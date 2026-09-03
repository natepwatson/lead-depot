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
import { awardPoints } from "./points";
import { fubRequest } from "./fub";
import { Resend } from "resend";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";

const IS_PROD = process.env.NODE_ENV === "production";
function listingPhotosDir(): string {
  const dir = IS_PROD ? "/app/data/listing-photos" : path.resolve(__dirname, "public", "listing-photos");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// v20.53.0 — Admin "Listing Consults" report PDF. Self-contained pdf-lib
// helpers (deliberately NOT importing from repairConsult.ts to avoid coupling
// two unrelated features) mirroring the same Brothers Group black/white
// letterhead styling already used on Repair Consult quotes/agreements.
function listingReportsDir(): string {
  const dir = IS_PROD ? "/app/data/listing-reports" : path.resolve(__dirname, "public", "listing-reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function brandLogoPath(): string {
  const prodPath = "/app/dist/public/brand-logo.jpg";
  const devPath = path.resolve(__dirname, "public", "brand-logo.jpg");
  return IS_PROD && fs.existsSync(prodPath) ? prodPath : devPath;
}

// Listing Consult photos only ever live under /listing-photos (no cross-tool
// hand-off ambiguity like Repair Consult has), so this resolver is simpler.
function resolveListingPhotoPath(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("/listing-photos/")) return null;
  return path.join(listingPhotosDir(), path.basename(url));
}

// Draws an image into a fixed box without distorting its aspect ratio,
// centering it and filling any letterbox margin with black — matches the
// same technique used on Repair Consult PDFs.
function drawContainedImage(
  page: any,
  img: any,
  box: { x: number; y: number; width: number; height: number },
  background = rgb(0, 0, 0)
) {
  page.drawRectangle({ x: box.x, y: box.y - box.height, width: box.width, height: box.height, color: background });
  const { width: drawW, height: drawH } = img.scaleToFit(box.width, box.height);
  const drawX = box.x + (box.width - drawW) / 2;
  const drawY = box.y - box.height + (box.height - drawH) / 2;
  page.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
}

// v20.54.0 — some summary helpers (accessSummary etc.) bake in literal HTML
// entities (e.g. "&amp;") because they're shared with HTML email rendering.
// The PDF draws raw text, not HTML, so decode entities before wrapping —
// otherwise "&amp;" prints literally instead of "&".
function decodeHtmlEntities(str: string): string {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function wrapReportText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = decodeHtmlEntities(String(text || "")).replace(/\r\n|\r|\n/g, " ").split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const test = current ? current + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const PILLAR_LABELS: Record<string, string> = {
  pressure_wash: "Pressure / Soft Washing",
  lawn: "Lawn & Landscaping",
  paint: "Touch-Up / Painting",
  deep_clean: "Deep Cleaning",
  junk_out: "Junk Out",
  flooring: "Flooring",
};
const TIER_LABELS: Record<string, string> = { small: "Small", medium: "Medium", large: "Large" };

function humanize(key: string): string {
  return String(key || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];
const FROM = "The Brothers Group Real Estate Team <noreply@watsonbrothersgroup.com>";
const BRAND = {
  contactLine: "Alex & Nate Watson — (904) 867-3984 — www.brothersgroup.realestate",
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

// v20.32.24 — Pets-during-showings plan, asked on Lock In right before
// Access. Keys must match PET_SHOWING_PLAN_OPTIONS in ListingConsultSheet.tsx.
const PET_SHOWING_PLAN_LABELS: Record<string, string> = {
  kenneled: "Kenneled/crated during showings",
  removed: "Removed from the home during showings",
  contained: "Contained in a room/garage during showings",
  other: "Other",
};

function petsSummary(lockin: any): string {
  if (lockin?.hasPets !== "yes") return lockin?.hasPets === "no" ? "No" : "—";
  const plan = lockin.petShowingPlan === "other" ? (lockin.petShowingPlanOther || "Other — details TBD") : (PET_SHOWING_PLAN_LABELS[lockin.petShowingPlan] || "Plan TBD");
  return `Yes — ${plan}`;
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
        ${row("Home Occupied", lockin.homeOccupied === "yes" ? "Yes" : lockin.homeOccupied === "no" ? "No" : "—")}
        ${row("Pets", petsSummary(lockin))}
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

// v20.53.0 — Admin "Listing Consult Report" PDF. Property/client/agent info,
// every walkthrough answer by section, lock-in details, final price, signed
// date, and every photo (hero + gallery + scope) — styled like the existing
// Brothers Group black-and-white letterhead used on Repair Consult PDFs.
export async function generateListingConsultReportPdf(consultId: number): Promise<string> {
  const r = getRow(consultId);
  if (!r) throw new Error("Listing consult not found");
  const d = parseData(r);
  const prep = d.prep || {};
  const walkthrough = d.walkthrough || {};
  const close = d.close || {};
  const lockin = d.lockin || {};
  const pillarFlags: Record<string, any> = walkthrough.pillars || {};

  const PAGE_W = 612, PAGE_H = 792;
  const marginX = 38;
  const black = rgb(0, 0, 0);
  const white = rgb(1, 1, 1);
  const gray = rgb(0.45, 0.45, 0.45);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const gold = rgb(0.55, 0.45, 0.24);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 40;

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - 40;
  }
  function ensureSpace(needed: number) {
    if (y - needed < 50) newPage();
  }
  function sectionHeader(title: string) {
    ensureSpace(30);
    y -= 4;
    page.drawRectangle({ x: marginX, y: y - 18, width: PAGE_W - marginX * 2, height: 18, color: black });
    page.drawText(title.toUpperCase(), { x: marginX + 6, y: y - 13, size: 10, font: fontBold, color: white });
    y -= 30;
  }
  function fieldRow(label: string, value: string) {
    const val = value && String(value).trim() ? String(value) : "—";
    const lines = wrapReportText(val, font, 10, PAGE_W - marginX * 2 - 160);
    ensureSpace(14 * Math.max(1, lines.length));
    page.drawText(label, { x: marginX, y, size: 9.5, font: fontBold, color: gray });
    lines.forEach((line, i) => {
      page.drawText(line, { x: marginX + 155, y: y - i * 13, size: 10, font, color: black });
    });
    y -= 13 * Math.max(1, lines.length) + 4;
  }
  function paragraph(text: string) {
    const val = text && String(text).trim() ? String(text) : "—";
    const lines = wrapReportText(val, font, 10, PAGE_W - marginX * 2);
    ensureSpace(13 * lines.length + 6);
    lines.forEach((line) => {
      page.drawText(line, { x: marginX, y, size: 10, font, color: black });
      y -= 13;
    });
    y -= 6;
  }

  // ── Logo ──
  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const w = 200;
    const h = w * (logoImg.height / logoImg.width);
    page.drawImage(logoImg, { x: (PAGE_W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 18;
  } catch { y -= 10; }

  const title = "Listing Consult Report";
  const titleWidth = fontBold.widthOfTextAtSize(title, 18);
  page.drawText(title, { x: (PAGE_W - titleWidth) / 2, y, size: 18, font: fontBold, color: black });
  y -= 24;

  // ── Property address bar ──
  page.drawRectangle({ x: marginX, y: y - 22, width: PAGE_W - marginX * 2, height: 22, color: black });
  page.drawText(r.property_address || "—", { x: marginX + 5, y: y - 15, size: 10.5, font: fontBold, color: white });
  const statusLabel = humanize(r.status);
  const statusW = fontBold.widthOfTextAtSize(statusLabel, 9);
  page.drawText(statusLabel, { x: PAGE_W - marginX - statusW - 6, y: y - 15, size: 9, font: fontBold, color: rgb(0.85, 0.75, 0.45) });
  y -= 40;

  // ── Hero photo ──
  if (r.hero_photo_url) {
    try {
      const p = resolveListingPhotoPath(r.hero_photo_url);
      if (p && fs.existsSync(p)) {
        const bytes = fs.readFileSync(p);
        const img = r.hero_photo_url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const boxH = 190;
        drawContainedImage(page, img, { x: marginX, y, width: PAGE_W - marginX * 2, height: boxH });
        y -= boxH + 14;
      }
    } catch { /* skip if unreadable */ }
  }

  // ── Overview ──
  sectionHeader("Overview");
  fieldRow("Agent", getAgentName(r.agent_id));
  fieldRow("Client", r.client_name || "—");
  fieldRow("Client Contact", [r.client_email, r.client_phone].filter(Boolean).join(" \u00b7 ") || "—");
  fieldRow("Created", r.created_at ? String(r.created_at).slice(0, 10) : "—");
  if (r.status === "signed") fieldRow("Signed Date", r.debrief_sent_at ? String(r.debrief_sent_at).slice(0, 10) : "—");

  // ── Prep ──
  sectionHeader("Prep — Before-You-Arrive Checklist");
  const checklist = prep.checklist || {};
  const checked = Object.keys(checklist).filter((k) => checklist[k]);
  paragraph(checked.length ? checked.join(", ") : "None checked");

  // ── Walkthrough & Intel ──
  sectionHeader("Walkthrough & Intel");
  fieldRow("Interior / Exterior Notes", walkthrough.notes || "—");
  fieldRow("Needs Repairs", walkthrough.needsRepairs === true ? "Yes" : walkthrough.needsRepairs === false ? "No" : "—");
  fieldRow("Mortgage Balance", walkthrough.mortgageBalance || "—");
  fieldRow("Buying Too", walkthrough.buyingToo || "—");
  if (walkthrough.buyingNotes) fieldRow("Buying Notes", walkthrough.buyingNotes);
  fieldRow("Timeline", walkthrough.timeline || "—");

  const flaggedKeys = Object.keys(pillarFlags).filter((k) => pillarFlags[k]?.checked);
  if (flaggedKeys.length) {
    y -= 2;
    ensureSpace(16);
    page.drawText("Condition Check — Flagged Needs", { x: marginX, y, size: 9.5, font: fontBold, color: gray });
    y -= 15;
    for (const key of flaggedKeys) {
      const st = pillarFlags[key];
      const label = PILLAR_LABELS[key] || humanize(key);
      const tier = TIER_LABELS[st.tier] || st.tier || "—";
      const details = (st.details || []).map((dt: string) => humanize(dt)).join(", ");
      let line = `• ${label} — ${tier}`;
      if (details) line += ` (${details})`;
      paragraph(line);
      if (st.notes) paragraph(`   Notes: ${st.notes}`);
    }
  } else {
    paragraph("No repair/condition needs flagged.");
  }

  // ── Close ──
  sectionHeader("Close");
  const pathLabel = close.whereAreWe === "ready_now" ? "Ready — start now"
    : close.whereAreWe === "ready_repairs" ? "Ready — repairs first"
    : close.whereAreWe === "not_moving" ? "Not moving forward" : "—";
  fieldRow("Path", pathLabel);
  if (close.whereAreWe === "not_moving") {
    fieldRow("Consult Result", NOT_MOVING_LABELS[close.notMovingReason] || close.notMovingReason || "—");
    if (close.notMovingNotes) fieldRow("Notes", close.notMovingNotes);
  } else {
    fieldRow("Recommended List Price", close.recommendedPrice || "—");
    fieldRow("Final Listing Price", close.finalListingPrice || "—");
    fieldRow("Commission", `${close.listingAgentCommission || "3.0"}% listing / ${close.buyerAgentCommission || "2.5"}% buyer's`);
    if (close.additionalTerms) fieldRow("Additional Terms", close.additionalTerms);
    const addenda = addendaSummary(close);
    if (addenda) fieldRow("Addenda", addenda);
  }

  // ── Lock In (only reached on a signed/ready path) ──
  if (close.whereAreWe === "ready_now" || close.whereAreWe === "ready_repairs") {
    sectionHeader("Lock In");
    fieldRow("Owner(s)", [lockin.ownerNames, lockin.ownerNames2].filter(Boolean).join(" & ") || r.client_name || "—");
    fieldRow("Home Occupied", lockin.homeOccupied === "yes" ? "Yes" : lockin.homeOccupied === "no" ? "No" : "—");
    fieldRow("Pets", petsSummary(lockin));
    fieldRow("Access", accessSummary(lockin));
    fieldRow("Gate", gateSummary(lockin));
    fieldRow("Showing Approval Contact", lockin.showingApprovalContact === "owner1" ? (lockin.ownerNames || "Owner 1")
      : lockin.showingApprovalContact === "owner2" ? (lockin.ownerNames2 || "Owner 2")
      : lockin.showingContactOtherName || "—");
    if (lockin.showingRestrictions) fieldRow("Showing Restrictions", lockin.showingRestrictions);
    fieldRow("Cleaning Needed", lockin.needsCleaning === "yes" ? "Yes" : lockin.needsCleaning === "no" ? "No" : "—");
    if (lockin.forecastStartDate) fieldRow("Forecast Start Date", lockin.forecastStartDate);
    if (lockin.repairWindowStart && lockin.repairWindowEnd) fieldRow("Repairs Window", `${lockin.repairWindowStart} – ${lockin.repairWindowEnd}`);
    if (lockin.forecastCleaningDate) fieldRow("Cleaning Date", lockin.forecastCleaningDate);
    if (lockin.goLiveDate) fieldRow("Go-Live Date", lockin.goLiveDate);
    if (lockin.openHouseDate) fieldRow("Open House Date", lockin.openHouseDate);
  }

  // ── Photo grid pages ──
  async function addPhotoGridPages(photos: string[], sectionTitle: string) {
    if (!photos || photos.length === 0) return;
    const cols = 2, rows = 3, perPage = cols * rows;
    const gap = 14;
    const imgW = (PAGE_W - marginX * 2 - gap) / cols;
    const imgH = 148;
    const cellH = imgH + gap + 6;
    for (let pageStart = 0; pageStart < photos.length; pageStart += perPage) {
      newPage();
      const t = sectionTitle;
      const tW = fontBold.widthOfTextAtSize(t, 15);
      page.drawText(t, { x: (PAGE_W - tW) / 2, y, size: 15, font: fontBold, color: black });
      y -= 18;
      page.drawRectangle({ x: marginX, y: y - 20, width: PAGE_W - marginX * 2, height: 20, color: black });
      page.drawText(r.property_address || "", { x: marginX + 5, y: y - 14, size: 9.5, font: fontBold, color: white });
      y -= 40;
      const chunk = photos.slice(pageStart, pageStart + perPage);
      for (let i = 0; i < chunk.length; i++) {
        const row_ = Math.floor(i / cols);
        const col = i % cols;
        const boxX = marginX + col * (imgW + gap);
        const boxY = y - row_ * cellH;
        const url = chunk[i];
        try {
          const p = resolveListingPhotoPath(url);
          if (p && fs.existsSync(p)) {
            const bytes = fs.readFileSync(p);
            const img = url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
            drawContainedImage(page, img, { x: boxX, y: boxY, width: imgW, height: imgH });
          }
        } catch { /* skip unreadable photo */ }
      }
    }
  }

  const galleryPhotos: string[] = Array.isArray(r.gallery_photos) ? r.gallery_photos : [];
  const scopePhotos: string[] = Array.isArray(r.scope_photos) ? r.scope_photos : [];
  await addPhotoGridPages(galleryPhotos, "Walkthrough Photos");
  await addPhotoGridPages(scopePhotos, "Scope Photos — Evidence");

  const bytes = await pdfDoc.save();
  const outDir = listingReportsDir();
  const filename = `report-${consultId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  return `/listing-reports/${filename}`;
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
    if (!lockin.homeOccupied) missing.push("Home Occupied? (Yes/No)");
    if (!lockin.hasPets) missing.push("Pets In The Home? (Yes/No)");
    if (lockin.hasPets === "yes" && !lockin.petShowingPlan) missing.push("Pet Plan During Showings");
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

    // v20.32.43 — Credit the listing agent 200 points for a signed listing
    // contract. r.agent_id is the consult's owning agent (same field used by
    // createSignedLeadFromConsult above).
    if (r.agent_id) {
      try { awardPoints(r.agent_id, "listing_signed", newLeadId ?? undefined, "seller"); }
      catch (err) { console.error("[ListingConsult] awardPoints failed:", err); }
    }

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

  // ── v20.53.0 — Admin: Listing Consults list/detail/report-pdf ─────────────
  // All 3 routes require an authenticated admin (same guard used elsewhere).
  function requireAdmin(req: any, res: Response): boolean {
    if (!req.currentAgent || req.currentAgent.role !== "admin") {
      res.status(403).json({ error: "Admin only" });
      return false;
    }
    return true;
  }

  app.get("/api/admin/listing-consults", (req: any, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const status = String(req.query.status || "").trim();
    const validStatuses = ["in_progress", "not_moving", "archived", "signed"];
    let sql = `
      SELECT lc.id, lc.property_address, lc.client_name, lc.client_email, lc.client_phone,
             lc.status, lc.hero_photo_url, lc.agent_id, a.name AS agent_name,
             lc.created_at, lc.updated_at, lc.debrief_sent_at
      FROM listing_consults lc
      LEFT JOIN agents a ON a.id = lc.agent_id
    `;
    const params: any[] = [];
    if (status && validStatuses.includes(status)) {
      sql += ` WHERE lc.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY lc.updated_at DESC`;
    const rows = rawDb.prepare(sql).all(...params);
    res.json({ consults: rows });
  });

  app.get("/api/admin/listing-consults/:id", (req: any, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const r = getRow(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: "Not found" });
    res.json({ ...r, data: parseData(r), agent_name: getAgentName(r.agent_id) });
  });

  app.get("/api/admin/listing-consults/:id/report-pdf", async (req: any, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const url = await generateListingConsultReportPdf(parseInt(req.params.id));
      res.redirect(url);
    } catch (err: any) {
      console.error("[ListingConsult] report PDF failed:", err);
      res.status(500).json({ error: "Failed to generate report", detail: err?.message });
    }
  });
}
