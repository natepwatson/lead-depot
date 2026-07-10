// ─── Real-time WebSocket hook ─────────────────────────────────────────────────
// Connects to /ws and invalidates React Query caches on server broadcast events.
// Drop this into any page component — it's idempotent and self-reconnects.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const RECONNECT_DELAY = 3000;

// v14.80 — Now returns { connected } so the UI can render a live heartbeat dot.
export function useRealtimeUpdates() {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          switch (event.type) {
            case "leads_updated":  // bulk broadcast (redistribute, morning run, etc.)
            case "lead_updated":
            case "lead_created":
              // Invalidate all lead-related queries so every view refreshes
              qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
              qc.invalidateQueries({ queryKey: ["/api/leads"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
              qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
              // Invalidate queue counts for all agents
              qc.invalidateQueries({ predicate: (q) =>
                String(q.queryKey[0]).startsWith("/api/leads/my-count")
              });
              break;
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (!destroyed) {
          // Auto-reconnect after delay
          timerRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      destroyed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [qc]);

  return { connected };
}
