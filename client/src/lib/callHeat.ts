// v15.11 — Optimal call-time meter, redesigned to 3 explicit tiers to match
// the Alex-decreed studio metaphor:
//
//   PRIME  — On Air. This is when we call. Non-negotiable.
//   MID    — OK to dial but not the sprint window.
//   DOWN   — Do not cold-call. Save the leads for Prime.
//
// Weights below are grounded in published contact-rate studies. The score is
// still a 0-100 receptivity index; the 3-tier split is layered on top so the
// UI copy stays honest.
//
// Sources:
//   - MIT / InsideSales.com Lead Response Management Study
//     https://www.onecavo.com/wp-content/uploads/2015/11/MIT-InsideSales.com_Lead-Response-Management.pdf
//     * 4-6 PM is the best time to CONTACT (+114% vs worst block)
//     * 8-9 AM & 4-5 PM are best for qualification (+164% vs 1-2 PM)
//     * Wednesday & Thursday are best contact days (+49.7% vs worst)
//   - PhoneBurner 11M-call analysis: 10 AM = 15.53% pickup, one of the highest windows
//   - CallHippo: pickup rate 27% mid-morning → 46% at 4-5 PM (nearly 2x)
//   - Cognism 200k B2B calls: Thursday connect rate ~14-15%, 50% lift vs Monday
//   - Revenue.io: 4-5 PM slot 109% better than 11-12 for qualification
//   - Skipcall/Cognism residential note: Saturday morning is the exceptional
//     residential day. Sunday afternoon is dead.

export type HeatTier = "prime" | "mid" | "down";

// Legacy alias for pre-v15.11 callers that referenced the old 4-tier names.
// Removed in v15.12; keep this comment as a reminder.

export interface CallHeat {
  tier: HeatTier;
  score: number;            // 0-100 receptivity index
  label: string;            // "PRIME TIME" | "MID TIME" | "DOWNTIME"
  reason: string;
  nextPrimeWindow?: string; // e.g. "peaks in 2h at 4 PM"
  color: string;
}

// Hour-of-day base weights (0-23, local time). Peaks: 8-10 AM & 4-6 PM.
// Trough: 12-2 PM lunch, evenings after 8 PM, before 7 AM.
const HOUR_WEIGHTS: number[] = [
  //  0    1    2    3    4    5    6    7    8    9   10   11
     0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.20, 0.45, 0.85, 0.90, 0.85, 0.70,
  // 12   13   14   15   16   17   18   19   20   21   22   23
     0.35, 0.30, 0.55, 0.75, 0.95, 1.00, 0.80, 0.55, 0.30, 0.15, 0.10, 0.05,
];

// Day-of-week multipliers (0=Sun ... 6=Sat).
const DAY_MULTIPLIERS: number[] = [
  0.65, // Sun
  0.80, // Mon
  0.95, // Tue
  1.05, // Wed
  1.05, // Thu
  0.70, // Fri
  0.95, // Sat
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

/** TCPA / operational cutoff — never cold-call outside 8am-9pm local. */
function withinLegalDialWindow(hour: number): boolean {
  return hour >= 8 && hour < 21;
}

/**
 * Compute the receptivity heat for a given moment.
 * @param now Optional Date (defaults to real now). Use for testing.
 * @param tz  IANA timezone string (defaults to America/New_York — Brothers Group is Jacksonville).
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

  const base = HOUR_WEIGHTS[hour] ?? 0.05;
  const dayMult = DAY_MULTIPLIERS[dow] ?? 0.9;
  const satBoost = saturdayMorningBoost(hour, dow);
  const friPen = fridayAfternoonPenalty(hour, dow);

  const raw = base * dayMult * satBoost * friPen;
  const score = Math.round(Math.min(1, Math.max(0, raw)) * 100);

  // 3-tier assignment. The legal-dial cutoff overrides everything else.
  let tier: HeatTier;
  let label: string;
  let color: string;

  if (!withinLegalDialWindow(hour)) {
    tier = "down"; label = "DOWNTIME"; color = "#6b7280";
  } else if (score >= 75) {
    tier = "prime"; label = "PRIME TIME"; color = "#ef4444";
  } else if (score >= 40) {
    tier = "mid"; label = "MID TIME"; color = "#f59e0b";
  } else {
    tier = "down"; label = "DOWNTIME"; color = "#6b7280";
  }

  // Reason string
  let reason = "";
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];
  if (tier === "prime") {
    if (hour >= 16 && hour <= 17) reason = "4-6 PM is the #1 contact window — 114% better than the worst block (MIT study).";
    else if (hour >= 8 && hour <= 10 && dow === 6) reason = "Saturday 8-11 AM — residential sellers are home. Peak weekend window.";
    else if (hour >= 8 && hour <= 10) reason = "8-10 AM is a top qualification window — 164% better than post-lunch (MIT).";
    else reason = `${dayName} peak hour — dial hard now.`;
  } else if (tier === "mid") {
    if (dow === 3 || dow === 4) reason = `${dayName} is a top contact day. Above-average pickup expected.`;
    else if (hour === 15) reason = "3 PM warm-up before the 4-6 PM peak. Get in the queue now.";
    else if (hour >= 11 && hour <= 13) reason = "Lunch slump. Middling — work the warm/recycle list, save cold for the 4 PM push.";
    else reason = "Middle-of-the-road window. Keep dialing but expect fewer pickups than Prime.";
  } else {
    if (!withinLegalDialWindow(hour)) reason = "Outside 8am-9pm legal dial window. Do NOT cold-call now (TCPA).";
    else if (dow === 5 && hour >= 14) reason = "Friday afternoon — 65% of dials hit voicemail (Cognism). Not worth the leads.";
    else if (dow === 0 && hour >= 13) reason = "Sunday afternoon — worst window of the week.";
    else reason = "Low-receptivity window. Save the leads for Prime Time.";
  }

  // Next Prime window — look forward up to 12h for the next hour that lands in Prime.
  let nextPrimeWindow: string | undefined;
  if (tier !== "prime") {
    for (let ahead = 1; ahead <= 12; ahead++) {
      const t = new Date(now.getTime() + ahead * 60 * 60 * 1000);
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(t);
      let h2 = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10);
      if (h2 === 24) h2 = 0;
      const wd2 = p.find(x => x.type === "weekday")?.value ?? "Mon";
      const d2 = dowMap[wd2] ?? 1;
      if (!withinLegalDialWindow(h2)) continue;
      const s = (HOUR_WEIGHTS[h2] ?? 0.05) * (DAY_MULTIPLIERS[d2] ?? 0.9)
              * saturdayMorningBoost(h2, d2) * fridayAfternoonPenalty(h2, d2);
      if (Math.min(1, s) * 100 >= 75) {
        const hourLabel = h2 === 0 ? "12 AM" : h2 < 12 ? `${h2} AM` : h2 === 12 ? "12 PM" : `${h2 - 12} PM`;
        nextPrimeWindow = ahead === 1 ? `Next Prime at ${hourLabel} (~1h)` : `Next Prime at ${hourLabel} (~${ahead}h)`;
        break;
      }
    }
  }

  return { tier, score, label, reason, nextPrimeWindow, color };
}

/**
 * Server-side utility (called from cron): given a timezone, return every
 * hour-of-week where a PRIME window STARTS (the first hour of a contiguous
 * prime block). Used by the push cron to know when to fire the T-30 alert.
 *
 * Returns pairs of (dow, hour) in the provided timezone.
 */
export function listPrimeWindowStarts(tz: string = "America/New_York"): Array<{ dow: number; hour: number }> {
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
