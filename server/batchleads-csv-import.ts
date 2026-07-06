// v14.3 — Manual CSV/XLSX import from BatchLeads UI export.
// Bypasses the broken /property API by letting admins upload the file
// downloaded from BatchLeads → Export to Excel.
//
// Expected columns (BatchLeads xlsx export, "SELECT ALL" preset):
//   First Name, Last Name, Property Address, Property City, Property State,
//   Property Zip, Property County, Email, Estimated Value, Last Sale Price,
//   Year Built, Bedroom Count, Bathroom Count, Total Building Area Square Feet,
//   Lot Size Square Feet, Mls Status, Mls Listing Amount, Mls Listing Date,
//   Batchrank Score Category, Phone 1..5, Phone 1..5 DNC, Phone 1..5 TYPE, List

import * as XLSX from "xlsx";

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

export function parseBatchLeadsFile(buffer: Buffer): ImportRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

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
    const lotSizeSqFt = toNum(r["Lot Size Square Feet"]);
    const lotSizeAcres = lotSizeSqFt !== null ? Math.round((lotSizeSqFt / 43560) * 100) / 100 : null;

    // Parse Last Sale Date for year_purchased
    let yearPurchased: number | null = null;
    const saleDate = String(r["Last Sale Date"] || "");
    const yearMatch = saleDate.match(/\d{4}/);
    if (yearMatch) yearPurchased = Number(yearMatch[0]);

    const score = scoreCategoryToNumber(r["Batchrank Score Category"]);

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
      score,
      listPrice,
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
      list_price, assessed_value, lot_size_acres, year_purchased,
      source, batch_id, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, ?, ?, ?, 'batchleads_csv', ?, datetime('now'))
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
        r.listPrice, r.assessedValue, r.lotSizeAcres, r.yearPurchased,
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
