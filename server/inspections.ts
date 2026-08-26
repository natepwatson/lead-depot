// ─── INSPECTIONS+ ───────────────────────────────────────────────────────────
// v20.32.13 — Buyer-side inspection ordering tool. Agent picks the client from
// FUB, checks off which inspections to order (Home Inspection, WDO, 4-Point,
// Wind Mitigation, Pool, Septic), sets a needed-by date and the inspection
// contingency expiration date, and sends the client a branded order summary
// with a single-stage typed-name e-sign (no countersignature — simpler than
// the Repair program by Alex's explicit design). Adding a service AFTER the
// client has already signed (e.g. a pool inspection discovered later) is an
// "add-on" and follows the EXACT same two-step pattern as Repair Change
// Orders: agent requests -> admin office-approves -> client e-signs the
// add-on specifically before it's folded into the order total.
//
// Pricing is 100% admin-editable (inspection_items catalog) — the numbers
// Alex gave (~$450 HI / $150 WDO / $100 4pt / $75 WM / $150 pool / $150
// septic, ~$400 vendor bundle cost from Jason Brown) are seeded as starting
// placeholders only. Vendor cost is tracked per item so margin recalculates
// automatically once real itemized vendor quotes come in.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";

import { rawDb } from "./db";
import { Resend } from "resend";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fireMilestoneTasks } from "./fub";
import { ACCEPTED_PAYMENT_METHODS_LABEL } from "./payments";

const IS_PROD = process.env.NODE_ENV === "production";

// ─── v20.32.28 — Ordering model change ────────────────────────────────────
// Brothers Group now places and PAYS for every inspection order directly —
// we are the ordering/paying party, not the client and not the vendor. The
// client pays Brothers Group (wire preferred) BEFORE we place the order
// with the vendor. Nate is the Transaction Coordinator (TC) who actually
// places the vendor order once payment is confirmed in the app. This
// replaces the old "book it in the client's own name, vendor bills client
// directly" model. Applies to BOTH buyer-side and seller-side orders.
function inspectionWiringDir(): string {
  const dir = IS_PROD ? "/app/data/inspection-wiring" : path.resolve(__dirname, "public", "inspection-wiring");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function brandLogoPath(): string {
  const prodPath = "/app/dist/public/brand-logo.jpg";
  const devPath = path.resolve(__dirname, "public", "brand-logo.jpg");
  return IS_PROD && fs.existsSync(prodPath) ? prodPath : devPath;
}

// Relay banking details (Nathaniel Peter Watson LLC business checking) —
// from Relay Bank Verification Letter, issued 3/20/26. Single source of
// truth for both the wiring-instructions PDF and the client-facing email.
const RELAY_WIRE = {
  beneficiary: "Nathaniel Peter Watson LLC",
  bankName: "Relay (banking services provided by Thread Bank; Member FDIC)",
  accountNumber: "200002452369",
  routingNumber: "064209588",
  accountType: "Business Checking",
  businessAddress: "Ste 2500, 50 N Laura St, Jacksonville, FL 32205, US",
};
const NATE_EMAIL = "nate@watsonbrothersgroup.com";

// ─── Part 8 (v20.32.13) — liability / disclosure terms shown on the client
// e-sign page. Kept as one short array (not a multi-page contract) per
// Alex's explicit design intent that Inspections+ stay simpler than the
// Repair program's full Agreement. Modeled on the Repair & Renovation
// Agreement's Section 8 pattern: non-GC/non-inspector disclaimer, licensed-
// trade carve-out, vendor-pricing disclosure, client responsibility, and
// limitation of liability.
export const INSPECTION_TERMS = [
  "Brothers Group coordinates and places this inspection order on your behalf with our preferred inspection partner, Pro-Spect Inspection Services — an independent, licensed, and insured third-party vendor. As a service to you, Brothers Group collects payment directly and pays the vendor ourselves; the vendor does not bill you directly.",
  "Vendor pricing may vary based on square footage, site conditions, and other criteria specific to each inspection type. The price shown above is confirmed at the time we place your order.",
  `Full payment is due to Brothers Group BEFORE we place your order with the vendor. We accept ${ACCEPTED_PAYMENT_METHODS_LABEL}. Once you approve below, we'll send wiring instructions by separate email — review them carefully, and always verify by phone at a known number before sending funds. Our wiring instructions will never change over email.`,
  "Time is of the essence. Inspection contingency and other contract deadlines do not pause while payment is processed — the sooner your payment is received, the sooner we can place your order and get you scheduled.",
  "You are responsible for providing the vendor access to the property at the scheduled time. Any rescheduling or cancellation fee charged by the vendor is passed through to you.",
  "Brothers Group assumes no liability for the accuracy, completeness, or findings of any inspection report, or for the licensing, insurance, scheduling, or performance of the inspecting vendor. Unpaid balances may be pursued through ordinary collection remedies available under Florida law.",
] as const;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const ADMIN_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];
const FROM = "Lead Depot <noreply@watsonbrothersgroup.com>";
const APP_URL = "https://depot.watsonbrothersgroup.com";
const BRAND = {
  black: "#0a0a0a",
  gray: "#808080",
  lightGray: "#f2f2f2",
  border: "#999999",
  green: "#008000",
};

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
export function ensureInspectionsSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS inspection_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      client_price REAL NOT NULL DEFAULT 0,
      vendor_cost REAL,                    -- NULL = TBD, awaiting real vendor quote
      sequence_order INTEGER NOT NULL DEFAULT 100,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inspection_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      agent_id INTEGER REFERENCES agents(id),
      fub_contact_id TEXT,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      needed_by TEXT NOT NULL DEFAULT 'asap',  -- 'asap' | 'specific'
      needed_by_date TEXT,
      contingency_expiration_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',    -- draft | sent | accepted | declined | completed
      subtotal REAL DEFAULT 0,
      total REAL DEFAULT 0,
      vendor_cost_total REAL DEFAULT 0,
      sign_token TEXT UNIQUE,
      accepted_at TEXT,
      accepted_signature_name TEXT,
      accepted_ip TEXT,
      declined_at TEXT,
      decline_reason TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inspection_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES inspection_orders(id),
      item_key TEXT NOT NULL,
      name TEXT NOT NULL,
      client_price REAL NOT NULL DEFAULT 0,
      vendor_cost REAL,
      vendor_id INTEGER REFERENCES repair_vendors(id),
      is_addon INTEGER NOT NULL DEFAULT 0,
      addon_status TEXT,               -- NULL for original items; pending|office_approved|declined|signed for add-ons
      addon_reason TEXT,
      addon_requested_by_agent_id INTEGER REFERENCES agents(id),
      addon_requested_at TEXT,
      addon_decided_at TEXT,
      addon_decided_by TEXT,
      addon_decline_reason TEXT,
      addon_sign_token TEXT UNIQUE,
      addon_sign_token_expires_at TEXT,
      addon_signed_at TEXT,
      addon_signature_name TEXT,
      addon_signed_ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_inspection_order_items_order ON inspection_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_status ON inspection_orders(status);
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_agent ON inspection_orders(agent_id);

    -- v20.32.13 — Part 1: per-vendor, sqft-tiered inspection pricing. Reuses
    -- repair_vendors as the vendor table (inspection_order_items.vendor_id
    -- already pointed there) instead of a separate inspection_vendors table.
    CREATE TABLE IF NOT EXISTS inspection_vendor_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES repair_vendors(id),
      item_key TEXT NOT NULL,                 -- hi | wdo | 4pt | wm | pool | septic
      context TEXT NOT NULL DEFAULT 'standalone', -- 'standalone' | 'bundled_with_hi'
      sqft_min INTEGER NOT NULL DEFAULT 0,
      sqft_max INTEGER,                       -- NULL = no upper bound
      vendor_cost REAL NOT NULL,
      markup_pct_override REAL,               -- NULL = use vendor-level repair_vendors.markup_pct (or 0.25 global default)
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inspection_vendor_pricing_lookup ON inspection_vendor_pricing(vendor_id, item_key, context);
  `);

  // v20.32.13 — subject_sqft + vendor_id on the order itself, so the correct
  // tier resolves automatically and historical orders keep a record of what
  // sqft/vendor were used at time of order.
  const ioCols = (rawDb.prepare(`PRAGMA table_info(inspection_orders)`).all() as any[]).map((c: any) => c.name);
  if (!ioCols.includes("subject_sqft")) rawDb.prepare("ALTER TABLE inspection_orders ADD COLUMN subject_sqft INTEGER").run();
  if (!ioCols.includes("vendor_id"))    rawDb.prepare("ALTER TABLE inspection_orders ADD COLUMN vendor_id INTEGER REFERENCES repair_vendors(id)").run();
  // v20.32.27 — Inspections+ is buyer-tooled by default (Home Inspection,
  // WDO, 4pt, etc. ordered during a buyer's due-diligence period), but the
  // shared bottom-nav chooser lets an agent launch it from the seller side
  // too (sharedToolDealSide). Persist which side this order was created for
  // so client-facing copy (email + accept page) never says "as we prepare to
  // list your home" to a buyer, or vice versa.
  if (!ioCols.includes("deal_side"))    rawDb.prepare("ALTER TABLE inspection_orders ADD COLUMN deal_side TEXT NOT NULL DEFAULT 'buyer'").run();

  // v20.32.13 — vendor-level default markup (repair_vendors is shared by
  // Repair AND Inspections vendors). NULL = fall back to the 25% global
  // default in resolveInspectionPricing().
  const rvCols2 = (rawDb.prepare(`PRAGMA table_info(repair_vendors)`).all() as any[]).map((c: any) => c.name);
  if (!rvCols2.includes("markup_pct")) rawDb.prepare("ALTER TABLE repair_vendors ADD COLUMN markup_pct REAL").run();

  seedInspectionItems();
  seedInspectionVendorPricing();
  fixInspectionVendorDataIntegrity();
  seedProSpectVendorPricing();
}

const DEFAULT_INSPECTION_MARKUP_PCT = 0.25;

function roundToNearest5(n: number): number {
  return Math.round(n / 5) * 5;
}

// Resolves the (vendor, item, context, sqft) tier into a vendor_cost /
// client_price pair. Returns null when no vendor is selected or no tier
// row matches — callers should fall back to the flat inspection_items
// catalog price in that case.
// v20.32.21 — the only items with a genuine price difference when a full HI
// is also ordered are WM and 4pt (per Jason Brown's real quote structure).
// Every other item (wdo, pool, pool_leak, mold_swab, mold_air, sewer_scope,
// septic) only ever has a 'standalone' tier row seeded for any vendor.
export const BUNDLABLE_WITH_HI_KEYS = new Set(["wm", "4pt"]);

export function resolveInspectionPricing(vendorId: number | null | undefined, itemKey: string, context: "standalone" | "bundled_with_hi", sqft: number | null | undefined): { vendorCost: number; clientPrice: number; tierId: number } | null {
  if (!vendorId || !sqft || sqft <= 0) return null;
  const row = rawDb.prepare(`
    SELECT * FROM inspection_vendor_pricing
    WHERE vendor_id = ? AND item_key = ? AND context = ? AND active = 1
      AND sqft_min <= ? AND (sqft_max IS NULL OR sqft_max >= ?)
    ORDER BY sqft_min DESC LIMIT 1
  `).get(vendorId, itemKey, context, sqft, sqft) as any;
  if (!row) return null;
  const vendor = rawDb.prepare(`SELECT markup_pct FROM repair_vendors WHERE id = ?`).get(vendorId) as any;
  const markup = row.markup_pct_override ?? vendor?.markup_pct ?? DEFAULT_INSPECTION_MARKUP_PCT;
  const clientPrice = roundToNearest5(row.vendor_cost * (1 + markup));
  return { vendorCost: row.vendor_cost, clientPrice, tierId: row.id };
}

// Seeds Jason Brown as the first inspection vendor + his placeholder tier
// ladder, built from his actual reply ("Home inspection starts at $349. WM
// and 4pt differ, with a full home inspection start at $75 each depending on
// sqft. Without a home inspection, insurance comp inspections start at $95
// ea. WDO scheduled via Bug Man Express for ~$125, same-day.") plus
// industry-standard per-sqft scaling for the bands he didn't specify.
// CLEARLY A PLACEHOLDER — swap in Jason's real tier sheet the moment he
// sends it (data update only, not a schema change).
function seedInspectionVendorPricing() {
  const existing = rawDb.prepare(`SELECT id FROM repair_vendors WHERE trade = 'inspection' AND name = 'Jason Brown'`).get() as any;
  let vendorId: number;
  if (existing) {
    vendorId = existing.id;
  } else {
    const result = rawDb.prepare(`
      INSERT INTO repair_vendors (trade, name, email, phone, notes, markup_pct)
      VALUES ('inspection', 'Jason Brown', 'TBD@brothersgroup.realestate', NULL, 'Placeholder contact info — update with Jason''s real email/phone. WDO is subcontracted to Bug Man Express (flat $125, no sqft scaling given). Pricing tiers below are placeholders built from his starting-price reply + industry-standard scaling — swap in his real fee schedule when he sends it.', 0.25)
    `).run();
    vendorId = Number(result.lastInsertRowid);
  }

  const tierCount = (rawDb.prepare(`SELECT COUNT(*) as c FROM inspection_vendor_pricing WHERE vendor_id = ?`).get(vendorId) as any).c;
  if (tierCount > 0) return;

  const rows: [string, string, number, number | null, number, string][] = [
    // Home Inspection — vendor_cost by sqft band (context irrelevant for HI itself, use 'standalone')
    ["hi", "standalone", 0, 2000, 349, "Placeholder — Jason's actual starting price."],
    ["hi", "standalone", 2001, 2500, 399, "Placeholder — industry-standard scaling above Jason's starting price."],
    ["hi", "standalone", 2501, 3000, 449, "Placeholder — industry-standard scaling above Jason's starting price."],
    ["hi", "standalone", 3001, 3500, 499, "Placeholder — industry-standard scaling above Jason's starting price."],
    ["hi", "standalone", 3501, 4000, 549, "Placeholder — industry-standard scaling above Jason's starting price. 4,001+ sqft is \"Call for quote\" — no tier row seeded above 4,000."],
    // WM + 4pt bundled with a full HI
    ["wm", "bundled_with_hi", 0, 2500, 75, "Placeholder — Jason's actual starting price, bundled with HI."],
    ["wm", "bundled_with_hi", 2501, 3500, 95, "Placeholder — industry-standard scaling."],
    ["wm", "bundled_with_hi", 3501, null, 115, "Placeholder — industry-standard scaling."],
    ["4pt", "bundled_with_hi", 0, 2500, 75, "Placeholder — Jason's actual starting price, bundled with HI."],
    ["4pt", "bundled_with_hi", 2501, 3500, 95, "Placeholder — industry-standard scaling."],
    ["4pt", "bundled_with_hi", 3501, null, 115, "Placeholder — industry-standard scaling."],
    // WM + 4pt standalone / insurance-comp-only
    ["wm", "standalone", 0, 2500, 95, "Placeholder — Jason's actual starting price, standalone/insurance-comp."],
    ["wm", "standalone", 2501, 3500, 115, "Placeholder — industry-standard scaling."],
    ["wm", "standalone", 3501, null, 135, "Placeholder — industry-standard scaling."],
    ["4pt", "standalone", 0, 2500, 95, "Placeholder — Jason's actual starting price, standalone/insurance-comp."],
    ["4pt", "standalone", 2501, 3500, 115, "Placeholder — industry-standard scaling."],
    ["4pt", "standalone", 3501, null, 135, "Placeholder — industry-standard scaling."],
    // WDO — flat, no sqft scaling given, via Bug Man Express subcontractor
    ["wdo", "standalone", 0, null, 125, "Flat rate via Bug Man Express subcontractor — no sqft scaling given by Jason."],
  ];
  const ins = rawDb.prepare(`INSERT INTO inspection_vendor_pricing (vendor_id, item_key, context, sqft_min, sqft_max, vendor_cost, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const [itemKey, context, sqftMin, sqftMax, vendorCost, notes] of rows) {
    ins.run(vendorId, itemKey, context, sqftMin, sqftMax, vendorCost, notes);
  }
}

// Placeholder catalog per Alex's generalization (message: "pricing scheme I
// gave you is a generalization... help build this out. We are going to get
// a quote for all Inspectors on our vendor list so we know what we're
// talking about and what our margins are."). Vendor costs for the 4 bundle
// items are a proportional split of Jason Brown's known $400 all-in bundle
// price (450+150+100+75=775 client total) so the seeded profit lines up with
// Alex's own math ($775 - $400 = $375) until real itemized quotes replace
// them. Pool/Septic vendor cost is left NULL (TBD — "need to request general
// pricing" per Alex).
function seedInspectionItems() {
  const count = (rawDb.prepare(`SELECT COUNT(*) as c FROM inspection_items`).get() as any).c;
  if (count > 0) return;
  const rows: [string, string, number, number | null, number, string | null][] = [
    ["hi", "Home Inspection", 450, 232.26, 10, "Vendor cost is a placeholder — proportional split of Jason Brown's $400 bundle price. Awaiting itemized vendor quote."],
    ["wdo", "WDO (Wood-Destroying Organism) Inspection", 150, 77.42, 20, "Vendor cost is a placeholder — proportional split of Jason Brown's $400 bundle price. Awaiting itemized vendor quote."],
    ["4pt", "4-Point Inspection", 100, 51.61, 30, "Vendor cost is a placeholder — proportional split of Jason Brown's $400 bundle price. Awaiting itemized vendor quote."],
    ["wm", "Wind Mitigation Inspection", 75, 38.71, 40, "Vendor cost is a placeholder — proportional split of Jason Brown's $400 bundle price. Awaiting itemized vendor quote."],
    ["pool", "Pool Inspection", 150, null, 50, "Vendor cost TBD — need to request general pricing from vendor list."],
    ["septic", "Septic Inspection", 150, null, 60, "Vendor cost TBD — need to request general pricing from vendor list."],
  ];
  const ins = rawDb.prepare(`INSERT INTO inspection_items (key, name, client_price, vendor_cost, sequence_order, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(...r);
}

// v20.32.20 — Fixes a real data-integrity bug uncovered while incorporating
// Pro-Spect's real pricing reply: her vendor row was saved with
// trade = 'inspections' (PLURAL), but /api/inspection-vendors (the picker
// that populates the Inspections+ order form) filters on the SINGULAR
// 'inspection' — so she has never actually appeared as a selectable vendor.
// The same typo also orphaned Jason Brown's real contact info onto a
// separate dead vendor row ("1st Class Home Inspections Plus") while his
// sqft-tiered pricing lived on a second row ("Jason Brown") stuck with
// placeholder contact info. Idempotent — safe to run on every boot.
function fixInspectionVendorDataIntegrity() {
  // Fix 1: Pro-Spect's trade typo, so she actually shows up in the picker.
  rawDb.prepare(`UPDATE repair_vendors SET trade = 'inspection' WHERE name = 'Pro-Spect Inspection Services' AND trade = 'inspections'`).run();

  // v20.32.28 — Alex: Pro-Spect is now our ONLY preferred inspection vendor.
  // Deactivate Jason Brown's pricing row so he no longer shows in the
  // vendor picker on new orders. Idempotent (guarded by active = 1).
  rawDb.prepare(`UPDATE repair_vendors SET active = 0, notes = COALESCE(notes, '') || ' [Deactivated 8/26/26 — Alex: Pro-Spect is now our sole preferred inspection vendor.]' WHERE trade = 'inspection' AND name = 'Jason Brown' AND active = 1`).run();

  // Fix 2: merge Jason Brown's two vendor rows — copy the real contact info
  // onto the pricing row, then deactivate the duplicate.
  const dup = rawDb.prepare(`SELECT * FROM repair_vendors WHERE name = '1st Class Home Inspections Plus' AND active = 1`).get() as any;
  const jasonPricing = rawDb.prepare(`SELECT * FROM repair_vendors WHERE trade = 'inspection' AND name = 'Jason Brown'`).get() as any;
  if (dup && jasonPricing && jasonPricing.email === "TBD@brothersgroup.realestate") {
    rawDb.prepare(`UPDATE repair_vendors SET email = ?, phone = ?, notes = ? WHERE id = ?`).run(
      dup.email,
      dup.phone,
      "Jason Brown, 1st Class Home Inspections Plus. Contact info merged in from a duplicate vendor row (previously split across two rows by a trade-field typo, fixed 8/25/26). WDO subcontracted to Bug Man Express (flat $125, no sqft scaling given). Pricing tiers below are placeholders built from his starting-price reply + industry-standard scaling — swap in his real fee schedule when he sends it.",
      jasonPricing.id
    );
    rawDb.prepare(`UPDATE repair_vendors SET active = 0, notes = COALESCE(notes, '') || ' [Merged into vendor id ' || ? || ' — Jason Brown — on 2026-08-25, do not reactivate.]' WHERE id = ?`).run(jasonPricing.id, dup.id);
  }

  // New service types Pro-Spect offers that Jason's catalog doesn't have
  // yet: pool inspection w/ leak detection, mold swab, mold air test, sewer
  // scope. Client price = her vendor cost x the same 25% markup convention
  // used elsewhere, rounded to the nearest $5. Checked per-key (not gated
  // behind a single count()), so it still inserts even though the original
  // 6-item seed already ran.
  const newCatalogRows: [string, string, number, number, number, string][] = [
    ["pool_leak", "Pool Inspection w/ Leak Detection", 425, 339, 55, "Vendor cost from Pro-Spect Inspection Services (8/25/26 reply). Leak-detection portion is subcontracted by Pro-Spect; she coordinates it for the same visit as the home inspection."],
    ["mold_swab", "Mold Swab Test", 245, 197, 70, "Vendor cost from Pro-Spect Inspection Services (8/25/26 reply)."],
    ["mold_air", "Mold Air Test", 295, 237, 80, "Vendor cost from Pro-Spect Inspection Services (8/25/26 reply)."],
    ["sewer_scope", "Sewer Scope Inspection", 305, 245, 90, "Vendor cost from Pro-Spect Inspection Services (8/25/26 reply)."],
  ];
  const catalogExists = rawDb.prepare(`SELECT 1 FROM inspection_items WHERE key = ?`);
  const catalogIns = rawDb.prepare(`INSERT INTO inspection_items (key, name, client_price, vendor_cost, sequence_order, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [key, name, clientPrice, vendorCost, seq, notes] of newCatalogRows) {
    if (!catalogExists.get(key)) catalogIns.run(key, name, clientPrice, vendorCost, seq, notes);
  }
}

// Seeds Pro-Spect Inspection Services' real reply pricing (8/25/26 email):
// Condo HI starts $237, Home HI starts $325, 4pt+WM bundle $120 total, WDO
// $131, Pool $85, Pool w/ leak detection $339, Mold swab $197, Mold air test
// $237, Sewer scope $245 — she does not offer septic inspections. She gave
// single "starts at" numbers, not a full sqft ladder like Jason's, so every
// tier below is seeded as ONE flat band (0 to no max) rather than guessing
// scaling. Swap in her real sqft tiers the moment she sends them.
function seedProSpectVendorPricing() {
  const existing = rawDb.prepare(`SELECT id FROM repair_vendors WHERE trade = 'inspection' AND name = 'Pro-Spect Inspection Services'`).get() as any;
  let vendorId: number;
  if (existing) {
    vendorId = existing.id;
  } else {
    const result = rawDb.prepare(`
      INSERT INTO repair_vendors (trade, name, email, phone, notes, markup_pct)
      VALUES ('inspection', 'Pro-Spect Inspection Services', 'clientcare@pro-spectfl.com', '863-999-0002', 'Real contact info from Pro-Spect''s 8/25/26 pricing reply. Handles mold and sewer scope in-house; pool leak detection is subcontracted but coordinated for the same visit as the home inspection. Does not offer septic inspection.', 0.25)
    `).run();
    vendorId = Number(result.lastInsertRowid);
  }

  const tierCount = (rawDb.prepare(`SELECT COUNT(*) as c FROM inspection_vendor_pricing WHERE vendor_id = ?`).get(vendorId) as any).c;
  if (tierCount > 0) return;

  const rows: [string, string, number, number | null, number, string][] = [
    // Home Inspection — she quoted Condo ($237) vs Home ($325) by PROPERTY
    // TYPE, not sqft band. Schema only supports sqft tiers today, so this
    // seeds her Home (single-family) starting price; the lower Condo rate
    // isn't representable yet — flag to Alex if condo-specific pricing is
    // needed on a future job.
    ["hi", "standalone", 0, null, 325, "Starting price only (her reply: \"starts at $325\" for a home; scales with sqft, no ladder given yet). Condo starts lower at $237 — schema doesn't support property-type pricing yet, only sqft bands."],
    // 4pt+WM — she quotes ONE combined bundle price ($120 total), unlike
    // Jason who prices 4pt and WM separately. Split evenly for schema
    // compatibility ($60 each) — this is an assumption, not her literal
    // per-item breakdown.
    ["wm", "bundled_with_hi", 0, null, 60, "Half of her $120 combined 4pt+WM bundle price — split assumption, not her literal per-item price."],
    ["4pt", "bundled_with_hi", 0, null, 60, "Half of her $120 combined 4pt+WM bundle price — split assumption, not her literal per-item price."],
    // WDO — flat, no sqft scaling given.
    ["wdo", "standalone", 0, null, 131, "Starting price from her 8/25/26 reply — no sqft scaling given."],
    // Pool — plain inspection, flat.
    ["pool", "standalone", 0, null, 85, "Starting price from her 8/25/26 reply — no sqft scaling given."],
    // Pool + leak detection, mold, sewer scope — new item keys, flat.
    ["pool_leak", "standalone", 0, null, 339, "Starting price from her 8/25/26 reply. Leak-detection portion is subcontracted by Pro-Spect; she coordinates it for the same visit as the HI."],
    ["mold_swab", "standalone", 0, null, 197, "Starting price from her 8/25/26 reply — no sqft scaling given."],
    ["mold_air", "standalone", 0, null, 237, "Starting price from her 8/25/26 reply — no sqft scaling given."],
    ["sewer_scope", "standalone", 0, null, 245, "Starting price from her 8/25/26 reply — no sqft scaling given."],
  ];
  const ins = rawDb.prepare(`INSERT INTO inspection_vendor_pricing (vendor_id, item_key, context, sqft_min, sqft_max, vendor_cost, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const [itemKey, context, sqftMin, sqftMax, vendorCost, notes] of rows) {
    ins.run(vendorId, itemKey, context, sqftMin, sqftMax, vendorCost, notes);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getOrderRow(id: number): any {
  return rawDb.prepare(`SELECT * FROM inspection_orders WHERE id = ?`).get(id);
}
function getOrderByToken(token: string): any {
  return rawDb.prepare(`SELECT * FROM inspection_orders WHERE sign_token = ?`).get(token);
}
function getOrderItems(orderId: number): any[] {
  return rawDb.prepare(`SELECT * FROM inspection_order_items WHERE order_id = ? ORDER BY is_addon ASC, id ASC`).all(orderId) as any[];
}
function getAddonRow(id: number): any {
  return rawDb.prepare(`SELECT * FROM inspection_order_items WHERE id = ? AND is_addon = 1`).get(id);
}
function getAddonByToken(token: string): any {
  return rawDb.prepare(`SELECT * FROM inspection_order_items WHERE addon_sign_token = ?`).get(token);
}

// Recomputes subtotal/total/vendor_cost_total from: all original items
// (is_addon=0) PLUS any add-on that's been client-signed. Pending/declined
// add-ons never count toward the total.
function recalcOrderTotals(orderId: number) {
  const rows = rawDb.prepare(`
    SELECT client_price, vendor_cost FROM inspection_order_items
    WHERE order_id = ? AND (is_addon = 0 OR addon_status = 'signed')
  `).all(orderId) as any[];
  const total = rows.reduce((s, r) => s + (r.client_price || 0), 0);
  const vendorTotal = rows.reduce((s, r) => s + (r.vendor_cost || 0), 0);
  rawDb.prepare(`UPDATE inspection_orders SET subtotal = ?, total = ?, vendor_cost_total = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(total, total, vendorTotal, orderId);
}

function neededByLabel(order: any): string {
  if (order.needed_by === "specific" && order.needed_by_date) {
    return `By ${new Date(order.needed_by_date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
  }
  return "As soon as possible";
}

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
    Alex &amp; Nate Watson — (904) 504-3794 — www.brothersgroup.realestate
  </div>`;
}
function itemsTableHtml(items: any[]): string {
  const rows = items.map(it => `
    <tr style="border-bottom:1px solid #e2e2e2">
      <td style="padding:8px 0;color:#333;font-size:13px">${it.name}${it.is_addon ? " (Add-On)" : ""}</td>
      <td style="padding:8px 0;text-align:right;color:#333;font-size:13px">$${(it.client_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
    </tr>`).join("");
  return `<table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr style="border-bottom:2px solid ${BRAND.black}"><th style="text-align:left;padding:6px 0;color:${BRAND.black}">Service</th><th style="text-align:right;padding:6px 0;color:${BRAND.black}">Price</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ─── EMAIL: Client-facing order w/ single-stage accept link ────────────────
// v20.32.27 — first-name-only greeting helper. Full-name greetings ("Hi
// Alex Watson —") read stiff/formal; every client-facing salutation should
// use just the first name, falling back to "there" when no name is on file.
function firstName(fullName: string | null | undefined): string {
  const n = (fullName || "").trim();
  return n ? n.split(/\s+/)[0] : "there";
}

// v20.32.27 — deal-side-aware intro paragraph. Inspections+ defaults to the
// buyer side (due-diligence inspections), but the shared bottom-nav chooser
// lets an agent launch it from the seller side too — so the copy can no
// longer hardcode "as we prepare to list your home" for every order.
function inspectionsIntroParagraph(order: any): string {
  const name = firstName(order.client_name);
  const context = order.deal_side === "seller" ? "as we prepare to list your home" : "as part of your due-diligence period";
  return `Hi ${name} — ${context}, we'd like to get these inspections scheduled right away. Brothers Group will place this order on your behalf with our inspection partner and handle payment directly, so everything moves quickly and cleanly on your timeline. Please review and approve below — once approved, we'll send wiring instructions so you can submit payment to us, and as soon as it's received we'll place your order with the vendor. Time is of the essence, so the sooner this is approved and paid, the sooner we can get you scheduled.`;
}

// v20.32.25 — html-building extracted into buildInspectionOrderEmailHtml() so
// the admin "Preview" feature renders the exact same markup the client will
// receive, byte-for-byte, before "Send to Client" is ever clicked.
function buildInspectionOrderEmailHtml(order: any, items: any[], opts: { preview?: boolean } = {}): string {
  const acceptUrl = order.sign_token
    ? `${APP_URL}/#/inspections/${order.sign_token}`
    : (opts.preview ? "#" : `${APP_URL}/#/inspections/`);

  return `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Inspections+ Order", order.property_address)}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">${inspectionsIntroParagraph(order)}</p>
      ${itemsTableHtml(items)}
      <table style="width:100%;margin-top:14px">
        <tr><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:16px;font-weight:700;width:110px">$${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>
      <div style="margin-top:14px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px;font-size:12.5px;color:#333">
        <p style="margin:0 0 4px"><strong>Needed by:</strong> ${neededByLabel(order)}</p>
        ${order.contingency_expiration_date ? `<p style="margin:0"><strong>Inspection contingency expires:</strong> ${new Date(order.contingency_expiration_date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} — time is of the essence, so the sooner we get this approved and scheduled the better.</p>` : ""}
      </div>
      <div style="text-align:center;margin:28px 0 10px">
        <a href="${acceptUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block">Review &amp; Approve</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${acceptUrl}" style="color:${BRAND.gray}">${acceptUrl}</a></p>
      <div style="margin-top:14px;padding:12px 16px;background:#fff4d6;border:1px solid #e6c766;border-radius:8px">
        <p style="margin:0;font-size:12px;color:${BRAND.black}"><strong>After you approve, we'll email you wiring instructions.</strong> Payment is due to Brothers Group before we place your order with the vendor. Time is of the essence — please review and submit payment promptly. Our wiring instructions will never change over email; always verify by phone at a known number before sending funds.</p>
      </div>
      <p style="font-size:11px;color:#333;text-align:center;margin-top:10px">We're working together as a team on your timeline — please let us know if you have any questions.</p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
}

export async function sendInspectionOrderToClient(orderId: number) {
  if (!resend) return;
  const order = getOrderRow(orderId);
  if (!order || !order.client_email) return;
  const items = getOrderItems(orderId).filter(i => !i.is_addon);
  const html = buildInspectionOrderEmailHtml(order, items);

  await resend.emails.send({
    from: FROM, to: [order.client_email], cc: ADMIN_EMAILS,
    subject: `Inspections+ Order — ${order.property_address}`,
    html,
  });
  rawDb.prepare(`UPDATE inspection_orders SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(orderId);
}

// v20.32.28 — Nate (TC) is the one who actually places the vendor order, and
// only AFTER payment is confirmed received. This internal email tells him
// the client approved and exactly what to order once cleared — but explicitly
// tells him to HOLD until the payment-received email (see
// notifyTCPaymentReceivedForInspectionOrder below) arrives.
async function sendInspectionOrderAcceptedInternal(orderId: number) {
  if (!resend) return;
  const order = getOrderRow(orderId);
  if (!order) return;
  const items = getOrderItems(orderId).filter(i => !i.is_addon);
  const vendor = order.vendor_id ? rawDb.prepare(`SELECT name, phone, email FROM repair_vendors WHERE id = ?`).get(order.vendor_id) as any : null;
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Inspections+ Approved by Client — Action Needed", order.property_address)}
    <div style="padding:20px 32px">
      <table style="width:100%;font-size:12.5px;color:#333;margin-bottom:10px">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:130px">Client</td><td style="font-weight:600">${order.client_name}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Signed</td><td>${order.accepted_signature_name}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Needed By</td><td>${neededByLabel(order)}</td></tr>
        ${order.contingency_expiration_date ? `<tr><td style="padding:4px 0;color:${BRAND.gray}">Contingency Expires</td><td>${order.contingency_expiration_date}</td></tr>` : ""}
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Vendor</td><td>${vendor ? `${vendor.name} — ${vendor.phone || ""} ${vendor.email || ""}` : "Pro-Spect Inspection Services"}</td></tr>
      </table>
      ${itemsTableHtml(items)}
      <table style="width:100%;margin-top:10px">
        <tr><td style="padding:4px 10px;text-align:right;font-size:14px;font-weight:700">Total</td><td style="padding:4px 10px;text-align:right;font-size:14px;font-weight:700;width:110px">$${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>
      <div style="margin-top:14px;padding:12px 16px;background:#fde2e2;border:1px solid #e08585;border-radius:8px">
        <p style="margin:0;font-size:12.5px;color:${BRAND.black};font-weight:700">HOLD — do not place this order with the vendor yet.</p>
        <p style="margin:6px 0 0;font-size:12px;color:#333">The client has been sent wiring instructions to pay Brothers Group directly (Relay account). You'll get a separate "Payment Received" email the moment it's recorded in Lead Depot — that's your signal to go ahead and place the order above with ${vendor ? vendor.name : "Pro-Spect Inspection Services"}. Time is of the essence, so keep an eye out for that clearance email and place the order right away once it lands.</p>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  const ccList = ADMIN_EMAILS.filter(e => e.toLowerCase() !== NATE_EMAIL);
  await resend.emails.send({ from: FROM, to: [NATE_EMAIL], cc: ccList, subject: `Inspections+ Approved — Hold for Payment — ${order.property_address}`, html });
}

// ─── PDF: Wire payment instructions (client-facing) ────────────────────────
async function generateInspectionWiringPdf(order: any): Promise<{ path: string; filename: string; bytes: Buffer }> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const red = rgb(0.7, 0.1, 0.1);
  let y = 792 - 50;

  try {
    const logoBytes = fs.readFileSync(brandLogoPath());
    const logoImg = await pdfDoc.embedJpg(logoBytes);
    const logoW = 200;
    const logoH = (logoImg.height / logoImg.width) * logoW;
    page.drawImage(logoImg, { x: (612 - logoW) / 2, y: y - logoH, width: logoW, height: logoH });
    y -= logoH + 20;
  } catch { /* logo optional */ }

  page.drawText("Wire Payment Instructions", { x: 306 - bold.widthOfTextAtSize("Wire Payment Instructions", 20) / 2, y, size: 20, font: bold, color: black });
  y -= 30;

  // Property bar
  page.drawRectangle({ x: 38, y: y - 22, width: 612 - 76, height: 24, color: black });
  page.drawText(order.property_address || "", { x: 46, y: y - 16, size: 10.5, font: bold, color: rgb(1, 1, 1) });
  y -= 46;

  const row = (label: string, value: string, size = 11) => {
    page.drawText(label, { x: 38, y, size: 9, font: bold, color: gray });
    page.drawText(value, { x: 38, y: y - 14, size, font, color: black });
    y -= 34;
  };

  row("REFERENCE", `INS-${order.id} — ${order.client_name || ""}`);
  row("AMOUNT DUE", `$${(order.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 14);

  y -= 6;
  page.drawLine({ start: { x: 38, y }, end: { x: 612 - 38, y }, thickness: 1, color: rgb(0.85, 0.85, 0.85) });
  y -= 26;

  page.drawText("WIRE TO", { x: 38, y, size: 10.5, font: bold, color: black });
  y -= 20;
  row("BENEFICIARY", RELAY_WIRE.beneficiary);
  row("BANK", RELAY_WIRE.bankName);
  row("ACCOUNT NUMBER", RELAY_WIRE.accountNumber, 13);
  row("ROUTING NUMBER", RELAY_WIRE.routingNumber, 13);
  row("ACCOUNT TYPE", RELAY_WIRE.accountType);
  row("BUSINESS ADDRESS", RELAY_WIRE.businessAddress);

  y -= 6;
  const warnH = 96;
  page.drawRectangle({ x: 38, y: y - warnH, width: 612 - 76, height: warnH, color: rgb(0.99, 0.95, 0.85), borderColor: rgb(0.85, 0.68, 0.25), borderWidth: 1 });
  page.drawText("TIME IS OF THE ESSENCE", { x: 50, y: y - 18, size: 10.5, font: bold, color: black });
  const line1 = "Contract and inspection contingency deadlines do not pause while payment is processed.";
  const line2 = "Please wire promptly upon receiving this document to keep your order on schedule.";
  page.drawText(line1, { x: 50, y: y - 34, size: 9, font, color: black });
  page.drawText(line2, { x: 50, y: y - 47, size: 9, font, color: black });
  page.drawText("WIRE FRAUD WARNING", { x: 50, y: y - 66, size: 10.5, font: bold, color: red });
  const line3 = "These instructions will never change over email. Verify by phone at (904) 504-3794 before sending funds.";
  page.drawText(line3, { x: 50, y: y - 82, size: 9, font, color: black });
  y -= warnH + 20;

  page.drawText("Alex & Nate Watson — Brothers Group at Momentum Realty — (904) 504-3794 — www.brothersgroup.realestate", { x: 38, y: 40, size: 8, font, color: gray });

  const bytes = await pdfDoc.save();
  const filename = `wiring-INS-${order.id}-${Date.now()}.pdf`;
  const dir = inspectionWiringDir();
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, filename, bytes: Buffer.from(bytes) };
}

// ─── EMAIL: Wire instructions to client (sent right after they approve) ────
async function sendWiringInstructionsToClient(orderId: number) {
  if (!resend) return;
  const order = getOrderRow(orderId);
  if (!order || !order.client_email) return;
  const pdf = await generateInspectionWiringPdf(order);
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Wire Payment Instructions", order.property_address)}
    <div style="padding:20px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${firstName(order.client_name)} — thank you for approving your inspection order. To get your inspections scheduled, please wire the amount below to Brothers Group. As soon as payment is received we'll place your order with the vendor.</p>
      <table style="width:100%;margin:12px 0;font-size:13px;color:#333">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:140px">Amount Due</td><td style="font-weight:700;font-size:16px">$${(order.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Reference</td><td>INS-${order.id}</td></tr>
      </table>
      <div style="border:1px solid #e2e2e2;border-radius:8px;padding:14px 16px;margin:14px 0;font-size:12.5px;color:#333">
        <p style="margin:0 0 4px"><strong>Beneficiary:</strong> ${RELAY_WIRE.beneficiary}</p>
        <p style="margin:0 0 4px"><strong>Bank:</strong> ${RELAY_WIRE.bankName}</p>
        <p style="margin:0 0 4px"><strong>Account Number:</strong> ${RELAY_WIRE.accountNumber}</p>
        <p style="margin:0 0 4px"><strong>Routing Number:</strong> ${RELAY_WIRE.routingNumber}</p>
        <p style="margin:0 0 4px"><strong>Account Type:</strong> ${RELAY_WIRE.accountType}</p>
        <p style="margin:0"><strong>Business Address:</strong> ${RELAY_WIRE.businessAddress}</p>
      </div>
      <div style="margin-top:10px;padding:12px 16px;background:#fff4d6;border:1px solid #e6c766;border-radius:8px">
        <p style="margin:0;font-size:12px;color:${BRAND.black}"><strong>Time is of the essence</strong> — contract and inspection contingency deadlines do not pause while payment is processed. Please wire promptly to keep your order on schedule.</p>
      </div>
      <div style="margin-top:10px;padding:12px 16px;background:#fde2e2;border:1px solid #e08585;border-radius:8px">
        <p style="margin:0;font-size:12px;color:${BRAND.black}"><strong>Wire fraud warning:</strong> these instructions will never change over email. If you receive an email claiming updated wiring instructions, do not act on it — call us directly at (904) 504-3794 to verify before sending any funds.</p>
      </div>
      <p style="font-size:11px;color:#333;margin-top:14px">Full wiring instructions are also attached as a PDF for your records. Let us know if you have any questions.</p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({
    from: FROM, to: [order.client_email], cc: ADMIN_EMAILS,
    subject: `Wire Payment Instructions — ${order.property_address}`,
    html,
    attachments: [{ filename: "Wire-Payment-Instructions.pdf", content: pdf.bytes.toString("base64") }],
  });
}

// ─── EMAIL: Payment confirmed -> tells Nate (TC) it's clear to place the
// vendor order. Called from payments.ts's reconciliation hook once the sum
// of recorded payments meets/exceeds the order total. Exported so payments.ts
// can call it without duplicating inspection-order email-building logic.
export async function notifyTCPaymentReceivedForInspectionOrder(orderId: number) {
  if (!resend) return;
  const order = getOrderRow(orderId);
  if (!order) return;
  const items = getOrderItems(orderId).filter(i => !i.is_addon || i.addon_status === "signed");
  const vendor = order.vendor_id ? rawDb.prepare(`SELECT name, phone, email FROM repair_vendors WHERE id = ?`).get(order.vendor_id) as any : null;
  const vendorLabel = vendor ? `${vendor.name}${vendor.phone ? ` — ${vendor.phone}` : ""}${vendor.email ? ` — ${vendor.email}` : ""}` : "Pro-Spect Inspection Services";
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Payment Received — Clear to Order", order.property_address)}
    <div style="padding:20px 32px">
      <div style="margin-top:0;padding:12px 16px;background:#e2f5e9;border:1px solid #7dbf9a;border-radius:8px">
        <p style="margin:0;font-size:12.5px;color:${BRAND.black};font-weight:700">Payment received in full — go ahead and place this order with ${vendorLabel} now.</p>
      </div>
      <table style="width:100%;font-size:12.5px;color:#333;margin:14px 0 10px">
        <tr><td style="padding:4px 0;color:${BRAND.gray};width:130px">Client</td><td style="font-weight:600">${order.client_name}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Phone</td><td>${order.client_phone || "—"}</td></tr>
        <tr><td style="padding:4px 0;color:${BRAND.gray}">Needed By</td><td>${neededByLabel(order)}</td></tr>
        ${order.contingency_expiration_date ? `<tr><td style="padding:4px 0;color:${BRAND.gray}">Contingency Expires</td><td>${order.contingency_expiration_date}</td></tr>` : ""}
      </table>
      ${itemsTableHtml(items)}
      <p style="font-size:12px;color:#333;margin-top:14px">Time is of the essence — please place this order right away to keep the inspection contingency on track.</p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  const ccList = ADMIN_EMAILS.filter(e => e.toLowerCase() !== NATE_EMAIL);
  await resend.emails.send({ from: FROM, to: [NATE_EMAIL], cc: ccList, subject: `Payment Received — Place Order with ${vendor ? vendor.name : "Pro-Spect"} — ${order.property_address}`, html });
}

// ─── EMAIL: Add-on requested (internal notify to admins for office-approve) ─
async function sendAddonRequestedInternal(itemId: number) {
  if (!resend) return;
  const addon = getAddonRow(itemId);
  if (!addon) return;
  const order = getOrderRow(addon.order_id);
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Inspections+ Add-On Requested — Needs Office Approval", order?.property_address || "")}
    <div style="padding:20px 32px">
      <p style="font-size:13px;color:#333"><strong>${addon.name}</strong> — $${(addon.client_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
      <p style="font-size:12.5px;color:${BRAND.gray}">Reason: ${addon.addon_reason || "—"}</p>
      <p style="font-size:12px;color:#333;margin-top:14px">Open the Inspections+ admin queue in Lead Depot to office-approve and send the client their add-on e-sign link.</p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({ from: FROM, to: ADMIN_EMAILS, subject: `Inspections+ Add-On Requested — ${order?.property_address || ""}`, html });
}

// ─── EMAIL: Add-on office-approved -> client sign link ─────────────────────
async function sendAddonSignEmail(itemId: number) {
  if (!resend) return;
  const addon = getAddonRow(itemId);
  if (!addon) return;
  const order = getOrderRow(addon.order_id);
  if (!order || !order.client_email) return;
  const signUrl = `${APP_URL}/#/inspections/addon/${addon.addon_sign_token}`;
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Additional Inspection Requested", order.property_address)}
    <div style="padding:24px 32px">
      <p style="font-size:13.5px;color:#333;line-height:1.6;margin-top:0">Hi ${order.client_name || "there"} — we'd like to add one more inspection to your order:</p>
      <div style="border:1px solid #e2e2e2;border-radius:8px;padding:14px 16px;margin:14px 0">
        <p style="margin:0 0 4px;font-weight:700;font-size:14px">${addon.name}</p>
        <p style="margin:0;font-size:16px;font-weight:700">$${(addon.client_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
      </div>
      <div style="text-align:center;margin:24px 0 10px">
        <a href="${signUrl}" style="background:${BRAND.black};color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block">Review &amp; Approve Add-On</a>
      </div>
      <p style="font-size:10.5px;color:${BRAND.gray};text-align:center">Or open on your phone: <a href="${signUrl}" style="color:${BRAND.gray}">${signUrl}</a></p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({ from: FROM, to: [order.client_email], cc: ADMIN_EMAILS, subject: `Additional Inspection Requested — ${order.property_address}`, html });
}

async function sendAddonSignedInternal(itemId: number) {
  if (!resend) return;
  const addon = getAddonRow(itemId);
  if (!addon) return;
  const order = getOrderRow(addon.order_id);
  const html = `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    ${brandedHeader("Inspections+ Add-On Signed", order?.property_address || "")}
    <div style="padding:20px 32px">
      <p style="font-size:13px;color:#333"><strong>${addon.name}</strong> — $${(addon.client_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
      <p style="font-size:12.5px;color:${BRAND.gray}">Signed by ${addon.addon_signature_name}. New order total: $${(order?.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
      <div style="margin-top:14px;padding:12px 16px;background:#fde2e2;border:1px solid #e08585;border-radius:8px">
        <p style="margin:0;font-size:12.5px;color:${BRAND.black};font-weight:700">HOLD — this add-on is not yet paid for.</p>
        <p style="margin:6px 0 0;font-size:12px;color:#333">This add-on is billed and paid for the same way as the main order — Brothers Group collects payment from <strong>${order?.client_name || "the client"}</strong> and places the order with the vendor once payment is confirmed. Do not book this directly with the vendor.</p>
      </div>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
  await resend.emails.send({ from: FROM, to: ADMIN_EMAILS, subject: `Inspections+ Add-On Signed — ${order?.property_address || ""}`, html });
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
export function registerInspectionsRoutes(app: Express) {
  ensureInspectionsSchema();

  // ── Catalog: active items for the wizard checklist ──
  app.get("/api/inspection-items", (req: any, res: Response) => {
    const rows = rawDb.prepare(`SELECT * FROM inspection_items WHERE active = 1 ORDER BY sequence_order ASC`).all() as any[];
    res.json({ items: rows.map(r => ({ key: r.key, name: r.name, clientPrice: r.client_price, sequenceOrder: r.sequence_order })) });
  });

  // ── v20.32.13 Part 1: vendors that can be assigned to an inspection order ──
  app.get("/api/inspection-vendors", (req: any, res: Response) => {
    const rows = rawDb.prepare(`SELECT id, name, phone, email, notes FROM repair_vendors WHERE trade = 'inspection' AND active = 1 ORDER BY name ASC`).all();
    res.json({ vendors: rows });
  });

  // ── v20.32.13 Part 1: live tiered-price preview for the order form. Given a
  // vendor + sqft + the item keys currently checked, resolves each item's
  // vendor cost / client price using the sqft-tiered catalog, falling back
  // to the flat inspection_items price when no tier matches. ──
  app.get("/api/inspection-vendor-pricing/preview", (req: any, res: Response) => {
    const vendorId = req.query.vendorId ? Number(req.query.vendorId) : null;
    const sqft = req.query.sqft ? Number(req.query.sqft) : null;
    const itemKeys = String(req.query.itemKeys || "").split(",").map(s => s.trim()).filter(Boolean);
    const catalog = rawDb.prepare(`SELECT * FROM inspection_items WHERE active = 1`).all() as any[];
    const byKey = new Map(catalog.map(c => [c.key, c]));
    const hasHi = itemKeys.includes("hi");
    const results = itemKeys.map(key => {
      const cat = byKey.get(key);
      if (!cat) return null;
      const context: "standalone" | "bundled_with_hi" = hasHi && BUNDLABLE_WITH_HI_KEYS.has(key) ? "bundled_with_hi" : "standalone";
      const tier = resolveInspectionPricing(vendorId, key, context, sqft);
      return {
        key, name: cat.name,
        clientPrice: tier ? tier.clientPrice : cat.client_price,
        vendorCost: tier ? tier.vendorCost : cat.vendor_cost,
        source: tier ? "vendor_tier" : "flat_catalog",
      };
    }).filter(Boolean);
    res.json({ items: results });
  });

  // ── v20.32.13 Part 1: admin CRUD for per-vendor sqft-tiered pricing rows,
  // so Alex/Nate can adjust Jason's real tiers (or add a new vendor's tiers)
  // later without a code change. ──
  app.get("/api/admin/inspection-vendor-pricing", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const vendorId = req.query.vendorId ? Number(req.query.vendorId) : null;
    const rows = vendorId
      ? rawDb.prepare(`SELECT * FROM inspection_vendor_pricing WHERE vendor_id = ? ORDER BY item_key ASC, context ASC, sqft_min ASC`).all(vendorId)
      : rawDb.prepare(`SELECT * FROM inspection_vendor_pricing ORDER BY vendor_id ASC, item_key ASC, context ASC, sqft_min ASC`).all();
    res.json({ rows });
  });
  app.post("/api/admin/inspection-vendor-pricing", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { vendorId, itemKey, context, sqftMin, sqftMax, vendorCost, markupPctOverride, notes } = req.body || {};
    if (!vendorId || !itemKey || !vendorCost) return res.status(400).json({ error: "vendorId, itemKey, and vendorCost are required" });
    const result = rawDb.prepare(`
      INSERT INTO inspection_vendor_pricing (vendor_id, item_key, context, sqft_min, sqft_max, vendor_cost, markup_pct_override, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(vendorId, itemKey, context || "standalone", sqftMin || 0, sqftMax ?? null, vendorCost, markupPctOverride ?? null, notes || null);
    res.json({ id: Number(result.lastInsertRowid) });
  });
  app.patch("/api/admin/inspection-vendor-pricing/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { itemKey, context, sqftMin, sqftMax, vendorCost, markupPctOverride, notes, active } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (itemKey !== undefined) { fields.push("item_key = ?"); vals.push(itemKey); }
    if (context !== undefined) { fields.push("context = ?"); vals.push(context); }
    if (sqftMin !== undefined) { fields.push("sqft_min = ?"); vals.push(sqftMin); }
    if (sqftMax !== undefined) { fields.push("sqft_max = ?"); vals.push(sqftMax); }
    if (vendorCost !== undefined) { fields.push("vendor_cost = ?"); vals.push(vendorCost); }
    if (markupPctOverride !== undefined) { fields.push("markup_pct_override = ?"); vals.push(markupPctOverride); }
    if (notes !== undefined) { fields.push("notes = ?"); vals.push(notes); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    rawDb.prepare(`UPDATE inspection_vendor_pricing SET ${fields.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    res.json({ ok: true });
  });
  app.delete("/api/admin/inspection-vendor-pricing/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    rawDb.prepare(`DELETE FROM inspection_vendor_pricing WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  // ── Admin: full catalog CRUD (client price + vendor cost editable) ──
  app.get("/api/admin/inspection-items", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`SELECT * FROM inspection_items ORDER BY sequence_order ASC`).all();
    res.json({ items: rows });
  });
  app.post("/api/admin/inspection-items", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { key, name, clientPrice, vendorCost, sequenceOrder, notes } = req.body || {};
    if (!key || !name) return res.status(400).json({ error: "key and name are required" });
    const result = rawDb.prepare(`INSERT INTO inspection_items (key, name, client_price, vendor_cost, sequence_order, notes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(key, name, clientPrice || 0, vendorCost ?? null, sequenceOrder || 100, notes || null);
    res.json({ id: result.lastInsertRowid });
  });
  app.patch("/api/admin/inspection-items/:id", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, clientPrice, vendorCost, active, notes, sequenceOrder } = req.body || {};
    const fields: string[] = []; const vals: any[] = [];
    if (name !== undefined) { fields.push("name = ?"); vals.push(name); }
    if (clientPrice !== undefined) { fields.push("client_price = ?"); vals.push(clientPrice); }
    if (vendorCost !== undefined) { fields.push("vendor_cost = ?"); vals.push(vendorCost); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (notes !== undefined) { fields.push("notes = ?"); vals.push(notes); }
    if (sequenceOrder !== undefined) { fields.push("sequence_order = ?"); vals.push(sequenceOrder); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at = datetime('now')");
    rawDb.prepare(`UPDATE inspection_items SET ${fields.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    res.json({ ok: true });
  });

  // ── Agent: create draft order ──
  app.post("/api/inspection-orders", (req: any, res: Response) => {
    const {
      leadId, agentId, fubContactId, clientName, clientEmail, clientPhone,
      propertyAddress, neededBy, neededByDate, contingencyExpirationDate, itemKeys,
      vendorId, subjectSqft, dealSide,
    } = req.body || {};
    if (!propertyAddress || !String(propertyAddress).trim()) return res.status(400).json({ error: "propertyAddress is required" });
    if (!clientName || !String(clientName).trim()) return res.status(400).json({ error: "clientName is required" });
    if (!Array.isArray(itemKeys) || itemKeys.length === 0) return res.status(400).json({ error: "Select at least one inspection" });

    const resolvedAgentId = agentId || req.currentAgent?.id || null;
    const resolvedVendorId = vendorId ? Number(vendorId) : null;
    const resolvedSqft = subjectSqft ? Number(subjectSqft) : null;
    const resolvedDealSide = dealSide === "seller" ? "seller" : "buyer";
    const token = randomBytes(20).toString("hex");
    const result = rawDb.prepare(`
      INSERT INTO inspection_orders
        (lead_id, agent_id, fub_contact_id, client_name, client_email, client_phone, property_address,
         needed_by, needed_by_date, contingency_expiration_date, sign_token, vendor_id, subject_sqft, deal_side)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      leadId || null, resolvedAgentId, fubContactId || null, String(clientName).trim(), clientEmail || null, clientPhone || null,
      String(propertyAddress).trim(), neededBy === "specific" ? "specific" : "asap", neededBy === "specific" ? (neededByDate || null) : null,
      contingencyExpirationDate || null, token, resolvedVendorId, resolvedSqft, resolvedDealSide
    );
    const orderId = Number(result.lastInsertRowid);

    // v20.32.13 — Part 1: resolve per-vendor sqft-tiered pricing when a vendor
    // + sqft were provided. WM/4pt price differently depending on whether a
    // full HI is also in this same order ("bundled_with_hi" vs "standalone").
    const hasHi = itemKeys.includes("hi");
    const catalog = rawDb.prepare(`SELECT * FROM inspection_items WHERE active = 1`).all() as any[];
    const byKey = new Map(catalog.map(c => [c.key, c]));
    const insItem = rawDb.prepare(`INSERT INTO inspection_order_items (order_id, item_key, name, client_price, vendor_cost, vendor_id) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const key of itemKeys) {
      const cat = byKey.get(key);
      if (!cat) continue;
      // v20.32.21 — only WM/4pt actually have separate "bundled_with_hi" vs
      // "standalone" tier rows seeded (they're the only items whose price
      // legitimately changes when a full HI is also ordered). Every other
      // item (wdo, pool, pool_leak, mold_swab, mold_air, sewer_scope, septic)
      // only ever has a 'standalone' row — tagging them 'bundled_with_hi'
      // just because HI is also in the order caused resolveInspectionPricing
      // to find no match and silently fall back to the flat catalog default
      // instead of the real vendor price. Fixed: only WM/4pt get re-tagged.
      const context: "standalone" | "bundled_with_hi" = hasHi && BUNDLABLE_WITH_HI_KEYS.has(key) ? "bundled_with_hi" : "standalone";
      const tier = resolveInspectionPricing(resolvedVendorId, key, context, resolvedSqft);
      const clientPrice = tier ? tier.clientPrice : cat.client_price;
      const vendorCost = tier ? tier.vendorCost : cat.vendor_cost;
      insItem.run(orderId, cat.key, cat.name, clientPrice, vendorCost, tier ? resolvedVendorId : null);
    }
    recalcOrderTotals(orderId);
    res.json({ id: orderId });
  });

  // ── Agent: preview a draft order BEFORE it's ever created/sent ──
  // v20.32.26 — InspectionsPlusSheet creates + sends an order in one atomic
  // call (there's no draft id to preview beforehand, unlike the Repair
  // Consult flow). This endpoint takes the exact same payload shape as the
  // create endpoint above, resolves pricing the identical way, and renders
  // the identical email via buildInspectionOrderEmailHtml — but never
  // touches the database. Safe to call repeatedly while the agent is still
  // filling out the form.
  app.post("/api/inspection-orders/preview-draft", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not signed in" });
    const {
      clientName, clientEmail, propertyAddress, neededBy, neededByDate,
      contingencyExpirationDate, itemKeys, vendorId, subjectSqft, dealSide,
    } = req.body || {};
    if (!propertyAddress || !String(propertyAddress).trim()) return res.status(400).json({ error: "propertyAddress is required" });
    if (!Array.isArray(itemKeys) || itemKeys.length === 0) return res.status(400).json({ error: "Select at least one inspection" });

    const resolvedVendorId = vendorId ? Number(vendorId) : null;
    const resolvedSqft = subjectSqft ? Number(subjectSqft) : null;
    const hasHi = itemKeys.includes("hi");
    const catalog = rawDb.prepare(`SELECT * FROM inspection_items WHERE active = 1`).all() as any[];
    const byKey = new Map(catalog.map(c => [c.key, c]));

    const draftItems: { name: string; client_price: number; is_addon: boolean }[] = [];
    let total = 0;
    for (const key of itemKeys) {
      const cat = byKey.get(key);
      if (!cat) continue;
      const context: "standalone" | "bundled_with_hi" = hasHi && BUNDLABLE_WITH_HI_KEYS.has(key) ? "bundled_with_hi" : "standalone";
      const tier = resolveInspectionPricing(resolvedVendorId, key, context, resolvedSqft);
      const clientPrice = tier ? tier.clientPrice : cat.client_price;
      draftItems.push({ name: cat.name, client_price: clientPrice, is_addon: false });
      total += clientPrice;
    }

    const fakeOrder = {
      property_address: String(propertyAddress).trim(),
      client_name: (clientName || "").trim() || "there",
      needed_by: neededBy === "specific" ? "specific" : "asap",
      needed_by_date: neededBy === "specific" ? (neededByDate || null) : null,
      contingency_expiration_date: contingencyExpirationDate || null,
      total,
      sign_token: null,
      deal_side: dealSide === "seller" ? "seller" : "buyer",
    };
    const emailHtml = buildInspectionOrderEmailHtml(fakeOrder, draftItems, { preview: true });

    res.json({
      order: {
        propertyAddress: fakeOrder.property_address, clientName: fakeOrder.client_name,
        neededBy: fakeOrder.needed_by, neededByDate: fakeOrder.needed_by_date,
        contingencyExpirationDate: fakeOrder.contingency_expiration_date,
        status: "draft", total: fakeOrder.total,
        acceptedSignatureName: null, acceptedAt: null,
        clientEmail: clientEmail || null,
        dealSide: fakeOrder.deal_side,
      },
      items: draftItems.map(it => ({ name: it.name, clientPrice: it.client_price, isAddon: it.is_addon })),
      terms: INSPECTION_TERMS,
      emailHtml,
      emailSubject: `Inspections+ Order — ${fakeOrder.property_address}`,
    });
  });

  // ── Agent: my recent orders (resume/history) — MUST be before "/:id" ──
  app.get("/api/inspection-orders/mine", (req: any, res: Response) => {
    const agentId = parseInt(req.query.agentId as string) || req.currentAgent?.id || null;
    if (!agentId) return res.json({ orders: [] });
    const rows = rawDb.prepare(`
      SELECT id, property_address, client_name, status, total, updated_at, created_at
      FROM inspection_orders WHERE agent_id = ? ORDER BY created_at DESC LIMIT 30
    `).all(agentId);
    res.json({ orders: rows });
  });

  // ── Agent: fetch one order (id + items) to hydrate the wizard / detail view ──
  app.get("/api/inspection-orders/:id", (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const order = getOrderRow(id);
    if (!order) return res.status(404).json({ error: "Not found" });
    res.json({ order, items: getOrderItems(id) });
  });

  // ── Agent: send the order to the client (generates/reuses sign token) ──
  app.post("/api/inspection-orders/:id/send", async (req: any, res: Response) => {
    const id = parseInt(req.params.id);
    const order = getOrderRow(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.client_email) return res.status(400).json({ error: "This client has no email on file — add one before sending." });
    try {
      await sendInspectionOrderToClient(id);
      res.json({ ok: true, signToken: order.sign_token });
    } catch (err: any) {
      console.error("send inspection order error:", err);
      res.status(500).json({ error: "Failed to send order", detail: err?.message });
    }
  });

  // ── Preview exactly what the client will receive — email + approval page ──
  // v20.32.25 — mirrors the repair-consult preview endpoint. Returns the same
  // data shape /api/inspection-order/:token uses plus the rendered email HTML,
  // built via buildInspectionOrderEmailHtml() so there is zero drift from the
  // real send path.
  app.get("/api/inspection-orders/:id/preview", (req: any, res: Response) => {
    if (!req.currentAgent) return res.status(401).json({ error: "Not signed in" });
    const id = parseInt(req.params.id);
    const order = getOrderRow(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = getOrderItems(id).filter((i: any) => !i.is_addon || i.addon_status === "signed");
    const emailItems = getOrderItems(id).filter((i: any) => !i.is_addon);
    const emailHtml = buildInspectionOrderEmailHtml(order, emailItems, { preview: true });
    res.json({
      order: {
        propertyAddress: order.property_address, clientName: order.client_name,
        neededBy: order.needed_by, neededByDate: order.needed_by_date,
        contingencyExpirationDate: order.contingency_expiration_date,
        status: order.status, total: order.total,
        acceptedSignatureName: order.accepted_signature_name, acceptedAt: order.accepted_at,
        clientEmail: order.client_email || null,
        dealSide: order.deal_side === "seller" ? "seller" : "buyer",
      },
      items: items.map((it: any) => ({ name: it.name, clientPrice: it.client_price, isAddon: !!it.is_addon })),
      terms: INSPECTION_TERMS,
      emailHtml,
      emailSubject: `Inspections+ Order — ${order.property_address}`,
    });
  });

  // ── Public: client fetches order by token ──
  app.get("/api/inspection-order/:token", (req: any, res: Response) => {
    const order = getOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = getOrderItems(order.id).filter((i: any) => !i.is_addon || i.addon_status === "signed");
    res.json({
      order: {
        propertyAddress: order.property_address, clientName: order.client_name,
        neededBy: order.needed_by, neededByDate: order.needed_by_date,
        contingencyExpirationDate: order.contingency_expiration_date,
        status: order.status, total: order.total,
        acceptedSignatureName: order.accepted_signature_name, acceptedAt: order.accepted_at,
        dealSide: order.deal_side === "seller" ? "seller" : "buyer",
      },
      items: items.map((i: any) => ({ name: i.name, clientPrice: i.client_price, isAddon: !!i.is_addon })),
      terms: INSPECTION_TERMS,
    });
  });

  // ── Public: single-stage e-sign — flips straight to 'accepted', no countersign ──
  app.post("/api/inspection-order/:token/accept", async (req: any, res: Response) => {
    const order = getOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status === "accepted") return res.status(409).json({ error: "This order has already been approved." });
    if (order.status === "declined") return res.status(409).json({ error: "This order was declined. Contact us to reopen it." });
    const { signatureName } = req.body || {};
    if (!signatureName || String(signatureName).trim().length < 2) return res.status(400).json({ error: "Full name required to sign" });
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    rawDb.prepare(`
      UPDATE inspection_orders SET status = 'accepted', accepted_at = datetime('now'),
        accepted_signature_name = ?, accepted_ip = ?, updated_at = datetime('now') WHERE id = ?
    `).run(String(signatureName).trim(), ip, order.id);
    try { await sendInspectionOrderAcceptedInternal(order.id); } catch (e) { console.error("inspection accepted email failed:", e); }
    try { await sendWiringInstructionsToClient(order.id); } catch (e) { console.error("inspection wiring instructions email failed:", e); }
    // v20.32.13 Part 4 — milestone task: confirm inspection scheduling
    fireMilestoneTasks("inspection_scheduled", {
      personId: order.fub_contact_id ? Number(order.fub_contact_id) : null,
      clientName: order.client_name, clientPhone: order.client_phone, clientEmail: order.client_email,
      contextNote: `Inspection order approved — ${order.property_address}`,
    }).catch((e) => console.warn("milestone fire failed (inspection_scheduled):", e));
    res.json({ ok: true });
  });

  // ── Public: decline ──
  app.post("/api/inspection-order/:token/decline", (req: any, res: Response) => {
    const order = getOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const { reason } = req.body || {};
    rawDb.prepare(`
      UPDATE inspection_orders SET status = 'declined', declined_at = datetime('now'),
        decline_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(reason || null, order.id);
    res.json({ ok: true });
  });

  // ── ADD-ONS (mirrors Repair Change Orders exactly: request -> office-approve -> client sign) ──

  // Agent/admin requests an add-on for an already-sent/accepted order.
  app.post("/api/inspection-orders/:id/addons", async (req: any, res: Response) => {
    const orderId = parseInt(req.params.id);
    const order = getOrderRow(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const { itemKey, customName, reason } = req.body || {};
    if (!itemKey && (!customName || !String(customName).trim())) {
      return res.status(400).json({ error: "Select a catalog item or enter a custom service name" });
    }
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: "A reason is required" });
    let name = customName ? String(customName).trim() : "";
    let clientPrice = 0; let vendorCost: number | null = null;
    if (itemKey) {
      const cat = rawDb.prepare(`SELECT * FROM inspection_items WHERE key = ? AND active = 1`).get(itemKey) as any;
      if (cat) { name = cat.name; clientPrice = cat.client_price; vendorCost = cat.vendor_cost; }
    }
    if (req.body.clientPrice !== undefined) clientPrice = Number(req.body.clientPrice) || 0;
    try {
      const result = rawDb.prepare(`
        INSERT INTO inspection_order_items
          (order_id, item_key, name, client_price, vendor_cost, is_addon, addon_status, addon_reason, addon_requested_by_agent_id, addon_requested_at)
        VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, datetime('now'))
      `).run(orderId, itemKey || `custom-${Date.now()}`, name, clientPrice, vendorCost, String(reason).trim(), req.currentAgent?.id || null);
      const id = Number(result.lastInsertRowid);
      try { await sendAddonRequestedInternal(id); } catch (e) { console.error("addon requested email failed:", e); }
      res.json({ ok: true, id });
    } catch (err: any) {
      console.error("create inspection addon error:", err);
      res.status(500).json({ error: "Failed to create add-on", detail: err?.message });
    }
  });

  app.get("/api/inspection-orders/:id/addons", (req: any, res: Response) => {
    const orderId = parseInt(req.params.id);
    const rows = rawDb.prepare(`SELECT * FROM inspection_order_items WHERE order_id = ? AND is_addon = 1 ORDER BY id DESC`).all(orderId);
    res.json({ addons: rows });
  });

  // Admin: queue of all pending add-ons across every order.
  app.get("/api/admin/inspection-addons", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`
      SELECT ii.*, io.property_address, io.client_name, a.name AS requested_by_name
      FROM inspection_order_items ii
      JOIN inspection_orders io ON io.id = ii.order_id
      LEFT JOIN agents a ON a.id = ii.addon_requested_by_agent_id
      WHERE ii.is_addon = 1
      ORDER BY ii.addon_requested_at DESC LIMIT 200
    `).all();
    res.json({ addons: rows });
  });

  // Admin office-approve: generates the client sign token + emails it.
  app.post("/api/admin/inspection-addons/:id/office-approve", async (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = parseInt(req.params.id);
    const addon = getAddonRow(id);
    if (!addon) return res.status(404).json({ error: "Add-on not found" });
    if (addon.addon_status !== "pending") return res.status(409).json({ error: `Add-on is already ${addon.addon_status}` });
    const token = randomBytes(20).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    rawDb.prepare(`
      UPDATE inspection_order_items SET addon_status = 'office_approved', addon_decided_at = datetime('now'),
        addon_decided_by = ?, addon_sign_token = ?, addon_sign_token_expires_at = ? WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", token, expires, id);
    try { await sendAddonSignEmail(id); } catch (e) { console.error("addon sign email failed:", e); }
    res.json({ ok: true, signToken: token });
  });

  app.post("/api/admin/inspection-addons/:id/decline", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = parseInt(req.params.id);
    const addon = getAddonRow(id);
    if (!addon) return res.status(404).json({ error: "Add-on not found" });
    if (addon.addon_status !== "pending") return res.status(409).json({ error: `Add-on is already ${addon.addon_status}` });
    const { reason } = req.body || {};
    rawDb.prepare(`
      UPDATE inspection_order_items SET addon_status = 'declined', addon_decided_at = datetime('now'),
        addon_decided_by = ?, addon_decline_reason = ? WHERE id = ?
    `).run(req.currentAgent.name || req.currentAgent.email || "Admin", reason || null, id);
    res.json({ ok: true });
  });

  // Public: fetch add-on by sign token.
  app.get("/api/inspection-addon/:token", (req: any, res: Response) => {
    const addon = getAddonByToken(req.params.token);
    if (!addon) return res.status(404).json({ error: "Add-on not found" });
    const order = getOrderRow(addon.order_id);
    res.json({
      addon: {
        name: addon.name, clientPrice: addon.client_price, status: addon.addon_status,
        signedAt: addon.addon_signed_at, signatureName: addon.addon_signature_name,
      },
      order: { propertyAddress: order?.property_address, clientName: order?.client_name, currentTotal: order?.total },
    });
  });

  // Public: client e-signs the add-on -> folds into order total.
  app.post("/api/inspection-addon/:token/sign", async (req: any, res: Response) => {
    const addon = getAddonByToken(req.params.token);
    if (!addon) return res.status(404).json({ error: "Add-on not found" });
    if (addon.addon_status === "signed") return res.status(409).json({ error: "This add-on has already been signed." });
    if (addon.addon_status !== "office_approved") return res.status(409).json({ error: "This add-on is not ready to sign." });
    if (addon.addon_sign_token_expires_at && new Date(addon.addon_sign_token_expires_at) < new Date()) {
      return res.status(410).json({ error: "This sign link has expired — ask your Brothers Group contact to resend it." });
    }
    const { signatureName } = req.body || {};
    if (!signatureName || String(signatureName).trim().length < 2) return res.status(400).json({ error: "Full name required to sign" });
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    try {
      rawDb.prepare(`
        UPDATE inspection_order_items SET addon_status = 'signed', addon_signed_at = datetime('now'),
          addon_signature_name = ?, addon_signed_ip = ? WHERE id = ?
      `).run(String(signatureName).trim(), ip, addon.id);
      recalcOrderTotals(addon.order_id);
      try { await sendAddonSignedInternal(addon.id); } catch (e) { console.error("addon signed email failed:", e); }
      const updated = getOrderRow(addon.order_id);
      res.json({ ok: true, newTotal: updated.total });
    } catch (err: any) {
      console.error("sign inspection addon error:", err);
      res.status(500).json({ error: "Failed to sign add-on", detail: err?.message });
    }
  });

  // ── Admin: orders queue + mark completed (final invoice = signed items sum) ──
  app.get("/api/admin/inspection-orders", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const rows = rawDb.prepare(`
      SELECT io.*, a.name AS agent_name FROM inspection_orders io
      LEFT JOIN agents a ON a.id = io.agent_id ORDER BY io.created_at DESC LIMIT 200
    `).all();
    res.json({ orders: rows });
  });

  app.post("/api/admin/inspection-orders/:id/complete", (req: any, res: Response) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = parseInt(req.params.id);
    const order = getOrderRow(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    recalcOrderTotals(id);
    rawDb.prepare(`UPDATE inspection_orders SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
    const updated = getOrderRow(id);
    const profit = (updated.total || 0) - (updated.vendor_cost_total || 0);
    // v20.32.13 Part 4 — milestone task: follow up on inspection results
    fireMilestoneTasks("inspection_completed", {
      personId: updated.fub_contact_id ? Number(updated.fub_contact_id) : null,
      clientName: updated.client_name, clientPhone: updated.client_phone, clientEmail: updated.client_email,
      contextNote: `Inspection completed — ${updated.property_address}`,
    }).catch((e) => console.warn("milestone fire failed (inspection_completed):", e));
    // v20.32.13 Part 4/7 — completion = the final invoice (total is now the
    // signed items sum); fires a separate payment-due reminder alongside the
    // results follow-up above.
    fireMilestoneTasks("invoice_sent", {
      personId: updated.fub_contact_id ? Number(updated.fub_contact_id) : null,
      clientName: updated.client_name, clientPhone: updated.client_phone, clientEmail: updated.client_email,
      contextNote: `Final invoice ready ($${(updated.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}) — ${updated.property_address}`,
    }).catch((e) => console.warn("milestone fire failed (invoice_sent):", e));
    res.json({ ok: true, finalInvoiceTotal: updated.total, vendorCostTotal: updated.vendor_cost_total, profit });
  });
}
