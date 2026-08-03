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

let _champCache: { at: number; data: { agentId: number | null } } | null = null;
export function useCurrentChampion(): { agentId: number | null } {
  const [state, setState] = useState<{ agentId: number | null }>(
    _champCache ? _champCache.data : { agentId: null }
  );
  useEffect(() => {
    if (_champCache && (Date.now() - _champCache.at) < 5 * 60_000) return;
    let cancelled = false;
    fetch("/api/champion", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled) return;
        const data = { agentId: j?.agentId ?? null };
        _champCache = { at: Date.now(), data };
        setState(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return state;
}

// Wrap any headshot in the wreath frame if the agent is the current champion.
// Otherwise it just renders `children` as-is (no visual change).
export function ChampionFrame({
  agentId, size, children,
}: {
  agentId: number | null | undefined;
  size: number;
  children: React.ReactNode;
}) {
  const champ = useCurrentChampion();
  const isChamp = agentId != null && champ.agentId === agentId;
  if (!isChamp) return <>{children}</>;

  // Wreath PNG has transparent center. Layer the headshot INSIDE the wreath by
  // rendering the wreath as an absolute-positioned overlay of ~130% size.
  const outerPx = Math.round(size * 1.30);
  const inset = Math.round((outerPx - size) / 2);
  return (
    <span style={{ position: "relative", display: "inline-block", width: outerPx, height: outerPx, verticalAlign: "middle" }}
          title="This month's Champion">
      <span style={{ position: "absolute", left: inset, top: inset, width: size, height: size, display: "inline-block" }}>
        {children}
      </span>
      <img
        src="/badges/champion-wreath.png"
        alt="Champion"
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          pointerEvents: "none",
          filter: "drop-shadow(0 0 6px rgba(200,170,90,0.55))",
        }}
      />
    </span>
  );
}
