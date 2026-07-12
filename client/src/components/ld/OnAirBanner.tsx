// v15.11.2 — Always-visible top status bar for the team-wide call schedule.
//
// Renders 24/7. Three states:
//   PRIME   → red "ON AIR — PRIME TIME" plate, flashing broadcast light both ends
//   MID     → amber "MID TIME — OK to dial" plate, static dots
//   DOWN    → dark gray "DOWNTIME — do not cold-call" plate, static dot
//
// The banner is pinned to the top of every page. This IS the source of truth
// for whether the whole team should be calling right now.

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

  // Style tokens per tier.
  const cfg = (() => {
    if (heat.tier === "prime") {
      return {
        // Deep red with strong halo. Text is bright red so it POPS against a phone glance.
        bg: "linear-gradient(90deg, #1a0202 0%, #4a0a0a 50%, #1a0202 100%)",
        border: "rgba(239,68,68,0.55)",
        dotColor: "#ef4444",
        badgeColor: "#ef4444",
        badgeText: "ON AIR",
        subText: "PRIME TIME — call now. Industry-best window.",
        anim: "ld-onair-blink 1.05s steps(1) infinite",
      };
    }
    if (heat.tier === "mid") {
      const soon = heatIn30.tier === "prime";
      return {
        bg: "linear-gradient(90deg, #1a1102 0%, #2f2004 50%, #1a1102 100%)",
        border: "rgba(245,158,11,0.45)",
        dotColor: "#f59e0b",
        badgeColor: "#f59e0b",
        badgeText: soon ? "STAND BY" : "MID TIME",
        subText: soon
          ? "PRIME TIME in ~30 min — wrap what you're on."
          : "MID TIME — OK to dial, not the sprint window.",
        anim: soon ? "ld-onair-pulse 2.2s ease-in-out infinite" : "none",
      };
    }
    // DOWN
    return {
      bg: "linear-gradient(90deg, #0a0a0a 0%, #1a1a1a 50%, #0a0a0a 100%)",
      border: "rgba(107,114,128,0.35)",
      dotColor: "#6b7280",
      badgeColor: "#9ca3af",
      badgeText: "DOWN TIME",
      subText: heat.reason || "Downtime — do NOT cold-call. Save leads for Prime.",
      anim: "none",
    };
  })();

  return (
    <>
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
        data-testid={`onair-banner-${heat.tier}`}
        data-tier={heat.tier}
        role="status"
        aria-live="polite"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          width: "100%",
          padding: "8px 14px",
          background: cfg.bg,
          borderBottom: `1px solid ${cfg.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          textAlign: "center",
        }}
      >
        {/* Broadcast light — left */}
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: cfg.dotColor,
            animation: cfg.anim,
            flexShrink: 0,
          }}
        />
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "center", minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              fontWeight: 800,
              color: cfg.badgeColor,
              fontFamily: "'Switzer','Inter',sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            {cfg.badgeText}
          </span>
          <span
            style={{
              fontSize: 12,
              color: heat.tier === "down" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.92)",
              fontFamily: "'Switzer','Inter',sans-serif",
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            {cfg.subText}
          </span>
        </div>
        {/* Broadcast light — right */}
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: cfg.dotColor,
            animation: cfg.anim,
            animationDelay: heat.tier === "prime" ? "0.55s" : "1.1s",
            flexShrink: 0,
          }}
        />
      </div>
    </>
  );
}
