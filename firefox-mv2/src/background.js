// For now, ignore this file completely.
// Work in progress for a normal refactor.

// Debug flag
const DEBUG = false;

// Add-on configuration management class.
// Responsible for loading/saving configuration state from/to browser storage,
// and providing an interface for other modules to access/update configuration.
class Configuration {
    constructor() {
        this.key = "styx:v1";
        this.defaults = {
            identifier: "",
            method: "server", // "server" or "browser.storage.sync"
            server: {
                url: "https://styx.yznts.cc",
                websocket: false,
            },
            interval: 1000, // Sync interval in milliseconds for periodic sync trigger
        }

        this.state = {
            device: "", // Unique identifier for this device/instance.
            settings: { ...this.defaults },
            lastSync: 0, // Timestamp of the last successful sync.
        }
    }

    async load() {
        const stored = await browser.storage.local.get(this.key);
        if (stored && stored[this.key]) {
            this.state = stored[this.key];
        } else {
            this.state.device = crypto.randomUUID();
        }
        return this;
    }

    async save() {
        await browser.storage.local.set({
            [this.key]: this.state,
        });
    }
}

// Replica engine helps to manage the local state of tabs and synchronize with the backend.
// It maintains the current state, applies updates from the backend, and generates updates to push to the backend.
class Replica {
    constructor(config) {
        this.config = config;
        this.lastChangedAt = 0; // Timestamp of the last local change, used to prevent loops and resolve conflicts.
        this.lastChangedHash = ""; // Hash of the last local state, used to detect changes and prevent loops.
    }

    _hash(replica) {
        let s = JSON.stringify(replica);
        let h = 0, l = s.length, i = 0;
        if ( l > 0 )
            while (i < l)
            h = (h << 5) - h + s.charCodeAt(i++) | 0;
        return h;
    }

    async reorderServiceTabs() {
        const tabs = await browser.tabs.query({});
        const serviceTabs = tabs
            .filter(tab => !(typeof tab.url === "string" && /^(https?|ftp):/i.test(tab.url)) && !tab.pinned)
            .sort((a, b) => (a.index || 0) - (b.index || 0));
        for (const tab of serviceTabs) {
            try {
                await browser.tabs.move(tab.id, { index: -1 });
            } catch (_) {
                // Tab may already be closed or unmovable; ignore.
            }
        }
    }

    // Gathers the current replica of tabs from the browser and prepares it for syncing.
    async gather() {
        // Ensure service tabs are at the end so their presence does not shift indices for syncable tabs.
        await this.reorderServiceTabs();
        // Query all browser tabs and build a syncable state object
        const tabs = await browser.tabs.query({});
        const replica = {
            tabs: tabs.filter(tab => typeof tab.url === "string" && /^(https?|ftp):/i.test(tab.url)).map(tab => ({
                url: typeof tab.url === "string" ? tab.url : "",
                title: typeof tab.title === "string" ? tab.title : "",
                pinned: Boolean(tab.pinned),
                index: Number.isInteger(tab.index) ? tab.index : null,
            })),
        };
        // Generate a hash of the current state to detect changes.
        const hash = this._hash(replica.tabs);
        // Update last changed hash and timestamp if state has changed since last sync.
        if (hash !== this.lastChangedHash) {
            console.log("Local state changed, updating replica hash and timestamp.");
            this.lastChangedAt = Date.now();
            this.lastChangedHash = hash;
        }
        // Add metadata to the replica for conflict resolution and loop prevention.
        replica.meta = {
            lastChangedAt: this.lastChangedAt,
        };
        // Return the gathered state to be pushed to the backend.
        return replica;
    }

    // Applies a replica from the backend to the local state.
    async apply(update) {
        // Ensure service tabs are at the end so their presence does not shift indices for syncable tabs.
        await this.reorderServiceTabs();
        // Skip apply if the update is older than the last local change to prevent loops.
        // That usually means sync engine will override backend state with current local state on the next push.
        if (update.meta && update.meta.lastChangedAt < this.lastChangedAt) {
            console.log("Received older update, skipping apply.");
            return;
        }

        console.log("Applying update from backend:", update);

        // Get current browser tabs
        const tabs = await browser.tabs.query({});

        // Delete tabs not present in remote replica.
        // Only consider tabs with a syncable URL (same filter as gather()) — new tabs,
        // about:blank and other internal pages are never part of the replica and must not be closed.
        for (const tab of tabs) {
            if (typeof tab.url !== "string" || !/^(https?|ftp):/i.test(tab.url)) {
                continue;
            }
            if (!update.tabs.some(t => t.url === tab.url)) {
                try {
                    await browser.tabs.remove(tab.id);
                } catch (_) {
                    // Tab may already be closed
                }
            }
        }

        // Create missing tabs
        for (const remoteTab of update.tabs) {
            if (!tabs.some(t => t.url === remoteTab.url)) {
                try {
                    await browser.tabs.create({
                        url: remoteTab.url,
                        active: false,
                        pinned: Boolean(remoteTab.pinned),
                    });
                } catch (_) {
                    console.warn(`Failed to create tab ${remoteTab.url}`);
                    // Ignore creation errors
                }
            }
        }

        // Move/pin tabs as needed
        for (const remoteTab of update.tabs) {
            const tab = tabs.find(t => t.url === remoteTab.url);
            if (tab) {
                // Pin/unpin if needed
                if (Boolean(tab.pinned) !== Boolean(remoteTab.pinned)) {
                    try {
                        await browser.tabs.update(tab.id, { pinned: Boolean(remoteTab.pinned) });
                    } catch (_) {
                        console.warn(`Failed to update pinned state for tab ${tab.url}`);
                        // Ignore pin errors
                    }
                }
                // Move tab if index differs
                if (Number.isInteger(remoteTab.index) && tab.index !== remoteTab.index) {
                    try {
                        await browser.tabs.move(tab.id, { index: remoteTab.index });
                    } catch (_) {
                        console.warn(`Failed to move tab ${tab.url} to index ${remoteTab.index}`);
                        // Ignore move errors
                    }
                }
            }
        }
    }
}

// ---
// Sync engines
// ---

// Sync engine for own backend server.
// Supports both REST and WebSocket sync methods based on configuration.
class ServerSync {
    /*
        * @param {Configuration} config - The configuration instance to read settings from.
        * @param {Replica} replica - The replica instance to gather/apply state.
    */
    constructor(config, replica) {
        this.config = config;
        this.replica = replica;
        this.ws = null; // WebSocket instance for reactive sync
    }

    // Shortcut helper to avoid repeating long references.
    params() {
        return {
            serverUrl: this.config.state.settings.server.url,
            identifier: this.config.state.settings.identifier,
            websocket: this.config.state.settings.server.websocket,
        }
    }

    // Websocket connect/disconnect control and handlers

    _wsConnect() {
        const { serverUrl, identifier } = this.params();
        const wsUrl = serverUrl.replace(/^http/, 'ws') + `/ws/sync/${encodeURIComponent(identifier)}`;
        const ws = new WebSocket(wsUrl);
        return new Promise((resolve, reject) => {
            ws.addEventListener('open', () => {
                this.ws = ws;
                resolve();
            });
            ws.addEventListener('message', this._wsMessage.bind(this));
            ws.addEventListener('error', (error) => {
                console.error('ws connection error:', error);
                reject(error);
            });
        })
    }

    _wsDisconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    async _wsMessage(event) {
        try {
            const message = JSON.parse(event.data);
            // Skip messages that originated from this device to prevent loops.
            if (message.sourceDeviceId && message.sourceDeviceId === this.config.state.device) return;
            // Apply incoming update.
            // Replica will resolve timing and conflicts.
            if (message.payload && message.payload.tabs) {
                await this.replica.apply(message.payload);
            }
        } catch (error) {
            console.error('ws message error:', error);
        }
    }

    // Pull/Push implementation

    async pull() {
        try {
            const { serverUrl, identifier } = this.params();
            const response = await fetch(`${serverUrl}/sync/${identifier}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            if (!response.ok) {
                throw new Error(`Pull failed: ${response.status}`);
            }
            const remoteState = await response.json();
            if (remoteState && remoteState.tabs && remoteState.meta.lastChangedAt > this.replica.lastChangedAt) {
                await this.replica.apply(remoteState);
            }
            return remoteState;
        } catch (error) {
            console.error('ServerSync.pull error:', error);
            return null;
        }
    }

    async push() {
        try {
            const { serverUrl, identifier } = this.params();
            const response = await fetch(`${serverUrl}/sync/${identifier}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(await this.replica.gather()),
            });
            if (!response.ok) {
                throw new Error(`Push failed: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('ServerSync.push error:', error);
            return null;
        }
    }
}

// ---
// Initialize core components and states
// ---

let initialized = false;
let synchronizing = false; // Flag to prevent concurrent syncs
let config = null;
let replica = null;
let engines = {
    server: new ServerSync(config, replica),
}

// ---
// Utility functions
// ---

// Select engine based on configuration.
function selectEngine() {
    let engine = engines[config.state.settings.method];
    if (!engine) {
        console.warn(`No engine found for method ${config.state.settings.method}`);
    }
    return engine;
}

// ---
// Lifecycle functions/handlers
// ---

async function init() {
    config = new Configuration();
    replica = new Replica(config);
    engines.server = new ServerSync(config, replica);

    await config.load();

    if (DEBUG) {
        config.state.settings.identifier = "debug";
        config.state.settings.method = "server";
        config.state.settings.server.url = "http://127.0.0.1:8787";
        config.state.settings.server.websocket = false;
        config.state.settings.interval = 1000;
        await config.save();
    }

    initialized = true;
}

async function sync() {
    if (!initialized) {
        console.warn("Sync called before initialization, skipping...");
        return;
    }
    if (!config.state.settings.identifier) {
        console.warn("No identifier set, skipping sync...");
        return;
    }
    if (synchronizing) {
        console.warn("Sync already in progress, skipping...");
        return;
    }
    const engine = selectEngine();
    if (engine) {
        synchronizing = true;
        try {
            await engine.pull();
            await engine.push();
            config.state.lastSync = Date.now();
            await config.save();
        } finally {
            synchronizing = false;
        }
    }
}

async function tabChanged(reason = "") {
    // Give Firefox a tick after removal so tab indices are settled before hashing.
    if (reason === "removed") {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    await replica.gather();
}

// ---
// Lifecycle bindings
// ---

// Call init on startup
init();
// Bind tab events to trigger sync on changes.
browser.tabs.onCreated.addListener(() => tabChanged("created"));
browser.tabs.onRemoved.addListener(() => tabChanged("removed"));
browser.tabs.onUpdated.addListener(() => tabChanged("updated"));
// Periodic sync to ensure state consistency.
// If interval is changed, need to restart browser/extension to apply new interval.
setInterval(() => {
    sync();
}, config.state.settings.interval || 1000);

// Message handler for popup communication.
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
        // Wait for initialization to complete before handling any messages, to ensure config and engines are ready.
        while (!initialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Handle messages from popup for getting/updating settings.
        switch (message.type) {
            case "styx:get-settings":
                sendResponse({
                    settings: config.state.settings,
                    lastSyncAt: config.state.lastSync,
                    deviceId: config.state.device,
                });
                break;
            case "styx:update-settings":
                config.state.settings = {
                    ...config.state.settings,
                    ...message.settings,
                }
                await config.save();
                sendResponse({ ok: true });
                break;
            default:
                sendResponse({ error: "Unknown message type" });
        }
    })();
    return true; // Keep channel open for async response
});
