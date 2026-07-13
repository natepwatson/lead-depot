// v15.11.11 — 5-tier Sprint Mode schedule (illegal / dead / low / middle / prime).
// Shared between client and server. If you edit the GRID, edit
// client/src/lib/callHeat.ts to match, exact-cell.
//
// User-approved 2026-07-13 (thread 77b076fa) — cross-referenced against
// MIT Lead Response, PropContact 2026, Orum (1B+ calls), Gong (100K calls),
// REDX Day-1 Expireds, Jamil Academy, and Fla. Stat. § 501.616(6)(a).
//
// LEGAL: Florida caps commercial calls at 8 AM – 8 PM recipient-local
// (Fla. Stat. § 501.616(6)(a)). Anything before 8 AM or at/after 8 PM is
// "illegal" regardless of what the research grid says.

// ─── 5-tier DISPLAY enum (what the UI shows) ─────────────────────────────────
export type SprintTier = "illegal" | "dead" | "low" | "middle" | "prime";

// ─── 3-tier AWARD enum (points multiplier, push cron) ────────────────────────
// Preserved for backwards compat with awardPoints() and the 15-min push cron.
//   prime  → 1.5x points, push alerts
//   mid    → 1.0x points, no alert (covers "middle" + "low" display tiers)
//   down   → 1.0x points, no alert (covers "dead" + "illegal" display tiers)
export type Tier = "prime" | "mid" | "down";

// 7 rows (Sun..Sat) × 12 columns (8AM..7PM = the legal 8AM–8PM window)
// Row 0 = Sunday. Column 0 = 8AM ... Column 11 = 7PM.
// (Hours outside 8AM–8PM are always "illegal" — not in this grid.)
const SPRINT_GRID: SprintTier[][] = [
  // 8AM     9AM      10AM     11AM     12PM     1PM      2PM      3PM       4PM       5PM       6PM       7PM
  ["dead",  "dead",   "dead",  "dead",  "dead",  "dead",  "dead",  "dead",   "dead",   "dead",   "dead",   "dead"  ], // Sun — all dead per user
  ["low",   "low",    "middle","low",   "dead",  "dead",  "low",   "middle", "middle", "middle", "middle", "middle"], // Mon
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Tue
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Wed
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Thu
  ["low",   "middle", "middle","low",   "dead",  "dead",  "low",   "middle", "middle", "middle", "middle", "low"   ], // Fri
  ["dead",  "middle", "prime", "prime", "low",   "low",   "low",   "low",    "dead",   "dead",   "dead",   "dead"  ], // Sat
];

function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 20;
}

/** Direct 5-tier display lookup — dow 0..6 (Sun..Sat), hour 0..23 (local ET). */
export function sprintTierForCell(dow: number, hour: number): SprintTier {
  if (!withinLegalDialWindow(hour)) return "illegal";
  const col = hour - 8;
  const row = SPRINT_GRID[dow];
  if (!row) return "illegal";
  return row[col] ?? "illegal";
}

/** Backwards-compat 3-tier lookup — collapses 5 display tiers into award tiers. */
export function tierForCell(dow: number, hour: number): Tier {
  const t = sprintTierForCell(dow, hour);
  if (t === "prime") return "prime";
  if (t === "middle" || t === "low") return "mid";
  return "down"; // dead or illegal
}

/**
 * List every (dow, hour) at which a PRIME window STARTS —
 * i.e. the previous hour was NOT prime but this hour IS.
 * Used for scheduling the 15-min-before push notifications.
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

/**
 * Current call-heat tier for a given timezone (3-tier award form).
 * Used server-side by awardPoints() for the 1.5x Prime bonus.
 */
export function getCallHeatTier(tz: string = "America/New_York"): Tier {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  const hStr = parts.find(p => p.type === "hour")?.value ?? "0";
  const dowMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  const dow = dowMap[wdStr] ?? 1;
  let hour = parseInt(hStr, 10);
  if (hour === 24) hour = 0;
  return tierForCell(dow, hour);
}

/** Current 5-tier display tier — used by the UI chip. */
export function getSprintTier(tz: string = "America/New_York"): SprintTier {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  const hStr = parts.find(p => p.type === "hour")?.value ?? "0";
  const dowMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  const dow = dowMap[wdStr] ?? 1;
  let hour = parseInt(hStr, 10);
  if (hour === 24) hour = 0;
  return sprintTierForCell(dow, hour);
}

/**
 * Given "now", find the NEXT PRIME window start in local time (ET).
 * Returns the Date at which the next prime hour starts.
 */
export function nextPrimeStartAfter(tz: string, from: Date): Date {
  const dowMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  for (let ahead = 0; ahead <= 24 * 8; ahead++) {
    const probe = new Date(from.getTime() + ahead * 3600 * 1000);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(probe);
    const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
    const hStr = parts.find(p => p.type === "hour")?.value ?? "0";
    const dow = dowMap[wdStr] ?? 1;
    let hour = parseInt(hStr, 10);
    if (hour === 24) hour = 0;
    if (tierForCell(dow, hour) !== "prime") continue;
    const prev = new Date(probe.getTime() - 3600 * 1000);
    const pParts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(prev);
    const pWd = pParts.find(p => p.type === "weekday")?.value ?? "Mon";
    const pHStr = pParts.find(p => p.type === "hour")?.value ?? "0";
    const pDow = dowMap[pWd] ?? 1;
    let pHour = parseInt(pHStr, 10);
    if (pHour === 24) pHour = 0;
    if (tierForCell(pDow, pHour) === "prime") continue;
    const startDate = new Date(probe);
    startDate.setMinutes(0, 0, 0);
    return startDate;
  }
  return from;
}

// Backwards compat — some code may still call these
export const HOUR_WEIGHTS = SPRINT_GRID; // deprecated shape, do not use
export const DAY_MULTIPLIERS: number[] = [1,1,1,1,1,1,1]; // deprecated
