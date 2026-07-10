// v14.61 — Bucket 5 Phase C — Agent audit log.
//
// Every lifecycle-affecting change to an agent (deactivate, reactivate, merge,
// email change, password reset, role change, invite/setup, etc.) gets one row
// here so admins can trace who did what, when, and what the row looked like
// before + after. Feeds Phase D's admin Agent Lifecycle tab.
//
// Storage shape (see CREATE TABLE in server/db.ts + server/storage.ts):
//   id INTEGER PK
//   ts INTEGER NOT NULL              -- unix ms
//   actor_id INTEGER                 -- who did it (null = system/boot migration)
//   target_id INTEGER NOT NULL       -- which agent row is affected
//   event TEXT NOT NULL              -- see AgentAuditEvent below
//   before_json TEXT                 -- JSON snapshot of changed fields (nullable)
//   after_json TEXT                  -- JSON snapshot of changed fields (nullable)
//   notes TEXT                       -- freeform human context (nullable)
//
// Event names are a closed set — new events must be added here AND documented.

import { rawDb } from "./db";

export type AgentAuditEvent =
  | "invite_sent"
  | "setup_completed"
  | "email_changed"
  | "email_change_requested"      // pending_email staged, verification sent
  | "email_change_verified"       // token clicked, email flipped
  | "password_reset"              // admin-initiated password reset (token email)
  | "password_changed"            // self-service password change succeeded
  | "deactivated"
  | "reactivated"
  | "merged_into"                 // source-side row: this row was merged into target
  | "merge_received"              // target-side row: another row merged into this one
  | "role_changed"
  | "fk_remap"                    // one-off data-normalization migration
  | "profile_updated";            // catch-all for name/phone/brokerage/etc.

export interface LogAgentEventArgs {
  actorId: number | null;
  targetId: number;
  event: AgentAuditEvent;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  notes?: string | null;
}

export function logAgentEvent(args: LogAgentEventArgs): void {
  try {
    rawDb.prepare(
      `INSERT INTO agent_audit_log (ts, actor_id, target_id, event, before_json, after_json, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      args.actorId,
      args.targetId,
      args.event,
      args.before ? JSON.stringify(args.before) : null,
      args.after ? JSON.stringify(args.after) : null,
      args.notes ?? null,
    );
  } catch (err) {
    // Audit failure must never block the underlying operation. Log and swallow.
    console.error("[audit] logAgentEvent failed:", err, args);
  }
}

// Fetch the full audit trail for one agent, most recent first.
// Used by GET /api/admin/agents/:id/audit-log.
export function getAgentAuditLog(agentId: number, limit = 200): Array<{
  id: number;
  ts: number;
  actor_id: number | null;
  actor_name: string | null;
  target_id: number;
  event: AgentAuditEvent;
  before: unknown;
  after: unknown;
  notes: string | null;
}> {
  const rows = rawDb.prepare(
    `SELECT l.id, l.ts, l.actor_id, l.target_id, l.event, l.before_json, l.after_json, l.notes,
            a.name as actor_name
     FROM agent_audit_log l
     LEFT JOIN agents a ON a.id = l.actor_id
     WHERE l.target_id = ?
     ORDER BY l.ts DESC
     LIMIT ?`
  ).all(agentId, limit) as any[];
  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    actor_id: r.actor_id,
    actor_name: r.actor_name,
    target_id: r.target_id,
    event: r.event as AgentAuditEvent,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after:  r.after_json  ? JSON.parse(r.after_json)  : null,
    notes:  r.notes,
  }));
}

// Deactivate reversibility window — 7 days. After this, the row is read-only.
// Called from the reactivate endpoint to reject stale undos.
export const REACTIVATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isWithinReactivateWindow(deactivatedAt: number | null | undefined): boolean {
  if (!deactivatedAt) return true; // never deactivated or legacy row — allow
  return (Date.now() - deactivatedAt) <= REACTIVATE_WINDOW_MS;
}
