// ─── REPAIR CONSULT ─────────────────────────────────────────────────────────
// v20.8.0 — "Repair Consult" tool. Lets an agent, during a listing walkthrough,
// check off simple repairs Brothers Group performs in-house (instant branded
// quote, 50/50 payment terms) and flag anything that needs a licensed trade
// (auto-emailed to our preferred vendor for that trade as a quote request,
// with photos + measurements). On client acceptance, a concise Work Order
// auto-fires to Alex + Nate so labor can be scheduled immediately.
//
// Design notes:
//  - In-house pricing is sqft / linear-ft / each / flat based — editable in
//    the admin Repair Pricing tab. Seeded with market-reasonable defaults
//    (NOT live Xactimate data — no API access from this environment), Alex
//    adjusts from there.
//  - Vendor items carry NO price — Brothers Group has no pricing authority
//    over licensed-trade work. We only route the request + photos.
//  - Work-order sequencing (sequence_order) reflects the most efficient
//    build order: clear/fix small stuff → wash exterior → paint exterior →
//    landscape → paint interior → clean last (so cleaning isn't undone by
//    earlier trades).
//  - Client e-sign is a lightweight typed-name + timestamp + IP capture
//    (works for the "in person" case too — agent can have the client type
//    their name on the agent's phone/tablet on the spot). True DocuSign
//    envelope generation requires Alex's own DocuSign API credentials wired
//    into Railway env vars — flagged as a fast follow, not built here.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { Resend } from "resend";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fireMilestoneTasks } from "./fub";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// v20.13.0 — Denise added per Alex's standing instruction: always CC nate, alex,
// and Denise on all repair-consult emails moving forward by default.
const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];
const FROM = "Lead Depot <noreply@watsonbrothersgroup.com>";
const APP_URL = "https://depot.watsonbrothersgroup.com";
const BRAND = {
  companyName: "Brothers Group",
  brokerage: "Momentum Realty",
  contactLine: "Alex & Nate Watson — (904) 504-3794 — www.brothersgroup.realestate",
  black: "#0a0a0a",
  gray: "#808080",
  lightGray: "#f2f2f2",
  border: "#999999",
  green: "#008000",
};

// ─── STORAGE PATHS ───────────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === "production";
function repairPhotosDir(): string {
  const dir = IS_PROD ? "/app/data/repair-photos" : path.resolve(__dirname, "public", "repair-photos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function repairPdfDir(): string {
  const dir = IS_PROD ? "/app/data/repair-quotes" : path.resolve(__dirname, "public", "repair-quotes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// v20.18.0 — Auto front-of-house hero photo via Google Street View Static API,
// for standalone Repair Consults (not nested from Listing Consult, which
// already hands off its own captured photo). Mirrors listingConsult.ts's
// fetchStreetViewPhoto exactly. Entirely optional at the infra level: with no
// GOOGLE_MAPS_API_KEY set, or no imagery at that address, this quietly
// returns null and the manual tap-to-photo flow is untouched.
async function ensureStreetViewHero(address: string): Promise<string | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !address?.trim()) return null;
  const loc = encodeURIComponent(address.trim());
  try {
    const metaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&key=${key}`);
    const meta = await metaRes.json().catch(() => ({} as any));
    if (meta?.status !== "OK") return null; // ZERO_RESULTS, REQUEST_DENIED, etc.
    const imgRes = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=640x400&fov=80&location=${loc}&key=${key}`);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const dir = repairPhotosDir();
    const filename = `street-view-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return `/repair-photos/${filename}`;
  } catch (err) {
    console.error("Repair Consult Street View fetch error:", err);
    return null;
  }
}
// v20.30.0 — a consult's hero photo (and gallery/scope photos) can come from
// TWO different upload pipelines: this tool's own /repair-photos uploads, OR
// a hand-off from Listing Consult (front-of-house hero photo + walkthrough
// photos carried over via prefillHeroPhotoUrl/prefillGalleryUrls at consult
// creation), which physically live under /listing-photos instead. Blindly
// assuming every photo lives in repairPhotosDir() silently drops any
// Listing-Consult-sourced photo from the generated PDFs — fs.existsSync just
// returns false and the whole image block is skipped with no error. Resolve
// against the correct on-disk directory based on the URL's own path prefix.
function resolveConsultPhotoPath(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("/repair-photos/")) return path.join(repairPhotosDir(), path.basename(url));
  if (url.startsWith("/listing-photos/")) {
    const dir = IS_PROD ? "/app/data/listing-photos" : path.resolve(__dirname, "public", "listing-photos");
    return path.join(dir, path.basename(url));
  }
  // Unknown prefix or absolute http(s) URL — no known local path to try.
  return null;
}

function brandLogoPath(): string {
  const prodPath = "/app/dist/public/brand-logo.jpg";
  const devPath = path.resolve(__dirname, "public", "brand-logo.jpg");
  return IS_PROD && fs.existsSync(prodPath) ? prodPath : devPath;
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
export function ensureRepairConsultSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS repair_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,           -- 'in_house' | 'vendor'
      trade TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,               -- 'sqft' | 'linear_ft' | 'each' | 'flat'
      default_rate REAL,
      min_charge REAL DEFAULT 0,
      two_story_eligible INTEGER NOT NULL DEFAULT 0,
      sequence_order INTEGER NOT NULL DEFAULT 100,
      instruction TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_consults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      agent_id INTEGER REFERENCES agents(id),
      client_name TEXT,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      hero_photo_url TEXT,
      property_photos TEXT,              -- JSON array of URLs (interior/exterior gallery)
      status TEXT NOT NULL DEFAULT 'draft', -- draft | quoted | sent | pending_countersignature | accepted | declined | work_order_sent
      start_window TEXT,                 -- 'asap' | 'within_1_week' | '1_2_weeks' | '2_4_weeks' | 'specific'
      start_date TEXT,
      start_time TEXT,
      subtotal REAL DEFAULT 0,
      two_story INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      deposit_amount REAL DEFAULT 0,
      final_amount REAL DEFAULT 0,
      quote_token TEXT UNIQUE,
      quote_expires_at TEXT,
      accepted_at TEXT,
      accepted_signature_name TEXT,
      accepted_ip TEXT,
      work_order_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_consult_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL REFERENCES repair_consults(id),
      item_key TEXT NOT NULL,
      category TEXT NOT NULL,
      trade TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit_rate REAL,
      two_story INTEGER DEFAULT 0,
      line_total REAL,
      instruction TEXT,
      photos TEXT,                      -- JSON array of URLs
      measurement_notes TEXT,
      sequence_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_vendor_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL REFERENCES repair_consults(id),
      trade TEXT NOT NULL,
      vendor_id INTEGER REFERENCES repair_vendors(id),
      vendor_email TEXT,
      item_ids TEXT,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    -- v20.15.1 — Change Orders. Additional work discovered/requested once a
    -- consult has been signed and work is underway (Agreement Section 5
    -- already promises this). Every change order requires (1) admin office
    -- approval BEFORE the client ever sees it, and (2) the client's own
    -- e-sign on the specific change order BEFORE it becomes billable —
    -- always, no dollar threshold, per Alex's "no mistakes" standard.
    -- Approved+signed change orders flow into repair_consult_items (via
    -- change_order_id) so totals/PDFs/invoices use the exact same math and
    -- code path as the original quote — no parallel pricing logic.
    CREATE TABLE IF NOT EXISTS repair_change_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL REFERENCES repair_consults(id),
      requested_by_agent_id INTEGER REFERENCES agents(id),
      item_key TEXT,                      -- catalog key, if selected from the in-house catalog
      custom_description TEXT,            -- free-text description, if off-catalog
      unit TEXT NOT NULL DEFAULT 'flat',
      quantity REAL NOT NULL DEFAULT 1,
      unit_rate REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      photos TEXT,                        -- JSON array of URLs (evidence)
      status TEXT NOT NULL DEFAULT 'pending', -- pending | office_approved | declined | signed
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      decided_by TEXT,
      decline_reason TEXT,
      sign_token TEXT UNIQUE,
      sign_token_expires_at TEXT,
      signed_at TEXT,
      signature_name TEXT,
      signed_ip TEXT,
      consult_item_id INTEGER REFERENCES repair_consult_items(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_repair_consult_items_consult ON repair_consult_items(consult_id);
    CREATE INDEX IF NOT EXISTS idx_repair_vendor_dispatches_consult ON repair_vendor_dispatches(consult_id);
    CREATE INDEX IF NOT EXISTS idx_repair_vendors_trade ON repair_vendors(trade);
    CREATE INDEX IF NOT EXISTS idx_repair_change_orders_consult ON repair_change_orders(consult_id);
    CREATE INDEX IF NOT EXISTS idx_repair_change_orders_status ON repair_change_orders(status);

    -- v20.18.0 — Packages layer. Admin-editable bundles of existing catalog
    -- items with a marketed discount off THOSE items' in-house subtotal only
    -- (a la carte add-ons stay full price). item_keys is a JSON array so
    -- Alex can retune contents/discount from the admin panel with no deploy.
    CREATE TABLE IF NOT EXISTS repair_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      tier TEXT NOT NULL DEFAULT 'small',   -- small | medium | large | largest — display sort
      discount_pct REAL NOT NULL DEFAULT 0, -- e.g. 0.10 = 10% off
      item_keys TEXT NOT NULL,              -- JSON array of repair_items.key (in-house)
      vendor_item_keys TEXT,                -- JSON array of repair_items.key (vendor, auto-dispatched on select)
      sort_order INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v20.18.0 — Sign-Today free-service incentive. Single admin-editable row
    -- (id always 1) so Alex can flip it on/off and retune threshold/free item
    -- from the admin panel with no code deploy.
    CREATE TABLE IF NOT EXISTS repair_incentive_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL DEFAULT 1,
      threshold_amount REAL NOT NULL DEFAULT 1500,
      free_item_key TEXT NOT NULL DEFAULT 'gutter_clean',
      label TEXT NOT NULL DEFAULT 'Sign today and get Gutter Cleaning free',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v20.32.13 — Land Clearing pricing settings. Single admin-editable row
    -- (id always 1). Modeled on Alex Porter's real pricing: $750 flat for
    -- small jobs (his 4-hour brush-cutter minimum), ~$1,500/acre above the
    -- threshold, with a default 20% markup applied on top of vendor cost to
    -- get the client-facing suggested price. All four numbers are editable
    -- from the Vendor Directory admin panel — no code deploy needed to retune.
    CREATE TABLE IF NOT EXISTS land_clearing_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_price REAL NOT NULL DEFAULT 750,
      acreage_threshold REAL NOT NULL DEFAULT 0.5,
      per_acre_rate REAL NOT NULL DEFAULT 1500,
      markup_pct REAL NOT NULL DEFAULT 0.20,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v20.32.13 — Smart Data: county-record-sourced (or manually entered)
    -- property characteristics, keyed by property_address. Populated either
    -- by pushing county-record / sales-package data in (source =
    -- 'county_record' | 'sales_package') via the ingest endpoint, or by an
    -- agent typing in the minimum required fields by hand (source =
    -- 'manual') when no other source has answers. heated_sqft and
    -- lot_size_acres are the two minimum-required fields per Alex; every
    -- other column is optional context.
    CREATE TABLE IF NOT EXISTS property_smart_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_address TEXT NOT NULL UNIQUE,
      lot_size_acres REAL,
      lot_size_sqft REAL,
      heated_sqft REAL,
      cooled_sqft REAL,
      effective_sqft REAL,
      stories REAL,
      bedrooms REAL,
      bathrooms REAL,
      year_built INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',        -- 'county_record' | 'sales_package' | 'manual'
      source_url TEXT,
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_property_smart_data_address ON property_smart_data(property_address);
  `);

  // v20.32.14 — Vacant land support: a lot like "0 Charles Ave" has no
  // validated mailing address and no structure, so heated sqft can never be
  // populated. The county Property Appraiser Parcel # is the reliable
  // identifier for these — store it, and a flag so the minimum-required
  // check swaps heated_sqft for parcel_number on vacant parcels.
  const psdCols = (rawDb.prepare(`PRAGMA table_info(property_smart_data)`).all() as any[]).map((c: any) => c.name);
  if (!psdCols.includes("parcel_number")) rawDb.prepare("ALTER TABLE property_smart_data ADD COLUMN parcel_number TEXT").run();
  if (!psdCols.includes("is_vacant_land")) rawDb.prepare("ALTER TABLE property_smart_data ADD COLUMN is_vacant_land INTEGER NOT NULL DEFAULT 0").run();

  // v20.9.0 — signing-method tracking + agreement PDF paths (ALTER TABLE is safe to run
  // repeatedly — guarded by PRAGMA table_info check, same pattern as server/db.ts)
  const rcCols = (rawDb.prepare(`PRAGMA table_info(repair_consults)`).all() as any[]).map((c: any) => c.name);
  if (!rcCols.includes("signature_method"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN signature_method TEXT").run();
  if (!rcCols.includes("print_signed_at"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_at TEXT").run();
  if (!rcCols.includes("print_signed_by"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_by TEXT").run();
  if (!rcCols.includes("print_signed_upload_url"))  rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_upload_url TEXT").run();
  if (!rcCols.includes("agreement_pdf_url"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN agreement_pdf_url TEXT").run();
  if (!rcCols.includes("quote_pdf_url"))            rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN quote_pdf_url TEXT").run();
  if (!rcCols.includes("signed_agreement_pdf_url")) rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN signed_agreement_pdf_url TEXT").run();
  if (!rcCols.includes("approval_email_sent_at"))   rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN approval_email_sent_at TEXT").run();

  // v20.13.0 — Deposit Required Gate: scheduling (start_window/date/time) is now
  // locked until the client has signed AND the deposit is marked received.
  // Sequence: signed -> work order sent -> deposit received -> THEN schedule start date.
  if (!rcCols.includes("deposit_received_at"))      rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN deposit_received_at TEXT").run();
  if (!rcCols.includes("deposit_received_by"))      rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN deposit_received_by TEXT").run();
  if (!rcCols.includes("deposit_method"))           rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN deposit_method TEXT").run();
  if (!rcCols.includes("deposit_reference"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN deposit_reference TEXT").run();
  // v20.13.0 — Office Approval Gate: no quote/approval email may reach the client
  // until an admin has approved it in-house first.
  if (!rcCols.includes("office_approved_at"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN office_approved_at TEXT").run();
  if (!rcCols.includes("office_approved_by"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN office_approved_by TEXT").run();

  // v20.15.1 — Change Orders: trace which consult_item row (if any) a signed
  // change order produced, so admin UI / PDFs can show provenance.
  const rciCols = (rawDb.prepare(`PRAGMA table_info(repair_consult_items)`).all() as any[]).map((c: any) => c.name);
  if (!rciCols.includes("change_order_id")) rawDb.prepare("ALTER TABLE repair_consult_items ADD COLUMN change_order_id INTEGER").run();

  // v20.32.0 — E-Sign redesign: two-stage signature chain. Homeowner signs
  // first (status -> 'pending_countersignature', reusing accepted_at /
  // accepted_signature_name / accepted_ip / signature_method exactly as
  // before), then an admin countersigns (status -> 'accepted' only then).
  // Decline is a new terminal state. Mark Signed now requires evidence
  // (photo or PDF) uploaded first, then a separate admin confirm step
  // before it too can flip status to 'accepted'.
  if (!rcCols.includes("countersigned_at"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN countersigned_at TEXT").run();
  if (!rcCols.includes("countersigned_by"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN countersigned_by TEXT").run();
  if (!rcCols.includes("declined_at"))               rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN declined_at TEXT").run();
  if (!rcCols.includes("decline_reason"))            rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN decline_reason TEXT").run();
  // v20.32.2 — owner-declined-at-consult loop-closer. declined_by identifies
  // who logged the decline (admin/agent name), decline_source distinguishes
  // an admin/agent marking it declined in person vs. the public e-sign
  // decline link. reopened_at/reopened_by track a revive without erasing the
  // decline history — nothing about the consult or its items is ever deleted.
  if (!rcCols.includes("declined_by"))               rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN declined_by TEXT").run();
  if (!rcCols.includes("decline_source"))            rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN decline_source TEXT").run();
  if (!rcCols.includes("reopened_at"))               rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN reopened_at TEXT").run();
  if (!rcCols.includes("reopened_by"))               rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN reopened_by TEXT").run();
  if (!rcCols.includes("print_signed_confirmed_at")) rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_confirmed_at TEXT").run();
  if (!rcCols.includes("print_signed_confirmed_by")) rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_confirmed_by TEXT").run();
  // v20.32.0 — final Work Order & Checklist doc (photos + chronological scope
  // + start/target-completion dates), generated the moment a contract is
  // fully executed. target_completion_date is editable by admin; if never
  // set, it's inferred as start_date + 14 days at generation time.
  if (!rcCols.includes("work_order_pdf_url"))       rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN work_order_pdf_url TEXT").run();
  if (!rcCols.includes("target_completion_date"))   rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN target_completion_date TEXT").run();

  // v20.32.13 Part 5 — meeting cadence + work order detail fields. tools_needed
  // is a plain newline/comma list (rendered on the Work Order PDF alongside
  // instructions/scope), time_block_estimate is a free-text window (e.g.
  // "8:00 AM – 12:00 PM"). completed_at marks the full job (final walkthrough
  // + final payment) done — status stays whatever it was (work_order_sent);
  // completed_at is the source of truth for "is this job fully closed out."
  if (!rcCols.includes("tools_needed"))             rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN tools_needed TEXT").run();
  if (!rcCols.includes("time_block_estimate"))      rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN time_block_estimate TEXT").run();
  if (!rcCols.includes("completed_at"))             rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN completed_at TEXT").run();
  if (!rcCols.includes("completed_by"))             rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN completed_by TEXT").run();

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS repair_project_meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL REFERENCES repair_consults(id),
      meeting_type TEXT NOT NULL, -- initial_start | punch_out | final_payment
      scheduled_at TEXT,
      completed_at TEXT,
      notes TEXT,
      fub_task_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_repair_project_meetings_consult ON repair_project_meetings(consult_id);`);

  // v20.32.7 — Vendor Directory: separate on-site contact person from the
  // company name, plus a company mailing address. Both optional/nullable —
  // existing vendor rows (there are none live yet) just get NULLs.
  const rvCols = (rawDb.prepare(`PRAGMA table_info(repair_vendors)`).all() as any[]).map((c: any) => c.name);
  if (!rvCols.includes("contact_name")) rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN contact_name TEXT").run();
  if (!rvCols.includes("address"))      rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN address TEXT").run();

  // v20.32.13 — Part 6: Vendor Directory upgrade. Shared by both Repair vendors
  // AND Inspection vendors (inspection_order_items.vendor_id already points
  // at this same table) so one profile serves both programs.
  if (!rvCols.includes("pricing_sheet_url"))      rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN pricing_sheet_url TEXT").run();
  if (!rvCols.includes("license_number"))         rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN license_number TEXT").run();
  if (!rvCols.includes("insurance_expiration"))   rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN insurance_expiration TEXT").run();
  if (!rvCols.includes("service_area"))           rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN service_area TEXT").run();
  if (!rvCols.includes("credentials_notes"))      rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN credentials_notes TEXT").run();

  // v20.32.0 — permanent, un-deletable archive of every fully-executed
  // (countersigned or print-sign-confirmed) contract. Delete never touches
  // this table — see DELETE /api/repair-consult/:id below.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS repair_consult_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      signature_method TEXT,
      property_address TEXT,
      client_name TEXT,
      total REAL,
      agreement_pdf_url TEXT,
      work_order_pdf_url TEXT,
      snapshot_json TEXT NOT NULL
    );
  `);

  // v20.18.0 — Packages + Sign-Today incentive + Street View hero default.
  if (!rcCols.includes("package_key"))             rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN package_key TEXT").run();
  if (!rcCols.includes("package_discount_pct"))    rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN package_discount_pct REAL DEFAULT 0").run();
  if (!rcCols.includes("package_discount_amount")) rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN package_discount_amount REAL DEFAULT 0").run();
  if (!rcCols.includes("free_item_applied_key"))   rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN free_item_applied_key TEXT").run();
  // 'manual' | 'street_view' — manual upload always wins and is never
  // overwritten by a later auto-fetch (see ensureStreetViewHero below).
  if (!rcCols.includes("hero_photo_source"))       rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN hero_photo_source TEXT").run();

  seedRepairItems();
  seedRepairPackages();
  seedIncentiveSettings();
  seedLandClearingSettings();
}

// ─── CATALOG SEED (idempotent — only inserts keys that don't exist yet) ─────
interface SeedItem {
  key: string; category: "in_house" | "vendor"; trade: string; name: string;
  unit: "sqft" | "linear_ft" | "each" | "flat";
  rate?: number; min?: number; twoStory?: boolean; seq: number;
  instruction: string; notes?: string;
}

const IN_HOUSE_ITEMS: SeedItem[] = [
  // v20.24.0 — Always-Included baseline items. Auto-checked on EVERY repair
  // consult regardless of pillar flags or the scope slider position — these
  // are the small professionalism touches that should show up on every
  // estimate no matter the scope (Alex: "shows how good we are").
  { key: "prep_protection", category: "in_house", trade: "handyman", name: "Site Prep & Surface Protection", unit: "flat", rate: 65, min: 65, seq: 1, instruction: "Mask and protect flooring, fixtures, and surfaces before work begins. Included on every job." },
  { key: "final_walkthrough_clean", category: "in_house", trade: "cleaning", name: "Final Walkthrough Clean-Up & Debris Haul", unit: "flat", rate: 85, min: 85, seq: 68, instruction: "Final clean-up and debris haul on completion. Included on every job." },
  { key: "junk_small", category: "in_house", trade: "junk_removal", name: "Junk Removal — Small Load (truck bed)", unit: "flat", rate: 175, min: 175, seq: 10, instruction: "Clear and haul small junk load." },
  { key: "junk_large", category: "in_house", trade: "junk_removal", name: "Junk Removal — Large Load (trailer/dump run)", unit: "flat", rate: 350, min: 350, seq: 11, instruction: "Clear and haul large junk load — trailer or dump run." },
  { key: "gutter_clean", category: "in_house", trade: "handyman", name: "Gutter Cleaning", unit: "linear_ft", rate: 1.25, min: 150, seq: 15, instruction: "Clean gutters — {qty} linear ft." },
  { key: "bulb_replace", category: "in_house", trade: "handyman", name: "Light Bulb Replacement", unit: "each", rate: 12, min: 0, seq: 20, instruction: "Replace {qty} light bulb(s)." },
  { key: "smoke_alarm", category: "in_house", trade: "handyman", name: "Smoke Alarm Replacement", unit: "each", rate: 35, min: 0, seq: 21, instruction: "Replace {qty} smoke alarm(s)." },
  { key: "hardware_replace", category: "in_house", trade: "handyman", name: "Door / Cabinet Hardware Replacement", unit: "each", rate: 18, min: 0, seq: 22, instruction: "Replace {qty} door/cabinet hardware piece(s)." },
  { key: "lockset_replace", category: "in_house", trade: "handyman", name: "Doorknob / Lockset Replacement", unit: "each", rate: 45, min: 0, seq: 23, instruction: "Replace {qty} doorknob/lockset(s)." },
  { key: "fixture_replace", category: "in_house", trade: "handyman", name: "Small Fixture Replacement (light, faucet, towel bar, etc.)", unit: "each", rate: 65, min: 0, seq: 24, instruction: "Replace {qty} small fixture(s)." },
  { key: "caulking", category: "in_house", trade: "handyman", name: "Caulking — Kitchen/Bath", unit: "linear_ft", rate: 4, min: 75, seq: 25, instruction: "Re-caulk {qty} linear ft, kitchen/bath." },
  { key: "drywall_patch", category: "in_house", trade: "handyman", name: "Drywall Patch/Spackle — Small (<1 sqft)", unit: "each", rate: 85, min: 85, seq: 26, instruction: "Patch {qty} small drywall spot(s)." },
  { key: "weatherstrip", category: "in_house", trade: "handyman", name: "Weatherstripping / Door Sweep Replacement", unit: "each", rate: 40, min: 0, seq: 27, instruction: "Replace {qty} weatherstrip/door sweep(s)." },
  { key: "screen_repair", category: "in_house", trade: "handyman", name: "Window Screen Repair/Replacement", unit: "each", rate: 45, min: 0, seq: 28, instruction: "Repair/replace {qty} window screen(s)." },
  { key: "outlet_cover", category: "in_house", trade: "handyman", name: "Outlet/Switch Cover Plate Replacement", unit: "each", rate: 8, min: 0, seq: 29, instruction: "Replace {qty} outlet/switch cover plate(s)." },
  { key: "blinds_install", category: "in_house", trade: "handyman", name: "Blinds Installation", unit: "each", rate: 35, min: 0, seq: 30, instruction: "Install {qty} blind(s)." },
  // v20.18.0 — Instant Repair Quote scope expansion. Every new item carries a
  // hard cap (Alex's "defined line drawn" rule) so agents never quote beyond
  // what one visit can safely cover — anything bigger routes to a vendor item.
  { key: "switch_replace", category: "in_house", trade: "handyman", name: "Light Switch Replacement", unit: "each", rate: 20, min: 0, seq: 31, instruction: "Replace {qty} light switch(es). Standard single-pole/3-way only — no smart-switch rewiring." },
  { key: "outlet_replace", category: "in_house", trade: "handyman", name: "Outlet Replacement", unit: "each", rate: 22, min: 0, seq: 32, instruction: "Replace {qty} outlet(s). Standard 15/20A only — no GFCI or dedicated-circuit work." },
  // v20.32.13 — GFCI, roofing minor repair, and water heater swap. Every task
  // carries a hard cap per Alex's "defined line drawn" rule — beyond the cap
  // routes to the matching vendor trade. Rates below are placeholders pending
  // Alex's confirmation/adjustment.
  { key: "gfci_install", category: "in_house", trade: "electrical", name: "GFCI Outlet Install/Replacement", unit: "each", rate: 45, min: 0, seq: 32.1, instruction: "Install/replace {qty} GFCI outlet(s). Existing circuit only, no new circuit run. Cap 6 per job — beyond that routes to vendor electrical work." },
  { key: "ceiling_fan_install", category: "in_house", trade: "handyman", name: "Ceiling Fan Replacement/Install", unit: "each", rate: 95, min: 95, seq: 33, instruction: "Replace/install {qty} ceiling fan(s). Requires existing electrical box/wiring — no new circuit run, standard fan up to 5 blades." },
  { key: "curtain_rod_install", category: "in_house", trade: "handyman", name: "Curtain Rod Install", unit: "each", rate: 35, min: 0, seq: 34, instruction: "Install {qty} curtain rod(s), per window. Drywall/wood mount only — no stone/tile." },
  { key: "light_fixture_replace", category: "in_house", trade: "handyman", name: "Small Light Fixture Replacement", unit: "each", rate: 65, min: 0, seq: 24.5, instruction: "Replace {qty} light fixture(s). Standard ceiling/wall fixture, existing wiring — nothing over 15 lbs." },
  { key: "tv_mount_removal", category: "in_house", trade: "handyman", name: "TV Mount Removal & Patch", unit: "each", rate: 95, min: 95, seq: 24.6, instruction: "Remove {qty} TV wall mount(s) and patch the resulting holes. Covers up to 2 sqft of wall patch per mount — paint touch-up not included, add separately if needed." },
  { key: "carpet_removal", category: "in_house", trade: "cleaning", name: "Carpet Removal & Haul", unit: "sqft", rate: 0.50, min: 200, seq: 67.5, instruction: "Remove and haul carpet — {qty} sqft. Cap 2,000 sqft per job, disposal included." },
  // NOTE: TV mount INSTALLATION is intentionally never added to this catalog —
  // out of scope per Alex. Only removal/patch (above) is a service we offer.
  { key: "pressure_wash_ext", category: "in_house", trade: "pressure_washing", name: "Pressure Washing — Exterior (Siding/Brick)", unit: "sqft", rate: 0.20, min: 200, twoStory: true, seq: 35, instruction: "Pressure wash exterior — {qty} sqft.{story}" },
  { key: "soft_wash_roof", category: "in_house", trade: "pressure_washing", name: "Soft Washing — Roof", unit: "sqft", rate: 0.35, min: 250, twoStory: true, seq: 36, instruction: "Soft wash roof — {qty} sqft.{story}" },
  { key: "pressure_wash_hard", category: "in_house", trade: "pressure_washing", name: "Pressure Washing — Driveway/Walkway/Patio", unit: "sqft", rate: 0.22, min: 150, seq: 37, instruction: "Pressure wash driveway/walkway/patio — {qty} sqft." },
  { key: "roof_nail_pop", category: "in_house", trade: "roofing", name: "Roof Minor Repair — Nail Pops", unit: "each", rate: 35, min: 100, seq: 37.1, instruction: "Reseat/reseal {qty} popped roofing nail(s). Cap 15 per job — beyond that routes to vendor roofing work." },
  { key: "roof_glue_shingle", category: "in_house", trade: "roofing", name: "Roof Minor Repair — Glue-Down Loose Shingles", unit: "each", rate: 45, min: 100, seq: 37.2, instruction: "Re-glue/reseat {qty} lifted or loose shingle(s). Cap 10 per job — beyond that routes to vendor roofing work." },
  { key: "roof_seal_flashing", category: "in_house", trade: "roofing", name: "Roof Minor Repair — Seal Flashing/Small Holes", unit: "each", rate: 65, min: 150, seq: 37.3, instruction: "Seal {qty} flashing seam(s) or small hole(s), up to 6 linear inches each. Cap 3 spots per job — beyond that routes to vendor roofing work." },
  { key: "water_heater_swap", category: "in_house", trade: "water_heater", name: "Water Heater — Like-for-Like Swap", unit: "flat", rate: 950, min: 950, seq: 37.4, instruction: "Like-for-like water heater swap only — same fuel type (gas or electric), same capacity ±5 gallons, up to 50-gallon unit. 1 unit per job. Different fuel type, larger capacity, or additional units routes to vendor water heater replacement." },
  { key: "paint_ext_body", category: "in_house", trade: "painting_exterior", name: "Exterior Painting — Body", unit: "sqft", rate: 2.25, min: 800, twoStory: true, seq: 40, instruction: "Paint exterior body — {qty} sqft. Color-matched to existing.{story}", notes: "Color match is visual-sample only; slight sheen/tone variance vs. original is possible." },
  { key: "paint_ext_trim", category: "in_house", trade: "painting_exterior", name: "Exterior Painting — Trim & Doors", unit: "linear_ft", rate: 3.50, min: 150, twoStory: true, seq: 41, instruction: "Paint exterior trim & doors — {qty} linear ft. Color-matched.{story}" },
  { key: "lawn_mow", category: "in_house", trade: "landscaping", name: "Lawn Mowing / Cut", unit: "sqft", rate: 0.03, min: 300, seq: 45, instruction: "Mow/cut lawn — {qty} sqft. (4-hour crew minimum)" },
  { key: "tree_hedge_removal", category: "in_house", trade: "landscaping", name: "Small Tree & Hedge Removal (up to 10 ft)", unit: "each", rate: 95, min: 0, seq: 46, instruction: "Remove {qty} small tree(s)/hedge(s)." },
  { key: "hedge_trim", category: "in_house", trade: "landscaping", name: "Hedge/Shrub Trimming", unit: "linear_ft", rate: 3.00, min: 100, seq: 47, instruction: "Trim hedges/shrubs — {qty} linear ft." },
  { key: "weed_pull", category: "in_house", trade: "landscaping", name: "Weed Pulling — Beds", unit: "sqft", rate: 1.25, min: 100, seq: 48, instruction: "Pull weeds in beds — {qty} sqft." },
  { key: "mulching", category: "in_house", trade: "landscaping", name: "Mulching — Beds (material + labor)", unit: "sqft", rate: 2.50, min: 150, seq: 49, instruction: "Mulch beds — {qty} sqft." },
  { key: "paint_int_body", category: "in_house", trade: "painting_interior", name: "Interior Painting — Body (Walls)", unit: "sqft", rate: 2.00, min: 600, seq: 55, instruction: "Paint interior walls — {qty} sqft. Color-matched to existing.", notes: "Color match is visual-sample only; slight sheen/tone variance vs. original is possible." },
  { key: "paint_int_trim", category: "in_house", trade: "painting_interior", name: "Interior Painting — Trim & Doors", unit: "linear_ft", rate: 3.00, min: 150, seq: 56, instruction: "Paint interior trim & doors — {qty} linear ft. Color-matched." },
  { key: "paint_int_ceiling", category: "in_house", trade: "painting_interior", name: "Interior Painting — Ceiling", unit: "sqft", rate: 1.75, min: 300, seq: 57, instruction: "Paint ceiling — {qty} sqft." },
  { key: "rough_clean", category: "in_house", trade: "cleaning", name: "Rough Clean (Post-Construction/Turnover)", unit: "sqft", rate: 0.15, min: 200, seq: 65, instruction: "Rough/turnover clean — {qty} sqft." },
  { key: "deep_clean", category: "in_house", trade: "cleaning", name: "Deep Clean", unit: "sqft", rate: 0.20, min: 250, seq: 66, instruction: "Deep clean — {qty} sqft." },
  { key: "carpet_clean", category: "in_house", trade: "cleaning", name: "Carpet Cleaning", unit: "sqft", rate: 0.35, min: 125, seq: 67, instruction: "Clean carpet — {qty} sqft." },
];

const VENDOR_TRADES: SeedItem[] = [
  { key: "v_tile_install", category: "vendor", trade: "tile_install", name: "Tile Installation", unit: "flat", seq: 200, instruction: "Vendor quote — tile installation." },
  { key: "v_cabinet_install", category: "vendor", trade: "cabinet_install", name: "Cabinet Installation", unit: "flat", seq: 201, instruction: "Vendor quote — cabinet installation." },
  { key: "v_cabinetry_paint", category: "vendor", trade: "cabinetry_painting", name: "Cabinetry Painting", unit: "flat", seq: 202, instruction: "Vendor quote — cabinetry painting/refinishing." },
  { key: "v_roofing", category: "vendor", trade: "roofing", name: "Roofing Work", unit: "flat", seq: 203, instruction: "Vendor quote — roofing repair/replacement." },
  { key: "v_electrical", category: "vendor", trade: "electrical", name: "Electrical Work", unit: "flat", seq: 204, instruction: "Vendor quote — electrical work." },
  { key: "v_plumbing", category: "vendor", trade: "plumbing", name: "Plumbing Work", unit: "flat", seq: 205, instruction: "Vendor quote — plumbing work." },
  { key: "v_hvac", category: "vendor", trade: "hvac", name: "HVAC (Repair / Replacement / Duct Cleaning)", unit: "flat", seq: 206, instruction: "Vendor quote — HVAC repair, replacement, or duct cleaning." },
  { key: "v_stucco_masonry", category: "vendor", trade: "stucco_masonry", name: "Stucco & Masonry Work", unit: "flat", seq: 207, instruction: "Vendor quote — stucco/masonry repair." },
  { key: "v_carpentry", category: "vendor", trade: "carpentry", name: "Carpentry Work", unit: "flat", seq: 208, instruction: "Vendor quote — carpentry work." },
  { key: "v_wdo", category: "vendor", trade: "wdo", name: "WDO (Wood-Destroying Organism) Work", unit: "flat", seq: 209, instruction: "Vendor quote — WDO/termite work." },
  { key: "v_windows", category: "vendor", trade: "windows", name: "Window Repair / Replacement", unit: "flat", seq: 210, instruction: "Vendor quote — window repair/replacement." },
  { key: "v_backflow", category: "vendor", trade: "backflow", name: "Backflow Prevention Repair", unit: "flat", seq: 211, instruction: "Vendor quote — backflow prevention repair." },
  { key: "v_floor_refinish", category: "vendor", trade: "flooring_wood_refinish", name: "Wood Floor Refinishing", unit: "flat", seq: 212, instruction: "Vendor quote — wood floor refinishing." },
  { key: "v_floor_lvp", category: "vendor", trade: "flooring_lvp", name: "LVP Flooring Installation", unit: "flat", seq: 213, instruction: "Vendor quote — LVP flooring installation." },
  { key: "v_floor_carpet", category: "vendor", trade: "flooring_carpet", name: "Carpet Installation", unit: "flat", seq: 214, instruction: "Vendor quote — carpet installation." },
  { key: "v_floor_epoxy", category: "vendor", trade: "flooring_epoxy", name: "Epoxy Flooring Installation", unit: "flat", seq: 214.5, instruction: "Vendor quote — epoxy flooring installation (garage, patio, concrete surfaces)." },
  { key: "v_appliances", category: "vendor", trade: "appliances", name: "Appliance Replacement / Repair", unit: "flat", seq: 215, instruction: "Vendor quote — appliance replacement/repair." },
  { key: "v_countertops", category: "vendor", trade: "countertops", name: "Countertop Installation", unit: "flat", seq: 216, instruction: "Vendor quote — countertop installation." },
  { key: "v_retexture", category: "vendor", trade: "retexture", name: "Re-Texturing", unit: "flat", seq: 217, instruction: "Vendor quote — wall/ceiling re-texturing." },
  { key: "v_shower_doors", category: "vendor", trade: "shower_doors", name: "Frameless Shower Door Installation", unit: "flat", seq: 218, instruction: "Vendor quote — frameless shower door installation." },
  { key: "v_irrigation", category: "vendor", trade: "irrigation", name: "Irrigation Repair", unit: "flat", seq: 219, instruction: "Vendor quote — irrigation repair." },
  { key: "v_fencing", category: "vendor", trade: "fencing", name: "Fencing Installation / Repair", unit: "flat", seq: 220, instruction: "Vendor quote — fencing installation/repair." },
  { key: "v_pool", category: "vendor", trade: "pool_equipment", name: "Pool Equipment / Repair", unit: "flat", seq: 221, instruction: "Vendor quote — pool equipment/repair." },
  { key: "v_septic", category: "vendor", trade: "septic", name: "Septic Work", unit: "flat", seq: 222, instruction: "Vendor quote — septic work." },
  { key: "v_water_heater", category: "vendor", trade: "water_heater", name: "Water Heater Replacement", unit: "flat", seq: 223, instruction: "Vendor quote — water heater replacement." },
  { key: "v_tree_large", category: "vendor", trade: "tree_removal_large", name: "Large Tree Removal", unit: "flat", seq: 224, instruction: "Vendor quote — large tree removal." },
  { key: "v_structural", category: "vendor", trade: "structural", name: "Structural / Foundation Work", unit: "flat", seq: 225, instruction: "Vendor quote — structural/foundation work." },
  { key: "v_mold", category: "vendor", trade: "mold_remediation", name: "Mold Remediation", unit: "flat", seq: 226, instruction: "Vendor quote — mold remediation." },
  { key: "v_chimney", category: "vendor", trade: "chimney", name: "Chimney Repair", unit: "flat", seq: 227, instruction: "Vendor quote — chimney repair." },
  { key: "v_solar", category: "vendor", trade: "solar", name: "Solar Installation / Repair", unit: "flat", seq: 228, instruction: "Vendor quote — solar installation/repair." },
  { key: "v_water_damage", category: "vendor", trade: "water_damage", name: "Water Damage Restoration", unit: "flat", seq: 229, instruction: "Vendor quote — water damage restoration." },
  { key: "v_garage_door", category: "vendor", trade: "garage_door", name: "Garage Door Repair / Replacement", unit: "flat", seq: 230, instruction: "Vendor quote — garage door repair/replacement." },
  { key: "v_hardscape", category: "vendor", trade: "hardscape", name: "Hardscape / Pavers / Retaining Walls", unit: "flat", seq: 231, instruction: "Vendor quote — hardscape/pavers/retaining wall work." },
  { key: "v_land_clearing", category: "vendor", trade: "land_clearing", name: "Land Clearing", unit: "flat", seq: 232, instruction: "Vendor quote — land clearing (acreage-based)." },
];

export const REPAIR_CATALOG_SEED: SeedItem[] = [...IN_HOUSE_ITEMS, ...VENDOR_TRADES];

// v20.18.0 — Package ladder, small to large. discount is off the in-house
// subtotal of ONLY the listed itemKeys — a la carte add-ons on top of a
// package always stay full price. vendorItemKeys (if any) auto-dispatch to
// that trade's vendor the moment the package is selected — no separate tap.
interface SeedPackage {
  key: string; name: string; description: string; tier: "small" | "medium" | "large" | "largest";
  discountPct: number; itemKeys: string[]; vendorItemKeys?: string[]; sortOrder: number;
}
const REPAIR_PACKAGES: SeedPackage[] = [
  { key: "punch_list", name: "Punch List Package", description: "Switch, outlet, cover plate, small fixture, curtain rod, TV mount removal & patch, drywall patch.", tier: "small", discountPct: 0.10, sortOrder: 10,
    itemKeys: ["switch_replace", "outlet_replace", "outlet_cover", "light_fixture_replace", "curtain_rod_install", "tv_mount_removal", "drywall_patch"] },
  { key: "lawn_service", name: "Lawn Service Package", description: "Mow, hedge trim, weed pull, mulching.", tier: "small", discountPct: 0.10, sortOrder: 20,
    itemKeys: ["lawn_mow", "hedge_trim", "weed_pull", "mulching"] },
  { key: "fresh_start_clean", name: "Fresh Start Clean", description: "Home clean plus junk out.", tier: "small", discountPct: 0.10, sortOrder: 30,
    itemKeys: ["rough_clean", "junk_small"] },
  { key: "deep_clean_pkg", name: "Deep Clean Package", description: "Deep clean plus carpet clean.", tier: "medium", discountPct: 0.10, sortOrder: 40,
    itemKeys: ["deep_clean", "carpet_clean"] },
  { key: "curb_refresh", name: "Curb & Refresh", description: "Pressure wash house + driveway, mow, hedge trim, weed pull.", tier: "medium", discountPct: 0.12, sortOrder: 50,
    itemKeys: ["pressure_wash_ext", "pressure_wash_hard", "lawn_mow", "hedge_trim", "weed_pull"] },
  { key: "quick_punch_clean", name: "Quick Punch + Clean", description: "Punch list items plus a deep clean.", tier: "medium", discountPct: 0.12, sortOrder: 60,
    itemKeys: ["switch_replace", "outlet_replace", "outlet_cover", "light_fixture_replace", "curtain_rod_install", "tv_mount_removal", "drywall_patch", "deep_clean"] },
  { key: "exterior_only", name: "Exterior-Only Package", description: "Pressure wash house + driveway, soft wash roof, mow, hedge trim, weed pull, exterior trim paint.", tier: "large", discountPct: 0.15, sortOrder: 70,
    itemKeys: ["pressure_wash_ext", "pressure_wash_hard", "soft_wash_roof", "lawn_mow", "hedge_trim", "weed_pull", "paint_ext_trim"] },
  { key: "interior_only", name: "Interior-Only Package", description: "Deep clean, carpet clean, full interior repaint, punch list items.", tier: "large", discountPct: 0.15, sortOrder: 80,
    itemKeys: ["deep_clean", "carpet_clean", "paint_int_body", "paint_int_trim", "paint_int_ceiling", "switch_replace", "outlet_replace", "light_fixture_replace"] },
  { key: "move_in_ready", name: "Move-In Ready", description: "Full interior repaint, deep clean, carpet clean.", tier: "large", discountPct: 0.15, sortOrder: 90,
    itemKeys: ["paint_int_body", "paint_int_trim", "paint_int_ceiling", "deep_clean", "carpet_clean"] },
  { key: "vacant_turnover", name: "Vacant Home Turnover", description: "Junk out (large), rough clean, pressure wash, mow, full interior repaint, carpet clean.", tier: "largest", discountPct: 0.18, sortOrder: 100,
    itemKeys: ["junk_large", "rough_clean", "pressure_wash_ext", "lawn_mow", "paint_int_body", "paint_int_trim", "paint_int_ceiling", "carpet_clean"] },
  { key: "smoke_remediation", name: "Smoke Remediation Package", description: "Full interior repaint, carpet removal, deep clean — plus HVAC duct cleaning (vendor, auto-dispatched).", tier: "largest", discountPct: 0.15, sortOrder: 110,
    itemKeys: ["paint_int_body", "paint_int_trim", "paint_int_ceiling", "carpet_removal", "deep_clean"], vendorItemKeys: ["v_hvac"] },
];

function seedRepairPackages() {
  const insert = rawDb.prepare(`
    INSERT INTO repair_packages (key, name, description, tier, discount_pct, item_keys, vendor_item_keys, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const tx = rawDb.transaction(() => {
    for (const p of REPAIR_PACKAGES) {
      insert.run(p.key, p.name, p.description, p.tier, p.discountPct, JSON.stringify(p.itemKeys), p.vendorItemKeys ? JSON.stringify(p.vendorItemKeys) : null, p.sortOrder);
    }
  });
  tx();
}

function seedIncentiveSettings() {
  rawDb.prepare(`INSERT INTO repair_incentive_settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`).run();
}

function seedLandClearingSettings() {
  rawDb.prepare(`INSERT INTO land_clearing_settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`).run();
}

// v20.32.13 — Land Clearing tiered pricing formula. Below the acreage
// threshold, Alex Porter's real-world minimum applies (his 4-hour
// brush-cutter minimum, ~$750 flat). At/above the threshold, cost scales
// per-acre. Markup is applied on top of vendor cost to produce the
// client-facing suggested price — both numbers are then fully editable by
// whoever is entering the Change Order.
function computeLandClearingEstimate(acres: number, settings: any) {
  const a = Math.max(0, Number(acres) || 0);
  const vendorCost = a < settings.acreage_threshold
    ? settings.base_price
    : Math.round(a * settings.per_acre_rate * 100) / 100;
  const clientPrice = Math.round(vendorCost * (1 + settings.markup_pct) * 100) / 100;
  return { acres: a, vendorCost, clientPrice, markupPct: settings.markup_pct };
}

function seedRepairItems() {
  const insert = rawDb.prepare(`
    INSERT INTO repair_items (key, category, trade, name, unit, default_rate, min_charge, two_story_eligible, sequence_order, instruction, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const tx = rawDb.transaction(() => {
    for (const it of REPAIR_CATALOG_SEED) {
      insert.run(
        it.key, it.category, it.trade, it.name, it.unit,
        it.rate ?? null, it.min ?? 0, it.twoStory ? 1 : 0, it.seq, it.instruction, it.notes ?? null
      );
    }
  });
  tx();
}

// ─── PRICING HELPERS ─────────────────────────────────────────────────────────
const TWO_STORY_SURCHARGE_PCT = 0.25; // +25% on eligible exterior line items

function computeLineTotal(rate: number, qty: number, min: number, twoStory: boolean, twoStoryEligible: boolean): number {
  let total = rate * qty;
  if (twoStory && twoStoryEligible) total *= 1 + TWO_STORY_SURCHARGE_PCT;
  return Math.max(total, min || 0);
}

function fillInstruction(template: string, qty: number, unit: string, twoStory: boolean): string {
  const qtyStr = unit === "each" || unit === "flat" ? String(qty) : `${qty.toLocaleString()}`;
  return template
    .replace("{qty}", qtyStr)
    .replace("{story}", twoStory ? " (2-story surcharge applied)" : "");
}

// ─── LEGAL / TERMS LANGUAGE — DRAFT, PENDING ALEX'S SIGN-OFF ────────────────
// Do not treat as final. Shown on every in-house quote until Alex approves
// final wording (see chat thread). Kept as one exported constant so a single
// edit here updates every quote + PDF + work order footnote.
export const IN_HOUSE_TERMS = [
  "Price reflects the scope, quantities, and condition observed at this consultation. Conditions discovered once work begins (rot, mold, structural issues, pest damage, code violations, etc.) are not included and will be presented as a separate change order requiring written approval before we proceed.",
  "Payment: 50% deposit due before work begins, 50% due upon completion.",
  "Color-matched paint is matched by visual sample only; minor sheen/tone variance from the original surface is possible due to substrate age, weathering, or manufacturer formulation changes. Client approves the color sample before purchase.",
  "This quote covers in-house labor & materials for the items listed only. It does not include permits, HOA approval, or any item requiring a licensed trade (electrical, plumbing, roofing, HVAC, structural, etc.) — those are quoted separately by our licensed vendor partners and are not performed or warrantied by Brothers Group's in-house crew.",
  "Client provides on-site access, water, and electrical, and secures pets and personal property in work areas. Delays caused by lack of access may incur a rescheduling fee.",
  "Quote valid 14 days from issue date. Deposits are non-refundable once material is purchased or labor is scheduled with less than 48 hours' notice.",
  "Brothers Group is not a licensed general contractor; in-house work is limited to non-structural, non-permitted cosmetic and maintenance items as listed above.",
  "By signing below, client authorizes Brothers Group to perform the listed work at the listed price under the terms above.",
  "Every quantity, square footage, and unit count listed on this quote is the maximum included in this price. Work beyond those stated maximums is quoted separately and requires written approval before we proceed.",
] as const;

export const VENDOR_DISPATCH_NOTE =
  "Items marked Vendor-Quoted are performed by an independent, licensed third-party contractor. Brothers Group facilitates the introduction and quote request only — pricing, licensing, insurance, scheduling, and workmanship are solely between the client and the vendor. Brothers Group assumes no liability for vendor work.";

// ─── REPAIR & RENOVATION AGREEMENT — full legal text (v20.9.0) ─────────────
// Two signing LLCs operating jointly under the internal/marketing name
// "BGRE Home Touchups and Repairs" (NOT a registered Florida DBA — both LLCs
// remain the actual legal signing parties on every agreement).
export const ENTITY_NATE = "Nathaniel Peter Watson LLC";
export const ENTITY_ALEX = "Alexander Gabriel Watson LLC";
export const DIVISION_NAME = "BGRE Home Touchups and Repairs";

export interface AgreementSection { heading: string; body: string; }
export const AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    heading: "1. Full Transparency: Why We're Both Your Agents and Your Repair Team",
    body: `As your listing agents, Alex and Nate Watson are also the owners of ${ENTITY_ALEX} and ${ENTITY_NATE} — together operating as ${DIVISION_NAME}, the team performing this work. We want to be upfront about that — not because it's a conflict, but because it's the whole reason this program exists. Rather than handing you off to a stranger and hoping it goes well, we put our own name, our own crew, and our own schedule behind the work, because we have just as much riding on a smooth, successful sale as you do. That means no marked-up middleman, one point of contact instead of three, and a team that's motivated to get your home market-ready — right, and on time. Florida law requires us to disclose that we (and our companies) are paid separately for this work, in addition to any real estate commission we earn on your sale. Consider this that disclosure — given openly, because we think it's a better way to do business, not something to bury in the fine print.`,
  },
  {
    heading: "2. Not a Licensed General Contractor — Scope of Work",
    body: `Neither ${ENTITY_NATE} nor ${ENTITY_ALEX} is a licensed general contractor. The work covered by this Agreement is limited to non-structural, non-permitted cosmetic and maintenance items only — the kind listed in your itemized quote (painting, pressure washing, landscaping, cleaning, junk removal, and minor handyman repairs). Anything requiring a licensed trade — electrical, plumbing, roofing, HVAC, structural work, and similar — is not performed by us. See Section 8.`,
  },
  {
    heading: "3. Pricing & Payment",
    body: "Total price for the Scope of Work is set out in your itemized quote and is part of this Agreement. 50% deposit is due before work begins. The remaining 50% is due upon completion, before the job is considered closed out. Deposits are non-refundable once materials have been purchased or labor has been scheduled with less than 48 hours' notice. Your quote is valid for 14 days from the date it's issued.",
  },
  {
    heading: "4. If Payment Isn't Made",
    body: "If the deposit isn't received, we won't schedule or begin work. If final payment isn't made upon completion, we may pause any remaining or future work under this or any other agreement with you until the balance is resolved, and pursue the unpaid balance through ordinary collection remedies available under Florida law. We do not assert, and this Agreement does not create, any lien or other claim against your property.",
  },
  {
    heading: "5. Conditions Discovered Once Work Begins",
    body: "Your price reflects the scope, quantities, and condition we observed during your walkthrough. Every quantity, square footage, and unit count on your itemized quote is a maximum, not a guarantee of exact usage. If we discover something once work is underway that wasn't part of that original scope — rot, mold, structural issues, pest damage, code violations, and similar — or if the work exceeds the stated maximums, we'll stop and present it to you as a separate change order in writing. We won't perform or charge for any additional work without your approval first.",
  },
  {
    heading: "6. Color Matching & Material Disclaimers",
    body: "Paint and material color matches are made by visual sample only. Some variance in sheen or tone from the original surface is possible due to substrate age, weathering, or changes in manufacturer formulation over time. You'll approve your color/material sample before we purchase anything.",
  },
  {
    heading: "7. Your Responsibilities",
    body: "You agree to provide on-site access, water, and electricity for the duration of the work, and to secure pets and personal property in and around the work area. If a delay is caused by lack of access, we may charge a reasonable rescheduling fee.",
  },
  {
    heading: "8. Vendor-Quoted (Licensed Trade) Items",
    body: "Any item in your quote marked \u201cVendor-Quoted\u201d is performed by an independent, licensed, and insured third-party contractor from our preferred vendor network — not by Brothers Group. We facilitate the introduction and quote request only. Pricing, licensing, insurance, scheduling, and workmanship for that work are solely between you and the vendor, under a separate agreement with them. Brothers Group assumes no liability for vendor-performed work. Vendor pricing varies by square footage, site conditions, and other trade-specific criteria — the amount shown at consultation is an estimate, confirmed once the vendor schedules and assesses the job directly.",
  },
  {
    heading: "9. Our Work — Limited Warranty",
    body: "We stand behind the work we perform. For 30 days after completion, we'll return and correct, at no charge, any workmanship defect directly caused by our crew on the items listed in your quote. This warranty does not cover normal wear and tear, weather events, damage caused by others, pre-existing conditions, or any item outside the original Scope of Work.",
  },
  {
    heading: "10. Limitation of Liability",
    body: "Our liability under this Agreement, for any claim of any kind, is limited to the total amount you paid us for the Scope of Work. We are not liable for indirect, incidental, or consequential damages, including delays to your closing or sale timeline. This Agreement does not guarantee that your home will sell, or sell within any particular timeframe or price.",
  },
  {
    heading: "11. Cancellation",
    body: "Either party may cancel this Agreement before work begins by written notice. If you cancel after your deposit has been used to purchase materials or after labor has been scheduled with less than 48 hours' notice, the deposit is non-refundable as described in Section 3.",
  },
  {
    heading: "12. Resolving Disagreements",
    body: "If a disagreement comes up, we agree to first try to work it out directly, in good faith. If we can't, either party may pursue any remedy available under Florida law. This Agreement is governed by the laws of the State of Florida, and any legal proceeding will be brought in Nassau or Duval County, Florida. The prevailing party in any dispute is entitled to recover its reasonable attorneys' fees and costs.",
  },
  {
    heading: "13. Entire Agreement",
    body: "This Agreement, together with your itemized quote, is the entire agreement between you and Brothers Group regarding this Scope of Work, and replaces any prior discussion or understanding on the subject. If any part of this Agreement is found unenforceable, the rest remains in full effect.",
  },
];

// ─── EMAIL: In-house quote (to agent + admin, always fires the moment a quote is generated) ─
// v20.24.0 — Alex: "remove the itemized breakdown but keep the total
// pricing." No more per-line dollar amount here — scope is listed (so the
// client sees exactly what's included) but pricing is isolated to a single
// Total figure below this table.
function quoteItemsTable(items: any[]): string {
  const rows = items.map(it => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12.5px;color:#1a1a1a">${it.name}${it.two_story ? " <span style='color:#888;font-size:11px'>(2-story)</span>" : ""}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12.5px;color:#1a1a1a;text-align:right">${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}</td>
    </tr>`).join("");
  return `
  <table style="width:100%;border-collapse:collapse;margin-top:10px">
    <thead>
      <tr>
        <th style="text-align:left;padding:6px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.gray};border-bottom:2px solid ${BRAND.black}">Item</th>
        <th style="text-align:right;padding:6px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.gray};border-bottom:2px solid ${BRAND.black}">Qty</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function startWindowLabel(consult: any): string {
  if (consult.start_window === "specific" && consult.start_date) {
    return `${consult.start_date}${consult.start_time ? " at " + consult.start_time : ""}`;
  }
  const map: Record<string, string> = {
    asap: "As soon as possible", within_1_week: "Within 1 week",
    "1_2_weeks": "1–2 weeks", "2_4_weeks": "2–4 weeks",
  };
  return map[consult.start_window] || "To be scheduled";
}

// v20.13.0 — Momentum messaging: shown at quote time (before signing/deposit)
// to keep the homeowner hopeful and ready to move forward. Deliberately
// non-committal ("often", "depending on trade") — the real start date is
// still locked behind the signed + deposit-received gate; this is copy only.
const START_MOMENTUM_HTML =
  "Good news — depending on the trade, we can often get crews started as soon as tomorrow. " +
  "And the moment repairs wrap up, we move right into photos &amp; video for your listing. Let's keep this moving!";
const START_MOMENTUM_PLAIN =
  "Good news — depending on the trade, we can often get crews started as soon as tomorrow. " +
  "And the moment repairs wrap up, we move right into photos & video for your listing. Let's keep this moving!";
const START_MOMENTUM_PDF_LINE =
  "Start Availability: Often as soon as tomorrow, depending on trade.";

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
    ${BRAND.contactLine}
  </div>`;
}

// v20.20.0 — the 50/50 payment terms used to be a single 12px gray line under
// the total. Alex wants it big and unmissable so clients see up front how
// affordable the split is — this renders as a bold black banner with the two
// dollar amounts large and legible.
function depositSplitHtml(consult: any): string {
  return `
  <div style="margin-top:14px;background:${BRAND.black};border-radius:8px;padding:16px 18px;display:flex;justify-content:space-between;gap:10px">
    <div style="text-align:center;flex:1">
      <p style="margin:0;color:rgba(255,255,255,0.55);font-size:10.5px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700">50% To Start</p>
      <p style="margin:4px 0 0;color:#fff;font-size:20px;font-weight:800">$${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}</p>
    </div>
    <div style="width:1px;background:rgba(255,255,255,0.15)"></div>
    <div style="text-align:center;flex:1">
      <p style="margin:0;color:rgba(255,255,255,0.55);font-size:10.5px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700">50% On Completion</p>
      <p style="margin:4px 0 0;color:#fff;font-size:20px;font-weight:800">$${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}</p>
    </div>
  </div>`;
}

// v20.20.0 — shows the full "one-stop-shop" scope by listing vendor-coordinated
// (licensed trade) service NAMES ONLY — never a dollar amount, and never
// summed into Brothers Group's total/deposit math. Standing rule from Alex:
// vendor pricing is always separate.
function vendorScopeHtml(vendorItems: any[]): string {
  if (!vendorItems || vendorItems.length === 0) return "";
  const names = vendorItems.map((v: any) => `<li style="margin-bottom:4px">${v.name}</li>`).join("");
  return `
  <div style="margin-top:16px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px">
    <p style="margin:0 0 6px;font-size:11px;color:${BRAND.gray};text-transform:uppercase;letter-spacing:0.06em;font-weight:700">Also Coordinating For You (Licensed Trade — One Stop Shop)</p>
    <ul style="margin:0;padding-left:18px;font-size:12.5px;color:#333">${names}</ul>
    <p style="margin:8px 0 0;font-size:10.5px;color:${BRAND.gray};font-style:italic">These are quoted and billed separately by our vetted vendor partners — not included in the Brothers Group total above.</p>
  </div>`;
}

// v20.20.0 — reads the blank (unsigned) 2-page Agreement PDF off disk and
// base64-encodes it for a Resend attachment, so every client email carries a
// physical, printable copy with the signature page — not just the web link.
function agreementAttachment(consult: any): { filename: string; content: string }[] {
  if (!consult.agreement_pdf_url) return [];
  try {
    const filePath = path.join(repairPdfDir(), path.basename(consult.agreement_pdf_url));
    if (!fs.existsSync(filePath)) return [];
    const bytes = fs.readFileSync(filePath);
    return [{ filename: "Repair-Renovation-Agreement.pdf", content: bytes.toString("base64") }];
  } catch { return []; }
}

export async function sendInHouseQuoteInternal(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const allItems = getConsultItems(consultId);
  const items = allItems.filter((i: any) => i.category === "in_house");
  const vendorItems = allItems.filter((i: any) => i.category === "vendor");
  if (!consult || items.length === 0) return;

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Instant Quote — In-House Quote Generated", consult.property_address)}
    <div style="padding:20px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:6px">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:130px">Client</td><td style="font-weight:600">${consult.client_name || "—"}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Agent</td><td>${consult.agent_name || "—"}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Requested Start</td><td>${startWindowLabel(consult)}</td></tr>
      </table>
      ${quoteItemsTable(items)}
      <table style="width:100%;margin-top:12px">
        <tr><td style="padding:4px 10px;text-align:right;font-size:12.5px;color:${BRAND.gray}">Subtotal</td><td style="padding:4px 10px;text-align:right;font-size:12.5px;width:110px">$${consult.subtotal.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:4px 10px;text-align:right;font-size:14px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:14px;font-weight:700;width:110px">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
      </table>
      ${depositSplitHtml(consult)}
      ${vendorScopeHtml(vendorItems)}
      ${consult.agreement_pdf_url ? `<p style="margin-top:14px;font-size:12px"><a href="${consult.agreement_pdf_url.startsWith("http") ? consult.agreement_pdf_url : APP_URL + consult.agreement_pdf_url}" style="color:${BRAND.black};font-weight:700">View the signature-ready Agreement PDF (2 pages, w/ Terms &amp; signature lines) →</a></p>` : ""}
      <div style="margin-top:18px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px;font-size:12px;color:#333">
        This quote has NOT been sent to the client yet. Open the consult in Lead Depot to review, then tap <strong>Send to Client</strong> to deliver the branded quote with the accept link.
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAILS,
    subject: `Instant Quote — ${consult.property_address} — $${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}`,
    html,
  });
}

// ─── EMAIL: Client-facing quote w/ accept link ──────────────────────────────
export async function sendClientQuoteEmail(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const allItems = getConsultItems(consultId);
  const items = allItems.filter((i: any) => i.category === "in_house");
  const vendorItems = allItems.filter((i: any) => i.category === "vendor");
  if (!consult || !consult.client_email) return;

  const acceptUrl = `${APP_URL}/#/repair-quote/${consult.quote_token}`;
  const heroImg = consult.hero_photo_url
    ? `<img src="${consult.hero_photo_url.startsWith("http") ? consult.hero_photo_url : APP_URL + consult.hero_photo_url}" alt="${consult.property_address}" style="width:100%;max-height:260px;object-fit:cover;display:block" />`
    : "";

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Your Repair Proposal", consult.property_address)}
    ${heroImg}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${consult.client_name || "there"} — here's the proposal we walked through together. Everything below is work our own crew handles in-house.</p>
      ${quoteItemsTable(items)}
      <table style="width:100%;margin-top:14px">
        <tr><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700;width:110px">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
      </table>
      ${depositSplitHtml(consult)}
      ${vendorScopeHtml(vendorItems)}
      <div style="margin-top:16px;padding:14px 16px;background:#f0f9f0;border:1px solid #cfe8cf;border-radius:6px">
        <p style="font-size:13px;color:#1a1a1a;line-height:1.55;margin:0"><strong style="color:${BRAND.green}">${START_MOMENTUM_HTML}</strong></p>
      </div>
      <div style="text-align:center;margin:28px 0 10px">
        <a href="${acceptUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block">Review &amp; Accept Proposal</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${acceptUrl}" style="color:${BRAND.gray}">${acceptUrl}</a></p>
      <p style="font-size:11px;color:${BRAND.gray};text-align:center;margin-top:10px">The full signature-ready Repair &amp; Renovation Agreement (with Terms &amp; signature page) is attached to this email as a PDF.</p>
      <div style="margin-top:22px;border-top:1px solid ${BRAND.border};padding-top:14px">
        <p style="font-size:10px;color:${BRAND.gray};line-height:1.6">${IN_HOUSE_TERMS.join(" ")}</p>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: [consult.client_email],
    cc: ADMIN_EMAILS,
    subject: `Your Repair Proposal — ${consult.property_address}`,
    html,
    attachments: agreementAttachment(consult),
  });

  rawDb.prepare(`UPDATE repair_consults SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(consultId);
}

// ─── EMAIL: One-click green Approval (mode=approve, no typing required) ───────
export async function sendApprovalEmail(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const allItems = getConsultItems(consultId);
  const items = allItems.filter((i: any) => i.category === "in_house");
  const vendorItems = allItems.filter((i: any) => i.category === "vendor");
  if (!consult || !consult.client_email) return;
  if (!consult.quote_token) throw new Error("Quote must be generated before sending an approval email");

  const approveUrl = `${APP_URL}/#/repair-quote/${consult.quote_token}?mode=approve`;
  const heroImg = consult.hero_photo_url
    ? `<img src="${consult.hero_photo_url.startsWith("http") ? consult.hero_photo_url : APP_URL + consult.hero_photo_url}" alt="${consult.property_address}" style="width:100%;max-height:220px;object-fit:cover;display:block" />`
    : "";

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Ready for Your Approval", consult.property_address)}
    ${heroImg}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${consult.client_name || "there"} — your repair proposal and full agreement are ready. Tap the button below to review and approve — no printing or typing required.</p>
      ${quoteItemsTable(items)}
      <table style="width:100%;margin-top:14px">
        <tr><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700;width:110px">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
      </table>
      ${depositSplitHtml(consult)}
      ${vendorScopeHtml(vendorItems)}
      <div style="margin-top:16px;padding:14px 16px;background:#f0f9f0;border:1px solid #cfe8cf;border-radius:6px">
        <p style="font-size:13px;color:#1a1a1a;line-height:1.55;margin:0"><strong style="color:${BRAND.green}">${START_MOMENTUM_HTML}</strong></p>
      </div>
      <div style="text-align:center;margin:28px 0 10px">
        <a href="${approveUrl}" style="background:${BRAND.green};color:#fff;text-decoration:none;padding:16px 44px;border-radius:6px;font-size:15px;font-weight:700;display:inline-block">✓ Approve Proposal</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${approveUrl}" style="color:${BRAND.gray}">${approveUrl}</a></p>
      <p style="font-size:11px;color:${BRAND.gray};text-align:center;margin-top:10px">Full Terms &amp; Conditions are shown on the approval page before you approve. The full signature-ready Agreement is also attached to this email as a PDF.</p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: [consult.client_email],
    cc: ADMIN_EMAILS,
    subject: `Approve Your Repair Proposal — ${consult.property_address}`,
    html,
    attachments: agreementAttachment(consult),
  });

  rawDb.prepare(`UPDATE repair_consults SET approval_email_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(consultId);
}

// ─── EMAIL: Vendor quote-request dispatch ───────────────────────────────────
export async function dispatchVendorEmails(consultId: number) {
  if (!resend) return { sent: 0 };
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "vendor");
  if (!consult || items.length === 0) return { sent: 0 };

  const byTrade = new Map<string, any[]>();
  for (const it of items) {
    if (!byTrade.has(it.trade)) byTrade.set(it.trade, []);
    byTrade.get(it.trade)!.push(it);
  }

  let sent = 0;
  for (const [trade, tradeItems] of byTrade) {
    const vendor = rawDb.prepare(`SELECT * FROM repair_vendors WHERE trade = ? AND active = 1 ORDER BY id LIMIT 1`).get(trade) as any;
    const toEmail = vendor?.email;
    if (!toEmail) continue; // no vendor on file for this trade yet — surfaced in admin as a gap

    const photoLinks = tradeItems.flatMap((it: any) => {
      try { return JSON.parse(it.photos || "[]"); } catch { return []; }
    });
    const photosHtml = photoLinks.length
      ? `<div style="margin-top:14px">${photoLinks.map((u: string) => `<img src="${u.startsWith("http") ? u : APP_URL + u}" style="width:130px;height:130px;object-fit:cover;border-radius:6px;margin:4px" />`).join("")}</div>`
      : "";

    const itemsHtml = tradeItems.map((it: any) => `
      <li style="margin-bottom:8px;font-size:13px;color:#333">
        <strong>${it.name}</strong>${it.measurement_notes ? ` — ${it.measurement_notes}` : ""}
      </li>`).join("");

    // v20.32.8 — this is a referral to OUR CLIENT's property, not our own job.
    // Surface the client's name/phone so the vendor knows who they'd actually
    // be doing the work for and can reach them directly to set up the visit,
    // while the quote itself still comes back to us (Alex/Nate) per Alex's
    // standing instruction so we can track/upload it just like Mike Carlton/HVAC.
    const clientRowHtml = consult.client_name
      ? `<p style="font-size:13px;color:#333"><strong>Client:</strong> ${consult.client_name}${consult.client_phone ? ` — ${consult.client_phone}` : ""}</p>`
      : "";
    const clientPhoneClause = consult.client_phone ? ` at <strong>${consult.client_phone}</strong>` : "";

    const html = `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#fff">
      ${brandedHeader("Quote Request", consult.property_address)}
      <div style="padding:24px 32px">
        <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi${(vendor.contact_name || vendor.name) ? " " + (vendor.contact_name || vendor.name) : ""} — this is a referral from Brothers Group. We're preparing to list one of our clients' homes for sale, and they need the following done at their property. We'd like you to quote it for them directly — since we're working against a listing timeline, time is of the essence and we appreciate you teaming up with us to keep this moving:</p>
        <ul style="padding-left:18px">${itemsHtml}</ul>
        ${photosHtml}
        <p style="font-size:13px;color:#333;margin-top:16px"><strong>Property:</strong> ${consult.property_address}</p>
        ${clientRowHtml}
        <p style="font-size:13px;color:#333"><strong>Desired Start:</strong> ${startWindowLabel(consult)}</p>
        <p style="font-size:12.5px;color:#333;margin-top:14px">Please send your quote and earliest availability back to us — <strong>alex@watsonbrothersgroup.com</strong> and <strong>nate@watsonbrothersgroup.com</strong> at Brothers Group. As one of our preferred vendors, our standard payout-at-close arrangement applies where offered — happy to discuss.</p>
        <p style="font-size:12.5px;color:#333;margin-top:10px">If you'd like to schedule a time to come take a look in person before quoting, feel free to call the client directly${clientPhoneClause} to set it up, or call us at <strong>(904) 504-3794</strong> and we'll help coordinate.</p>
      </div>
      ${brandedFooter()}
    </div>
    </body></html>`;

    await resend.emails.send({
      from: FROM,
      to: [toEmail],
      cc: ADMIN_EMAILS,
      subject: `Quote Request — ${trade.replace(/_/g, " ")} — ${consult.property_address}`,
      html,
    });

    const itemIds = tradeItems.map((it: any) => it.id);
    rawDb.prepare(`
      INSERT INTO repair_vendor_dispatches (consult_id, trade, vendor_id, vendor_email, item_ids, sent_at, status)
      VALUES (?, ?, ?, ?, ?, datetime('now'), 'sent')
    `).run(consultId, trade, vendor.id, toEmail, JSON.stringify(itemIds));
    sent++;
  }

  return { sent, tradesWithoutVendor: [...byTrade.keys()].filter(t => !rawDb.prepare(`SELECT 1 FROM repair_vendors WHERE trade = ? AND active = 1`).get(t)) };
}

// ─── EMAIL: Work order (fires to admins the moment client accepts) ─────────
// v20.32.0 — fires the moment a contract is FULLY executed (admin
// countersignature or confirmed print-signed evidence). Generates the
// Work Order & Final Checklist PDF (photos + full chronological scope +
// start date + target completion/deadline) and emails it to BOTH the
// admins AND the client — this is the punch-list document used at final
// walkthrough before releasing final payment.
export async function sendWorkOrderEmail(consultId: number) {
  const workOrderUrl = await generateWorkOrderPdf(consultId);
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId)
    .filter((i: any) => i.category === "in_house")
    .sort((a: any, b: any) => a.sequence_order - b.sequence_order);
  if (!consult) return;
  const targetCompletion = computeTargetCompletionDate(consult);

  if (!resend) {
    rawDb.prepare(`UPDATE repair_consults SET status = 'work_order_sent', work_order_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(consultId);
    fireMilestoneTasks("repair_punch_out", {
      clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
      contextNote: `Work order sent — ${consult.property_address}`,
    }).then((created) => logProjectMeeting(consultId, "punch_out", created[0]?.taskId ?? null))
      .catch((e) => console.warn("milestone fire failed (repair_punch_out):", e));
    return;
  }

  const stepsHtml = items.map((it: any, idx: number) => {
    const qtyLabel = `${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`;
    return `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12px;color:${BRAND.gray};width:26px">${idx + 1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:13px;color:#1a1a1a">${it.name}${it.two_story ? " (2-story)" : ""} — ${qtyLabel}${it.instruction ? `<br/><span style="color:${BRAND.gray};font-size:11px;font-style:italic">${it.instruction}</span>` : ""}</td>
    </tr>`;
  }).join("");

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("✅ Contract Signed — Work Order & Final Checklist", consult.property_address)}
    <div style="padding:22px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:14px">
        <tr><td style="padding:3px 0;color:${BRAND.gray};width:140px">Client</td><td style="font-weight:600">${consult.client_name}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Signed By</td><td>${consult.accepted_signature_name || "—"}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Countersigned</td><td>${consult.countersigned_at ? "Yes — " + consult.countersigned_at : (consult.print_signed_confirmed_at ? "Yes (print-signed) — " + consult.print_signed_confirmed_at : "—")}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Start Date</td><td style="font-weight:700">${startWindowLabel(consult)}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Target Completion / Deadline</td><td style="font-weight:700">${targetCompletion || "To be set"}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Contract Total</td><td style="font-weight:700">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Deposit Collected?</td><td>Confirm 50% ($${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) before dispatching a crew.</td></tr>
      </table>
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${BRAND.gray};font-weight:700;margin-bottom:6px">Full Scope — Materials, Quantities &amp; Build Order (Chronological)</p>
      <table style="width:100%;border-collapse:collapse">${stepsHtml}</table>
      <p style="font-size:11px;color:${BRAND.gray};margin-top:14px">The attached Work Order &amp; Final Checklist PDF includes this scope, every job photo on file, and a sign-off block for the final walkthrough — use it to confirm every item is complete before releasing final payment.</p>
      <div style="margin-top:16px;text-align:center">
        <a href="${APP_URL}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">Open in Lead Depot</a>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  const recipients = consult.client_email ? [consult.client_email] : ADMIN_EMAILS;
  const ccList = consult.client_email ? ADMIN_EMAILS : undefined;

  await resend.emails.send({
    from: FROM,
    to: recipients,
    ...(ccList ? { cc: ccList } : {}),
    subject: `✅ Work Order & Final Checklist — ${consult.property_address} — Start ${startWindowLabel(consult)}`,
    html,
    attachments: [...workOrderAttachment({ ...consult, work_order_pdf_url: workOrderUrl })],
  });

  rawDb.prepare(`UPDATE repair_consults SET status = 'work_order_sent', work_order_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(consultId);
  fireMilestoneTasks("repair_punch_out", {
    clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
    contextNote: `Work order sent — ${consult.property_address}`,
  }).then((created) => logProjectMeeting(consultId, "punch_out", created[0]?.taskId ?? null))
    .catch((e) => console.warn("milestone fire failed (repair_punch_out):", e));
}

// ─── Draw an image into a fixed box WITHOUT distorting its aspect ratio ────
// pdf-lib's drawImage stretches to exactly fill width/height, which skews any
// photo that doesn't match the box's ratio. This scales the photo to fit
// fully inside the box (preserving its native aspect ratio) and centers it,
// filling any letterbox margin with a black bar to match the brand's
// black-and-white bar styling used elsewhere on these documents.
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

// v20.30.0 — Alex: the other scope/gallery photos (front-of-house hero is
// separate, shown on page 1) give the itemized quote more legitimacy on the
// work being proposed. Appends a 2x3 photo-grid page for every 6 photos,
// paginating as needed. Photos that can't be read from disk are silently
// skipped (no broken-image placeholder box) rather than shown as an error.
async function addScopePhotosPages(
  pdfDoc: any,
  fontBold: any,
  font: any,
  fontItalic: any,
  photos: { url: string; tag?: string }[],
  propertyAddress: string
) {
  if (!photos || photos.length === 0) return;
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const PAGE_W = 612, PAGE_H = 792;
  const cols = 2, rows = 3, perPage = cols * rows;
  const marginX = 38;
  const gap = 14;
  const imgW = (PAGE_W - marginX * 2 - gap) / cols;
  const imgH = 148;
  const captionH = 12;
  const cellH = imgH + captionH + gap;

  for (let pageStart = 0; pageStart < photos.length; pageStart += perPage) {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - 40;
    const title = "Additional Scope Photos";
    const titleW = fontBold.widthOfTextAtSize(title, 16);
    page.drawText(title, { x: (PAGE_W - titleW) / 2, y, size: 16, font: fontBold, color: black });
    y -= 20;
    page.drawRectangle({ x: marginX, y: y - 20, width: PAGE_W - marginX * 2, height: 20, color: black });
    page.drawText(propertyAddress || "", { x: marginX + 5, y: y - 14, size: 9.5, font: fontBold, color: rgb(1, 1, 1) });
    y -= 40;

    const chunk = photos.slice(pageStart, pageStart + perPage);
    for (let i = 0; i < chunk.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const boxX = marginX + col * (imgW + gap);
      const boxY = y - row * cellH;
      const photo = chunk[i];
      try {
        const p = resolveConsultPhotoPath(photo.url);
        if (p && fs.existsSync(p)) {
          const bytes = fs.readFileSync(p);
          const img = photo.url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
          drawContainedImage(page, img, { x: boxX, y: boxY, width: imgW, height: imgH });
          const label = photo.tag === "repair_scope" ? "Repair Scope" : "Property Photo";
          page.drawText(label, { x: boxX, y: boxY - imgH - 10, size: 7.5, font: fontItalic, color: gray });
        }
      } catch { /* non-fatal — skip this photo if unreadable, leave grid slot blank */ }
    }
  }
}

// ─── PDF QUOTE (pdf-lib, matches Brothers Group letterhead) ────────────────
export async function generateQuotePdf(consultId: number): Promise<string> {
  const consult = getConsultRow(consultId);
  const allItems = getConsultItems(consultId);
  const items = allItems.filter((i: any) => i.category === "in_house");
  const vendorItems = allItems.filter((i: any) => i.category === "vendor");
  if (!consult) throw new Error("Consult not found");

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const green = rgb(0, 0.5, 0);

  let y = 792 - 40;
  // Logo
  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const w = 220;
    const h = w * (logoImg.height / logoImg.width);
    page.drawImage(logoImg, { x: (612 - w) / 2, y: y - h, width: w, height: h });
    y -= h + 24;
  } catch { y -= 10; }

  const title = "Repair Proposal";
  const titleWidth = fontBold.widthOfTextAtSize(title, 20);
  page.drawText(title, { x: (612 - titleWidth) / 2, y, size: 20, font: fontBold, color: black });
  y -= 26;

  // Property bar
  page.drawRectangle({ x: 38, y: y - 22, width: 536, height: 22, color: black });
  page.drawText(consult.property_address, { x: 43, y: y - 15, size: 10, font: fontBold, color: rgb(1, 1, 1) });
  y -= 40;

  // Hero photo
  if (consult.hero_photo_url) {
    try {
      const heroPath = resolveConsultPhotoPath(consult.hero_photo_url);
      if (heroPath && fs.existsSync(heroPath)) {
        const bytes = fs.readFileSync(heroPath);
        const img = consult.hero_photo_url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const w = 536, h = 180;
        drawContainedImage(page, img, { x: 38, y, width: w, height: h });
        y -= h + 18;
      }
    } catch { /* non-fatal — skip hero image if unreadable */ }
  }

  // Items table
  // v20.24.0 — Alex: keep the total, drop the itemized $ breakdown. Item +
  // Qty columns only; no per-line Amount, no Subtotal line.
  const colLabelX = 38, colQtyX = 480, colAmtX = 480;
  page.drawText("Item", { x: colLabelX, y, size: 9, font: fontBold, color: gray });
  page.drawText("Qty", { x: colQtyX, y, size: 9, font: fontBold, color: gray });
  y -= 6;
  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 1, color: black });
  y -= 14;

  let rowIdx = 0;
  for (const it of items) {
    if (y < 195) { break; } // guard against overflow on very long scopes (v20.20.0 — raised to fit the boxed 50/50 + vendor callout)
    if (rowIdx % 2 === 1) page.drawRectangle({ x: 38, y: y - 4, width: 536, height: 16, color: lightGray });
    const label = it.two_story ? `${it.name} (2-story)` : it.name;
    page.drawText(label.slice(0, 60), { x: colLabelX, y: y, size: 9, font, color: black });
    page.drawText(`${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`, { x: colQtyX, y, size: 9, font, color: black });
    y -= 16;
    rowIdx++;
  }

  y -= 10;
  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.5, color: gray });
  y -= 18;
  // v20.18.0 — show package discount (if any) as its own line before the total.
  if (consult.package_discount_amount && Number(consult.package_discount_amount) > 0) {
    const pkgRow = REPAIR_PACKAGES.find((p: any) => p.key === consult.package_key);
    const pkgLabel = pkgRow ? `Package Discount (${pkgRow.name})` : "Package Discount";
    page.drawText(pkgLabel.slice(0, 55), { x: colAmtX - 210, y, size: 9.5, font, color: green });
    page.drawText(`-$${Number(consult.package_discount_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 9.5, font, color: green });
    y -= 18;
  }
  page.drawText("Total", { x: colAmtX - 70, y, size: 13, font: fontBold, color: black });
  page.drawText(`$${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 13, font: fontBold, color: black });
  y -= 16;
  // v20.18.0 — sign-today free-item incentive, called out separately from pricing.
  if (consult.free_item_applied_key) {
    const freeItem = IN_HOUSE_ITEMS.find(i => i.key === consult.free_item_applied_key);
    // Plain "FREE:" prefix, not a unicode checkmark — WinAnsi (pdf-lib's default
    // Helvetica encoding) can't encode U+2713 and throws at render time.
    page.drawText(`FREE: ${freeItem?.name || consult.free_item_applied_key} (sign-today incentive)`, { x: 38, y, size: 9.5, font: fontBold, color: green });
    y -= 16;
  }
  // v20.20.0 — 50/50 payment terms made large, bold, and boxed so it reads as
  // the headline affordability message, not fine print.
  y -= 4;
  page.drawRectangle({ x: 38, y: y - 30, width: 536, height: 30, color: rgb(0.94, 0.98, 0.94) });
  page.drawText("50% DEPOSIT TO START", { x: 48, y: y - 12, size: 10, font: fontBold, color: green });
  page.drawText(`$${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: 48, y: y - 25, size: 13, font: fontBold, color: black });
  page.drawText("50% ON COMPLETION", { x: 320, y: y - 12, size: 10, font: fontBold, color: green });
  page.drawText(`$${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: 320, y: y - 25, size: 13, font: fontBold, color: black });
  y -= 42;
  page.drawText(START_MOMENTUM_PDF_LINE, { x: 38, y, size: 9.5, font: fontBold, color: rgb(0, 0.35, 0) });
  y -= 14;

  // v20.20.0 — Additional (vendor-coordinated) services, shown with NO price so
  // the client sees the full one-stop-shop scope without vendor $ ever being
  // summed into Brothers Group's total/deposit math (standing rule).
  if (vendorItems.length > 0 && y > 95) {
    page.drawText("ALSO COORDINATING (licensed trade — quoted separately by our vendor partners):", { x: 38, y, size: 7.5, font: fontBold, color: gray });
    y -= 10;
    const vendorNames = vendorItems.map((v: any) => v.name).join("  ·  ");
    for (const line of wrapText(vendorNames, font, 7.5, 536).slice(0, 2)) {
      page.drawText(line, { x: 38, y, size: 7.5, font, color: rgb(0.3, 0.3, 0.3) });
      y -= 9;
    }
  }
  if (y > 78) {
    page.drawText("Full signature-ready Repair & Renovation Agreement (2 pages, with Terms & signature lines) provided separately.", { x: 38, y, size: 6.8, font: fontItalic, color: gray });
  }

  // Footer terms (small print)
  const footerY = 70;
  page.drawRectangle({ x: 0, y: 0, width: 612, height: footerY, color: rgb(0.5, 0.5, 0.5) });
  const termsText = IN_HOUSE_TERMS.join(" ");
  const wrapped = wrapText(termsText, font, 6.5, 536);
  let ty = footerY - 12;
  for (const line of wrapped.slice(0, 6)) {
    page.drawText(line, { x: 38, y: ty, size: 6.5, font, color: rgb(1, 1, 1) });
    ty -= 8;
  }

  // v20.30.0 — Alex: show the other scope/gallery photos on the quote too,
  // not just the front-of-house hero — gives the client more confidence the
  // proposal reflects the actual property. Dedupe against the hero photo.
  const scopePhotos = (consult.property_photos || []).filter((p: any) => p?.url && p.url !== consult.hero_photo_url);
  if (scopePhotos.length > 0) {
    await addScopePhotosPages(pdfDoc, fontBold, font, fontItalic, scopePhotos, consult.property_address);
  }

  const bytes = await pdfDoc.save();
  const outDir = repairPdfDir();
  const filename = `quote-${consultId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  const url = `/repair-quotes/${filename}`;
  // v20.30.0 — persist so the itemized quote PDF can be re-opened later
  // (view-anytime, not just the moment it was generated) — mirrors how
  // agreement_pdf_url already works for the signature-ready agreement.
  rawDb.prepare(`UPDATE repair_consults SET quote_pdf_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
  return url;
}

function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
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

// ─── TWO-PAGE REPAIR & RENOVATION AGREEMENT PDF (pdf-lib) ─────────────────
// Page 1 (front) = branded estimate/scope + client info pre-fill + signature
// block. Page 2 (back) = full 13-section Terms & Conditions, two-column.
// `opts.blank=true` renders empty signature lines (Print & Sign hand-out).
// Otherwise, if the consult has already been accepted, the client signature
// line shows the captured e-signature name/timestamp/IP instead of a blank line.
export async function generateAgreementPdf(consultId: number, opts: { blank?: boolean } = {}): Promise<string> {
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "in_house");
  if (!consult) throw new Error("Consult not found");

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const green = rgb(0, 0.5, 0);
  const PAGE_W = 612, PAGE_H = 792;

  // ── PAGE 1 — FRONT: Estimate, Scope & Signatures ──────────────────────────
  const p1 = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 34;

  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const w = 160;
    const h = w * (logoImg.height / logoImg.width);
    p1.drawImage(logoImg, { x: (PAGE_W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
  } catch { y -= 6; }

  const divisionLabel = DIVISION_NAME.toUpperCase();
  const divW = fontBold.widthOfTextAtSize(divisionLabel, 10.5);
  p1.drawText(divisionLabel, { x: (PAGE_W - divW) / 2, y, size: 10.5, font: fontBold, color: black });
  y -= 14;
  const subLabel = "an in-house division of Brothers Group at Momentum Realty";
  const subW = font.widthOfTextAtSize(subLabel, 8);
  p1.drawText(subLabel, { x: (PAGE_W - subW) / 2, y, size: 8, font, color: gray });
  y -= 18;

  const title = "Repair & Renovation Agreement";
  const titleWidth = fontBold.widthOfTextAtSize(title, 16);
  p1.drawText(title, { x: (PAGE_W - titleWidth) / 2, y, size: 16, font: fontBold, color: black });
  y -= 8;
  const pageTag = "Page 1 of 2 — Estimate, Scope of Work & Signatures";
  const pageTagW = font.widthOfTextAtSize(pageTag, 8);
  p1.drawText(pageTag, { x: (PAGE_W - pageTagW) / 2, y: y - 10, size: 8, font: fontItalic, color: gray });
  y -= 24;

  // Property bar
  p1.drawRectangle({ x: 38, y: y - 20, width: 536, height: 20, color: black });
  p1.drawText(consult.property_address || "Property TBD", { x: 43, y: y - 14, size: 10, font: fontBold, color: rgb(1, 1, 1) });
  y -= 32;

  // Client info line (pre-filled)
  const infoParts = [
    consult.client_name ? `Client: ${consult.client_name}` : "Client: ____________________",
    `Date: ${new Date().toLocaleDateString("en-US")}`,
  ];
  if (consult.client_phone) infoParts.push(`Phone: ${consult.client_phone}`);
  p1.drawText(infoParts.join("      "), { x: 38, y, size: 8.5, font, color: rgb(0.2, 0.2, 0.2) });
  y -= 16;

  // Hero photo (walkthrough photo captured room-by-room, hero selected)
  if (consult.hero_photo_url) {
    try {
      const heroPath = resolveConsultPhotoPath(consult.hero_photo_url);
      if (heroPath && fs.existsSync(heroPath)) {
        const bytes = fs.readFileSync(heroPath);
        const img = consult.hero_photo_url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const w = 536, h = 130;
        drawContainedImage(p1, img, { x: 38, y, width: w, height: h });
        y -= h + 14;
      }
    } catch { /* non-fatal — skip hero image if unreadable */ }
  }

  // Items table
  // v20.24.0 — Alex: keep the total, drop the itemized $ breakdown.
  const colLabelX = 38, colQtyX = 480, colAmtX = 480;
  p1.drawText("Item", { x: colLabelX, y, size: 8.5, font: fontBold, color: gray });
  p1.drawText("Qty", { x: colQtyX, y, size: 8.5, font: fontBold, color: gray });
  y -= 6;
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 1, color: black });
  y -= 13;

  let rowIdx = 0;
  const rowFloor = 248; // leave room for totals + signature block below (grew slightly in v20.20.0 for the boxed 50/50 line)
  for (const it of items) {
    if (y < rowFloor) break;
    if (rowIdx % 2 === 1) p1.drawRectangle({ x: 38, y: y - 3, width: 536, height: 14, color: lightGray });
    const label = it.two_story ? `${it.name} (2-story)` : it.name;
    p1.drawText(label.slice(0, 62), { x: colLabelX, y, size: 8.5, font, color: black });
    p1.drawText(`${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`, { x: colQtyX, y, size: 8.5, font, color: black });
    y -= 14;
    rowIdx++;
  }

  y -= 8;
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.5, color: gray });
  y -= 16;
  p1.drawText("Total", { x: colAmtX - 70, y, size: 12, font: fontBold, color: black });
  p1.drawText(`$${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 12, font: fontBold, color: black });
  y -= 14;
  // v20.20.0 — 50/50 terms enlarged + boxed to match the client quote PDF (was tiny gray text).
  p1.drawRectangle({ x: 38, y: y - 24, width: 536, height: 24, color: rgb(0.94, 0.98, 0.94) });
  p1.drawText(`50% DEPOSIT TO START: $${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: 46, y: y - 16, size: 10, font: fontBold, color: green });
  p1.drawText(`50% ON COMPLETION: $${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: 320, y: y - 16, size: 10, font: fontBold, color: green });
  y -= 34;
  p1.drawText(START_MOMENTUM_PDF_LINE, { x: 38, y, size: 8.5, font: fontBold, color: rgb(0, 0.35, 0) });
  y -= 14;
  p1.drawText("Full Terms & Conditions (Sections 1–13) on the reverse — part of this Agreement by reference.", { x: 38, y, size: 7.5, font: fontItalic, color: gray });
  y -= 22;

  // ── Signature block ──
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.75, color: black });
  y -= 16;
  const isSigned = !opts.blank && consult.status === "accepted" && consult.accepted_signature_name;
  if (isSigned) {
    p1.drawText("CLIENT — Signed Electronically", { x: 38, y, size: 8, font: fontBold, color: green });
    y -= 13;
    p1.drawText(`${consult.accepted_signature_name}`, { x: 38, y, size: 11, font: fontItalic, color: black });
    p1.drawText(`Signed: ${consult.accepted_at || ""}  ·  IP: ${consult.accepted_ip || "—"}`, { x: 300, y: y + 1, size: 7, font, color: gray });
    y -= 20;
  } else {
    p1.drawText("Client Signature:", { x: 38, y, size: 8.5, font, color: gray });
    p1.drawLine({ start: { x: 130, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.75, color: black });
    p1.drawText("Date:", { x: 410, y, size: 8.5, font, color: gray });
    p1.drawLine({ start: { x: 440, y: y - 2 }, end: { x: 574, y: y - 2 }, thickness: 0.75, color: black });
    y -= 24;
  }

  p1.drawText(ENTITY_NATE, { x: 38, y, size: 8.5, font: fontBold, color: black });
  y -= 12;
  p1.drawText("Representative Signature:", { x: 38, y, size: 8, font, color: gray });
  p1.drawLine({ start: { x: 165, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.75, color: black });
  p1.drawText("Date:", { x: 410, y, size: 8, font, color: gray });
  p1.drawLine({ start: { x: 440, y: y - 2 }, end: { x: 574, y: y - 2 }, thickness: 0.75, color: black });
  y -= 20;

  p1.drawText(ENTITY_ALEX, { x: 38, y, size: 8.5, font: fontBold, color: black });
  y -= 12;
  p1.drawText("Representative Signature:", { x: 38, y, size: 8, font, color: gray });
  p1.drawLine({ start: { x: 165, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.75, color: black });
  p1.drawText("Date:", { x: 410, y, size: 8, font, color: gray });
  p1.drawLine({ start: { x: 440, y: y - 2 }, end: { x: 574, y: y - 2 }, thickness: 0.75, color: black });

  // ── PAGE 2 — BACK: Full Terms & Conditions (two-column) ──────────────────
  const p2 = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let py = PAGE_H - 36;
  const backTitle = "Terms & Conditions";
  const backTitleW = fontBold.widthOfTextAtSize(backTitle, 14);
  p2.drawText(backTitle, { x: (PAGE_W - backTitleW) / 2, y: py, size: 14, font: fontBold, color: black });
  py -= 6;
  const backSub = "Page 2 of 2 — This page is part of the Repair & Renovation Agreement";
  const backSubW = font.widthOfTextAtSize(backSub, 7.5);
  p2.drawText(backSub, { x: (PAGE_W - backSubW) / 2, y: py - 10, size: 7.5, font: fontItalic, color: gray });
  py -= 24;
  p2.drawLine({ start: { x: 38, y: py }, end: { x: 574, y: py }, thickness: 1, color: black });
  py -= 14;

  const colTop = py;
  const colWidth = 250;
  const colGap = 36;
  const colX = [38, 38 + colWidth + colGap];
  const colFloor = 66;
  let col = 0;
  let cy = colTop;

  const advance = (lines: number, lineHeight: number) => {
    if (cy - lines * lineHeight < colFloor) {
      col++;
      cy = colTop;
    }
  };

  for (const section of AGREEMENT_SECTIONS) {
    const headingLines = wrapText(section.heading, fontBold, 7.8, colWidth);
    const bodyLines = wrapText(section.body, font, 7, colWidth);
    const totalLines = headingLines.length + bodyLines.length + 1;
    if (col > 1) break; // safety guard — should never overflow 2 columns given content length
    advance(totalLines, 9);
    if (col > 1) break;
    for (const hl of headingLines) {
      p2.drawText(hl, { x: colX[col], y: cy, size: 7.8, font: fontBold, color: black });
      cy -= 9.5;
    }
    for (const bl of bodyLines) {
      p2.drawText(bl, { x: colX[col], y: cy, size: 7, font, color: rgb(0.15, 0.15, 0.15) });
      cy -= 8.5;
    }
    cy -= 7;
  }

  // Footer disclosure line
  const footerNote = `This Agreement, together with the attached itemized quote, is between the Client and ${ENTITY_NATE} and ${ENTITY_ALEX}, jointly operating as ${DIVISION_NAME}.`;
  const footerLines = wrapText(footerNote, fontItalic, 6.5, 536);
  let fy = 40;
  for (const line of footerLines) {
    const fw = fontItalic.widthOfTextAtSize(line, 6.5);
    p2.drawText(line, { x: (PAGE_W - fw) / 2, y: fy, size: 6.5, font: fontItalic, color: gray });
    fy -= 8;
  }

  const bytes = await pdfDoc.save();
  const outDir = repairPdfDir();
  const filename = `agreement-${consultId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  const url = `/repair-quotes/${filename}`;

  if (opts.blank) {
    rawDb.prepare(`UPDATE repair_consults SET agreement_pdf_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
  } else {
    rawDb.prepare(`UPDATE repair_consults SET signed_agreement_pdf_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
  }
  return url;
}

// v20.32.0 — target completion / punch-out deadline. Admin can set an exact
// date via target_completion_date; otherwise infer a reasonable placeholder
// (start_date + 14 days) purely for the Work Order document — never used to
// gate billing or scheduling logic elsewhere.
function computeTargetCompletionDate(consult: any): string | null {
  if (consult.target_completion_date) return consult.target_completion_date;
  if (consult.start_window === "specific" && consult.start_date) {
    const d = new Date(consult.start_date);
    if (!isNaN(d.getTime())) {
      d.setDate(d.getDate() + 14);
      return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    }
  }
  return null;
}

// ─── PDF WORK ORDER & FINAL CHECKLIST (photos + chronological scope) ───────
// v20.32.0 — generated the moment a contract is fully executed (admin
// countersignature OR confirmed print-signed evidence). This is the punch-
// list crews/admin/client use at final walkthrough before releasing final
// payment: full scope in build order, quantities as materials/scope detail,
// start date + target completion, and every scope/gallery photo on file.
export async function generateWorkOrderPdf(consultId: number): Promise<string> {
  const consult = getConsultRow(consultId);
  if (!consult) throw new Error("Consult not found");
  const allItems = getConsultItems(consultId);
  const inHouseItems = allItems.filter((i: any) => i.category === "in_house").sort((a: any, b: any) => a.sequence_order - b.sequence_order);
  const vendorItems = allItems.filter((i: any) => i.category === "vendor").sort((a: any, b: any) => a.sequence_order - b.sequence_order);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const PAGE_W = 612, PAGE_H = 792;
  const targetCompletion = computeTargetCompletionDate(consult);

  const p1 = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 34;

  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const w = 150;
    const h = w * (logoImg.height / logoImg.width);
    p1.drawImage(logoImg, { x: (PAGE_W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
  } catch { y -= 6; }

  const title = "Work Order & Final Checklist";
  const titleWidth = fontBold.widthOfTextAtSize(title, 17);
  p1.drawText(title, { x: (PAGE_W - titleWidth) / 2, y, size: 17, font: fontBold, color: black });
  y -= 10;
  const pageTag = "For crew reference and final walkthrough sign-off before release of final payment";
  const pageTagW = font.widthOfTextAtSize(pageTag, 8);
  p1.drawText(pageTag, { x: (PAGE_W - pageTagW) / 2, y, size: 8, font: fontItalic, color: gray });
  y -= 22;

  p1.drawRectangle({ x: 38, y: y - 20, width: 536, height: 20, color: black });
  p1.drawText(consult.property_address || "Property TBD", { x: 43, y: y - 14, size: 10, font: fontBold, color: rgb(1, 1, 1) });
  y -= 32;

  // Key-dates strip — start date + target completion/deadline, side by side
  p1.drawRectangle({ x: 38, y: y - 30, width: 536, height: 30, color: lightGray });
  p1.drawText("START DATE", { x: 46, y: y - 11, size: 7.5, font: fontBold, color: gray });
  p1.drawText(startWindowLabel(consult), { x: 46, y: y - 24, size: 10.5, font: fontBold, color: black });
  p1.drawText("TARGET COMPLETION / DEADLINE", { x: 300, y: y - 11, size: 7.5, font: fontBold, color: gray });
  p1.drawText(targetCompletion || "To be set", { x: 300, y: y - 24, size: 10.5, font: fontBold, color: black });
  y -= 42;

  // v20.32.13 Part 5 — tools needed + time-block estimate strip, only drawn
  // when at least one is set (keeps older/unset jobs' PDFs unchanged).
  if (consult.tools_needed || consult.time_block_estimate) {
    p1.drawRectangle({ x: 38, y: y - 30, width: 536, height: 30, color: lightGray });
    p1.drawText("TOOLS NEEDED", { x: 46, y: y - 11, size: 7.5, font: fontBold, color: gray });
    p1.drawText((consult.tools_needed || "—").slice(0, 70), { x: 46, y: y - 24, size: 9.5, font: fontBold, color: black });
    p1.drawText("TIME BLOCK ESTIMATE", { x: 300, y: y - 11, size: 7.5, font: fontBold, color: gray });
    p1.drawText(consult.time_block_estimate || "—", { x: 300, y: y - 24, size: 9.5, font: fontBold, color: black });
    y -= 42;
  }

  const infoLine = [
    consult.client_name ? `Client: ${consult.client_name}` : null,
    `Contract Total: $${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    `Deposit: ${consult.deposit_received_at ? "Received " + consult.deposit_received_at : "Not yet received"}`,
  ].filter(Boolean).join("      ");
  p1.drawText(infoLine, { x: 38, y, size: 8.5, font, color: rgb(0.2, 0.2, 0.2) });
  y -= 18;

  p1.drawText("Scope of Work — In Build Order", { x: 38, y, size: 10.5, font: fontBold, color: black });
  y -= 6;
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 1, color: black });
  y -= 14;

  const rowFloor = 60;
  let rowIdx = 0;
  for (const it of inHouseItems) {
    const qtyLabel = `${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`;
    const nameLine = `${it.two_story ? "[2-story] " : ""}${it.name} — ${qtyLabel}`;
    const instrLines = it.instruction ? wrapText(it.instruction, fontItalic, 7.5, 470) : [];
    const rowsNeeded = 1 + instrLines.length;
    if (y - rowsNeeded * 11 < rowFloor) {
      // paginate — continue the checklist on a fresh page
      const cont = pdfDoc.addPage([PAGE_W, PAGE_H]);
      cont.drawText("Scope of Work — continued", { x: 38, y: PAGE_H - 40, size: 10.5, font: fontBold, color: black });
      cont.drawLine({ start: { x: 38, y: PAGE_H - 46 }, end: { x: 574, y: PAGE_H - 46 }, thickness: 1, color: black });
      p1.drawText("", { x: 0, y: 0, size: 1, font });
      (pdfDoc as any)._workOrderCurrentPage = cont;
      y = PAGE_H - 60;
    }
    const page = (pdfDoc as any)._workOrderCurrentPage || p1;
    if (rowIdx % 2 === 1) page.drawRectangle({ x: 38, y: y - 3, width: 536, height: 11 + instrLines.length * 10, color: lightGray });
    page.drawText("\u2610", { x: 40, y, size: 9, font: fontBold, color: black });
    page.drawText(nameLine.slice(0, 90), { x: 56, y, size: 8.5, font: fontBold, color: black });
    y -= 10;
    for (const line of instrLines) {
      page.drawText(line, { x: 56, y, size: 7.5, font: fontItalic, color: gray });
      y -= 9.5;
    }
    y -= 3;
    rowIdx++;
  }

  if (vendorItems.length > 0) {
    const page = (pdfDoc as any)._workOrderCurrentPage || p1;
    if (y < 90) { y = PAGE_H - 60; }
    y -= 6;
    page.drawText("Vendor-Coordinated (billed separately — confirm with vendor, not this checklist)", { x: 38, y, size: 8.5, font: fontBold, color: gray });
    y -= 12;
    for (const v of vendorItems) {
      page.drawText(`\u2022 ${v.name}`, { x: 46, y, size: 8, font: fontItalic, color: gray });
      y -= 11;
    }
  }

  // Punch-out sign-off block on whichever page we ended on
  {
    const page = (pdfDoc as any)._workOrderCurrentPage || p1;
    let sy = Math.min(y - 16, 110);
    if (sy < 70) sy = 70;
    page.drawLine({ start: { x: 38, y: sy }, end: { x: 574, y: sy }, thickness: 0.75, color: black });
    sy -= 16;
    page.drawText("Final Walkthrough Confirmation — all items above complete and approved by client before final payment release.", { x: 38, y: sy, size: 8, font: fontItalic, color: gray });
    sy -= 20;
    page.drawText("Client Signature:", { x: 38, y: sy, size: 8.5, font, color: gray });
    page.drawLine({ start: { x: 130, y: sy - 2 }, end: { x: 400, y: sy - 2 }, thickness: 0.75, color: black });
    page.drawText("Date:", { x: 410, y: sy, size: 8.5, font, color: gray });
    page.drawLine({ start: { x: 440, y: sy - 2 }, end: { x: 574, y: sy - 2 }, thickness: 0.75, color: black });
  }

  // Scope/gallery photos — reuse the same photo-grid helper as the quote PDF.
  const galleryPhotos: { url: string; tag?: string }[] = [];
  try {
    const props = consult.property_photos ? JSON.parse(consult.property_photos) : [];
    for (const url of props) galleryPhotos.push({ url, tag: "property" });
  } catch { /* non-fatal */ }
  for (const it of inHouseItems) {
    try {
      const photos = it.photos ? JSON.parse(it.photos) : [];
      for (const url of photos) galleryPhotos.push({ url, tag: "repair_scope" });
    } catch { /* non-fatal */ }
  }
  await addScopePhotosPages(pdfDoc, fontBold, font, fontItalic, galleryPhotos, consult.property_address);

  const bytes = await pdfDoc.save();
  const outDir = repairPdfDir();
  const filename = `workorder-${consultId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  const url = `/repair-quotes/${filename}`;
  rawDb.prepare(`UPDATE repair_consults SET work_order_pdf_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
  return url;
}

function workOrderAttachment(consult: any): { filename: string; content: string }[] {
  if (!consult.work_order_pdf_url) return [];
  try {
    const filePath = path.join(repairPdfDir(), path.basename(consult.work_order_pdf_url));
    if (!fs.existsSync(filePath)) return [];
    const bytes = fs.readFileSync(filePath);
    return [{ filename: "Work-Order-Final-Checklist.pdf", content: bytes.toString("base64") }];
  } catch { return []; }
}

// v20.32.0 — permanent record. Writes one row per fully-executed contract
// into repair_consult_archives, which no DELETE route ever touches. Always
// called AFTER both PDFs (signed agreement + work order) are generated so
// their URLs are captured in the snapshot.
async function archiveSignedConsult(consultId: number, signatureMethod: string) {
  const consult = getConsultRow(consultId);
  if (!consult) return;
  const items = getConsultItems(consultId);
  const changeOrders = getChangeOrdersForConsult(consultId);
  const snapshot = JSON.stringify({ consult, items, changeOrders, archived_at: new Date().toISOString() });
  rawDb.prepare(`
    INSERT INTO repair_consult_archives (consult_id, signature_method, property_address, client_name, total, agreement_pdf_url, work_order_pdf_url, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(consultId, signatureMethod, consult.property_address, consult.client_name, consult.total, consult.signed_agreement_pdf_url || consult.agreement_pdf_url, consult.work_order_pdf_url, snapshot);
}

// ─── ROW HELPERS ─────────────────────────────────────────────────────────────
// v20.32.13 Part 5 — log a project-meeting row for the given consult/type,
// linking the FUB task created for the same lifecycle event (if any). One
// row per meeting_type per consult — if one already exists (e.g. re-firing
// the same trigger), update it instead of duplicating.
function logProjectMeeting(consultId: number, meetingType: "initial_start" | "punch_out" | "final_payment", fubTaskId: number | null, notes?: string) {
  try {
    const existing = rawDb.prepare(`SELECT id FROM repair_project_meetings WHERE consult_id = ? AND meeting_type = ?`).get(consultId, meetingType) as any;
    if (existing) {
      rawDb.prepare(`UPDATE repair_project_meetings SET fub_task_id = COALESCE(?, fub_task_id), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`).run(fubTaskId, notes || null, existing.id);
    } else {
      rawDb.prepare(`INSERT INTO repair_project_meetings (consult_id, meeting_type, fub_task_id, notes) VALUES (?, ?, ?, ?)`).run(consultId, meetingType, fubTaskId, notes || null);
    }
  } catch (err: any) {
    console.warn("logProjectMeeting failed:", err?.message || err);
  }
}

function getConsultRow(id: number): any {
  const row = rawDb.prepare(`
    SELECT rc.*, a.name AS agent_name, a.email AS agent_email
    FROM repair_consults rc
    LEFT JOIN agents a ON a.id = rc.agent_id
    WHERE rc.id = ?
  `).get(id) as any;
  if (row && row.property_photos) {
    try {
      const parsed = JSON.parse(row.property_photos);
      // v20.15.2 — normalize legacy plain-string entries to { url, tag } shape.
      row.property_photos = parsed.map((entry: any) => typeof entry === "string" ? { url: entry, tag: "overview" } : entry);
    } catch { row.property_photos = []; }
  }
  return row;
}
function getConsultItems(consultId: number): any[] {
  return rawDb.prepare(`SELECT * FROM repair_consult_items WHERE consult_id = ? ORDER BY sequence_order ASC, id ASC`).all(consultId) as any[];
}

// ─── CHANGE ORDERS (v20.15.1) ────────────────────────────────────────────────
// Flow: agent/admin requests -> admin office-approves (or declines) -> client
// e-signs -> line item inserted into repair_consult_items + consult totals
// recalculated -> "Change Order Approved" email fires showing the delta.
// Declining a change order has zero financial impact — it just closes the row.
function getChangeOrderRow(id: number): any {
  return rawDb.prepare(`
    SELECT co.*, rc.property_address, rc.client_name, rc.client_email, rc.client_phone,
           rc.total AS consult_total_before, rc.hero_photo_url,
           a.name AS requested_by_name
    FROM repair_change_orders co
    JOIN repair_consults rc ON rc.id = co.consult_id
    LEFT JOIN agents a ON a.id = co.requested_by_agent_id
    WHERE co.id = ?
  `).get(id) as any;
}

function getChangeOrdersForConsult(consultId: number): any[] {
  return rawDb.prepare(`SELECT * FROM repair_change_orders WHERE consult_id = ? ORDER BY requested_at DESC`).all(consultId) as any[];
}

function changeOrderDescription(co: any): string {
  return co.custom_description || co.item_key || "Additional work";
}

// Recompute repair_consults subtotal/total/deposit/final from its in_house
// line items — the exact same math as the /items endpoint. Called after a
// signed change order inserts a new consult_item row, so a change order never
// has its own parallel pricing path.
function recalcConsultTotals(consultId: number) {
  const items = rawDb.prepare(`SELECT line_total FROM repair_consult_items WHERE consult_id = ? AND category = 'in_house'`).all(consultId) as any[];
  const subtotal = items.reduce((sum, it) => sum + (Number(it.line_total) || 0), 0);
  rawDb.prepare(`
    UPDATE repair_consults SET subtotal = ?, total = ?, deposit_amount = ?, final_amount = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(subtotal, subtotal, subtotal / 2, subtotal / 2, consultId);
}

// ─── PDF: Change Order (simple one-pager, mirrors brand styling) ───────────
async function generateChangeOrderPdf(changeOrderId: number): Promise<string> {
  const co = getChangeOrderRow(changeOrderId);
  if (!co) throw new Error("Change order not found");

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const green = rgb(0, 0.5, 0);
  const PAGE_W = 612, PAGE_H = 792;
  let y = PAGE_H - 40;

  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const w = 180;
    const h = w * (logoImg.height / logoImg.width);
    page.drawImage(logoImg, { x: (PAGE_W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 14;
  } catch { y -= 6; }

  const title = "Change Order";
  const titleW = fontBold.widthOfTextAtSize(title, 18);
  page.drawText(title, { x: (PAGE_W - titleW) / 2, y, size: 18, font: fontBold, color: black });
  y -= 26;

  page.drawRectangle({ x: 38, y: y - 20, width: 536, height: 20, color: black });
  page.drawText(co.property_address || "Property TBD", { x: 43, y: y - 14, size: 10, font: fontBold, color: rgb(1, 1, 1) });
  y -= 40;

  const rows: [string, string][] = [
    ["Client", co.client_name || "\u2014"],
    ["Description", changeOrderDescription(co)],
    ["Quantity", `${co.quantity} ${co.unit === "each" ? "ea" : co.unit === "flat" ? "" : co.unit.replace("_", " ")}`],
    ["Reason", co.reason || "\u2014"],
    ["Requested By", co.requested_by_name || "Office"],
    ["Office Approved", co.decided_by ? `${co.decided_by} \u2014 ${co.decided_at}` : "\u2014"],
  ];
  for (const [label, value] of rows) {
    const lines = wrapText(value, font, 9.5, 400);
    page.drawText(label, { x: 38, y, size: 9, font: fontBold, color: gray });
    for (const l of lines) {
      page.drawText(l, { x: 170, y, size: 9.5, font, color: black });
      y -= 13;
    }
    y -= 2;
  }

  y -= 10;
  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.75, color: black });
  y -= 20;
  page.drawText("Change Order Amount", { x: 38, y, size: 12, font: fontBold, color: black });
  page.drawText(`$${Number(co.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: 460, y, size: 12, font: fontBold, color: black });
  y -= 18;
  page.drawText("New Contract Total", { x: 38, y, size: 10, font, color: gray });
  const newTotal = Number(co.consult_total_before || 0);
  page.drawText(`$${newTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: 460, y, size: 10, font, color: gray });
  y -= 30;

  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.5, color: gray });
  y -= 20;

  if (co.signed_at) {
    page.drawText("CLIENT \u2014 Signed Electronically", { x: 38, y, size: 8, font: fontBold, color: green });
    y -= 13;
    page.drawText(`${co.signature_name}`, { x: 38, y, size: 11, font: fontItalic, color: black });
    page.drawText(`Signed: ${co.signed_at}  \u00b7  IP: ${co.signed_ip || "\u2014"}`, { x: 300, y: y + 1, size: 7, font, color: gray });
  } else {
    page.drawText("Client Signature:", { x: 38, y, size: 8.5, font, color: gray });
    page.drawLine({ start: { x: 130, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.75, color: black });
    page.drawText("Date:", { x: 410, y, size: 8.5, font, color: gray });
    page.drawLine({ start: { x: 440, y: y - 2 }, end: { x: 574, y: y - 2 }, thickness: 0.75, color: black });
  }
  y -= 30;
  const disclaimer = "This Change Order supplements and becomes part of the Repair & Renovation Agreement between the client and Nathaniel Peter Watson LLC / Alexander Gabriel Watson LLC (\u201cBGRE Home Touchups and Repairs\u201d). No additional work described above will be performed, and no additional charge will apply, until the client signs this Change Order.";
  const discLines = wrapText(disclaimer, fontItalic, 7.5, 536);
  for (const l of discLines) { page.drawText(l, { x: 38, y, size: 7.5, font: fontItalic, color: gray }); y -= 10; }

  const bytes = await pdfDoc.save();
  const outDir = repairPdfDir();
  const filename = `change-order-${changeOrderId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  const url = `/repair-quotes/${filename}`;
  rawDb.prepare(`UPDATE repair_change_orders SET updated_at = datetime('now') WHERE id = ?`).run(changeOrderId);
  return url;
}

// ─── EMAIL: Change Order requested (internal, fires the moment it's submitted) ─
async function sendChangeOrderRequestedEmail(changeOrderId: number) {
  if (!resend) return;
  const co = getChangeOrderRow(changeOrderId);
  if (!co) return;
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("New Change Order \u2014 Needs Office Approval", co.property_address)}
    <div style="padding:22px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:10px">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:130px">Client</td><td style="font-weight:600">${co.client_name || "\u2014"}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Description</td><td>${changeOrderDescription(co)}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Reason</td><td>${co.reason}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Requested By</td><td>${co.requested_by_name || "Office"}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Amount</td><td style="font-weight:700">$${Number(co.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>
      <div style="margin-top:12px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px;font-size:12px;color:#333">
        This change order has NOT been sent to the client. Open Lead Depot \u2192 Repair Program \u2192 Change Orders to approve or decline it first.
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({
    from: FROM, to: ADMIN_EMAILS,
    subject: `Change Order Requested \u2014 ${co.property_address} \u2014 $${Number(co.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    html,
  });
}

// ─── EMAIL: Change Order ready for client e-sign (fires after office approval) ─
async function sendChangeOrderSignEmail(changeOrderId: number) {
  if (!resend) return;
  const co = getChangeOrderRow(changeOrderId);
  if (!co || !co.client_email) return;
  const signUrl = `${APP_URL}/#/change-order/${co.sign_token}`;
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Change Order \u2014 Signature Needed", co.property_address)}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${co.client_name || "there"} \u2014 while working on your property, we found something that needs your approval before we continue. Nothing further will be done, and nothing further will be charged, until you review and sign below.</p>
      <table style="width:100%;font-size:12.5px;color:#333;margin:14px 0">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:120px">Description</td><td style="font-weight:600">${changeOrderDescription(co)}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Why</td><td>${co.reason}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Additional Amount</td><td style="font-weight:700">$${Number(co.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>
      <div style="text-align:center;margin:26px 0 10px">
        <a href="${signUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block">Review &amp; Sign Change Order</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${signUrl}" style="color:${BRAND.gray}">${signUrl}</a></p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({
    from: FROM, to: [co.client_email], cc: ADMIN_EMAILS,
    subject: `Change Order \u2014 Signature Needed \u2014 ${co.property_address}`,
    html,
  });
  rawDb.prepare(`UPDATE repair_change_orders SET updated_at = datetime('now') WHERE id = ?`).run(changeOrderId);
}

// ─── EMAIL: Change Order approved by client (fires the moment they sign) ───
async function sendChangeOrderApprovedEmail(changeOrderId: number, newTotal: number) {
  if (!resend) return;
  const co = getChangeOrderRow(changeOrderId);
  if (!co) return;
  const pdfUrl = await generateChangeOrderPdf(changeOrderId).catch(() => null);
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("\u2705 Change Order Signed", co.property_address)}
    <div style="padding:22px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:14px">
        <tr><td style="padding:3px 0;color:${BRAND.gray};width:150px">Description</td><td style="font-weight:600">${changeOrderDescription(co)}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Signed By</td><td>${co.signature_name}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Signed</td><td>${co.signed_at}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Change Order Amount</td><td style="font-weight:700">$${Number(co.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">New Contract Total</td><td style="font-weight:700">$${newTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">New Final Payment Due (50%)</td><td>$${(newTotal / 2).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>
      ${pdfUrl ? `<div style="text-align:center;margin:16px 0"><a href="${APP_URL}${pdfUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">Download Signed Change Order</a></div>` : ""}
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  const to = co.client_email ? [co.client_email] : ADMIN_EMAILS;
  const cc = co.client_email ? ADMIN_EMAILS : undefined;
  await resend.emails.send({
    from: FROM, to, ...(cc ? { cc } : {}),
    subject: `\u2705 Change Order Signed \u2014 ${co.property_address} \u2014 New Total $${newTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    html,
  });
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
export function registerRepairConsultRoutes(app: Express) {
  ensureRepairConsultSchema();

  // ── Catalog (agent-facing checklist source) ──
  // v20.16.0 — also returns a `popularity` map of item_key -> times actually
  // selected across real past consults, so the client can surface a
  // "Frequently Selected" shortlist at the top of the checklist instead of
  // forcing every walkthrough through the full 62-item, 39-trade list.
  // Genuine usage data only — excludes archived rows and anything from a
  // TEST-DELETE-ME gate-verification consult so QA runs never pollute what
  // agents see as "commonly picked."
  app.get("/api/repair-items", (_req: Request, res: Response) => {
    const items = rawDb.prepare(`SELECT * FROM repair_items WHERE active = 1 ORDER BY category, sequence_order ASC`).all();
    const popRows = rawDb.prepare(`
      SELECT rci.item_key AS key, COUNT(*) AS n
      FROM repair_consult_items rci
      JOIN repair_consults rc ON rc.id = rci.consult_id
      WHERE (rc.property_address NOT LIKE '%TEST-DELETE-ME%' OR rc.property_address IS NULL)
        AND rc.status <> 'archived'
      GROUP BY rci.item_key
    `).all() as { key: string; n: number }[];
    const popularity: Record<string, number> = {};
    for (const r of popRows) popularity[r.key] = r.n;
    res.json({ items, popularity });
  });

  // ── Create consult ──
  // v20.14.4 — accepts an optional heroPhotoUrl so Listing Consult can hand
  // off its already-captured front-of-house photo directly at creation time,
  // instead of the agent re-taking the same photo for Repair Consult.
  // v20.18.0 — when NOT handed a heroPhotoUrl (i.e. a standalone Repair
  // Consult, not nested from Listing Consult), auto-fetch a Google Street
  // View front-of-house shot as the default hero. Fully optional — silently
  // no-ops without GOOGLE_MAPS_API_KEY or if imagery isn't found. Manual
  // upload always wins and is never overwritten (see photo route below).
  app.post("/api/repair-consult", async (req: any, res: Response) => {
    const { leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress, heroPhotoUrl } = req.body || {};
    if (!propertyAddress) return res.status(400).json({ error: "propertyAddress is required" });
    let resolvedHero = heroPhotoUrl || null;
    let heroSource: string | null = resolvedHero ? "manual" : null;
    if (!resolvedHero) {
      const streetViewUrl = await ensureStreetViewHero(propertyAddress);
      if (streetViewUrl) { resolvedHero = streetViewUrl; heroSource = "street_view"; }
    }
    const result = rawDb.prepare(`
      INSERT INTO repair_consults (lead_id, agent_id, client_name, client_email, client_phone, property_address, hero_photo_url, hero_photo_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leadId || null, agentId || req.currentAgent?.id || null, clientName || null, clientEmail || null, clientPhone || null, propertyAddress, resolvedHero, heroSource);
    res.json({ id: result.lastInsertRowid, heroPhotoUrl: resolvedHero });
  });

  // ── List active packages (Packages selector, checklist step). MUST be
  // registered before the "/:id" GET below — same "mine" pitfall (Express
  // would try to parse "packages" as a numeric id otherwise). ──
  app.get("/api/repair-consult/packages", (req: any, res: Response) => {
    const rows = rawDb.prepare(`SELECT * FROM repair_packages WHERE active = 1 ORDER BY sort_order ASC`).all() as any[];
    res.json({ packages: rows.map(r => ({
      key: r.key, name: r.name, description: r.description, tier: r.tier,
      discountPct: r.discount_pct, itemKeys: JSON.parse(r.item_keys), vendorItemKeys: r.vendor_item_keys ? JSON.parse(r.vendor_item_keys) : [],
    })) });
  });

  // ── v20.21.0 — read-only incentive settings (sticky live-total preview on
  // the checklist step needs to know the threshold/free-item without any
  // admin auth). Never exposes anything the admin panel doesn't already
  // show publicly on the quote itself once the incentive is active. ──
  app.get("/api/repair-consult/incentive-settings", (req: any, res: Response) => {
    const row = rawDb.prepare(`SELECT * FROM repair_incentive_settings WHERE id = 1`).get() as any;
    if (!row) return res.json({ active: false });
    res.json({
      active: !!row.active, thresholdAmount: row.threshold_amount,
      freeItemKey: row.free_item_key, label: row.label,
    });
  });

  // ── v20.32.13 — Land Clearing pricing settings (read for any signed-in
  // agent — needed by the Change Order acreage-estimate helper) ──
  app.get("/api/land-clearing/settings", (req: any, res: Response) => {
    const row = rawDb.prepare(`SELECT * FROM land_clearing_settings WHERE id = 1`).get() as any;
    res.json({
      basePrice: row.base_price, acreageThreshold: row.acreage_threshold,
      perAcreRate: row.per_acre_rate, markupPct: row.markup_pct,
    });
  });

  // ── v20.32.13 — Admin: update Land Clearing pricing settings ──
  app.patch("/api/admin/land-clearing/settings", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { basePrice, acreageThreshold, perAcreRate, markupPct } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (basePrice !== undefined) { fields.push("base_price = ?"); vals.push(Number(basePrice)); }
    if (acreageThreshold !== undefined) { fields.push("acreage_threshold = ?"); vals.push(Number(acreageThreshold)); }
    if (perAcreRate !== undefined) { fields.push("per_acre_rate = ?"); vals.push(Number(perAcreRate)); }
    if (markupPct !== undefined) { fields.push("markup_pct = ?"); vals.push(Number(markupPct)); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at = datetime('now')");
    rawDb.prepare(`UPDATE land_clearing_settings SET ${fields.join(", ")} WHERE id = 1`).run(...vals);
    const row = rawDb.prepare(`SELECT * FROM land_clearing_settings WHERE id = 1`).get() as any;
    res.json({
      basePrice: row.base_price, acreageThreshold: row.acreage_threshold,
      perAcreRate: row.per_acre_rate, markupPct: row.markup_pct,
    });
  });

  // ── v20.32.13 — Land Clearing acreage-based price estimate. Pulls acreage
  // from Smart Data for the given property if not passed explicitly, applies
  // the tiered formula, and returns both vendor cost and client price as a
  // SUGGESTION only — both remain fully editable wherever this is used
  // (Change Order form). ──
  app.get("/api/land-clearing/estimate", (req: any, res: Response) => {
    const settings = rawDb.prepare(`SELECT * FROM land_clearing_settings WHERE id = 1`).get() as any;
    let acres = req.query.acres !== undefined ? Number(req.query.acres) : null;
    let acresSource: string | null = acres !== null ? "manual_input" : null;
    if ((acres === null || Number.isNaN(acres)) && req.query.propertyAddress) {
      const sd = rawDb.prepare(`SELECT lot_size_acres, lot_size_sqft FROM property_smart_data WHERE property_address = ?`).get(String(req.query.propertyAddress)) as any;
      if (sd?.lot_size_acres) { acres = Number(sd.lot_size_acres); acresSource = "smart_data"; }
      else if (sd?.lot_size_sqft) { acres = Math.round((Number(sd.lot_size_sqft) / 43560) * 100) / 100; acresSource = "smart_data_sqft"; }
    }
    if (acres === null || Number.isNaN(acres)) return res.status(400).json({ error: "acres or a propertyAddress with Smart Data lot size is required" });
    const est = computeLandClearingEstimate(acres, settings);
    res.json({ ...est, acresSource });
  });

  // ── v20.32.13 — Smart Data: read property characteristics for the address.
  // Returns null fields (never 404) so the UI can render an empty/"add
  // manually" state cleanly when nothing has been captured yet. Also
  // reports whether the two Alex-mandated minimum fields are present. ──
  app.get("/api/smart-data", (req: any, res: Response) => {
    const propertyAddress = String(req.query.propertyAddress || "").trim();
    if (!propertyAddress) return res.status(400).json({ error: "propertyAddress is required" });
    const row = rawDb.prepare(`SELECT * FROM property_smart_data WHERE property_address = ?`).get(propertyAddress) as any;
    if (!row) {
      return res.json({
        found: false, propertyAddress, lotSizeAcres: null, lotSizeSqft: null,
        heatedSqft: null, cooledSqft: null, effectiveSqft: null, stories: null,
        bedrooms: null, bathrooms: null, yearBuilt: null, source: null, sourceUrl: null,
        parcelNumber: null, isVacantLand: false,
        hasMinimumRequired: false,
      });
    }
    res.json({
      found: true, propertyAddress: row.property_address,
      lotSizeAcres: row.lot_size_acres, lotSizeSqft: row.lot_size_sqft,
      heatedSqft: row.heated_sqft, cooledSqft: row.cooled_sqft, effectiveSqft: row.effective_sqft,
      stories: row.stories, bedrooms: row.bedrooms, bathrooms: row.bathrooms, yearBuilt: row.year_built,
      source: row.source, sourceUrl: row.source_url, verifiedBy: row.verified_by, verifiedAt: row.verified_at,
      parcelNumber: row.parcel_number, isVacantLand: !!row.is_vacant_land,
      // v20.32.14 — vacant land has no structure, so a parcel # substitutes
      // for heated sqft as the required identifying field.
      hasMinimumRequired: row.is_vacant_land
        ? (row.parcel_number != null && row.parcel_number !== "" && (row.lot_size_acres != null || row.lot_size_sqft != null))
        : (row.heated_sqft != null && (row.lot_size_acres != null || row.lot_size_sqft != null)),
    });
  });

  // ── v20.32.13 — Smart Data: upsert by property_address. Used two ways:
  //  (1) an agent manually filling in the minimum required fields
  //      (heated_sqft + lot size) right in the Smart Data panel —
  //      source defaults to 'manual'.
  //  (2) pushing county-record / sales-package data gathered separately
  //      (via the property-appraiser-lookup workflow or a sales package)
  //      into Lead Depot — caller passes source: 'county_record' or
  //      'sales_package' plus sourceUrl. NOTE: Lead Depot itself has no
  //      browser-automation capability to run a live county lookup —
  //      this endpoint only stores data that was gathered elsewhere and
  //      is being pushed in. ──
  app.post("/api/smart-data", (req: any, res: Response) => {
    const {
      propertyAddress, lotSizeAcres, lotSizeSqft, heatedSqft, cooledSqft, effectiveSqft,
      stories, bedrooms, bathrooms, yearBuilt, source, sourceUrl, verifiedBy,
      parcelNumber, isVacantLand,
    } = req.body || {};
    const addr = String(propertyAddress || "").trim();
    if (!addr) return res.status(400).json({ error: "propertyAddress is required" });
    const src = source && ["county_record", "sales_package", "manual"].includes(source) ? source : "manual";
    const verifier = verifiedBy || req.currentAgent?.name || null;
    // v20.32.14 — is_vacant_land is a real boolean toggle (not a "only fill
    // if blank" field like heated_sqft), so an omitted flag on a push that
    // doesn't mention it should preserve whatever's already on file rather
    // than silently resetting a marked vacant lot back to false.
    const existingRow = rawDb.prepare(`SELECT is_vacant_land FROM property_smart_data WHERE property_address = ?`).get(addr) as any;
    const vacantLandValue = isVacantLand !== undefined ? (isVacantLand ? 1 : 0) : (existingRow ? existingRow.is_vacant_land : 0);
    rawDb.prepare(`
      INSERT INTO property_smart_data
        (property_address, lot_size_acres, lot_size_sqft, heated_sqft, cooled_sqft, effective_sqft,
         stories, bedrooms, bathrooms, year_built, source, source_url, verified_by, verified_at, updated_at,
         parcel_number, is_vacant_land)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
      ON CONFLICT(property_address) DO UPDATE SET
        lot_size_acres = COALESCE(excluded.lot_size_acres, property_smart_data.lot_size_acres),
        lot_size_sqft = COALESCE(excluded.lot_size_sqft, property_smart_data.lot_size_sqft),
        heated_sqft = COALESCE(excluded.heated_sqft, property_smart_data.heated_sqft),
        cooled_sqft = COALESCE(excluded.cooled_sqft, property_smart_data.cooled_sqft),
        effective_sqft = COALESCE(excluded.effective_sqft, property_smart_data.effective_sqft),
        stories = COALESCE(excluded.stories, property_smart_data.stories),
        bedrooms = COALESCE(excluded.bedrooms, property_smart_data.bedrooms),
        bathrooms = COALESCE(excluded.bathrooms, property_smart_data.bathrooms),
        year_built = COALESCE(excluded.year_built, property_smart_data.year_built),
        source = excluded.source,
        source_url = COALESCE(excluded.source_url, property_smart_data.source_url),
        verified_by = excluded.verified_by,
        verified_at = datetime('now'),
        updated_at = datetime('now'),
        parcel_number = COALESCE(excluded.parcel_number, property_smart_data.parcel_number),
        is_vacant_land = excluded.is_vacant_land
    `).run(
      addr,
      lotSizeAcres != null ? Number(lotSizeAcres) : null,
      lotSizeSqft != null ? Number(lotSizeSqft) : null,
      heatedSqft != null ? Number(heatedSqft) : null,
      cooledSqft != null ? Number(cooledSqft) : null,
      effectiveSqft != null ? Number(effectiveSqft) : null,
      stories != null ? Number(stories) : null,
      bedrooms != null ? Number(bedrooms) : null,
      bathrooms != null ? Number(bathrooms) : null,
      yearBuilt != null ? Number(yearBuilt) : null,
      src, sourceUrl || null, verifier,
      parcelNumber != null && String(parcelNumber).trim() !== "" ? String(parcelNumber).trim() : null,
      vacantLandValue,
    );
    const row = rawDb.prepare(`SELECT * FROM property_smart_data WHERE property_address = ?`).get(addr) as any;
    res.json({
      found: true, propertyAddress: row.property_address,
      lotSizeAcres: row.lot_size_acres, lotSizeSqft: row.lot_size_sqft,
      heatedSqft: row.heated_sqft, cooledSqft: row.cooled_sqft, effectiveSqft: row.effective_sqft,
      stories: row.stories, bedrooms: row.bedrooms, bathrooms: row.bathrooms, yearBuilt: row.year_built,
      source: row.source, sourceUrl: row.source_url, verifiedBy: row.verified_by, verifiedAt: row.verified_at,
      parcelNumber: row.parcel_number, isVacantLand: !!row.is_vacant_land,
      hasMinimumRequired: row.is_vacant_land
        ? (row.parcel_number != null && row.parcel_number !== "" && (row.lot_size_acres != null || row.lot_size_sqft != null))
        : (row.heated_sqft != null && (row.lot_size_acres != null || row.lot_size_sqft != null)),
    });
  });

  // ── v20.14.5 — In-progress consults for this agent (resume picker). MUST be
  //    registered before the "/:id" GET below — otherwise Express would try
  //    to parse "mine" as a numeric id and 404. Resumable = not yet accepted
  //    or handed off to the admin work-order flow. ──
  app.get("/api/repair-consult/mine", (req: any, res: Response) => {
    const agentId = parseInt(req.query.agentId as string) || req.currentAgent?.id || null;
    if (!agentId) return res.json({ consults: [] });
    const rows = rawDb.prepare(`
      SELECT id, property_address, client_name, status, updated_at, created_at
      FROM repair_consults
      WHERE agent_id = ? AND status IN ('draft', 'quoted', 'sent')
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(agentId);
    res.json({ consults: rows });
  });

  // ── v20.14.6 — Archive an unfinished consult (soft-delete). Same pattern as
  //    the listing-consult archive route — flips status to 'archived' so it
  //    drops out of /mine and the resume picker, without deleting the row
  //    or its checklist items. ──
  app.post("/api/repair-consult/:id/archive", (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const consult = getConsultRow(id);
    if (!consult) return res.status(404).json({ error: "Not found" });
    rawDb.prepare(`UPDATE repair_consults SET status = 'archived', updated_at = datetime('now') WHERE id = ?`).run(id);
    res.json({ archived: true });
  });

  // ── v20.14.5 — Fetch a consult in full (row + checklist items) for the resume
  //    picker to hydrate the wizard's local state on mount. ──
  app.get("/api/repair-consult/:id", (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const consult = getConsultRow(id);
    if (!consult) return res.status(404).json({ error: "Not found" });
    const items = getConsultItems(id);
    res.json({ ...consult, items, agreementPdfUrl: consult.agreement_pdf_url || null, quotePdfUrl: consult.quote_pdf_url || null });
  });

  // ── Upload a photo (hero, gallery, or per-item). Returns a URL. ──
  app.post("/api/repair-consult/:id/photo", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { imageData, mimeType, kind, tag } = req.body || {}; // kind: 'hero' | 'gallery' | 'item'; tag (gallery only): 'overview' | 'repair_scope'
    if (!imageData || !mimeType) return res.status(400).json({ error: "Missing imageData or mimeType" });
    if (imageData.length > 28000000) return res.status(413).json({ error: "Image too large. Max 20MB." });
    try {
      const sharp = require("sharp");
      const inputBuf = Buffer.from(imageData, "base64");
      const rotated = await sharp(inputBuf).rotate().toBuffer();
      const processed = await sharp(rotated).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, progressive: true }).toBuffer();
      const dir = repairPhotosDir();
      const filename = `${consultId}-${kind || "photo"}-${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir, filename), processed);
      const url = `/repair-photos/${filename}`;

      if (kind === "hero") {
        // v20.18.0 — manual upload always wins; tag the source so a later
        // Street View auto-fetch (there isn't one post-creation today, but
        // this future-proofs it) never overwrites a manual choice.
        rawDb.prepare(`UPDATE repair_consults SET hero_photo_url = ?, hero_photo_source = 'manual', updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
      } else if (kind === "gallery") {
        // v20.15.2 — each gallery entry is now { url, tag }, mirrors listing-consult pattern.
        const row = rawDb.prepare(`SELECT property_photos FROM repair_consults WHERE id = ?`).get(consultId) as any;
        const raw = row?.property_photos ? JSON.parse(row.property_photos) : [];
        const arr = raw.map((entry: any) => typeof entry === "string" ? { url: entry, tag: "overview" } : entry);
        arr.push({ url, tag: tag === "repair_scope" ? "repair_scope" : "overview" });
        rawDb.prepare(`UPDATE repair_consults SET property_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(arr), consultId);
      }
      res.json({ url });
    } catch (err: any) {
      console.error("Repair photo processing error:", err);
      res.status(500).json({ error: "Failed to process image." });
    }
  });

  // v20.15.2 — update an existing gallery photo's tag. Body: { url, tag }.
  app.post("/api/repair-consult/:id/photo-tag", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { url, tag } = req.body || {};
    if (!url || (tag !== "overview" && tag !== "repair_scope")) return res.status(400).json({ error: "url and a valid tag are required" });
    const row = rawDb.prepare(`SELECT property_photos FROM repair_consults WHERE id = ?`).get(consultId) as any;
    const raw = row?.property_photos ? JSON.parse(row.property_photos) : [];
    const arr = raw.map((entry: any) => {
      const normalized = typeof entry === "string" ? { url: entry, tag: "overview" } : entry;
      return normalized.url === url ? { ...normalized, tag } : normalized;
    });
    rawDb.prepare(`UPDATE repair_consults SET property_photos = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(arr), consultId);
    res.json({ ok: true });
  });

  // ── Select (or clear) a package on a consult. Auto-checked items are
  // applied client-side; this just records the choice so /items can price
  // the discount. Passing packageKey: null clears the selection. ──
  app.post("/api/repair-consult/:id/select-package", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { packageKey } = req.body || {};
    if (packageKey) {
      const pkg = rawDb.prepare(`SELECT * FROM repair_packages WHERE key = ? AND active = 1`).get(packageKey) as any;
      if (!pkg) return res.status(404).json({ error: "Package not found" });
    }
    rawDb.prepare(`UPDATE repair_consults SET package_key = ?, updated_at = datetime('now') WHERE id = ?`).run(packageKey || null, consultId);
    res.json({ ok: true });
  });

  // ── Submit checklist items in one pass ──
  // v20.18.0 — applies the selected package's discount (if any) to the
  // in-house subtotal of ONLY that package's item keys, then checks the
  // sign-today free-service incentive against the discounted total.
  app.post("/api/repair-consult/:id/items", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { items } = req.body || {}; // [{ itemKey, quantity, twoStory, photos: [url], measurementNotes }]
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items array is required" });

    const consultRow = rawDb.prepare(`SELECT package_key FROM repair_consults WHERE id = ?`).get(consultId) as any;
    const pkg = consultRow?.package_key
      ? rawDb.prepare(`SELECT * FROM repair_packages WHERE key = ? AND active = 1`).get(consultRow.package_key) as any
      : null;
    const pkgItemKeys: string[] = pkg ? JSON.parse(pkg.item_keys) : [];

    const del = rawDb.prepare(`DELETE FROM repair_consult_items WHERE consult_id = ?`);
    const insert = rawDb.prepare(`
      INSERT INTO repair_consult_items
        (consult_id, item_key, category, trade, name, unit, quantity, unit_rate, two_story, line_total, instruction, photos, measurement_notes, sequence_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const catalogStmt = rawDb.prepare(`SELECT * FROM repair_items WHERE key = ? AND active = 1`);

    let subtotal = 0;
    let packageEligibleSubtotal = 0;
    let anyTwoStory = 0;
    const tx = rawDb.transaction(() => {
      del.run(consultId);
      for (const raw of items) {
        const cat = catalogStmt.get(raw.itemKey) as any;
        if (!cat) continue;
        const qty = Number(raw.quantity) || 0;
        const twoStory = !!raw.twoStory && !!cat.two_story_eligible;
        if (twoStory) anyTwoStory = 1;
        let lineTotal: number | null = null;
        if (cat.category === "in_house") {
          lineTotal = computeLineTotal(cat.default_rate || 0, qty, cat.min_charge || 0, twoStory, !!cat.two_story_eligible);
          subtotal += lineTotal;
          if (pkg && pkgItemKeys.includes(cat.key)) packageEligibleSubtotal += lineTotal;
        }
        const instruction = fillInstruction(cat.instruction || cat.name, qty, cat.unit, twoStory);
        insert.run(
          consultId, cat.key, cat.category, cat.trade, cat.name, cat.unit, qty,
          cat.category === "in_house" ? cat.default_rate : null, twoStory ? 1 : 0, lineTotal,
          instruction, JSON.stringify(raw.photos || []), raw.measurementNotes || null, cat.sequence_order
        );
      }
    });
    tx();

    const discountPct = pkg ? Number(pkg.discount_pct) || 0 : 0;
    const discountAmount = Math.round(packageEligibleSubtotal * discountPct * 100) / 100;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;

    // Sign-today free-service incentive — evaluated against the discounted total.
    const incentive = rawDb.prepare(`SELECT * FROM repair_incentive_settings WHERE id = 1`).get() as any;
    const freeItemKey = (incentive?.active && total >= (incentive?.threshold_amount || Infinity)) ? incentive.free_item_key : null;

    rawDb.prepare(`
      UPDATE repair_consults SET subtotal = ?, total = ?, two_story = ?,
        package_discount_pct = ?, package_discount_amount = ?, free_item_applied_key = ?,
        deposit_amount = ?, final_amount = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(subtotal, total, anyTwoStory, discountPct, discountAmount, freeItemKey, total / 2, total / 2, consultId);

    res.json({ ok: true, subtotal, discountAmount, total, freeItemKey });
  });

  // ── Set start window / specific date+time ──
  // v20.13.0 — Deposit Required Gate: scheduling is locked until signed + deposit received.
  app.post("/api/repair-consult/:id/start-window", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { startWindow, startDate, startTime } = req.body || {};
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (consult.status !== "accepted") {
      return res.status(409).json({ error: "This consult hasn't been signed yet. Scheduling opens once the client signs." });
    }
    if (!consult.deposit_received_at) {
      return res.status(409).json({ error: "Deposit not yet received. Mark the deposit received before scheduling a start date." });
    }
    rawDb.prepare(`
      UPDATE repair_consults SET start_window = ?, start_date = ?, start_time = ?, updated_at = datetime('now') WHERE id = ?
    `).run(startWindow || null, startDate || null, startTime || null, consultId);
    if (startDate) {
      fireMilestoneTasks("repair_start_date", {
        clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
        anchorDate: new Date(startDate),
        contextNote: `Repair start date set (${startDate}) — ${consult.property_address}`,
      }).catch((e) => console.warn("milestone fire failed (repair_start_date):", e));
    }
    res.json({ ok: true });
  });

  // ── Mark deposit received (fast, one-tap; unlocks scheduling) ──
  app.post("/api/repair-consult/:id/mark-deposit-received", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (consult.status !== "accepted") {
      return res.status(409).json({ error: "Client hasn't signed yet — can't take a deposit on an unsigned agreement." });
    }
    const { method, reference } = req.body || {};
    rawDb.prepare(`
      UPDATE repair_consults SET deposit_received_at = datetime('now'), deposit_received_by = ?,
        deposit_method = ?, deposit_reference = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", method || null, reference || null, consultId);
    res.json({ ok: true });
  });

  // ── Generate quote: builds PDF, mints accept token, emails internal notice ──
  app.post("/api/repair-consult/:id/generate-quote", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    try {
      const token = randomBytes(20).toString("hex");
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      rawDb.prepare(`
        UPDATE repair_consults SET status = 'quoted', quote_token = ?, quote_expires_at = ?,
          office_approved_at = NULL, office_approved_by = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(token, expires, consultId);
      const pdfUrl = await generateQuotePdf(consultId);
      const agreementPdfUrl = await generateAgreementPdf(consultId, { blank: true });
      await sendInHouseQuoteInternal(consultId);
      const consult = getConsultRow(consultId);
      res.json({ ok: true, quoteToken: token, pdfUrl, agreementPdfUrl, total: consult.total, acceptUrl: `${APP_URL}/#/repair-quote/${token}` });
    } catch (err: any) {
      console.error("generate-quote error:", err);
      res.status(500).json({ error: "Failed to generate quote", detail: err?.message });
    }
  });

  // ── Send for signature (v20.32.0: Office Approval Gate retired — Alex now
  // countersigns after the homeowner e-signs instead of pre-approving) ──
  app.post("/api/repair-consult/:id/send-to-client", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.quote_token) return res.status(409).json({ error: "Generate the quote first." });
      await sendClientQuoteEmail(consultId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("send-to-client error:", err);
      res.status(500).json({ error: "Failed to send to client" });
    }
  });

  // ── Print & Sign: download/regenerate the blank agreement PDF (admin) ──
  // v20.32.0 — Office Approval Gate retired. Alex/admin can look at — and
  // reprint — this PDF at any point while still editing, no gate at all.
  app.get("/api/repair-consult/:id/agreement-pdf", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      const url = await generateAgreementPdf(consultId, { blank: true });
      res.redirect(url);
    } catch (err: any) {
      console.error("agreement-pdf error:", err);
      res.status(500).json({ error: "Failed to generate agreement PDF", detail: err?.message });
    }
  });

  // ── View/reprint the itemized quote PDF — anytime, no approval needed.
  // v20.30.0 — mirrors agreement-pdf above but for the client-facing
  // itemized quote. Available to any signed-in agent (not admin-only) since
  // the agent who ran the consult needs to be able to re-open it too.
  app.get("/api/repair-consult/:id/quote-pdf", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.quote_token) return res.status(409).json({ error: "Generate the quote first." });
      const url = await generateQuotePdf(consultId);
      res.redirect(url);
    } catch (err: any) {
      console.error("quote-pdf error:", err);
      res.status(500).json({ error: "Failed to generate quote PDF", detail: err?.message });
    }
  });

  // ── Print & Sign: mark a consult as signed via a physically-signed printout ──
  // v20.32.0 — Mark Print-Signed now records EVIDENCE ONLY (photo or PDF of
  // the signed printout). It does NOT finalize the contract by itself —
  // admin must review the evidence and hit Confirm Signed (route below),
  // which is the step that actually flips status to 'accepted'.
  app.post("/api/repair-consult/:id/mark-print-signed", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const { signedBy, imageData, mimeType } = req.body || {};
    if (!signedBy || String(signedBy).trim().length < 2) return res.status(400).json({ error: "signedBy name is required" });
    if (!imageData || !mimeType) return res.status(400).json({ error: "Photo or PDF evidence of the signed printout is required." });
    try {
      const existingForGate = getConsultRow(consultId);
      if (!existingForGate) return res.status(404).json({ error: "Consult not found" });
      if (!existingForGate.quote_token) return res.status(409).json({ error: "Generate the quote first." });
      if (existingForGate.status === "accepted") return res.status(409).json({ error: "This consult is already signed." });
      const dir = repairPhotosDir();
      let uploadUrl: string;
      if (String(mimeType).toLowerCase() === "application/pdf") {
        // PDF evidence: skip the sharp image pipeline, write raw bytes.
        const filename = `${consultId}-print-signed-${Date.now()}.pdf`;
        fs.writeFileSync(path.join(dir, filename), Buffer.from(imageData, "base64"));
        uploadUrl = `/repair-photos/${filename}`;
      } else {
        const sharp = require("sharp");
        const inputBuf = Buffer.from(imageData, "base64");
        const rotated = await sharp(inputBuf).rotate().toBuffer();
        const processed = await sharp(rotated).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, progressive: true }).toBuffer();
        const filename = `${consultId}-print-signed-${Date.now()}.jpg`;
        fs.writeFileSync(path.join(dir, filename), processed);
        uploadUrl = `/repair-photos/${filename}`;
      }
      rawDb.prepare(`
        UPDATE repair_consults SET signature_method = 'print_sign',
          print_signed_at = datetime('now'), print_signed_by = ?, print_signed_upload_url = ?,
          print_signed_confirmed_at = NULL, print_signed_confirmed_by = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(String(signedBy).trim(), uploadUrl, consultId);
      res.json({ ok: true, printSignedUploadUrl: uploadUrl });
    } catch (err: any) {
      console.error("mark-print-signed error:", err);
      res.status(500).json({ error: "Failed to record print-signed agreement", detail: err?.message });
    }
  });

  // v20.32.0, new — Confirm Print-Signed: admin confirms the uploaded
  // evidence is legitimate. THIS is the step that finalizes the contract:
  // status → accepted, signed agreement + Work Order PDF generated,
  // permanently archived, and the Work Order emailed to client + admins.
  app.post("/api/repair-consult/:id/confirm-print-signed", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.print_signed_at) return res.status(409).json({ error: "No print-signed evidence on file yet." });
      if (consult.print_signed_confirmed_at) return res.status(409).json({ error: "Already confirmed." });
      const confirmedBy = req.currentAgent.name || req.currentAgent.email || "Admin";
      rawDb.prepare(`
        UPDATE repair_consults SET status = 'accepted', signature_method = 'print_sign',
          print_signed_confirmed_at = datetime('now'), print_signed_confirmed_by = ?,
          accepted_at = COALESCE(accepted_at, datetime('now')),
          accepted_signature_name = COALESCE(accepted_signature_name, print_signed_by),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(confirmedBy, consultId);
      await generateAgreementPdf(consultId, { blank: false });
      await generateWorkOrderPdf(consultId);
      await archiveSignedConsult(consultId, "print_sign");
      try { await sendWorkOrderEmail(consultId); } catch (e) { console.error("work order send failed:", e); }
      // v20.32.13 Part 4 — milestone task: Initial Start Meeting
      fireMilestoneTasks("repair_contract_signed", {
        clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
        contextNote: `Repair contract signed (print-sign) — ${consult.property_address}`,
      }).then((created) => logProjectMeeting(consultId, "initial_start", created[0]?.taskId ?? null))
        .catch((e) => console.warn("milestone fire failed (repair_contract_signed):", e));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("confirm-print-signed error:", err);
      res.status(500).json({ error: "Failed to confirm print-signed agreement", detail: err?.message });
    }
  });

  // -- Delete a consult permanently -- admin only. v20.31.0 button audit:
  // Alex needs to be able to clean up test/duplicate/abandoned consults from
  // the Repair Program panel. Cascades to items, vendor dispatches, and
  // change orders tied to this consult so no orphan rows are left behind.
  app.delete("/api/repair-consult/:id", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      const del = rawDb.transaction(() => {
        rawDb.prepare("DELETE FROM repair_change_orders WHERE consult_id = ?").run(consultId);
        rawDb.prepare("DELETE FROM repair_vendor_dispatches WHERE consult_id = ?").run(consultId);
        rawDb.prepare("DELETE FROM repair_consult_items WHERE consult_id = ?").run(consultId);
        rawDb.prepare("DELETE FROM repair_consults WHERE id = ?").run(consultId);
      });
      del();
      res.json({ ok: true });
    } catch (err: any) {
      console.error("delete consult error:", err);
      res.status(500).json({ error: "Failed to delete consult", detail: err?.message });
    }
  });

  // v20.32.0, new — Countersign: admin's half of the two-stage e-sign flow.
  // Homeowner already e-signed (status === 'pending_countersignature').
  // Countersigning finalizes the contract: signed agreement + Work Order
  // PDF generated, permanently archived, and the Work Order emailed to
  // client + admins.
  app.post("/api/repair-consult/:id/countersign", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (consult.status !== "pending_countersignature") return res.status(409).json({ error: "This consult isn't awaiting countersignature." });
      const countersignedBy = req.currentAgent.name || req.currentAgent.email || "Admin";
      rawDb.prepare(`
        UPDATE repair_consults SET status = 'accepted', countersigned_at = datetime('now'), countersigned_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(countersignedBy, consultId);
      await generateAgreementPdf(consultId, { blank: false });
      await generateWorkOrderPdf(consultId);
      await archiveSignedConsult(consultId, "e_sign");
      try { await sendWorkOrderEmail(consultId); } catch (e) { console.error("work order send failed:", e); }
      // v20.32.13 Part 4 — milestone task: Initial Start Meeting
      fireMilestoneTasks("repair_contract_signed", {
        clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
        contextNote: `Repair contract signed (e-sign) — ${consult.property_address}`,
      }).then((created) => logProjectMeeting(consultId, "initial_start", created[0]?.taskId ?? null))
        .catch((e) => console.warn("milestone fire failed (repair_contract_signed):", e));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("countersign error:", err);
      res.status(500).json({ error: "Failed to countersign", detail: err?.message });
    }
  });

  // v20.32.13 Part 5 — work order detail fields (tools needed + time-block
  // estimate). Admin-editable any time before/after the work order is sent;
  // if edited after send, the crew-facing PDF is NOT auto-regenerated here —
  // admin should re-send the work order if the crew needs the updated PDF.
  app.patch("/api/repair-consult/:id/work-order-details", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const { toolsNeeded, timeBlockEstimate } = req.body;
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    rawDb.prepare(`UPDATE repair_consults SET tools_needed = ?, time_block_estimate = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(toolsNeeded ?? consult.tools_needed ?? null, timeBlockEstimate ?? consult.time_block_estimate ?? null, consultId);
    res.json({ ok: true });
  });

  // v20.32.13 Part 5 — list the 3 project-meeting rows (initial_start,
  // punch_out, final_payment) for a consult. Rows are created automatically
  // by the milestone engine as each lifecycle stage fires; this is a
  // read/schedule surface, not a create surface (rows always originate from
  // a real lifecycle event so they stay tied to a real FUB task).
  app.get("/api/repair-consult/:id/meetings", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not authenticated" });
    const consultId = parseInt(req.params.id);
    const rows = rawDb.prepare(`SELECT * FROM repair_project_meetings WHERE consult_id = ? ORDER BY id ASC`).all(consultId);
    res.json({ meetings: rows });
  });

  // v20.32.13 Part 5 — admin schedules or completes one of the 3 meetings.
  // meeting_type in the URL must be one of initial_start | punch_out |
  // final_payment. If the row doesn't exist yet (lifecycle event hasn't
  // fired), it's created here so admin can pre-schedule ahead of the trigger.
  app.patch("/api/admin/repair-consult/:id/meetings/:type", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const meetingType = req.params.type;
    if (!["initial_start", "punch_out", "final_payment"].includes(meetingType)) {
      return res.status(400).json({ error: "Invalid meeting type" });
    }
    const { scheduledAt, completedAt, notes } = req.body;
    const existing = rawDb.prepare(`SELECT id FROM repair_project_meetings WHERE consult_id = ? AND meeting_type = ?`).get(consultId, meetingType) as any;
    if (existing) {
      rawDb.prepare(`UPDATE repair_project_meetings SET scheduled_at = COALESCE(?, scheduled_at), completed_at = COALESCE(?, completed_at), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`)
        .run(scheduledAt ?? null, completedAt ?? null, notes ?? null, existing.id);
    } else {
      rawDb.prepare(`INSERT INTO repair_project_meetings (consult_id, meeting_type, scheduled_at, completed_at, notes) VALUES (?, ?, ?, ?, ?)`)
        .run(consultId, meetingType, scheduledAt ?? null, completedAt ?? null, notes ?? null);
    }
    res.json({ ok: true });
  });

  // v20.32.13 Part 5 — mark the full repair job complete (final walkthrough +
  // final payment released). Logs the final_payment meeting row and fires
  // the repair_final_payment_due milestone (invoice/payment-due reminder in
  // FUB) anchored to right now, since "complete" means the job is done and
  // final payment collection starts immediately.
  app.post("/api/repair-consult/:id/mark-complete", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (consult.completed_at) return res.status(409).json({ error: "This job is already marked complete." });
    const completedBy = req.currentAgent.name || req.currentAgent.email || "Admin";
    rawDb.prepare(`UPDATE repair_consults SET completed_at = datetime('now'), completed_by = ?, updated_at = datetime('now') WHERE id = ?`).run(completedBy, consultId);
    try {
      const created = await fireMilestoneTasks("repair_final_payment_due", {
        clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
        contextNote: `Repair job complete, final payment due — ${consult.property_address}`,
      });
      logProjectMeeting(consultId, "final_payment", created[0]?.taskId ?? null, req.body?.notes || null);
    } catch (e) {
      console.warn("milestone fire failed (repair_final_payment_due):", e);
    }
    // v20.32.13 Part 4/7 — completion is also the final-invoice event; fires a
    // separate payment-due reminder (3-day default) alongside the day-0
    // Final/Payment Meeting task fired above.
    fireMilestoneTasks("invoice_sent", {
      clientName: consult.client_name, clientPhone: consult.client_phone, clientEmail: consult.client_email,
      contextNote: `Final invoice ready ($${(consult.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}) — ${consult.property_address}`,
    }).catch((e) => console.warn("milestone fire failed (invoice_sent):", e));
    res.json({ ok: true });
  });

  // ── Dispatch vendor quote requests ──
  app.post("/api/repair-consult/:id/dispatch-vendors", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    try {
      const result = await dispatchVendorEmails(consultId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("dispatch-vendors error:", err);
      res.status(500).json({ error: "Failed to dispatch vendor emails" });
    }
  });

  // ── Public: fetch quote by token (client accept page) ──
  app.get("/api/repair-quote/:token", (req: Request, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE quote_token = ?`).get(req.params.token) as any;
    if (!consult) return res.status(404).json({ error: "Quote not found" });
    const allItems = getConsultItems(consult.id);
    const items = allItems.filter((i: any) => i.category === "in_house");
    const vendorItems = allItems.filter((i: any) => i.category === "vendor").map((v: any) => ({ name: v.name }));
    res.json({
      consult: {
        propertyAddress: consult.property_address,
        clientName: consult.client_name,
        heroPhotoUrl: consult.hero_photo_url,
        propertyPhotos: consult.property_photos ? JSON.parse(consult.property_photos).map((e: any) => typeof e === "string" ? { url: e, tag: "overview" } : e) : [],
        subtotal: consult.subtotal, total: consult.total,
        depositAmount: consult.deposit_amount, finalAmount: consult.final_amount,
        startWindow: consult.start_window, startDate: consult.start_date, startTime: consult.start_time,
        startMomentum: START_MOMENTUM_PLAIN,
        status: consult.status, acceptedAt: consult.accepted_at,
        quoteExpiresAt: consult.quote_expires_at,
        signatureMethod: consult.signature_method,
        agreementPdfUrl: consult.agreement_pdf_url || null,
      },
      items,
      vendorItems,
      terms: IN_HOUSE_TERMS,
      agreementSections: AGREEMENT_SECTIONS,
    });
  });

  // ── Public: client e-signs ── v20.32.0: two-stage flow. Homeowner e-signing
  // no longer finalizes the contract by itself — it moves the consult to
  // 'pending_countersignature' and waits for the admin to countersign
  // (see POST /api/repair-consult/:id/countersign above). This is what
  // generates the signed agreement, the Work Order PDF, archives, and
  // sends the Work Order email — not this route.
  app.post("/api/repair-quote/:token/accept", async (req: Request, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE quote_token = ?`).get(req.params.token) as any;
    if (!consult) return res.status(404).json({ error: "Quote not found" });
    const { signatureName, method } = req.body || {};
    if (!signatureName || String(signatureName).trim().length < 2) return res.status(400).json({ error: "Full name required to sign" });
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const signatureMethod = method === "email_approval" ? "email_approval" : "e_sign";

    rawDb.prepare(`
      UPDATE repair_consults SET status = 'pending_countersignature', accepted_at = datetime('now'),
        accepted_signature_name = ?, accepted_ip = ?, signature_method = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(signatureName).trim(), ip, signatureMethod, consult.id);

    if (resend) {
      try {
        await resend.emails.send({
          from: FROM,
          to: ADMIN_EMAILS,
          subject: `Countersignature needed — ${consult.property_address}`,
          html: `<p><strong>${String(signatureName).trim()}</strong> just e-signed the repair agreement for <strong>${consult.property_address}</strong>.</p>
            <p>Open the Repair Program panel and click <strong>Countersign</strong> to finalize the contract and send the Work Order.</p>
            <p><a href="${APP_URL}">${APP_URL}</a></p>`,
        });
      } catch (e) { console.error("countersign-needed notify failed:", e); }
    }

    res.json({ ok: true });
  });

  // ── Public: client declines ──
  app.post("/api/repair-quote/:token/decline", async (req: Request, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE quote_token = ?`).get(req.params.token) as any;
    if (!consult) return res.status(404).json({ error: "Quote not found" });
    const { reason } = req.body || {};
    rawDb.prepare(`
      UPDATE repair_consults SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, declined_by = ?, decline_source = 'client_esign', updated_at = datetime('now')
      WHERE id = ?
    `).run(reason ? String(reason).trim().slice(0, 1000) : null, consult.client_name || null, consult.id);

    if (resend) {
      try {
        await resend.emails.send({
          from: FROM,
          to: ADMIN_EMAILS,
          subject: `Quote declined — ${consult.property_address}`,
          html: `<p>${consult.client_name || "The client"} declined the repair quote for <strong>${consult.property_address}</strong>.</p>
            ${reason ? `<p><strong>Reason:</strong> ${String(reason).trim()}</p>` : ""}`,
        });
      } catch (e) { console.error("decline notify failed:", e); }
    }

    res.json({ ok: true });
  });

  // ── Admin/agent: mark a consult declined at the consult itself (owner said
  // no money / handling it themselves) BEFORE a quote was ever sent for
  // e-signature. This is the earlier, in-person loop-closer requested
  // v20.32.2 — distinct from the public e-sign decline above. Never deletes
  // anything: all items/photos/pillars stay put so the consult can be
  // reopened later at full fidelity if the owner changes their mind.
  app.post("/api/repair-consult/:id/decline", (req: any, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE id = ?`).get(req.params.id) as any;
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (consult.status === "accepted" || consult.status === "work_order_sent") {
      return res.status(400).json({ error: "Already signed/executing — cannot decline. Use a Change Order or contact the client directly." });
    }
    const { reason } = req.body || {};
    const actor = req.currentAgent?.name || "Admin";
    rawDb.prepare(`
      UPDATE repair_consults SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, declined_by = ?, decline_source = 'consult', updated_at = datetime('now')
      WHERE id = ?
    `).run(reason ? String(reason).trim().slice(0, 1000) : "Owner declined at consult", actor, consult.id);
    res.json({ ok: true });
  });

  // ── Admin/agent: reopen a declined consult (owner changed their mind).
  // Returns it to draft so it can be re-quoted/re-sent. Keeps the original
  // declined_at/decline_reason/declined_by as history — nothing is erased,
  // only reopened_at/reopened_by are stamped on top. ──
  app.post("/api/repair-consult/:id/reopen", (req: any, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE id = ?`).get(req.params.id) as any;
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (consult.status !== "declined") return res.status(400).json({ error: "Only a declined consult can be reopened." });
    const actor = req.currentAgent?.name || "Admin";
    rawDb.prepare(`
      UPDATE repair_consults SET status = 'draft', reopened_at = datetime('now'), reopened_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(actor, consult.id);
    res.json({ ok: true });
  });

  // ── Admin: consult list ──
  app.get("/api/admin/repair-consults", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`
      SELECT rc.*, a.name AS agent_name FROM repair_consults rc
      LEFT JOIN agents a ON a.id = rc.agent_id
      ORDER BY rc.created_at DESC LIMIT 200
    `).all();
    res.json({ consults: rows });
  });

  // ── Admin: pricing catalog CRUD ──
  app.get("/api/admin/repair-pricing", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const items = rawDb.prepare(`SELECT * FROM repair_items ORDER BY category, sequence_order ASC`).all();
    res.json({ items });
  });
  app.patch("/api/admin/repair-pricing/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { defaultRate, minCharge, active, name, instruction } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (defaultRate !== undefined) { fields.push("default_rate = ?"); vals.push(defaultRate); }
    if (minCharge !== undefined) { fields.push("min_charge = ?"); vals.push(minCharge); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (name !== undefined) { fields.push("name = ?"); vals.push(name); }
    if (instruction !== undefined) { fields.push("instruction = ?"); vals.push(instruction); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at = datetime('now')");
    rawDb.prepare(`UPDATE repair_items SET ${fields.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    res.json({ ok: true });
  });

  // ── Admin: vendor directory CRUD ──
  app.get("/api/admin/repair-vendors", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const vendors = rawDb.prepare(`SELECT * FROM repair_vendors ORDER BY trade, name ASC`).all();
    res.json({ vendors });
  });
  app.post("/api/admin/repair-vendors", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { trade, name, email, phone, notes, contact_name, address, pricing_sheet_url, license_number, insurance_expiration, service_area, credentials_notes } = req.body || {};
    if (!trade || !name || !email) return res.status(400).json({ error: "trade, name, and email are required" });
    const result = rawDb.prepare(`INSERT INTO repair_vendors (trade, name, email, phone, notes, contact_name, address, pricing_sheet_url, license_number, insurance_expiration, service_area, credentials_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(trade, name, email, phone || null, notes || null, contact_name || null, address || null, pricing_sheet_url || null, license_number || null, insurance_expiration || null, service_area || null, credentials_notes || null);
    res.json({ id: result.lastInsertRowid });
  });
  app.patch("/api/admin/repair-vendors/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, email, phone, notes, active, contact_name, address, pricing_sheet_url, license_number, insurance_expiration, service_area, credentials_notes } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (name !== undefined) { fields.push("name = ?"); vals.push(name); }
    if (email !== undefined) { fields.push("email = ?"); vals.push(email); }
    if (phone !== undefined) { fields.push("phone = ?"); vals.push(phone); }
    if (notes !== undefined) { fields.push("notes = ?"); vals.push(notes); }
    if (contact_name !== undefined) { fields.push("contact_name = ?"); vals.push(contact_name); }
    if (address !== undefined) { fields.push("address = ?"); vals.push(address); }
    if (pricing_sheet_url !== undefined) { fields.push("pricing_sheet_url = ?"); vals.push(pricing_sheet_url); }
    if (license_number !== undefined) { fields.push("license_number = ?"); vals.push(license_number); }
    if (insurance_expiration !== undefined) { fields.push("insurance_expiration = ?"); vals.push(insurance_expiration); }
    if (service_area !== undefined) { fields.push("service_area = ?"); vals.push(service_area); }
    if (credentials_notes !== undefined) { fields.push("credentials_notes = ?"); vals.push(credentials_notes); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    rawDb.prepare(`UPDATE repair_vendors SET ${fields.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    res.json({ ok: true });
  });
  app.delete("/api/admin/repair-vendors/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    rawDb.prepare(`DELETE FROM repair_vendors WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  // ── CHANGE ORDERS (v20.15.1) ──────────────────────────────────────────────

  // Agent/admin submits a change order request for an in-progress consult.
  // Always starts as 'pending' — never auto-approved, never sent to the
  // client until an admin office-approves it first.
  app.post("/api/repair-consult/:id/change-orders", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    const { itemKey, customDescription, quantity, unitRate, unit, reason, photos } = req.body || {};
    if (!itemKey && (!customDescription || !String(customDescription).trim())) {
      return res.status(400).json({ error: "Select a catalog item or enter a custom description" });
    }
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: "A reason is required" });
    const qty = Number(quantity) > 0 ? Number(quantity) : 1;
    let rate = Number(unitRate) || 0;
    let unitLabel = unit || "flat";
    if (itemKey) {
      const cat = rawDb.prepare(`SELECT * FROM repair_items WHERE key = ? AND active = 1`).get(itemKey) as any;
      if (cat) {
        if (!unitRate && unitRate !== 0) rate = cat.default_rate || 0;
        unitLabel = cat.unit;
      }
    }
    const lineTotal = rate * qty;
    try {
      const result = rawDb.prepare(`
        INSERT INTO repair_change_orders
          (consult_id, requested_by_agent_id, item_key, custom_description, unit, quantity, unit_rate, line_total, reason, photos, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        consultId, req.currentAgent?.id || null, itemKey || null, customDescription ? String(customDescription).trim() : null,
        unitLabel, qty, rate, lineTotal, String(reason).trim(), JSON.stringify(Array.isArray(photos) ? photos : [])
      );
      const id = Number(result.lastInsertRowid);
      try { await sendChangeOrderRequestedEmail(id); } catch (e) { console.error("change-order requested email failed:", e); }
      res.json({ ok: true, id });
    } catch (err: any) {
      console.error("create change-order error:", err);
      res.status(500).json({ error: "Failed to create change order", detail: err?.message });
    }
  });

  // List change orders for a specific consult (agent-facing history/status).
  app.get("/api/repair-consult/:id/change-orders", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const orders = getChangeOrdersForConsult(consultId).map((co: any) => ({ ...co, photos: co.photos ? JSON.parse(co.photos) : [] }));
    res.json({ changeOrders: orders });
  });

  // Admin: queue of ALL change orders across every consult.
  app.get("/api/admin/repair-change-orders", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`
      SELECT co.*, rc.property_address, rc.client_name, a.name AS requested_by_name
      FROM repair_change_orders co
      JOIN repair_consults rc ON rc.id = co.consult_id
      LEFT JOIN agents a ON a.id = co.requested_by_agent_id
      ORDER BY co.requested_at DESC LIMIT 200
    `).all() as any[];
    res.json({ changeOrders: rows.map((r: any) => ({ ...r, photos: r.photos ? JSON.parse(r.photos) : [] })) });
  });

  // Admin office-approve: generates the client sign token/link and emails it.
  // This is the SAME two-step pattern as the main quote's office-approve gate
  // — nothing reaches the client until an admin has signed off in-house.
  app.post("/api/admin/repair-change-orders/:id/office-approve", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = parseInt(req.params.id);
    const co = getChangeOrderRow(id);
    if (!co) return res.status(404).json({ error: "Change order not found" });
    if (co.status !== "pending") return res.status(409).json({ error: `Change order is already ${co.status}` });
    const token = randomBytes(20).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    rawDb.prepare(`
      UPDATE repair_change_orders
      SET status = 'office_approved', decided_at = datetime('now'), decided_by = ?,
          sign_token = ?, sign_token_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", token, expires, id);
    try { await sendChangeOrderSignEmail(id); } catch (e) { console.error("change-order sign email failed:", e); }
    res.json({ ok: true, signToken: token });
  });

  // Admin decline: zero financial impact, just closes the row.
  app.post("/api/admin/repair-change-orders/:id/decline", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = parseInt(req.params.id);
    const co = getChangeOrderRow(id);
    if (!co) return res.status(404).json({ error: "Change order not found" });
    if (co.status !== "pending") return res.status(409).json({ error: `Change order is already ${co.status}` });
    const { reason } = req.body || {};
    rawDb.prepare(`
      UPDATE repair_change_orders
      SET status = 'declined', decided_at = datetime('now'), decided_by = ?, decline_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", reason || null, id);
    res.json({ ok: true });
  });

  // Public: fetch change order by sign token (client sign page).
  app.get("/api/repair-change-order/:token", (req: Request, res: Response) => {
    const co = rawDb.prepare(`SELECT * FROM repair_change_orders WHERE sign_token = ?`).get(req.params.token) as any;
    if (!co) return res.status(404).json({ error: "Change order not found" });
    const consult = getConsultRow(co.consult_id);
    res.json({
      changeOrder: {
        description: changeOrderDescription(co),
        quantity: co.quantity, unit: co.unit, unitRate: co.unit_rate, lineTotal: co.line_total,
        reason: co.reason, photos: co.photos ? JSON.parse(co.photos) : [],
        status: co.status, signedAt: co.signed_at, signatureName: co.signature_name,
      },
      consult: {
        propertyAddress: consult?.property_address, clientName: consult?.client_name,
        heroPhotoUrl: consult?.hero_photo_url, currentTotal: consult?.total,
      },
    });
  });

  // Public: client types their name to e-sign. On success, folds the change
  // order into repair_consult_items (same category/pricing path as the
  // original quote) and recalculates the consult's subtotal/total/deposit.
  app.post("/api/repair-change-order/:token/sign", async (req: Request, res: Response) => {
    const co = rawDb.prepare(`SELECT * FROM repair_change_orders WHERE sign_token = ?`).get(req.params.token) as any;
    if (!co) return res.status(404).json({ error: "Change order not found" });
    if (co.status === "signed") return res.status(409).json({ error: "This change order has already been signed." });
    if (co.status !== "office_approved") return res.status(409).json({ error: "This change order is not ready to sign." });
    if (co.sign_token_expires_at && new Date(co.sign_token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This sign link has expired \u2014 ask your Brothers Group contact to resend it." });
    }
    const { signatureName } = req.body || {};
    if (!signatureName || String(signatureName).trim().length < 2) return res.status(400).json({ error: "Full name required to sign" });
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

    try {
      const catalogItem = co.item_key ? (rawDb.prepare(`SELECT * FROM repair_items WHERE key = ?`).get(co.item_key) as any) : null;
      const insertResult = rawDb.prepare(`
        INSERT INTO repair_consult_items
          (consult_id, item_key, category, trade, name, unit, quantity, unit_rate, two_story, line_total, instruction, photos, measurement_notes, sequence_order, change_order_id)
        VALUES (?, ?, 'in_house', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 999, ?)
      `).run(
        co.consult_id, co.item_key || `change-order-${co.id}`, catalogItem?.trade || "change_order",
        changeOrderDescription(co), co.unit, co.quantity, co.unit_rate, co.line_total,
        `Change Order: ${co.reason}`, co.photos || "[]", `Change Order #${co.id}`, co.id
      );

      rawDb.prepare(`
        UPDATE repair_change_orders
        SET status = 'signed', signed_at = datetime('now'), signature_name = ?, signed_ip = ?,
            consult_item_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(String(signatureName).trim(), ip, Number(insertResult.lastInsertRowid), co.id);

      recalcConsultTotals(co.consult_id);
      const updatedConsult = getConsultRow(co.consult_id);
      try { await sendChangeOrderApprovedEmail(co.id, updatedConsult.total); } catch (e) { console.error("change-order approved email failed:", e); }

      res.json({ ok: true, newTotal: updatedConsult.total });
    } catch (err: any) {
      console.error("sign change-order error:", err);
      res.status(500).json({ error: "Failed to sign change order", detail: err?.message });
    }
  });
}
