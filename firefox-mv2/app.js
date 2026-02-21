// Popup DOM references.
const identifierInput = document.getElementById("identifier-input");
const syncMethodSelect = document.getElementById("sync-method");
const serverUrlInput = document.getElementById("server-url-input");
const serverUrlGroup = document.getElementById("server-url-group");
const serverWsEnabledInput = document.getElementById("server-ws-enabled");
const serverWsToggleGroup = document.getElementById("server-ws-toggle-group");
const syncNowButton = document.getElementById("sync-now-button");
const lastUpdated = document.getElementById("last-updated");
const statusMessage = document.getElementById("status-message");

// Local cache of settings shown in the popup.
let settingsCache = {
  identifier: "",
  syncMethod: "browserSync",
  serverBaseUrl: "http://127.0.0.1:8787",
  serverUseWebSocket: false,
};

// Formats timestamps into short human-readable relative time text.
function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "never";
  }

  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Shows/hides server and WebSocket fields based on current selections.
function renderServerField() {
  const isServerMode = syncMethodSelect.value === "server";
  serverUrlGroup.style.display = isServerMode ? "flex" : "none";
  serverWsToggleGroup.style.display = isServerMode ? "flex" : "none";
}

// Writes a short status message in the popup footer.
function setStatus(text) {
  statusMessage.textContent = text;
}

// Reads the current popup controls into a settings object.
function readUiSettings() {
  return {
    identifier: identifierInput.value.trim(),
    syncMethod: syncMethodSelect.value,
    serverBaseUrl: serverUrlInput.value.trim(),
    serverUseWebSocket: Boolean(serverWsEnabledInput.checked),
  };
}

// Sends updated settings to the background script.
async function saveSettings() {
  const settings = readUiSettings();
  settingsCache = settings;
  await browser.runtime.sendMessage({
    type: "styx:update-settings",
    settings,
  });
}

// Loads current settings/state from the background script into the popup.
async function loadSettings() {
  const response = await browser.runtime.sendMessage({
    type: "styx:get-settings",
  });

  settingsCache = {
    ...settingsCache,
    ...(response && response.settings ? response.settings : {}),
  };

  identifierInput.value = settingsCache.identifier || "";
  syncMethodSelect.value = settingsCache.syncMethod || "browserSync";
  serverUrlInput.value = settingsCache.serverBaseUrl || "http://127.0.0.1:8787";
  serverWsEnabledInput.checked = Boolean(settingsCache.serverUseWebSocket);
  renderServerField();

  lastUpdated.textContent = formatRelativeTime(response ? response.lastSyncAt : 0);
  if (response && response.deviceId) {
    setStatus(`Device: ${response.deviceId.slice(0, 8)}…`);
  }
}

// Persist identifier changes.
identifierInput.addEventListener("change", async () => {
  await saveSettings();
  setStatus("Identifier saved.");
});

// Persist sync backend changes.
syncMethodSelect.addEventListener("change", async () => {
  renderServerField();
  await saveSettings();
  setStatus("Sync method saved.");
});

// Persist server HTTP URL changes.
serverUrlInput.addEventListener("change", async () => {
  await saveSettings();
  setStatus("Server URL saved.");
});

// Persist WebSocket enable/disable toggle changes.
serverWsEnabledInput.addEventListener("change", async () => {
  await saveSettings();
  setStatus("WebSocket mode saved.");
});

// Triggers an immediate manual sync from the popup.
syncNowButton.addEventListener("click", async () => {
  syncNowButton.disabled = true;
  setStatus("Sync in progress...");

  try {
    await saveSettings();
    const response = await browser.runtime.sendMessage({ type: "styx:sync-now" });
    lastUpdated.textContent = formatRelativeTime(response ? response.lastSyncAt : 0);
    setStatus("Sync completed.");
  } catch (_error) {
    setStatus("Sync failed. Check server URL or permissions.");
  } finally {
    syncNowButton.disabled = false;
  }
});

// Periodically refreshes last-sync time displayed in the popup.
setInterval(() => {
  browser.runtime.sendMessage({ type: "styx:get-settings" }).then((response) => {
    lastUpdated.textContent = formatRelativeTime(response ? response.lastSyncAt : 0);
  });
}, 5000);

// Initial popup bootstrapping.
loadSettings().catch(() => {
  setStatus("Failed to load current settings.");
});
