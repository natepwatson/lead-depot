// ─── PAYMENT RECORDS (Part 7, v20.32.13) ───────────────────────────────────
// Fully manual/person-to-person payment collection — no processor, no API,
// no webhooks (Nate's explicit call, 8/24/26). Accepted rails: check, wire,
// Zelle, Cash App, Apple Pay, Venmo, cash. Every payment gets evidence (a
// photo of the cash/check, or a screenshot of the digital confirmation) PLUS
// a photo of the fully-signed "Payment Received" line (Company Representative
// + Client) — that signed photo IS the receipt, which is what makes an
// all-manual system defensible.
//
// Recording a payment is restricted to Alex, Nate, and Denise ONLY — not the
// general admin role. This matches the confirmed rule that the Company
// Representative signature must be one of those three people, and the person
// logging the payment in the app is the same trusted set.
//
// Signature capture note: the codebase's existing "signature" pattern
// (repair_consults.accepted_signature_name / print_signed_by) is a TYPED
// NAME, not a drawn canvas signature — there is no signature-pad component
// anywhere in this app. This module follows that same real, working pattern
// (company_rep_signature_name / client_signature_name as typed names) rather
// than inventing a new canvas-signature UI paradigm that doesn't exist
// elsewhere in Lead Depot. Flag to Alex if he actually wants a drawn
// signature captured — that would be new UI work, not a reuse of anything
// already built.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { rawDb } from "./db";
import { fubRequest, resolveFubPersonId } from "./fub";

const IS_PROD = process.env.NODE_ENV === "production";
function paymentPhotosDir(): string {
  const dir = IS_PROD ? "/app/data/payment-photos" : path.resolve(__dirname, "public", "payment-photos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const PAYMENT_METHODS = ["check", "wire", "zelle", "cash_app", "apple_pay", "venmo", "cash"] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export const PAYMENT_SOURCE_TYPES = ["repair_consult", "inspection_order"] as const;
export type PaymentSourceType = typeof PAYMENT_SOURCE_TYPES[number];

// Restricted to these three people only — company-rep signature + who may
// log a payment are the same trusted set, per Alex's confirmation.
const PAYMENT_AUTHORIZED_EMAILS = [
  "alex@watsonbrothersgroup.com",
  "nate@watsonbrothersgroup.com",
  "denise@watsonbrothersgroup.com",
];

export function isPaymentAuthorizedAgent(agent: any): boolean {
  if (!agent || !agent.email) return false;
  return PAYMENT_AUTHORIZED_EMAILS.includes(String(agent.email).toLowerCase().trim());
}

export function ensurePaymentRecordsSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,             -- repair_consult | inspection_order
      source_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,                  -- check|wire|zelle|cash_app|apple_pay|venmo|cash
      reference_note TEXT,                   -- check #, wire confirmation #, Zelle/Venmo/Cash App txn id
      evidence_photo_url TEXT,               -- photo of cash/check, or screenshot of digital confirmation
      receipt_photo_url TEXT,                -- photo of the fully-signed Payment Received line
      company_rep_agent_id INTEGER REFERENCES agents(id),   -- must be Alex, Nate, or Denise
      company_rep_signature_name TEXT,
      client_signature_name TEXT,
      signed_at TEXT,
      recorded_by_agent_id INTEGER REFERENCES agents(id),   -- restricted to Alex/Nate/Denise
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_payment_records_source ON payment_records(source_type, source_id);`);
}

// Minimal shared lookup across the two source tables — just the fields the
// payment flow needs (client contact info, address, contract total).
function getSourceRow(sourceType: PaymentSourceType, sourceId: number): any {
  if (sourceType === "repair_consult") {
    return rawDb.prepare(`SELECT id, client_name, client_email, client_phone, property_address, total FROM repair_consults WHERE id = ?`).get(sourceId);
  }
  return rawDb.prepare(`SELECT id, client_name, client_email, client_phone, property_address, total, fub_contact_id FROM inspection_orders WHERE id = ?`).get(sourceId);
}

function sumPaymentsForSource(sourceType: PaymentSourceType, sourceId: number): number {
  const row = rawDb.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records WHERE source_type = ? AND source_id = ?`).get(sourceType, sourceId) as any;
  return row?.total || 0;
}

export function registerPaymentRoutes(app: Express) {
  ensurePaymentRecordsSchema();

  // Upload evidence/receipt photo — base64 JSON body, same pattern as
  // /api/repair-consult/:id/photo. kind: 'evidence' | 'receipt'. Restricted
  // to Alex/Nate/Denise since only they ever reach the Record Payment screen.
  app.post("/api/payments/photo", async (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    if (!isPaymentAuthorizedAgent(req.currentAgent)) {
      return res.status(403).json({ error: "Only Alex, Nate, or Denise may upload payment photos." });
    }
    const { imageData, mimeType, kind } = req.body || {};
    if (!imageData || !mimeType) return res.status(400).json({ error: "Missing imageData or mimeType" });
    if (imageData.length > 28000000) return res.status(413).json({ error: "Image too large. Max 20MB." });
    try {
      const sharp = require("sharp");
      const inputBuf = Buffer.from(imageData, "base64");
      const rotated = await sharp(inputBuf).rotate().toBuffer();
      const processed = await sharp(rotated).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, progressive: true }).toBuffer();
      const dir = paymentPhotosDir();
      const filename = `${kind || "photo"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      fs.writeFileSync(path.join(dir, filename), processed);
      res.json({ ok: true, url: `/payment-photos/${filename}` });
    } catch (err: any) {
      console.error("[Payments] Photo upload error:", err);
      res.status(500).json({ error: "Photo upload failed" });
    }
  });

  // List payment records + running total / reconciliation status for a source.
  app.get("/api/payments", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    const sourceType = String(req.query.sourceType || "");
    const sourceId = parseInt(String(req.query.sourceId || ""));
    if (!PAYMENT_SOURCE_TYPES.includes(sourceType as PaymentSourceType) || !sourceId) {
      return res.status(400).json({ error: "sourceType and sourceId are required" });
    }
    const source = getSourceRow(sourceType as PaymentSourceType, sourceId);
    if (!source) return res.status(404).json({ error: "Source record not found" });
    const rows = rawDb.prepare(`SELECT * FROM payment_records WHERE source_type = ? AND source_id = ? ORDER BY id ASC`).all(sourceType, sourceId);
    const paid = sumPaymentsForSource(sourceType as PaymentSourceType, sourceId);
    res.json({
      payments: rows,
      totalPaid: paid,
      contractTotal: source.total || 0,
      balanceRemaining: Math.max(0, (source.total || 0) - paid),
      reconciled: paid >= (source.total || 0) && (source.total || 0) > 0,
    });
  });

  // Record a payment — restricted to Alex, Nate, Denise only.
  app.post("/api/payments", async (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    if (!isPaymentAuthorizedAgent(req.currentAgent)) {
      return res.status(403).json({ error: "Only Alex, Nate, or Denise may record a payment." });
    }
    const {
      sourceType, sourceId, amount, method, referenceNote,
      evidencePhotoUrl, receiptPhotoUrl, companyRepAgentId,
      companyRepSignatureName, clientSignatureName, notes,
    } = req.body || {};

    if (!PAYMENT_SOURCE_TYPES.includes(sourceType)) return res.status(400).json({ error: "Invalid sourceType" });
    if (!sourceId) return res.status(400).json({ error: "sourceId is required" });
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: "Invalid payment method" });
    if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be greater than 0" });
    if (!companyRepSignatureName || !clientSignatureName) {
      return res.status(400).json({ error: "Both Company Representative and Client signatures are required." });
    }

    const source = getSourceRow(sourceType, sourceId);
    if (!source) return res.status(404).json({ error: "Source record not found" });

    // Company Representative must also be one of the 3 authorized people —
    // whoever is logging it in, and whoever the rep on the line is, can
    // differ (e.g. Denise logs it but Alex physically collected it), but
    // both must be from the same restricted set.
    let repAgent: any = null;
    if (companyRepAgentId) {
      repAgent = rawDb.prepare(`SELECT id, name, email FROM agents WHERE id = ?`).get(companyRepAgentId);
      if (!repAgent || !isPaymentAuthorizedAgent(repAgent)) {
        return res.status(400).json({ error: "companyRepAgentId must be Alex, Nate, or Denise." });
      }
    }

    const insert = rawDb.prepare(`
      INSERT INTO payment_records (
        source_type, source_id, amount, method, reference_note,
        evidence_photo_url, receipt_photo_url, company_rep_agent_id,
        company_rep_signature_name, client_signature_name, signed_at,
        recorded_by_agent_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `);
    const result = insert.run(
      sourceType, sourceId, amount, method, referenceNote || null,
      evidencePhotoUrl || null, receiptPhotoUrl || null, companyRepAgentId || null,
      companyRepSignatureName, clientSignatureName,
      req.currentAgent.id, notes || null
    );

    const paid = sumPaymentsForSource(sourceType, sourceId);
    const reconciled = paid >= (source.total || 0) && (source.total || 0) > 0;

    // FUB tie-in — fire-and-forget, non-fatal. Posts a note so the payment
    // shows up in the client's FUB timeline, and if this payment reconciles
    // the job in full and it's a repair consult, best-effort-completes the
    // final_payment milestone task created by Part 4/5's mark-complete flow.
    (async () => {
      try {
        const personId = sourceType === "inspection_order" && source.fub_contact_id
          ? parseInt(source.fub_contact_id)
          : await resolveFubPersonId({ phone: source.client_phone, email: source.client_email, name: source.client_name });
        if (personId) {
          await fubRequest("POST", "/notes", {
            personId,
            subject: `Payment received — $${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} via ${method}`,
            body: `Recorded by ${req.currentAgent.name || req.currentAgent.email} for ${source.property_address}.${reconciled ? " Job paid in full." : ` Balance remaining: $${((source.total || 0) - paid).toLocaleString(undefined, { minimumFractionDigits: 2 })}.`}`,
          });
        }
        if (reconciled && sourceType === "repair_consult") {
          const meeting = rawDb.prepare(`SELECT fub_task_id FROM repair_project_meetings WHERE consult_id = ? AND meeting_type = 'final_payment'`).get(sourceId) as any;
          if (meeting?.fub_task_id) {
            await fubRequest("PUT", `/tasks/${meeting.fub_task_id}`, { isCompleted: true });
          }
        }
      } catch (err: any) {
        console.warn("[Payments] FUB tie-in failed:", err?.message || err);
      }
    })();

    res.json({
      ok: true,
      id: result.lastInsertRowid,
      totalPaid: paid,
      contractTotal: source.total || 0,
      balanceRemaining: Math.max(0, (source.total || 0) - paid),
      reconciled,
    });
  });

  // Single record lookup.
  app.get("/api/payments/:id", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    const row = rawDb.prepare(`SELECT * FROM payment_records WHERE id = ?`).get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: "Payment record not found" });
    res.json({ payment: row });
  });
}
