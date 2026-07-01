// ─── WebSocket broadcast hub ──────────────────────────────────────────────────
// Attach to the existing HTTP server. Broadcasts real-time events to all
// connected clients whenever leads or agents change.

import { createRequire } from "node:module";
import type { Server } from "node:http";

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const { WebSocketServer } = require("ws");

let wss: any = null;

export function initWebSocket(httpServer: Server) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: any) => {
    // Send a welcome ping so the client knows it's live
    ws.send(JSON.stringify({ type: "connected" }));

    ws.on("error", () => {}); // swallow individual client errors
  });

  console.log("[ws] WebSocket server ready on /ws");
}

// Broadcast an event to every connected client
export function broadcast(event: { type: string; [key: string]: any }) {
  if (!wss) return;
  const msg = JSON.stringify(event);
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}
