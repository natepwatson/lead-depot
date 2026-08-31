// ─── PAYMENT RECORDS (Part 7, v20.32.13) ───────────────────────────────────
// Fully manual/person-to-person payment collection — no processor, no API,
// no webhooks (Nate's explicit call, 8/24/26). Accepted rails (v20.32.16,
// Alex's confirmed list): cash, wire, check, money order, Venmo, Zelle,
// Apple Pay. Cash App was swapped out for Money Order to match exactly.
// Every payment gets evidence (a
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
import { Resend } from "resend";
import { rawDb } from "./db";
import { fubRequest, resolveFubPersonId } from "./fub";
import { notifyTCPaymentReceivedForInspectionOrder } from "./inspections";

// v20.33.3 — local branded-email constants, matching the exact pattern
// already duplicated in repairConsult.ts and inspections.ts (no shared
// brand module exists yet in this codebase — this follows the established
// convention rather than introducing a new cross-import, which would risk
// a circular dependency since repairConsult.ts already imports FROM this
// file (ACCEPTED_PAYMENT_METHODS_LABEL)).
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];
const FROM = "The Brothers Group Real Estate Team <noreply@watsonbrothersgroup.com>";
const APP_URL = "https://depot.watsonbrothersgroup.com";
const BRAND = {
  black: "#0a0a0a",
  gray: "#808080",
  lightGray: "#f2f2f2",
  green: "#1a7a3c",
  border: "#e0e0e0",
};

function brandedHeader(title: string, subtitle: string): string {
  return `
  <div style="background:${BRAND.black};padding:28px 32px;text-align:center">
    <img src="${APP_URL}/brand-logo.jpg" alt="Brothers Group" style="width:220px;max-width:70%;height:auto;display:inline-block" />
  </div>
  <div style="padding:22px 32px 4px;text-align:center;border-bottom:3px solid ${BRAND.black}">
    <h1 style="margin:0;font-size:19px;color:${BRAND.black};font-family:Helvetica,Arial,sans-serif;font-weight:700">${title}</h1>
    ${subtitle ? `<p style="margin:6px 0 16px;font-size:12.5px;color:${BRAND.gray}">${subtitle}</p>` : ""}
  </div>`;
}

function brandedFooter(): string {
  return `
  <div style="padding:16px 32px;background:${BRAND.gray};color:#fff;font-size:11px;text-align:center">
    Alex &amp; Nate Watson — (904) 867-3984 — www.brothersgroup.realestate
  </div>`;
}

// v20.33.3 — deterministic, human-readable confirmation number. Not a
// security token (nothing sensitive is derivable from it) — purely a
// reference number the client can quote back to us, matching how wire
// confirmation #s / check #s already work elsewhere in this flow. Format:
// BG-PMT-<zero-padded payment_records.id> so it's stable and unique forever.
function paymentConfirmationNumber(paymentId: number): string {
  return `BG-PMT-${String(paymentId).padStart(6, "0")}`;
}

const IS_PROD = process.env.NODE_ENV === "production";
function paymentPhotosDir(): string {
  const dir = IS_PROD ? "/app/data/payment-photos" : path.resolve(__dirname, "public", "payment-photos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const PAYMENT_METHODS = ["check", "wire", "zelle", "money_order", "apple_pay", "venmo", "cash", "credit_card"] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

// v20.47.1 — Credit Card added as an accepted rail alongside the existing
// manual/person-to-person methods (Alex, 8/31/26). Unlike the other methods,
// CC carries a processing-cost pass-through: a flat 3% fee that can be
// toggled on at the moment of recording ANY payment — this is the exact
// "client said cash, changed their mind to CC right before paying" case
// Alex described, so the fee must be quick to add regardless of what method
// was originally quoted/expected, not something that requires re-quoting the
// job. See CC_FEE_PCT and the cc_fee_amount column below.
export const CC_FEE_PCT = 0.03;

// v20.32.16 — single source of truth for the client-facing accepted-forms
// sentence, used in repair/inspection quote emails, agreements, and terms so
// the wording never drifts across files.
export const ACCEPTED_PAYMENT_METHODS_LABEL = "Cash, Wire, Check, Money Order, Venmo, Zelle, Apple Pay, or Credit Card (a 3% card processing fee applies)";

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
      method TEXT NOT NULL,                  -- check|wire|zelle|money_order|apple_pay|venmo|cash
      reference_note TEXT,                   -- check #, wire confirmation #, Zelle/Venmo txn id, money order serial #
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

  // v20.47.1 — CC fee breakdown columns (ALTER TABLE guarded by PRAGMA
  // table_info check, same pattern used throughout this codebase). amount
  // stays the true total collected (base + fee, if any) so reconciliation
  // math elsewhere never needs to know about fees; these two columns are
  // purely for transparency/audit/receipt breakdown.
  const prCols = (rawDb.prepare(`PRAGMA table_info(payment_records)`).all() as any[]).map((c: any) => c.name);
  if (!prCols.includes("cc_fee_applied")) rawDb.prepare("ALTER TABLE payment_records ADD COLUMN cc_fee_applied INTEGER NOT NULL DEFAULT 0").run();
  if (!prCols.includes("cc_fee_amount")) rawDb.prepare("ALTER TABLE payment_records ADD COLUMN cc_fee_amount REAL DEFAULT 0").run();
  if (!prCols.includes("base_amount")) rawDb.prepare("ALTER TABLE payment_records ADD COLUMN base_amount REAL").run();
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

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  check: "Check", wire: "Wire Transfer", zelle: "Zelle", money_order: "Money Order",
  apple_pay: "Apple Pay", venmo: "Venmo", cash: "Cash", credit_card: "Credit Card",
};

// v20.33.3 — client-facing payment confirmation receipt. Fire-and-forget,
// non-fatal (mirrors the existing FUB tie-in block's error handling) so an
// email hiccup never blocks the payment record itself from saving. Every
// receipt includes a stable confirmation number AND an explicit anti-fraud
// line — real deals with wiring instructions in flow means every client
// touchpoint should reinforce "we will never change payment instructions by
// email alone," which is the single highest-leverage wire-fraud deterrent a
// small brokerage can put in writing (industry-standard advice from ALTA /
// FBI IC3 wire-fraud guidance for real estate closings).
async function sendPaymentConfirmationEmail(opts: {
  paymentId: number;
  sourceType: PaymentSourceType;
  source: any;
  amount: number;
  method: PaymentMethod;
  referenceNote?: string | null;
  totalPaid: number;
  contractTotal: number;
  balanceRemaining: number;
  reconciled: boolean;
  ccFeeAmount?: number;
}) {
  if (!resend || !opts.source?.client_email) return;
  const confNum = paymentConfirmationNumber(opts.paymentId);
  const methodLabel = PAYMENT_METHOD_LABELS[opts.method] || opts.method;
  const jobLabel = opts.sourceType === "inspection_order" ? "Inspection Order" : "Repair Proposal";
  const firstName = (opts.source.client_name || "").split(" ")[0] || "there";
  const feeAmt = opts.ccFeeAmount || 0;

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Payment Received — Confirmation", opts.source.property_address)}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${firstName} — this confirms we received your payment. Please keep this confirmation number for your records.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:10px">
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Confirmation #</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-weight:700;font-size:13px;text-align:right">${confNum}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Property</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">${opts.source.property_address}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Job</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">${jobLabel}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Amount Received</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-weight:700;font-size:14px;text-align:right;color:${BRAND.green}">$${opts.amount.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        ${feeAmt > 0 ? `<tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Includes 3% Card Processing Fee</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">$${feeAmt.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>` : ""}
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Method</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">${methodLabel}</td></tr>
        ${opts.referenceNote ? `<tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Reference #</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">${opts.referenceNote}</td></tr>` : ""}
        <tr><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.gray};font-size:12.5px">Total Paid to Date</td><td style="padding:6px 0;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:right">$${opts.totalPaid.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:8px 0 0;color:${BRAND.gray};font-size:12.5px">${opts.reconciled ? "Balance" : "Balance Remaining"}</td><td style="padding:8px 0 0;font-weight:700;font-size:14px;text-align:right">${opts.reconciled ? "Paid in Full" : `$${opts.balanceRemaining.toLocaleString(undefined,{minimumFractionDigits:2})}`}</td></tr>
      </table>
      <div style="margin-top:18px;padding:12px 14px;background:#fdf3e7;border:1px solid #f0dcb8;border-radius:6px">
        <p style="font-size:11.5px;color:#5a4522;margin:0;line-height:1.55"><strong>Protect yourself from wire fraud:</strong> this email is your official receipt. We will <strong>never</strong> ask you to change payment instructions, wiring details, or account numbers by email alone. If you receive any message asking you to send funds a different way — even if it looks like it's from us — stop and call us directly at <strong>(904) 867-3984</strong> before sending anything.</p>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.source.client_email],
      cc: ADMIN_EMAILS,
      subject: `Payment Confirmation ${confNum} — ${opts.source.property_address}`,
      html,
    });
  } catch (err) {
    console.error("[Payments] confirmation email failed:", err);
  }
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
      ccFeeApplied,
    } = req.body || {};

    if (!PAYMENT_SOURCE_TYPES.includes(sourceType)) return res.status(400).json({ error: "Invalid sourceType" });
    if (!sourceId) return res.status(400).json({ error: "sourceId is required" });
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: "Invalid payment method" });
    if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be greater than 0" });
    if (!companyRepSignatureName || !clientSignatureName) {
      return res.status(400).json({ error: "Both Company Representative and Client signatures are required." });
    }

    // v20.47.1 — 3% CC fee, quick to apply at the moment of collecting ANY
    // payment (Alex: a client can say cash then switch to card right when
    // it's time to pay). `amount` from the client is always the base job
    // amount being collected for; the fee (if any) is computed server-side
    // and added on top — the stored `amount` column becomes the true total
    // collected so every downstream balance/reconciliation calc (which reads
    // that column) automatically reflects what actually came in, with no
    // separate code path to keep in sync.
    const baseAmount = Number(amount);
    const feeApplied = !!ccFeeApplied && method === "credit_card";
    const ccFeeAmount = feeApplied ? Math.round(baseAmount * CC_FEE_PCT * 100) / 100 : 0;
    const totalCollected = Math.round((baseAmount + ccFeeAmount) * 100) / 100;

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
        recorded_by_agent_id, notes, cc_fee_applied, cc_fee_amount, base_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      sourceType, sourceId, totalCollected, method, referenceNote || null,
      evidencePhotoUrl || null, receiptPhotoUrl || null, companyRepAgentId || null,
      companyRepSignatureName, clientSignatureName,
      req.currentAgent.id, notes || null,
      feeApplied ? 1 : 0, ccFeeAmount, baseAmount
    );

    // v20.38.3 — Alex: "Deposit in/awaiting deposit should trigger as
    // received when a payment is made so it doesn't show awaiting since
    // they just paid... those two things should be connected and smart."
    // Any recorded payment against a repair consult auto-flips
    // deposit_received_at the first time money comes in — no separate
    // manual "mark deposit received" tap needed. Idempotent: only fires
    // once, on whichever payment happens to be the first recorded.
    if (sourceType === "repair_consult") {
      const rc = rawDb.prepare(`SELECT deposit_received_at FROM repair_consults WHERE id = ?`).get(sourceId) as any;
      if (rc && !rc.deposit_received_at) {
        rawDb.prepare(`
          UPDATE repair_consults SET deposit_received_at = datetime('now'), deposit_received_by = ?,
            deposit_method = ?, deposit_reference = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(req.currentAgent.name || req.currentAgent.email || "Admin", method, referenceNote || null, sourceId);
      }
    }

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
            subject: `Payment received — $${totalCollected.toLocaleString(undefined, { minimumFractionDigits: 2 })} via ${method}${feeApplied ? ` (incl. $${ccFeeAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} 3% card fee)` : ""}`,
            body: `Recorded by ${req.currentAgent.name || req.currentAgent.email} for ${source.property_address}.${reconciled ? " Job paid in full." : ` Balance remaining: $${((source.total || 0) - paid).toLocaleString(undefined, { minimumFractionDigits: 2 })}.`}`,
          });
        }
        if (reconciled && sourceType === "repair_consult") {
          const meeting = rawDb.prepare(`SELECT fub_task_id FROM repair_project_meetings WHERE consult_id = ? AND meeting_type = 'final_payment'`).get(sourceId) as any;
          if (meeting?.fub_task_id) {
            await fubRequest("PUT", `/tasks/${meeting.fub_task_id}`, { isCompleted: true });
          }
        }
        // v20.32.28 — payment reconciled on an inspection order is the TC's
        // (Nate's) signal to actually place the order with the vendor.
        if (reconciled && sourceType === "inspection_order") {
          await notifyTCPaymentReceivedForInspectionOrder(sourceId);
        }
      } catch (err: any) {
        console.warn("[Payments] FUB tie-in failed:", err?.message || err);
      }
    })();

    // v20.33.3 — client-facing confirmation-number receipt email, same
    // fire-and-forget/non-fatal treatment as the FUB tie-in above.
    sendPaymentConfirmationEmail({
      paymentId: Number(result.lastInsertRowid),
      sourceType, source, amount: totalCollected, method, referenceNote,
      totalPaid: paid, contractTotal: source.total || 0,
      balanceRemaining: Math.max(0, (source.total || 0) - paid), reconciled,
      ccFeeAmount,
    }).catch((err) => console.warn("[Payments] confirmation email failed:", err?.message || err));

    res.json({
      ok: true,
      id: result.lastInsertRowid,
      confirmationNumber: paymentConfirmationNumber(Number(result.lastInsertRowid)),
      totalPaid: paid,
      contractTotal: source.total || 0,
      balanceRemaining: Math.max(0, (source.total || 0) - paid),
      reconciled,
      baseAmount,
      ccFeeAmount,
      totalCollected,
    });
  });

  // Single record lookup.
  app.get("/api/payments/:id", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    const row = rawDb.prepare(`SELECT * FROM payment_records WHERE id = ?`).get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: "Payment record not found" });
    res.json({ payment: row });
  });

  // v20.33.4 — Accounts Receivable admin tab. Unions repair_consults and
  // inspection_orders (the only two payment_records source types) into one
  // receivables ledger: total, paid-to-date (from payment_records), and
  // balance, plus a reference date for aging. Excludes draft/declined rows
  // (never billable) and anything with total <= 0 (nothing was ever owed).
  app.get("/api/admin/accounts-receivable", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const repairRows = rawDb.prepare(`
      SELECT
        'repair_consult' AS source_type, rc.id AS source_id,
        rc.property_address, rc.client_name, rc.client_email, rc.client_phone,
        a.name AS agent_name, rc.status, rc.total AS total,
        COALESCE((SELECT SUM(amount) FROM payment_records WHERE source_type = 'repair_consult' AND source_id = rc.id), 0) AS paid,
        COALESCE(rc.accepted_at, rc.work_order_sent_at, rc.created_at) AS reference_date,
        rc.completed_at AS completed_at
      FROM repair_consults rc
      LEFT JOIN agents a ON a.id = rc.agent_id
      WHERE rc.status NOT IN ('draft', 'declined') AND rc.total > 0
    `).all() as any[];
    const inspectionRows = rawDb.prepare(`
      SELECT
        'inspection_order' AS source_type, io.id AS source_id,
        io.property_address, io.client_name, io.client_email, io.client_phone,
        a.name AS agent_name, io.status, io.total AS total,
        COALESCE((SELECT SUM(amount) FROM payment_records WHERE source_type = 'inspection_order' AND source_id = io.id), 0) AS paid,
        COALESCE(io.accepted_at, io.created_at) AS reference_date,
        io.completed_at AS completed_at
      FROM inspection_orders io
      LEFT JOIN agents a ON a.id = io.agent_id
      WHERE io.status NOT IN ('draft', 'declined') AND io.total > 0
    `).all() as any[];

    const all = [...repairRows, ...inspectionRows].map(r => ({
      ...r,
      balance: Math.max(0, (r.total || 0) - (r.paid || 0)),
    }));

    const outstanding = all.filter(r => r.balance > 0.005);
    const paidInFull = all.filter(r => r.balance <= 0.005);

    // Oldest reference date first — the longest-outstanding balance surfaces
    // at the top, matching how any real AR aging report is read.
    outstanding.sort((a, b) => (a.reference_date || "").localeCompare(b.reference_date || ""));
    paidInFull.sort((a, b) => (b.reference_date || "").localeCompare(a.reference_date || ""));

    res.json({
      outstanding,
      paidInFull,
      totals: {
        totalOutstanding: outstanding.reduce((s, r) => s + r.balance, 0),
        totalCollected: all.reduce((s, r) => s + (r.paid || 0), 0),
        countOutstanding: outstanding.length,
      },
    });
  });
}
