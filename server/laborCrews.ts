// v20.40.0 — Labor & Crews: Phase 1 of the Scheduler/Labor/Calendar build.
// Standalone laborer roster (name, contact, pay tier, hourly rate,
// approved/active) that Phase 2's per-job Labor Calculator will assign
// against. Kept as its own table (not folded into `agents`) because
// laborers do not log into the app — they are people we dispatch and pay,
// added/approved by an admin. Phase 4 will separately add a real Project
// Manager login role, which is unrelated to this roster.
//
// Pay tiers are fixed at three levels per Alex 8/29/26: Tier 1 ($16/hr),
// Tier 2 ($20/hr), Tier 3 ($25/hr). The tier is stored for
// categorization/filtering, but hourly_rate is its own editable column —
// selecting a tier auto-fills the standard rate client-side, but a specific
// laborer's rate can be overridden (e.g. a Tier 2 with extra experience at
// $22/hr) without inventing a fourth tier.
import type { Express, Response } from "express";
import { rawDb } from "./db";

export const LABORER_TIERS = ["tier_1", "tier_2", "tier_3"] as const;
export type LaborerTier = typeof LABORER_TIERS[number];

export const LABORER_TIER_DEFAULT_RATES: Record<LaborerTier, number> = {
  tier_1: 16,
  tier_2: 20,
  tier_3: 25,
};

export function ensureLaborCrewsSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS laborers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      tier TEXT NOT NULL DEFAULT 'tier_1',
      hourly_rate REAL NOT NULL DEFAULT 16,
      trades TEXT,              -- optional comma-separated trade keys this person is skilled in (for Phase 2 filtering)
      notes TEXT,
      approved INTEGER NOT NULL DEFAULT 0,  -- must be approved before they can be assigned in the Phase 2 labor calculator
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_laborers_active ON laborers(active);`);
}

function isValidTier(t: any): t is LaborerTier {
  return LABORER_TIERS.includes(t);
}

export function registerLaborCrewsRoutes(app: Express) {
  ensureLaborCrewsSchema();

  // ── List roster ──
  app.get("/api/admin/laborers", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const laborers = rawDb.prepare(`SELECT * FROM laborers ORDER BY active DESC, approved ASC, name ASC`).all();
    res.json({ laborers });
  });

  // ── Add laborer ──
  app.post("/api/admin/laborers", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, phone, email, tier, hourly_rate, trades, notes, approved } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
    const finalTier: LaborerTier = isValidTier(tier) ? tier : "tier_1";
    const finalRate = typeof hourly_rate === "number" && hourly_rate > 0 ? hourly_rate : LABORER_TIER_DEFAULT_RATES[finalTier];
    const result = rawDb.prepare(`
      INSERT INTO laborers (name, phone, email, tier, hourly_rate, trades, notes, approved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(name).trim(), phone || null, email || null, finalTier, finalRate,
      trades || null, notes || null, approved ? 1 : 0
    );
    res.json({ id: result.lastInsertRowid });
  });

  // ── Update laborer (rate, tier, approve, activate/deactivate, edit info) ──
  app.patch("/api/admin/laborers/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, phone, email, tier, hourly_rate, trades, notes, approved, active } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (name !== undefined) { fields.push("name = ?"); vals.push(String(name).trim()); }
    if (phone !== undefined) { fields.push("phone = ?"); vals.push(phone || null); }
    if (email !== undefined) { fields.push("email = ?"); vals.push(email || null); }
    if (tier !== undefined) {
      if (!isValidTier(tier)) return res.status(400).json({ error: "Invalid tier" });
      fields.push("tier = ?"); vals.push(tier);
    }
    if (hourly_rate !== undefined) {
      if (typeof hourly_rate !== "number" || hourly_rate <= 0) return res.status(400).json({ error: "hourly_rate must be a positive number" });
      fields.push("hourly_rate = ?"); vals.push(hourly_rate);
    }
    if (trades !== undefined) { fields.push("trades = ?"); vals.push(trades || null); }
    if (notes !== undefined) { fields.push("notes = ?"); vals.push(notes || null); }
    if (approved !== undefined) { fields.push("approved = ?"); vals.push(approved ? 1 : 0); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at = datetime('now')");
    rawDb.prepare(`UPDATE laborers SET ${fields.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    res.json({ ok: true });
  });

  // ── Remove laborer (hard delete — only safe pre-Phase-2 since nothing references laborer_id yet) ──
  app.delete("/api/admin/laborers/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    rawDb.prepare(`DELETE FROM laborers WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}
