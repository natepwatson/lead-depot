// v20.4.9 — Weekly BGRE Workbook parser.
// Denise uploads a single .xlsx with 3 tabs:
//   Tab 1: Closed        (historical, ignored)
//   Tab 2: Sellers       (color-coded)
//     🔴 Red    = Expired         → skip
//     🟢 Green  = Closed this yr  → status='sold'
//     ⚪ White  = Active          → status='active'
//     🟡 Yellow = Signed/coming   → status='coming_soon'
//     🔵 Blue   = Pocket listing  → status='pocket'
//   Tab 3: Buyers        (color-coded)
//     🟢 Green  = Closed this yr  → status='closed'
//     ⚪ White  = On the hunt     → status='active'
//
// Uses ExcelJS because SheetJS community does not expose fill colors reliably.

import ExcelJS from "exceljs";
import { rawDb } from "./db";
import { parseIntent } from "./buyerIntentParser";

// Rough color buckets. ARGB hex from Excel fill.fgColor.argb.
// Excel default no-fill is undefined/null, treated as white.
function classifyColor(argb: string | undefined | null): "red"|"green"|"white"|"yellow"|"blue"|"unknown" {
  if (!argb) return "white";
  const hex = argb.toUpperCase().padStart(8, "0"); // AARRGGBB
  const r = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const b = parseInt(hex.slice(6, 8), 16);
  // Treat near-white as white
  if (r > 235 && g > 235 && b > 235) return "white";
  // Dominant channel heuristics
  const max = Math.max(r, g, b);
  if (max < 100) return "unknown"; // black-ish
  // Red: R dominates, G+B low
  if (r > 180 && g < 130 && b < 130) return "red";
  // Green: G dominates, and either R or B is not close to G
  if (g > 150 && g >= r && g >= b && (g - Math.min(r, b) > 40)) return "green";
  // Yellow: R and G both high, B low
  if (r > 200 && g > 180 && b < 150) return "yellow";
  // Blue: B dominates
  if (b > 150 && b >= r && b >= g && (b - Math.min(r, g) > 30)) return "blue";
  return "unknown";
}

// Normalize a header string to a canonical key
function normHeader(s: any): string {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Map many possible spellings → canonical field name
const SELLER_HEADER_MAP: Record<string, string> = {
  address: "address", property_address: "address", street: "address", street_address: "address",
  city: "city", state: "state", zip: "zip", zip_code: "zip", zipcode: "zip",
  list_price: "list_price", price: "list_price", asking: "list_price", asking_price: "list_price",
  listing_agent: "listing_agent", agent: "listing_agent", list_agent: "listing_agent",
  list_date: "list_date", listed: "list_date", listed_on: "list_date",
  mls: "mls_number", mls_number: "mls_number", mls_num: "mls_number",
  beds: "beds", bedrooms: "beds", br: "beds",
  baths: "baths", bathrooms: "baths", ba: "baths",
  sqft: "sqft", square_feet: "sqft", size: "sqft", heated: "sqft",
  notes: "notes", note: "notes", comments: "notes", memo: "notes",
  sold_date: "sold_date", closed_date: "sold_date", close_date: "sold_date",
  sold_price: "sold_price", close_price: "sold_price", closed_price: "sold_price",
  pending_date: "pending_date",
};

const BUYER_HEADER_MAP: Record<string, string> = {
  name: "name", buyer: "name", buyer_name: "name", client: "name", client_name: "name",
  phone: "phone", cell: "phone", mobile: "phone", phone_number: "phone",
  email: "email", email_address: "email",
  agent: "buyers_agent", buyers_agent: "buyers_agent", buyer_agent: "buyers_agent", assigned_agent: "buyers_agent",
  price: "price_max", budget: "price_max", max_price: "price_max", asking: "price_max",
  price_min: "price_min", min_price: "price_min", price_from: "price_min",
  price_max: "price_max", price_to: "price_max",
  area: "preferred_areas", areas: "preferred_areas", locations: "preferred_areas", preferred_areas: "preferred_areas",
  beds: "beds_min", bedrooms: "beds_min", min_beds: "beds_min",
  baths: "baths_min", bathrooms: "baths_min", min_baths: "baths_min",
  sqft: "sqft_min", min_sqft: "sqft_min",
  must_haves: "must_haves", must_have: "must_haves", requirements: "must_haves",
  no_gos: "no_gos", exclude: "no_gos", avoid: "no_gos",
  pre_approved: "pre_approved", pre_approval: "pre_approved", preapproved: "pre_approved",
  lender: "lender",
  timeline: "timeline", when: "timeline",
  notes: "notes", note: "notes", comments: "notes",
  closed_date: "closed_date", close_date: "closed_date",
  closed_address: "closed_address", address: "closed_address", closed_property: "closed_address",
  closed_price: "closed_price",
};

// Parse a dollar string like "$1,234,500" or "1.25M" → integer cents-less USD.
function parsePrice(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  const s = String(v).replace(/[$, ]/g, "").toLowerCase().trim();
  if (!s) return null;
  const m = s.match(/^([0-9.]+)\s*(k|m)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === "k") n *= 1000;
  if (m[2] === "m") n *= 1_000_000;
  return isFinite(n) ? Math.round(n) : null;
}

function parseInt2(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).replace(/[, ]/g, ""), 10);
  return isFinite(n) ? n : null;
}

function parseFloat2(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[, ]/g, ""));
  return isFinite(n) ? n : null;
}

function parseBool(v: any): number {
  if (v == null) return 0;
  const s = String(v).trim().toLowerCase();
  if (["1","y","yes","true","t","approved","pre-approved","preapproved"].includes(s)) return 1;
  return 0;
}

function toIsoDate(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m2) {
    let yr = m2[3]; if (yr.length === 2) yr = "20" + yr;
    return `${yr}-${m2[1].padStart(2,"0")}-${m2[2].padStart(2,"0")}`;
  }
  return null;
}

export type WorkbookParseResult = {
  sellers: { inserted: number; updated: number; skipped_red: number; skipped_other: number; buckets: Record<string, number> };
  buyers:  { inserted: number; updated: number; skipped: number; buckets: Record<string, number> };
  warnings: string[];
};

// Read a color-coded sheet. Determines dominant fill color per row.
function readSheetRows(sheet: ExcelJS.Worksheet, headerMap: Record<string, string>): Array<{ color: string; row: Record<string, any> }> {
  const results: Array<{ color: string; row: Record<string, any> }> = [];
  if (!sheet.rowCount) return results;

  // Find header row — first row where at least one cell text matches headerMap
  let headerRowIdx = 1;
  let headers: Record<number, string> = {};
  for (let r = 1; r <= Math.min(5, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const tmpHeaders: Record<number, string> = {};
    let hits = 0;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = normHeader(cell.value);
      const canonical = headerMap[key];
      if (canonical) { tmpHeaders[colNumber] = canonical; hits++; }
    });
    if (hits >= 2) { headerRowIdx = r; headers = tmpHeaders; break; }
  }
  if (!Object.keys(headers).length) return results;

  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row || row.cellCount === 0) continue;

    const rowData: Record<string, any> = {};
    let dominantColor = "white";
    const colorVotes: Record<string, number> = {};

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const canonical = headers[colNumber];
      if (canonical) rowData[canonical] = cell.value;

      // Sample fill color from this cell
      const fill = cell.fill as any;
      if (fill && fill.type === "pattern" && fill.fgColor) {
        const argb = fill.fgColor.argb;
        const c = classifyColor(argb);
        if (c !== "unknown") colorVotes[c] = (colorVotes[c] || 0) + 1;
      }
    });

    // Also check the whole-row fill (some sheets color the row not the cell)
    const rowFill = (row as any).fill;
    if (rowFill && rowFill.type === "pattern" && rowFill.fgColor) {
      const c = classifyColor(rowFill.fgColor.argb);
      if (c !== "unknown") colorVotes[c] = (colorVotes[c] || 0) + 3; // weight row fill higher
    }

    if (Object.keys(colorVotes).length) {
      dominantColor = Object.entries(colorVotes).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Only push if row has ANY data
    if (Object.values(rowData).some(v => v != null && v !== "")) {
      results.push({ color: dominantColor, row: rowData });
    }
  }
  return results;
}

// ─── SELLERS ────────────────────────────────────────────────
const COLOR_TO_SELLER_STATUS: Record<string, string | null> = {
  red:    null,           // skip
  green:  "sold",
  white:  "active",
  yellow: "coming_soon",
  blue:   "pocket",
};

// ─── BUYERS ─────────────────────────────────────────────────
const COLOR_TO_BUYER_STATUS: Record<string, string | null> = {
  red:    null,
  green:  "closed",
  white:  "active",
  yellow: "active",   // fallback — treat like white
  blue:   "active",
};

export async function parseWeeklyWorkbook(buf: Buffer, uploadedBy: string): Promise<WorkbookParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);

  const result: WorkbookParseResult = {
    sellers: { inserted: 0, updated: 0, skipped_red: 0, skipped_other: 0, buckets: {} },
    buyers:  { inserted: 0, updated: 0, skipped: 0, buckets: {} },
    warnings: [],
  };

  // Identify tabs. Prefer by name, fall back to positional (tab 2 = sellers, tab 3 = buyers).
  let sellersSheet: ExcelJS.Worksheet | null = null;
  let buyersSheet: ExcelJS.Worksheet | null = null;
  wb.eachSheet((sheet) => {
    const n = sheet.name.toLowerCase();
    if (n.includes("seller") && !sellersSheet) sellersSheet = sheet;
    else if (n.includes("buyer") && !buyersSheet) buyersSheet = sheet;
  });
  if (!sellersSheet && wb.worksheets.length >= 2) sellersSheet = wb.worksheets[1];
  if (!buyersSheet  && wb.worksheets.length >= 3) buyersSheet  = wb.worksheets[2];

  // ─── SELLERS ─────────────────────────────────────────────
  if (sellersSheet) {
    const rows = readSheetRows(sellersSheet, SELLER_HEADER_MAP);
    const upsert = rawDb.prepare(`
      INSERT INTO listings (
        address, city, state, zip, list_price, status, listing_agent,
        list_date, pending_date, sold_date, sold_price, mls_number, notes,
        beds, baths, sqft, uploaded_by, source, source_ref, created_at, updated_at
      ) VALUES (
        @address, @city, @state, @zip, @list_price, @status, @listing_agent,
        @list_date, @pending_date, @sold_date, @sold_price, @mls_number, @notes,
        @beds, @baths, @sqft, @uploaded_by, 'excel', @source_ref, datetime('now'), datetime('now')
      )
      ON CONFLICT(lower(address), coalesce(zip,'')) DO UPDATE SET
        list_price    = excluded.list_price,
        status        = excluded.status,
        listing_agent = excluded.listing_agent,
        list_date     = COALESCE(excluded.list_date, listings.list_date),
        pending_date  = COALESCE(excluded.pending_date, listings.pending_date),
        sold_date     = COALESCE(excluded.sold_date, listings.sold_date),
        sold_price    = COALESCE(excluded.sold_price, listings.sold_price),
        mls_number    = COALESCE(excluded.mls_number, listings.mls_number),
        notes         = excluded.notes,
        beds          = COALESCE(excluded.beds, listings.beds),
        baths         = COALESCE(excluded.baths, listings.baths),
        sqft          = COALESCE(excluded.sqft, listings.sqft),
        source        = 'excel',
        source_ref    = excluded.source_ref,
        updated_at    = datetime('now')
      RETURNING id
    `);

    for (let i = 0; i < rows.length; i++) {
      const { color, row } = rows[i];
      result.sellers.buckets[color] = (result.sellers.buckets[color] || 0) + 1;
      const status = COLOR_TO_SELLER_STATUS[color];
      if (!status) {
        if (color === "red") result.sellers.skipped_red++;
        else result.sellers.skipped_other++;
        continue;
      }
      const address = String(row.address || "").trim();
      if (!address) { result.sellers.skipped_other++; continue; }

      try {
        const info = upsert.run({
          address,
          city:          row.city ? String(row.city).trim() : null,
          state:         row.state ? String(row.state).trim() : null,
          zip:           row.zip ? String(row.zip).trim() : null,
          list_price:    parsePrice(row.list_price),
          status,
          listing_agent: row.listing_agent ? String(row.listing_agent).trim() : null,
          list_date:     toIsoDate(row.list_date),
          pending_date:  toIsoDate(row.pending_date),
          sold_date:     status === "sold" ? (toIsoDate(row.sold_date) || new Date().toISOString().slice(0,10)) : null,
          sold_price:    status === "sold" ? parsePrice(row.sold_price || row.list_price) : null,
          mls_number:    row.mls_number ? String(row.mls_number).trim() : null,
          notes:         row.notes ? String(row.notes).trim() : null,
          beds:          parseInt2(row.beds),
          baths:         parseFloat2(row.baths),
          sqft:          parseInt2(row.sqft),
          uploaded_by:   uploadedBy,
          source_ref:    `workbook:sellers:r${i + 2}`,
        });
        if ((info as any).changes) {
          // heuristic: RETURNING id — but better-sqlite3 doesn't give us insert-vs-update.
          // Track via updated_at == created_at? For now, count all as inserted+updated combined.
          result.sellers.inserted++;
        }
      } catch (e) {
        result.warnings.push(`Sellers row ${i + 2} (${address}): ${(e as Error).message}`);
      }
    }
  } else {
    result.warnings.push("Sellers tab not found");
  }

  // ─── BUYERS ──────────────────────────────────────────────
  if (buyersSheet) {
    const rows = readSheetRows(buyersSheet, BUYER_HEADER_MAP);

    // v20.5.0: Track (name+ordinal) so a repeat buyer with two rows on the same
    // sheet gets ordinal=1 and ordinal=2 (Alex's Q1 rule: same name, different
    // intent = two rows). Same-name Rank #2 gets a new row, not an overwrite.
    const nameOrdinal = new Map<string, number>();
    function nextOrdinal(name: string): number {
      const key = name.toLowerCase().trim();
      const cur = nameOrdinal.get(key) || 0;
      const next = cur + 1;
      nameOrdinal.set(key, next);
      return next;
    }

    const upsert = rawDb.prepare(`
      INSERT INTO buyers (
        name, phone, email, buyers_agent, status,
        price_min, price_max, preferred_areas, zip_codes,
        beds_min, baths_min, sqft_min,
        land_acres_min, lot_width_min, arv_min, arv_max,
        must_haves, no_gos, pre_approved, lender, timeline,
        closed_date, closed_address, closed_price,
        notes, intent_phrases,
        intent_property_types, intent_conditions, intent_verbs,
        financing, is_investor, is_rental, rental_type,
        confidence, origin_sources, multi_search_ordinal,
        source, source_ref, last_updated_by, created_at, updated_at
      ) VALUES (
        @name, @phone, @email, @buyers_agent, @status,
        @price_min, @price_max, @preferred_areas, @zip_codes,
        @beds_min, @baths_min, @sqft_min,
        @land_acres_min, @lot_width_min, @arv_min, @arv_max,
        @must_haves, @no_gos, @pre_approved, @lender, @timeline,
        @closed_date, @closed_address, @closed_price,
        @notes, @intent_phrases,
        @intent_property_types, @intent_conditions, @intent_verbs,
        @financing, @is_investor, @is_rental, @rental_type,
        @confidence, @origin_sources, @multi_search_ordinal,
        'excel', @source_ref, @last_updated_by, datetime('now'), datetime('now')
      )
      ON CONFLICT(lower(name), multi_search_ordinal) DO UPDATE SET
        phone            = COALESCE(excluded.phone, buyers.phone),
        email            = COALESCE(excluded.email, buyers.email),
        buyers_agent     = COALESCE(excluded.buyers_agent, buyers.buyers_agent),
        status           = CASE WHEN buyers.do_not_import = 1
                                THEN buyers.status
                                ELSE excluded.status END,
        price_min        = COALESCE(excluded.price_min, buyers.price_min),
        price_max        = COALESCE(excluded.price_max, buyers.price_max),
        preferred_areas  = COALESCE(excluded.preferred_areas, buyers.preferred_areas),
        zip_codes        = COALESCE(excluded.zip_codes, buyers.zip_codes),
        beds_min         = COALESCE(excluded.beds_min, buyers.beds_min),
        baths_min        = COALESCE(excluded.baths_min, buyers.baths_min),
        sqft_min         = COALESCE(excluded.sqft_min, buyers.sqft_min),
        land_acres_min   = COALESCE(excluded.land_acres_min, buyers.land_acres_min),
        lot_width_min    = COALESCE(excluded.lot_width_min, buyers.lot_width_min),
        arv_min          = COALESCE(excluded.arv_min, buyers.arv_min),
        arv_max          = COALESCE(excluded.arv_max, buyers.arv_max),
        must_haves       = COALESCE(excluded.must_haves, buyers.must_haves),
        no_gos           = COALESCE(excluded.no_gos, buyers.no_gos),
        pre_approved     = excluded.pre_approved,
        lender           = COALESCE(excluded.lender, buyers.lender),
        timeline         = COALESCE(excluded.timeline, buyers.timeline),
        closed_date      = COALESCE(excluded.closed_date, buyers.closed_date),
        closed_address   = COALESCE(excluded.closed_address, buyers.closed_address),
        closed_price     = COALESCE(excluded.closed_price, buyers.closed_price),
        notes            = COALESCE(excluded.notes, buyers.notes),
        intent_phrases   = COALESCE(excluded.intent_phrases, buyers.intent_phrases),
        intent_property_types = COALESCE(excluded.intent_property_types, buyers.intent_property_types),
        intent_conditions = COALESCE(excluded.intent_conditions, buyers.intent_conditions),
        intent_verbs     = COALESCE(excluded.intent_verbs, buyers.intent_verbs),
        financing        = COALESCE(excluded.financing, buyers.financing),
        is_investor      = excluded.is_investor,
        is_rental        = excluded.is_rental,
        rental_type      = COALESCE(excluded.rental_type, buyers.rental_type),
        confidence       = MAX(excluded.confidence, COALESCE(buyers.confidence, 0)),
        origin_sources   = excluded.origin_sources,
        source           = 'excel',
        source_ref       = excluded.source_ref,
        last_updated_by  = excluded.last_updated_by,
        updated_at       = datetime('now')
    `);

    // Read existing origin_sources so we can APPEND 'excel' instead of overwriting
    const readOriginStmt = rawDb.prepare(
      `SELECT origin_sources FROM buyers WHERE lower(name) = ? AND multi_search_ordinal = ?`
    );

    for (let i = 0; i < rows.length; i++) {
      const { color, row } = rows[i];
      result.buyers.buckets[color] = (result.buyers.buckets[color] || 0) + 1;
      const status = COLOR_TO_BUYER_STATUS[color];
      if (!status) { result.buyers.skipped++; continue; }

      const name = String(row.name || "").trim();
      if (!name) { result.buyers.skipped++; continue; }

      // v20.5.0: run intent parser on Denise's jumbled notes column
      const rawNotes = row.notes ? String(row.notes).trim() : "";
      const intent = parseIntent(rawNotes);

      // Assign multi-search ordinal (1 first, 2 second, etc. per name in this upload)
      const ordinal = nextOrdinal(name);

      // Merge origin_sources: existing (if any) UNION ['excel']
      let originSources: string[] = ["excel"];
      try {
        const existing = readOriginStmt.get(name.toLowerCase(), ordinal) as { origin_sources: string } | undefined;
        if (existing?.origin_sources) {
          const arr = JSON.parse(existing.origin_sources);
          if (Array.isArray(arr)) originSources = Array.from(new Set([...arr, "excel"]));
        }
      } catch { /* first sighting of this name+ordinal, keep ['excel'] */ }

      // Excel columns win when filled; intent parser fills the gaps
      const priceMin = parsePrice(row.price_min) ?? intent.price_min;
      const priceMax = parsePrice(row.price_max) ?? intent.price_max;
      const bedsMin  = parseInt2(row.beds_min)   ?? intent.beds_min;
      const bathsMin = parseFloat2(row.baths_min) ?? intent.baths_min;
      const sqftMin  = parseInt2(row.sqft_min)   ?? intent.sqft_min;
      const areas    = row.preferred_areas
                        ? String(row.preferred_areas).trim()
                        : (intent.areas.length ? intent.areas.join(", ") : null);

      try {
        upsert.run({
          name,
          phone:            row.phone ? String(row.phone).trim() : null,
          email:            row.email ? String(row.email).trim() : null,
          buyers_agent:     row.buyers_agent ? String(row.buyers_agent).trim() : null,
          status,
          price_min:        priceMin,
          price_max:        priceMax,
          preferred_areas:  areas,
          zip_codes:        intent.zip_codes.length ? intent.zip_codes.join(",") : null,
          beds_min:         bedsMin,
          baths_min:        bathsMin,
          sqft_min:         sqftMin,
          land_acres_min:   intent.land_acres_min,
          lot_width_min:    intent.lot_width_min,
          arv_min:          intent.arv_min,
          arv_max:          intent.arv_max,
          must_haves:       row.must_haves ? String(row.must_haves).trim() : null,
          no_gos:           row.no_gos ? String(row.no_gos).trim() : null,
          pre_approved:     parseBool(row.pre_approved),
          lender:           row.lender ? String(row.lender).trim() : null,
          timeline:         row.timeline ? String(row.timeline).trim() : null,
          closed_date:      status === "closed" ? (toIsoDate(row.closed_date) || new Date().toISOString().slice(0,10)) : null,
          closed_address:   status === "closed" ? (row.closed_address ? String(row.closed_address).trim() : null) : null,
          closed_price:     status === "closed" ? parsePrice(row.closed_price) : null,
          notes:            rawNotes || null,
          intent_phrases:        rawNotes ? JSON.stringify([rawNotes]) : null,
          intent_property_types: intent.property_types.length ? intent.property_types.join(",") : null,
          intent_conditions:     intent.conditions.length ? intent.conditions.join(",") : null,
          intent_verbs:          intent.verbs.length ? intent.verbs.join(",") : null,
          financing:        intent.financing,
          is_investor:      intent.is_investor ? 1 : 0,
          is_rental:        intent.is_rental ? 1 : 0,
          rental_type:      intent.rental_type,
          confidence:       intent.confidence,
          origin_sources:   JSON.stringify(originSources),
          multi_search_ordinal: ordinal,
          source_ref:       `workbook:buyers:r${i + 2}:ord${ordinal}`,
          last_updated_by:  uploadedBy,
        });
        result.buyers.inserted++;
      } catch (e) {
        result.warnings.push(`Buyers row ${i + 2} (${name}): ${(e as Error).message}`);
      }
    }
  } else {
    result.warnings.push("Buyers tab not found");
  }

  return result;
}
