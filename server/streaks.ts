// ─────────────────────────────────────────────────────────────────────────────
// server/streaks.ts — v17.3 Streak & Champion Wreath engine
//
// Streak model (locked with Alex 2026-08-03):
//   • Qualifying day = ≥5 dials logged on that America/New_York calendar day.
//     Any outcome counts (proves the agent showed up and dialed).
//   • Streak = consecutive qualifying days ending today (or yesterday if today
//     hasn't qualified yet).
//   • Freeze = 1 auto-freeze per Sun–Sat calendar week (ET). If an agent misses
//     a day and their freeze is available, the streak survives and the freeze
//     is consumed for that week. Miss another day → streak resets to 0.
//
// Tier ladder (client uses same numbers to pick the badge asset):
//   1 = Consistent (7d)   badge: /badges/streak-1-consistent.png
//   2 = Locked In  (14d)  badge: /badges/streak-2-locked-in.png
//   3 = Machine    (30d)  badge: /badges/streak-3-machine.png
//   4 = Beastmode  (45d)  badge: /badges/streak-4-beastmode.png
//   5 = Legendary  (60d+) badge: /badges/streak-5-legendary.png
//
// Champion Wreath:
//   • Awarded to the #1 monthly-appts agent on the last day of the month at
//     11:59 PM ET (via cron in server/routes.ts).
//   • Winner's headshot is framed with /badges/champion-wreath.png for the
//     following month only. Refreshes each month.
//
// Storage (HARD RULE — no schema migrations; use app_settings):
//   Key: agent_streak:<agentId>  Value: JSON { current, best, lastQualifiedDate,
//        freezeUsedWeekKey }
//   Key: champion_current_month  Value: JSON { agentId, agentName, monthKey,
//        awardedAt, appts }
//   Key: champion_history        Value: JSON [{ agentId, agentName, monthKey,
//        appts, awardedAt }, ...] (newest first, capped at 60 entries)
// ─────────────────────────────────────────────────────────────────────────────

import { rawDb } from "./db";

const MIN_DIALS_PER_DAY = 5;
const TIER_THRESHOLDS = [
  { tier: 5, days: 60, label: "Legendary",  badge: "/badges/streak-5-legendary.png" },
  { tier: 4, days: 45, label: "Beastmode",  badge: "/badges/streak-4-beastmode.png" },
  { tier: 3, days: 30, label: "Machine",    badge: "/badges/streak-3-machine.png" },
  { tier: 2, days: 14, label: "Locked In",  badge: "/badges/streak-2-locked-in.png" },
  { tier: 1, days:  7, label: "Consistent", badge: "/badges/streak-1-consistent.png" },
];

// Which outcomes count as a "dial" for streak purposes. Everything the agent
// LOGS from the AgentView outcomes grid counts — including no_answer & wrong_number,
// because those still require them to have picked up the phone and worked the
// queue. Recycle also counts. Anything NOT in this set (e.g. system-only rows)
// is excluded defensively.
const DIAL_OUTCOMES = new Set([
  "contacted_appointment",
  "keep_in_touch",
  "recycled",
  "no_answer",
  "contacted_not_interested",
  "nice_not_interested",
  "wrong_number",
  // legacy names — kept so historical rows still count
  "callback_requested",
  "left_voicemail",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — America/New_York calendar days
// ─────────────────────────────────────────────────────────────────────────────

// Return "YYYY-MM-DD" for the given Date, in America/New_York.
export function etDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const day = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

// Return "YYYY-Www" ISO-ish week key using Sun–Sat weeks (ET). The freeze pool
// resets whenever this key changes.
export function etWeekKey(d: Date = new Date()): string {
  // Get ET wall-clock parts
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const y = parseInt(parts.find(p => p.type === "year")!.value, 10);
  const m = parseInt(parts.find(p => p.type === "month")!.value, 10);
  const day = parseInt(parts.find(p => p.type === "day")!.value, 10);
  const wd = parts.find(p => p.type === "weekday")!.value; // Sun/Mon/…/Sat
  const wdIdx = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
  // Roll back to the most-recent Sunday
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() - wdIdx);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Return "YYYY-MM" for the current ET month (used for champion wreath).
export function etMonthKey(d: Date = new Date()): string {
  return etDateKey(d).slice(0, 7);
}

// Add or subtract N days from an ET date key ("YYYY-MM-DD").
function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streak computation
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentStreak {
  agentId: number;
  current: number;              // days
  best: number;                 // days (all-time best)
  lastQualifiedDate: string | null;   // "YYYY-MM-DD"
  freezeUsedWeekKey: string | null;   // "YYYY-MM-DD" (Sunday) of the week the freeze was used
  tier: 0 | 1 | 2 | 3 | 4 | 5;  // 0 = no active streak
  tierLabel: string;            // "Consistent" | "Locked In" | ... | ""
  tierBadge: string | null;     // "/badges/streak-N-*.png" or null
  nextTierDays: number | null;  // days remaining to next tier (null if maxed)
  nextTierLabel: string | null;
}

function tierFor(days: number) {
  for (const t of TIER_THRESHOLDS) {
    if (days >= t.days) return t;
  }
  return { tier: 0 as const, days: 0, label: "", badge: null as string | null };
}

function nextTierFor(days: number) {
  // Walk ladder low → high
  const ladder = [...TIER_THRESHOLDS].reverse();
  for (const t of ladder) {
    if (days < t.days) return { days: t.days - days, label: t.label };
  }
  return null;
}

function loadStreakRow(agentId: number): {
  current: number;
  best: number;
  lastQualifiedDate: string | null;
  freezeUsedWeekKey: string | null;
} {
  const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(`agent_streak:${agentId}`) as { value: string } | undefined;
  if (!row) return { current: 0, best: 0, lastQualifiedDate: null, freezeUsedWeekKey: null };
  try {
    const j = JSON.parse(row.value);
    return {
      current: Number(j.current) || 0,
      best: Number(j.best) || 0,
      lastQualifiedDate: j.lastQualifiedDate || null,
      freezeUsedWeekKey: j.freezeUsedWeekKey || null,
    };
  } catch { return { current: 0, best: 0, lastQualifiedDate: null, freezeUsedWeekKey: null }; }
}

function saveStreakRow(agentId: number, data: {
  current: number; best: number; lastQualifiedDate: string | null; freezeUsedWeekKey: string | null;
}): void {
  const value = JSON.stringify(data);
  rawDb.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`agent_streak:${agentId}`, value);
}

// Count dials for a given agent on a given ET calendar day. This uses the ET
// day boundaries expressed as UTC ISO strings for the BETWEEN comparison against
// lead_activity.created_at. (v18.0 — was agent_lead_activity, table dropped.)
function countDialsForDay(agentId: number, etDay: string): number {
  // ET day = day at 00:00 ET → next day 00:00 ET. ET is UTC-5 or UTC-4.
  // We over-cover both offsets by scanning 04:00–05:00 UTC bookends and then
  // trusting the substr() ET conversion below. Cheaper: just scan a UTC 30h
  // window then filter by etDateKey().
  const startProbe = `${etDay}T00:00:00Z`;
  const endProbe   = `${addDaysToKey(etDay, 1)}T12:00:00Z`;
  const rows = rawDb.prepare(`
    SELECT outcome, created_at
    FROM lead_activity
    WHERE agent_id = ?
      AND created_at BETWEEN ? AND ?
  `).all(agentId, addDaysToKey(etDay, -1) + "T00:00:00Z", endProbe) as { outcome: string; created_at: string }[];
  let n = 0;
  for (const r of rows) {
    if (!DIAL_OUTCOMES.has(r.outcome)) continue;
    const rowEtDay = etDateKey(new Date(r.created_at));
    if (rowEtDay === etDay) n++;
  }
  return n;
}

// Recompute an agent's streak by walking backwards from today (ET). This is the
// authoritative computation. It is idempotent — running it twice gives the same
// answer. Called on-demand from /api/agents/:id/streak and from the nightly
// cron sweep.
export function computeAndPersistStreak(agentId: number): AgentStreak {
  const today = etDateKey();
  const week  = etWeekKey();
  const prior = loadStreakRow(agentId);

  // Walk backwards day by day. We look at up to 90 days (well past Legendary).
  // Rules:
  //   • Today doesn't have to qualify — an agent isn't "broken" mid-day. If
  //     today doesn't qualify yet, start counting from yesterday.
  //   • Consecutive qualifying days → +1.
  //   • Non-qualifying day INSIDE the current-week freeze window with no freeze
  //     used yet → freeze consumes it, streak continues past it.
  //   • Non-qualifying day with no freeze available → streak ends.
  let cursor = today;
  const todayQualified = countDialsForDay(agentId, cursor) >= MIN_DIALS_PER_DAY;
  if (!todayQualified) cursor = addDaysToKey(cursor, -1);

  let streak = 0;
  let lastQualifiedDate: string | null = null;
  let freezeUsedThisWeek = false;
  const freezeAvailableThisWeek = prior.freezeUsedWeekKey !== week; // fresh week ⇒ fresh freeze
  let freezeAvailable = freezeAvailableThisWeek;

  for (let i = 0; i < 90; i++) {
    const dials = countDialsForDay(agentId, cursor);
    const qualified = dials >= MIN_DIALS_PER_DAY;
    if (qualified) {
      if (lastQualifiedDate === null) lastQualifiedDate = cursor;
      streak++;
      cursor = addDaysToKey(cursor, -1);
      continue;
    }
    // Non-qualifying day. Can freeze absorb it?
    // Freeze rule: only usable when the missed day falls in the CURRENT ET week
    // (Sun–Sat matches the freezeUsedWeekKey semantics).
    if (freezeAvailable && etWeekKey(new Date(`${cursor}T18:00:00Z`)) === week) {
      freezeAvailable = false;
      freezeUsedThisWeek = true;
      cursor = addDaysToKey(cursor, -1);
      continue;
    }
    // Freeze not available or day is outside this week → streak ends here.
    break;
  }

  const current = streak;
  const best = Math.max(prior.best, current);
  const t = tierFor(current);
  const nt = nextTierFor(current);

  // Persist
  saveStreakRow(agentId, {
    current,
    best,
    lastQualifiedDate,
    freezeUsedWeekKey: freezeUsedThisWeek ? week : prior.freezeUsedWeekKey,
  });

  return {
    agentId,
    current,
    best,
    lastQualifiedDate,
    freezeUsedWeekKey: freezeUsedThisWeek ? week : prior.freezeUsedWeekKey,
    tier: t.tier as 0 | 1 | 2 | 3 | 4 | 5,
    tierLabel: t.label,
    tierBadge: t.badge,
    nextTierDays: nt?.days ?? null,
    nextTierLabel: nt?.label ?? null,
  };
}

// Recompute streaks for every ACTIVE agent. Used by the nightly cron so that
// tiers "roll" every night even without agent activity.
export function recomputeAllStreaks(): { count: number; ms: number } {
  const t0 = Date.now();
  const rows = rawDb.prepare(`
    SELECT id FROM agents WHERE is_active = 1
  `).all() as { id: number }[];
  for (const r of rows) computeAndPersistStreak(r.id);
  return { count: rows.length, ms: Date.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Champion Wreath
// ─────────────────────────────────────────────────────────────────────────────

export interface ChampionInfo {
  agentId: number | null;
  agentName: string | null;
  monthKey: string;            // "YYYY-MM" the wreath is FOR (i.e. this month)
  awardedForMonth: string;     // "YYYY-MM" the wreath was WON in (last month)
  awardedAt: string | null;    // ISO timestamp
  appts: number;               // winner's appts for the winning month
}

export function getCurrentChampion(): ChampionInfo {
  const nowMonth = etMonthKey();
  const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get("champion_current_month") as { value: string } | undefined;
  if (!row) {
    return { agentId: null, agentName: null, monthKey: nowMonth, awardedForMonth: "", awardedAt: null, appts: 0 };
  }
  try {
    const j = JSON.parse(row.value);
    // If the stored champion is for a month that is NO LONGER current, treat as
    // stale — the wreath expires on the 1st of the following month.
    // j.monthKey holds the DISPLAY month (the month in which the wreath is worn).
    if (j.monthKey !== nowMonth) {
      return { agentId: null, agentName: null, monthKey: nowMonth, awardedForMonth: "", awardedAt: null, appts: 0 };
    }
    return {
      agentId: j.agentId,
      agentName: j.agentName,
      monthKey: j.monthKey,
      awardedForMonth: j.awardedForMonth || "",
      awardedAt: j.awardedAt || null,
      appts: Number(j.appts) || 0,
    };
  } catch {
    return { agentId: null, agentName: null, monthKey: nowMonth, awardedForMonth: "", awardedAt: null, appts: 0 };
  }
}

// Compute the #1 monthly-appts agent for the CLOSING month and record them as
// the champion for the FOLLOWING month. Called by the cron on the last day of
// the month at 11:59 PM ET. Idempotent — running twice in the same month keeps
// the same winner.
export function crownMonthlyChampion(): ChampionInfo {
  const now = new Date();
  const closingMonth = etMonthKey(now); // month we just finished
  // Winner is #1 monthly appts (contacted_appointment) in that month, ET.
  const monthStart = `${closingMonth}-01T04:00:00Z`;     // ~00:00 ET on 1st
  const [y, m] = closingMonth.split("-").map(Number);
  const nextMonthDate = new Date(Date.UTC(y, m, 1));
  const monthEndExclusive = nextMonthDate.toISOString();

  // v18.0 — was agent_lead_activity/caller_id, table dropped. Seller-side only now.
  const winner = rawDb.prepare(`
    SELECT a.id as id, a.name as name, COUNT(*) as appts
    FROM lead_activity la
    JOIN agents a ON a.id = la.agent_id
    WHERE la.outcome = 'contacted_appointment'
      AND la.created_at >= ?
      AND la.created_at <  ?
      AND a.is_active = 1
    GROUP BY a.id
    ORDER BY appts DESC, a.id ASC
    LIMIT 1
  `).get(monthStart, monthEndExclusive) as { id: number; name: string; appts: number } | undefined;

  const displayMonth = (() => {
    const nm = new Date(Date.UTC(y, m, 1));
    const yy = nm.getUTCFullYear();
    const mm = String(nm.getUTCMonth() + 1).padStart(2, "0");
    return `${yy}-${mm}`;
  })();

  if (!winner) {
    return { agentId: null, agentName: null, monthKey: displayMonth, awardedForMonth: closingMonth, awardedAt: null, appts: 0 };
  }

  const record = {
    agentId: winner.id,
    agentName: winner.name,
    monthKey: displayMonth,          // month the wreath is DISPLAYED in
    awardedForMonth: closingMonth,   // month it was WON in
    awardedAt: new Date().toISOString(),
    appts: winner.appts,
  };
  rawDb.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("champion_current_month", JSON.stringify(record));

  // Also append to champion_history
  const histRow = rawDb.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get("champion_history") as { value: string } | undefined;
  let hist: any[] = [];
  if (histRow) { try { hist = JSON.parse(histRow.value) || []; } catch {} }
  // Dedupe: if the last entry is the same monthKey+agent, replace it
  const key = `${record.awardedForMonth}:${record.agentId}`;
  hist = hist.filter(h => `${h.awardedForMonth}:${h.agentId}` !== key);
  hist.unshift(record);
  if (hist.length > 60) hist.length = 60;
  rawDb.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("champion_history", JSON.stringify(hist));

  return record;
}

export function getChampionHistory(): any[] {
  const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get("champion_history") as { value: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.value) || []; } catch { return []; }
}
