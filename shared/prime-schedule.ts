// v15.11 — Shared prime-schedule primitives usable from BOTH client and server.
// This deliberately duplicates the weight tables from client/src/lib/callHeat.ts
// so that server code (which cannot import from client/) has a source of truth
// for when Prime windows start. If you edit the weights, edit BOTH files.

const HOUR_WEIGHTS: number[] = [
  0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.20, 0.45, 0.85, 0.90, 0.85, 0.70,
  0.35, 0.30, 0.55, 0.75, 0.95, 1.00, 0.80, 0.55, 0.30, 0.15, 0.10, 0.05,
];

const DAY_MULTIPLIERS: number[] = [
  0.65, 0.80, 0.95, 1.05, 1.05, 0.70, 0.95,
];

function saturdayMorningBoost(hour: number, dow: number): number {
  if (dow !== 6) return 1;
  if (hour >= 8 && hour <= 11) return 1.15;
  return 1;
}

function fridayAfternoonPenalty(hour: number, dow: number): number {
  if (dow !== 5) return 1;
  if (hour >= 14) return 0.75;
  return 1;
}

function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 21;
}

/**
 * Given a timezone, list every (dow, hour) at which a PRIME window STARTS —
 * i.e. the previous hour was NOT prime but this hour IS.
 */
export function listPrimeWindowStarts(_tz: string = "America/New_York"): Array<{ dow: number; hour: number }> {
  const starts: Array<{ dow: number; hour: number }> = [];
  for (let dow = 0; dow < 7; dow++) {
    let prevPrime = false;
    for (let hour = 0; hour < 24; hour++) {
      if (!withinLegalDialWindow(hour)) { prevPrime = false; continue; }
      const s = (HOUR_WEIGHTS[hour] ?? 0.05) * (DAY_MULTIPLIERS[dow] ?? 0.9)
              * saturdayMorningBoost(hour, dow) * fridayAfternoonPenalty(hour, dow);
      const isPrime = Math.min(1, s) * 100 >= 75;
      if (isPrime && !prevPrime) starts.push({ dow, hour });
      prevPrime = isPrime;
    }
  }
  return starts;
}

/**
 * v15.11.4 — return the current call-heat tier ("prime" | "mid" | "down") for a
 * given timezone. Used server-side by awardPoints() to apply the 1.5x Prime
 * bonus. Must stay in lockstep with client/src/lib/callHeat.ts.
 */
export function getCallHeatTier(tz: string = "America/New_York"): "prime" | "mid" | "down" {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  const hStr = parts.find(p => p.type === "hour")?.value ?? "0";
  const dowMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  const dow = dowMap[wdStr] ?? 1;
  let hour = parseInt(hStr, 10);
  if (hour === 24) hour = 0;
  if (!withinLegalDialWindow(hour)) return "down";
  const s = (HOUR_WEIGHTS[hour] ?? 0.05) * (DAY_MULTIPLIERS[dow] ?? 0.9)
          * saturdayMorningBoost(hour, dow) * fridayAfternoonPenalty(hour, dow);
  const score = Math.min(1, s) * 100;
  if (score >= 75) return "prime";
  if (score >= 40) return "mid";
  return "down";
}
