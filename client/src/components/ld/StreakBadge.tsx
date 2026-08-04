// v17.3 — Streak badge chip + Champion Wreath headshot frame.
// Both components read from server endpoints:
//   GET /api/agents/:id/streak    → { tier, current, best, tierBadge, tierLabel, nextTierDays, nextTierLabel }
//   GET /api/champion              → { agentId, agentName, monthKey, appts }
// Both components fail silently (render null on error / no data), so any old
// codepath that mounts them will simply show nothing until data arrives.

import { useEffect, useState } from "react";

// ─── Streak Badge ─────────────────────────────────────────────────────────────

export interface StreakState {
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  current: number;
  best: number;
  tierBadge: string | null;
  tierLabel: string;
  nextTierDays: number | null;
  nextTierLabel: string | null;
}

let _cache: Record<number, { data: StreakState; at: number }> = {};
const CACHE_MS = 60_000;

async function fetchStreak(agentId: number): Promise<StreakState | null> {
  const now = Date.now();
  const c = _cache[agentId];
  if (c && (now - c.at) < CACHE_MS) return c.data;
  try {
    const res = await fetch(`/api/agents/${agentId}/streak`, { credentials: "include" });
    if (!res.ok) return null;
    const json = await res.json();
    _cache[agentId] = { data: json, at: now };
    return json;
  } catch { return null; }
}

// Chip sizes: sm = 20px badge + tiny label (leaderboard rows), md = 32px + day count
export function StreakBadge({ agentId, size = "sm", showLabel = false }: {
  agentId: number;
  size?: "sm" | "md";
  showLabel?: boolean;
}) {
  const [s, setS] = useState<StreakState | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchStreak(agentId).then(x => { if (!cancelled) setS(x); });
    return () => { cancelled = true; };
  }, [agentId]);

  if (!s || s.tier === 0 || !s.tierBadge) return null;

  const badgePx = size === "md" ? 32 : 20;
  const fontPx  = size === "md" ? 13 : 11;

  return (
    <span
      title={`${s.tierLabel} — ${s.current}-day streak (best ${s.best})`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        verticalAlign: "middle",
      }}
    >
      <img
        src={s.tierBadge}
        alt={s.tierLabel}
        style={{ width: badgePx, height: badgePx, objectFit: "contain", flexShrink: 0 }}
      />
      {showLabel && (
        <span style={{ fontSize: fontPx, fontWeight: 600, color: "#c8aa5a", letterSpacing: 0.3 }}>
          {s.current}d
        </span>
      )}
    </span>
  );
}

// Detailed streak card for the agent's own profile — shows tier, day count,
// best, and progress-to-next-tier hint.
export function StreakCard({ agentId }: { agentId: number }) {
  const [s, setS] = useState<StreakState | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchStreak(agentId).then(x => { if (!cancelled) setS(x); });
    return () => { cancelled = true; };
  }, [agentId]);

  if (!s) return null;

  // No streak yet — show a neutral encourage state (no badge).
  if (s.tier === 0) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px",
        background: "rgba(20,18,15,0.6)",
        border: "1px solid rgba(200,170,90,0.15)",
        borderRadius: 12,
        color: "#c8b898",
        fontSize: 12,
      }}>
        <span style={{ fontSize: 18 }}>🔥</span>
        <div>
          <div style={{ fontWeight: 600, color: "#e8dcc0" }}>No active streak</div>
          <div style={{ fontSize: 11, color: "#8a8175" }}>
            Log 5+ dials today to start one · {s.nextTierLabel ? `Next: ${s.nextTierLabel} (${s.nextTierDays}d)` : ""}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px",
      background: "linear-gradient(90deg, rgba(200,170,90,0.09), rgba(20,18,15,0.6))",
      border: "1px solid rgba(200,170,90,0.32)",
      borderRadius: 12,
      color: "#e8dcc0",
    }}>
      <img
        src={s.tierBadge!}
        alt={s.tierLabel}
        style={{ width: 44, height: 44, objectFit: "contain", flexShrink: 0 }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: "#c8aa5a", lineHeight: 1 }}>
            {s.current}
          </span>
          <span style={{ fontSize: 11, color: "#8a8175" }}>day streak</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e8dcc0", marginTop: 2 }}>
          {s.tierLabel}
        </div>
        <div style={{ fontSize: 10.5, color: "#8a8175", marginTop: 2 }}>
          {s.nextTierLabel
            ? `${s.nextTierDays}d to ${s.nextTierLabel}`
            : `LEGENDARY · best ${s.best}d`}
        </div>
      </div>
    </div>
  );
}

// ─── Champion Wreath frame ───────────────────────────────────────────────────

// v20.4.4 — Champion Wreath RESTORED. Winner is the previous ET month's #1
// by points (agent_points sum, scope='seller'). Wreath displays for the
// entire following month everywhere the champion's headshot appears.
// Endpoint: GET /api/champion → { agentId, agentName, monthKey, points, appts, awardedForMonth }

// v20.4.9 — champion payload now includes headshotUrl so the Reigning Champion
// card renders a real photo (with laurel wreath frame), not just initials.
type ChampionData = { agentId: number | null; agentName: string | null; headshotUrl: string | null; points: number; awardedForMonth: string };
let _championCache: { data: ChampionData | null; at: number } | null = null;
const CHAMPION_CACHE_MS = 60_000;

async function fetchChampion(): Promise<ChampionData | null> {
  const now = Date.now();
  if (_championCache && (now - _championCache.at) < CHAMPION_CACHE_MS) return _championCache.data;
  try {
    const res = await fetch(`/api/champion`, { credentials: "include" });
    if (!res.ok) return null;
    const j = await res.json();
    const data: ChampionData = {
      agentId: j.agentId ?? null,
      agentName: j.agentName ?? null,
      headshotUrl: j.headshotUrl ?? null,
      points: Number(j.points) || 0,
      awardedForMonth: j.awardedForMonth || "",
    };
    _championCache = { data, at: now };
    return data;
  } catch { return null; }
}

export function useCurrentChampion(): ChampionData {
  const [c, setC] = useState<ChampionData>({ agentId: null, agentName: null, headshotUrl: null, points: 0, awardedForMonth: "" });
  useEffect(() => {
    let cancelled = false;
    fetchChampion().then(x => { if (!cancelled && x) setC(x); });
    return () => { cancelled = true; };
  }, []);
  return c;
}

// Wreath renders a subtle laurel ring around the child avatar. If this agent
// is NOT the current champion, or no champion is set, returns children
// unchanged (pass-through).
export function ChampionFrame({
  agentId,
  size = 44,
  children,
}: {
  agentId?: number | null | undefined;
  size?: number;
  children: React.ReactNode;
}) {
  const champ = useCurrentChampion();
  if (!agentId || !champ.agentId || champ.agentId !== agentId) return <>{children}</>;
  // Laurel ring: gold gradient border, thin outer glow, slight lift.
  const ringPx = Math.round(size * 1.18);
  return (
    <span
      title={`Reigning Champion — ${champ.agentName || ""} · ${champ.points} pts in ${champ.awardedForMonth}`}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: ringPx,
        height: ringPx,
        borderRadius: "50%",
        background: "conic-gradient(from 210deg, #f4d780, #c8aa5a, #8b6f2f, #c8aa5a, #f4d780)",
        padding: 2,
        boxShadow: "0 0 0 1px rgba(200,170,90,0.5), 0 0 12px rgba(200,170,90,0.35)",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          background: "rgba(20,18,15,0.9)",
          padding: 1,
        }}
      >
        {children}
      </span>
      {/* Laurel-leaf accents at the crown top */}
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        {/* Left laurel branch */}
        <path d="M 22 30 Q 14 22 12 12" stroke="#f4d780" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <ellipse cx="15" cy="17" rx="3" ry="1.6" fill="#c8aa5a" transform="rotate(-40 15 17)" opacity="0.9" />
        <ellipse cx="19" cy="24" rx="3" ry="1.6" fill="#c8aa5a" transform="rotate(-30 19 24)" opacity="0.9" />
        {/* Right laurel branch */}
        <path d="M 78 30 Q 86 22 88 12" stroke="#f4d780" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <ellipse cx="85" cy="17" rx="3" ry="1.6" fill="#c8aa5a" transform="rotate(40 85 17)" opacity="0.9" />
        <ellipse cx="81" cy="24" rx="3" ry="1.6" fill="#c8aa5a" transform="rotate(30 81 24)" opacity="0.9" />
        {/* Crown star at the top */}
        <path d="M50 3 L52 8 L57 8 L53 11 L54.5 16 L50 13 L45.5 16 L47 11 L43 8 L48 8 Z" fill="#f4d780" opacity="0.95" />
      </svg>
    </span>
  );
}
