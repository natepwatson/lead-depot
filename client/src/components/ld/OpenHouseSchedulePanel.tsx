// v20.4.7 — Open House Schedule.
// Denise fills this every Tuesday: for each active listing, does it get an
// open house this weekend? If yes, pick date + start time + length,
// optionally pre-assign a host by name, and drop lockbox/access info + notes.
// Each Yes row becomes a `pending_approval` open house row awaiting admin.
import { useState, useEffect } from "react";
import { CalendarDays, Save } from "lucide-react";

type Listing = {
  id: number;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  list_price: number | null;
  listing_agent: string | null;
};

type Pick = {
  listing_id: number;
  enabled: boolean;
  date: string;      // YYYY-MM-DD
  time_start: string; // HH:MM
  length_hours: number;
  host_preference: string;
  access_info: string;
  notes: string;
};

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
  return r.json();
};

// Compute the coming weekend Saturday + Sunday, plus following weekend.
function upcomingWeekendDates(): { label: string; value: string }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: { label: string; value: string }[] = [];
  for (let ahead = 0; ahead < 14; ahead++) {
    const d = new Date(today);
    d.setDate(d.getDate() + ahead);
    const dow = d.getDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) continue;
    const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ label, value });
    if (out.length >= 4) break;
  }
  return out;
}

const TIME_OPTIONS = [
  { label: "9:00 AM",  value: "09:00" },
  { label: "10:00 AM", value: "10:00" },
  { label: "11:00 AM", value: "11:00" },
  { label: "12:00 PM", value: "12:00" },
  { label: "1:00 PM",  value: "13:00" },
  { label: "2:00 PM",  value: "14:00" },
  { label: "3:00 PM",  value: "15:00" },
];

const LENGTH_OPTIONS = [
  { label: "2 hrs", value: 2 },
  { label: "3 hrs", value: 3 },
  { label: "4 hrs", value: 4 },
];

export function OpenHouseSchedulePanel() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const dateOptions = upcomingWeekendDates();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchJson("/api/admin/listings?status=active");
        setListings(data.listings || []);
        const initial: Record<number, Pick> = {};
        for (const l of data.listings || []) {
          initial[l.id] = {
            listing_id: l.id, enabled: false,
            date: dateOptions[0]?.value || "",
            time_start: "10:00", length_hours: 3,
            host_preference: "", access_info: "", notes: "",
          };
        }
        setPicks(initial);
      } catch (e: any) {
        setStatusMsg(`Failed to load listings: ${e?.message}`);
      } finally { setLoading(false); }
    };
    load();
  }, []);

  const updatePick = (id: number, patch: Partial<Pick>) => {
    setPicks((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const handleSubmit = async () => {
    const yes = Object.values(picks).filter((p) => p.enabled);
    if (!yes.length) { setStatusMsg("No open houses selected."); return; }
    const missingAccess = yes.filter((p) => !p.access_info.trim());
    if (missingAccess.length) {
      setStatusMsg(`${missingAccess.length} row(s) missing Access Info.`);
      return;
    }
    setSubmitting(true); setStatusMsg("Submitting…");
    try {
      const body = {
        picks: yes.map((p) => ({
          listing_id: p.listing_id,
          date: p.date,
          time_start: p.time_start,
          length_hours: p.length_hours,
          host_preference: p.host_preference.trim() || undefined,
          access_info: p.access_info.trim(),
          notes: p.notes.trim() || undefined,
        })),
      };
      const res = await fetchJson("/api/admin/open-house-schedule", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      setStatusMsg(`✓ Submitted ${res.created} open houses for approval${res.failed ? ` (${res.failed} failed)` : ""}.`);
      // Reset enabled flags after success
      setPicks((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) next[Number(id)] = { ...next[Number(id)], enabled: false };
        return next;
      });
    } catch (e: any) { setStatusMsg(`Submit failed: ${e?.message}`); }
    finally { setSubmitting(false); }
  };

  const enabledCount = Object.values(picks).filter((p) => p.enabled).length;

  if (loading) return <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>Loading active listings…</div>;
  if (!listings.length) return (
    <div style={{ padding: 40, textAlign: "center", border: "1px dashed rgba(255,255,255,0.06)", borderRadius: 8 }}>
      <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>No active listings yet.</p>
      <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, marginTop: 8 }}>Upload active listings on the Upload CSV tab first.</p>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <CalendarDays size={20} style={{ color: "#c8aa5a" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.4rem", fontWeight: 300, color: "#fff", margin: 0 }}>
          Open House Schedule
        </h2>
      </div>
      <p className="text-sm text-muted-foreground" style={{ marginBottom: 20 }}>
        For each active listing, mark <strong style={{ color: "#c8aa5a" }}>Yes</strong> if it's open this weekend, then set date, start time, length, and access info. Optional: type an agent's name to pre-assign the host. Each Yes row goes to Approvals.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
        {listings.map((l) => {
          const p = picks[l.id];
          if (!p) return null;
          return (
            <div key={l.id} style={{
              padding: 14, borderRadius: 10,
              background: p.enabled ? "rgba(200,170,90,0.05)" : "rgba(255,255,255,0.02)",
              border: `1px solid ${p.enabled ? "rgba(200,170,90,0.3)" : "rgba(255,255,255,0.05)"}`,
              transition: "all 0.15s",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: p.enabled ? 12 : 0 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 90 }}>
                  <input type="checkbox" checked={p.enabled}
                    onChange={(e) => updatePick(l.id, { enabled: e.target.checked })}
                    style={{ width: 16, height: 16, accentColor: "#c8aa5a" }} />
                  <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: p.enabled ? "#c8aa5a" : "rgba(255,255,255,0.4)", fontWeight: 600 }}>
                    Open House
                  </span>
                </label>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: "#fff" }}>{l.address}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                    {[l.city, l.state, l.zip].filter(Boolean).join(", ")}
                    {l.listing_agent ? ` · ${l.listing_agent}` : ""}
                    {l.list_price ? ` · $${l.list_price.toLocaleString()}` : ""}
                  </div>
                </div>
              </div>

              {p.enabled && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 8 }}>
                  <label style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Date
                    <select value={p.date} onChange={(e) => updatePick(l.id, { date: e.target.value })}
                      style={selectStyle}>
                      {dateOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Start Time
                    <select value={p.time_start} onChange={(e) => updatePick(l.id, { time_start: e.target.value })}
                      style={selectStyle}>
                      {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Length
                    <select value={p.length_hours} onChange={(e) => updatePick(l.id, { length_hours: Number(e.target.value) })}
                      style={selectStyle}>
                      {LENGTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Pre-Assign Host <span style={{ textTransform: "none", opacity: 0.5 }}>(optional)</span>
                    <input value={p.host_preference} onChange={(e) => updatePick(l.id, { host_preference: e.target.value })}
                      placeholder="Agent name" style={inputStyle} />
                  </label>
                  <label style={{ gridColumn: "1 / -1", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Access Info <span style={{ color: "#e57373" }}>*required</span>
                    <textarea value={p.access_info} onChange={(e) => updatePick(l.id, { access_info: e.target.value })}
                      placeholder="Lockbox code, alarm code, garage code, key location…"
                      style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} />
                  </label>
                  <label style={{ gridColumn: "1 / -1", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    Notes <span style={{ textTransform: "none", opacity: 0.5 }}>(optional)</span>
                    <textarea value={p.notes} onChange={(e) => updatePick(l.id, { notes: e.target.value })}
                      placeholder="Parking notes, pet warning, staging quirks…"
                      style={{ ...inputStyle, minHeight: 44, resize: "vertical" }} />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ position: "sticky", bottom: 0, background: "#0a0a0a", padding: "12px 0",
        borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 13, color: enabledCount ? "#c8aa5a" : "rgba(255,255,255,0.4)" }}>
          {enabledCount} listing{enabledCount === 1 ? "" : "s"} selected
        </div>
        <button onClick={handleSubmit} disabled={submitting || !enabledCount}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 20px",
            borderRadius: 8, fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
            border: "1px solid rgba(200,170,90,0.5)",
            background: enabledCount ? "rgba(200,170,90,0.15)" : "rgba(255,255,255,0.03)",
            color: enabledCount ? "#c8aa5a" : "rgba(255,255,255,0.3)",
            cursor: enabledCount ? "pointer" : "not-allowed",
          }}>
          <Save size={14} /> {submitting ? "Submitting…" : "Submit Schedule"}
        </button>
      </div>
      {statusMsg && (
        <div style={{ marginTop: 10, fontSize: 12, color: statusMsg.startsWith("✓") ? "#7ed49a" : "rgba(255,170,170,0.85)" }}>{statusMsg}</div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", marginTop: 4, padding: "6px 8px",
  background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 6, color: "#fff", fontSize: 12, letterSpacing: "normal", textTransform: "none",
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };
