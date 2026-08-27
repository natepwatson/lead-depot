// v20.33.4 — Work Calendar/Scheduler admin tab. Aggregates job start dates,
// job target-completion dates, project meetings (initial start / punch-out /
// final payment), inspection needed-by + contingency-expiration dates, and
// upcoming open houses into one chronological agenda grouped by day. A flat
// agenda list rather than a grid calendar — far more reliable to build/QA
// and matches how Alex/Nate actually read a day's schedule.
import { useEffect, useState } from "react";
import { RefreshCw, CalendarClock, Wrench, ClipboardCheck, Home, HardHat, Handshake, ReceiptText, AlertTriangle } from "lucide-react";

const GOLD = "#c8aa5a";

type CalEvent = {
  event_date: string;
  event_type: string;
  property_address: string;
  client_name: string | null;
  agent_name: string | null;
  source_id: number;
  source_type: string;
  extra: string | null;
};

const EVENT_META: Record<string, { label: string; icon: any; color: string }> = {
  job_start: { label: "Job Start", icon: HardHat, color: "#93c5fd" },
  job_target_completion: { label: "Target Completion", icon: Wrench, color: GOLD },
  meeting_initial_start: { label: "Initial Start Meeting", icon: Handshake, color: "#c4b5fd" },
  meeting_punch_out: { label: "Punch-Out Walkthrough", icon: ClipboardCheck, color: "#c4b5fd" },
  meeting_final_payment: { label: "Final Payment Meeting", icon: ReceiptText, color: "#4ade80" },
  inspection_needed_by: { label: "Inspection Needed By", icon: ClipboardCheck, color: "#93c5fd" },
  inspection_contingency_expiration: { label: "Contingency Expires", icon: AlertTriangle, color: "#f87171" },
  open_house: { label: "Open House", icon: Home, color: "#facc15" },
};

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  const base = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (diffDays === 0) return `Today — ${base}`;
  if (diffDays === 1) return `Tomorrow — ${base}`;
  if (diffDays < 0) return `${base} (${Math.abs(diffDays)}d ago)`;
  return base;
}

export function WorkCalendarPanel() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/work-calendar", { credentials: "include" });
      const d = await r.json();
      setEvents(d.events || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const grouped: { date: string; items: CalEvent[] }[] = [];
  for (const ev of events) {
    const last = grouped[grouped.length - 1];
    if (last && last.date === ev.event_date) last.items.push(ev);
    else grouped.push({ date: ev.event_date, items: [ev] });
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
          <CalendarClock size={13} color={GOLD} /> Work Calendar
        </h3>
        <button onClick={load} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Every dated, schedulable event across the app in one place — job start &amp; target-completion dates, project
        meetings, inspection deadlines, and upcoming open houses. Sorted soonest first; anything within the last
        7 days that's still open shows too, so nothing slips through.
      </p>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading calendar…</div>
      ) : grouped.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Nothing scheduled right now.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {grouped.map(g => {
            const isPast = g.date < todayStr;
            return (
              <div key={g.date}>
                <div style={{
                  fontSize: 11.5, fontWeight: 700, color: isPast ? "#f87171" : GOLD, marginBottom: 6,
                  textTransform: "uppercase", letterSpacing: 0.3,
                }}>{fmtDate(g.date)}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {g.items.map((ev, i) => {
                    const meta = EVENT_META[ev.event_type] || { label: ev.event_type, icon: CalendarClock, color: "#94a3b8" };
                    const Icon = meta.icon;
                    return (
                      <div key={i} style={{
                        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "9px 12px",
                        background: "rgba(255,255,255,0.02)", display: "flex", justifyContent: "space-between",
                        alignItems: "flex-start", flexWrap: "wrap", gap: 8,
                      }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <Icon size={13} color={meta.color} style={{ marginTop: 2, flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#e5e7eb" }}>{ev.property_address}</div>
                            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>
                              {ev.client_name ? `${ev.client_name} · ` : ""}Agent: {ev.agent_name || "—"}
                              {ev.extra ? ` · ${ev.extra}` : ""}
                            </div>
                          </div>
                        </div>
                        <span style={{
                          fontSize: 10.5, padding: "3px 8px", borderRadius: 4, whiteSpace: "nowrap",
                          color: meta.color, background: `${meta.color}15`, border: `1px solid ${meta.color}55`,
                        }}>{meta.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
