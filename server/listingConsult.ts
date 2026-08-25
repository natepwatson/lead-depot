// ─── LISTING CONSULT ────────────────────────────────────────────────────────
// v20.14.0 — "Listing Consult" tool. Walks an agent through the full Seller
// Meet & Greet appointment without the agent needing to stare at their phone
// the whole time: quick checklist chips + a handful of fields per step,
// modeled on the same wizard shell as Repair Consult.
//
// v20.18.0 — FOUR-PAGE REDESIGN (Prep → Walkthrough & Intel → Close → Lock In).
//  - Merged the old Preview + Intel steps into one "Walkthrough & Intel" step.
//  - Close is now a single 3-way "Where are we?" control (ready now / ready,
//    repairs first / not moving forward) instead of four separate toggles.
//    Picking "not moving forward" reveals 4 outcomes INLINE — the standalone
//    Debrief page is gone entirely. Only "Consult Result" survived from the
//    old debrief; everything else (Notes/Upgrades/Tempo/Stage/Next Steps) was
//    cut per Alex's instruction.
//  - Lock In gained a first-class Cleaning Y/N (always asked), a direct
//    Repair Date/Time (shown only when Close said "repairs first" — never
//    re-asks a question already answered), a Showing Approval Contact picker
//    (Owner 1 / Owner 2 / Other) that replaces the old free-text Access
//    Phone, a Showing Restrictions field, and a derived (read-only) Access
//    Email. "Send Listing Contract" is now a real validation + summary gate,
//    not a plain button — confirming it is what actually records the Signed
//    outcome (Lead Depot active pipeline, FUB stage Active, TC notified).
//  - Outcome routing (Lead Depot / FUB stage / TC) lives in this file, using
//    a small self-contained FUB helper (pushListingConsultStageToFub) rather
//    than the cold-lead-oriented pushOutcomeToFub in fub.ts.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { storage } from "./storage";
import { fubRequest } from "./fub";
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
  green: "#008000",
};

// TC (transaction coordinator) notification — same temporary stand-in used by
// the "Place an Offer" tool (server/writeOffer.ts) until Alex confirms the
// real outside TC. Keep in sync with that file if the stand-in changes.
const TC_EMAIL = "nate@watsonbrothersgroup.com";
const TC_NAME = "Nate Watson";

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
      status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | archived | not_moving | signed
      data TEXT NOT NULL DEFAULT '{}',            -- JSON blob of every step's answers
      debrief_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const lcCols = (rawDb.prepare(`PRAGMA table_info(listing_consults)`).all() as any[]).map((c: any) => c.name);
  if (!lcCols.includes("hero_photo_url"))  rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN hero_photo_url TEXT").run();
  if (!lcCols.includes("gallery_photos"))  rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN gallery_photos TEXT").run();
  // v20.17.0 — tracks whether hero_photo_url came from a manual tap-to-photo
  // upload or the Street View auto-pull, so a later auto-fetch call never
  // clobbers a photo the agent deliberately took/chose.
  if (!lcCols.includes("hero_photo_source")) rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN hero_photo_source TEXT").run();
  // v20.28.0 — Scope Photos is a second, distinct upload moment (evidence for
  // exactly what got flagged during the walkthrough) that must survive a
  // resume/reopen just like gallery_photos does. Every scope photo is ALSO
  // pushed into gallery_photos (full evidence set) — this column exists only
  // so the UI can show the two buckets separately after reopening.
  if (!lcCols.includes("scope_photos")) rawDb.prepare("ALTER TABLE listing_consults ADD COLUMN scope_photos TEXT").run();
}

function getRow(id: number): any {
  const r: any = rawDb.prepare(`SELECT * FROM listing_consults WHERE id = ?`).get(id);
  if (r && r.gallery_photos) {
    try {
      const parsed = JSON.parse(r.gallery_photos);
      // Normalize legacy { url, tag } entries down to plain url strings — the
      // tag toggle UI was removed in v20.18.0, but old rows may still have it.
      r.gallery_photos = parsed.map((entry: any) => (typeof entry === "string" ? entry : entry?.url)).filter(Boolean);
    } catch { r.gallery_photos = []; }
  }
  // v20.28.0 — scope_photos rehydration, same normalization as gallery_photos.
  if (r) {
    if (r.scope_photos) {
      try { r.scope_photos = JSON.parse(r.scope_photos); } catch { r.scope_photos = []; }
    } else {
      r.scope_photos = [];
    }
  }
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
  return `<tr><td style="padding:4px 0;color:${BRAND.gray};width:170px;font-size:12.5px;vertical-align:top">${label}</td><td style="padding:4px 0;font-size:12.5px;color:#222">${value || "—"}</td></tr>`;
}

// v20.32.4 — Gate Code is now a gated Yes/No question. No → "No gate". Yes
// → code + guard/unmanned + gate-specific instructions, matching accessSummary's pattern.
function gateSummary(lockin: any): string {
  if (lockin.hasGate === "no") return "No gate";
  if (lockin.hasGate !== "yes") return "—";
  const code = lockin.gateCode || "—";
  const guard = lockin.gateGuarded === "yes" ? "Guard-attended" : lockin.gateGuarded === "no" ? "Unmanned" : "—";
  const how = lockin.gateAccessInstructions || "—";
  return `Code: ${code}. ${guard}. Access: ${how}`;
}

// v20.32.2 — Access is Key or Code (never a bare free-text string). Renders
// a one-line human summary for the signed-TC email.
function accessSummary(lockin: any): string {
  if (lockin.accessType === "key") {
    const exchanged = lockin.keyInLockbox === "yes" ? "Yes — key is in the lockbox for the agent" : lockin.keyInLockbox === "no" ? "No — key NOT yet exchanged/in lockbox" : "—";
    return `Key. Exchanged &amp; in lockbox? ${exchanged}`;
  }
  if (lockin.accessType === "code") {
    const code = lockin.accessCode || lockin.accessKeyOrCode || "—";
    const how = lockin.accessCodeInstructions || "—";
    return `Code: ${code}. How to get in: ${how}`;
  }
  return lockin.accessKeyOrCode || "—";
}

// v20.19.x — Timeline Forecast rendering for the signed-TC email. Dates are
// saved as plain ISO strings by the client; format here without pulling in a
// date library.
function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "—";
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function timelineForecastTable(lockin: any): string {
  const rows: Array<[string, string]> = [];
  if (lockin.repairWindowStart && lockin.repairWindowEnd) {
    rows.push(["Repairs Window", `${fmtDateShort(lockin.repairWindowStart)} – ${fmtDateShort(lockin.repairWindowEnd)}`]);
  }
  if (lockin.forecastCleaningDate) rows.push(["Cleaning", fmtDateShort(lockin.forecastCleaningDate)]);
  if (lockin.photosScheduledDate) rows.push(["Photos Scheduled", fmtDateShort(lockin.photosScheduledDate)]);
  if (lockin.photosBackDate) rows.push(["Photo/Video Back", fmtDateShort(lockin.photosBackDate)]);
  if (!rows.length && !lockin.goLiveDate && !lockin.openHouseDate) return "";
  const bodyRows = rows.map(([label, value]) => `
      <tr><td style="padding:3px 0;color:${BRAND.gray};width:170px;font-size:12.5px;vertical-align:top">${label}</td><td style="padding:3px 0;font-size:12.5px;color:#222">${value}</td></tr>`).join("");
  const goLive = lockin.goLiveDate ? `<tr><td style="padding:6px 0;color:${BRAND.gray};width:170px;font-size:12.5px;font-weight:700">Go-Live</td><td style="padding:6px 0;font-size:13px;font-weight:700;color:#8a6d1d">${fmtDateShort(lockin.goLiveDate)}</td></tr>` : "";
  const openHouse = lockin.openHouseDate ? `<tr><td style="padding:6px 0;color:${BRAND.gray};width:170px;font-size:12.5px;font-weight:700">Open House</td><td style="padding:6px 0;font-size:13px;font-weight:700;color:#8a6d1d">${fmtDateShort(lockin.openHouseDate)}</td></tr>` : "";
  return `
    <div style="padding:0 32px 8px">
      <p style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.gray};margin:14px 0 6px;font-weight:700">Timeline Forecast${lockin.forecastStartDate ? ` (from ${fmtDateShort(lockin.forecastStartDate)})` : ""}</p>
      <table style="width:100%">${bodyRows}${goLive}${openHouse}</table>
      <p style="font-size:10.5px;color:${BRAND.gray};margin:6px 0 0;font-style:italic">Forecasted, not booked — repairs and cleaning are scheduled separately once the instant quote is confirmed.</p>
    </div>`;
}

const NOT_MOVING_LABELS: Record<string, string> = {
  pending_repair_quote: "Not ready — pending repair quote",
  other_reason: "Not ready — other reason",
  listed_other_agent: "Listed with another agent",
  not_interested: "Not interested",
};

// v20.32.23 — Optional Listing Agreement Addenda, selected on the Close
// step. Keys must match ADDENDA_OPTIONS in ListingConsultSheet.tsx.
const ADDENDA_LABELS: Record<string, string> = {
  repair_work: "Repair Work & Listing Agreement Addendum",
  personal_property: "Personal Property Addendum — Chairlift & Generator",
};

function addendaSummary(close: any): string {
  const keys: string[] = Array.isArray(close?.selectedAddenda) ? close.selectedAddenda : [];
  if (!keys.length) return "";
  return keys.map(k => ADDENDA_LABELS[k] || k).join(", ");
}

// ─── EMAIL: "Not moving forward" outcome sent to office admin ──────────────
async function sendNotMovingForwardEmail(consultId: number) {
  if (!resend) return;
  const r = getRow(consultId);
  if (!r) return;
  const d = parseData(r);
  const close = d.close || {};

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Listing Consult — Not Moving Forward", r.property_address)}
    <div style="padding:20px 32px">
      <table style="width:100%">
        ${row("Agent", getAgentName(r.agent_id))}
        ${row("Client", r.client_name || "—")}
        ${row("Client Contact", [r.client_email, r.client_phone].filter(Boolean).join(" · ") || "—")}
        ${row("Consult Result", NOT_MOVING_LABELS[close.notMovingReason] || close.notMovingReason || "—")}
      </table>
      <div style="margin-top:14px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px;font-size:12.5px;color:#333;line-height:1.6">
        <strong>Notes:</strong> ${close.notMovingNotes || "—"}<br/>
        <strong>Walkthrough:</strong> ${d.walkthrough?.needsRepairs ? "Needs repairs" : "No repairs flagged"} — ${d.walkthrough?.notes || "—"}<br/>
        <strong>Timeline:</strong> ${d.walkthrough?.timeline || "—"} · <strong>Mortgage balance:</strong> ${d.walkthrough?.mortgageBalance || "—"}<br/>
        <strong>Recommended list price:</strong> ${close.recommendedPrice || "—"}
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAILS,
    subject: `Listing Consult — ${NOT_MOVING_LABELS[close.notMovingReason] || "Not moving forward"} — ${r.property_address}`,
    html,
  });
}

// ─── EMAIL: Signed — notifies TC (CC admins) to open the file ──────────────
async function sendSignedTcEmail(consultId: number) {
  if (!resend) return;
  const r = getRow(consultId);
  if (!r) return;
  const d = parseData(r);
  const close = d.close || {};
  const lockin = d.lockin || {};

  const commissionLine = `${close.listingAgentCommission || "3.0"}% listing / ${close.buyerAgentCommission || "2.5"}% buyer's`;
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("New Signed Listing — Please Open File", r.property_address)}
    <div style="padding:20px 32px">
      <table style="width:100%">
        ${row("Listing Agent", getAgentName(r.agent_id))}
        ${row("Owner(s)", [lockin.ownerNames, lockin.ownerNames2].filter(Boolean).join(" & ") || r.client_name || "—")}
        ${row("Client Contact", [r.client_email, r.client_phone].filter(Boolean).join(" · ") || "—")}
        ${row("Final Listing Price", close.finalListingPrice || "—")}
        ${row("Commission", commissionLine)}
        ${close.additionalTerms ? row("Additional Terms", close.additionalTerms) : ""}
        ${row("Timeline", d.walkthrough?.timeline || "—")}
        ${addendaSummary(close) ? `<tr><td style="padding:6px 0;color:${BRAND.gray};width:170px;font-size:12.5px;font-weight:700;vertical-align:top">Addenda for DocuSign</td><td style="padding:6px 0;font-size:13px;font-weight:700;color:#8a6d1d">${addendaSummary(close)}</td></tr>` : ""}
        ${row("Access", accessSummary(lockin))}
        ${row("Gate", gateSummary(lockin))}
        ${row("Showing Approval Contact", lockin.showingContactName || "—")}
        ${row("Showing Restrictions", lockin.showingRestrictions || "—")}
        ${row("Cleaning Needed", lockin.needsCleaning === "yes" ? "Yes — see forecast below" : "No")}
      </table>
    </div>
    ${timelineForecastTable(lockin)}
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: [TC_EMAIL],
    cc: ADMIN_EMAILS,
    subject: `Signed Listing — Please Open File — ${r.property_address}`,
    html,
  });
}

// v20.17.0 — Auto front-of-house photo via Google Street View Static API.
// Entirely optional at the infra level: with no GOOGLE_MAPS_API_KEY set, this
// quietly reports "not found" and the existing manual tap-to-photo flow is
// untouched.
async function fetchStreetViewPhoto(address: string): Promise<Buffer | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !address?.trim()) return null;
  const loc = encodeURIComponent(address.trim());
  try {
    const metaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&key=${key}`);
    const meta = await metaRes.json().catch(() => ({} as any));
    if (meta?.status !== "OK") return null; // ZERO_RESULTS (no imagery here), REQUEST_DENIED (bad/missing key or API not enabled), etc.
    const imgRes = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=640x400&fov=80&location=${loc}&key=${key}`);
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (err) {
    console.error("Street View fetch error:", err);
    return null;
  }
}

// ─── FUB — self-contained stage push for Listing Consult outcomes ──────────
// Deliberately NOT reusing pushOutcomeToFub from fub.ts — that helper is
// overfit to the cold-lead action-plan/deal model. Listing Consult only
// needs to resolve/create the FUB person, set their stage, and leave a note.

let fubStageCache: Record<string, number> | null = null;

async function resolveFubStageId(name: string): Promise<number | null> {
  if (!fubStageCache) {
    const res = await fubRequest("GET", "/stages?limit=100");
    if (res.ok && Array.isArray(res.data?.stages)) {
      fubStageCache = {};
      for (const s of res.data.stages) {
        if (s?.name) fubStageCache[String(s.name).toLowerCase()] = s.id;
      }
    }
  }
  return fubStageCache?.[name.toLowerCase()] ?? null;
}

async function resolveFubPersonId(opts: { fubPersonId?: string | number; phone?: string; name?: string }): Promise<number | null> {
  if (opts.fubPersonId) return Number(opts.fubPersonId);
  if (opts.phone) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.phone)}&limit=1`);
    const id = r.data?.people?.[0]?.id;
    if (id) return id;
  }
  if (opts.name) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.name)}&limit=1`);
    const id = r.data?.people?.[0]?.id;
    if (id) return id;
  }
  return null;
}

async function pushListingConsultStageToFub(opts: {
  fubPersonId?: string | number;
  phone?: string;
  name?: string;
  stageName: "Active" | "Hot Prospect" | "Nurture" | "Trash";
  note: string;
  subject?: string;
}): Promise<{ ok: boolean; personId: number | null }> {
  let personId = await resolveFubPersonId(opts);

  if (!personId) {
    // No existing FUB person found — create one via /events so Lead Flow and
    // dedup rules still apply (per the codebase-wide rule: never POST /people
    // directly).
    const [firstName, ...rest] = (opts.name || "Listing Consult Contact").split(" ");
    const eventPayload: any = {
      source: "Lead Depot",
      system: "LeadDepot",
      type: "General Inquiry",
      person: {
        firstName: firstName || "Unknown",
        lastName: rest.join(" ") || "Contact",
        phones: opts.phone ? [{ value: opts.phone }] : [],
      },
      message: opts.note,
    };
    const evRes = await fubRequest("POST", "/events", eventPayload);
    personId = evRes.data?.person?.id || evRes.data?.personId || null;
  }

  if (!personId) {
    console.warn("[ListingConsult→FUB] Could not resolve or create FUB person — skipping stage push");
    return { ok: false, personId: null };
  }

  const stageId = await resolveFubStageId(opts.stageName);
  if (stageId) {
    await fubRequest("PUT", `/people/${personId}`, { stageId });
  } else {
    await fubRequest("PUT", `/people/${personId}`, { stage: opts.stageName });
  }

  await fubRequest("POST", "/notes", { personId, subject: opts.subject || "Listing Consult", body: opts.note, isHtml: false });

  return { ok: true, personId };
}

// ─── Lead Depot lead creation helpers ──────────────────────────────────────
// ListingConsultSheet is always launched with leadId=null — there is no
// originating lead row to update, so outcomes that need Lead Depot pipeline
// visibility CREATE a brand-new lead rather than updating one.

function createKeepInTouchLeadFromConsult(r: any, data: any, reason: string): number {
  const lead = storage.createLead({
    leadType: "listing_consult",
    address: r.property_address || "Unknown address",
    ownerName: r.client_name || null,
    phone: r.client_phone || null,
    email: r.client_email || null,
    motivation: data.close?.notMovingNotes || NOT_MOVING_LABELS[reason] || "Listing consult follow-up",
    extraData: JSON.stringify({ source: "listing_consult", consultId: r.id, notMovingReason: reason }),
    status: "keep_in_touch",
    assignedAgentId: r.agent_id || null,
    attemptCount: 0,
    source: "manual",
  } as any);
  const followUp = data.close?.notMovingFollowUpTiming;
  if (followUp) {
    try { rawDb.prepare(`UPDATE leads SET follow_up_timing = ? WHERE id = ?`).run(followUp, lead.id); } catch {}
  }
  return lead.id;
}

function createSignedLeadFromConsult(r: any, data: any): number {
  const close = data.close || {};
  const lockin = data.lockin || {};
  const lead = storage.createLead({
    leadType: "listing_consult",
    address: r.property_address || "Unknown address",
    ownerName: [lockin.ownerNames, lockin.ownerNames2].filter(Boolean).join(" & ") || r.client_name || null,
    phone: r.client_phone || null,
    email: r.client_email || null,
    motivation: `Signed — final price ${close.finalListingPrice || "—"}`,
    extraData: JSON.stringify({ source: "listing_consult", consultId: r.id, finalListingPrice: close.finalListingPrice, whereAreWe: close.whereAreWe }),
    status: "signed",
    assignedAgentId: r.agent_id || null,
    attemptCount: 0,
    source: "manual",
    listPrice: Number(String(close.finalListingPrice || "").replace(/[^0-9.]/g, "")) || null,
  } as any);
  return lead.id;
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
  //    /photo endpoint exactly — same compression pass, same response shape.
  //    v20.18.0 — gallery entries are now plain URL strings; the tag toggle UI
  //    was removed from the frontend, so `tag` is accepted-but-ignored here for
  //    backward compatibility with any in-flight consults. ──
  app.post("/api/listing-consult/:id/photo", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { imageData, mimeType, kind, bucket } = req.body || {}; // kind: 'hero' | 'gallery'; bucket: 'walkthrough' | 'scope' (gallery only, v20.28.0)
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
        rawDb.prepare(`UPDATE listing_consults SET hero_photo_url = ?, hero_photo_source = 'manual', updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
      } else if (kind === "gallery") {
        const row = rawDb.prepare(`SELECT gallery_photos, scope_photos FROM listing_consults WHERE id = ?`).get(consultId) as any;
        // v20.32.1 — FIX: Scope Photos and Walkthrough Photos are two
        // distinct buckets and must stay fully separate. Previously every
        // scope-bucket upload was ALSO appended to gallery_photos, so it
        // showed up duplicated under Walkthrough Photos too. Now each
        // upload lands in exactly one bucket based on which uploader sent it.
        if (bucket === "scope") {
          let scopeArr: string[] = [];
          try { scopeArr = row?.scope_photos ? JSON.parse(row.scope_photos) : []; } catch { scopeArr = []; }
          scopeArr.push(url);
          rawDb.prepare(`UPDATE listing_consults SET scope_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(scopeArr), consultId);
        } else {
          const raw = row?.gallery_photos ? JSON.parse(row.gallery_photos) : [];
          const arr = raw.map((entry: any) => (typeof entry === "string" ? entry : entry?.url)).filter(Boolean);
          arr.push(url);
          rawDb.prepare(`UPDATE listing_consults SET gallery_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(arr), consultId);
        }
      }
      res.json({ url });
    } catch (err: any) {
      console.error("Listing consult photo processing error:", err);
      res.status(500).json({ error: "Failed to process image." });
    }
  });

  // ── In-progress consults for this agent (resume picker). MUST be
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

  // ── Archive an unfinished consult (soft-delete). ──
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

  // ── Merge-patch step data. Body: { section: "walkthrough", patch: {...} }
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

  // ── v20.18.0 — "Not moving forward" inline outcome (replaces the old
  //    standalone Debrief page entirely). Body: { reason, notes?, followUpTiming? }
  //    reason ∈ pending_repair_quote | other_reason | listed_other_agent | not_interested.
  //    Ends the flow — no Lock In step is reached for any of these 4. ──
  app.post("/api/listing-consult/:id/not-moving", async (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const r = getRow(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    const { reason, notes, followUpTiming } = req.body || {};
    if (!NOT_MOVING_LABELS[reason]) return res.status(400).json({ error: "Invalid reason" });

    const data = parseData(r);
    data.close = {
      ...(data.close || {}),
      whereAreWe: "not_moving",
      notMovingReason: reason,
      notMovingNotes: notes || "",
      notMovingFollowUpTiming: followUpTiming || "",
    };
    rawDb.prepare(`
      UPDATE listing_consults SET data = ?, status = 'not_moving', updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(data), id);

    const stageMap: Record<string, "Hot Prospect" | "Nurture" | "Trash"> = {
      pending_repair_quote: "Hot Prospect",
      other_reason: "Nurture",
      listed_other_agent: "Trash",
      not_interested: "Nurture",
    };
    const stageName = stageMap[reason];

    let newLeadId: number | null = null;
    if (reason === "pending_repair_quote" || reason === "other_reason") {
      try { newLeadId = createKeepInTouchLeadFromConsult(r, data, reason); }
      catch (err) { console.error("[ListingConsult] KIT lead creation failed:", err); }
    }

    // Best-effort — never blocks the response.
    pushListingConsultStageToFub({
      fubPersonId: data.prep?.fubPersonId,
      phone: r.client_phone,
      name: r.client_name,
      stageName,
      note: `Listing consult at ${r.property_address} — outcome: ${NOT_MOVING_LABELS[reason]}.${notes ? " Notes: " + notes : ""}`,
    }).catch((err) => console.error("[ListingConsult→FUB] stage push failed:", err));

    sendNotMovingForwardEmail(id).catch((err) => console.error("[ListingConsult] not-moving email failed:", err));

    res.json({ ok: true, newLeadId });
  });

  // ── v20.18.0 — "Send Listing Contract" final gate. Only reachable from
  //    Lock In, only after Close said ready_now/ready_repairs. Confirming
  //    records the Signed outcome: Lead Depot active pipeline lead, FUB stage
  //    Active, TC notified to open the file. ──
  app.post("/api/listing-consult/:id/send-contract", async (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const r = getRow(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    const data = parseData(r);
    const { patch } = req.body || {};
    if (patch) data.lockin = { ...(data.lockin || {}), ...patch };

    const close = data.close || {};
    if (close.whereAreWe !== "ready_now" && close.whereAreWe !== "ready_repairs") {
      return res.status(400).json({ error: "Consult is not in a ready state — cannot send contract." });
    }

    // Minimal server-side validation mirroring the client's gate — belt and
    // suspenders in case the client check is ever bypassed.
    const lockin = data.lockin || {};
    const missing: string[] = [];
    if (!lockin.ownerNames) missing.push("Owner 1 Legal Name");
    if (!r.property_address) missing.push("Property Address");
    if (!close.finalListingPrice) missing.push("Final Listing Price");
    if (!lockin.accessType) missing.push("Access: Key or Code");
    if (lockin.accessType === "code" && !lockin.accessCode) missing.push("Access Code");
    if (lockin.accessType === "key" && !lockin.keyInLockbox) missing.push("Key Exchanged To Lockbox? (Yes/No)");
    if (!lockin.showingApprovalContact) missing.push("Showing Approval Contact");
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}`, missing });

    rawDb.prepare(`
      UPDATE listing_consults SET data = ?, status = 'signed', debrief_sent_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(data), id);

    let newLeadId: number | null = null;
    try { newLeadId = createSignedLeadFromConsult(r, data); }
    catch (err) { console.error("[ListingConsult] Signed lead creation failed:", err); }

    pushListingConsultStageToFub({
      fubPersonId: data.prep?.fubPersonId,
      phone: r.client_phone,
      name: r.client_name,
      stageName: "Active",
      note: `Listing signed at ${r.property_address} — final price ${close.finalListingPrice || "—"}.`,
    }).catch((err) => console.error("[ListingConsult→FUB] stage push failed:", err));

    sendSignedTcEmail(id).catch((err) => console.error("[ListingConsult] TC email failed:", err));

    res.json({ ok: true, newLeadId });
  });
}
