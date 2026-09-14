/**
 * HomeTerritoryGate — v20.58.8
 * Required first-login step for agents (not admins).
 * Agent must pick primary territory (territory1) before entering the app.
 * Optional second territory (territory2).
 * Migrated from HomeCountyGate — Duval/St Johns home_county no longer maps
 * unambiguously, so agents without territory1 are forced to pick.
 */
import { useState } from "react";
import { MapPin, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface HomeTerritoryGateProps {
  userId: number;
  userName: string;
  onComplete: (territory1: string, territory2?: string | null) => void;
}

const TERRITORIES = [
  { value: "nassau", display: "Nassau", desc: "Fernandina, Yulee, Callahan, Hilliard" },
  { value: "northside", display: "Northside", desc: "Oceanway, Dinsmore, Baldwin, North Jax" },
  { value: "east_jax", display: "East Jax", desc: "Arlington, Southside, Mandarin, San Marco" },
  { value: "intercoastal_towncenter", display: "Intercoastal/Towncenter", desc: "32246 · 32256 Town Center / ICW" },
  { value: "jax_beaches", display: "Jax Beaches", desc: "Atlantic, Neptune, Jax Beach, Mayport" },
  { value: "ponte_vedra", display: "Ponte Vedra", desc: "PVB, Nocatee, St. Augustine corridor" },
  { value: "west_jax", display: "West Jax", desc: "Westside, Oakleaf, Ortega, Whitehouse" },
  { value: "st_johns_inland", display: "St Johns Inland", desc: "Fruit Cove, Julington, Hastings" },
];

export default function HomeCountyGate({ userId, userName, onComplete }: HomeTerritoryGateProps) {
  const { toast } = useToast();
  const [primary, setPrimary] = useState<string | null>(null);
  const [secondary, setSecondary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const firstName = userName.split(" ")[0];

  const handleSave = async () => {
    if (!primary) return;
    setSaving(true);
    try {
      const res = await apiRequest("PATCH", `/api/agents/${userId}/home-territory`, {
        territory1: primary,
        territory2: secondary || null,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || "Save failed", variant: "destructive" });
        return;
      }
      setDone(true);
      setTimeout(() => onComplete(primary, secondary), 900);
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
      <div style={{
        position: "absolute", top: "30%", left: "50%", transform: "translate(-50%,-50%)",
        width: 400, height: 400, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(56,189,248,0.06) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

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
        width: "100%", maxWidth: 480,
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
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <MapPin size={28} style={{ color: "#38bdf8", margin: "0 auto 10px" }} />
              <h2 style={{
                fontFamily: "'Cormorant Garamond','Georgia',serif",
                color: "#fff", fontWeight: 300, fontSize: "1.55rem", margin: "0 0 8px",
              }}>
                Welcome, {firstName}.
              </h2>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6 }}>
                Pick your primary territory. Leads there get served first. If it runs dry, you'll overflow to other territories automatically. Optionally add a second.
              </p>
            </div>

            <p style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,170,90,0.55)", marginBottom: 8, fontWeight: 700 }}>
              Primary territory *
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {TERRITORIES.map(c => {
                const isActive = primary === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => {
                      setPrimary(c.value);
                      if (secondary === c.value) setSecondary(null);
                    }}
                    style={{
                      textAlign: "left",
                      padding: "12px 14px",
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
                        fontSize: 14, fontWeight: 600,
                        color: isActive ? "#38bdf8" : "#fff",
                        margin: "0 0 2px",
                      }}>{c.display}</p>
                      <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", margin: 0 }}>{c.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <p style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,170,90,0.55)", marginBottom: 8, fontWeight: 700 }}>
              Second territory (optional)
            </p>
            <select
              value={secondary || ""}
              onChange={(e) => setSecondary(e.target.value || null)}
              style={{
                width: "100%", marginBottom: 18,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(200,170,90,0.2)",
                borderRadius: 8, padding: "11px 14px",
                color: "#fff", fontSize: 14, outline: "none",
              }}
            >
              <option value="" style={{ background: "#0a0a0a" }}>None</option>
              {TERRITORIES.filter(t => t.value !== primary).map(t => (
                <option key={t.value} value={t.value} style={{ background: "#0a0a0a" }}>{t.display}</option>
              ))}
            </select>

            <button
              onClick={handleSave}
              disabled={!primary || saving}
              style={{
                width: "100%", padding: "13px",
                background: !primary || saving
                  ? "rgba(200,170,90,0.2)"
                  : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
                color: !primary || saving ? "rgba(255,255,255,0.3)" : "#080808",
                cursor: !primary || saving ? "not-allowed" : "pointer",
                boxShadow: primary && !saving ? "0 4px 16px rgba(200,170,90,0.25)" : "none",
                transition: "all 0.2s",
              }}
            >
              {saving ? "Saving…" : "Continue"}
            </button>

            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", textAlign: "center", marginTop: 14 }}>
              You can change territories later in Profile.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
