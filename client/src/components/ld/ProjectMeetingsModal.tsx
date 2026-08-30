// v20.32.19 — Part 8 admin surface: view/schedule the 3-meeting repair
// cadence (Initial Start / Punch-Out / Final Payment). Backend
// (repair_project_meetings table, GET/PATCH endpoints, auto-row-creation via
// fireMilestoneTasks) already existed since v20.32.13 — this modal was the
// missing admin visibility layer so Alex/Nate can actually see and adjust
// the 3 meeting dates instead of only having them fire silently into FUB.
// v20.39.2 — Alex: "The start date, project work days, and the project
// manager meetings should all be on the same page." Folded the old
// prompt()-based "Schedule Start Date" flow (a standalone button that
// called POST /api/repair-consult/:id/start-window) into this modal as a
// proper Start Date & Time section at the top. One "Schedule" button now
// opens this single page for both start date and all 3 meetings — replaces
// the separate Schedule + Meetings buttons everywhere this modal is used.
import { useEffect, useState } from "react";

const GOLD = "#c8aa5a";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 13,
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.14)", color: "#e6e6e6",
};
const labelStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 4, display: "block" };

type MeetingType = "initial_start" | "punch_out" | "final_payment";
type MeetingRow = { id: number; meeting_type: MeetingType; scheduled_at: string | null; completed_at: string | null; notes: string | null };

const MEETING_LABELS: Record<MeetingType, string> = {
  initial_start: "Initial Start Meeting",
  punch_out: "Punch-Out Meeting",
  final_payment: "Final Payment Meeting",
};
const MEETING_ORDER: MeetingType[] = ["initial_start", "punch_out", "final_payment"];

function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ProjectMeetingsModal({
  consultId, propertyAddress, onClose,
  startDate, startTime, onScheduleSaved,
}: {
  consultId: number;
  propertyAddress: string;
  onClose: () => void;
  // v20.39.2 — initial Start Date/Time values from the parent's consult
  // row, so this modal doesn't need its own extra fetch just to seed the
  // Start Date fields. Optional so existing call sites that haven't been
  // updated yet still compile and render (fields just start blank).
  startDate?: string | null;
  startTime?: string | null;
  // Called after a successful Start Date save so the parent list/board can
  // refresh (mirrors the old scheduleStart()'s post-save load()).
  onScheduleSaved?: () => void;
}) {
  const [startDateVal, setStartDateVal] = useState(startDate || "");
  const [startTimeVal, setStartTimeVal] = useState(startTime || "");
  const [savingStart, setSavingStart] = useState(false);
  const [startError, setStartError] = useState("");

  async function saveStart() {
    setSavingStart(true);
    setStartError("");
    try {
      const r = await fetch(`/api/repair-consult/${consultId}/start-window`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startWindow: startDateVal.trim() ? "specific" : null,
          startDate: startDateVal.trim() || null,
          startTime: startTimeVal.trim() || null,
        }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.error || "Failed to save start date");
      onScheduleSaved?.();
    } catch (e: any) {
      setStartError(e.message || "Failed to save start date");
    } finally {
      setSavingStart(false);
    }
  }

  const [rows, setRows] = useState<Record<MeetingType, MeetingRow | null>>({ initial_start: null, punch_out: null, final_payment: null });
  const [drafts, setDrafts] = useState<Record<MeetingType, { scheduledAt: string; completedAt: string; notes: string }>>({
    initial_start: { scheduledAt: "", completedAt: "", notes: "" },
    punch_out: { scheduledAt: "", completedAt: "", notes: "" },
    final_payment: { scheduledAt: "", completedAt: "", notes: "" },
  });
  const [loading, setLoading] = useState(true);
  const [savingType, setSavingType] = useState<MeetingType | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/repair-consult/${consultId}/meetings`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        const byType: Record<MeetingType, MeetingRow | null> = { initial_start: null, punch_out: null, final_payment: null };
        for (const row of (d.meetings || []) as MeetingRow[]) byType[row.meeting_type] = row;
        setRows(byType);
        setDrafts({
          initial_start: { scheduledAt: toDateTimeLocal(byType.initial_start?.scheduled_at ?? null), completedAt: toDateTimeLocal(byType.initial_start?.completed_at ?? null), notes: byType.initial_start?.notes || "" },
          punch_out: { scheduledAt: toDateTimeLocal(byType.punch_out?.scheduled_at ?? null), completedAt: toDateTimeLocal(byType.punch_out?.completed_at ?? null), notes: byType.punch_out?.notes || "" },
          final_payment: { scheduledAt: toDateTimeLocal(byType.final_payment?.scheduled_at ?? null), completedAt: toDateTimeLocal(byType.final_payment?.completed_at ?? null), notes: byType.final_payment?.notes || "" },
        });
      })
      .catch(() => setError("Could not load meetings."))
      .finally(() => setLoading(false));
  }, [consultId]);

  async function save(type: MeetingType) {
    setSavingType(type);
    setError("");
    const d = drafts[type];
    try {
      const r = await fetch(`/api/admin/repair-consult/${consultId}/meetings/${type}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduledAt: d.scheduledAt ? new Date(d.scheduledAt).toISOString() : null,
          completedAt: d.completedAt ? new Date(d.completedAt).toISOString() : null,
          notes: d.notes || null,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Failed to save");
      const refreshed = await fetch(`/api/repair-consult/${consultId}/meetings`, { credentials: "include" }).then(res => res.json());
      const updated = (refreshed.meetings || []).find((m: MeetingRow) => m.meeting_type === type) || null;
      setRows(prev => ({ ...prev, [type]: updated }));
    } catch (e: any) {
      setError(e.message || "Failed to save");
    } finally {
      setSavingType(null);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", background: "#141414", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 12, padding: 20 }}>
        <h3 style={{ margin: 0, marginBottom: 4, fontSize: 16, fontWeight: 700, color: GOLD }}>Schedule</h3>
        <p style={{ margin: 0, marginBottom: 14, fontSize: 12, color: "#94a3b8" }}>{propertyAddress}</p>

        <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
          <p style={{ margin: 0, marginBottom: 8, fontSize: 12.5, fontWeight: 700, color: "#e5e7eb" }}>Start Date</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
            <div>
              <label style={labelStyle}>Date</label>
              <input style={inputStyle} type="date" value={startDateVal} onChange={e => setStartDateVal(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Time (optional)</label>
              <input style={inputStyle} type="text" placeholder="e.g. 9:00 AM" value={startTimeVal} onChange={e => setStartTimeVal(e.target.value)} />
            </div>
          </div>
          {startError && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{startError}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={saveStart} disabled={savingStart}
              style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: GOLD, border: "none", color: "#141414", cursor: savingStart ? "default" : "pointer", opacity: savingStart ? 0.6 : 1 }}>
              {savingStart ? "Saving..." : "Save Start Date"}
            </button>
          </div>
        </div>

        <p style={{ margin: 0, marginBottom: 10, fontSize: 12.5, fontWeight: 700, color: "#e5e7eb" }}>Project Meetings</p>

        {loading ? (
          <p style={{ fontSize: 12, color: "#94a3b8" }}>Loading...</p>
        ) : (
          MEETING_ORDER.map(type => {
            const row = rows[type];
            const d = drafts[type];
            return (
              <div key={type} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "#e5e7eb" }}>{MEETING_LABELS[type]}</p>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: row?.completed_at ? "#4ade80" : row?.scheduled_at ? "#5eead4" : "#64748b" }}>
                    {row?.completed_at ? "Completed" : row?.scheduled_at ? "Scheduled" : "Not yet scheduled"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
                  <div>
                    <label style={labelStyle}>Scheduled</label>
                    <input style={inputStyle} type="datetime-local" value={d.scheduledAt}
                      onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...prev[type], scheduledAt: e.target.value } }))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Completed</label>
                    <input style={inputStyle} type="datetime-local" value={d.completedAt}
                      onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...prev[type], completedAt: e.target.value } }))} />
                  </div>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={labelStyle}>Notes</label>
                  <input style={inputStyle} placeholder="Optional" value={d.notes}
                    onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...prev[type], notes: e.target.value } }))} />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => save(type)} disabled={savingType === type}
                    style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: GOLD, border: "none", color: "#141414", cursor: savingType === type ? "default" : "pointer", opacity: savingType === type ? 0.6 : 1 }}>
                    {savingType === type ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            );
          })
        )}

        {error && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 10 }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", cursor: "pointer" }}>Close</button>
        </div>
      </div>
    </div>
  );
}
