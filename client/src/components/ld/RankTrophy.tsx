// v15.11.25 — Proper trophy graphic (SVG) for top 3 leaderboard ranks.
//
// - Gold:   animated diagonal shimmer sweep across the cup + a soft breathing glow.
// - Silver: subtle low-intensity breathing glow, NO shimmer sweep.
// - Bronze: fully static. No shimmer, no glow.
//
// All three share the same trophy silhouette (cup + handles + stem + base).
// Colors are per-tier metallic gradients. The whole thing is one inline SVG so
// it renders cleanly on retina, at any size, and inherits the light/dark theme.
//
// Motion is scoped: shimmer + glow keyframes are declared inside a scoped <style>
// so they can't collide with anything else in the app, and they wrap the animated
// bits in @media (prefers-reduced-motion: no-preference).
import React from "react";

type Rank = 1 | 2 | 3;

const TIER: Record<Rank, {
  cupA: string; cupB: string; cupC: string;   // 3-stop metallic gradient for the cup
  stem: string;                                // stem/base solid
  ring: string;                                // outer ring color (also glow color)
  shine: string;                               // highlight color inside the cup
  animate: "shimmer" | "pulse" | "none";
  glowStrength: number;                        // px of drop-shadow spread
}> = {
  1: {
    cupA: "#fff2b8", cupB: "#f6d572", cupC: "#8a6f2f",
    stem: "#a5822f", ring: "#c8aa5a",
    shine: "rgba(255,246,200,0.75)",
    animate: "shimmer",
    glowStrength: 6,
  },
  2: {
    cupA: "#fbfcfd", cupB: "#dbe0e5", cupC: "#7f878f",
    stem: "#9199a1", ring: "#c0c7cf",
    shine: "rgba(255,255,255,0.7)",
    animate: "pulse",
    glowStrength: 4,
  },
  3: {
    cupA: "#f0c39b", cupB: "#c48454", cupC: "#5f3a1c",
    stem: "#7a4d29", ring: "#c48454",
    shine: "rgba(250,210,180,0.55)",
    animate: "none",
    glowStrength: 0,
  },
};

export function RankTrophy({ rank, size = 32 }: { rank: Rank; size?: number }) {
  const t = TIER[rank];
  const uid = React.useId().replace(/:/g, "");     // scope gradient IDs so no dup collisions
  const cupId    = `cup-${uid}`;
  const stemId   = `stem-${uid}`;
  const shineId  = `shine-${uid}`;
  const clipId   = `clip-${uid}`;
  const shimmerId = `shim-${uid}`;

  // Wrapper filter for glow (only rank 1 + 2)
  const filterStyle = t.glowStrength > 0
    ? { filter: `drop-shadow(0 0 ${t.glowStrength}px ${t.ring}88)` }
    : undefined;

  return (
    <span
      className={`ld-trophy ld-trophy-r${rank}`}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        ...filterStyle,
      }}
      aria-label={`Rank ${rank}`}
    >
      <style>{`
        /* v15.11.25 — trophy motion.
           GOLD: shimmer sweep across the cup + slow glow pulse.
           SILVER: slow glow pulse only.
           BRONZE: none.
        */
        @keyframes ld-trophy-shimmer-${uid} {
          0%   { transform: translateX(-140%); opacity: 0; }
          20%  { opacity: 1; }
          60%  { opacity: 1; }
          100% { transform: translateX(140%); opacity: 0; }
        }
        @keyframes ld-trophy-pulse-${uid} {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1;    }
        }
        @media (prefers-reduced-motion: no-preference) {
          .ld-trophy-r1 .ld-trophy-shimmer-band-${uid} {
            animation: ld-trophy-shimmer-${uid} 3.2s ease-in-out infinite;
            animation-delay: 0.4s;
          }
          .ld-trophy-r1 { animation: ld-trophy-pulse-${uid} 2.4s ease-in-out infinite; }
          .ld-trophy-r2 { animation: ld-trophy-pulse-${uid} 3.6s ease-in-out infinite; }
        }
      `}</style>
      <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Cup vertical gradient — bright top → mid → shadow bottom */}
          <linearGradient id={cupId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.cupA} />
            <stop offset="55%" stopColor={t.cupB} />
            <stop offset="100%" stopColor={t.cupC} />
          </linearGradient>
          {/* Stem/base gradient */}
          <linearGradient id={stemId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.cupB} />
            <stop offset="100%" stopColor={t.stem} />
          </linearGradient>
          {/* Inner glossy highlight — soft vertical shine */}
          <linearGradient id={shineId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.shine} stopOpacity="0.95" />
            <stop offset="60%" stopColor={t.shine} stopOpacity="0.15" />
            <stop offset="100%" stopColor={t.shine} stopOpacity="0" />
          </linearGradient>
          {/* Shimmer diagonal band — used only on gold. Confined to the cup with a clip. */}
          <linearGradient id={shimmerId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stopColor="#ffffff" stopOpacity="0" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          {/* Clip to the cup so the shimmer band doesn't spill onto the base */}
          <clipPath id={clipId}>
            {/* Cup body: rounded goblet */}
            <path d="M9 6 h14 v7 a7 7 0 0 1 -7 7 a7 7 0 0 1 -7 -7 z" />
          </clipPath>
        </defs>

        {/* Handles (left + right ears) — drawn behind the cup */}
        <path d="M9 8 c-4 0 -5 4 -3 6 c1.5 1.5 3.5 1 3.5 1"
              fill="none" stroke={t.stem} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M23 8 c4 0 5 4 3 6 c-1.5 1.5 -3.5 1 -3.5 1"
              fill="none" stroke={t.stem} strokeWidth="1.6" strokeLinecap="round" />

        {/* Cup body */}
        <path d="M9 6 h14 v7 a7 7 0 0 1 -7 7 a7 7 0 0 1 -7 -7 z" fill={`url(#${cupId})`} />

        {/* Cup rim (thin darker band at very top for definition) */}
        <rect x="8.5" y="5.5" width="15" height="1.8" rx="0.6" fill={t.cupC} opacity="0.55" />
        <rect x="9"   y="6"   width="14" height="0.8" rx="0.4" fill={t.cupA} opacity="0.9" />

        {/* Glossy inner highlight (left-of-center vertical shine) */}
        <path d="M11 7.5 h3 v10 a4 4 0 0 1 -3 -4 z"
              fill={`url(#${shineId})`} clipPath={`url(#${clipId})`} />

        {/* Shimmer band — only on gold (rank 1). Clipped to the cup. */}
        {t.animate === "shimmer" && (
          <g clipPath={`url(#${clipId})`}>
            <rect
              className={`ld-trophy-shimmer-band-${uid}`}
              x="-8" y="4" width="18" height="18"
              transform="rotate(20 8 13)"
              fill={`url(#${shimmerId})`}
              style={{ transformOrigin: "center" }}
            />
          </g>
        )}

        {/* Stem */}
        <rect x="14.5" y="20" width="3" height="4" fill={`url(#${stemId})`} />
        {/* Base plate */}
        <rect x="10" y="24" width="12" height="2.4" rx="0.6" fill={`url(#${stemId})`} />
        {/* Base shadow lip */}
        <rect x="10" y="26.2" width="12" height="1" rx="0.4" fill={t.stem} opacity="0.6" />

        {/* Rank number etched on the cup */}
        <text
          x="16" y="15.5"
          textAnchor="middle"
          fontFamily="'Cormorant Garamond','Georgia',serif"
          fontWeight="800"
          fontSize="9"
          fill={rank === 2 ? "#3a4148" : rank === 3 ? "#2a1608" : "#3d2a00"}
          opacity="0.85"
          style={{ paintOrder: "stroke", stroke: t.cupA, strokeWidth: 0.4, strokeOpacity: 0.5 }}
        >{rank}</text>
      </svg>
    </span>
  );
}
