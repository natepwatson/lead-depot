// v18.3 — Challenge routes + detection sweep.
//
// Guard style matches the rest of routes.ts: requireSession / requireAdmin
// are called INSIDE the handler and return boolean. `req.currentAgent` is the
// authenticated agent record set by attachCurrentAgent middleware.

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { requireSession, requireAdmin } from "./auth";
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

// ─── AUTO-DETECT ───────────────────────────────────────────────────────────
// Detection reads counts from lead_activity for this agent in this period,
// then flips non-gated completions whose threshold is met and credits points.

function computeProgressForAgent(agentId: number, periodKey: string, cadence: "daily" | "weekly"): Record<string, number> {
  let sinceISO: string;
  if (cadence === "daily") {
    const [y, m, d] = periodKey.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // ET midnight ≈ 05:00 UTC
    sinceISO = start.toISOString();
  } else {
    const [ystr, wstr] = periodKey.split("-W");
    const y = Number(ystr), w = Number(wstr);
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

  let agg: any;
  try {
    agg = rawDb.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled','retired_no_answer','manual_credit') THEN 1 ELSE 0 END) as dials,
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
  } catch {
    agg = { total: 0, dials: 0, appts: 0, kits: 0, refs: 0, oh: 0, doors: 0, routes: 0, mail: 0 };
  }

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

  progress["weekly.vol.dial500"]   = agg.dials || 0;
  progress["weekly.vol.knock250"]  = agg.doors || 0;
  progress["weekly.vol.oh4"]       = agg.oh || 0;
  progress["weekly.vol.ref8"]      = agg.refs || 0;
  progress["weekly.meta.appt5"]    = agg.appts || 0;
  progress["weekly.meta.kit10"]    = agg.kits || 0;

  return progress;
}

export function checkAndAwardAutoDetect(agentId: number, periodKey: string, cadence: "daily" | "weekly"): number {
  let awarded = 0;
  const progress = computeProgressForAgent(agentId, periodKey, cadence);
  const existing = getCompletionMap(agentId, periodKey);

  for (const ch of ALL_CHALLENGES) {
    if (ch.cadence !== cadence) continue;
    if (ch.gated) continue;
    if (existing[ch.key]) continue;
    const p = progress[ch.key];
    if (p == null) continue;

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
        rawDb.prepare(`
          INSERT INTO agent_points (agent_id, points, reason, scope, created_at)
          VALUES (?, ?, ?, 'seller', datetime('now'))
        `).run(agentId, ch.points, `challenge:${ch.key}`);
        // v20.7.2 — unpin from active-challenges (Option C: auto-clear slot).
        try {
          rawDb.prepare(
            `DELETE FROM challenge_accepts WHERE agent_id = ? AND challenge_key = ? AND period_key = ?`
          ).run(agentId, ch.key, periodKey);
        } catch {}
        awarded++;
      } catch {
        // UNIQUE violation — already awarded this tick.
      }
    }
  }
  return awarded;
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

export function registerChallengeRoutes(app: Express) {
  ensureChallengeSchema();

  // GET /api/challenges — list + agent state for current period.
  app.get("/api/challenges", (req: Request, res: Response) => {
    if (!requireSession(req, res)) return;
    const agentId = (req as any).currentAgent!.id;

    const dailyKey = currentDailyKey();
    const weeklyKey = currentWeeklyKey();

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

  // v20.7.2 — GET /api/challenges/active. Returns the agent's pinned challenges
  // for the current daily + weekly period, with progress + threshold, so the
  // Home tab card can render the 3+2 slot grid without pulling the full 62-row
  // catalog. Also auto-runs detection so completed pins don't linger on the card.
  app.get("/api/challenges/active", (req: Request, res: Response) => {
    if (!requireSession(req, res)) return;
    const agentId = (req as any).currentAgent!.id;
    const dailyKey = currentDailyKey();
    const weeklyKey = currentWeeklyKey();

    try { checkAndAwardAutoDetect(agentId, dailyKey,  "daily"); } catch {}
    try { checkAndAwardAutoDetect(agentId, weeklyKey, "weekly"); } catch {}

    const dailyAccepts  = getAcceptedSet(agentId, dailyKey);
    const weeklyAccepts = getAcceptedSet(agentId, weeklyKey);
    const dailyCompletions  = getCompletionMap(agentId, dailyKey);
    const weeklyCompletions = getCompletionMap(agentId, weeklyKey);
    const dailyProgress  = computeProgressForAgent(agentId, dailyKey, "daily");
    const weeklyProgress = computeProgressForAgent(agentId, weeklyKey, "weekly");

    // Auto-clear rule: if a pin is already completed for this period, drop the
    // accept so the slot frees immediately (Alex's Option C: no lingering trophy).
    const dropStmt = rawDb.prepare(`DELETE FROM challenge_accepts WHERE agent_id = ? AND challenge_key = ? AND period_key = ?`);
    for (const k of Array.from(dailyAccepts)) {
      const c = dailyCompletions[k];
      if (c && (c.status === "complete" || c.status === "approved")) {
        try { dropStmt.run(agentId, k, dailyKey); } catch {}
        dailyAccepts.delete(k);
      }
    }
    for (const k of Array.from(weeklyAccepts)) {
      const c = weeklyCompletions[k];
      if (c && (c.status === "complete" || c.status === "approved")) {
        try { dropStmt.run(agentId, k, weeklyKey); } catch {}
        weeklyAccepts.delete(k);
      }
    }

    const shape = (k: string, cadence: "daily" | "weekly") => {
      const ch = CHALLENGE_MAP[k];
      if (!ch) return null;
      const progressMap = cadence === "daily" ? dailyProgress : weeklyProgress;
      const progress = progressMap[k] ?? 0;
      const threshold = ch.autoDetect?.match(/:(\d+)/)?.[1];
      return {
        key: ch.key,
        cadence: ch.cadence,
        leg: ch.leg,
        tier: ch.tier,
        points: ch.points,
        label: ch.label,
        detail: ch.detail,
        gated: ch.gated,
        progress,
        threshold: threshold ? Number(threshold) : null,
      };
    };

    res.json({
      dailyKey,
      weeklyKey,
      dailySlots:  { max: 3, filled: Array.from(dailyAccepts).map(k => shape(k, "daily")).filter(Boolean) },
      weeklySlots: { max: 2, filled: Array.from(weeklyAccepts).map(k => shape(k, "weekly")).filter(Boolean) },
    });
  });

  // POST /api/challenges/:key/accept. v20.7.2 enforces slot caps:
  // max 3 daily pins per period + max 2 weekly pins per period. Already-completed
  // challenges cannot be re-pinned.
  app.post("/api/challenges/:key/accept", (req: Request, res: Response) => {
    if (!requireSession(req, res)) return;
    const agentId = (req as any).currentAgent!.id;
    const key = String(req.params.key);
    const ch = CHALLENGE_MAP[key];
    if (!ch) return res.status(404).json({ error: "unknown challenge" });
    const periodKey = ch.cadence === "daily" ? currentDailyKey() : currentWeeklyKey();

    // v20.7.2 — reject if already completed this period.
    const existing: any = rawDb.prepare(
      `SELECT status FROM challenge_completions WHERE agent_id = ? AND challenge_key = ? AND period_key = ?`
    ).get(agentId, key, periodKey);
    if (existing && (existing.status === "complete" || existing.status === "approved")) {
      return res.status(409).json({ error: "already completed for this period" });
    }

    // v20.7.2 — slot cap: 3 daily / 2 weekly. Idempotent for the same key.
    const alreadyPinned: any = rawDb.prepare(
      `SELECT id FROM challenge_accepts WHERE agent_id = ? AND challenge_key = ? AND period_key = ?`
    ).get(agentId, key, periodKey);
    if (!alreadyPinned) {
      const currentCount: any = rawDb.prepare(`
        SELECT COUNT(*) as n FROM challenge_accepts ca
        JOIN (SELECT ? as pk) p ON 1=1
        WHERE ca.agent_id = ? AND ca.period_key = p.pk
      `).get(periodKey, agentId);
      const cap = ch.cadence === "daily" ? 3 : 2;
      if ((currentCount?.n ?? 0) >= cap) {
        return res.status(409).json({ error: `slot limit reached (${cap} ${ch.cadence})`, cap, cadence: ch.cadence });
      }
    }

    try {
      rawDb.prepare(`
        INSERT INTO challenge_accepts (agent_id, challenge_key, period_key)
        VALUES (?, ?, ?)
      `).run(agentId, key, periodKey);
    } catch { /* idempotent */ }
    res.json({ ok: true, key, periodKey });
  });

  // v20.7.2 — DELETE /api/challenges/:key/accept. Agent can unpin a challenge
  // to free a slot for something else (as long as it's not already completed).
  app.delete("/api/challenges/:key/accept", (req: Request, res: Response) => {
    if (!requireSession(req, res)) return;
    const agentId = (req as any).currentAgent!.id;
    const key = String(req.params.key);
    const ch = CHALLENGE_MAP[key];
    if (!ch) return res.status(404).json({ error: "unknown challenge" });
    const periodKey = ch.cadence === "daily" ? currentDailyKey() : currentWeeklyKey();
    try {
      rawDb.prepare(
        `DELETE FROM challenge_accepts WHERE agent_id = ? AND challenge_key = ? AND period_key = ?`
      ).run(agentId, key, periodKey);
    } catch {}
    res.json({ ok: true, key, periodKey, unpinned: true });
  });

  // POST /api/challenges/:key/claim — gated challenges only
  app.post("/api/challenges/:key/claim", (req: Request, res: Response) => {
    if (!requireSession(req, res)) return;
    const agent = (req as any).currentAgent!;
    const key = String(req.params.key);
    const { evidence, notes } = req.body || {};
    const ch = CHALLENGE_MAP[key];
    if (!ch) return res.status(404).json({ error: "unknown challenge" });
    if (!ch.gated) return res.status(400).json({ error: "not a gated challenge" });
    const periodKey = ch.cadence === "daily" ? currentDailyKey() : currentWeeklyKey();

    const payload = JSON.stringify({ challengeKey: key, evidence: evidence || null, notes: notes || "", periodKey });
    const info = rawDb.prepare(`
      INSERT INTO approval_requests (kind, agent_id, agent_name, status, points_potential, payload_json)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(`challenge:${key}`, agent.id, agent.name || "Agent", ch.points, payload);
    const approvalId = info.lastInsertRowid;

    try {
      rawDb.prepare(`
        INSERT INTO challenge_completions (agent_id, challenge_key, period_key, status, approval_request_id)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(agent.id, key, periodKey, approvalId);
    } catch {
      return res.status(409).json({ error: "already claimed" });
    }
    res.json({ ok: true, approvalId, status: "pending" });
  });

  // POST /api/admin/challenges/approve
  app.post("/api/admin/challenges/approve", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const admin = (req as any).currentAgent!;
    const { approvalId, notes } = req.body || {};
    const approval: any = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) return res.status(404).json({ error: "approval not found" });
    if (approval.status !== "pending") return res.status(400).json({ error: `already ${approval.status}` });

    const payload = JSON.parse(approval.payload_json || "{}");
    const ch = CHALLENGE_MAP[payload.challengeKey];
    if (!ch) return res.status(400).json({ error: "unknown challenge key" });

    rawDb.prepare(`
      UPDATE approval_requests
      SET status = 'approved', decided_at = datetime('now'), decided_by = ?, decision_notes = ?, points_awarded = ?
      WHERE id = ?
    `).run(admin.id, notes || null, ch.points, approvalId);

    rawDb.prepare(`
      UPDATE challenge_completions
      SET status = 'approved', points_awarded = ?, approved_by = ?, approved_at = datetime('now')
      WHERE approval_request_id = ?
    `).run(ch.points, admin.id, approvalId);

    rawDb.prepare(`
      INSERT INTO agent_points (agent_id, points, reason, scope, created_at)
      VALUES (?, ?, ?, 'seller', datetime('now'))
    `).run(approval.agent_id, ch.points, `challenge:${payload.challengeKey}`);

    res.json({ ok: true });
  });

  // POST /api/admin/challenges/reject
  app.post("/api/admin/challenges/reject", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const admin = (req as any).currentAgent!;
    const { approvalId, reason } = req.body || {};
    const approval: any = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) return res.status(404).json({ error: "approval not found" });
    if (approval.status !== "pending") return res.status(400).json({ error: `already ${approval.status}` });

    rawDb.prepare(`
      UPDATE approval_requests
      SET status = 'rejected', decided_at = datetime('now'), decided_by = ?, decision_notes = ?
      WHERE id = ?
    `).run(admin.id, reason || null, approvalId);

    rawDb.prepare(`
      UPDATE challenge_completions
      SET status = 'rejected', rejected_reason = ?
      WHERE approval_request_id = ?
    `).run(reason || null, approvalId);

    res.json({ ok: true });
  });

  console.log("[challenges] routes registered — 37 daily + 25 weekly");
}
