// v20.34.0 — BGHS (Brothers Group Home Solutions) Profit & Loss Center.
// Revenue side reuses the existing repair_consults / repair_consult_items /
// payment_records tables (no parallel pricing logic). Cost side adds one new
// table, bghs_expenses, for the costs the app doesn't already track anywhere:
// materials, in-house labor, fuel, equipment, insurance, marketing, overhead,
// etc. Vendor-quoted line items already carry their own cost
// (vendor_quote_amount) so those are pulled in automatically and NOT meant to
// be re-logged as a manual expense — the Add Expense form callouts this.
//
// Scope note (flagged to Alex): BGHS = the repair/touch-up/turnover program
// (repair_consults), not Inspections+ (a separate product line/table). If
// Alex wants inspection revenue folded into this P&L later, it's a small
// addition (inspection_orders + inspection_order_items follow the same
// shape) — held out for now so "BGHS P&L" means exactly what the name says.
import type { Express, Response } from "express";
import { rawDb } from "./db";
import { isPaymentAuthorizedAgent } from "./payments";

export const BGHS_EXPENSE_CATEGORIES = [
  "materials", "labor", "equipment", "fuel", "insurance",
  "marketing", "tools", "overhead", "other",
] as const;
export type BghsExpenseCategory = typeof BGHS_EXPENSE_CATEGORIES[number];

export function ensureBghsPnlSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS bghs_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER REFERENCES repair_consults(id),  -- NULL = general/overhead expense, not tied to one job
      category TEXT NOT NULL,                             -- see BGHS_EXPENSE_CATEGORIES
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      vendor_name TEXT,
      expense_date TEXT NOT NULL,                         -- YYYY-MM-DD, user-set (may differ from entry date)
      recorded_by_agent_id INTEGER REFERENCES agents(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_bghs_expenses_consult ON bghs_expenses(consult_id);`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_bghs_expenses_date ON bghs_expenses(expense_date);`);
}

function isFinitePositive(n: any): boolean {
  return typeof n === "number" && isFinite(n) && n > 0;
}

export function registerBghsPnlRoutes(app: Express) {
  ensureBghsPnlSchema();

  // ---- Expense ledger --------------------------------------------------

  app.get("/api/admin/bghs/expenses", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { from, to, consultId } = req.query as Record<string, string>;
    let sql = `
      SELECT e.*, rc.property_address, a.name AS recorded_by_name
      FROM bghs_expenses e
      LEFT JOIN repair_consults rc ON rc.id = e.consult_id
      LEFT JOIN agents a ON a.id = e.recorded_by_agent_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (from) { sql += ` AND e.expense_date >= ?`; params.push(from); }
    if (to) { sql += ` AND e.expense_date <= ?`; params.push(to); }
    if (consultId) { sql += ` AND e.consult_id = ?`; params.push(parseInt(consultId)); }
    sql += ` ORDER BY e.expense_date DESC, e.id DESC`;
    const rows = rawDb.prepare(sql).all(...params);
    res.json({ expenses: rows });
  });

  app.post("/api/admin/bghs/expenses", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    if (!isPaymentAuthorizedAgent(req.currentAgent)) {
      return res.status(403).json({ error: "Only Alex, Nate, or Denise may log HHS expenses." });
    }
    const { consultId, category, description, amount, vendorName, expenseDate, notes } = req.body || {};
    if (!BGHS_EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${BGHS_EXPENSE_CATEGORIES.join(", ")}` });
    }
    if (!description || typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }
    const amt = Number(amount);
    if (!isFinitePositive(amt)) return res.status(400).json({ error: "amount must be a positive number" });
    const dateStr = (expenseDate && /^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) ? expenseDate : new Date().toISOString().slice(0, 10);
    let consult: any = null;
    if (consultId) {
      consult = rawDb.prepare(`SELECT id FROM repair_consults WHERE id = ?`).get(parseInt(consultId));
      if (!consult) return res.status(400).json({ error: "consultId does not match a known job" });
    }
    const result = rawDb.prepare(`
      INSERT INTO bghs_expenses (consult_id, category, description, amount, vendor_name, expense_date, recorded_by_agent_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(consult ? consult.id : null, category, description.trim(), amt, vendorName || null, dateStr, req.currentAgent.id, notes || null);
    res.json({ ok: true, id: result.lastInsertRowid });
  });

  app.delete("/api/admin/bghs/expenses/:id", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    if (!isPaymentAuthorizedAgent(req.currentAgent)) {
      return res.status(403).json({ error: "Only Alex, Nate, or Denise may remove HHS expenses." });
    }
    const id = parseInt(req.params.id);
    const row = rawDb.prepare(`SELECT id FROM bghs_expenses WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "Expense not found" });
    rawDb.prepare(`DELETE FROM bghs_expenses WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // Job picker for tagging an expense to a specific repair job.
  app.get("/api/admin/bghs/jobs-for-expense", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`
      SELECT id, property_address, status, total, created_at
      FROM repair_consults
      WHERE status NOT IN ('draft', 'declined')
      ORDER BY created_at DESC
      LIMIT 300
    `).all();
    res.json({ jobs: rows });
  });

  // ---- P&L summary -------------------------------------------------------

  app.get("/api/admin/bghs/pnl", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { from, to } = req.query as Record<string, string>;

    // Cash-basis revenue: payments actually collected on repair jobs, bucketed
    // by the date each payment was recorded — this is the number that matches
    // money that has actually moved.
    let payWhere = `WHERE pr.source_type = 'repair_consult'`;
    const payParams: any[] = [];
    if (from) { payWhere += ` AND date(pr.recorded_at) >= ?`; payParams.push(from); }
    if (to) { payWhere += ` AND date(pr.recorded_at) <= ?`; payParams.push(to); }
    const collectedRows = rawDb.prepare(`
      SELECT pr.source_id AS consult_id, pr.amount, pr.recorded_at
      FROM payment_records pr
      ${payWhere}
    `).all(...payParams) as any[];
    const revenueCollected = collectedRows.reduce((s, r) => s + (r.amount || 0), 0);

    // Accrual/backlog view: full contract value of every signed job whose
    // acceptance falls in the period, regardless of how much has been paid
    // yet. Useful for seeing pipeline value, separate from cash collected.
    let jobWhere = `WHERE rc.status NOT IN ('draft', 'declined') AND rc.total > 0`;
    const jobParams: any[] = [];
    if (from) { jobWhere += ` AND date(COALESCE(rc.accepted_at, rc.work_order_sent_at, rc.created_at)) >= ?`; jobParams.push(from); }
    if (to) { jobWhere += ` AND date(COALESCE(rc.accepted_at, rc.work_order_sent_at, rc.created_at)) <= ?`; jobParams.push(to); }
    const jobs = rawDb.prepare(`
      SELECT rc.id, rc.property_address, rc.status, rc.total,
             COALESCE(rc.accepted_at, rc.work_order_sent_at, rc.created_at) AS reference_date,
             a.name AS agent_name
      FROM repair_consults rc
      LEFT JOIN agents a ON a.id = rc.agent_id
      ${jobWhere}
      ORDER BY reference_date DESC
    `).all(...jobParams) as any[];
    const revenueContracted = jobs.reduce((s, j) => s + (j.total || 0), 0);

    // Known vendor cost: vendor_quote_amount on every vendor-category line
    // item belonging to one of the jobs in scope above (joins on the same
    // job set so the period filter is consistent between revenue and cost).
    const jobIds = jobs.map(j => j.id);
    let vendorCostByJob: Record<number, number> = {};
    let vendorCostTotal = 0;
    if (jobIds.length > 0) {
      const placeholders = jobIds.map(() => "?").join(",");
      const vendorRows = rawDb.prepare(`
        SELECT consult_id, COALESCE(SUM(vendor_quote_amount), 0) AS cost
        FROM repair_consult_items
        WHERE category = 'vendor' AND vendor_quote_amount IS NOT NULL AND consult_id IN (${placeholders})
        GROUP BY consult_id
      `).all(...jobIds) as any[];
      for (const r of vendorRows) { vendorCostByJob[r.consult_id] = r.cost || 0; vendorCostTotal += r.cost || 0; }
    }

    // Manual expenses (materials/labor/overhead/etc.) within the same date range.
    let expWhere = `WHERE 1=1`;
    const expParams: any[] = [];
    if (from) { expWhere += ` AND expense_date >= ?`; expParams.push(from); }
    if (to) { expWhere += ` AND expense_date <= ?`; expParams.push(to); }
    const expenses = rawDb.prepare(`SELECT * FROM bghs_expenses ${expWhere}`).all(...expParams) as any[];
    const expensesByCategory: Record<string, number> = {};
    const expensesByJob: Record<number, number> = {};
    let expensesTotal = 0;
    for (const e of expenses) {
      expensesTotal += e.amount || 0;
      expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + (e.amount || 0);
      if (e.consult_id) expensesByJob[e.consult_id] = (expensesByJob[e.consult_id] || 0) + (e.amount || 0);
    }

    // Cash-basis gross profit is the headline number: what actually came in,
    // minus known hard costs (vendor invoices + logged materials/labor/
    // overhead). It does NOT subtract an imputed cost for in-house crew time
    // beyond what's logged in bghs_expenses — if labor hours aren't logged
    // there, this overstates margin on in-house-labor-heavy jobs. Flagged in
    // the UI, not hidden.
    const grossProfit = revenueCollected - vendorCostTotal - expensesTotal;
    const grossMarginPct = revenueCollected > 0 ? (grossProfit / revenueCollected) * 100 : null;

    const perJob = jobs.map(j => {
      const collected = (rawDb.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payment_records WHERE source_type='repair_consult' AND source_id = ?`).get(j.id) as any).s || 0;
      const vCost = vendorCostByJob[j.id] || 0;
      const exp = expensesByJob[j.id] || 0;
      const profit = collected - vCost - exp;
      return {
        consultId: j.id,
        propertyAddress: j.property_address,
        agentName: j.agent_name,
        status: j.status,
        referenceDate: j.reference_date,
        contractTotal: j.total || 0,
        collected,
        vendorCost: vCost,
        expenses: exp,
        profit,
        marginPct: collected > 0 ? (profit / collected) * 100 : null,
      };
    }).sort((a, b) => (b.referenceDate || "").localeCompare(a.referenceDate || ""));

    res.json({
      range: { from: from || null, to: to || null },
      revenueCollected,
      revenueContracted,
      vendorCostTotal,
      expensesTotal,
      expensesByCategory,
      grossProfit,
      grossMarginPct,
      jobCount: jobs.length,
      perJob,
    });
  });
}
