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
