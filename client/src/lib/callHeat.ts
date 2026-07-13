// v15.11.17 — 5-tier grid-locked call-heat.
//
// Reconciled from two research sources (see scripts/heat-reconcile.md):
//   A. Watson Brothers Group hand-annotated schedule (attachment "6 AM at the top…")
//   B. MIT / Harvard prime-time schedule (attachment "Prime Time Schedule")
//
// Tiers (worst → best):
//   ILLEGAL — outside Fla. Stat. § 501.616(6)(a) window (before 8 AM / after 8 PM). HARD BLOCK, no bypass.
//   DOWN    — both schedules say don't dial. Confirm to bypass.
//   LOW     — sources disagree (one says M, one says D). Shoulder hour. Confirm to bypass.
//   MID     — both agree it's a middle window. No confirm; MID pill on CTA.
//   PRIME   — either schedule says PRIME. Free dial.
//
// Legal cap: Fla. Stat. § 501.616(6)(a) — commercial calls 8 AM – 8 PM (hard).
// https://www.flsenate.gov/laws/statutes/2021/501.616

export type HeatTier = "illegal" | "down" | "low" | "mid" | "prime";

export interface CallHeat {
  tier: HeatTier;
  score: number;            // 0-100 receptivity index (informational)
  label: string;            // "PRIME TIME" | "MID TIME" | "LOW TIME" | "DOWNTIME" | "TCPA BLOCK"
  reason: string;
  nextPrimeWindow?: string;
  color: string;
  legal: boolean;           // false when calling now would violate TCPA
  needsConfirm: boolean;    // true for DOWN and LOW (soft-confirm), false for MID/PRIME, false for ILLEGAL (hard-block, no confirm bypass)
}

// 7 rows (Sun..Sat) × 12 columns (8AM..7PM). Values outside 8A–8P are ILLEGAL and
// are handled by the withinLegalDialWindow() check, not the grid.
// v15.11.17 grid = max(A, B) with LOW breaking A/B disagreement (see scripts/heat-reconcile.md).
const GRID: HeatTier[][] = [
  //  8      9      10     11     12     1p     2p     3p     4p     5p     6p     7p
  ["mid",  "mid",  "mid",  "prime","prime","mid",  "prime","mid",  "mid",  "prime","prime","prime"], // Sun
  ["mid",  "low",  "low",  "low",  "down", "down", "mid",  "mid",  "prime","prime","prime","prime"], // Mon
  ["prime","prime","prime","low",  "down", "down", "mid",  "mid",  "prime","prime","prime","prime"], // Tue
  ["prime","prime","prime","low",  "down", "down", "mid",  "prime","prime","prime","prime","prime"], // Wed
  ["prime","prime","prime","low",  "down", "down", "mid",  "prime","prime","prime","prime","prime"], // Thu
  ["mid",  "mid",  "mid",  "mid",  "low",  "low",  "prime","prime","prime","low",  "mid",  "low"],   // Fri
  ["prime","prime","prime","prime","mid",  "mid",  "mid",  "mid",  "prime","prime","prime","prime"], // Sat
];

// Informational 0-100 score per tier — used only for display/telemetry.
const SCORE_BY_TIER: Record<HeatTier, number> = {
  prime:   88,
  mid:     62,
  low:     40,
  down:    20,
  illegal:  0,
};

// Legacy exports kept so old imports don't break at build time. Do NOT use.
export const HOUR_WEIGHTS: number[] = new Array(24).fill(0.5);
export const DAY_MULTIPLIERS: number[] = [1, 1, 1, 1, 1, 1, 1];

function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 20;
}

/** Direct lookup for a (dow, hour) cell. Returns `illegal` for TCPA-restricted hours. */
export function tierForCell(dow: number, hour: number): HeatTier {
  if (!withinLegalDialWindow(hour)) return "illegal";
  const row = GRID[dow];
  if (!row) return "down";
  return row[hour - 8] ?? "down";
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Compute the receptivity heat for a given moment.
 * @param now Optional Date (defaults to real now). Use for testing.
 * @param tz  IANA timezone (defaults to America/New_York — Brothers Group is Jacksonville).
 */
export function computeCallHeat(now: Date = new Date(), tz: string = "America/New_York"): CallHeat {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const hourStr = parts.find(p => p.type === "hour")?.value ?? "0";
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  let hour = parseInt(hourStr, 10);
  if (isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wdStr] ?? 1;
  const legal = withinLegalDialWindow(hour);

  const tier: HeatTier = tierForCell(dow, hour);
  const score = SCORE_BY_TIER[tier];

  let label: string;
  let color: string;
  let needsConfirm = false;
  switch (tier) {
    case "prime":   label = "PRIME TIME"; color = "#ef4444"; break; // red-500
    case "mid":     label = "MID TIME";   color = "#f59e0b"; break; // amber-500
    case "low":     label = "LOW TIME";   color = "#eab308"; needsConfirm = true; break; // yellow-500 (softer than amber)
    case "down":    label = "DOWNTIME";   color = "#6b7280"; needsConfirm = true; break; // gray-500
    case "illegal": label = "TCPA BLOCK"; color = "#1f2937"; break; // gray-800 — hard block, no confirm bypass
  }

  // Reason — grounded in the reconciled research
  const dayName = DAY_NAMES[dow];
  let reason = "";
  if (!legal) {
    reason = "Outside Florida's 8 AM – 8 PM legal window. Do NOT cold-call now (Fla. Stat. § 501.616).";
  } else if (tier === "prime") {
    if (hour >= 18 && hour < 20) reason = "6–8 PM every day — the single most-agreed window in the data (Massey, CallHub, MIT).";
    else if (dow === 6 && hour >= 8 && hour < 12) reason = "Saturday morning — the strongest weekend residential window.";
    else if (dow === 6 && hour >= 16) reason = "Saturday late-afternoon — Massey shows 51–61% at-home all day.";
    else if (dow === 0 && hour === 11) reason = "Sunday post-church, pre-football — cleanest Sunday window in Florida.";
    else if (dow === 0 && hour >= 17) reason = "Sunday early-evening — Massey ranks this the strongest evening (62.1% at 7 PM).";
    else if (dow === 5 && (hour === 14 || hour === 15 || hour === 16)) reason = "Friday 2–5 PM — homeowners are home early (4:03 PM avg logoff). Catch them BEFORE the 5 PM commute.";
    else if (dow >= 2 && dow <= 4 && hour >= 8 && hour <= 10) reason = "Tue–Thu 8–10 AM — sellers still at the kitchen table before the workday absorbs them (MIT).";
    else reason = `${dayName} peak — dial hard now.`;
  } else if (tier === "mid") {
    if (hour === 8) reason = "8 AM first-touch — be first to reach new expireds. Pickup low, first-mover value high.";
    else if (dow === 5 && hour >= 17) reason = "Friday evening — reachable but calls run short (CallHub Fri = 24.15s avg).";
    else if (dow === 0 && hour < 11) reason = "Sunday morning — at-home rate is high, but Bible Belt church etiquette argues caution.";
    else reason = "Middle window. Keep dialing — expect fewer pickups than Prime.";
  } else if (tier === "low") {
    reason = "Shoulder hour — sources disagree. Legal, but expect low pickup. Dial anyway if you're already at your desk.";
  } else if (tier === "down") {
    if (dow === 4 && hour === 17) reason = "Thursday 5–6 PM — INRIX names Thursday the worst U.S. traffic day. Deepest commute hole.";
    else if (dow === 5 && hour === 17) reason = "Friday 5–6 PM — the single worst commuting hour of the week.";
    else if (hour >= 12 && hour <= 13) reason = "Weekday lunch — residential DOWN zone. Working homeowners aren't home.";
    else reason = "Low-yield window. Save cold leads for Prime.";
  } else {
    reason = "Outside Florida's legal window (8 AM – 8 PM). Blocked.";
  }

  // Next Prime window — search forward up to 24h
  let nextPrimeWindow: string | undefined;
  if (tier !== "prime") {
    for (let ahead = 1; ahead <= 24; ahead++) {
      const t = new Date(now.getTime() + ahead * 3600 * 1000);
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(t);
      let h2 = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10);
      if (h2 === 24) h2 = 0;
      const wd2 = p.find(x => x.type === "weekday")?.value ?? "Mon";
      const d2 = dowMap[wd2] ?? 1;
      if (tierForCell(d2, h2) === "prime") {
        const hourLabel = h2 === 0 ? "12 AM" : h2 < 12 ? `${h2} AM` : h2 === 12 ? "12 PM" : `${h2 - 12} PM`;
        nextPrimeWindow = ahead === 1 ? `Next On Air at ${hourLabel} (~1h)` : `Next On Air at ${hourLabel} (~${ahead}h)`;
        break;
      }
    }
  }

  return { tier, score, label, reason, nextPrimeWindow, color, legal, needsConfirm };
}

/**
 * List every (dow, hour) at which a PRIME window STARTS —
 * used by the server push cron to schedule the 15-min-before alert.
 */
export function listPrimeWindowStarts(_tz: string = "America/New_York"): Array<{ dow: number; hour: number }> {
  const starts: Array<{ dow: number; hour: number }> = [];
  for (let dow = 0; dow < 7; dow++) {
    let prevPrime = false;
    for (let hour = 0; hour < 24; hour++) {
      const isPrime = tierForCell(dow, hour) === "prime";
      if (isPrime && !prevPrime) starts.push({ dow, hour });
      prevPrime = isPrime;
    }
  }
  return starts;
}
