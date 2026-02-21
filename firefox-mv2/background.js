// Default server settings used for HTTP and optional WebSocket sync.
const DEFAULT_SERVER_CONFIG = {
	baseUrl: "http://127.0.0.1:8787",
	useWebSocket: false,
	timeoutMs: 10000,
};

// Storage and sync behavior constants.
const LOCAL_STATE_KEY = "styx_local_state";
const SYNC_KEY_PREFIX = "styx_sync_payload:";
const MAX_ACTIONS = 5000;
const ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 3 * 1000;

// Default user-editable extension settings.
const DEFAULT_SETTINGS = {
	identifier: "",
	syncMethod: "browserSync",
	serverBaseUrl: DEFAULT_SERVER_CONFIG.baseUrl,
	serverUseWebSocket: DEFAULT_SERVER_CONFIG.useWebSocket,
};

// In-memory runtime state for the background script.
const state = {
	deviceId: "",
	settings: { ...DEFAULT_SETTINGS },
	actions: [],
	tabBindings: {},
	lastSyncAt: 0,
};

// Runtime flags and timers for sync/WebSocket lifecycle.
let applyingRemote = false;
let syncScheduled = null;
let isSyncing = false;
let websocket = null;
let websocketReconnectTimer = null;
let websocketPublishTimer = null;
let reconnectAttempt = 0;
let websocketEndpoint = "";

// Generates a UUID-like identifier for devices, tabs, and actions.
function createId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const random = Math.floor(Math.random() * 16);
		const value = char === "x" ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
}

// Returns current timestamp in milliseconds.
function now() {
	return Date.now();
}

// Converts an HTTP(S) base URL into a WebSocket sync base URL.
function toWebSocketBaseUrl(httpBaseUrl) {
	const inputBaseUrl = typeof httpBaseUrl === "string" && httpBaseUrl.trim()
		? httpBaseUrl.trim()
		: DEFAULT_SERVER_CONFIG.baseUrl;

	const normalized = inputBaseUrl.replace(/\/$/, "");
	if (normalized.startsWith("ws://") || normalized.startsWith("wss://")) {
		return `${normalized}/ws/sync`;
	}

	if (normalized.startsWith("https://")) {
		return `${normalized.replace("https://", "wss://")}/ws/sync`;
	}

	if (normalized.startsWith("http://")) {
		return `${normalized.replace("http://", "ws://")}/ws/sync`;
	}

	const fallback = DEFAULT_SERVER_CONFIG.baseUrl.replace(/\/$/, "");
	if (fallback.startsWith("https://")) {
		return `${fallback.replace("https://", "wss://")}/ws/sync`;
	}

	if (fallback.startsWith("http://")) {
		return `${fallback.replace("http://", "ws://")}/ws/sync`;
	}

	return `${fallback}/ws/sync`;
}

// Builds a full WebSocket endpoint for the current identifier.
function getWebSocketEndpoint(settings) {
	const identifier = settings.identifier ? settings.identifier.trim() : "";
	if (!identifier) {
		return "";
	}

	const wsBase = toWebSocketBaseUrl(settings.serverBaseUrl);
	const base = wsBase.replace(/\/$/, "");
	return `${base}/${encodeURIComponent(identifier)}`;
}

// Indicates whether realtime WebSocket mode should be active.
function shouldUseWebSocket(settings) {
	return settings.syncMethod === "server" && Boolean(settings.serverUseWebSocket) && Boolean(settings.identifier);
}

// Safely closes and clears the active WebSocket connection and timers.
function closeWebSocketConnection() {
	if (websocketReconnectTimer) {
		clearTimeout(websocketReconnectTimer);
		websocketReconnectTimer = null;
	}

	if (websocketPublishTimer) {
		clearTimeout(websocketPublishTimer);
		websocketPublishTimer = null;
	}

	if (websocket) {
		websocket.onopen = null;
		websocket.onclose = null;
		websocket.onmessage = null;
		websocket.onerror = null;
		try {
			websocket.close();
		} catch (_error) {
			// Ignore close errors.
		}
		websocket = null;
	}

	websocketEndpoint = "";
	if (!shouldUseWebSocket(state.settings)) {
		reconnectAttempt = 0;
	}
}

// Schedules reconnect attempts with exponential backoff.
function scheduleWebSocketReconnect() {
	if (websocketReconnectTimer || !shouldUseWebSocket(state.settings)) {
		return;
	}

	const waitMs = Math.min(30000, 1000 * (2 ** reconnectAttempt));
	websocketReconnectTimer = setTimeout(() => {
		websocketReconnectTimer = null;
		ensureWebSocketConnection();
	}, waitMs);
	reconnectAttempt += 1;
}

// Sends a merged payload to the server over WebSocket.
function publishPayloadOverWebSocket(payload) {
	if (!websocket || websocket.readyState !== WebSocket.OPEN) {
		return;
	}

	websocket.send(JSON.stringify({
		type: "sync",
		sourceDeviceId: state.deviceId,
		payload,
	}));
}

// Debounces realtime payload publishing to avoid message spam.
function scheduleRealtimePublish(delayMs = 250) {
	if (!shouldUseWebSocket(state.settings)) {
		return;
	}

	if (websocketPublishTimer) {
		clearTimeout(websocketPublishTimer);
	}

	websocketPublishTimer = setTimeout(() => {
		websocketPublishTimer = null;
		publishPayloadOverWebSocket({
			version: 1,
			updatedAt: now(),
			actions: state.actions,
		});
	}, delayMs);
}

// Handles incoming WebSocket payloads by merging and applying state.
async function onWebSocketMessage(rawMessage) {
	let message;
	try {
		message = JSON.parse(typeof rawMessage === "string" ? rawMessage : String(rawMessage));
	} catch (_error) {
		return;
	}

	if (!message || typeof message !== "object") {
		return;
	}

	if (typeof message.sourceDeviceId === "string" && message.sourceDeviceId === state.deviceId) {
		return;
	}

	if (message.type !== "snapshot" && message.type !== "sync") {
		return;
	}

	const remotePayload = normalizePayload(message.payload);
	const localPayload = {
		version: 1,
		updatedAt: now(),
		actions: state.actions,
	};

	const merged = mergePayloads(localPayload, remotePayload);
	state.actions = merged.actions;
	await applyMergedState(merged);
	state.lastSyncAt = now();
	await persistState();
}

// Ensures a single valid WebSocket connection exists when enabled.
function ensureWebSocketConnection() {
	if (!shouldUseWebSocket(state.settings)) {
		closeWebSocketConnection();
		return;
	}

	const endpoint = getWebSocketEndpoint(state.settings);
	if (!endpoint) {
		closeWebSocketConnection();
		return;
	}

	if (websocket && websocket.readyState === WebSocket.OPEN && websocketEndpoint === endpoint) {
		return;
	}

	if (websocket && websocket.readyState === WebSocket.CONNECTING && websocketEndpoint === endpoint) {
		return;
	}

	closeWebSocketConnection();
	websocketEndpoint = endpoint;

	try {
		websocket = new WebSocket(endpoint);
	} catch (_error) {
		scheduleWebSocketReconnect();
		return;
	}

	websocket.onopen = () => {
		reconnectAttempt = 0;
		websocket.send(JSON.stringify({ type: "pull", sourceDeviceId: state.deviceId }));
		scheduleRealtimePublish(100);
	};

	websocket.onmessage = (event) => {
		onWebSocketMessage(event.data).catch((error) => {
			console.error("WebSocket message handling failed:", error);
		});
	};

	websocket.onerror = () => {
		if (websocket) {
			try {
				websocket.close();
			} catch (_error) {
				// Ignore close errors.
			}
		}
	};

	websocket.onclose = () => {
		websocket = null;
		if (shouldUseWebSocket(state.settings)) {
			scheduleWebSocketReconnect();
		}
	};
}

// Filters URLs to sync only regular web/ftp tabs.
function shouldSyncUrl(url) {
	return typeof url === "string" && /^(https?|ftp):/i.test(url);
}

// Normalizes remote/local payload shape.
function normalizePayload(payload) {
	if (!payload || typeof payload !== "object") {
		return { version: 1, updatedAt: 0, actions: [] };
	}

	const actions = Array.isArray(payload.actions) ? payload.actions : [];
	return {
		version: 1,
		updatedAt: Number(payload.updatedAt || 0),
		actions,
	};
}

// Validates and normalizes a single action from any source.
function normalizeAction(rawAction) {
	if (!rawAction || typeof rawAction !== "object") {
		return null;
	}

	const type = typeof rawAction.type === "string" ? rawAction.type : "";
	if (!["OPEN", "UPDATE", "MOVE", "CLOSE"].includes(type)) {
		return null;
	}

	const instanceId = typeof rawAction.instanceId === "string" ? rawAction.instanceId : "";
	const actionId = typeof rawAction.actionId === "string" ? rawAction.actionId : "";
	if (!instanceId || !actionId) {
		return null;
	}

	return {
		actionId,
		type,
		instanceId,
		url: typeof rawAction.url === "string" ? rawAction.url : "",
		title: typeof rawAction.title === "string" ? rawAction.title : "",
		pinned: Boolean(rawAction.pinned),
		index: Number.isInteger(rawAction.index) && rawAction.index >= 0 ? rawAction.index : null,
		timestamp: Number(rawAction.timestamp || 0),
		deviceId: typeof rawAction.deviceId === "string" ? rawAction.deviceId : "",
	};
}

// Sorts actions deterministically for conflict resolution.
function sortActions(actions) {
	actions.sort((left, right) => {
		if (left.timestamp !== right.timestamp) {
			return left.timestamp - right.timestamp;
		}
		return left.actionId.localeCompare(right.actionId);
	});
}

// Reconstructs latest per-tab instance state from action history.
function deriveInstances(actions) {
	const instances = new Map();
	const sorted = actions.slice();
	sortActions(sorted);

	for (const action of sorted) {
		const previous = instances.get(action.instanceId) || {
			instanceId: action.instanceId,
			open: false,
			url: "",
			title: "",
			pinned: false,
			index: Number.MAX_SAFE_INTEGER,
			updatedAt: 0,
		};

		if (action.type === "OPEN" || action.type === "UPDATE" || action.type === "MOVE") {
			previous.open = true;
			if (shouldSyncUrl(action.url)) {
				previous.url = action.url;
			}
			if (typeof action.title === "string") {
				previous.title = action.title;
			}
			previous.pinned = Boolean(action.pinned);
			if (Number.isInteger(action.index) && action.index >= 0) {
				previous.index = action.index;
			}
		}

		if (action.type === "CLOSE") {
			previous.open = false;
			previous.index = Number.MAX_SAFE_INTEGER;
		}

		previous.updatedAt = Math.max(previous.updatedAt, action.timestamp || 0);
		instances.set(action.instanceId, previous);
	}

	return instances;
}

// Prunes action history while preserving active tab lineage.
function pruneActions(actions) {
	const cutoff = now() - ACTION_TTL_MS;
	const instances = deriveInstances(actions);

	const keepIds = new Set();
	for (const [instanceId, instance] of instances.entries()) {
		if (instance.open) {
			keepIds.add(instanceId);
		}
	}

	const filtered = actions.filter((action) => {
		if (keepIds.has(action.instanceId)) {
			return true;
		}
		return action.timestamp >= cutoff;
	});

	sortActions(filtered);
	if (filtered.length <= MAX_ACTIONS) {
		return filtered;
	}

	const byRecency = filtered.slice().sort((left, right) => right.timestamp - left.timestamp);
	const capped = byRecency.slice(0, MAX_ACTIONS);
	sortActions(capped);
	return capped;
}

// Merges local and remote payloads into a single conflict-resolved payload.
function mergePayloads(localPayload, remotePayload) {
	const local = normalizePayload(localPayload);
	const remote = normalizePayload(remotePayload);

	const actionMap = new Map();
	for (const rawAction of local.actions.concat(remote.actions)) {
		const action = normalizeAction(rawAction);
		if (!action) {
			continue;
		}
		actionMap.set(action.actionId, action);
	}

	const actions = Array.from(actionMap.values());
	const mergedActions = pruneActions(actions);

	return {
		version: 1,
		updatedAt: now(),
		actions: mergedActions,
	};
}

// Adds an action into local history with deduplication and pruning.
function addAction(action) {
	const normalized = normalizeAction(action);
	if (!normalized) {
		return;
	}

	if (state.actions.some((existingAction) => existingAction.actionId === normalized.actionId)) {
		return;
	}

	state.actions.push(normalized);
	state.actions = pruneActions(state.actions);
	scheduleRealtimePublish();
}

// Creates an action envelope from tab data.
function createAction(type, instanceId, tabLike) {
	return {
		actionId: createId(),
		type,
		instanceId,
		url: tabLike && typeof tabLike.url === "string" ? tabLike.url : "",
		title: tabLike && typeof tabLike.title === "string" ? tabLike.title : "",
		pinned: Boolean(tabLike && tabLike.pinned),
		index: tabLike && Number.isInteger(tabLike.index) && tabLike.index >= 0 ? tabLike.index : null,
		timestamp: now(),
		deviceId: state.deviceId,
	};
}

// Reorders bound tabs to match merged remote ordering.
async function reorderBoundTabs(instances, boundByInstanceId) {
	const tabs = await browser.tabs.query({});
	const tabById = new Map();
	for (const tab of tabs) {
		tabById.set(tab.id, tab);
	}

	const ordered = [];
	for (const instance of instances.values()) {
		if (!instance.open || !shouldSyncUrl(instance.url)) {
			continue;
		}

		if (!boundByInstanceId.has(instance.instanceId)) {
			continue;
		}

		const tabId = boundByInstanceId.get(instance.instanceId);
		const tab = tabById.get(tabId);
		if (!tab) {
			continue;
		}

		ordered.push({
			tabId,
			windowId: tab.windowId,
			instance,
		});
	}

	if (ordered.length === 0) {
		return;
	}

	const targetWindowId = ordered[0].windowId;
	const sameWindow = ordered.filter((entry) => entry.windowId === targetWindowId);
	if (sameWindow.length === 0) {
		return;
	}

	sameWindow.sort((left, right) => {
		const leftIndex = Number.isInteger(left.instance.index) ? left.instance.index : Number.MAX_SAFE_INTEGER;
		const rightIndex = Number.isInteger(right.instance.index) ? right.instance.index : Number.MAX_SAFE_INTEGER;

		if (leftIndex !== rightIndex) {
			return leftIndex - rightIndex;
		}

		if (left.instance.updatedAt !== right.instance.updatedAt) {
			return right.instance.updatedAt - left.instance.updatedAt;
		}

		return left.instance.instanceId.localeCompare(right.instance.instanceId);
	});

	const pinned = sameWindow.filter((entry) => entry.instance.pinned);
	const unpinned = sameWindow.filter((entry) => !entry.instance.pinned);
	const desiredOrder = pinned.concat(unpinned);

	for (let index = 0; index < desiredOrder.length; index += 1) {
		const entry = desiredOrder[index];
		const currentTab = tabById.get(entry.tabId);
		if (!currentTab) {
			continue;
		}

		if (Boolean(currentTab.pinned) !== Boolean(entry.instance.pinned)) {
			await browser.tabs.update(entry.tabId, { pinned: Boolean(entry.instance.pinned) });
		}

		await browser.tabs.move(entry.tabId, { windowId: targetWindowId, index });
	}
}

// Captures current tab ordering for a window as MOVE actions.
async function recordWindowOrder(windowId) {
	const tabs = await browser.tabs.query({ windowId });

	for (const tab of tabs) {
		if (!shouldSyncUrl(tab.url)) {
			continue;
		}

		const instanceId = await ensureTabBinding(tab, false);
		if (!instanceId) {
			continue;
		}

		addAction(createAction("MOVE", instanceId, tab));
	}

	await persistState();
}

// Persists runtime state to local browser storage.
async function persistState() {
	await browser.storage.local.set({
		[LOCAL_STATE_KEY]: {
			deviceId: state.deviceId,
			settings: state.settings,
			actions: state.actions,
			lastSyncAt: state.lastSyncAt,
		},
	});
}

// Loads persisted state and initializes defaults as needed.
async function loadState() {
	const stored = await browser.storage.local.get(LOCAL_STATE_KEY);
	const loaded = stored[LOCAL_STATE_KEY] || {};

	state.deviceId = typeof loaded.deviceId === "string" && loaded.deviceId ? loaded.deviceId : createId();
	state.settings = {
		...DEFAULT_SETTINGS,
		...(loaded.settings || {}),
	};
	state.actions = pruneActions((loaded.actions || []).map(normalizeAction).filter(Boolean));
	state.tabBindings = {};
	state.lastSyncAt = Number(loaded.lastSyncAt || 0);

	await persistState();
	ensureWebSocketConnection();
}

// Debounces sync execution triggered by tab/settings changes.
function scheduleSync(reason, delayMs = 1500) {
	if (syncScheduled) {
		clearTimeout(syncScheduled);
	}

	syncScheduled = setTimeout(() => {
		syncScheduled = null;
		performSync(reason).catch((error) => {
			console.error("Sync failed:", error);
		});
	}, delayMs);
}

// Ensures a browser tab id is bound to a stable instance id.
async function ensureTabBinding(tab, emitOpenAction) {
	if (!tab || typeof tab.id !== "number" || !shouldSyncUrl(tab.url)) {
		return null;
	}

	let instanceId = state.tabBindings[tab.id];
	if (!instanceId) {
		instanceId = createId();
		state.tabBindings[tab.id] = instanceId;
		if (emitOpenAction) {
			addAction(createAction("OPEN", instanceId, tab));
		}
	}

	return instanceId;
}

// Initializes bindings and OPEN actions for already open tabs on startup.
async function bootstrapCurrentTabs() {
	const tabs = await browser.tabs.query({});
	for (const tab of tabs) {
		if (!shouldSyncUrl(tab.url)) {
			continue;
		}
		await ensureTabBinding(tab, true);
	}

	await persistState();
}

// Retrieves remote payload via selected backend (server or browser sync).
async function fetchRemotePayload() {
	const { identifier, syncMethod, serverBaseUrl } = state.settings;
	if (!identifier) {
		return { version: 1, updatedAt: 0, actions: [] };
	}

	if (syncMethod === "server") {
		const baseUrl = (serverBaseUrl || DEFAULT_SERVER_CONFIG.baseUrl).replace(/\/$/, "");
		const url = `${baseUrl}/sync/${encodeURIComponent(identifier)}`;

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_SERVER_CONFIG.timeoutMs);
		try {
			const response = await fetch(url, {
				method: "GET",
				signal: controller.signal,
			});

			if (!response.ok) {
				return { version: 1, updatedAt: 0, actions: [] };
			}

			const payload = await response.json();
			if (payload && typeof payload === "object" && payload.payload) {
				return normalizePayload(payload.payload);
			}

			return normalizePayload(payload);
		} catch (_error) {
			return { version: 1, updatedAt: 0, actions: [] };
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	const syncKey = `${SYNC_KEY_PREFIX}${identifier}`;
	const stored = await browser.storage.sync.get(syncKey);
	return normalizePayload(stored[syncKey]);
}

// Pushes merged payload to remote backend and optional realtime channel.
async function pushRemotePayload(payload) {
	const { identifier, syncMethod, serverBaseUrl } = state.settings;
	if (!identifier) {
		return;
	}

	if (syncMethod === "server") {
		if (state.settings.serverUseWebSocket) {
			publishPayloadOverWebSocket(payload);
		}

		const baseUrl = (serverBaseUrl || DEFAULT_SERVER_CONFIG.baseUrl).replace(/\/$/, "");
		const url = `${baseUrl}/sync/${encodeURIComponent(identifier)}`;

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_SERVER_CONFIG.timeoutMs);

		try {
			await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} catch (_error) {
			return;
		} finally {
			clearTimeout(timeoutHandle);
		}

		return;
	}

	const syncKey = `${SYNC_KEY_PREFIX}${identifier}`;
	await browser.storage.sync.set({ [syncKey]: payload });
}

// Applies merged state to local browser tabs (open/update/close/reorder).
async function applyMergedState(payload) {
	const instances = deriveInstances(payload.actions);
	const boundByInstanceId = new Map();
	for (const [tabIdString, instanceId] of Object.entries(state.tabBindings)) {
		boundByInstanceId.set(instanceId, Number(tabIdString));
	}

	const tabs = await browser.tabs.query({});
	const tabById = new Map();
	for (const tab of tabs) {
		tabById.set(tab.id, tab);
	}

	applyingRemote = true;
	try {
		for (const instance of instances.values()) {
			if (!instance.open || !shouldSyncUrl(instance.url)) {
				continue;
			}

			if (boundByInstanceId.has(instance.instanceId)) {
				const boundTabId = boundByInstanceId.get(instance.instanceId);
				const boundTab = tabById.get(boundTabId);
				if (boundTab && (boundTab.url !== instance.url || Boolean(boundTab.pinned) !== Boolean(instance.pinned))) {
					await browser.tabs.update(boundTabId, { url: instance.url, pinned: instance.pinned });
				}
				continue;
			}

			const created = await browser.tabs.create({
				url: instance.url,
				active: false,
				pinned: Boolean(instance.pinned),
			});
			state.tabBindings[created.id] = instance.instanceId;
		}

		for (const [tabIdString, instanceId] of Object.entries(state.tabBindings)) {
			const tabId = Number(tabIdString);
			const instance = instances.get(instanceId);
			const shouldBeOpen = Boolean(instance && instance.open);

			if (!shouldBeOpen && tabById.has(tabId)) {
				try {
					await browser.tabs.remove(tabId);
				} catch (_error) {
					// Tab could already be closed.
				}
				delete state.tabBindings[tabIdString];
			}
		}

		const refreshedBoundByInstanceId = new Map();
		for (const [tabIdString, instanceId] of Object.entries(state.tabBindings)) {
			refreshedBoundByInstanceId.set(instanceId, Number(tabIdString));
		}

		await reorderBoundTabs(instances, refreshedBoundByInstanceId);
	} finally {
		applyingRemote = false;
	}
}

// Executes a full sync cycle: fetch, merge, apply, push, persist.
async function performSync(reason = "unknown") {
	if (isSyncing) {
		return;
	}

	if (!state.settings.identifier) {
		return;
	}

	isSyncing = true;
	try {
		const localPayload = {
			version: 1,
			updatedAt: now(),
			actions: state.actions,
		};

		const remotePayload = await fetchRemotePayload();
		const merged = mergePayloads(localPayload, remotePayload);

		state.actions = merged.actions;
		await applyMergedState(merged);
		await pushRemotePayload(merged);

		state.lastSyncAt = now();
		await persistState();

		console.debug(`Styx sync completed (${reason})`);
	} finally {
		isSyncing = false;
	}
}

// Handles newly created tabs and schedules synchronization.
function onTabCreated(tab) {
	if (applyingRemote || !shouldSyncUrl(tab.url)) {
		return;
	}

	ensureTabBinding(tab, true).then(() => {
		persistState();
		scheduleSync("tab-created");
	});
}

// Handles tab URL/title/pinned changes and records update actions.
function onTabUpdated(tabId, changeInfo, tab) {
	if (applyingRemote) {
		return;
	}

	const hasRelevantChange = Object.prototype.hasOwnProperty.call(changeInfo, "url") ||
		Object.prototype.hasOwnProperty.call(changeInfo, "title") ||
		Object.prototype.hasOwnProperty.call(changeInfo, "pinned");

	if (!hasRelevantChange) {
		return;
	}

	if (!shouldSyncUrl(tab.url)) {
		const instanceId = state.tabBindings[tabId];
		if (!instanceId) {
			return;
		}
		addAction(createAction("CLOSE", instanceId, tab));
		delete state.tabBindings[tabId];
		persistState();
		scheduleSync("tab-updated-nonsyncable");
		return;
	}

	ensureTabBinding(tab, false).then((instanceId) => {
		if (!instanceId) {
			return;
		}
		addAction(createAction("UPDATE", instanceId, tab));
		persistState();
		scheduleSync("tab-updated");
	});
}

// Handles tab closures and records CLOSE actions.
function onTabRemoved(tabId) {
	if (applyingRemote) {
		return;
	}

	const instanceId = state.tabBindings[tabId];
	if (!instanceId) {
		return;
	}

	addAction(createAction("CLOSE", instanceId, {}));
	delete state.tabBindings[tabId];
	persistState();
	scheduleSync("tab-removed");
}

// Handles tab movement by snapshotting full window order.
function onTabMoved(tabId, moveInfo) {
	if (applyingRemote) {
		return;
	}

	recordWindowOrder(moveInfo.windowId).then(() => {
		scheduleSync("tab-moved");
	}).catch(() => {
		// Tab may not exist anymore.
	});
}

// Sanitizes incoming settings from the popup UI.
function sanitizeSettings(inputSettings) {
	const next = { ...state.settings };

	if (typeof inputSettings.identifier === "string") {
		next.identifier = inputSettings.identifier.trim();
	}

	if (inputSettings.syncMethod === "browserSync" || inputSettings.syncMethod === "server") {
		next.syncMethod = inputSettings.syncMethod;
	}

	if (typeof inputSettings.serverBaseUrl === "string" && inputSettings.serverBaseUrl.trim()) {
		next.serverBaseUrl = inputSettings.serverBaseUrl.trim();
	}

	if (typeof inputSettings.serverUseWebSocket === "boolean") {
		next.serverUseWebSocket = inputSettings.serverUseWebSocket;
	}

	return next;
}

// Handles popup-to-background messages for settings and manual sync.
browser.runtime.onMessage.addListener((message) => {
	if (!message || typeof message !== "object") {
		return null;
	}

	if (message.type === "styx:get-settings") {
		return Promise.resolve({
			settings: state.settings,
			lastSyncAt: state.lastSyncAt,
			isSyncing,
			deviceId: state.deviceId,
		});
	}

	if (message.type === "styx:update-settings") {
		state.settings = sanitizeSettings(message.settings || {});
		return persistState().then(() => {
			ensureWebSocketConnection();
			scheduleSync("settings-updated", 200);
			return {
				settings: state.settings,
			};
		});
	}

	if (message.type === "styx:sync-now") {
		return performSync("manual").then(() => ({
			ok: true,
			lastSyncAt: state.lastSyncAt,
		}));
	}

	return null;
});

// Browser tab event subscriptions.
browser.tabs.onCreated.addListener(onTabCreated);
browser.tabs.onUpdated.addListener(onTabUpdated);
browser.tabs.onRemoved.addListener(onTabRemoved);
browser.tabs.onMoved.addListener(onTabMoved);

// Periodic background sync fallback.
setInterval(() => {
	performSync("interval").catch((error) => {
		console.error("Interval sync failed:", error);
	});
}, SYNC_INTERVAL_MS);

// Extension startup initialization flow.
loadState()
	.then(() => bootstrapCurrentTabs())
	.then(() => performSync("startup"))
	.catch((error) => {
		console.error("Styx initialization failed:", error);
	});
