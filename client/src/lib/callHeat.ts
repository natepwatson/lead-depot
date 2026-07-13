// v15.11.10 — Grid-locked call-heat.
// LOCKED to research report at /home/user/workspace/optimal_call_schedule_by_day.md
// (Section 3, hourly schedule table). Every cell traceable to a primary residential
// (B2C) source. If you edit the grid, edit shared/prime-schedule.ts to match.
//
// Legal cap: Fla. Stat. § 501.616(6)(a) — commercial calls 8 AM – 8 PM (hard).
// https://www.flsenate.gov/laws/statutes/2021/501.616

export type HeatTier = "prime" | "mid" | "down";

export interface CallHeat {
  tier: HeatTier;
  score: number;            // 0-100 receptivity index (informational)
  label: string;            // "PRIME TIME" | "MID TIME" | "DOWNTIME"
  reason: string;
  nextPrimeWindow?: string;
  color: string;
}

// 7 rows (Sun..Sat) × 12 columns (8AM..7PM).
// Row 0 = Sunday. Column 0 = 8AM ... Column 11 = 7PM.
// Values from Section 3 of the day-by-day research report.
const GRID: HeatTier[][] = [
  // 8    9    10   11   12   1p   2p   3p   4p   5p   6p    7p
  ["mid","mid","mid","prime","prime","mid","prime","mid","mid","prime","prime","prime"],  // Sun
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],     // Mon
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],     // Tue
  ["mid","down","down","down","down","down","mid","mid","mid","mid","prime","prime"],     // Wed
  ["mid","down","down","down","down","down","mid","mid","mid","down","prime","prime"],    // Thu
  ["mid","mid","mid","mid","mid","mid","prime","prime","prime","down","mid","mid"],       // Fri
  ["prime","prime","prime","prime","mid","mid","mid","mid","prime","prime","prime","prime"], // Sat
];

// Informational 0-100 score per tier — used only for display/telemetry.
const SCORE_BY_TIER: Record<HeatTier, number> = { prime: 88, mid: 55, down: 20 };

// Legacy exports kept so old imports don't break at build time. Do NOT use.
export const HOUR_WEIGHTS: number[] = new Array(24).fill(0.5);
export const DAY_MULTIPLIERS: number[] = [1, 1, 1, 1, 1, 1, 1];

function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 20;
}

/** Direct lookup for a (dow, hour) cell. */
export function tierForCell(dow: number, hour: number): HeatTier {
  if (!withinLegalDialWindow(hour)) return "down";
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

  const tier: HeatTier = tierForCell(dow, hour);
  const score = SCORE_BY_TIER[tier];

  let label: string;
  let color: string;
  if (tier === "prime") { label = "PRIME TIME"; color = "#ef4444"; }
  else if (tier === "mid") { label = "MID TIME"; color = "#f59e0b"; }
  else { label = "DOWNTIME"; color = "#6b7280"; }

  // Reason — grounded in the research
  const dayName = DAY_NAMES[dow];
  let reason = "";
  if (!withinLegalDialWindow(hour)) {
    reason = "Outside Florida's 8 AM – 8 PM legal window. Do NOT cold-call now (Fla. Stat. § 501.616).";
  } else if (tier === "prime") {
    if (hour >= 18 && hour < 20) reason = "6–8 PM every day — the single most-agreed-upon window in the data (Massey, CallHub, ThinkingPhones, WFM, MIT).";
    else if (dow === 6 && hour >= 8 && hour < 12) reason = "Saturday morning — the strongest weekend residential window. Longest, highest-quality calls (CallHub).";
    else if (dow === 6 && hour >= 16) reason = "Saturday late-afternoon — Massey Saturday holds 51–61% all day. Sellers are home.";
    else if (dow === 0 && hour >= 11 && hour <= 12) reason = "Sunday post-church, pre-football — the cleanest Sunday window in Florida (NBER worship data + NFL kickoff at 1 PM).";
    else if (dow === 0 && hour >= 17) reason = "Sunday early-evening — Massey ranks this the strongest evening in the table (62.1% at 7 PM).";
    else if (dow === 5 && hour >= 14 && hour < 17) reason = "Friday 2–5 PM — homeowners are home early (4:03 PM logoff, ActivTrak 75k workers). Catch them BEFORE the 5 PM commute snarl.";
    else reason = `${dayName} peak — dial hard now.`;
  } else if (tier === "mid") {
    if (hour === 8) reason = "8 AM first-touch on new expireds — be first to reach them (Landvoice loads leads at 8). Pickup low, first-mover value high.";
    else if (dow === 5 && hour >= 17) reason = "Friday evening — reachable but they want off the phone fast (CallHub Fri = shortest calls, 24.15s).";
    else if (dow === 0 && hour < 11) reason = "Sunday morning — Massey shows at-home contact high, but church etiquette in FL (Bible Belt) argues caution. Test locally.";
    else reason = "Middle window. Keep dialing but expect fewer pickups than Prime.";
  } else {
    if (dow === 4 && hour === 17) reason = "Thursday 5–6 PM — INRIX names Thursday the worst overall U.S. traffic day. Deepest commute hole of the week.";
    else if (dow === 5 && hour === 17) reason = "Friday 5–6 PM — the single worst commuting hour of the week (INRIX). Wait until 6 PM.";
    else if (hour >= 9 && hour <= 13) reason = "Weekday midday — residential DOWN zone. Working homeowners aren't home (Massey 40–46% vs 58–65% evening). Use for expired list-prep, not cold calls.";
    else reason = "Low-yield window. Save cold leads for Prime.";
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

  return { tier, score, label, reason, nextPrimeWindow, color };
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
