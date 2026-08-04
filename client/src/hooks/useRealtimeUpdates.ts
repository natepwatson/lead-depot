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
            case "lead_deleted":
              // Invalidate all lead-related queries so every view refreshes
              qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
              qc.invalidateQueries({ queryKey: ["/api/leads"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
              qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] });
              qc.invalidateQueries({ queryKey: ["/api/leads/my-pipeline"] });
              qc.invalidateQueries({ queryKey: ["/api/leads/stats"] });
              // Invalidate queue counts for all agents
              qc.invalidateQueries({ predicate: (q) =>
                String(q.queryKey[0]).startsWith("/api/leads/my-count")
              });
              break;

            // v19.5 — Instant dial + points refresh. Any outcome-logged activity
            // (dial, KIT, appt, wrong number, disconnected, voicemail) fires this
            // event server-side. Leaderboard, team pot, agent stats, live-count,
            // and reports/outcomes must all refresh without waiting for the poll.
            case "points_awarded":
            case "activity_event":
              qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
              qc.invalidateQueries({ queryKey: ["/api/team-pot"] });
              qc.invalidateQueries({ queryKey: ["/api/agents/live-agents"] });
              qc.invalidateQueries({ queryKey: ["/api/agents/live-count"] });
              qc.invalidateQueries({ queryKey: ["/api/reports/outcomes"] });
              qc.invalidateQueries({ queryKey: ["/api/leads/stats"] });
              qc.invalidateQueries({ queryKey: ["/api/challenges"] });
              break;

            // v19.5 — Approval decisions (approve/reject) instantly refresh:
            //   • the pending-approvals queue in the admin dashboard
            //   • the agent's leaderboard + team pot totals if points were awarded
            //   • the challenge-completions tab if this was a challenge_claim
            case "approval_event":
              qc.invalidateQueries({ queryKey: ["/api/admin/approvals"] });
              qc.invalidateQueries({ queryKey: ["/api/challenges"] });
              qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/leaderboard"] });
              qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
              qc.invalidateQueries({ queryKey: ["/api/team-pot"] });
              break;

            // v20.4.8 — FUB seat overage: this approve pushed us past 10 included
            // Pro seats and now costs +$49/mo. Refresh the seats pill and fire a
            // window event so the admin dashboard can surface a toast.
            case "fub_seat_overage":
              qc.invalidateQueries({ queryKey: ["/api/admin/fub-seats"] });
              try {
                window.dispatchEvent(new CustomEvent("ld:fub_seat_overage", { detail: event }));
              } catch {}
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
