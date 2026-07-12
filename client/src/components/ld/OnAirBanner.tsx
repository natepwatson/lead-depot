// v15.11 — ON AIR banner. Flashing broadcast-studio light pinned above the
// entire app whenever we're inside a PRIME TIME window. This is the primary
// motivator — every agent (and admin) sees the exact same visual, at the same
// moment, so nobody can pretend they didn't know it was Prime.
//
// Two states this component renders:
//   1. Currently in PRIME → red "ON AIR — PRIME TIME" banner, flashing dot
//   2. PRIME starts in <=30 min → amber "PRIME TIME IN ~30 MIN" pre-warning
//   Otherwise: renders nothing.

import { useEffect, useMemo, useState } from "react";
import { computeCallHeat } from "@/lib/callHeat";

export default function OnAirBanner() {
  // Re-compute every 60s.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const heat = useMemo(() => computeCallHeat(), [tick]);
  const heatIn30 = useMemo(
    () => computeCallHeat(new Date(Date.now() + 30 * 60 * 1000)),
    [tick],
  );

  const inPrime = heat.tier === "prime";
  const primeIncoming = !inPrime && heatIn30.tier === "prime";

  if (!inPrime && !primeIncoming) return null;

  return (
    <>
      {/* keyframes injected inline so this component is fully self-contained */}
      <style>{`
        @keyframes ld-onair-pulse {
          0%, 100% { opacity: 1;   box-shadow: 0 0 24px rgba(239,68,68,0.55), 0 0 4px rgba(239,68,68,0.9); }
          50%      { opacity: 0.35; box-shadow: 0 0 6px  rgba(239,68,68,0.25), 0 0 0   rgba(239,68,68,0.0); }
        }
        @keyframes ld-onair-blink {
          0%, 44%, 100% { opacity: 1; }
          45%, 99%      { opacity: 0.15; }
        }
      `}</style>
      <div
        data-testid={inPrime ? "on-air-banner" : "prime-incoming-banner"}
        role="alert"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          width: "100%",
          padding: "10px 14px",
          background: inPrime
            ? "linear-gradient(90deg, #1a0202 0%, #3b0808 50%, #1a0202 100%)"
            : "linear-gradient(90deg, #1a1102 0%, #2f2004 50%, #1a1102 100%)",
          borderBottom: `1px solid ${inPrime ? "rgba(239,68,68,0.55)" : "rgba(245,158,11,0.45)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          textAlign: "center",
        }}
      >
        {/* Broadcast light — flashing red circle */}
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: inPrime ? "#ef4444" : "#f59e0b",
            animation: inPrime
              ? "ld-onair-blink 1.05s steps(1) infinite"
              : "ld-onair-pulse 2.2s ease-in-out infinite",
            flexShrink: 0,
          }}
        />
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          <span
            style={{
              fontSize: 11,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              fontWeight: 800,
              color: inPrime ? "#ef4444" : "#f59e0b",
              fontFamily: "'Switzer','Inter',sans-serif",
            }}
          >
            {inPrime ? "ON AIR" : "STAND BY"}
          </span>
          <span
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,0.92)",
              fontFamily: "'Switzer','Inter',sans-serif",
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            {inPrime
              ? "PRIME TIME — call now. This is the industry-best window."
              : "Prime Time in ~30 min — wrap what you're on and get ready."}
          </span>
        </div>
        {/* Right-side broadcast light for symmetry */}
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: inPrime ? "#ef4444" : "#f59e0b",
            animation: inPrime
              ? "ld-onair-blink 1.05s steps(1) infinite"
              : "ld-onair-pulse 2.2s ease-in-out infinite",
            animationDelay: inPrime ? "0.55s" : "1.1s",
            flexShrink: 0,
          }}
        />
      </div>
    </>
  );
}
