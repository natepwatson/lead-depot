// v15.3 — Optimal call-time meter for expired-listing / motivated-seller phone sales.
//
// Weights below are grounded in published contact-rate studies. The score is a 0-100
// receptivity index for "how good is RIGHT NOW to dial an expired-listing seller?".
//
// Sources:
//   - MIT / InsideSales.com Lead Response Management Study (100k+ dials, 15k leads)
//     https://www.onecavo.com/wp-content/uploads/2015/11/MIT-InsideSales.com_Lead-Response-Management.pdf
//     * 4-6 PM is the best time to CONTACT (+114% vs worst block)
//     * 8-9 AM & 4-5 PM are best for qualification (+164% vs 1-2 PM)
//     * Wednesday & Thursday are best contact days (+49.7% vs worst)
//   - PhoneBurner 11M-call analysis: 10 AM = 15.53% pickup, one of the highest windows
//   - CallHippo: pickup rate 27% mid-morning → 46% at 4-5 PM (nearly 2x)
//   - Cognism 200k B2B calls: Thursday connect rate ~14-15%, 50% lift vs Monday
//   - Revenue.io (formerly RingDNA): 4-5 PM slot 109% better than 11-12 for qualification
//   - Residential real-estate note (Skipcall/Cognism): Saturday morning is the exceptional
//     residential day — buyers & sellers are home. Sunday afternoon is dead.

export type HeatTier = "hot" | "warm" | "cool" | "cold";

export interface CallHeat {
  tier: HeatTier;
  score: number;            // 0-100 receptivity index
  label: string;            // "PRIME TIME", "GOOD WINDOW", "OK", "COLD"
  reason: string;            // short one-line explanation
  nextHotWindow?: string;   // e.g. "peaks in 2h at 4 PM"
  color: string;             // hex for meter fill
}

// Hour-of-day base weights (0-23, local time). Peaks: 8-10 AM & 4-6 PM.
// Trough: 12-2 PM lunch, evenings after 8 PM, before 7 AM.
// Numbers are relative receptivity, roughly calibrated to MIT/CallHippo pickup deltas.
const HOUR_WEIGHTS: number[] = [
  //  0    1    2    3    4    5    6    7    8    9   10   11
     0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.20, 0.45, 0.85, 0.90, 0.85, 0.70,
  // 12   13   14   15   16   17   18   19   20   21   22   23
     0.35, 0.30, 0.55, 0.75, 0.95, 1.00, 0.80, 0.55, 0.30, 0.15, 0.10, 0.05,
];

// Day-of-week multipliers (0=Sun, 1=Mon ... 6=Sat).
// Wed/Thu are peaks per MIT + Cognism. Sat morning is exceptional for residential RE.
// Sun afternoon is worst; Fri PM is nearly as bad.
const DAY_MULTIPLIERS: number[] = [
  0.65, // Sun — soft; Sun AM ok, Sun PM dead
  0.80, // Mon — recovery day, mornings weak
  0.95, // Tue — strong
  1.05, // Wed — peak
  1.05, // Thu — peak
  0.70, // Fri — fades hard after lunch
  0.95, // Sat — residential-RE sweet spot, esp AM
];

// Saturday-morning override: residential real estate contact rate spikes 8-11 AM
// because sellers are home and not at work. Bump those hours further on Sat.
function saturdayMorningBoost(hour: number, dow: number): number {
  if (dow !== 6) return 1;
  if (hour >= 8 && hour <= 11) return 1.15;
  return 1;
}

// Friday-afternoon penalty: Cognism found 65% of voicemails happen Fri PM.
function fridayAfternoonPenalty(hour: number, dow: number): number {
  if (dow !== 5) return 1;
  if (hour >= 14) return 0.75;
  return 1;
}

/**
 * Compute the receptivity heat for a given moment.
 * @param now Optional Date (defaults to real now). Use for testing.
 * @param tz  IANA timezone string (defaults to America/New_York — Brothers Group is Jacksonville).
 */
export function computeCallHeat(now: Date = new Date(), tz: string = "America/New_York"): CallHeat {
  // Extract hour + day-of-week in the target timezone.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const hourStr = parts.find(p => p.type === "hour")?.value ?? "0";
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  let hour = parseInt(hourStr, 10);
  if (isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0; // Intl edge case in some engines
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wdStr] ?? 1;

  const base = HOUR_WEIGHTS[hour] ?? 0.05;
  const dayMult = DAY_MULTIPLIERS[dow] ?? 0.9;
  const satBoost = saturdayMorningBoost(hour, dow);
  const friPen = fridayAfternoonPenalty(hour, dow);

  const raw = base * dayMult * satBoost * friPen;
  const score = Math.round(Math.min(1, Math.max(0, raw)) * 100);

  let tier: HeatTier;
  let label: string;
  let color: string;
  if (score >= 80) { tier = "hot";  label = "PRIME TIME";  color = "#ef4444"; }
  else if (score >= 55) { tier = "warm"; label = "GOOD WINDOW"; color = "#f59e0b"; }
  else if (score >= 30) { tier = "cool"; label = "OK";           color = "#c8aa5a"; }
  else { tier = "cold"; label = "COLD"; color = "#6b7280"; }

  // Reason string — human-readable, tied to the biggest contributing factor.
  let reason = "";
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];
  if (tier === "hot") {
    if (hour >= 16 && hour <= 17) reason = "4-6 PM is the #1 contact window — 114% more effective than the worst block (MIT study).";
    else if (hour >= 8 && hour <= 10 && dow === 6) reason = "Saturday 8-11 AM — residential sellers are home. Peak weekend window.";
    else if (hour >= 8 && hour <= 10) reason = "8-10 AM is a top qualification window — 164% better than post-lunch (MIT).";
    else reason = `${dayName} peak hour — dial hard now.`;
  } else if (tier === "warm") {
    if (dow === 3 || dow === 4) reason = `${dayName} is a top contact day. Solid window — expect above-average pickup.`;
    else if (hour === 15) reason = "3 PM warm-up before the 4-6 PM peak. Start dialing so you're deep in the queue by 4.";
    else reason = "Above-average pickup expected. Stay on the phones.";
  } else if (tier === "cool") {
    if (hour >= 11 && hour <= 13) reason = "Lunch dip (11-2 PM) — pickup rates crash. Use this for CRM/admin, not cold dials.";
    else if (dow === 1) reason = "Monday morning — decision-makers are catching up. Pickup lags until mid-morning.";
    else reason = "Middling window. Dial the recycled/warm list, save the cold pours for the 4 PM push.";
  } else {
    if (hour >= 20 || hour < 7) reason = "Outside acceptable dial hours. Do NOT cold-call now — TCPA + reputational risk.";
    else if (dow === 5 && hour >= 14) reason = "Friday afternoon — 65% of dials hit voicemail. Save the leads for Monday-Thursday.";
    else if (dow === 0 && hour >= 13) reason = "Sunday afternoon — worst window of the week. Prospects tune out.";
    else reason = "Low-receptivity window. Recycle time, not dial time.";
  }

  // Next hot window — look forward up to 12h for the next hour that lands in the "hot" bucket.
  let nextHotWindow: string | undefined;
  if (tier !== "hot") {
    for (let ahead = 1; ahead <= 12; ahead++) {
      const t = new Date(now.getTime() + ahead * 60 * 60 * 1000);
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(t);
      let h2 = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10);
      if (h2 === 24) h2 = 0;
      const wd2 = p.find(x => x.type === "weekday")?.value ?? "Mon";
      const d2 = dowMap[wd2] ?? 1;
      const s = (HOUR_WEIGHTS[h2] ?? 0.05) * (DAY_MULTIPLIERS[d2] ?? 0.9)
              * saturdayMorningBoost(h2, d2) * fridayAfternoonPenalty(h2, d2);
      if (Math.min(1, s) * 100 >= 80) {
        const hourLabel = h2 === 0 ? "12 AM" : h2 < 12 ? `${h2} AM` : h2 === 12 ? "12 PM" : `${h2 - 12} PM`;
        nextHotWindow = ahead === 1 ? `peaks in ~1h at ${hourLabel}` : `peaks in ${ahead}h at ${hourLabel}`;
        break;
      }
    }
  }

  return { tier, score, label, reason, nextHotWindow, color };
}
