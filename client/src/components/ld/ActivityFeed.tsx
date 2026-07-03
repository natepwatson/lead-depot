/**
 * ActivityFeed — floating right-side drawer (v11.39)
 * Real-time video-game-style event log powered by WebSocket + REST history.
 * Toggle via the pulsing button pinned in the admin header.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  X, Activity, Trophy, Phone, Heart, UserX, Upload, GitMerge,
  Star, Zap, Users, ChevronRight,
} from "lucide-react";

// ── Event types & display config ─────────────────────────────────────────────
const EVENT_META: Record<string, { label: string; icon: any; color: string; pts: number | null }> = {
  contacted_appointment: { label: "Appointment Set",     icon: Trophy,    color: "#22c55e",  pts: 10 },
  keep_in_touch:         { label: "Keep in Touch",        icon: Heart,     color: "#60a5fa",  pts: 3  },
  no_answer:             { label: "No Answer",            icon: Phone,     color: "#94a3b8",  pts: 1  },
  contacted_not_interested: { label: "Not Interested",   icon: UserX,     color: "#f87171",  pts: 1  },
  wrong_number:          { label: "Wrong Number (+2pts)", icon: Zap,       color: "#f59e0b",  pts: 2  },
  callback_requested:    { label: "Callback Requested",   icon: Phone,     color: "#a78bfa",  pts: 1  },
  network_lead_submitted:{ label: "Client Lead Submitted",icon: GitMerge,  color: "#c8aa5a",  pts: 5  },
  csv_uploaded:          { label: "Leads Uploaded",       icon: Upload,    color: "#38bdf8",  pts: null },
  agent_deactivated:     { label: "Agent Deactivated",    icon: Users,     color: "#f87171",  pts: null },
  agent_activated:       { label: "Agent Activated",      icon: Users,     color: "#22c55e",  pts: null },
};

interface FeedEvent {
  id: string;
  type: string;
  agentName?: string;
  agentHeadshot?: string | null;
  address?: string;
  count?: number;
  leadType?: string;
  ts: string;
  isNew?: boolean;
}

interface ActivityFeedProps {
  open: boolean;
  onClose: () => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
}

function Avatar({ name, headshot, size = 28, color }: { name?: string; headshot?: string | null; size?: number; color: string }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
  if (headshot) {
    return (
      <img
        src={headshot}
        alt={name}
        style={{
          width: size, height: size, borderRadius: "50%",
          objectFit: "cover", flexShrink: 0,
          border: `1.5px solid ${color}55`,
        }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `${color}22`, border: `1.5px solid ${color}55`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, color,
    }}>
      {initials}
    </div>
  );
}

function EventRow({ ev, animate }: { ev: FeedEvent; animate: boolean }) {
  const meta = EVENT_META[ev.type] || { label: ev.type, icon: Activity, color: "#94a3b8", pts: null };
  const Icon = meta.icon;
  const timeStr = (() => {
    const d = new Date(ev.ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  })();

  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        background: animate ? `${meta.color}10` : "transparent",
        transition: "background 0.8s ease",
        animation: animate ? "feedSlideIn 0.3s ease" : "none",
      }}
    >
      {/* Icon bubble */}
      <div style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: `${meta.color}18`, border: `1px solid ${meta.color}40`,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginTop: 1,
      }}>
        <Icon size={13} style={{ color: meta.color }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Avatar name={ev.agentName} headshot={ev.agentHeadshot} size={18} color={meta.color} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>
            {ev.agentName || "System"}
          </span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            {meta.label}
          </span>
          {meta.pts !== null && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: meta.color,
              background: `${meta.color}18`, borderRadius: 4,
              padding: "1px 5px", letterSpacing: "0.05em",
            }}>
              +{meta.pts}pts
            </span>
          )}
        </div>
        {(ev.address || ev.count !== undefined) && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2, paddingLeft: 24 }}>
            {ev.count !== undefined
              ? `${ev.count} leads · ${ev.leadType || ""}`
              : ev.address
            }
          </div>
        )}
      </div>

      {/* Timestamp */}
      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", flexShrink: 0, marginTop: 2 }}>
        {timeStr}
      </span>
    </div>
  );
}

export default function ActivityFeed({ open, onClose, wsRef }: ActivityFeedProps) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // ── Fetch history on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    fetch("/api/admin/activity-feed?limit=80")
      .then(r => r.json())
      .then((rows: any[]) => {
        const mapped: FeedEvent[] = rows.map(r => ({
          id: `hist_${r.id}`,
          type: r.reason,
          agentName: r.agent_name || undefined,
          agentHeadshot: r.agent_headshot || null,
          ts: r.created_at,
        }));
        setEvents(mapped);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      })
      .catch(() => {});
    setUnread(0);
  }, [open]);

  // ── Listen for WS activity_event ──────────────────────────────────────────
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== "activity_event") return;
        const ev: FeedEvent = {
          id: `live_${Date.now()}_${Math.random()}`,
          type: msg.event.type,
          agentName: msg.event.agentName,
          agentHeadshot: msg.event.agentHeadshot || null,
          address: msg.event.address,
          count: msg.event.count,
          leadType: msg.event.leadType,
          ts: msg.event.ts || new Date().toISOString(),
          isNew: true,
        };
        setEvents(prev => {
          const next = [...prev, ev].slice(-120);
          return next;
        });
        setNewIds(prev => new Set([...prev, ev.id]));
        if (!open) setUnread(u => u + 1);
        // Clear highlight after 3s
        setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(ev.id); return s; }), 3000);
        // Auto-scroll if open
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      } catch {}
    };

    const ws = wsRef.current;
    if (ws) ws.addEventListener("message", handleMessage);
    return () => { if (ws) ws.removeEventListener("message", handleMessage); };
  }, [wsRef, open]);

  // Clear unread on open
  useEffect(() => { if (open) setUnread(0); }, [open]);

  return (
    <>
      {/* CSS keyframes */}
      <style>{`
        @keyframes feedSlideIn {
          from { opacity: 0; transform: translateX(12px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes feedPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(200,170,90,0.4); }
          50%       { box-shadow: 0 0 0 6px rgba(200,170,90,0); }
        }
      `}</style>

      {/* Backdrop */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 999,
            background: "rgba(0,0,0,0.3)", backdropFilter: "blur(2px)",
          }}
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0,
          width: "min(360px, 92vw)", zIndex: 1000,
          background: "linear-gradient(180deg,#0d0c0a 0%,#080808 100%)",
          borderLeft: "1px solid rgba(200,170,90,0.15)",
          boxShadow: open ? "-20px 0 60px rgba(0,0,0,0.6)" : "none",
          display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.28s cubic-bezier(0.4,0,0.2,1)",
          willChange: "transform",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px",
          borderBottom: "1px solid rgba(200,170,90,0.12)",
          background: "rgba(10,10,8,0.98)",
          flexShrink: 0,
        }}>
          <Activity size={15} style={{ color: "#c8aa5a" }} />
          <span style={{
            flex: 1,
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: 15, fontWeight: 400, color: "#fff",
            letterSpacing: "0.06em",
          }}>
            Live Activity
          </span>
          <span style={{
            fontSize: 10, color: "rgba(200,170,90,0.5)",
            letterSpacing: "0.1em", textTransform: "uppercase",
          }}>
            Real-time
          </span>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "#22c55e",
            boxShadow: "0 0 6px #22c55e",
            animation: "feedPulse 2s ease infinite",
          }} />
          <button
            onClick={onClose}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6,
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              cursor: "pointer", color: "rgba(255,255,255,0.5)",
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Event list */}
        <div style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
          {events.length === 0 ? (
            <div style={{
              padding: "48px 20px", textAlign: "center",
              color: "rgba(255,255,255,0.25)", fontSize: 13, lineHeight: 1.7,
            }}>
              <Activity size={28} style={{ margin: "0 auto 12px", opacity: 0.3, display: "block" }} />
              Waiting for activity…
              <br />
              <span style={{ fontSize: 11 }}>Events appear here in real time</span>
            </div>
          ) : (
            events.map(ev => (
              <EventRow key={ev.id} ev={ev} animate={newIds.has(ev.id)} />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 16px", flexShrink: 0,
          borderTop: "1px solid rgba(255,255,255,0.05)",
          fontSize: 10, color: "rgba(255,255,255,0.2)",
          letterSpacing: "0.07em", textAlign: "center",
        }}>
          Showing last 120 events · auto-scrolls on new activity
        </div>
      </div>

      {/* Unread badge (shown when drawer is closed) */}
      {!open && unread > 0 && (
        <div style={{
          position: "fixed", top: 58, right: 14, zIndex: 1001,
          background: "#ef4444", color: "#fff",
          borderRadius: "50%", width: 18, height: 18,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 700,
          boxShadow: "0 0 8px rgba(239,68,68,0.6)",
          pointerEvents: "none",
        }}>
          {unread > 9 ? "9+" : unread}
        </div>
      )}
    </>
  );
}
