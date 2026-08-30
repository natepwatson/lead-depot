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
// job estimate.
//
// v20.44.0 — Phase 3: P&L integration. `actual_hours` on each assignment
// (nullable, separate from `estimated_hours`) lets an admin true-up real
// hours worked after the job wraps; approved cost = estimated_hours × rate,
// actual cost = (actual_hours ?? estimated_hours) × rate. `getApprovedLaborOrderCost`
// is consumed by server/bghsPnl.ts to auto-pull labor cost into the P&L
// without a manual "labor" category bghs_expenses entry. Approving an order
// also fires one consolidated work-order email per assigned laborer (hours
// and scope only — no dollar figures).
import type { Express, Response } from "express";
import { Resend } from "resend";
import { rawDb } from "./db";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = "Happy Home Solutions <noreply@watsonbrothersgroup.com>";
const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];

// Kept in sync with client/src/lib/tradeLabels.ts — duplicated here because
// the server bundle never imports from client/src.
const TRADE_LABELS: Record<string, string> = {
  junk_removal: "Junk Removal", handyman: "Handyman", pressure_washing: "Pressure Washing",
  painting_exterior: "Exterior Painting", landscaping: "Landscaping", painting_interior: "Interior Painting",
  cleaning: "Cleaning",
  tile_install: "Tile Installation", cabinet_install: "Cabinet Installation", cabinetry_painting: "Cabinetry Painting",
  roofing: "Roofing", electrical: "Electrical", plumbing: "Plumbing", hvac: "HVAC",
  stucco_masonry: "Stucco & Masonry", carpentry: "Carpentry", wdo: "WDO / Termite",
  windows: "Windows", backflow: "Backflow Prevention", flooring_wood_refinish: "Wood Floor Refinishing",
  flooring_lvp: "LVP Flooring", flooring_carpet: "Carpet Installation", flooring_epoxy: "Epoxy Flooring", appliances: "Appliances",
  countertops: "Countertops", retexture: "Re-Texturing", shower_doors: "Frameless Shower Doors",
  irrigation: "Irrigation", fencing: "Fencing", pool_equipment: "Pool Equipment", septic: "Septic",
  water_heater: "Water Heater", tree_removal_large: "Large Tree Removal", structural: "Structural / Foundation",
  mold_remediation: "Mold Remediation", chimney: "Chimney", solar: "Solar", water_damage: "Water Damage Restoration",
  garage_door: "Garage Door", hardscape: "Hardscape / Pavers", land_clearing: "Land Clearing",
  bathroom_repair: "Bathroom Repairs", kitchen_repair: "Kitchen Repairs", laundry_repair: "Laundry Room",
  appliance_coordination: "Materials, Appliance Purchase & Delivery",
};

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

  // ALTER TABLE is safe to run repeatedly — SQLite ignores "duplicate column" errors
  const assignmentCols = (rawDb.prepare(`PRAGMA table_info(labor_order_assignments)`).all() as any[]).map(c => c.name);
  if (!assignmentCols.includes("actual_hours")) rawDb.prepare(`ALTER TABLE labor_order_assignments ADD COLUMN actual_hours REAL`).run();
}

// Cost totals for one labor order, regardless of status. Actual cost falls
// back to estimated hours per-assignment until an admin enters a real
// actual_hours value for that assignment.
function computeOrderTotals(orderId: number): { approvedCost: number; actualCost: number; hasActuals: boolean } {
  const rows = rawDb.prepare(`
    SELECT loa.estimated_hours, loa.actual_hours, loa.hourly_rate_snapshot
    FROM labor_order_assignments loa
    JOIN labor_order_trades lot ON lot.id = loa.labor_order_trade_id
    WHERE lot.labor_order_id = ?
  `).all(orderId) as any[];
  let approvedCost = 0, actualCost = 0, hasActuals = false;
  for (const r of rows) {
    const rate = r.hourly_rate_snapshot || 0;
    approvedCost += (r.estimated_hours || 0) * rate;
    const actualHours = r.actual_hours != null ? r.actual_hours : (r.estimated_hours || 0);
    if (r.actual_hours != null) hasActuals = true;
    actualCost += actualHours * rate;
  }
  return { approvedCost, actualCost, hasActuals };
}

// Consumed by server/bghsPnl.ts. Returns null unless the labor order for
// this job has actually been approved — a draft plan is not a committed
// cost and should never be pulled into the P&L.
export function getApprovedLaborOrderCost(consultId: number): { approvedCost: number; actualCost: number; overage: number; hasActuals: boolean } | null {
  const order = rawDb.prepare(`SELECT id, status FROM labor_orders WHERE consult_id = ?`).get(consultId) as any;
  if (!order || order.status !== "approved") return null;
  const totals = computeOrderTotals(order.id);
  return { ...totals, overage: totals.actualCost - totals.approvedCost };
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
            SELECT loa.id, loa.laborer_id, loa.estimated_hours, loa.actual_hours, loa.hourly_rate_snapshot,
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

    const totals = computeOrderTotals(order.id);

    res.json({
      laborOrder: { id: order.id, status: order.status, approvedAt: order.approved_at, approvedBy: order.approved_by },
      propertyAddress: consult.property_address,
      trades,
      allTabsSaved,
      laborers,
      laborCost: { ...totals, overage: totals.actualCost - totals.approvedCost },
    });
  });

  // — Enter/edit actual hours worked per assignment, after the job wraps.
  // Only allowed once the order is approved — actual hours are a true-up
  // against the committed approved plan, not a draft-editing shortcut. —
  app.post("/api/admin/repair-consult/:id/labor-order/actuals", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status !== "approved") return res.status(400).json({ error: "Approve the labor order before entering actual hours worked." });

    const actuals: Array<{ assignmentId: number; actualHours: number | null }> = Array.isArray(req.body?.actuals) ? req.body.actuals : [];
    if (actuals.length === 0) return res.status(400).json({ error: "No actual-hours entries provided." });
    for (const a of actuals) {
      if (!a.assignmentId || (a.actualHours != null && (typeof a.actualHours !== "number" || a.actualHours < 0))) {
        return res.status(400).json({ error: "Each entry needs a valid assignmentId and a non-negative actualHours (or null to clear it)." });
      }
    }

    // Every assignmentId must belong to THIS order — no cross-job writes.
    const validIds = new Set((rawDb.prepare(`
      SELECT loa.id FROM labor_order_assignments loa
      JOIN labor_order_trades lot ON lot.id = loa.labor_order_trade_id
      WHERE lot.labor_order_id = ?
    `).all(order.id) as any[]).map(r => r.id));
    for (const a of actuals) {
      if (!validIds.has(a.assignmentId)) return res.status(400).json({ error: `Assignment ${a.assignmentId} does not belong to this labor order.` });
    }

    const tx = rawDb.transaction(() => {
      const update = rawDb.prepare(`UPDATE labor_order_assignments SET actual_hours = ? WHERE id = ?`);
      for (const a of actuals) update.run(a.actualHours, a.assignmentId);
      rawDb.prepare(`UPDATE labor_orders SET updated_at = datetime('now') WHERE id = ?`).run(order.id);
    });
    tx();

    const totals = computeOrderTotals(order.id);
    res.json({ ok: true, laborCost: { ...totals, overage: totals.actualCost - totals.approvedCost } });
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

  // ── Delete ALL saved trade tabs for this job's labor order in one shot —
  // same safety gate as the per-trade delete (blocked once approved; undo
  // approval first). Leaves the labor_orders row itself in place (still
  // 'draft'), just wipes every trade_id + its assignments, so the next GET
  // shows a completely fresh set of unsaved tabs. ──
  app.delete("/api/admin/repair-consult/:id/labor-order/trades", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });

    const order = getOrCreateLaborOrder(consultId);
    if (order.status === "approved") return res.status(400).json({ error: "Labor order is approved — undo the approval before deleting labor." });

    const tradeRows = rawDb.prepare(`SELECT id FROM labor_order_trades WHERE labor_order_id = ?`).all(order.id) as any[];
    if (tradeRows.length === 0) return res.status(404).json({ error: "No saved trade tabs on this labor order — nothing to delete." });

    const tx = rawDb.transaction(() => {
      for (const t of tradeRows) {
        rawDb.prepare(`DELETE FROM labor_order_assignments WHERE labor_order_trade_id = ?`).run(t.id);
      }
      rawDb.prepare(`DELETE FROM labor_order_trades WHERE labor_order_id = ?`).run(order.id);
      rawDb.prepare(`UPDATE labor_orders SET updated_at = datetime('now') WHERE id = ?`).run(order.id);
    });
    tx();
    res.json({ ok: true, deletedTrades: tradeRows.length });
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
  app.post("/api/admin/repair-consult/:id/labor-order/approve", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = Number(req.params.id);
    const consult = rawDb.prepare(`SELECT id, property_address FROM repair_consults WHERE id = ?`).get(consultId) as any;
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

    // ── Consolidated work-order email, one per assigned laborer, grouped
    // across every trade on this job. Hours and scope only — no dollar
    // figures anywhere in this template, per standing rule. Best-effort:
    // a laborer with no email on file is skipped (not an error), and a
    // send failure for one laborer never blocks the approval itself. ──
    const assignmentRows = rawDb.prepare(`
      SELECT lot.trade, loa.estimated_hours, l.id AS laborer_id, l.name AS laborer_name, l.email AS laborer_email
      FROM labor_order_assignments loa
      JOIN labor_order_trades lot ON lot.id = loa.labor_order_trade_id
      JOIN laborers l ON l.id = loa.laborer_id
      WHERE lot.labor_order_id = ?
      ORDER BY l.name ASC, lot.trade ASC
    `).all(order.id) as any[];

    const byLaborer = new Map<number, { name: string; email: string | null; lines: Array<{ trade: string; hours: number }> }>();
    for (const r of assignmentRows) {
      if (!byLaborer.has(r.laborer_id)) byLaborer.set(r.laborer_id, { name: r.laborer_name, email: r.laborer_email || null, lines: [] });
      byLaborer.get(r.laborer_id)!.lines.push({ trade: r.trade, hours: r.estimated_hours });
    }

    const sent: string[] = [];
    const skipped: string[] = [];
    for (const [, laborer] of byLaborer) {
      if (!laborer.email) { skipped.push(laborer.name); continue; }
      if (!resend) { skipped.push(laborer.name); continue; }
      const rowsHtml = laborer.lines.map(l => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${TRADE_LABELS[l.trade] || l.trade}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${l.hours} hrs</td></tr>`).join("");
      const html = `
        <div style="font-family:Arial,sans-serif;color:#222;">
          <h2 style="margin:0 0 6px;">Work Order</h2>
          <p style="margin:0 0 14px;color:#555;">${consult.property_address}</p>
          <table style="border-collapse:collapse;width:100%;max-width:480px;">
            <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;">Trade</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;">Hours</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="margin-top:16px;color:#777;font-size:12.5px;">Reach out if you have any questions about the scope for this job.</p>
        </div>`;
      try {
        await resend.emails.send({
          from: FROM,
          to: laborer.email,
          bcc: ADMIN_EMAILS,
          subject: `Work Order — ${consult.property_address}`,
          html,
        });
        sent.push(laborer.name);
      } catch {
        skipped.push(laborer.name);
      }
    }

    res.json({ ok: true, workOrdersSent: sent, workOrdersSkipped: skipped });
  });
}
