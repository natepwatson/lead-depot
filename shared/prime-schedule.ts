// v15.11.10 — Shared prime-schedule primitives usable from BOTH client and server.
// LOCKED to research report at /home/user/workspace/optimal_call_schedule_by_day.md
// If you edit this grid, edit client/src/lib/callHeat.ts to match, exact-cell.
//
// Legal window: Fla. Stat. § 501.616(6)(a) — commercial calls only 8 AM – 8 PM
// in the called party's local time. Hours < 8 or >= 20 are DOWN (illegal).

export type Tier = "prime" | "mid" | "down";

// 7 rows (Sun..Sat) × 12 columns (8AM..7PM)
// Row 0 = Sunday, Column 0 = 8AM ... Column 11 = 7PM
// Values from research report Section 3.
const SCHEDULE_GRID: Tier[][] = [
  // 8    9    10    11   12   1p   2p   3p   4p   5p   6p    7p
  ["mid","mid","mid","prime","prime","mid","prime","mid","mid","prime","prime","prime"], // Sun
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],    // Mon
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],    // Tue
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],    // Wed
  ["mid","down","down","down","down","down","mid","mid","mid","down","prime","prime"],   // Thu
  ["mid","mid","mid","mid","mid","mid","prime","prime","prime","down","mid","mid"],      // Fri
  ["prime","prime","prime","prime","mid","mid","mid","mid","prime","prime","prime","prime"], // Sat
];

function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 20;
}

/** Direct lookup — dow 0..6 (Sun..Sat), hour 0..23 (local ET). */
export function tierForCell(dow: number, hour: number): Tier {
  if (!withinLegalDialWindow(hour)) return "down";
  const col = hour - 8; // 8AM = col 0
  const row = SCHEDULE_GRID[dow];
  if (!row) return "down";
  return row[col] ?? "down";
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
 * Current call-heat tier for a given timezone.
 * Used server-side by awardPoints() for the 1.5x Prime bonus.
 * Must stay in lockstep with client/src/lib/callHeat.ts.
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

/**
 * Given "now", find the NEXT PRIME window start in local time (ET).
 * Returns the Date at which the next prime hour starts. Used for the
 * 15-min-before push scheduler.
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
    // Previous hour (probe - 1h) must NOT be prime
    const prev = new Date(probe.getTime() - 3600 * 1000);
    const pParts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(prev);
    const pWd = pParts.find(p => p.type === "weekday")?.value ?? "Mon";
    const pHStr = pParts.find(p => p.type === "hour")?.value ?? "0";
    const pDow = dowMap[pWd] ?? 1;
    let pHour = parseInt(pHStr, 10);
    if (pHour === 24) pHour = 0;
    if (tierForCell(pDow, pHour) === "prime") continue;
    // probe is a fresh prime start. Normalize to :00 of that hour.
    const startDate = new Date(probe);
    startDate.setMinutes(0, 0, 0);
    return startDate;
  }
  return from;
}

// Backwards compat — some code may still call this
export const HOUR_WEIGHTS = SCHEDULE_GRID; // deprecated shape, do not use
export const DAY_MULTIPLIERS: number[] = [1,1,1,1,1,1,1]; // deprecated
