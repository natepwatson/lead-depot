// v18.3 — Challenge routes + detection sweep.

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import {
  ALL_CHALLENGES, CHALLENGE_MAP, currentDailyKey, currentWeeklyKey,
  ensureChallengeSchema, type ChallengeDef,
} from "./challenges";

// ─── STATE HELPERS ─────────────────────────────────────────────────────────

function getAcceptedSet(agentId: number, periodKey: string): Set<string> {
  const rows = rawDb.prepare(
    `SELECT challenge_key FROM challenge_accepts WHERE agent_id = ? AND period_key = ?`
  ).all(agentId, periodKey) as any[];
  return new Set(rows.map(r => r.challenge_key));
}

function getCompletionMap(agentId: number, periodKey: string): Record<string, any> {
  const rows = rawDb.prepare(
    `SELECT * FROM challenge_completions WHERE agent_id = ? AND period_key = ?`
  ).all(agentId, periodKey) as any[];
  const m: Record<string, any> = {};
  for (const r of rows) m[r.challenge_key] = r;
  return m;
}

// ─── AUTO-DETECT (rough heuristics — improves in later versions) ───────────
// We check counts in lead_activity + agent_points for the current period and
// flip completions to complete when threshold is met.
// This is a "good enough" first pass; specific event types (piggyback, sunday
// route, etc.) fall back to manual claim until we wire per-event tagging.

function computeProgressForAgent(agentId: number, periodKey: string, cadence: "daily" | "weekly"): Record<string, number> {
  // Determine time window for the period.
  let sinceISO: string;
  if (cadence === "daily") {
    const [y, m, d] = periodKey.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, d, 5, 0, 0));   // ET midnight ≈ 05:00 UTC
    sinceISO = start.toISOString();
  } else {
    // Weekly ISO: start of ISO week (Monday 00:00 ET)
    const [ystr, wstr] = periodKey.split("-W");
    const y = Number(ystr), w = Number(wstr);
    // Jan 4th is always in week 1; find Monday of week 1 then add (w-1)*7 days
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const weekStart = new Date(week1Mon);
    weekStart.setUTCDate(week1Mon.getUTCDate() + (w - 1) * 7);
    weekStart.setUTCHours(5, 0, 0, 0);
    sinceISO = weekStart.toISOString();
  }

  const progress: Record<string, number> = {};

  // Aggregated stats for this agent in this window.
  const agg: any = rawDb.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','listed','recycled') THEN 1 ELSE 0 END) as dials,
      SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
      SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kits,
      SUM(CASE WHEN outcome = 'network_referral' THEN 1 ELSE 0 END) as refs,
      SUM(CASE WHEN outcome = 'open_house_log' OR outcome = 'open_house_lead' THEN 1 ELSE 0 END) as oh,
      SUM(CASE WHEN outcome = 'door_knock' THEN 1 ELSE 0 END) as doors,
      SUM(CASE WHEN outcome = 'oh_knock_route' THEN 1 ELSE 0 END) as routes,
      SUM(CASE WHEN outcome = 'direct_mail' THEN 1 ELSE 0 END) as mail
    FROM lead_activity
    WHERE agent_id = ? AND created_at >= ?
  `).get(agentId, sinceISO);

  // Daily
  progress["daily.dial.25"]        = agg.dials || 0;
  progress["daily.dial.50"]        = agg.dials || 0;
  progress["daily.dial.100"]       = agg.dials || 0;
  progress["daily.dial.kit5"]      = agg.kits || 0;
  progress["daily.dial.appt1"]     = agg.appts || 0;
  progress["daily.oh.log1"]        = agg.oh || 0;
  progress["daily.knock.route1"]   = agg.routes || 0;
  progress["daily.knock.d25"]      = agg.doors || 0;
  progress["daily.knock.d50"]      = agg.doors || 0;
  progress["daily.net.r1"]         = agg.refs || 0;
  progress["daily.net.r2"]         = agg.refs || 0;

  // Weekly
  progress["weekly.vol.dial500"]   = agg.dials || 0;
  progress["weekly.vol.knock250"]  = agg.doors || 0;
  progress["weekly.vol.oh4"]       = agg.oh || 0;
  progress["weekly.vol.ref8"]      = agg.refs || 0;
  progress["weekly.meta.appt5"]    = agg.appts || 0;
  progress["weekly.meta.kit10"]    = agg.kits || 0;

  return progress;
}

function checkAndAwardAutoDetect(agentId: number, periodKey: string, cadence: "daily" | "weekly"): number {
  let awarded = 0;
  const progress = computeProgressForAgent(agentId, periodKey, cadence);
  const existing = getCompletionMap(agentId, periodKey);

  for (const ch of ALL_CHALLENGES) {
    if (ch.cadence !== cadence) continue;
    if (ch.gated) continue;
    if (existing[ch.key]) continue;
    const p = progress[ch.key];
    if (p == null) continue;

    // Threshold parsing from autoDetect
    const match = ch.autoDetect?.match(/:(\d+)/);
    const threshold = match ? Number(match[1]) : null;
    if (threshold == null) continue;

    if (p >= threshold) {
      try {
        rawDb.prepare(`
          INSERT INTO challenge_completions
            (agent_id, challenge_key, period_key, status, points_awarded, completed_at)
          VALUES (?, ?, ?, 'complete', ?, datetime('now'))
        `).run(agentId, ch.key, periodKey, ch.points);
        // Also credit points to agent_points ledger so leaderboard reflects it.
        rawDb.prepare(`
          INSERT INTO agent_points (agent_id, points, reason, scope, created_at)
          VALUES (?, ?, ?, 'seller', datetime('now'))
        `).run(agentId, ch.points, `challenge:${ch.key}`);
        awarded++;
      } catch (e: any) {
        // UNIQUE constraint — already completed this tick, skip.
      }
    }
  }
  return awarded;
}

export function registerChallengeRoutes(app: Express, requireAuth: any, requireAdmin: any) {
  ensureChallengeSchema();

  // GET /api/challenges — list all challenges + agent state for current period.
  app.get("/api/challenges", requireAuth, (req: any, res: Response) => {
    const agentId = req.user?.id;
    if (!agentId) return res.status(401).json({ error: "auth required" });

    const dailyKey = currentDailyKey();
    const weeklyKey = currentWeeklyKey();

    // Run auto-detect on read (cheap enough — bounded aggregate query per agent).
    try { checkAndAwardAutoDetect(agentId, dailyKey,  "daily"); } catch (e) { console.error("[challenges] daily autodetect:", e); }
    try { checkAndAwardAutoDetect(agentId, weeklyKey, "weekly"); } catch (e) { console.error("[challenges] weekly autodetect:", e); }

    const dailyAccepts  = getAcceptedSet(agentId, dailyKey);
    const weeklyAccepts = getAcceptedSet(agentId, weeklyKey);
    const dailyCompletions  = getCompletionMap(agentId, dailyKey);
    const weeklyCompletions = getCompletionMap(agentId, weeklyKey);
    const dailyProgress  = computeProgressForAgent(agentId, dailyKey, "daily");
    const weeklyProgress = computeProgressForAgent(agentId, weeklyKey, "weekly");

    const withState = (c: ChallengeDef) => {
      const accepts = c.cadence === "daily" ? dailyAccepts : weeklyAccepts;
      const completions = c.cadence === "daily" ? dailyCompletions : weeklyCompletions;
      const progressMap = c.cadence === "daily" ? dailyProgress : weeklyProgress;
      const comp = completions[c.key];
      const progress = progressMap[c.key] ?? 0;
      const threshold = c.autoDetect?.match(/:(\d+)/)?.[1];
      return {
        ...c,
        accepted: accepts.has(c.key),
        completion: comp ? {
          status: comp.status,
          pointsAwarded: comp.points_awarded,
          completedAt: comp.completed_at,
          approvedAt: comp.approved_at,
          rejectedReason: comp.rejected_reason,
        } : null,
        progress,
        threshold: threshold ? Number(threshold) : null,
      };
    };

    res.json({
      dailyKey,
      weeklyKey,
      daily:  ALL_CHALLENGES.filter(c => c.cadence === "daily").map(withState),
      weekly: ALL_CHALLENGES.filter(c => c.cadence === "weekly").map(withState),
    });
  });

  // POST /api/challenges/:key/accept — agent accepts a challenge (notify).
  app.post("/api/challenges/:key/accept", requireAuth, (req: any, res: Response) => {
    const agentId = req.user?.id;
    const key = req.params.key;
    const ch = CHALLENGE_MAP[key];
    if (!ch) return res.status(404).json({ error: "unknown challenge" });
    const periodKey = ch.cadence === "daily" ? currentDailyKey() : currentWeeklyKey();
    try {
      rawDb.prepare(`
        INSERT INTO challenge_accepts (agent_id, challenge_key, period_key)
        VALUES (?, ?, ?)
      `).run(agentId, key, periodKey);
    } catch {
      // already accepted — idempotent
    }
    res.json({ ok: true, key, periodKey });
  });

  // POST /api/challenges/:key/claim — agent claims a gated challenge with evidence.
  app.post("/api/challenges/:key/claim", requireAuth, (req: any, res: Response) => {
    const agentId = req.user?.id;
    const key = req.params.key;
    const { evidence, notes } = req.body;
    const ch = CHALLENGE_MAP[key];
    if (!ch) return res.status(404).json({ error: "unknown challenge" });
    if (!ch.gated) return res.status(400).json({ error: "not a gated challenge" });
    const periodKey = ch.cadence === "daily" ? currentDailyKey() : currentWeeklyKey();

    // Insert approval_request + link.
    const agent: any = rawDb.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId);
    const payload = JSON.stringify({ challengeKey: key, evidence: evidence || null, notes: notes || "", periodKey });
    const info = rawDb.prepare(`
      INSERT INTO approval_requests (kind, agent_id, agent_name, status, points_potential, payload_json)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(`challenge:${key}`, agentId, agent?.name || "Agent", ch.points, payload);
    const approvalId = info.lastInsertRowid;

    // Insert completion row in pending state.
    try {
      rawDb.prepare(`
        INSERT INTO challenge_completions (agent_id, challenge_key, period_key, status, approval_request_id)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(agentId, key, periodKey, approvalId);
    } catch {
      return res.status(409).json({ error: "already claimed" });
    }
    res.json({ ok: true, approvalId, status: "pending" });
  });

  // POST /api/admin/challenges/approve — admin approves a claim.
  app.post("/api/admin/challenges/approve", requireAdmin, (req: any, res: Response) => {
    const { approvalId, notes } = req.body;
    const approval: any = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) return res.status(404).json({ error: "approval not found" });
    if (approval.status !== "pending") return res.status(400).json({ error: `already ${approval.status}` });

    const payload = JSON.parse(approval.payload_json || "{}");
    const ch = CHALLENGE_MAP[payload.challengeKey];
    if (!ch) return res.status(400).json({ error: "unknown challenge key" });

    const adminId = req.user?.id;
    rawDb.prepare(`
      UPDATE approval_requests
      SET status = 'approved', decided_at = datetime('now'), decided_by = ?, decision_notes = ?, points_awarded = ?
      WHERE id = ?
    `).run(adminId, notes || null, ch.points, approvalId);

    rawDb.prepare(`
      UPDATE challenge_completions
      SET status = 'approved', points_awarded = ?, approved_by = ?, approved_at = datetime('now')
      WHERE approval_request_id = ?
    `).run(ch.points, adminId, approvalId);

    // Credit points ledger
    rawDb.prepare(`
      INSERT INTO agent_points (agent_id, points, reason, scope, created_at)
      VALUES (?, ?, ?, 'seller', datetime('now'))
    `).run(approval.agent_id, ch.points, `challenge:${payload.challengeKey}`);

    res.json({ ok: true });
  });

  // POST /api/admin/challenges/reject — admin rejects a claim.
  app.post("/api/admin/challenges/reject", requireAdmin, (req: any, res: Response) => {
    const { approvalId, reason } = req.body;
    const approval: any = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) return res.status(404).json({ error: "approval not found" });
    if (approval.status !== "pending") return res.status(400).json({ error: `already ${approval.status}` });

    const adminId = req.user?.id;
    rawDb.prepare(`
      UPDATE approval_requests
      SET status = 'rejected', decided_at = datetime('now'), decided_by = ?, decision_notes = ?
      WHERE id = ?
    `).run(adminId, reason || null, approvalId);

    rawDb.prepare(`
      UPDATE challenge_completions
      SET status = 'rejected', rejected_reason = ?
      WHERE approval_request_id = ?
    `).run(reason || null, approvalId);

    res.json({ ok: true });
  });

  console.log("[challenges] routes registered");
}
