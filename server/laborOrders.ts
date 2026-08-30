// v20.41.0 — Labor Calculator: Phase 2 of the Scheduler/Labor/Calendar build.
// Per-job labor plan built from the job's ACTUAL in-house scope (distinct
// `trade` values on repair_consult_items where category = 'in_house' —
// vendor-category items are subcontracted out and never need an in-house
// crew, so they never generate a tab here). One tab per trade; each tab is
// saved independently (assign 1+ approved laborers + estimated hours), and
// the whole order can only be "Approved" once every trade tab present in
// scope has been saved with at least one assignment.
//
// Rate handling: `hourly_rate_snapshot` on each assignment captures the
// laborer's rate at the moment the tab was saved, so editing a laborer's
// rate later (roster maintenance) never silently changes an already-typed
// job estimate. Phase 3 will add its own `approved_cost` snapshot at the
// order level for P&L — this file only owns the draft/approve mechanics.
import type { Express, Response } from "express";
import { rawDb } from "./db";

export function ensureLaborOrdersSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS labor_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL UNIQUE REFERENCES repair_consults(id),
      status TEXT NOT NULL DEFAULT 'draft',   -- draft | approved
      approved_at TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labor_order_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labor_order_id INTEGER NOT NULL REFERENCES labor_orders(id),
      trade TEXT NOT NULL,
      saved INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(labor_order_id, trade)
    );

    CREATE TABLE IF NOT EXISTS labor_order_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labor_order_trade_id INTEGER NOT NULL REFERENCES labor_order_trades(id),
      laborer_id INTEGER NOT NULL REFERENCES laborers(id),
      estimated_hours REAL NOT NULL DEFAULT 0,
      hourly_rate_snapshot REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_labor_order_trades_order ON labor_order_trades(labor_order_id);
    CREATE INDEX IF NOT EXISTS idx_labor_order_assignments_trade ON labor_order_assignments(labor_order_trade_id);
    CREATE INDEX IF NOT EXISTS idx_labor_order_assignments_laborer ON labor_order_assignments(laborer_id);
  `);
}

function getOrCreateLaborOrder(consultId: number): { id: number; status: string; approved_at: string | null; approved_by: string | null } {
  let order = rawDb.prepare(`SELECT * FROM labor_orders WHERE consult_id = ?`).get(consultId) as any;
  if (!order) {
    const result = rawDb.prepare(`INSERT INTO labor_orders (consult_id) VALUES (?)`).run(consultId);
    order = rawDb.prepare(`SELECT * FROM labor_orders WHERE id = ?`).get(result.lastInsertRowid);
  }
  return order;
}

// Distinct in-house trades actually present on this job's scope — the
// authoritative tab list. Vendor-category items never appear here.
function scopeTradesForConsult(consultId: number): string[] {
  const rows = rawDb.prepare(`
    SELECT DISTINCT trade FROM repair_consult_items
    WHERE consult_id = ? AND category = 'in_house'
    ORDER BY trade ASC
  `).all(consultId) as any[];
  return rows.map(r => r.trade);
}

export function registerLaborOrdersRoutes(app: Express) {
  ensureLaborOrdersSchema();

  // ── Get (or lazily create) the labor order for a job, with every scope
  // trade as a tab — including tabs that were saved earlier but whose trade
  // has since dropped out of scope (kept visible so nothing silently
  // disappears; flagged via `inScope: false`) ──
  app.get("/api/admin/repair-consult/:id/labor-order", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id, property_address FROM repair_consults WHERE id = ?`).get(consultId) as any;
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    const scopeTrades = scopeTradesForConsult(consultId);

    const savedTradeRows = rawDb.prepare(`SELECT * FROM labor_order_trades WHERE labor_order_id = ?`).all(order.id) as any[];
    const savedByTrade = new Map(savedTradeRows.map(t => [t.trade, t]));

    const allTradeKeys = Array.from(new Set([...scopeTrades, ...savedTradeRows.map(t => t.trade)]));

    const trades = allTradeKeys.map(trade => {
      const row = savedByTrade.get(trade);
      const assignments = row
        ? (rawDb.prepare(`
            SELECT loa.id, loa.laborer_id, loa.estimated_hours, loa.hourly_rate_snapshot,
                   l.name AS laborer_name, l.tier AS laborer_tier, l.active AS laborer_active
            FROM labor_order_assignments loa
            JOIN laborers l ON l.id = loa.laborer_id
            WHERE loa.labor_order_trade_id = ?
            ORDER BY loa.id ASC
          `).all(row.id) as any[])
        : [];
      return {
        trade,
        inScope: scopeTrades.includes(trade),
        saved: !!row?.saved,
        notes: row?.notes || null,
        laborOrderTradeId: row?.id || null,
        assignments,
      };
    }).sort((a, b) => a.trade.localeCompare(b.trade));

    const allTabsSaved = trades.filter(t => t.inScope).every(t => t.saved && t.assignments.length > 0);

    // Eligible laborers for the assignment dropdown — approved + active only.
    const laborers = rawDb.prepare(`SELECT id, name, tier, hourly_rate, trades FROM laborers WHERE approved = 1 AND active = 1 ORDER BY name ASC`).all();

    res.json({
      laborOrder: { id: order.id, status: order.status, approvedAt: order.approved_at, approvedBy: order.approved_by },
      propertyAddress: consult.property_address,
      trades,
      allTabsSaved,
      laborers,
    });
  });

  // ── Save one trade tab (replaces its assignment list wholesale) ──
  app.post("/api/admin/repair-consult/:id/labor-order/trades/:trade", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const trade = String(req.params.trade);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status === "approved") return res.status(400).json({ error: "Labor order is already approved — trades can no longer be edited here." });

    const assignments: Array<{ laborerId: number; estimatedHours: number }> = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    const notes: string | null = req.body?.notes || null;
    if (assignments.length === 0) return res.status(400).json({ error: "At least one laborer assignment is required to save this trade." });
    for (const a of assignments) {
      if (!a.laborerId || typeof a.estimatedHours !== "number" || a.estimatedHours <= 0) {
        return res.status(400).json({ error: "Each assignment needs a laborer and hours greater than 0." });
      }
    }

    const laborerIds = assignments.map(a => a.laborerId);
    const found = rawDb.prepare(`SELECT id, hourly_rate FROM laborers WHERE id IN (${laborerIds.map(() => "?").join(",")}) AND approved = 1 AND active = 1`).all(...laborerIds) as any[];
    if (found.length !== new Set(laborerIds).size) {
      return res.status(400).json({ error: "One or more selected laborers is not an approved/active roster member." });
    }
    const rateById = new Map(found.map(l => [l.id, l.hourly_rate]));

    const tx = rawDb.transaction(() => {
      rawDb.prepare(`
        INSERT INTO labor_order_trades (labor_order_id, trade, saved, notes)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(labor_order_id, trade) DO UPDATE SET saved = 1, notes = excluded.notes, updated_at = datetime('now')
      `).run(order.id, trade, notes);
      const tradeRow = rawDb.prepare(`SELECT id FROM labor_order_trades WHERE labor_order_id = ? AND trade = ?`).get(order.id, trade) as any;
      rawDb.prepare(`DELETE FROM labor_order_assignments WHERE labor_order_trade_id = ?`).run(tradeRow.id);
      const insert = rawDb.prepare(`INSERT INTO labor_order_assignments (labor_order_trade_id, laborer_id, estimated_hours, hourly_rate_snapshot) VALUES (?, ?, ?, ?)`);
      for (const a of assignments) insert.run(tradeRow.id, a.laborerId, a.estimatedHours, rateById.get(a.laborerId));
      rawDb.prepare(`UPDATE labor_orders SET updated_at = datetime('now') WHERE id = ?`).run(order.id);
    });
    tx();
    res.json({ ok: true });
  });

  // ── Delete a saved trade tab — clears its assignments and removes the
  // labor_order_trades row entirely, returning that tab to a fresh/unsaved
  // state (same as if it had never been saved). Blocked once the order is
  // approved — undo the approval first. ──
  app.delete("/api/admin/repair-consult/:id/labor-order/trades/:trade", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const trade = String(req.params.trade);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status === "approved") return res.status(400).json({ error: "Labor order is approved — undo the approval before deleting a trade tab." });

    const tradeRow = rawDb.prepare(`SELECT id FROM labor_order_trades WHERE labor_order_id = ? AND trade = ?`).get(order.id, trade) as any;
    if (!tradeRow) return res.status(404).json({ error: "That trade tab has not been saved yet — nothing to delete." });

    const tx = rawDb.transaction(() => {
      rawDb.prepare(`DELETE FROM labor_order_assignments WHERE labor_order_trade_id = ?`).run(tradeRow.id);
      rawDb.prepare(`DELETE FROM labor_order_trades WHERE id = ?`).run(tradeRow.id);
      rawDb.prepare(`UPDATE labor_orders SET updated_at = datetime('now') WHERE id = ?`).run(order.id);
    });
    tx();
    res.json({ ok: true });
  });

  // ── Undo approval — reverts an approved order back to draft so trades can
  // be edited/deleted again. Does not touch the saved trade data itself. ──
  app.post("/api/admin/repair-consult/:id/labor-order/unapprove", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status !== "approved") return res.status(400).json({ error: "This labor order is not approved — nothing to undo." });

    rawDb.prepare(`UPDATE labor_orders SET status = 'draft', approved_at = NULL, approved_by = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(order.id);
    res.json({ ok: true });
  });

  // ── Approve the whole labor order — gated on every in-scope trade being saved ──
  app.post("/api/admin/repair-consult/:id/labor-order/approve", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status === "approved") return res.status(400).json({ error: "Already approved." });

    const scopeTrades = scopeTradesForConsult(consultId);
    if (scopeTrades.length === 0) return res.status(400).json({ error: "This job has no in-house scope items to assign labor for." });

    const savedTradeRows = rawDb.prepare(`SELECT * FROM labor_order_trades WHERE labor_order_id = ? AND saved = 1`).all(order.id) as any[];
    const savedTradeIds = new Map(savedTradeRows.map(t => [t.trade, t.id]));
    const missing: string[] = [];
    for (const trade of scopeTrades) {
      const tradeId = savedTradeIds.get(trade);
      if (!tradeId) { missing.push(trade); continue; }
      const count = (rawDb.prepare(`SELECT COUNT(*) AS n FROM labor_order_assignments WHERE labor_order_trade_id = ?`).get(tradeId) as any).n;
      if (count === 0) missing.push(trade);
    }
    if (missing.length > 0) return res.status(400).json({ error: "Every trade tab must be saved with at least one laborer before approving.", missingTrades: missing });

    rawDb.prepare(`UPDATE labor_orders SET status = 'approved', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(req.currentAgent.name || req.currentAgent.email || "admin", order.id);
    res.json({ ok: true });
  });
}
