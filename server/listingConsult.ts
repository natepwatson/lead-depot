// ─── LISTING CONSULT ────────────────────────────────────────────────────────
// v20.14.0 — "Listing Consult" tool. Walks an agent through the full Seller
// Meet & Greet appointment (per Brothers Group's printed Listing Flow, page 1
// only) without the agent needing to stare at their phone the whole time:
// quick checklist chips + a handful of fields per step, modeled on the same
// wizard shell as Repair Consult. The repair-scoping question lives INSIDE
// this flow (Step 2 — Preview the Home) and can hand off into the existing
// Repair Consult tool mid-appointment, returning to this flow afterward.
//
// Design notes:
//  - Kept intentionally lightweight vs. Repair Consult: no photo uploads, no
//    PDF/e-sign generation here — this is intel capture + relationship-
//    building structure, not a pricing engine. Photos/repairs are captured
//    via the linked Repair Consult record when the agent launches it.
//  - Schema uses a small set of top-level columns (for admin querying) plus
//    one flexible JSON `data` column holding every step's answers. Chosen
//    over one column per field to keep this fast to extend as the flow
//    evolves — matches Alex's "small, verified changes over big rewrites"
//    preference.
//  - "Tempo" in the debrief is a free-text field, NOT the Aggressive/
//    Balanced/Methodical taxonomy from the disregarded pricing-strategy page
//    of the source PDF — Alex asked to use page 1 only.
//  - Debrief step fires the same admin-summary pattern as Repair Consult:
//    CC'd to Alex + Nate + Denise per the standing instruction.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { Resend } from "resend";
import fs from "node:fs";
import path from "node:path";

const IS_PROD = process.env.NODE_ENV === "production";
function listingPhotosDir(): string {
  const dir = IS_PROD ? "/app/data/listing-photos" : path.resolve(__dirname, "public", "listing-photos");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];
const FROM = "Lead Depot <noreply@watsonbrothersgroup.com>";
const BRAND = {
  contactLine: "Alex & Nate Watson — (904) 504-3794 — www.brothersgroup.realestate",
  gray: "#808080",
  lightGray: "#f2f2f2",
  border: "#999999",
  black: "#0a0a0a",
};

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
export function ensureListingConsultSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS listing_consults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      agent_id INTEGER REFERENCES agents(id),
      client_name TEXT,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      hero_photo_url TEXT,
      gallery_photos TEXT,                        -- JSON array of walkthrough photo URLs
      status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | debriefed
      data TEXT NOT NULL DEFAULT '{}',            -- JSON blob of every step's answers
      debrief_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // v20.14.4 — front-of-house hero photo + walkthrough gallery, added to an
  // already-live table. ALTER TABLE is safe to run repeatedly — guarded by
  // PRAGMA table_info check, same pattern as server/db.ts and repairConsult.ts.
  const lcCols = (rawDb.prepare(`PRAGMA table_info(listing_consults)`).all() as any[]).map((c: any) => c.name);
  if (!lcCols.includes("hero_photo_url"))  rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN hero_photo_url TEXT").run();
  if (!lcCols.includes("gallery_photos"))  rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN gallery_photos TEXT").run();
}

function getRow(id: number): any {
  const r: any = rawDb.prepare(`SELECT * FROM listing_consults WHERE id = ?`).get(id);
  if (r && r.gallery_photos) { try { r.gallery_photos = JSON.parse(r.gallery_photos); } catch { r.gallery_photos = []; } }
  return r;
}

function getAgentName(agentId: number | null): string {
  if (!agentId) return "—";
  const row = rawDb.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as any;
  return row?.name || "—";
}

function parseData(row: any): any {
  try { return JSON.parse(row?.data || "{}"); } catch { return {}; }
}

function brandedHeader(title: string, subtitle: string): string {
  return `
  <div style="padding:24px 32px;background:${BRAND.black};color:#fff">
    <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin:0 0 6px">Brothers Group at Momentum Realty</p>
    <h1 style="font-size:19px;margin:0;font-weight:700">${title}</h1>
    <p style="font-size:12.5px;color:rgba(255,255,255,0.7);margin:6px 0 0">${subtitle}</p>
  </div>`;
}

function brandedFooter(): string {
  return `
  <div style="padding:16px 32px;background:${BRAND.gray};color:#fff;font-size:11px;text-align:center">
    ${BRAND.contactLine}
  </div>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 0;color:${BRAND.gray};width:150px;font-size:12.5px;vertical-align:top">${label}</td><td style="padding:4px 0;font-size:12.5px;color:#222">${value || "—"}</td></tr>`;
}

function checklistLine(label: string, items: Record<string, boolean> | undefined): string {
  if (!items) return `${label}: —`;
  const done = Object.entries(items).filter(([, v]) => v).map(([k]) => k);
  return `${label}: ${done.length ? done.join(", ") : "none checked"}`;
}

// ─── EMAIL: Debrief sent to office admin ────────────────────────────────────
async function sendDebriefEmail(consultId: number) {
  if (!resend) return;
  const r = getRow(consultId);
  if (!r) return;
  const d = parseData(r);
  const debrief = d.debrief || {};

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Listing Consult — Debrief", r.property_address)}
    <div style="padding:20px 32px">
      <table style="width:100%">
        ${row("Agent", getAgentName(r.agent_id))}
        ${row("Client", r.client_name || "—")}
        ${row("Client Contact", [r.client_email, r.client_phone].filter(Boolean).join(" · ") || "—")}
        ${row("Consult Result", debrief.result || "—")}
        ${row("Ready to Move Forward", d.close?.readyToStart || "—")}
        ${row("Tempo", debrief.tempo || "—")}
        ${row("Stage", debrief.stage || "—")}
      </table>
      <div style="margin-top:14px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px;font-size:12.5px;color:#333;line-height:1.6">
        <strong>Preview / Repairs:</strong> ${d.preview?.needsRepairs ? "Needs repairs — " + (d.preview?.repairNotes || "see Repair Consult record") : "No repairs flagged"}<br/>
        <strong>Intel:</strong> Desired price ${d.intel?.desiredPrice || "—"} · Motivation ${d.intel?.motivation || "—"} · Mortgage balance ${d.intel?.mortgageBalance || "—"} · Timeline ${d.intel?.timeline || "—"}<br/>
        <strong>Presentation covered:</strong> ${checklistLine("", d.presentation?.covered)}<br/>
        <strong>Recommended list price:</strong> ${d.pricing?.recommendedPrice || "—"}<br/>
        <strong>What's holding them back:</strong> ${d.close?.holdingBack || "—"}<br/>
        ${d.close?.readyToStart === "yes" ? `<strong>Lock-in schedule:</strong> ${checklistLine("", d.lockin?.schedule)}<br/><strong>Access:</strong> ${d.lockin?.accessNotes || "—"}<br/>` : ""}
        <strong>Notes:</strong> ${debrief.notes || "—"}<br/>
        <strong>Upgrades noted:</strong> ${debrief.upgrades || "—"}<br/>
        <strong>Next steps:</strong> ${debrief.nextSteps || "—"}
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAILS,
    subject: `Listing Consult Debrief — ${r.property_address}`,
    html,
  });
}

export function registerListingConsultRoutes(app: Express) {
  ensureListingConsultSchema();

  // ── Create consult ──
  app.post("/api/listing-consult", (req: any, res: Response) => {
    const { leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress, heroPhotoUrl } = req.body || {};
    if (!propertyAddress) return res.status(400).json({ error: "propertyAddress is required" });
    const result = rawDb.prepare(`
      INSERT INTO listing_consults (lead_id, agent_id, client_name, client_email, client_phone, property_address, hero_photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(leadId || null, agentId || req.currentAgent?.id || null, clientName || null, clientEmail || null, clientPhone || null, propertyAddress, heroPhotoUrl || null);
    res.json({ id: result.lastInsertRowid });
  });

  // ── Upload a photo (hero or gallery). Returns a URL. Mirrors Repair Consult's
  //    /photo endpoint exactly — same compression pass, same response shape. ──
  app.post("/api/listing-consult/:id/photo", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { imageData, mimeType, kind } = req.body || {}; // kind: 'hero' | 'gallery'
    if (!imageData || !mimeType) return res.status(400).json({ error: "Missing imageData or mimeType" });
    if (imageData.length > 28000000) return res.status(413).json({ error: "Image too large. Max 20MB." });
    try {
      const sharp = require("sharp");
      const inputBuf = Buffer.from(imageData, "base64");
      const rotated = await sharp(inputBuf).rotate().toBuffer();
      const processed = await sharp(rotated).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, progressive: true }).toBuffer();
      const dir = listingPhotosDir();
      const filename = `${consultId}-${kind || "photo"}-${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir, filename), processed);
      const url = `/listing-photos/${filename}`;

      if (kind === "hero") {
        rawDb.prepare(`UPDATE listing_consults SET hero_photo_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
      } else if (kind === "gallery") {
        const row = rawDb.prepare(`SELECT gallery_photos FROM listing_consults WHERE id = ?`).get(consultId) as any;
        const arr = row?.gallery_photos ? JSON.parse(row.gallery_photos) : [];
        arr.push(url);
        rawDb.prepare(`UPDATE listing_consults SET gallery_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(arr), consultId);
      }
      res.json({ url });
    } catch (err: any) {
      console.error("Listing consult photo processing error:", err);
      res.status(500).json({ error: "Failed to process image." });
    }
  });

  // ── v20.14.5 — In-progress consults for this agent (resume picker). MUST be
  //    registered before the "/:id" GET below — otherwise Express would try
  //    to parse "mine" as a numeric id and 404. ──
  app.get("/api/listing-consult/mine", (req: any, res: Response) => {
    const agentId = parseInt(req.query.agentId as string) || req.currentAgent?.id || null;
    if (!agentId) return res.json({ consults: [] });
    const rows = rawDb.prepare(`
      SELECT id, property_address, client_name, status, updated_at, created_at
      FROM listing_consults
      WHERE agent_id = ? AND status = 'in_progress'
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(agentId);
    res.json({ consults: rows });
  });

  // ── v20.14.6 — Archive an unfinished consult (soft-delete). Sets status to
  //    'archived' so it drops out of /mine and the resume picker without
  //    losing the underlying record — same pattern as every other soft-
  //    delete in this app (agents, leads). Registered before the "/:id" GET
  //    below for consistency, though the more specific path wouldn't
  //    conflict either way. ──
  app.post("/api/listing-consult/:id/archive", (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const row = getRow(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    rawDb.prepare(`UPDATE listing_consults SET status = 'archived', updated_at = datetime('now') WHERE id = ?`).run(id);
    res.json({ archived: true });
  });

  // ── Fetch a consult ──
  app.get("/api/listing-consult/:id", (req: any, res: Response) => {
    const r = getRow(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: "Not found" });
    res.json({ ...r, data: parseData(r) });
  });

  // ── Merge-patch step data. Body: { section: "preview", patch: {...} }
  //    also accepts top-level client/address updates so later steps can
  //    correct info captured in the "prep" step. ──
  app.post("/api/listing-consult/:id/data", (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const r = getRow(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    const { section, patch, clientName, clientEmail, clientPhone, propertyAddress } = req.body || {};
    const data = parseData(r);
    if (section) data[section] = { ...(data[section] || {}), ...(patch || {}) };
    rawDb.prepare(`
      UPDATE listing_consults SET
        data = ?, updated_at = datetime('now'),
        client_name = COALESCE(?, client_name),
        client_email = COALESCE(?, client_email),
        client_phone = COALESCE(?, client_phone),
        property_address = COALESCE(?, property_address)
      WHERE id = ?
    `).run(JSON.stringify(data), clientName || null, clientEmail || null, clientPhone || null, propertyAddress || null, id);
    res.json({ ok: true, data });
  });

  // ── Debrief: save final step + email admin summary ──
  app.post("/api/listing-consult/:id/debrief", async (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const r = getRow(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    const data = parseData(r);
    data.debrief = { ...(data.debrief || {}), ...(req.body || {}) };
    rawDb.prepare(`
      UPDATE listing_consults SET data = ?, status = 'debriefed', debrief_sent_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(data), id);
    try { await sendDebriefEmail(id); } catch (err) { console.error("Listing consult debrief email error:", err); }
    res.json({ ok: true });
  });
}
