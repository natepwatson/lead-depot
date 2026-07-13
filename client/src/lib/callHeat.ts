// v15.11.11 — 5-tier Sprint Mode heat (illegal / dead / low / middle / prime).
// Client mirror of shared/prime-schedule.ts. If you edit one, edit both.
//
// Legal cap: Fla. Stat. § 501.616(6)(a) — commercial calls 8 AM – 8 PM
// recipient-local. NEVER call at or after 8 PM. Last legal dial hour is 7 PM.
// https://www.flsenate.gov/laws/statutes/2021/501.616

export type SprintTier = "illegal" | "dead" | "low" | "middle" | "prime";
export type HeatTier = "prime" | "mid" | "down"; // 3-tier award form (backwards compat)

export interface CallHeat {
  tier: HeatTier;              // 3-tier form (award/color legacy)
  sprintTier: SprintTier;      // 5-tier form (display chip)
  score: number;               // 0-100 receptivity index (informational)
  label: string;               // "PRIME TIME" | "MIDDLE" | "LOW" | "DEAD" | "ILLEGAL"
  reason: string;
  nextPrimeWindow?: string;
  color: string;
}

// 7 rows (Sun..Sat) × 12 columns (8AM..7PM) — grid MUST match shared/prime-schedule.ts
const GRID: SprintTier[][] = [
  // 8AM     9AM      10AM     11AM     12PM     1PM      2PM      3PM       4PM       5PM       6PM       7PM
  ["dead",  "dead",   "dead",  "dead",  "dead",  "dead",  "dead",  "dead",   "dead",   "dead",   "dead",   "dead"  ], // Sun
  ["low",   "low",    "middle","low",   "dead",  "dead",  "low",   "middle", "middle", "middle", "middle", "middle"], // Mon
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Tue
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Wed
  ["prime", "prime",  "middle","low",   "dead",  "dead",  "low",   "middle", "prime",  "prime",  "prime",  "middle"], // Thu
  ["low",   "middle", "middle","low",   "dead",  "dead",  "low",   "middle", "middle", "middle", "middle", "low"   ], // Fri
  ["dead",  "middle", "prime", "prime", "low",   "low",   "low",   "low",    "dead",   "dead",   "dead",   "dead"  ], // Sat
];

const SCORE_BY_TIER: Record<SprintTier, number> = {
  prime: 92, middle: 62, low: 38, dead: 15, illegal: 0,
};

// Legacy exports kept so old imports don't break at build time. Do NOT use.
export const HOUR_WEIGHTS: number[] = new Array(24).fill(0.5);
export const DAY_MULTIPLIERS: number[] = [1, 1, 1, 1, 1, 1, 1];

function withinLegalDialWindow(hour: number): boolean {
  // 8 AM – 8 PM (last legal hour is 7:00–7:59 PM). Fla. Stat. § 501.616(6)(a).
  return hour >= 8 && hour < 20;
}

/** 5-tier display lookup for a (dow, hour) cell. */
export function sprintTierForCell(dow: number, hour: number): SprintTier {
  if (!withinLegalDialWindow(hour)) return "illegal";
  const row = GRID[dow];
  if (!row) return "illegal";
  return row[hour - 8] ?? "illegal";
}

/** 3-tier award form (backwards compat). Collapses 5 display tiers → 3 award tiers. */
export function tierForCell(dow: number, hour: number): HeatTier {
  const t = sprintTierForCell(dow, hour);
  if (t === "prime") return "prime";
  if (t === "middle" || t === "low") return "mid";
  return "down"; // dead or illegal
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Compute call heat for a given moment (defaults to now, ET). */
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

  const sprintTier: SprintTier = sprintTierForCell(dow, hour);
  const tier: HeatTier = sprintTier === "prime" ? "prime"
    : (sprintTier === "middle" || sprintTier === "low") ? "mid"
    : "down";
  const score = SCORE_BY_TIER[sprintTier];

  // 5-tier chip appearance
  let label: string;
  let color: string;
  switch (sprintTier) {
    case "prime":   label = "PRIME TIME"; color = "#ef4444"; break;   // red
    case "middle":  label = "MIDDLE";     color = "#f59e0b"; break;   // amber
    case "low":     label = "LOW";        color = "#facc15"; break;   // yellow
    case "dead":    label = "DEAD";       color = "#6b7280"; break;   // gray
    case "illegal": label = "ILLEGAL";    color = "#991b1b"; break;   // dark red
  }

  // Reason — grounded in the research + user-approved schedule
  const dayName = DAY_NAMES[dow];
  let reason = "";
  if (sprintTier === "illegal") {
    reason = "Outside Florida's 8 AM – 8 PM legal window. Do NOT cold-call now (Fla. Stat. § 501.616).";
  } else if (sprintTier === "prime") {
    if (dow === 6 && hour >= 10 && hour < 12) reason = "Saturday 10 AM – noon — the second-best window overall per PropContact. Especially strong for older/land-owner leads.";
    else if (dow >= 2 && dow <= 4 && hour === 8) reason = "Tue/Wed/Thu 8 AM — Day-1 expired golden hour (REDX, Kravitz, Jamil). Be first before the other 20+ agents dial.";
    else if (dow >= 2 && dow <= 4 && hour === 9) reason = "Tue/Wed/Thu 9 AM — fresh-expired window continues. Mothers-Always-Right 8–10:30 sweet spot.";
    else if (dow >= 2 && dow <= 4 && hour >= 16 && hour < 19) reason = `${dayName} ${hour === 16 ? "4" : hour === 17 ? "5" : "6"}–${hour === 16 ? "5" : hour === 17 ? "6" : "7"} PM — MIT's #1 contact window (114% better than worst). Universal peak in every dataset (Orum, Gong, PropContact, Revenue.io).`;
    else reason = `${dayName} peak — dial hard now.`;
  } else if (sprintTier === "middle") {
    if (hour >= 10 && hour < 11) reason = "Late morning — Orum/Gong peak, but every other agent is dialing now. Solid but competitive.";
    else if (hour >= 15 && hour < 16) reason = `${dayName} 3–4 PM — ramp into afternoon peak. Revenue.io flags 3–6 PM window.`;
    else if (hour === 19) reason = `${dayName} 7 PM — post-dinner. Legal until 8 PM but declining pickup.`;
    else if (dow === 5) reason = "Friday — solid but expect 40–60% lower pickup than Tue/Wed/Thu (PropContact).";
    else reason = `${dayName} middle window — reachable but not sprint-worthy.`;
  } else if (sprintTier === "low") {
    if (hour === 8 && (dow === 1 || dow === 5)) reason = `${dayName} 8 AM — usable for expired first-touch, but Mon/Fri weaker than Tue–Thu.`;
    else if (hour === 11) reason = "11 AM–noon — ramping into lunch trough. Not sprint-worthy.";
    else if (hour === 14) reason = "2–3 PM — post-lunch tail. Retirees/self-employed OK; weak for working adults.";
    else if (dow === 6) reason = "Saturday afternoon — family time; PropContact 'many won't answer.' Usable but low ROI.";
    else reason = `${dayName} low-yield window. Save cold leads for prime.`;
  } else if (sprintTier === "dead") {
    if (hour === 12 || hour === 13) reason = "Lunch/crunch — MIT's worst window (114% worse than 4–6 PM). Every study agrees. Do not dial.";
    else if (dow === 0) reason = "Sunday — family/church day. Bad ROI and bad taste. Save it for Monday.";
    else reason = `${dayName} dead zone — pickup too low to justify the list burn.`;
  }

  // Next prime window
  let nextPrimeWindow: string | undefined;
  if (tier !== "prime") {
    for (let ahead = 1; ahead <= 24 * 7; ahead++) {
      const t = new Date(now.getTime() + ahead * 3600 * 1000);
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(t);
      let h2 = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10);
      if (h2 === 24) h2 = 0;
      const wd2 = p.find(x => x.type === "weekday")?.value ?? "Mon";
      const d2 = dowMap[wd2] ?? 1;
      if (tierForCell(d2, h2) === "prime") {
        const hourLabel = h2 === 0 ? "12 AM" : h2 < 12 ? `${h2} AM` : h2 === 12 ? "12 PM" : `${h2 - 12} PM`;
        const dayLabel = d2 === dow ? "today" : d2 === (dow + 1) % 7 ? "tomorrow" : DAY_NAMES[d2];
        nextPrimeWindow = ahead <= 1 ? `Next prime at ${hourLabel} (~1h)` : `Next prime ${dayLabel} ${hourLabel} (~${ahead}h)`;
        break;
      }
    }
  }

  return { tier, sprintTier, score, label, reason, nextPrimeWindow, color };
}

/** Prime window starts — used by the 15-min-before push cron. */
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
