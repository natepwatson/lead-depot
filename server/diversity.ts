// v17.6 — Diversity Challenge: weekly bonus for agents who hit multiple
// lead-gen categories in a single ET week (Mon–Sun).
//
// Categories (5 total):
//   1. phone     — any dial outcome in lead_activity for the week
//   2. open_house— approval_requests kind='open_house_log' (approved this week)
//   3. door_knock— approval_requests kind IN ('door_knock_log','oh_knock_route') (approved this week)
//   4. direct_mail— approval_requests kind='direct_mail_log' (approved this week)
//   5. social    — approval_requests kind='social_post' (approved this week)
//
// Tiered bonus:
//   3 categories → +150
//   4 categories → +200
//   5 categories → +250
//
// Awarded Sunday 23:59 ET via cron. Idempotent: guarded by unique
// (agent_id, week_start) in diversity_bonuses table.
//
// Streak: consecutive weeks where any bonus was awarded → surfaced in badges.

import { rawDb } from "./db";

export function ensureDiversityChallengeSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS diversity_bonuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,           -- 'YYYY-MM-DD' Monday ET
      week_end TEXT NOT NULL,             -- 'YYYY-MM-DD' Sunday ET
      categories_hit INTEGER NOT NULL,    -- 3, 4, or 5
      categories_list TEXT NOT NULL,      -- JSON array of category strings
      points_awarded INTEGER NOT NULL,    -- 150, 200, or 250
      awarded_at TEXT NOT NULL,           -- ISO timestamp
      UNIQUE(agent_id, week_start)
    );
    CREATE INDEX IF NOT EXISTS idx_div_agent ON diversity_bonuses(agent_id);
    CREATE INDEX IF NOT EXISTS idx_div_week ON diversity_bonuses(week_start);
  `);
}

// Return ET Monday and ET Sunday for a given ET reference date (YYYY-MM-DD)
function weekBoundsET(etDateStr: string): { start: string; end: string } {
  const [y, m, d] = etDateStr.split("-").map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC = safe midday
  // getUTCDay: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const dow = dt.getUTCDay();
  const daysBackToMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - daysBackToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

// Current ET date (YYYY-MM-DD)
function todayET(): string {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    .toISOString().slice(0, 10);
}

// Which categories did agent hit in [start..end] inclusive?
export function categoriesHitForAgent(agentId: number, weekStart: string, weekEnd: string): string[] {
  const hit: string[] = [];

  // Phone: any actual dial outcome in lead_activity for the agent in the range.
  // Excludes evidence-approval outcomes (open_house_log, direct_mail_log, etc.).
  const phone = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM lead_activity
    WHERE agent_id = ?
      AND substr(created_at, 1, 10) BETWEEN ? AND ?
      AND outcome IN (
        'appt_set','keep_in_touch','network_referral','owner_no_answer',
        'no_answer','not_interested','wrong_number','disconnected',
        'recycled','contacted_not_interested','listed','open_house_lead'
      )
  `).get(agentId, weekStart, weekEnd) as any;
  if ((phone?.n || 0) > 0) hit.push("phone");

  // Open house (approved)
  const oh = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM approval_requests
    WHERE agent_id = ? AND status = 'approved'
      AND kind = 'open_house_log'
      AND substr(decided_at, 1, 10) BETWEEN ? AND ?
  `).get(agentId, weekStart, weekEnd) as any;
  if ((oh?.n || 0) > 0) hit.push("open_house");

  // Door knock (approved) — includes standalone DK and OH knock route
  const dk = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM approval_requests
    WHERE agent_id = ? AND status = 'approved'
      AND kind IN ('door_knock_log','oh_knock_route')
      AND substr(decided_at, 1, 10) BETWEEN ? AND ?
  `).get(agentId, weekStart, weekEnd) as any;
  if ((dk?.n || 0) > 0) hit.push("door_knock");

  // Direct mail (approved)
  const dm = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM approval_requests
    WHERE agent_id = ? AND status = 'approved'
      AND kind = 'direct_mail_log'
      AND substr(decided_at, 1, 10) BETWEEN ? AND ?
  `).get(agentId, weekStart, weekEnd) as any;
  if ((dm?.n || 0) > 0) hit.push("direct_mail");

  // Social post (approved)
  const sp = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM approval_requests
    WHERE agent_id = ? AND status = 'approved'
      AND kind = 'social_post'
      AND substr(decided_at, 1, 10) BETWEEN ? AND ?
  `).get(agentId, weekStart, weekEnd) as any;
  if ((sp?.n || 0) > 0) hit.push("social");

  return hit;
}

export function bonusForCount(count: number): number {
  if (count >= 5) return 250;
  if (count >= 4) return 200;
  if (count >= 3) return 150;
  return 0;
}

// Award diversity bonuses for a given ET week (start/end YYYY-MM-DD).
// Idempotent per (agent_id, week_start). Returns list of awards inserted.
export function awardDiversityBonusesForWeek(weekStart: string, weekEnd: string): Array<{
  agentId: number; agentName: string; count: number; points: number; categories: string[];
}> {
  ensureDiversityChallengeSchema();
  const awards: Array<{ agentId: number; agentName: string; count: number; points: number; categories: string[] }> = [];

  // Iterate all active agents
  const agents = rawDb.prepare(`SELECT id, name FROM agents WHERE deactivated IS NULL OR deactivated = 0`).all() as any[];
  const now = new Date().toISOString();

  const insertBonus = rawDb.prepare(`
    INSERT OR IGNORE INTO diversity_bonuses
      (agent_id, week_start, week_end, categories_hit, categories_list, points_awarded, awarded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPoints = rawDb.prepare(`
    INSERT INTO agent_points (agent_id, points, reason, created_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const a of agents) {
    const cats = categoriesHitForAgent(a.id, weekStart, weekEnd);
    const points = bonusForCount(cats.length);
    if (points === 0) continue;

    const info = insertBonus.run(
      a.id, weekStart, weekEnd, cats.length, JSON.stringify(cats), points, now
    );
    // If IGNORE hit (already awarded this week), skip point insert
    if (info.changes > 0) {
      insertPoints.run(a.id, points, `diversity_bonus:${cats.length}`, now);
      awards.push({ agentId: a.id, agentName: a.name, count: cats.length, points, categories: cats });
    }
  }
  return awards;
}

// Compute streak of consecutive weeks where agent got any bonus
export function streakForAgent(agentId: number): number {
  ensureDiversityChallengeSchema();
  const rows = rawDb.prepare(`
    SELECT week_start FROM diversity_bonuses
    WHERE agent_id = ?
    ORDER BY week_start DESC
    LIMIT 60
  `).all(agentId) as any[];
  if (rows.length === 0) return 0;

  const { start: currentWeek } = weekBoundsET(todayET());
  // Walk back week-by-week and count consecutive presence
  let streak = 0;
  let cursor = currentWeek;
  const set = new Set(rows.map((r) => r.week_start));
  // Only count fully completed weeks. If agent has an award for prior week, count consecutively.
  // For simplicity: last consecutive weeks where entry exists.
  const bounds = weekBoundsET(currentWeek);
  // Iterate: start from most-recent completed week (previous week)
  const [y, m, d] = bounds.start.split("-").map((v) => parseInt(v, 10));
  const cur = new Date(Date.UTC(y, m - 1, d, 12));
  // Move to previous week Monday
  cur.setUTCDate(cur.getUTCDate() - 7);
  for (let i = 0; i < 60; i++) {
    const iso = cur.toISOString().slice(0, 10);
    if (set.has(iso)) {
      streak++;
      cur.setUTCDate(cur.getUTCDate() - 7);
    } else {
      break;
    }
  }
  return streak;
}

// Schedule Sunday 23:59 ET via setTimeout loop (matches dailySnapshots pattern).
// Recomputes next fire time after each tick so DST transitions self-correct.
export function scheduleDiversityChallengeCron(sendNotification?: (msg: any) => void) {
  ensureDiversityChallengeSchema();

  function msUntilNextSunday23_59ET(): number {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc; }, {});
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[parts.weekday as string] ?? 0;
    const H = parseInt(parts.hour, 10);
    const M = parseInt(parts.minute, 10);
    const S = parseInt(parts.second, 10);
    // Seconds until end of Sunday (dow=0), at 23:59:00.
    const nowSecInDay = H * 3600 + M * 60 + S;
    const targetSecInDay = 23 * 3600 + 59 * 60;
    let secs: number;
    if (dow === 0) {
      secs = targetSecInDay - nowSecInDay;
      if (secs <= 0) secs += 7 * 24 * 3600;
    } else {
      // days until next Sunday = 7 - dow
      const daysUntilSun = 7 - dow;
      secs = daysUntilSun * 24 * 3600 + (targetSecInDay - nowSecInDay);
    }
    return secs * 1000;
  }

  const initialDelay = msUntilNextSunday23_59ET();
  console.log(`[diversity] Weekly award scheduled in ${Math.round(initialDelay / 60000)} min (Sun 23:59 ET)`);

  setTimeout(function fire() {
    try {
      const today = todayET();
      const { start, end } = weekBoundsET(today);
      const awards = awardDiversityBonusesForWeek(start, end);
      console.log(`[diversity] Awarded ${awards.length} bonuses for week ${start}..${end}`);
      if (sendNotification && awards.length > 0) {
        sendNotification({ awards, weekStart: start, weekEnd: end });
      }
    } catch (err) {
      console.error("[diversity] Weekly award failed:", err);
    }
    setTimeout(fire, msUntilNextSunday23_59ET());
  }, initialDelay);
}

// Manual re-award endpoint helper
export function reawardWeekFor(dateInWeek: string): Array<any> {
  const { start, end } = weekBoundsET(dateInWeek);
  return awardDiversityBonusesForWeek(start, end);
}

export { weekBoundsET };
