// Core dependencies for REST + WebSocket server.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

// Server runtime configuration.
const HOST = process.env.STYX_SERVER_HOST || "127.0.0.1";
const PORT = Number(process.env.STYX_SERVER_PORT || 8787);
const MAX_BODY_SIZE = "1mb";

// In-memory payload store and websocket channel registry.
const store = new Map();
const app = express();
const channelMap = new Map();

// JSON parsing and permissive CORS middleware for extension clients.
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use((request, response, next) => {
	response.setHeader("Access-Control-Allow-Origin", "*");
	response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	response.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (request.method === "OPTIONS") {
		response.status(204).end();
		return;
	}

	next();
});

// Normalizes incoming sync payload structure.
function normalizePayload(input) {
	const actions = Array.isArray(input?.actions) ? input.actions : [];
	return {
		version: Number(input?.version || 1),
		updatedAt: Number(input?.updatedAt || Date.now()),
		actions,
	};
}

// Returns websocket client set for an identifier, creating it if needed.
function getOrCreateChannel(identifier) {
	if (!channelMap.has(identifier)) {
		channelMap.set(identifier, new Set());
	}
	return channelMap.get(identifier);
}

// Removes a websocket client from an identifier channel.
function removeFromChannel(identifier, socket) {
	if (!channelMap.has(identifier)) {
		return;
	}

	const channel = channelMap.get(identifier);
	channel.delete(socket);
	if (channel.size === 0) {
		channelMap.delete(identifier);
	}
}

// Broadcasts websocket messages to all peers for an identifier.
function broadcast(identifier, payload, exceptSocket = null) {
	if (!channelMap.has(identifier)) {
		return;
	}

	const message = JSON.stringify(payload);
	for (const socket of channelMap.get(identifier)) {
		if (socket === exceptSocket) {
			continue;
		}
		if (socket.readyState === 1) {
			socket.send(message);
		}
	}
}

// REST: fetch current synced state for an identifier.
app.get("/sync/:id", (request, response) => {
	const identifier = request.params.id;
	const payload = store.get(identifier) || {
		version: 1,
		updatedAt: 0,
		actions: [],
	};

	response.status(200).json(payload);
});

// REST: store updated synced state for an identifier.
app.post("/sync/:id", (request, response) => {
	const identifier = request.params.id;
	const payload = normalizePayload(request.body || {});
	payload.updatedAt = Date.now();
	store.set(identifier, payload);

	response.status(200).json({
		ok: true,
		identifier,
		storedActions: payload.actions.length,
		updatedAt: payload.updatedAt,
	});
});

// REST fallback for unknown routes.
app.use((request, response) => {
	response.status(404).json({ error: "Not found" });
});

// Error handling middleware for body size and JSON parse issues.
app.use((error, _request, response, _next) => {
	if (error && error.type === "entity.too.large") {
		response.status(413).json({ error: "Request body too large" });
		return;
	}

	if (error && error instanceof SyntaxError && error.status === 400 && "body" in error) {
		response.status(400).json({ error: "Invalid JSON" });
		return;
	}

	response.status(500).json({ error: "Internal server error" });
});

// HTTP server + websocket upgrade infrastructure.
const server = http.createServer(app);
const websocketServer = new WebSocketServer({ noServer: true });

// Handles websocket upgrade requests for /ws/sync/:id.
server.on("upgrade", (request, socket, head) => {
	try {
		const requestUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);
		const match = requestUrl.pathname.match(/^\/ws\/sync\/([^/]+)$/);
		if (!match) {
			socket.destroy();
			return;
		}

		const identifier = decodeURIComponent(match[1]);
		websocketServer.handleUpgrade(request, socket, head, (websocket) => {
			websocket.identifier = identifier;
			websocketServer.emit("connection", websocket, request);
		});
	} catch (_error) {
		socket.destroy();
	}
});

// Handles websocket lifecycle and sync messages per identifier channel.
websocketServer.on("connection", (socket) => {
	const identifier = socket.identifier;
	const channel = getOrCreateChannel(identifier);
	channel.add(socket);

	const snapshot = store.get(identifier) || {
		version: 1,
		updatedAt: 0,
		actions: [],
	};

	socket.send(JSON.stringify({
		type: "snapshot",
		identifier,
		payload: snapshot,
	}));

	socket.on("message", (rawMessage) => {
		try {
			const message = JSON.parse(String(rawMessage || "{}"));
			if (!message || typeof message !== "object") {
				return;
			}

			if (message.type === "pull") {
				const payload = store.get(identifier) || {
					version: 1,
					updatedAt: 0,
					actions: [],
				};
				socket.send(JSON.stringify({
					type: "snapshot",
					identifier,
					payload,
				}));
				return;
			}

			if (message.type !== "sync") {
				return;
			}

			const payload = normalizePayload(message.payload || {});
			payload.updatedAt = Date.now();
			store.set(identifier, payload);

			broadcast(identifier, {
				type: "sync",
				identifier,
				payload,
				sourceDeviceId: typeof message.sourceDeviceId === "string" ? message.sourceDeviceId : "",
			}, socket);
		} catch (_error) {
			socket.send(JSON.stringify({ type: "error", message: "Invalid websocket payload" }));
		}
	});

	socket.on("close", () => {
		removeFromChannel(identifier, socket);
	});
});

// Starts the combined REST + websocket server.
server.listen(PORT, HOST, () => {
	console.log(`Styx sync server listening on http://${HOST}:${PORT}`);
});
