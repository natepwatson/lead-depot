// v17.6 — DB Audit
// Read-only sweep that surfaces orphans, ledger drift, payload bloat, snapshot
// gaps, routing errors, and dead schema. Runs via admin endpoint or nightly
// Certify. Never modifies data — repair actions live in db-repair.ts.

import { rawDb } from "./db";

export interface AuditFinding {
  category: string;         // "orphan" | "ledger" | "bloat" | "routing" | "snapshot" | "schema" | "duplicate"
  severity: "critical" | "warning" | "info";
  key: string;              // stable identifier for this finding type
  count: number;            // rows/items affected
  summary: string;          // one-line human description
  sampleIds?: number[];     // up to 10 affected row ids (or null)
  meta?: Record<string, any>;
}

export interface AuditReport {
  generatedAt: string;
  durationMs: number;
  totals: { critical: number; warning: number; info: number };
  findings: AuditFinding[];
}

function safeAll(sql: string, ...params: any[]): any[] {
  try {
    return rawDb.prepare(sql).all(...params) as any[];
  } catch (err) {
    return [];
  }
}
function safeGet(sql: string, ...params: any[]): any {
  try {
    return rawDb.prepare(sql).get(...params);
  } catch (err) {
    return null;
  }
}

function tableExists(name: string): boolean {
  const row = safeGet(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name);
  return !!row;
}

function columnsOf(table: string): string[] {
  const rows = safeAll(`PRAGMA table_info(${table})`);
  return rows.map((r: any) => r.name);
}

// ─── Orphan checks ─────────────────────────────────────────────────────────
function checkOrphans(): AuditFinding[] {
  const out: AuditFinding[] = [];

  // lead_activity → leads (lead_id can be null legitimately; only flag when lead_id set but lead missing)
  if (tableExists("lead_activity") && tableExists("leads")) {
    const rows = safeAll(`
      SELECT la.id FROM lead_activity la
      LEFT JOIN leads l ON l.id = la.lead_id
      WHERE la.lead_id IS NOT NULL AND l.id IS NULL
      LIMIT 100
    `);
    if (rows.length > 0) {
      out.push({
        category: "orphan", severity: "warning",
        key: "lead_activity_missing_lead",
        count: rows.length,
        summary: `${rows.length} lead_activity rows reference a deleted lead`,
        sampleIds: rows.slice(0, 10).map((r: any) => r.id),
      });
    }
  }

  // lead_activity → agents
  if (tableExists("lead_activity") && tableExists("agents")) {
    const rows = safeAll(`
      SELECT la.id FROM lead_activity la
      LEFT JOIN agents a ON a.id = la.agent_id
      WHERE la.agent_id IS NOT NULL AND a.id IS NULL
      LIMIT 100
    `);
    if (rows.length > 0) {
      out.push({
        category: "orphan", severity: "critical",
        key: "lead_activity_missing_agent",
        count: rows.length,
        summary: `${rows.length} lead_activity rows reference a deleted agent`,
        sampleIds: rows.slice(0, 10).map((r: any) => r.id),
      });
    }
  }

  // agent_points → agents
  if (tableExists("agent_points") && tableExists("agents")) {
    const rows = safeAll(`
      SELECT ap.id FROM agent_points ap
      LEFT JOIN agents a ON a.id = ap.agent_id
      WHERE a.id IS NULL
      LIMIT 100
    `);
    if (rows.length > 0) {
      out.push({
        category: "orphan", severity: "critical",
        key: "agent_points_missing_agent",
        count: rows.length,
        summary: `${rows.length} agent_points rows reference a deleted agent`,
        sampleIds: rows.slice(0, 10).map((r: any) => r.id),
      });
    }
  }

  // approval_requests → agents
  if (tableExists("approval_requests") && tableExists("agents")) {
    const rows = safeAll(`
      SELECT ar.id FROM approval_requests ar
      LEFT JOIN agents a ON a.id = ar.agent_id
      WHERE a.id IS NULL
      LIMIT 100
    `);
    if (rows.length > 0) {
      out.push({
        category: "orphan", severity: "warning",
        key: "approval_requests_missing_agent",
        count: rows.length,
        summary: `${rows.length} approval_requests reference a deleted agent`,
        sampleIds: rows.slice(0, 10).map((r: any) => r.id),
      });
    }
  }

  // leads assigned to deactivated agents
  if (tableExists("leads") && tableExists("agents")) {
    const cols = columnsOf("leads");
    if (cols.includes("assigned_agent_id")) {
      // Fixed v20.33.3 — agents table has no `deactivated` column (that query
      // silently threw inside safeAll() and returned [], meaning this check
      // has been reporting a false "0 leads found" for an unknown period).
      // Correct column is is_active (0 = deactivated).
      const rows = safeAll(`
        SELECT l.id, l.assigned_agent_id, a.name AS agent_name FROM leads l
        JOIN agents a ON a.id = l.assigned_agent_id
        WHERE a.is_active = 0
        LIMIT 100
      `);
      if (rows.length > 0) {
        out.push({
          category: "routing", severity: "critical",
          key: "leads_owned_by_deactivated_agent",
          count: rows.length,
          summary: `${rows.length} leads still assigned to deactivated agents (should be back in pool)`,
          sampleIds: rows.slice(0, 10).map((r: any) => r.id),
          meta: { agents: [...new Set(rows.map((r: any) => r.agent_name))] },
        });
      }
    }
  }

  return out;
}

// ─── Ledger integrity ──────────────────────────────────────────────────────
function checkLedgerIntegrity(): AuditFinding[] {
  const out: AuditFinding[] = [];
  if (!tableExists("agent_points") || !tableExists("agents")) return out;

  // Any agent with negative net points?
  const neg = safeAll(`
    SELECT ap.agent_id, a.name, SUM(ap.points) AS total
    FROM agent_points ap
    JOIN agents a ON a.id = ap.agent_id
    GROUP BY ap.agent_id
    HAVING SUM(ap.points) < 0
  `);
  if (neg.length > 0) {
    out.push({
      category: "ledger", severity: "warning",
      key: "agents_with_negative_total",
      count: neg.length,
      summary: `${neg.length} agent(s) have a net-negative point balance`,
      sampleIds: neg.map((r: any) => r.agent_id),
      meta: { rows: neg },
    });
  }

  // Any agent_points row with points=0 (wasted row, no effect)
  const zero = safeGet(`SELECT COUNT(*) AS n FROM agent_points WHERE points = 0`);
  if (zero && zero.n > 0) {
    out.push({
      category: "ledger", severity: "info",
      key: "zero_point_ledger_rows",
      count: zero.n,
      summary: `${zero.n} agent_points rows have points=0 (wasteful, no effect)`,
    });
  }

  // Duplicate approval awards: approval_requests approved but no agent_points row exists
  if (tableExists("approval_requests")) {
    const missing = safeAll(`
      SELECT ar.id, ar.kind, ar.agent_id, ar.points_potential, ar.decided_at
      FROM approval_requests ar
      LEFT JOIN agent_points ap
        ON ap.agent_id = ar.agent_id
       AND ap.reason = 'approval:' || ar.kind
       AND substr(ap.created_at,1,19) = substr(ar.decided_at,1,19)
      WHERE ar.status = 'approved' AND ar.points_potential > 0 AND ap.id IS NULL
      LIMIT 100
    `);
    if (missing.length > 0) {
      out.push({
        category: "ledger", severity: "critical",
        key: "approved_but_no_points_awarded",
        count: missing.length,
        summary: `${missing.length} approved submissions never got a points ledger entry`,
        sampleIds: missing.slice(0, 10).map((r: any) => r.id),
      });
    }

    // Duplicate award: two agent_points rows for same approval decision timestamp
    const dupes = safeAll(`
      SELECT ap.agent_id, ap.reason, substr(ap.created_at,1,19) AS ts, COUNT(*) AS n
      FROM agent_points ap
      WHERE ap.reason LIKE 'approval:%'
      GROUP BY ap.agent_id, ap.reason, ts
      HAVING COUNT(*) > 1
      LIMIT 50
    `);
    if (dupes.length > 0) {
      out.push({
        category: "ledger", severity: "critical",
        key: "duplicate_approval_award",
        count: dupes.length,
        summary: `${dupes.length} distinct approvals awarded twice to the same agent`,
        meta: { rows: dupes },
      });
    }
  }

  return out;
}

// ─── Payload bloat ─────────────────────────────────────────────────────────
function checkBloat(): AuditFinding[] {
  const out: AuditFinding[] = [];
  if (!tableExists("approval_requests")) return out;

  const bigRow = safeGet(`
    SELECT COUNT(*) AS n, SUM(LENGTH(payload_json)) AS bytes
    FROM approval_requests
    WHERE LENGTH(payload_json) > 500000
  `);
  if (bigRow && bigRow.n > 0) {
    out.push({
      category: "bloat", severity: "warning",
      key: "large_approval_payloads",
      count: bigRow.n,
      summary: `${bigRow.n} approval_requests rows exceed 500KB (total ${Math.round((bigRow.bytes || 0) / 1024 / 1024)}MB)`,
      meta: { totalBytes: bigRow.bytes },
    });
  }

  const oldPhotos = safeGet(`
    SELECT COUNT(*) AS n FROM approval_requests
    WHERE status IN ('approved','rejected')
      AND decided_at < datetime('now', '-180 days')
      AND payload_json LIKE '%photoDataUrl%'
      AND LENGTH(payload_json) > 50000
  `);
  if (oldPhotos && oldPhotos.n > 0) {
    out.push({
      category: "bloat", severity: "info",
      key: "stale_evidence_photos",
      count: oldPhotos.n,
      summary: `${oldPhotos.n} decided approvals still hold photo bytes older than 180 days (candidates for pruning)`,
    });
  }
  return out;
}

// ─── Snapshot chain gaps ───────────────────────────────────────────────────
function checkSnapshotGaps(): AuditFinding[] {
  const out: AuditFinding[] = [];
  if (!tableExists("agent_daily_snapshots")) return out;

  const rows = safeAll(`SELECT DISTINCT date FROM agent_daily_snapshots ORDER BY date DESC LIMIT 60`);
  if (rows.length < 2) return out;

  const dates = rows.map((r: any) => r.date).sort();
  const first = new Date(dates[0] + "T00:00:00Z");
  const last = new Date(dates[dates.length - 1] + "T00:00:00Z");
  const expected: string[] = [];
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    expected.push(d.toISOString().slice(0, 10));
  }
  const have = new Set(dates);
  const missing = expected.filter((d) => !have.has(d));
  if (missing.length > 0) {
    out.push({
      category: "snapshot", severity: "warning",
      key: "snapshot_chain_gaps",
      count: missing.length,
      summary: `Missing ${missing.length} day(s) between ${dates[0]} and ${dates[dates.length - 1]}`,
      meta: { missing: missing.slice(0, 30) },
    });
  }
  return out;
}

// ─── Duplicate active assignments ──────────────────────────────────────────
function checkDuplicates(): AuditFinding[] {
  const out: AuditFinding[] = [];
  if (!tableExists("leads")) return out;
  const cols = columnsOf("leads");
  if (!cols.includes("assigned_agent_id")) return out;

  // Same lead assigned to multiple non-null agents? Shouldn't be possible with schema, but check.
  const dupes = safeAll(`
    SELECT id, phone, address, assigned_agent_id
    FROM leads
    WHERE phone IS NOT NULL AND phone != ''
    GROUP BY phone
    HAVING COUNT(*) > 1 AND SUM(CASE WHEN assigned_agent_id IS NOT NULL THEN 1 ELSE 0 END) > 1
    LIMIT 50
  `);
  if (dupes.length > 0) {
    out.push({
      category: "duplicate", severity: "warning",
      key: "same_phone_multiple_assigned",
      count: dupes.length,
      summary: `${dupes.length} phone numbers appear on multiple assigned leads`,
      sampleIds: dupes.slice(0, 10).map((r: any) => r.id),
    });
  }
  return out;
}

// ─── Dead / disused columns (best-effort heuristic) ────────────────────────
function checkDeadColumns(): AuditFinding[] {
  const out: AuditFinding[] = [];
  const targets = ["leads", "agents", "lead_activity"];
  for (const t of targets) {
    if (!tableExists(t)) continue;
    const cols = columnsOf(t);
    for (const c of cols) {
      // Skip id / created_at / obvious required cols
      if (["id", "created_at", "updated_at"].includes(c)) continue;
      try {
        const row = safeGet(`SELECT COUNT(*) AS n FROM ${t} WHERE "${c}" IS NOT NULL AND "${c}" != ''`);
        const total = safeGet(`SELECT COUNT(*) AS n FROM ${t}`);
        if (row && total && total.n > 20 && row.n === 0) {
          out.push({
            category: "schema", severity: "info",
            key: `dead_column:${t}.${c}`,
            count: 0,
            summary: `Column ${t}.${c} has zero non-null rows across ${total.n} records (candidate for removal)`,
            meta: { table: t, column: c, totalRows: total.n },
          });
        }
      } catch (err) { /* ignore per-column errors */ }
    }
  }
  return out;
}

// ─── Main entry ────────────────────────────────────────────────────────────
export function runFullAudit(): AuditReport {
  const started = Date.now();
  const findings: AuditFinding[] = [];
  findings.push(...checkOrphans());
  findings.push(...checkLedgerIntegrity());
  findings.push(...checkBloat());
  findings.push(...checkSnapshotGaps());
  findings.push(...checkDuplicates());
  findings.push(...checkDeadColumns());

  const totals = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) totals[f.severity]++;

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    totals,
    findings,
  };
}
