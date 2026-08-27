// v17.6 — DB Repair
// All operations default to dryRun. Nothing writes unless dryRun=false.
// Every write is journaled to db_repair_log so Nate/Alex can audit.

import { rawDb } from "./db";

export function ensureRepairLogSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS db_repair_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      actor_agent_id INTEGER,
      actor_name TEXT,
      dry_run INTEGER NOT NULL DEFAULT 1,
      rows_affected INTEGER NOT NULL DEFAULT 0,
      details_json TEXT,
      ran_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repair_op ON db_repair_log(operation, ran_at DESC);
  `);
}

function logRepair(op: string, actor: { id?: number; name?: string } | null, dryRun: boolean, rowsAffected: number, details: any) {
  ensureRepairLogSchema();
  rawDb.prepare(`
    INSERT INTO db_repair_log (operation, actor_agent_id, actor_name, dry_run, rows_affected, details_json, ran_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(op, actor?.id || null, actor?.name || null, dryRun ? 1 : 0, rowsAffected, JSON.stringify(details), new Date().toISOString());
}

// ─── Recompute points for one agent (or all) ───────────────────────────────
// Walks lead_activity + approved approval_requests + diversity_bonuses to
// rebuild the expected point balance. Compares to current agent_points sum.
// If dryRun=false and drift detected, writes a corrective agent_points row
// (never rewrites history — always appends a delta with reason='repair:recompute').
export interface RecomputeResult {
  agentId: number;
  agentName: string;
  currentTotal: number;
  computedTotal: number;
  delta: number;
  correctionInserted: boolean;
}

// Points dictionary must mirror the one in routes.ts. Kept in sync manually.
const POINTS: Record<string, number> = {
  appt_set: 60,
  keep_in_touch: 15,
  network_referral: 20,
  open_house_lead: 20,
  contacted_not_interested: 5,
  listed: 3,
  recycled: 2,
  owner_no_answer: 6,
  no_answer: 2,
  not_interested: 5,
  wrong_number: 1,
  disconnected: 1,
};
// FLAT (no prime multiplier) — must match routes.ts
const FLAT: Set<string> = new Set([
  "network_referral",
  "open_house_log",
  "oh_knock_route",
  "direct_mail",
  "door_knock",
  "social_post",
]);

// Prime hours in ET (weekday, hour): if hour ∈ primeHours(dow) then × 2
// We don't have access to the config table here; use the standard research-driven set.
// If Prime schedule changes, sync from client/src/lib/primeTime.ts.
function isPrimeET(iso: string): boolean {
  // Convert UTC iso to America/New_York wall clock
  try {
    const d = new Date(iso);
    const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dow = et.getDay(); // 0=Sun..6=Sat
    const hr = et.getHours();
    // Approximate Prime windows (dial-only categories):
    //   Mon-Fri: 8-11am + 4-7pm
    //   Sat:     9am-12pm
    //   Sun:     4-7pm
    if (dow >= 1 && dow <= 5) return (hr >= 8 && hr < 11) || (hr >= 16 && hr < 19);
    if (dow === 6) return hr >= 9 && hr < 12;
    if (dow === 0) return hr >= 16 && hr < 19;
  } catch (_) { /* fallthrough */ }
  return false;
}

export function recomputePointsForAgent(agentId: number, dryRun: boolean, actor: any): RecomputeResult {
  const a = rawDb.prepare(`SELECT id, name FROM agents WHERE id = ?`).get(agentId) as any;
  if (!a) throw new Error("agent_not_found");

  const currentRow = rawDb.prepare(`SELECT COALESCE(SUM(points),0) AS total FROM agent_points WHERE agent_id = ?`).get(agentId) as any;
  const currentTotal = Number(currentRow?.total || 0);

  // 1. Dial outcomes from lead_activity
  const activities = rawDb.prepare(`
    SELECT outcome, created_at FROM lead_activity WHERE agent_id = ?
  `).all(agentId) as any[];
  let dialPoints = 0;
  for (const row of activities) {
    const base = POINTS[row.outcome];
    if (!base) continue;
    if (FLAT.has(row.outcome)) {
      dialPoints += base;
    } else {
      dialPoints += isPrimeET(row.created_at) ? base * 2 : base;
    }
  }

  // 2. Approved evidence submissions — use points_potential directly (matches approve endpoint)
  const approvedRow = rawDb.prepare(`
    SELECT COALESCE(SUM(points_potential),0) AS total FROM approval_requests
    WHERE agent_id = ? AND status = 'approved'
  `).get(agentId) as any;
  const approvedPoints = Number(approvedRow?.total || 0);

  // 3. Diversity bonuses
  let diversityPoints = 0;
  try {
    const divRow = rawDb.prepare(`
      SELECT COALESCE(SUM(points_awarded),0) AS total FROM diversity_bonuses WHERE agent_id = ?
    `).get(agentId) as any;
    diversityPoints = Number(divRow?.total || 0);
  } catch (_) { /* diversity table may not exist yet */ }

  // 4. Repair corrections themselves (they've already been added to the ledger, count them
  // so recompute is idempotent — if we already applied a correction, delta will be 0 next run)
  const repairRow = rawDb.prepare(`
    SELECT COALESCE(SUM(points),0) AS total FROM agent_points
    WHERE agent_id = ? AND reason LIKE 'repair:%'
  `).get(agentId) as any;
  const repairPoints = Number(repairRow?.total || 0);

  const computedTotal = dialPoints + approvedPoints + diversityPoints + repairPoints;
  const delta = computedTotal - currentTotal;

  let correctionInserted = false;
  if (!dryRun && delta !== 0) {
    rawDb.prepare(`
      INSERT INTO agent_points (agent_id, points, reason, created_at)
      VALUES (?, ?, 'repair:recompute', ?)
    `).run(agentId, delta, new Date().toISOString());
    correctionInserted = true;
  }

  logRepair("recompute_points_agent", actor, dryRun, correctionInserted ? 1 : 0, {
    agentId, agentName: a.name, currentTotal, computedTotal, delta,
    breakdown: { dialPoints, approvedPoints, diversityPoints, repairPoints },
  });

  return {
    agentId,
    agentName: a.name,
    currentTotal,
    computedTotal,
    delta,
    correctionInserted,
  };
}

export function recomputePointsForAll(dryRun: boolean, actor: any): RecomputeResult[] {
  // Fixed v20.33.3 — agents table has no `deactivated` column (that query threw
  // "no such column: deactivated" and silently broke the whole ledger-repair tool).
  // Correct column is `is_active` (see server/db.ts deactivate/reactivate flows).
  const agents = rawDb.prepare(`SELECT id FROM agents WHERE is_active = 1`).all() as any[];
  const out: RecomputeResult[] = [];
  for (const a of agents) {
    try {
      out.push(recomputePointsForAgent(a.id, dryRun, actor));
    } catch (err: any) {
      out.push({ agentId: a.id, agentName: "?", currentTotal: 0, computedTotal: 0, delta: 0, correctionInserted: false } as any);
    }
  }
  return out;
}

// ─── Prune stale evidence photos ───────────────────────────────────────────
// Strips photoDataUrl from decided approval_requests older than olderThanDays.
// Preserves the row and all metadata — only removes the base64 blob.
export interface PruneResult {
  candidates: number;
  bytesFreed: number;
  pruned: number;
}

export function pruneStaleEvidence(olderThanDays: number, dryRun: boolean, actor: any): PruneResult {
  const cutoff = `datetime('now', '-${olderThanDays} days')`;
  const candidates = rawDb.prepare(`
    SELECT id, LENGTH(payload_json) AS bytes FROM approval_requests
    WHERE status IN ('approved','rejected')
      AND decided_at < ${cutoff}
      AND payload_json LIKE '%photoDataUrl%'
      AND LENGTH(payload_json) > 50000
  `).all() as any[];

  let bytesFreed = 0;
  let pruned = 0;
  if (!dryRun) {
    const updateStmt = rawDb.prepare(`UPDATE approval_requests SET payload_json = ? WHERE id = ?`);
    for (const c of candidates) {
      try {
        const row = rawDb.prepare(`SELECT payload_json FROM approval_requests WHERE id = ?`).get(c.id) as any;
        if (!row?.payload_json) continue;
        const obj = JSON.parse(row.payload_json);
        const before = row.payload_json.length;
        delete obj.photoDataUrl;
        obj._pruned = { at: new Date().toISOString(), reason: `>${olderThanDays}d` };
        const next = JSON.stringify(obj);
        updateStmt.run(next, c.id);
        bytesFreed += (before - next.length);
        pruned++;
      } catch (_) { /* skip malformed rows */ }
    }
  } else {
    bytesFreed = candidates.reduce((sum, c) => sum + (c.bytes || 0), 0);
  }

  logRepair("prune_stale_evidence", actor, dryRun, pruned, { candidates: candidates.length, bytesFreed, olderThanDays });
  return { candidates: candidates.length, bytesFreed, pruned };
}

// ─── Reassign leads owned by deactivated agents ────────────────────────────
export interface ReassignResult {
  found: number;
  reassigned: number;
  sample: Array<{ leadId: number; from: string }>;
}

export function reassignLeadsFromDeactivated(dryRun: boolean, actor: any): ReassignResult {
  // Fixed v20.33.3 — agents table has no `deactivated` column (that query
  // threw "no such column: deactivated" and made this repair tool 100%
  // non-functional — same class of bug found in recomputePointsForAll() and
  // db-audit.ts's leads_owned_by_deactivated_agent check). Correct column is
  // is_active (0 = deactivated).
  const rows = rawDb.prepare(`
    SELECT l.id AS lead_id, a.name AS agent_name, l.assigned_agent_id
    FROM leads l
    JOIN agents a ON a.id = l.assigned_agent_id
    WHERE a.is_active = 0
  `).all() as any[];

  let reassigned = 0;
  if (!dryRun && rows.length > 0) {
    const nullify = rawDb.prepare(`UPDATE leads SET assigned_agent_id = NULL WHERE id = ?`);
    const txn = rawDb.transaction(() => {
      for (const r of rows) {
        nullify.run(r.lead_id);
        reassigned++;
      }
    });
    txn();
  }
  logRepair("reassign_deactivated_leads", actor, dryRun, reassigned, {
    found: rows.length,
    sample: rows.slice(0, 20).map((r) => ({ leadId: r.lead_id, from: r.agent_name })),
  });
  return {
    found: rows.length,
    reassigned,
    sample: rows.slice(0, 20).map((r) => ({ leadId: r.lead_id, from: r.agent_name })),
  };
}

// ─── Fill missing snapshot gaps (delegates to dailySnapshots.backfillSnapshots) ──
// Alias for symmetry — actual work is in dailySnapshots.ts.
export function repairSnapshotGaps(from: string, to: string, dryRun: boolean, actor: any) {
  if (dryRun) {
    // Just enumerate what would be filled
    const rows = rawDb.prepare(`
      SELECT DISTINCT date FROM agent_daily_snapshots WHERE date BETWEEN ? AND ?
    `).all(from, to) as any[];
    const have = new Set(rows.map((r: any) => r.date));
    const missing: string[] = [];
    const start = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (!have.has(iso)) missing.push(iso);
    }
    logRepair("repair_snapshot_gaps", actor, true, 0, { from, to, missing });
    return { dryRun: true, from, to, missing };
  }
  // For actual repair, caller invokes backfillSnapshots directly from dailySnapshots.
  throw new Error("Call backfillSnapshots directly for non-dry-run snapshot repair");
}

// ─── Recent repair history ─────────────────────────────────────────────────
// — v20.32.1 — Dedupe Listing Consult scope/gallery photo duplication —
// Bug: scope-bucket uploads were previously written into BOTH scope_photos
// AND gallery_photos (Walk-Through Photos), so every Scope Photo appeared
// duplicated under Walk-Through. Fixed going forward in listingConsult.ts;
// this repairs already-affected rows by removing, from gallery_photos, any
// URL that also appears in scope_photos. scope_photos is left untouched.
export interface DedupeListingPhotosResult {
  consultId: number;
  propertyAddress: string;
  before: number;
  after: number;
  removed: number;
}

export function dedupeListingConsultPhotos(consultId: number | null, dryRun: boolean, actor: any): { dryRun: boolean; results: DedupeListingPhotosResult[] } {
  const rows = consultId
    ? rawDb.prepare(`SELECT id, property_address, gallery_photos, scope_photos FROM listing_consults WHERE id = ?`).all(consultId) as any[]
    : rawDb.prepare(`SELECT id, property_address, gallery_photos, scope_photos FROM listing_consults WHERE scope_photos IS NOT NULL AND scope_photos != '[]'`).all() as any[];

  const results: DedupeListingPhotosResult[] = [];
  for (const row of rows) {
    let gallery: string[] = [];
    let scope: string[] = [];
    try { gallery = row.gallery_photos ? JSON.parse(row.gallery_photos) : []; } catch { gallery = []; }
    try { scope = row.scope_photos ? JSON.parse(row.scope_photos) : []; } catch { scope = []; }
    if (!gallery.length || !scope.length) continue;
    const scopeSet = new Set(scope);
    const cleaned = gallery.filter((url: string) => !scopeSet.has(url));
    const removed = gallery.length - cleaned.length;
    if (removed === 0) continue;
    results.push({ consultId: row.id, propertyAddress: row.property_address, before: gallery.length, after: cleaned.length, removed });
    if (!dryRun) {
      rawDb.prepare(`UPDATE listing_consults SET gallery_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(cleaned), row.id);
    }
  }
  logRepair("dedupe_listing_consult_photos", actor, dryRun, results.reduce((s, r) => s + r.removed, 0), { consultId, results });
  return { dryRun, results };
}

export function listRepairLog(limit = 100) {
  ensureRepairLogSchema();
  return rawDb.prepare(`
    SELECT * FROM db_repair_log ORDER BY ran_at DESC LIMIT ?
  `).all(limit);
}
