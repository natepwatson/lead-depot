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
      status TEXT NOT NULL DEFAULT 'draft', -- draft | quoted | sent | accepted | work_order_sent
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

    CREATE INDEX IF NOT EXISTS idx_repair_consult_items_consult ON repair_consult_items(consult_id);
    CREATE INDEX IF NOT EXISTS idx_repair_vendor_dispatches_consult ON repair_vendor_dispatches(consult_id);
    CREATE INDEX IF NOT EXISTS idx_repair_vendors_trade ON repair_vendors(trade);
  `);

  // v20.9.0 — signing-method tracking + agreement PDF paths (ALTER TABLE is safe to run
  // repeatedly — guarded by PRAGMA table_info check, same pattern as server/db.ts)
  const rcCols = (rawDb.prepare(`PRAGMA table_info(repair_consults)`).all() as any[]).map((c: any) => c.name);
  if (!rcCols.includes("signature_method"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN signature_method TEXT").run();
  if (!rcCols.includes("print_signed_at"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_at TEXT").run();
  if (!rcCols.includes("print_signed_by"))          rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_by TEXT").run();
  if (!rcCols.includes("print_signed_upload_url"))  rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN print_signed_upload_url TEXT").run();
  if (!rcCols.includes("agreement_pdf_url"))        rawDb.prepare("ALTER TABLE repair_consults ADD COLUMN agreement_pdf_url TEXT").run();
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

  seedRepairItems();
}

// ─── CATALOG SEED (idempotent — only inserts keys that don't exist yet) ─────
interface SeedItem {
  key: string; category: "in_house" | "vendor"; trade: string; name: string;
  unit: "sqft" | "linear_ft" | "each" | "flat";
  rate?: number; min?: number; twoStory?: boolean; seq: number;
  instruction: string; notes?: string;
}

const IN_HOUSE_ITEMS: SeedItem[] = [
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
  { key: "pressure_wash_ext", category: "in_house", trade: "pressure_washing", name: "Pressure Washing — Exterior (Siding/Brick)", unit: "sqft", rate: 0.20, min: 200, twoStory: true, seq: 35, instruction: "Pressure wash exterior — {qty} sqft.{story}" },
  { key: "soft_wash_roof", category: "in_house", trade: "pressure_washing", name: "Soft Washing — Roof", unit: "sqft", rate: 0.35, min: 250, twoStory: true, seq: 36, instruction: "Soft wash roof — {qty} sqft.{story}" },
  { key: "pressure_wash_hard", category: "in_house", trade: "pressure_washing", name: "Pressure Washing — Driveway/Walkway/Patio", unit: "sqft", rate: 0.22, min: 150, seq: 37, instruction: "Pressure wash driveway/walkway/patio — {qty} sqft." },
  { key: "paint_ext_body", category: "in_house", trade: "painting_exterior", name: "Exterior Painting — Body", unit: "sqft", rate: 2.25, min: 800, twoStory: true, seq: 40, instruction: "Paint exterior body — {qty} sqft. Color-matched to existing.{story}", notes: "Color match is visual-sample only; slight sheen/tone variance vs. original is possible." },
  { key: "paint_ext_trim", category: "in_house", trade: "painting_exterior", name: "Exterior Painting — Trim & Doors", unit: "linear_ft", rate: 3.50, min: 150, twoStory: true, seq: 41, instruction: "Paint exterior trim & doors — {qty} linear ft. Color-matched.{story}" },
  { key: "lawn_mow", category: "in_house", trade: "landscaping", name: "Lawn Mowing / Cut", unit: "sqft", rate: 0.03, min: 75, seq: 45, instruction: "Mow/cut lawn — {qty} sqft." },
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
];

export const REPAIR_CATALOG_SEED: SeedItem[] = [...IN_HOUSE_ITEMS, ...VENDOR_TRADES];

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
    body: "Your price reflects the scope, quantities, and condition we observed during your walkthrough. If we discover something once work is underway that wasn't part of that original scope — rot, mold, structural issues, pest damage, code violations, and similar — we'll stop and present it to you as a separate change order in writing. We won't perform or charge for any additional work without your approval first.",
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
    body: "Any item in your quote marked \u201cVendor-Quoted\u201d is performed by an independent, licensed, and insured third-party contractor from our preferred vendor network — not by Brothers Group. We facilitate the introduction and quote request only. Pricing, licensing, insurance, scheduling, and workmanship for that work are solely between you and the vendor, under a separate agreement with them. Brothers Group assumes no liability for vendor-performed work.",
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
function quoteItemsTable(items: any[]): string {
  const rows = items.map(it => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12.5px;color:#1a1a1a">${it.name}${it.two_story ? " <span style='color:#888;font-size:11px'>(2-story)</span>" : ""}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12.5px;color:#1a1a1a;text-align:center">${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12.5px;color:#1a1a1a;text-align:right;font-weight:600">$${Number(it.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>`).join("");
  return `
  <table style="width:100%;border-collapse:collapse;margin-top:10px">
    <thead>
      <tr>
        <th style="text-align:left;padding:6px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.gray};border-bottom:2px solid ${BRAND.black}">Item</th>
        <th style="text-align:center;padding:6px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.gray};border-bottom:2px solid ${BRAND.black}">Qty</th>
        <th style="text-align:right;padding:6px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.gray};border-bottom:2px solid ${BRAND.black}">Amount</th>
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

export async function sendInHouseQuoteInternal(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "in_house");
  if (!consult || items.length === 0) return;

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Repair Consult — In-House Quote Generated", consult.property_address)}
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
        <tr><td style="padding:4px 10px;text-align:right;font-size:11.5px;color:${BRAND.gray}">Deposit (50%) / Final (50%)</td><td style="padding:4px 10px;text-align:right;font-size:11.5px;color:${BRAND.gray};width:110px">$${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})} / $${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
      </table>
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
    subject: `Repair Consult Quote — ${consult.property_address} — $${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}`,
    html,
  });
}

// ─── EMAIL: Client-facing quote w/ accept link ──────────────────────────────
export async function sendClientQuoteEmail(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "in_house");
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
        <tr><td style="padding:4px 10px;text-align:right;font-size:13px;color:${BRAND.gray}">Subtotal</td><td style="padding:4px 10px;text-align:right;font-size:13px;width:110px">$${consult.subtotal.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700;width:110px">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
      </table>
      <p style="font-size:12px;color:${BRAND.gray};text-align:right;margin-top:2px">50% deposit ($${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) to begin · 50% ($${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) on completion</p>
      <div style="margin-top:16px;padding:14px 16px;background:#f0f9f0;border:1px solid #cfe8cf;border-radius:6px">
        <p style="font-size:13px;color:#1a1a1a;line-height:1.55;margin:0"><strong style="color:${BRAND.green}">${START_MOMENTUM_HTML}</strong></p>
      </div>
      <div style="text-align:center;margin:28px 0 10px">
        <a href="${acceptUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block">Review &amp; Accept Proposal</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${acceptUrl}" style="color:${BRAND.gray}">${acceptUrl}</a></p>
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
  });

  rawDb.prepare(`UPDATE repair_consults SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(consultId);
}

// ─── EMAIL: One-click green Approval (mode=approve, no typing required) ───────
export async function sendApprovalEmail(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "in_house");
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
      <p style="font-size:12px;color:${BRAND.gray};text-align:right;margin-top:2px">50% deposit ($${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) to begin · 50% ($${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) on completion</p>
      <div style="margin-top:16px;padding:14px 16px;background:#f0f9f0;border:1px solid #cfe8cf;border-radius:6px">
        <p style="font-size:13px;color:#1a1a1a;line-height:1.55;margin:0"><strong style="color:${BRAND.green}">${START_MOMENTUM_HTML}</strong></p>
      </div>
      <div style="text-align:center;margin:28px 0 10px">
        <a href="${approveUrl}" style="background:${BRAND.green};color:#fff;text-decoration:none;padding:16px 44px;border-radius:6px;font-size:15px;font-weight:700;display:inline-block">✓ Approve Proposal</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${approveUrl}" style="color:${BRAND.gray}">${approveUrl}</a></p>
      <p style="font-size:11px;color:${BRAND.gray};text-align:center;margin-top:10px">Full Terms &amp; Conditions are shown on the approval page before you approve.</p>
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

    const html = `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#fff">
      ${brandedHeader("Quote Request", consult.property_address)}
      <div style="padding:24px 32px">
        <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi${vendor.name ? " " + vendor.name : ""} — we walked a listing today and would like a quote on the following:</p>
        <ul style="padding-left:18px">${itemsHtml}</ul>
        ${photosHtml}
        <p style="font-size:13px;color:#333;margin-top:16px"><strong>Property:</strong> ${consult.property_address}</p>
        <p style="font-size:13px;color:#333"><strong>Desired Start:</strong> ${startWindowLabel(consult)}</p>
        <p style="font-size:12.5px;color:#333;margin-top:14px">Please reply with your quote and earliest availability. As one of our preferred vendors, our standard payout-at-close arrangement applies where offered — happy to discuss.</p>
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
export async function sendWorkOrderEmail(consultId: number) {
  if (!resend) return;
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId)
    .filter((i: any) => i.category === "in_house")
    .sort((a: any, b: any) => a.sequence_order - b.sequence_order);
  if (!consult) return;

  const stepsHtml = items.map((it: any, idx: number) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:12px;color:${BRAND.gray};width:26px">${idx + 1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-size:13px;color:#1a1a1a">${it.instruction || it.name}</td>
    </tr>`).join("");

  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("✅ Work Order — Client Accepted", consult.property_address)}
    <div style="padding:22px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:14px">
        <tr><td style="padding:3px 0;color:${BRAND.gray};width:140px">Client</td><td style="font-weight:600">${consult.client_name}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Signed By</td><td>${consult.accepted_signature_name}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Accepted</td><td>${consult.accepted_at}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Start Window</td><td style="font-weight:700">${startWindowLabel(consult)}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Contract Total</td><td style="font-weight:700">$${consult.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:3px 0;color:${BRAND.gray}">Deposit Collected?</td><td>Confirm 50% ($${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}) before dispatching a crew.</td></tr>
      </table>
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${BRAND.gray};font-weight:700;margin-bottom:6px">Scope — in build order</p>
      <table style="width:100%;border-collapse:collapse">${stepsHtml}</table>
      <div style="margin-top:16px;text-align:center">
        <a href="${APP_URL}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">Open in Lead Depot</a>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAILS,
    subject: `✅ Work Order Ready — ${consult.property_address} — Start ${startWindowLabel(consult)}`,
    html,
  });

  rawDb.prepare(`UPDATE repair_consults SET status = 'work_order_sent', work_order_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(consultId);
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

// ─── PDF QUOTE (pdf-lib, matches Brothers Group letterhead) ────────────────
export async function generateQuotePdf(consultId: number): Promise<string> {
  const consult = getConsultRow(consultId);
  const items = getConsultItems(consultId).filter((i: any) => i.category === "in_house");
  if (!consult) throw new Error("Consult not found");

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.5, 0.5, 0.5);
  const lightGray = rgb(0.95, 0.95, 0.95);

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
      const heroPath = path.join(repairPhotosDir(), path.basename(consult.hero_photo_url));
      if (fs.existsSync(heroPath)) {
        const bytes = fs.readFileSync(heroPath);
        const img = consult.hero_photo_url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const w = 536, h = 180;
        drawContainedImage(page, img, { x: 38, y, width: w, height: h });
        y -= h + 18;
      }
    } catch { /* non-fatal — skip hero image if unreadable */ }
  }

  // Items table
  const colLabelX = 38, colQtyX = 420, colAmtX = 480;
  page.drawText("Item", { x: colLabelX, y, size: 9, font: fontBold, color: gray });
  page.drawText("Qty", { x: colQtyX, y, size: 9, font: fontBold, color: gray });
  page.drawText("Amount", { x: colAmtX, y, size: 9, font: fontBold, color: gray });
  y -= 6;
  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 1, color: black });
  y -= 14;

  let rowIdx = 0;
  for (const it of items) {
    if (y < 140) { break; } // guard against overflow on very long scopes (v1 — single page)
    if (rowIdx % 2 === 1) page.drawRectangle({ x: 38, y: y - 4, width: 536, height: 16, color: lightGray });
    const label = it.two_story ? `${it.name} (2-story)` : it.name;
    page.drawText(label.slice(0, 60), { x: colLabelX, y: y, size: 9, font, color: black });
    page.drawText(`${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`, { x: colQtyX, y, size: 9, font, color: black });
    page.drawText(`$${Number(it.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 9, font: fontBold, color: black });
    y -= 16;
    rowIdx++;
  }

  y -= 10;
  page.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.5, color: gray });
  y -= 18;
  page.drawText("Subtotal", { x: colAmtX - 70, y, size: 10, font, color: gray });
  page.drawText(`$${consult.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 10, font, color: black });
  y -= 18;
  page.drawText("Total", { x: colAmtX - 70, y, size: 13, font: fontBold, color: black });
  page.drawText(`$${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 13, font: fontBold, color: black });
  y -= 16;
  page.drawText(`50% deposit: $${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}   /   50% on completion: $${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: colAmtX - 210, y, size: 8.5, font, color: gray });
  y -= 20;
  page.drawText(START_MOMENTUM_PDF_LINE, { x: 38, y, size: 9.5, font: fontBold, color: rgb(0, 0.35, 0) });

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

  const bytes = await pdfDoc.save();
  const outDir = repairPdfDir();
  const filename = `quote-${consultId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(outDir, filename), bytes);
  return `/repair-quotes/${filename}`;
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
      const heroPath = path.join(repairPhotosDir(), path.basename(consult.hero_photo_url));
      if (fs.existsSync(heroPath)) {
        const bytes = fs.readFileSync(heroPath);
        const img = consult.hero_photo_url.endsWith(".png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const w = 536, h = 130;
        drawContainedImage(p1, img, { x: 38, y, width: w, height: h });
        y -= h + 14;
      }
    } catch { /* non-fatal — skip hero image if unreadable */ }
  }

  // Items table
  const colLabelX = 38, colQtyX = 420, colAmtX = 480;
  p1.drawText("Item", { x: colLabelX, y, size: 8.5, font: fontBold, color: gray });
  p1.drawText("Qty", { x: colQtyX, y, size: 8.5, font: fontBold, color: gray });
  p1.drawText("Amount", { x: colAmtX, y, size: 8.5, font: fontBold, color: gray });
  y -= 6;
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 1, color: black });
  y -= 13;

  let rowIdx = 0;
  const rowFloor = 230; // leave room for totals + signature block below
  for (const it of items) {
    if (y < rowFloor) break;
    if (rowIdx % 2 === 1) p1.drawRectangle({ x: 38, y: y - 3, width: 536, height: 14, color: lightGray });
    const label = it.two_story ? `${it.name} (2-story)` : it.name;
    p1.drawText(label.slice(0, 62), { x: colLabelX, y, size: 8.5, font, color: black });
    p1.drawText(`${it.quantity} ${it.unit === "each" ? "ea" : it.unit === "flat" ? "" : it.unit.replace("_", " ")}`, { x: colQtyX, y, size: 8.5, font, color: black });
    p1.drawText(`$${Number(it.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 8.5, font: fontBold, color: black });
    y -= 14;
    rowIdx++;
  }

  y -= 8;
  p1.drawLine({ start: { x: 38, y }, end: { x: 574, y }, thickness: 0.5, color: gray });
  y -= 16;
  p1.drawText("Subtotal", { x: colAmtX - 70, y, size: 9.5, font, color: gray });
  p1.drawText(`$${consult.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 9.5, font, color: black });
  y -= 16;
  p1.drawText("Total", { x: colAmtX - 70, y, size: 12, font: fontBold, color: black });
  p1.drawText(`$${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, { x: colAmtX, y, size: 12, font: fontBold, color: black });
  y -= 14;
  p1.drawText(`50% deposit: $${consult.deposit_amount.toLocaleString(undefined,{minimumFractionDigits:2})}   /   50% on completion: $${consult.final_amount.toLocaleString(undefined,{minimumFractionDigits:2})}`, { x: colAmtX - 210, y, size: 8, font, color: gray });
  y -= 16;
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

// ─── ROW HELPERS ─────────────────────────────────────────────────────────────
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

// ─── ROUTES ──────────────────────────────────────────────────────────────────
export function registerRepairConsultRoutes(app: Express) {
  ensureRepairConsultSchema();

  // ── Catalog (agent-facing checklist source) ──
  app.get("/api/repair-items", (_req: Request, res: Response) => {
    const items = rawDb.prepare(`SELECT * FROM repair_items WHERE active = 1 ORDER BY category, sequence_order ASC`).all();
    res.json({ items });
  });

  // ── Create consult ──
  // v20.14.4 — accepts an optional heroPhotoUrl so Listing Consult can hand
  // off its already-captured front-of-house photo directly at creation time,
  // instead of the agent re-taking the same photo for Repair Consult.
  app.post("/api/repair-consult", (req: any, res: Response) => {
    const { leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress, heroPhotoUrl } = req.body || {};
    if (!propertyAddress) return res.status(400).json({ error: "propertyAddress is required" });
    const result = rawDb.prepare(`
      INSERT INTO repair_consults (lead_id, agent_id, client_name, client_email, client_phone, property_address, hero_photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(leadId || null, agentId || req.currentAgent?.id || null, clientName || null, clientEmail || null, clientPhone || null, propertyAddress, heroPhotoUrl || null);
    res.json({ id: result.lastInsertRowid });
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
    res.json({ ...consult, items });
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
        rawDb.prepare(`UPDATE repair_consults SET hero_photo_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, consultId);
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

  // ── Submit checklist items in one pass ──
  app.post("/api/repair-consult/:id/items", (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    const { items } = req.body || {}; // [{ itemKey, quantity, twoStory, photos: [url], measurementNotes }]
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items array is required" });

    const del = rawDb.prepare(`DELETE FROM repair_consult_items WHERE consult_id = ?`);
    const insert = rawDb.prepare(`
      INSERT INTO repair_consult_items
        (consult_id, item_key, category, trade, name, unit, quantity, unit_rate, two_story, line_total, instruction, photos, measurement_notes, sequence_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const catalogStmt = rawDb.prepare(`SELECT * FROM repair_items WHERE key = ? AND active = 1`);

    let subtotal = 0;
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

    rawDb.prepare(`
      UPDATE repair_consults SET subtotal = ?, total = ?, two_story = ?,
        deposit_amount = ?, final_amount = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(subtotal, subtotal, anyTwoStory, subtotal / 2, subtotal / 2, consultId);

    res.json({ ok: true, subtotal, total: subtotal });
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

  // ── Office Approval Gate (v20.13.0): admin must approve in-house before ANY
  // quote/approval email is allowed to reach the client. Every fresh
  // generate-quote call clears this, so re-pricing always needs re-approval.
  app.post("/api/repair-consult/:id/office-approve", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const consult = getConsultRow(consultId);
    if (!consult) return res.status(404).json({ error: "Consult not found" });
    if (!consult.quote_token) return res.status(409).json({ error: "Generate the quote before approving it." });
    rawDb.prepare(`
      UPDATE repair_consults SET office_approved_at = datetime('now'), office_approved_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", consultId);
    res.json({ ok: true });
  });

  // ── Send to client ──
  app.post("/api/repair-consult/:id/send-to-client", async (req: any, res: Response) => {
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.office_approved_at) {
        return res.status(409).json({ error: "Needs office approval before it can be sent to the client." });
      }
      await sendClientQuoteEmail(consultId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("send-to-client error:", err);
      res.status(500).json({ error: "Failed to send to client" });
    }
  });

  // ── Print & Sign: download/regenerate the blank agreement PDF (admin) ──
  app.get("/api/repair-consult/:id/agreement-pdf", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.office_approved_at) {
        return res.status(409).json({ error: "Needs office approval before this can be printed for a client signature." });
      }
      const url = await generateAgreementPdf(consultId, { blank: true });
      res.redirect(url);
    } catch (err: any) {
      console.error("agreement-pdf error:", err);
      res.status(500).json({ error: "Failed to generate agreement PDF", detail: err?.message });
    }
  });

  // ── Print & Sign: mark a consult as signed via a physically-signed printout ──
  app.post("/api/repair-consult/:id/mark-print-signed", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    const { signedBy, imageData, mimeType } = req.body || {};
    if (!signedBy || String(signedBy).trim().length < 2) return res.status(400).json({ error: "signedBy name is required" });
    try {
      let uploadUrl: string | null = null;
      if (imageData && mimeType) {
        const sharp = require("sharp");
        const inputBuf = Buffer.from(imageData, "base64");
        const rotated = await sharp(inputBuf).rotate().toBuffer();
        const processed = await sharp(rotated).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, progressive: true }).toBuffer();
        const dir = repairPhotosDir();
        const filename = `${consultId}-print-signed-${Date.now()}.jpg`;
        fs.writeFileSync(path.join(dir, filename), processed);
        uploadUrl = `/repair-photos/${filename}`;
      }
      rawDb.prepare(`
        UPDATE repair_consults SET status = 'accepted', signature_method = 'print_sign',
          print_signed_at = datetime('now'), print_signed_by = ?, print_signed_upload_url = ?,
          accepted_at = datetime('now'), accepted_signature_name = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(String(signedBy).trim(), uploadUrl, String(signedBy).trim(), consultId);
      try { await sendWorkOrderEmail(consultId); } catch (e) { console.error("work order send failed:", e); }
      res.json({ ok: true, printSignedUploadUrl: uploadUrl });
    } catch (err: any) {
      console.error("mark-print-signed error:", err);
      res.status(500).json({ error: "Failed to record print-signed agreement", detail: err?.message });
    }
  });

  // ── Send one-click green Approval email ──
  app.post("/api/repair-consult/:id/send-approval-email", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const consultId = parseInt(req.params.id);
    try {
      const consult = getConsultRow(consultId);
      if (!consult) return res.status(404).json({ error: "Consult not found" });
      if (!consult.office_approved_at) {
        return res.status(409).json({ error: "Needs office approval before it can be sent to the client." });
      }
      await sendApprovalEmail(consultId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("send-approval-email error:", err);
      res.status(500).json({ error: "Failed to send approval email", detail: err?.message });
    }
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
    const items = getConsultItems(consult.id).filter((i: any) => i.category === "in_house");
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
      },
      items,
      terms: IN_HOUSE_TERMS,
      agreementSections: AGREEMENT_SECTIONS,
    });
  });

  // ── Public: client accepts + e-signs ──
  app.post("/api/repair-quote/:token/accept", async (req: Request, res: Response) => {
    const consult = rawDb.prepare(`SELECT * FROM repair_consults WHERE quote_token = ?`).get(req.params.token) as any;
    if (!consult) return res.status(404).json({ error: "Quote not found" });
    const { signatureName, method } = req.body || {};
    if (!signatureName || String(signatureName).trim().length < 2) return res.status(400).json({ error: "Full name required to sign" });
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const signatureMethod = method === "email_approval" ? "email_approval" : "e_sign";

    rawDb.prepare(`
      UPDATE repair_consults SET status = 'accepted', accepted_at = datetime('now'),
        accepted_signature_name = ?, accepted_ip = ?, signature_method = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(signatureName).trim(), ip, signatureMethod, consult.id);

    try { await generateAgreementPdf(consult.id, { blank: false }); } catch (e) { console.error("signed agreement pdf failed:", e); }
    try { await sendWorkOrderEmail(consult.id); } catch (e) { console.error("work order send failed:", e); }

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
    const { trade, name, email, phone, notes } = req.body || {};
    if (!trade || !name || !email) return res.status(400).json({ error: "trade, name, and email are required" });
    const result = rawDb.prepare(`INSERT INTO repair_vendors (trade, name, email, phone, notes) VALUES (?, ?, ?, ?, ?)`).run(trade, name, email, phone || null, notes || null);
    res.json({ id: result.lastInsertRowid });
  });
  app.patch("/api/admin/repair-vendors/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, email, phone, notes, active } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (name !== undefined) { fields.push("name = ?"); vals.push(name); }
    if (email !== undefined) { fields.push("email = ?"); vals.push(email); }
    if (phone !== undefined) { fields.push("phone = ?"); vals.push(phone); }
    if (notes !== undefined) { fields.push("notes = ?"); vals.push(notes); }
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
}
