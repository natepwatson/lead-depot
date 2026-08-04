// v20.4.7 — Agent-facing Book Open House sheet.
// Shows currently open (approved, unclaimed) open houses. Book = atomic claim.
// On success, agent gets a rich Accept email server-side (address, date/time,
// listing agent, list price, access info, prep checklist).
import { useEffect, useState } from "react";
import { MapPin, Calendar, Clock, User, DollarSign, Loader2 } from "lucide-react";

type OH = {
  id: number;
  address: string;
  date: string;
  time_start: string;
  time_end: string;
  listing_agent: string | null;
  list_price: number | null;
  status: "open" | "booked";
  claimed_by_id: string | null;
  claimed_by_name: string | null;
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

export function BookOpenHouseSheet({ userId, onBooked }: { userId?: string; onBooked?: () => void }) {
  const [rows, setRows] = useState<OH[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const d = await fetchJson("/api/open-houses/upcoming");
      setRows(d.openHouses || []);
    } catch (e: any) { setMsg(`Failed to load: ${e?.message}`); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleClaim = async (id: number, address: string) => {
    if (!confirm(`Book this open house?\n\n${address}\n\nYou'll get an email with all the details.`)) return;
    setBusyId(id); setMsg("");
    try {
      await fetchJson(`/api/open-houses/${id}/claim`, { method: "POST" });
      setMsg("✓ Booked! Check your email for full details.");
      onBooked?.();
      await load();
    } catch (e: any) {
      setMsg(`Could not book: ${e?.message || "unknown"}`);
      await load(); // Refresh in case someone else grabbed it.
    } finally { setBusyId(null); }
  };

  const openRows = rows.filter((r) => r.status === "open");
  const myBooked = rows.filter((r) => r.status === "booked" && r.claimed_by_id === userId);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 20, color: "rgba(255,255,255,0.5)", fontSize: 13 }}>
      <Loader2 size={14} className="animate-spin" /> Loading open houses…
    </div>
  );

  return (
    <div>
      {msg && (
        <div style={{ padding: 10, marginBottom: 12, borderRadius: 8,
          background: msg.startsWith("✓") ? "rgba(126,212,154,0.1)" : "rgba(255,120,120,0.1)",
          color: msg.startsWith("✓") ? "#7ed49a" : "#ffb0b0", fontSize: 12,
        }}>{msg}</div>
      )}

      {myBooked.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "#c8aa5a", marginBottom: 8, fontWeight: 600 }}>
            Your booked open houses
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {myBooked.map((oh) => <BookedRow key={oh.id} oh={oh} />)}
          </div>
        </div>
      )}

      {openRows.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 10 }}>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, margin: 0 }}>No open houses available right now.</p>
          <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, marginTop: 6 }}>Check back after Denise's Tuesday schedule is approved.</p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 8, fontWeight: 600 }}>
            Available — first come, first serve
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {openRows.map((oh) => (
              <div key={oh.id} style={{
                padding: 14, borderRadius: 10,
                background: "linear-gradient(135deg, rgba(200,170,90,0.08) 0%, rgba(200,170,90,0.03) 100%)",
                border: "1px solid rgba(200,170,90,0.3)",
              }}>
                <div style={{ display: "flex", alignItems: "start", gap: 10, marginBottom: 10 }}>
                  <MapPin size={16} style={{ color: "#c8aa5a", flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, color: "#fff", fontWeight: 500 }}>{oh.address}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
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
                  </div>
                </div>
                <button onClick={() => handleClaim(oh.id, oh.address)} disabled={busyId === oh.id}
                  style={{
                    width: "100%", padding: "10px 16px", borderRadius: 8,
                    fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase",
                    background: busyId === oh.id ? "rgba(200,170,90,0.1)" : "#c8aa5a",
                    color: busyId === oh.id ? "#c8aa5a" : "#0a0a0a",
                    border: "1px solid rgba(200,170,90,0.6)",
                    cursor: busyId === oh.id ? "wait" : "pointer",
                  }}>
                  {busyId === oh.id ? "Booking…" : "Book This Open House"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BookedRow({ oh }: { oh: OH }) {
  return (
    <div style={{
      padding: 12, borderRadius: 8,
      background: "rgba(126,212,154,0.05)", border: "1px solid rgba(126,212,154,0.2)",
    }}>
      <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
        <MapPin size={13} style={{ color: "#7ed49a", flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "#fff" }}>{oh.address}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
            {fmtDate(oh.date)} · {fmtTime(oh.time_start)} – {fmtTime(oh.time_end)}
          </div>
          <div style={{ fontSize: 10, color: "#7ed49a", marginTop: 4, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            ✓ Booked — check your email for access info
          </div>
        </div>
      </div>
    </div>
  );
}
