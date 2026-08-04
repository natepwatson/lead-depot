// v20.4.8 — Approvals tab section for pending Open Houses.
// Admin approves (→ 'open' or auto-'booked' if Denise pre-typed a host name)
// or declines with reason (→ 'declined').
import { useEffect, useState } from "react";
import { Check, X, MapPin, Calendar, Clock, User, DollarSign } from "lucide-react";

type PendingOH = {
  id: number;
  listing_id: number | null;
  address: string;
  date: string;
  time_start: string;
  time_end: string;
  listing_agent: string | null;
  list_price: number | null;
  host_preference: string | null;
  access_info: string | null;
  notes: string | null;
  source: string | null;
};

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
  return r.json();
};

const fmtDate = (d: string) => {
  try {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  } catch { return d; }
};
const fmtTime = (t: string) => {
  try {
    const [h, mi] = t.split(":").map(Number);
    const suf = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(mi).padStart(2, "0")} ${suf}`;
  } catch { return t; }
};

export function PendingOpenHousesPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [rows, setRows] = useState<PendingOH[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [decliningId, setDecliningId] = useState<number | null>(null);
  const [declineReason, setDeclineReason] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchJson("/api/admin/open-houses/pending");
      setRows(data.pending || []);
      onCountChange?.((data.pending || []).length);
    } catch (e: any) { console.error("[pending-oh] load:", e?.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleApprove = async (id: number) => {
    setBusyId(id);
    try {
      await fetchJson(`/api/admin/open-houses/${id}/approve`, { method: "POST" });
      await load();
    } catch (e: any) { alert(`Approve failed: ${e?.message}`); }
    finally { setBusyId(null); }
  };
  const handleDecline = async (id: number) => {
    setBusyId(id);
    try {
      await fetchJson(`/api/admin/open-houses/${id}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: declineReason.trim() || undefined }),
      });
      setDecliningId(null); setDeclineReason("");
      await load();
    } catch (e: any) { alert(`Decline failed: ${e?.message}`); }
    finally { setBusyId(null); }
  };

  if (loading) return <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Loading pending open houses…</div>;
  if (!rows.length) return null; // Silent when empty; parent shows count elsewhere.

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <MapPin size={18} style={{ color: "#c8aa5a" }} />
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.2rem", fontWeight: 300, color: "#fff", margin: 0 }}>
          Open Houses Awaiting Approval
        </h3>
        <span style={{
          fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600,
          padding: "3px 8px", borderRadius: 999,
          background: "rgba(200,170,90,0.15)", color: "#c8aa5a",
        }}>{rows.length}</span>
      </div>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16 }}>
        Submitted by Denise. Approve to release to agents, or decline with a reason.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((oh) => (
          <div key={oh.id} style={{
            padding: 14, borderRadius: 10,
            background: "rgba(255,255,255,0.02)", border: "1px solid rgba(200,170,90,0.15)",
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "start" }}>
              <div>
                <div style={{ fontSize: 14, color: "#fff", marginBottom: 4 }}>{oh.address}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Calendar size={11} /> {fmtDate(oh.date)}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Clock size={11} /> {fmtTime(oh.time_start)} – {fmtTime(oh.time_end)}
                  </span>
                  {oh.listing_agent && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <User size={11} /> {oh.listing_agent}
                    </span>
                  )}
                  {oh.list_price && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <DollarSign size={11} /> {oh.list_price.toLocaleString()}
                    </span>
                  )}
                </div>
                {oh.host_preference && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "#c8aa5a" }}>
                    Pre-assigned to: <strong>{oh.host_preference}</strong> (auto-booked if agent match)
                  </div>
                )}
                {oh.access_info && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                    <span style={{ opacity: 0.6 }}>Access:</span> {oh.access_info}
                  </div>
                )}
                {oh.notes && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                    <span style={{ opacity: 0.6 }}>Notes:</span> {oh.notes}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => handleApprove(oh.id)} disabled={busyId === oh.id}
                  style={{
                    padding: "6px 12px", borderRadius: 6, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600,
                    border: "1px solid rgba(126,212,154,0.4)", background: "rgba(126,212,154,0.1)", color: "#7ed49a",
                    cursor: busyId === oh.id ? "wait" : "pointer",
                    display: "inline-flex", alignItems: "center", gap: 4,
                  }}>
                  <Check size={12} /> Approve
                </button>
                <button onClick={() => { setDecliningId(oh.id); setDeclineReason(""); }} disabled={busyId === oh.id}
                  style={{
                    padding: "6px 12px", borderRadius: 6, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600,
                    border: "1px solid rgba(255,120,120,0.3)", background: "transparent", color: "rgba(255,150,150,0.7)",
                    cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
                  }}>
                  <X size={12} /> Decline
                </button>
              </div>
            </div>

            {decliningId === oh.id && (
              <div style={{ marginTop: 12, padding: 12, background: "rgba(255,90,90,0.05)", border: "1px solid rgba(255,90,90,0.15)", borderRadius: 8 }}>
                <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Reason (optional but recommended)…"
                  style={{
                    width: "100%", minHeight: 44, padding: 8, background: "rgba(0,0,0,0.35)",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#fff", fontSize: 12,
                  }} />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
                  <button onClick={() => setDecliningId(null)}
                    style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.5)", cursor: "pointer" }}>
                    Cancel
                  </button>
                  <button onClick={() => handleDecline(oh.id)} disabled={busyId === oh.id}
                    style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "rgba(255,90,90,0.15)", border: "1px solid rgba(255,90,90,0.4)", color: "#ffa0a0", cursor: "pointer" }}>
                    Confirm Decline
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
