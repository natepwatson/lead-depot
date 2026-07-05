/**
 * HomeCountyGate — v13.10
 * Required first-login step for agents (not admins).
 * Agent must pick their home county before entering the app.
 * Cannot skip. Applies whenever homeCounty is null/empty.
 */
import { useState } from "react";
import { MapPin, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface HomeCountyGateProps {
  userId: number;
  userName: string;
  onComplete: (county: string) => void;
}

const COUNTIES = [
  { value: "Nassau",   desc: "Yulee, Fernandina Beach, Callahan, Hilliard" },
  { value: "Duval",    desc: "Jacksonville, Jax Beach, Atlantic Beach" },
  { value: "St Johns", desc: "St Augustine, Ponte Vedra, Nocatee, WGV" },
];

export default function HomeCountyGate({ userId, userName, onComplete }: HomeCountyGateProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const firstName = userName.split(" ")[0];

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await apiRequest("PATCH", `/api/agents/${userId}/home-county`, { homeCounty: selected });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || "Save failed", variant: "destructive" });
        return;
      }
      setDone(true);
      setTimeout(() => onComplete(selected), 900);
    } catch {
      toast({ title: "Network error. Try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9998,
      background: "linear-gradient(160deg, #0a0a0a 0%, #0f0d08 100%)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "24px 20px",
      fontFamily: "'Switzer','Inter',sans-serif",
      overflowY: "auto",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "absolute", top: "30%", left: "50%", transform: "translate(-50%,-50%)",
        width: 400, height: 400, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(56,189,248,0.06) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* Logo */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none" style={{ margin: "0 auto 10px", display: "block" }}>
          <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
          <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
          <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
        </svg>
        <p style={{ color: "rgba(200,170,90,0.6)", letterSpacing: "0.2em", fontSize: 10, textTransform: "uppercase", margin: 0 }}>
          Brothers Group · Momentum Realty
        </p>
      </div>

      <div style={{
        width: "100%", maxWidth: 440,
        background: "rgba(15,13,8,0.96)",
        border: "1px solid rgba(200,170,90,0.2)",
        borderRadius: 18, padding: "32px 24px 28px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
      }}>
        {done ? (
          <div style={{ textAlign: "center" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <CheckCircle2 size={28} style={{ color: "#22c55e" }} />
            </div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              color: "#fff", fontWeight: 300, fontSize: "1.6rem", margin: "0 0 8px",
            }}>
              You're set, {firstName}.
            </h2>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
              Loading your leads…
            </p>
          </div>
        ) : (
          <>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <MapPin size={28} style={{ color: "#38bdf8", margin: "0 auto 10px" }} />
              <h2 style={{
                fontFamily: "'Cormorant Garamond','Georgia',serif",
                color: "#fff", fontWeight: 300, fontSize: "1.55rem", margin: "0 0 8px",
              }}>
                Welcome, {firstName}.
              </h2>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6 }}>
                Pick the county you live in. Leads there get served to you first. If your home county runs dry, you'll pull from other counties automatically.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {COUNTIES.map(c => {
                const isActive = selected === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() => setSelected(c.value)}
                    style={{
                      textAlign: "left",
                      padding: "14px 16px",
                      borderRadius: 10,
                      background: isActive
                        ? "linear-gradient(135deg, rgba(56,189,248,0.14) 0%, rgba(56,189,248,0.05) 100%)"
                        : "rgba(255,255,255,0.025)",
                      border: `1.5px solid ${isActive ? "rgba(56,189,248,0.55)" : "rgba(255,255,255,0.08)"}`,
                      color: "#fff",
                      cursor: "pointer",
                      transition: "all 0.15s",
                      fontFamily: "inherit",
                      display: "flex", alignItems: "center", gap: 12,
                    }}
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: "50%",
                      border: `2px solid ${isActive ? "#38bdf8" : "rgba(255,255,255,0.25)"}`,
                      background: isActive ? "#38bdf8" : "transparent",
                      flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {isActive && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#0a0a0a" }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{
                        fontSize: 15, fontWeight: 600,
                        color: isActive ? "#38bdf8" : "#fff",
                        margin: "0 0 3px",
                      }}>{c.value} County</p>
                      <p style={{
                        fontSize: 11, color: "rgba(255,255,255,0.45)", margin: 0,
                      }}>{c.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleSave}
              disabled={!selected || saving}
              style={{
                width: "100%", padding: "13px",
                background: !selected || saving
                  ? "rgba(200,170,90,0.2)"
                  : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
                color: !selected || saving ? "rgba(255,255,255,0.3)" : "#080808",
                cursor: !selected || saving ? "not-allowed" : "pointer",
                boxShadow: selected && !saving ? "0 4px 16px rgba(200,170,90,0.25)" : "none",
                transition: "all 0.2s",
              }}
            >
              {saving ? "Saving…" : "Continue"}
            </button>

            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", textAlign: "center", marginTop: 14 }}>
              This is a one-time choice. An admin can change it later if you move.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
