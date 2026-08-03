// server/dailySnapshots.ts — v17.5 Agent Daily Snapshots
//
// Immutable per-agent-per-ET-day metrics row. Never mutated, never deleted
// (except by explicit admin action). Purpose: any bug, dispute, or regression
// can be reconstructed exactly by reading the snapshot row for that day.
//
// Standing rule (Alex): "There should be a snapshot of all metrics each day
// and logged so you can always see who did what when and how much for
// everything even when a bug comes up."
//
// Cron: fires at 11:58 PM ET every day (2 minutes before ET midnight) so the
// day's data is frozen before the ET boundary rolls. UNIQUE(agent_id,
// snapshot_date) constraint makes re-fires idempotent.
//
// Backfill: reconstruct from lead_activity for any historical ET day that
// doesn't yet have a snapshot row. Safe to run repeatedly.

import Database from "better-sqlite3";
import { rawDb } from "./db";
import { computeAndPersistStreak } from "./streaks";

// ─── Helpers ────────────────────────────────────────────────────────────────

function etDateString(ms?: number): string {
  // Returns YYYY-MM-DD in America/New_York.
  const d = ms !== undefined ? new Date(ms) : new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

function etDayBoundsIso(dateStr: string): { startIso: string; endIso: string } {
  // Given a YYYY-MM-DD ET date, return the [start, end) UTC ISO strings
  // for that ET calendar day. Handles DST correctly.
  // The ET day starts at 00:00 America/New_York and ends at 00:00 the next day.
  //
  // Approach: build a Date interpretation of "dateStr T 00:00" in ET by
  // using UTC construction + offset correction. Robust across DST transitions.
  const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
  // Naive UTC midnight of the same date.
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Ask what UTC hour that ET wall time is at. In EDT it's UTC-4, in EST UTC-5.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(naiveUtc));
  const etHour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  // If ET hour at naiveUtc is 20 (EDT) we need +4h; if 19 (EST) we need +5h.
  // General formula: startUtc = naiveUtc + (24 - etHour) hours, mod 24.
  const shift = ((24 - etHour) % 24) * 3600 * 1000;
  const startMs = naiveUtc + shift;
  const endMs = startMs + 24 * 3600 * 1000;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

// ─── Schema init ────────────────────────────────────────────────────────────

let initialized = false;

function ensureSchema() {
  if (initialized) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,           -- 'YYYY-MM-DD' in America/New_York
      snapshot_at TEXT NOT NULL,             -- ISO UTC of when the row was written
      -- dial outcomes (day-scoped)
      dials INTEGER NOT NULL DEFAULT 0,
      appts INTEGER NOT NULL DEFAULT 0,
      kit INTEGER NOT NULL DEFAULT 0,
      recycled INTEGER NOT NULL DEFAULT 0,
      no_answer INTEGER NOT NULL DEFAULT 0,
      not_interested INTEGER NOT NULL DEFAULT 0,
      wrong_number INTEGER NOT NULL DEFAULT 0,
      callback_requested INTEGER NOT NULL DEFAULT 0,
      left_voicemail INTEGER NOT NULL DEFAULT 0,
      -- other
      emails_sent INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      referrals INTEGER NOT NULL DEFAULT 0,
      leads_pulled INTEGER NOT NULL DEFAULT 0,
      -- streak state as of the snapshot moment
      streak_current INTEGER NOT NULL DEFAULT 0,
      streak_best INTEGER NOT NULL DEFAULT 0,
      streak_tier INTEGER NOT NULL DEFAULT 0,
      -- champion state
      is_champion INTEGER NOT NULL DEFAULT 0,
      UNIQUE(agent_id, snapshot_date)
    )
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON agent_daily_snapshots(snapshot_date)`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON agent_daily_snapshots(agent_id, snapshot_date DESC)`);
  initialized = true;
  console.log("[snapshots] agent_daily_snapshots schema ready");
}

// ─── Compute a single agent's day counters ──────────────────────────────────

const DIAL_OUTCOMES = new Set([
  "contacted_appointment",
  "keep_in_touch",
  "recycled",
  "no_answer",
  "contacted_not_interested",
  "nice_not_interested",
  "wrong_number",
  "callback_requested",  // legacy
  "left_voicemail",       // legacy
]);

interface DayCounters {
  dials: number;
  appts: number;
  kit: number;
  recycled: number;
  no_answer: number;
  not_interested: number;
  wrong_number: number;
  callback_requested: number;
  left_voicemail: number;
  emails_sent: number;
  points: number;
  referrals: number;
  leads_pulled: number;
}

function computeDayCounters(agentId: number, dateStr: string): DayCounters {
  const { startIso, endIso } = etDayBoundsIso(dateStr);

  // Lead activity counts (dial outcomes + emails)
  const activityRow = rawDb.prepare(`
    SELECT
      SUM(CASE WHEN outcome IN ('contacted_appointment','keep_in_touch','recycled','no_answer','contacted_not_interested','nice_not_interested','wrong_number','callback_requested','left_voicemail') THEN 1 ELSE 0 END) AS dials,
      SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) AS appts,
      SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) AS kit,
      SUM(CASE WHEN outcome = 'recycled' THEN 1 ELSE 0 END) AS recycled,
      SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) AS no_answer,
      SUM(CASE WHEN outcome IN ('contacted_not_interested','nice_not_interested') THEN 1 ELSE 0 END) AS not_interested,
      SUM(CASE WHEN outcome = 'wrong_number' THEN 1 ELSE 0 END) AS wrong_number,
      SUM(CASE WHEN outcome = 'callback_requested' THEN 1 ELSE 0 END) AS callback_requested,
      SUM(CASE WHEN outcome = 'left_voicemail' THEN 1 ELSE 0 END) AS left_voicemail,
      SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) AS emails_sent
    FROM lead_activity
    WHERE agent_id = ? AND created_at >= ? AND created_at < ?
  `).get(agentId, startIso, endIso) as any;

  // Points earned that day (seller scope)
  const pointsRow = rawDb.prepare(`
    SELECT COALESCE(SUM(points),0) AS points
    FROM agent_points
    WHERE agent_id = ? AND scope = 'seller' AND created_at >= ? AND created_at < ?
  `).get(agentId, startIso, endIso) as any;

  // Referrals uploaded that day (network leads)
  const refRow = rawDb.prepare(`
    SELECT COUNT(*) AS n
    FROM leads
    WHERE uploaded_by = ? AND json_extract(extra_data,'$.source') = 'network'
      AND uploaded_at >= ? AND uploaded_at < ?
  `).get(agentId, startIso, endIso) as any;

  // Leads pulled that day (assignment_events)
  let leadsPulled = 0;
  try {
    const pullRow = rawDb.prepare(`
      SELECT COUNT(*) AS n FROM assignment_events
      WHERE agent_id = ? AND event_type IN ('pull','assign')
        AND created_at >= ? AND created_at < ?
    `).get(agentId, startIso, endIso) as any;
    leadsPulled = pullRow?.n || 0;
  } catch {
    // assignment_events table may not exist in all deployments — ignore.
  }

  return {
    dials: activityRow?.dials || 0,
    appts: activityRow?.appts || 0,
    kit: activityRow?.kit || 0,
    recycled: activityRow?.recycled || 0,
    no_answer: activityRow?.no_answer || 0,
    not_interested: activityRow?.not_interested || 0,
    wrong_number: activityRow?.wrong_number || 0,
    callback_requested: activityRow?.callback_requested || 0,
    left_voicemail: activityRow?.left_voicemail || 0,
    emails_sent: activityRow?.emails_sent || 0,
    points: pointsRow?.points || 0,
    referrals: refRow?.n || 0,
    leads_pulled: leadsPulled,
  };
}

// ─── Get current champion agent_id (for is_champion flag) ───────────────────

function getCurrentChampionAgentId(): number | null {
  try {
    const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = 'champion_current_month'`).get() as any;
    if (!row?.value) return null;
    const j = JSON.parse(row.value);
    return typeof j.agentId === "number" ? j.agentId : null;
  } catch {
    return null;
  }
}

// ─── Get streak state for an agent (from streaks module's persistence) ──────

function getStreakStateForSnapshot(agentId: number): { current: number; best: number; tier: number } {
  try {
    const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(`agent_streak:${agentId}`) as any;
    if (!row?.value) return { current: 0, best: 0, tier: 0 };
    const j = JSON.parse(row.value);
    const current = typeof j.current === "number" ? j.current : 0;
    const best = typeof j.best === "number" ? j.best : 0;
    // Tier boundaries mirror server/streaks.ts
    let tier = 0;
    if (current >= 60) tier = 5;
    else if (current >= 45) tier = 4;
    else if (current >= 30) tier = 3;
    else if (current >= 14) tier = 2;
    else if (current >= 7) tier = 1;
    return { current, best, tier };
  } catch {
    return { current: 0, best: 0, tier: 0 };
  }
}

// ─── Capture one snapshot row (upsert) ──────────────────────────────────────

export function captureAgentSnapshot(agentId: number, agentName: string, dateStr: string): { inserted: boolean; updated: boolean; row: any } {
  ensureSchema();
  const counters = computeDayCounters(agentId, dateStr);
  const streak = getStreakStateForSnapshot(agentId);
  const championId = getCurrentChampionAgentId();
  const isChampion = championId === agentId ? 1 : 0;
  const now = new Date().toISOString();

  // Idempotent upsert. If the row already exists for this (agent, date), we
  // UPDATE the counters — but only if this is TODAY's snapshot (still mutable).
  // Historical snapshots are locked once written.
  const todayEt = etDateString();
  const isToday = dateStr === todayEt;

  const existing = rawDb.prepare(`
    SELECT id FROM agent_daily_snapshots WHERE agent_id = ? AND snapshot_date = ?
  `).get(agentId, dateStr) as any;

  if (existing && !isToday) {
    // Historical row exists — do not overwrite. Return as-is.
    const row = rawDb.prepare(`SELECT * FROM agent_daily_snapshots WHERE id = ?`).get(existing.id);
    return { inserted: false, updated: false, row };
  }

  if (existing && isToday) {
    rawDb.prepare(`
      UPDATE agent_daily_snapshots SET
        agent_name = ?, snapshot_at = ?,
        dials = ?, appts = ?, kit = ?, recycled = ?, no_answer = ?,
        not_interested = ?, wrong_number = ?, callback_requested = ?, left_voicemail = ?,
        emails_sent = ?, points = ?, referrals = ?, leads_pulled = ?,
        streak_current = ?, streak_best = ?, streak_tier = ?,
        is_champion = ?
      WHERE id = ?
    `).run(
      agentName, now,
      counters.dials, counters.appts, counters.kit, counters.recycled, counters.no_answer,
      counters.not_interested, counters.wrong_number, counters.callback_requested, counters.left_voicemail,
      counters.emails_sent, counters.points, counters.referrals, counters.leads_pulled,
      streak.current, streak.best, streak.tier,
      isChampion,
      existing.id,
    );
    const row = rawDb.prepare(`SELECT * FROM agent_daily_snapshots WHERE id = ?`).get(existing.id);
    return { inserted: false, updated: true, row };
  }

  const info = rawDb.prepare(`
    INSERT INTO agent_daily_snapshots (
      agent_id, agent_name, snapshot_date, snapshot_at,
      dials, appts, kit, recycled, no_answer,
      not_interested, wrong_number, callback_requested, left_voicemail,
      emails_sent, points, referrals, leads_pulled,
      streak_current, streak_best, streak_tier, is_champion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agentId, agentName, dateStr, now,
    counters.dials, counters.appts, counters.kit, counters.recycled, counters.no_answer,
    counters.not_interested, counters.wrong_number, counters.callback_requested, counters.left_voicemail,
    counters.emails_sent, counters.points, counters.referrals, counters.leads_pulled,
    streak.current, streak.best, streak.tier, isChampion,
  );
  const row = rawDb.prepare(`SELECT * FROM agent_daily_snapshots WHERE id = ?`).get(info.lastInsertRowid);
  return { inserted: true, updated: false, row };
}

// ─── Capture all active agents for a given date ─────────────────────────────

export function captureAllSnapshots(dateStr?: string): { date: string; captured: number; updated: number; skipped: number; ms: number } {
  ensureSchema();
  const t0 = Date.now();
  const date = dateStr || etDateString();
  const agents = rawDb.prepare(`
    SELECT id, name FROM agents WHERE is_active = 1
  `).all() as { id: number; name: string }[];

  let captured = 0, updated = 0, skipped = 0;
  for (const a of agents) {
    try {
      const r = captureAgentSnapshot(a.id, a.name, date);
      if (r.inserted) captured++;
      else if (r.updated) updated++;
      else skipped++;
    } catch (err) {
      console.error(`[snapshots] Failed for agent ${a.id} (${a.name}):`, err);
    }
  }
  return { date, captured, updated, skipped, ms: Date.now() - t0 };
}

// ─── Backfill: reconstruct historical snapshots ─────────────────────────────

export function backfillSnapshots(fromDate: string, toDate: string): { days: number; totalRows: number; ms: number } {
  ensureSchema();
  const t0 = Date.now();
  const start = new Date(fromDate + "T12:00:00Z"); // noon UTC to avoid DST edges
  const end = new Date(toDate + "T12:00:00Z");
  if (start > end) throw new Error("fromDate must be <= toDate");

  let days = 0;
  let totalRows = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const dateStr = etDateString(cursor.getTime());
    const r = captureAllSnapshots(dateStr);
    days++;
    totalRows += r.captured + r.updated;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { days, totalRows, ms: Date.now() - t0 };
}

// ─── Query helpers ──────────────────────────────────────────────────────────

export function getSnapshotsForAgent(agentId: number, days: number = 30): any[] {
  ensureSchema();
  return rawDb.prepare(`
    SELECT * FROM agent_daily_snapshots
    WHERE agent_id = ?
    ORDER BY snapshot_date DESC
    LIMIT ?
  `).all(agentId, Math.max(1, Math.min(365, days))) as any[];
}

export function getSnapshotsFiltered(opts: { agentId?: number; from?: string; to?: string; limit?: number }): any[] {
  ensureSchema();
  const clauses: string[] = [];
  const args: any[] = [];
  if (opts.agentId !== undefined) { clauses.push("agent_id = ?"); args.push(opts.agentId); }
  if (opts.from) { clauses.push("snapshot_date >= ?"); args.push(opts.from); }
  if (opts.to)   { clauses.push("snapshot_date <= ?"); args.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(5000, opts.limit || 500));
  args.push(limit);
  return rawDb.prepare(`
    SELECT * FROM agent_daily_snapshots
    ${where}
    ORDER BY snapshot_date DESC, agent_id ASC
    LIMIT ?
  `).all(...args) as any[];
}

// ─── Scheduler: fire at 11:58 PM ET every day ───────────────────────────────

export function scheduleDailySnapshotCron() {
  ensureSchema();
  function msUntilNext11_58pmEt(): number {
    // We want 23:58 America/New_York. Same trick as monthly reset — compute
    // via projection, cap timeouts at 24 days (not needed at daily cadence
    // but the pattern is safe).
    const now = new Date();
    // Get current ET wall clock parts.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc; }, {});
    const y = parseInt(parts.year, 10);
    const m = parseInt(parts.month, 10);
    const d = parseInt(parts.day, 10);
    const H = parseInt(parts.hour, 10);
    const M = parseInt(parts.minute, 10);
    const S = parseInt(parts.second, 10);
    // Seconds until 23:58:00 today (ET).
    const nowSecInDay = H * 3600 + M * 60 + S;
    const targetSecInDay = 23 * 3600 + 58 * 60;
    let secsUntil = targetSecInDay - nowSecInDay;
    if (secsUntil <= 0) secsUntil += 24 * 3600;
    return secsUntil * 1000;
  }

  const delay = msUntilNext11_58pmEt();
  console.log(`[snapshots] Daily capture scheduled in ${Math.round(delay / 60000)} min (11:58 PM ET)`);

  setTimeout(function fire() {
    try {
      const r = captureAllSnapshots();
      console.log(`[snapshots] Daily capture: ${r.captured} new, ${r.updated} updated, ${r.skipped} locked (${r.ms}ms) for ${r.date}`);
    } catch (err) {
      console.error("[snapshots] Daily capture error:", err);
    }
    setTimeout(fire, msUntilNext11_58pmEt());
  }, delay);

  // Also capture once at boot so "today" always has at least one row.
  setTimeout(() => {
    try {
      const r = captureAllSnapshots();
      console.log(`[snapshots] Boot capture: ${r.captured} new, ${r.updated} updated for ${r.date}`);
    } catch (err) {
      console.error("[snapshots] Boot capture error:", err);
    }
  }, 8_000);
}
