// Default server settings used for HTTP and optional WebSocket sync.
const DEFAULT_SERVER_CONFIG = {
	baseUrl: "https://styx.yznts.cc",
	useWebSocket: true,
	timeoutMs: 10000,
};

// Storage and sync behavior constants.
const LOCAL_STATE_KEY = "styx_local_state";
const SYNC_KEY_PREFIX = "styx_sync_payload:";
const SYNC_INTERVAL_MS = 5000;
const RECENT_OPEN_TTL_MS = 15000;

// Default user-editable extension settings.
const DEFAULT_SETTINGS = {
	identifier: "",
	syncMethod: "server",
	serverBaseUrl: DEFAULT_SERVER_CONFIG.baseUrl,
	serverUseWebSocket: DEFAULT_SERVER_CONFIG.useWebSocket,
};

// In-memory runtime state for the background script.
const state = {
	deviceId: "",
	settings: { ...DEFAULT_SETTINGS },
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
let hasInitialRemoteState = false;
let remoteApplyQueue = Promise.resolve();
const recentRemoteOpens = new Map();

// Generates a UUID-like identifier for devices.
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

// Filters URLs to sync only regular web/ftp tabs.
function shouldSyncUrl(url) {
	return typeof url === "string" && /^(https?|ftp):/i.test(url);
}

// Validates and normalizes a tab entry in payload.
function normalizeTab(rawTab) {
	if (!rawTab || typeof rawTab !== "object") {
		return null;
	}

	const url = typeof rawTab.url === "string" ? rawTab.url : "";
	if (!shouldSyncUrl(url)) {
		return null;
	}

	return {
		url,
		title: typeof rawTab.title === "string" ? rawTab.title : "",
		pinned: Boolean(rawTab.pinned),
		index: Number.isInteger(rawTab.index) && rawTab.index >= 0 ? rawTab.index : null,
	};
}

// Normalizes remote/local payload shape.
function normalizePayload(payload) {
	if (!payload || typeof payload !== "object") {
		return { version: 1, updatedAt: 0, tabs: [] };
	}

	const normalizedTabs = [];
	const seen = new Set();
	for (const rawTab of Array.isArray(payload.tabs) ? payload.tabs : []) {
		const tab = normalizeTab(rawTab);
		if (!tab) {
			continue;
		}
		if (seen.has(tab.url)) {
			continue;
		}
		seen.add(tab.url);
		normalizedTabs.push(tab);
	}

	return {
		version: 1,
		updatedAt: Number(payload.updatedAt || 0),
		tabs: normalizedTabs,
	};
}

// Captures current browser tabs as a single latest-state payload.
async function captureLocalPayload() {
	const tabs = await browser.tabs.query({});
	const result = [];
	const seen = new Set();

	for (const tab of tabs) {
		if (!shouldSyncUrl(tab.url)) {
			continue;
		}
		if (seen.has(tab.url)) {
			continue;
		}
		seen.add(tab.url);
		result.push({
			url: tab.url,
			title: typeof tab.title === "string" ? tab.title : "",
			pinned: Boolean(tab.pinned),
			index: Number.isInteger(tab.index) ? tab.index : null,
		});
	}

	return {
		version: 1,
		updatedAt: now(),
		tabs: result,
	};
}

// Applies remote state by opening missing tabs and deleting synced tabs not in remote state.
async function applyRemoteState(payload) {
	const normalized = normalizePayload(payload);
	const currentTabs = await browser.tabs.query({});
	const existingUrls = new Set();
	const currentSyncedTabs = [];
	const timestamp = now();

	for (const tab of currentTabs) {
		if (!shouldSyncUrl(tab.url)) {
			continue;
		}
		existingUrls.add(tab.url);
		currentSyncedTabs.push(tab);
	}

	for (const [url, expiry] of recentRemoteOpens.entries()) {
		if (expiry <= timestamp) {
			recentRemoteOpens.delete(url);
			continue;
		}
		existingUrls.add(url);
	}

	const orderedTabs = normalized.tabs.slice().sort((left, right) => {
		const leftIndex = Number.isInteger(left.index) ? left.index : Number.MAX_SAFE_INTEGER;
		const rightIndex = Number.isInteger(right.index) ? right.index : Number.MAX_SAFE_INTEGER;
		return leftIndex - rightIndex;
	});

	applyingRemote = true;
	try {
		const remoteUrls = new Set(normalized.tabs.map((tab) => tab.url));

		for (const tab of currentSyncedTabs) {
			if (remoteUrls.has(tab.url)) {
				continue;
			}

			try {
				await browser.tabs.remove(tab.id);
			} catch (_error) {
				// Tab could already be closed.
			}
		}

		for (const tab of orderedTabs) {
			if (existingUrls.has(tab.url)) {
				continue;
			}

			recentRemoteOpens.set(tab.url, now() + RECENT_OPEN_TTL_MS);
			await browser.tabs.create({
				url: tab.url,
				active: false,
				pinned: Boolean(tab.pinned),
			});
			existingUrls.add(tab.url);
		}
	} finally {
		applyingRemote = false;
	}
}

// Serializes remote apply operations to avoid duplicate tab opens from concurrent sync sources.
function enqueueRemoteApply(payload) {
	remoteApplyQueue = remoteApplyQueue
		.catch(() => {
			// Keep queue alive after previous failures.
		})
		.then(() => applyRemoteState(payload));

	return remoteApplyQueue;
}

// Converts HTTP(S) base URL into a WebSocket sync base URL.
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
	return `${wsBase.replace(/\/$/, "")}/${encodeURIComponent(identifier)}`;
}

// Indicates whether realtime WebSocket mode should be active.
function shouldUseWebSocket(settings) {
	return settings.syncMethod === "server" && Boolean(settings.serverUseWebSocket) && Boolean(settings.identifier);
}

// Persists runtime state to local browser storage.
async function persistState() {
	await browser.storage.local.set({
		[LOCAL_STATE_KEY]: {
			deviceId: state.deviceId,
			settings: state.settings,
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
	state.lastSyncAt = Number(loaded.lastSyncAt || 0);

	await persistState();
}

// Retrieves remote payload via selected backend (server or browser sync).
async function fetchRemotePayload() {
	const { identifier, syncMethod, serverBaseUrl } = state.settings;
	if (!identifier) {
		return { version: 1, updatedAt: 0, tabs: [] };
	}

	if (syncMethod === "server") {
		const baseUrl = (serverBaseUrl || DEFAULT_SERVER_CONFIG.baseUrl).replace(/\/$/, "");
		const url = `${baseUrl}/sync/${encodeURIComponent(identifier)}`;

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_SERVER_CONFIG.timeoutMs);
		try {
			const response = await fetch(url, { method: "GET", signal: controller.signal });
			if (!response.ok) {
				return { version: 1, updatedAt: 0, tabs: [] };
			}
			return normalizePayload(await response.json());
		} catch (_error) {
			return { version: 1, updatedAt: 0, tabs: [] };
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	const syncKey = `${SYNC_KEY_PREFIX}${identifier}`;
	const stored = await browser.storage.sync.get(syncKey);
	return normalizePayload(stored[syncKey]);
}

// Pushes payload to remote backend and optional realtime channel.
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
				headers: { "Content-Type": "application/json" },
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

// Sends a state snapshot to the server over WebSocket.
function publishPayloadOverWebSocket(payload) {
	if (!hasInitialRemoteState) {
		return;
	}

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
		captureLocalPayload().then((payload) => {
			publishPayloadOverWebSocket(payload);
		}).catch(() => {
			// Ignore publish errors.
		});
	}, delayMs);
}

// Handles incoming WebSocket payloads by applying remote tab state.
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

	await enqueueRemoteApply(message.payload);
	hasInitialRemoteState = true;
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

// Executes a full sync cycle: pull, apply, push latest snapshot.
async function performSync(reason = "unknown") {
	if (isSyncing || !state.settings.identifier) {
		return;
	}

	isSyncing = true;
	try {
		const remotePayload = await fetchRemotePayload();
		await enqueueRemoteApply(remotePayload);
		hasInitialRemoteState = true;

		const latestPayload = await captureLocalPayload();
		await pushRemotePayload(latestPayload);

		state.lastSyncAt = now();
		await persistState();
		console.debug(`Styx sync completed (${reason})`);
	} finally {
		isSyncing = false;
	}
}

// Handles local tab changes by scheduling a sync and realtime publish.
function onTabChanged() {
	if (applyingRemote) {
		return;
	}

	scheduleSync("tab-changed");
	scheduleRealtimePublish();
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
			return { settings: state.settings };
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
browser.tabs.onCreated.addListener(onTabChanged);
browser.tabs.onRemoved.addListener(onTabChanged);
browser.tabs.onMoved.addListener(onTabChanged);
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (Object.prototype.hasOwnProperty.call(changeInfo, "url") ||
		Object.prototype.hasOwnProperty.call(changeInfo, "pinned")) {
		onTabChanged(tabId, changeInfo, tab);
	}
});

// Periodic background sync fallback.
setInterval(() => {
	performSync("interval").catch((error) => {
		console.error("Interval sync failed:", error);
	});
}, SYNC_INTERVAL_MS);

// Extension startup initialization flow.
loadState()
	.then(() => {
		ensureWebSocketConnection();
		return performSync("startup");
	})
	.catch((error) => {
		console.error("Styx initialization failed:", error);
	});
