// v14.3 — Manual CSV/XLSX import from BatchLeads UI export.
// v14.5 — Also handles LandVoice CSV exports (auto-detected by column headers).
// Bypasses the broken /property API by letting admins upload the file
// downloaded from BatchLeads → Export to Excel or LandVoice CSV download.
//
// BatchLeads columns (xlsx export, "SELECT ALL" preset):
//   First Name, Last Name, Property Address, Property City, Property State,
//   Property Zip, Property County, Email, Estimated Value, Last Sale Price,
//   Year Built, Bedroom Count, Bathroom Count, Total Building Area Square Feet,
//   Lot Size Square Feet, Mls Status, Mls Listing Amount, Mls Listing Date,
//   Batchrank Score Category, Phone 1..5, Phone 1..5 DNC, Phone 1..5 TYPE, List
//
// LandVoice columns (CSV, listing/expired export):
//   Address, City, State, Zip, First Name, Last Name, Primary Phone,
//   Secondary Phone, Email, Price, Beds, Baths, Square Footage, Parcel Number,
//   Lot Size, LandvoiceContact1..4FirstName/LastName/Phone/DNC, LandvoiceOwnerEmail

import * as XLSX from "xlsx";
import { computeUnifiedScore } from "../shared/scoring";

interface ImportRow {
  ownerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county: string | null;
  email: string;
  phone: string;              // primary (Phone 1 digits-only, last 10)
  allPhones: string[];        // all Phone 1..5 digits-only
  phoneStates: Record<string, string>;
  leadType: "expired" | "absentee";
  score: number;              // 0-100
  listPrice: number | null;
  lastSalePrice: number | null;
  assessedValue: number | null;
  lotSizeAcres: number | null;
  yearPurchased: number | null;
}

// Map "Lead Depot - Expired - Nassau" → { leadType, county }
function parseListName(name: string | null): { leadType: "expired" | "absentee" | null; county: string | null } {
  if (!name) return { leadType: null, county: null };
  const n = String(name).trim().toLowerCase();
  if (!n.startsWith("lead depot -")) return { leadType: null, county: null };
  let leadType: "expired" | "absentee" | null = null;
  if (/expired/.test(n)) leadType = "expired";
  else if (/absentee/.test(n)) leadType = "absentee";
  // county after second dash
  const parts = n.split("-").map(s => s.trim());
  let county: string | null = null;
  if (parts.length >= 3) {
    const c = parts[2];
    if (c.includes("nassau")) county = "Nassau";
    else if (c.includes("duval")) county = "Duval";
    else if (c.includes("john")) county = "St. Johns";
  }
  return { leadType, county };
}

function normalizePhone(raw: any): string {
  if (raw === null || raw === undefined) return "";
  const d = String(raw).replace(/\D/g, "");
  if (d.length < 10) return "";
  return d.slice(-10);
}

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function scoreCategoryToNumber(cat: any): number {
  const c = String(cat || "").toLowerCase();
  if (c === "high") return 85;
  if (c === "medium") return 65;
  if (c === "low") return 45;
  return 50;
}

// Zip → County map for NE FL (Nassau/Duval/St. Johns). Used for LandVoice which
// doesn't include a county column. Any zip not listed falls back to Duval
// (dominant county for LandVoice Duval-focused pulls).
const NEFL_ZIP_TO_COUNTY: Record<string, string> = {};
// Nassau county zips
for (const z of ["32009", "32011", "32034", "32035", "32041", "32046", "32097"]) NEFL_ZIP_TO_COUNTY[z] = "Nassau";
// St. Johns county zips
for (const z of ["32080", "32081", "32082", "32084", "32085", "32086", "32092", "32095", "32137", "32145", "32259"]) NEFL_ZIP_TO_COUNTY[z] = "St. Johns";
// Duval county zips (Jacksonville metro)
for (const z of ["32099", "32202", "32203", "32204", "32205", "32206", "32207", "32208", "32209", "32210", "32211", "32212", "32214", "32216", "32217", "32218", "32219", "32220", "32221", "32222", "32223", "32224", "32225", "32226", "32227", "32228", "32233", "32234", "32244", "32246", "32250", "32254", "32256", "32257", "32258", "32266", "32277"]) NEFL_ZIP_TO_COUNTY[z] = "Duval";

function inferCountyFromZip(zip: string): string | null {
  const z = zip.trim().slice(0, 5);
  return NEFL_ZIP_TO_COUNTY[z] || null;
}

// Detect which format we're looking at by examining the header row keys.
function detectFormat(sampleRow: any): "batchleads" | "landvoice" | "unknown" {
  if (!sampleRow || typeof sampleRow !== "object") return "unknown";
  const keys = Object.keys(sampleRow);
  if (keys.some(k => k.startsWith("Landvoice"))) return "landvoice";
  if (keys.includes("Batchrank Score Category") || keys.includes("Property Address")) return "batchleads";
  return "unknown";
}

function parseLandVoiceRow(r: any): ImportRow | null {
  // Collect phones: Primary, Secondary, then Landvoice Contact 1..4 (each has DNC).
  const allPhones: string[] = [];
  const phoneStates: Record<string, string> = {};
  const addPhone = (raw: any) => {
    const p = normalizePhone(raw);
    if (p && !allPhones.includes(p)) {
      allPhones.push(p);
      phoneStates[p] = "untried";
    }
  };
  addPhone(r["Primary Phone"]);
  addPhone(r["Secondary Phone"]);
  for (let i = 1; i <= 4; i++) addPhone(r[`LandvoiceContact${i}Phone`]);

  const primary = allPhones[0] || "";
  if (!primary) return null;

  const firstName = String(r["First Name"] || r["LandvoiceOwnerFirstName"] || "").trim();
  const lastName = String(r["Last Name"] || r["LandvoiceOwnerLastName"] || "").trim();
  const ownerName = [firstName, lastName].filter(Boolean).join(" ").trim() || "Unknown";

  const address = String(r["Address"] || r["Property Address"] || "").trim();
  if (!address) return null;

  // LandVoice has two "City" columns (property + owner mailing). sheet_to_json will
  // dedupe to a single key; we use whichever survives, then fall back to Duval-area default.
  const city = String(r["City"] || r["Property City"] || "").trim();
  const state = String(r["State"] || "FL").trim();
  const zip = String(r["Zip"] || r["Postal Code"] || "").split("-")[0].trim();
  const county = inferCountyFromZip(zip);

  const email = String(r["Email"] || r["LandvoiceOwnerEmail"] || "").trim();
  const listPrice = toNum(r["Price"]);
  // LandVoice doesn't give assessed value or last sale price directly.
  const assessedValue = null;
  const lastSalePrice = null;
  const lotSizeAcres = toNum(r["Lot Size"]);

  const unified = computeUnifiedScore({
    phoneCount: allPhones.length,
    hasEmail: !!email,
    listPrice,
    assessedValue,
    yearPurchased: null,
    lotSizeAcres,
    sourceRating: null,
    leadType: "expired",
  });

  return {
    ownerName,
    address,
    city,
    state,
    zip,
    county,
    email,
    phone: primary,
    allPhones,
    phoneStates,
    leadType: "expired",  // LandVoice = expired only
    score: unified.score,
    listPrice,
    lastSalePrice,
    assessedValue,
    lotSizeAcres,
    yearPurchased: null,
  };
}

export function parseBatchLeadsFile(buffer: Buffer): ImportRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

  if (rows.length === 0) return [];

  const format = detectFormat(rows[0]);
  console.log(`[Import] Detected format: ${format} (${rows.length} rows)`);

  if (format === "landvoice") {
    const out: ImportRow[] = [];
    for (const r of rows) {
      const row = parseLandVoiceRow(r);
      if (row) out.push(row);
    }
    return out;
  }

  // Fall through to BatchLeads path below.
  // (Original BatchLeads loop follows.)

  const out: ImportRow[] = [];

  for (const r of rows) {
    const listName: string = String(r["List"] || "").trim();
    const { leadType, county } = parseListName(listName);
    if (!leadType) continue; // skip rows we don't recognize

    // Collect all phones 1..5
    const allPhones: string[] = [];
    const phoneStates: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      const p = normalizePhone(r[`Phone ${i}`]);
      if (p && !allPhones.includes(p)) {
        allPhones.push(p);
        phoneStates[p] = "untried";
      }
    }

    const primary = allPhones[0] || "";
    if (!primary) continue; // require at least one phone to be dial-able

    const firstName = String(r["First Name"] || "").trim();
    const lastName = String(r["Last Name"] || "").trim();
    const ownerName = [firstName, lastName].filter(Boolean).join(" ").trim() || "Unknown";

    const address = String(r["Property Address"] || "").trim();
    const city = String(r["Property City"] || "").trim();
    const state = String(r["Property State"] || "FL").trim();
    const zip = String(r["Property Zip"] || "").split("-")[0].trim();
    const countyRaw = String(r["Property County"] || "").trim();
    const finalCounty = county || (countyRaw ? countyRaw : null);

    if (!address) continue;

    const email = String(r["Email"] || "").trim();
    const listPrice = toNum(r["Mls Listing Amount"]);
    const assessedValue = toNum(r["Estimated Value"]) || toNum(r["Total Assessed Value"]);
    const lastSalePrice = toNum(r["Last Sale Price"]);
    const lotSizeSqFt = toNum(r["Lot Size Square Feet"]);
    const lotSizeAcres = lotSizeSqFt !== null ? Math.round((lotSizeSqFt / 43560) * 100) / 100 : null;

    // Parse Last Sale Date for year_purchased
    let yearPurchased: number | null = null;
    const saleDate = String(r["Last Sale Date"] || "");
    const yearMatch = saleDate.match(/\d{4}/);
    if (yearMatch) yearPurchased = Number(yearMatch[0]);

    // Map BatchLeads "Batchrank Score Category" → sourceRating for the unified scorer.
    const cat = String(r["Batchrank Score Category"] || "").toLowerCase();
    const sourceRating: "high" | "medium" | "low" | null =
      cat === "high" ? "high" : cat === "medium" ? "medium" : cat === "low" ? "low" : null;

    const unified = computeUnifiedScore({
      phoneCount: allPhones.length,
      hasEmail: !!email,
      listPrice,
      assessedValue,
      yearPurchased,
      lotSizeAcres,
      sourceRating,
      leadType,
    });

    out.push({
      ownerName,
      address,
      city,
      state,
      zip,
      county: finalCounty,
      email,
      phone: primary,
      allPhones,
      phoneStates,
      leadType,
      score: unified.score,
      listPrice,
      lastSalePrice,
      assessedValue,
      lotSizeAcres,
      yearPurchased,
    });
  }

  return out;
}

// Insert rows into DB. Returns stats.
export function insertImportedLeads(rawDb: any, rows: ImportRow[]): {
  inserted: number;
  skippedDuplicate: number;
  byType: Record<string, number>;
  byCounty: Record<string, number>;
} {
  // Dedup: build existing phone set
  const existingPhones = new Set<string>();
  const existingAddresses = new Set<string>();
  const existing = rawDb.prepare(`SELECT phone, phones, address FROM leads`).all() as any[];
  for (const l of existing) {
    if (l.phone) existingPhones.add(String(l.phone).replace(/\D/g, "").slice(-10));
    if (l.phones) {
      try {
        const arr: string[] = JSON.parse(l.phones);
        for (const p of arr) existingPhones.add(String(p).replace(/\D/g, "").slice(-10));
      } catch {}
    }
    if (l.address) existingAddresses.add(String(l.address).toLowerCase().replace(/[^a-z0-9]/g, ""));
  }

  const insertStmt = rawDb.prepare(`
    INSERT OR IGNORE INTO leads (
      owner_name, address, city, state, zip, county,
      phone, phones, phone_states, email,
      lead_type, status, score,
      list_price, assessed_value, last_sale_price, lot_size_acres, year_purchased,
      source, batch_id, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, ?, ?, ?, ?, 'batchleads_csv', ?, datetime('now'))
  `);

  const batchId = `batchleads_csv_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  let inserted = 0;
  let skippedDuplicate = 0;
  const byType: Record<string, number> = {};
  const byCounty: Record<string, number> = {};

  const tx = rawDb.transaction((items: ImportRow[]) => {
    for (const r of items) {
      const addrKey = r.address.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (existingPhones.has(r.phone) || existingAddresses.has(addrKey)) {
        skippedDuplicate++;
        continue;
      }
      const result = insertStmt.run(
        r.ownerName, r.address, r.city, r.state, r.zip, r.county,
        r.phone, JSON.stringify(r.allPhones), JSON.stringify(r.phoneStates), r.email,
        r.leadType, r.score,
        r.listPrice, r.assessedValue, r.lastSalePrice, r.lotSizeAcres, r.yearPurchased,
        batchId,
      );
      if (result.changes > 0) {
        inserted++;
        byType[r.leadType] = (byType[r.leadType] || 0) + 1;
        if (r.county) byCounty[r.county] = (byCounty[r.county] || 0) + 1;
        // add to dedup sets so subsequent rows in same batch dedupe correctly
        existingPhones.add(r.phone);
        existingAddresses.add(addrKey);
      } else {
        skippedDuplicate++;
      }
    }
  });

  tx(rows);

  return { inserted, skippedDuplicate, byType, byCounty };
}
