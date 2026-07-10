// v14.74 — Unified LandVoice + BatchLeads CSV/XLSX parser.
//
// Supports three LandVoice export shapes plus the legacy BatchLeads xlsx:
//   1. LandVoice SkipTraced listing / Custom Uploads listing
//        Address, City, State, Zip, First Name, Last Name, Primary Phone,
//        Secondary Phone, Email, Price, Beds, Baths, Square Footage,
//        Parcel Number, Lot Size, Property Address, City, State, Postal Code,
//        LandvoiceContact1..4FirstName/MiddleName/LastName/Phone/DNC,
//        LandvoiceOwnerFirstName/LastName/Street/City/State/Zip/Email,
//        LandvoiceOwnerXProfile/LinkedinProfile, LandvoiceNotes, LandvoiceTags
//
//   2. LandVoice Expired listing (real "Expired" export)
//        LandvoiceID, Date, MLSNumber, Status, OwnerOccupied, OwnerStreet,
//        OwnerCity, OwnerState, OwnerZip, OwnerName, OwnerFirstName,
//        OwnerMiddleName, OwnerLastName, OwnerPhone, OwnerPhoneDNC, OwnerEmail,
//        MlsOwnerInfo, MlsOwnerPhone, PropertyStreet, PropertyHouseNumber,
//        PropertyStreetName, PropertyUnitNumber, PropertyCity, PropertyState,
//        PropertyZip, Price, Type, Bedrooms, Bathrooms, SquareFeet, YearBuilt,
//        Acreage, OwnerAgent, Relisted, Remarks, DOM, StatusDate, ListAgent,
//        ListAgentPhone, ListOffice, TaxId, OwnerHouseNumber, OwnerStreetName,
//        Contact1..4 + Contact1..4FirstName/MiddleName/LastName + Phone1..4 + DNC1..4,
//        Notes, Tags
//
//   3. BatchLeads xlsx (legacy — kept working for archive uploads)
//
// Every row's full structured intel is preserved on leads.extra_data JSON so
// AgentView can render MLS #, DOM, remarks, DNC flags, list agent, and rank
// each phone with its owner name.

import * as XLSX from "xlsx";
import { computeUnifiedScore } from "../shared/scoring";

export interface PhoneMeta {
  number: string;
  dnc: boolean;
  rank: number;      // 1 = primary/best, higher = fallback
  role: string;      // "primary" | "secondary" | "landvoice-contact1..4" | "owner" | "contact1..4" | "mls-owner"
  personName?: string;
}

export interface ImportRow {
  ownerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county: string | null;
  email: string;
  phone: string;              // primary (digits-only, last 10)
  allPhones: string[];        // all phones digits-only, dedup, in rank order
  phoneStates: Record<string, string>;
  leadType: "expired" | "absentee";
  score: number;
  listPrice: number | null;
  lastSalePrice: number | null;
  assessedValue: number | null;
  lotSizeAcres: number | null;
  yearPurchased: number | null;
  extra: Record<string, any>; // → leads.extra_data JSON
}

// Map "Lead Depot - Expired - Nassau" → { leadType, county }
function parseListName(name: string | null): { leadType: "expired" | "absentee" | null; county: string | null } {
  if (!name) return { leadType: null, county: null };
  const n = String(name).trim().toLowerCase();
  if (!n.startsWith("lead depot -")) return { leadType: null, county: null };
  let leadType: "expired" | "absentee" | null = null;
  if (/expired/.test(n)) leadType = "expired";
  else if (/absentee/.test(n)) leadType = "absentee";
  const parts = n.split("-").map(s => s.trim());
  let county: string | null = null;
  if (parts.length >= 3) {
    const c = parts[2];
    if (c.includes("nassau")) county = "Nassau";
    else if (c.includes("duval")) county = "Duval";
    else if (c.includes("john")) county = "St Johns";
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

function truthy(v: any): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1" || s === "do not call" || s === "dnc";
}

// Zip → County map for NE FL (Nassau/Duval/St. Johns).
const NEFL_ZIP_TO_COUNTY: Record<string, string> = {};
for (const z of ["32009", "32011", "32034", "32035", "32041", "32046", "32097"]) NEFL_ZIP_TO_COUNTY[z] = "Nassau";
for (const z of ["32080", "32081", "32082", "32084", "32085", "32086", "32092", "32095", "32137", "32145", "32259"]) NEFL_ZIP_TO_COUNTY[z] = "St Johns";
for (const z of ["32099", "32202", "32203", "32204", "32205", "32206", "32207", "32208", "32209", "32210", "32211", "32212", "32214", "32216", "32217", "32218", "32219", "32220", "32221", "32222", "32223", "32224", "32225", "32226", "32227", "32228", "32233", "32234", "32244", "32246", "32250", "32254", "32256", "32257", "32258", "32266", "32277"]) NEFL_ZIP_TO_COUNTY[z] = "Duval";

function inferCountyFromZip(zip: string): string | null {
  const z = (zip || "").trim().slice(0, 5);
  return NEFL_ZIP_TO_COUNTY[z] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

export type CsvFormat = "landvoice-listing" | "landvoice-expired" | "batchleads" | "unknown";

export function detectFormat(sampleRow: any): CsvFormat {
  if (!sampleRow || typeof sampleRow !== "object") return "unknown";
  const keys = Object.keys(sampleRow);
  // Expired export: has LandvoiceID + Phone1 + Contact1FirstName (no Landvoice prefix).
  const hasExpiredCols = keys.includes("LandvoiceID") && keys.includes("MLSNumber") &&
                        (keys.includes("Phone1") || keys.includes("Contact1FirstName"));
  if (hasExpiredCols) return "landvoice-expired";
  // Listing/SkipTraced export: has LandvoiceContact1Phone or LandvoiceOwnerFirstName.
  if (keys.some(k => k.startsWith("LandvoiceContact") || k.startsWith("LandvoiceOwner"))) return "landvoice-listing";
  if (keys.includes("Batchrank Score Category") || keys.includes("Property Address")) return "batchleads";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDVOICE LISTING / SKIP-TRACED
// ─────────────────────────────────────────────────────────────────────────────

function parseLandVoiceListingRow(r: any): ImportRow | null {
  // XLSX.utils.sheet_to_json disambiguates duplicate column headers by suffixing "_1",
  // "_2" etc. LandVoice listing files have two "City", "State" columns (property + owner mailing).
  // The FIRST occurrence keeps the plain name (property = "Address"/"City"/"State"/"Zip"),
  // the SECOND is suffixed. Property Address column arrives as "Property Address" (unique).
  const phones: PhoneMeta[] = [];
  const addPhone = (raw: any, opts: { rank: number; role: string; dnc?: boolean; personName?: string }) => {
    const p = normalizePhone(raw);
    if (!p) return;
    if (phones.some(x => x.number === p)) return;
    phones.push({ number: p, dnc: !!opts.dnc, rank: opts.rank, role: opts.role, personName: opts.personName });
  };

  // Rank 1..2: seller's own Primary/Secondary (rarely populated in skip-traced).
  addPhone(r["Primary Phone"], { rank: 1, role: "primary", personName: `${r["First Name"] || ""} ${r["Last Name"] || ""}`.trim() });
  addPhone(r["Secondary Phone"], { rank: 2, role: "secondary" });

  // Rank 3..6: LandVoice contacts 1..4 (skip-trace matches, each with DNC + name).
  for (let i = 1; i <= 4; i++) {
    const first = r[`LandvoiceContact${i}FirstName`] || "";
    const last = r[`LandvoiceContact${i}LastName`] || "";
    const personName = [first, last].filter(Boolean).join(" ").trim();
    addPhone(r[`LandvoiceContact${i}Phone`], {
      rank: 2 + i,
      role: `landvoice-contact${i}`,
      dnc: truthy(r[`LandvoiceContact${i}DNC`]),
      personName,
    });
  }

  // v14.74 — Prefer first non-DNC phone as primary. If EVERY phone is DNC we
  // skip the lead: the platform is a phone-first dialer, and shipping non-dialable
  // leads only clutters the shared pool (they'd get purged to dead_lines within
  // 24h anyway). LandVoice pricing already assumes callable phones — all-DNC
  // rows are dead intel.
  const primary = phones.find(p => !p.dnc);
  if (!primary) return null;

  const propAddress = String(r["Property Address"] || r["Address"] || "").trim();
  if (!propAddress) return null;

  // Column-order rule: "Address, City, State, Zip" (property) appears BEFORE the second block.
  // sheet_to_json preserves first key. So r["City"] is property city, r["City_1"] would be owner mailing.
  const propCity = String(r["City"] || "").trim();
  const propState = String(r["State"] || "FL").trim();
  const propZip = String(r["Zip"] || r["Postal Code"] || "").split("-")[0].trim();

  const ownerFirst = String(r["LandvoiceOwnerFirstName"] || r["First Name"] || "").trim();
  const ownerLast = String(r["LandvoiceOwnerLastName"] || r["Last Name"] || "").trim();
  const ownerName = [ownerFirst, ownerLast].filter(Boolean).join(" ").trim() || "Unknown";

  const ownerStreet = String(r["LandvoiceOwnerStreet"] || "").trim();
  const ownerMailCity = String(r["LandvoiceOwnerCity"] || r["City_1"] || "").trim();
  const ownerMailState = String(r["LandvoiceOwnerState"] || r["State_1"] || "").trim();
  const ownerMailZip = String(r["LandvoiceOwnerZip"] || "").trim();

  const email = String(r["Email"] || r["LandvoiceOwnerEmail"] || "").trim();
  const listPrice = toNum(r["Price"]);
  const lotSizeAcres = toNum(r["Lot Size"]);
  const beds = toNum(r["Beds"]);
  const baths = toNum(r["Baths"]);
  const sqft = toNum(r["Square Footage"]);
  const parcelId = String(r["Parcel Number"] || "").trim();

  // Owner-occupied heuristic: same street on property + mailing.
  const ownerOccupied = ownerStreet && propAddress
    ? propAddress.toLowerCase().replace(/[^a-z0-9]/g, "") === ownerStreet.toLowerCase().replace(/[^a-z0-9]/g, "")
    : null;

  const extra: Record<string, any> = {
    source: "landvoice-listing",
    parcelId: parcelId || null,
    beds, baths, sqft, lotSizeAcres,
    listPrice,
    ownerOccupied,
    ownerMailing: (ownerStreet || ownerMailCity) ? {
      street: ownerStreet || null,
      city: ownerMailCity || null,
      state: ownerMailState || null,
      zip: ownerMailZip || null,
    } : null,
    ownerLinkedIn: String(r["LandvoiceOwnerLinkedinProfile"] || "").trim() || null,
    ownerX: String(r["LandvoiceOwnerXProfile"] || "").trim() || null,
    notes: String(r["LandvoiceNotes"] || "").trim() || null,
    tags: String(r["LandvoiceTags"] || "").trim() || null,
    phoneMeta: phones,
  };

  const county = inferCountyFromZip(propZip);
  const unified = computeUnifiedScore({
    phoneCount: phones.length,
    hasEmail: !!email,
    listPrice,
    assessedValue: null,
    yearPurchased: null,
    lotSizeAcres,
    sourceRating: null,
    leadType: "expired",
  });

  const allPhones = phones.map(p => p.number);
  const phoneStates: Record<string, string> = {};
  // v14.74 — ALL phones start "untried". DNC is metadata (phoneMeta[].dnc, shown
  // as a badge in AgentView), not a state-machine state. Downstream only handles
  // untried|tried|no_answer_today|struck.
  // v14.74 — DNC phones start as "struck" (never dialed, purged to dead_lines
  // within 24h by the struck-phone sweep). Non-DNC phones start "untried".
  // DNC info also persists in extra.phoneMeta so the UI can render the badge.
  for (const p of phones) phoneStates[p.number] = p.dnc ? "struck" : "untried";

  return {
    ownerName,
    address: propAddress,
    city: propCity,
    state: propState,
    zip: propZip,
    county,
    email,
    phone: primary.number,
    allPhones,
    phoneStates,
    leadType: "expired",
    score: unified.score,
    listPrice,
    lastSalePrice: null,
    assessedValue: null,
    lotSizeAcres,
    yearPurchased: null,
    extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDVOICE EXPIRED
// ─────────────────────────────────────────────────────────────────────────────

function parseLandVoiceExpiredRow(r: any): ImportRow | null {
  const phones: PhoneMeta[] = [];
  const addPhone = (raw: any, opts: { rank: number; role: string; dnc?: boolean; personName?: string }) => {
    const p = normalizePhone(raw);
    if (!p) return;
    if (phones.some(x => x.number === p)) return;
    phones.push({ number: p, dnc: !!opts.dnc, rank: opts.rank, role: opts.role, personName: opts.personName });
  };

  const ownerFirst = String(r["OwnerFirstName"] || "").trim();
  const ownerLast = String(r["OwnerLastName"] || "").trim();
  const ownerFullFromName = String(r["OwnerName"] || "").trim();
  const ownerName = [ownerFirst, ownerLast].filter(Boolean).join(" ").trim() || ownerFullFromName || "Unknown";

  // Rank 1: OwnerPhone (with its own DNC flag).
  addPhone(r["OwnerPhone"], {
    rank: 1,
    role: "owner",
    dnc: truthy(r["OwnerPhoneDNC"]),
    personName: ownerName !== "Unknown" ? ownerName : undefined,
  });

  // Rank 2: MlsOwnerPhone (phone listed with MLS).
  addPhone(r["MlsOwnerPhone"], {
    rank: 2,
    role: "mls-owner",
    personName: String(r["MlsOwnerInfo"] || "").trim() || undefined,
  });

  // Rank 3..6: Contact1..4 with DNC1..4.
  for (let i = 1; i <= 4; i++) {
    const first = r[`Contact${i}FirstName`] || "";
    const last = r[`Contact${i}LastName`] || "";
    const personName = [first, last].filter(Boolean).join(" ").trim() ||
      String(r[`Contact${i}`] || "").trim();
    addPhone(r[`Phone${i}`], {
      rank: 2 + i,
      role: `contact${i}`,
      dnc: truthy(r[`DNC${i}`]),
      personName,
    });
  }

  // v14.74 — Prefer first non-DNC phone as primary. If EVERY phone is DNC we
  // skip the lead: the platform is a phone-first dialer, and shipping non-dialable
  // leads only clutters the shared pool (they'd get purged to dead_lines within
  // 24h anyway). LandVoice pricing already assumes callable phones — all-DNC
  // rows are dead intel.
  const primary = phones.find(p => !p.dnc);
  if (!primary) return null;

  const propStreet = String(r["PropertyStreet"] || "").trim();
  if (!propStreet) return null;

  const propCity = String(r["PropertyCity"] || "").trim();
  const propState = String(r["PropertyState"] || "FL").trim();
  const propZip = String(r["PropertyZip"] || "").split("-")[0].trim();

  const ownerStreet = String(r["OwnerStreet"] || "").trim();
  const ownerMailCity = String(r["OwnerCity"] || "").trim();
  const ownerMailState = String(r["OwnerState"] || "").trim();
  const ownerMailZip = String(r["OwnerZip"] || "").trim();

  const email = String(r["OwnerEmail"] || "").trim();
  const listPrice = toNum(r["Price"]);
  const beds = toNum(r["Bedrooms"]);
  const baths = toNum(r["Bathrooms"]);
  const sqft = toNum(r["SquareFeet"]);
  const yearBuilt = toNum(r["YearBuilt"]);
  const acreage = toNum(r["Acreage"]);
  const mlsNumber = String(r["MLSNumber"] || "").trim();
  const mlsStatus = String(r["Status"] || "").trim();     // Withdrawn, Expired, etc.
  const daysOnMarket = toNum(r["DOM"]);
  const statusDate = String(r["StatusDate"] || "").trim();
  const listAgent = String(r["ListAgent"] || "").trim();
  const listAgentPhone = normalizePhone(r["ListAgentPhone"]);
  const listOffice = String(r["ListOffice"] || "").trim();
  const remarks = String(r["Remarks"] || "").trim();
  const relisted = truthy(r["Relisted"]);
  const ownerAgent = truthy(r["OwnerAgent"]);
  const ownerOccupied = truthy(r["OwnerOccupied"]);
  const parcelId = String(r["TaxId"] || "").trim();

  const extra: Record<string, any> = {
    source: "landvoice-expired",
    mlsNumber: mlsNumber || null,
    mlsStatus: mlsStatus || null,
    daysOnMarket,
    statusDate: statusDate || null,
    listAgent: listAgent || null,
    listAgentPhone: listAgentPhone || null,
    listOffice: listOffice || null,
    remarks: remarks || null,
    relisted,
    ownerIsAgent: ownerAgent,
    ownerOccupied,
    parcelId: parcelId || null,
    beds, baths, sqft,
    yearBuilt,
    acreage,
    listPrice,
    ownerMailing: (ownerStreet || ownerMailCity) ? {
      street: ownerStreet || null,
      city: ownerMailCity || null,
      state: ownerMailState || null,
      zip: ownerMailZip || null,
    } : null,
    notes: String(r["Notes"] || "").trim() || null,
    tags: String(r["Tags"] || "").trim() || null,
    phoneMeta: phones,
  };

  const county = inferCountyFromZip(propZip);
  const unified = computeUnifiedScore({
    phoneCount: phones.length,
    hasEmail: !!email,
    listPrice,
    assessedValue: null,
    yearPurchased: null,
    lotSizeAcres: acreage,
    sourceRating: null,
    leadType: "expired",
  });

  const allPhones = phones.map(p => p.number);
  const phoneStates: Record<string, string> = {};
  // v14.74 — ALL phones start "untried". DNC is metadata (phoneMeta[].dnc, shown
  // as a badge in AgentView), not a state-machine state. Downstream only handles
  // untried|tried|no_answer_today|struck.
  // v14.74 — DNC phones start as "struck" (never dialed, purged to dead_lines
  // within 24h by the struck-phone sweep). Non-DNC phones start "untried".
  // DNC info also persists in extra.phoneMeta so the UI can render the badge.
  for (const p of phones) phoneStates[p.number] = p.dnc ? "struck" : "untried";

  return {
    ownerName,
    address: propStreet,
    city: propCity,
    state: propState,
    zip: propZip,
    county,
    email,
    phone: primary.number,
    allPhones,
    phoneStates,
    leadType: "expired",
    score: unified.score,
    listPrice,
    lastSalePrice: null,
    assessedValue: null,
    lotSizeAcres: acreage,
    yearPurchased: null,
    extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHLEADS (legacy)
// ─────────────────────────────────────────────────────────────────────────────

function parseBatchLeadsRow(r: any): ImportRow | null {
  const listName: string = String(r["List"] || "").trim();
  const { leadType, county } = parseListName(listName);
  if (!leadType) return null;

  const phones: PhoneMeta[] = [];
  for (let i = 1; i <= 5; i++) {
    const p = normalizePhone(r[`Phone ${i}`]);
    if (!p || phones.some(x => x.number === p)) continue;
    phones.push({
      number: p,
      dnc: truthy(r[`Phone ${i} DNC`]),
      rank: i,
      role: `phone${i}`,
    });
  }
  // v14.74 — Prefer first non-DNC phone as primary. If EVERY phone is DNC we
  // skip the lead: the platform is a phone-first dialer, and shipping non-dialable
  // leads only clutters the shared pool (they'd get purged to dead_lines within
  // 24h anyway). LandVoice pricing already assumes callable phones — all-DNC
  // rows are dead intel.
  const primary = phones.find(p => !p.dnc);
  if (!primary) return null;

  const firstName = String(r["First Name"] || "").trim();
  const lastName = String(r["Last Name"] || "").trim();
  const ownerName = [firstName, lastName].filter(Boolean).join(" ").trim() || "Unknown";

  const address = String(r["Property Address"] || "").trim();
  if (!address) return null;

  const city = String(r["Property City"] || "").trim();
  const state = String(r["Property State"] || "FL").trim();
  const zip = String(r["Property Zip"] || "").split("-")[0].trim();
  const countyRaw = String(r["Property County"] || "").trim();
  const finalCounty = county || (countyRaw ? countyRaw : null);

  const email = String(r["Email"] || "").trim();
  const listPrice = toNum(r["Mls Listing Amount"]);
  const assessedValue = toNum(r["Estimated Value"]) || toNum(r["Total Assessed Value"]);
  const lastSalePrice = toNum(r["Last Sale Price"]);
  const lotSizeSqFt = toNum(r["Lot Size Square Feet"]);
  const lotSizeAcres = lotSizeSqFt !== null ? Math.round((lotSizeSqFt / 43560) * 100) / 100 : null;

  let yearPurchased: number | null = null;
  const saleDate = String(r["Last Sale Date"] || "");
  const yearMatch = saleDate.match(/\d{4}/);
  if (yearMatch) yearPurchased = Number(yearMatch[0]);

  const cat = String(r["Batchrank Score Category"] || "").toLowerCase();
  const sourceRating: "high" | "medium" | "low" | null =
    cat === "high" ? "high" : cat === "medium" ? "medium" : cat === "low" ? "low" : null;

  const unified = computeUnifiedScore({
    phoneCount: phones.length,
    hasEmail: !!email,
    listPrice, assessedValue, yearPurchased, lotSizeAcres,
    sourceRating, leadType,
  });

  const allPhones = phones.map(p => p.number);
  const phoneStates: Record<string, string> = {};
  // v14.74 — ALL phones start "untried". DNC is metadata (phoneMeta[].dnc, shown
  // as a badge in AgentView), not a state-machine state. Downstream only handles
  // untried|tried|no_answer_today|struck.
  // v14.74 — DNC phones start as "struck" (never dialed, purged to dead_lines
  // within 24h by the struck-phone sweep). Non-DNC phones start "untried".
  // DNC info also persists in extra.phoneMeta so the UI can render the badge.
  for (const p of phones) phoneStates[p.number] = p.dnc ? "struck" : "untried";

  return {
    ownerName,
    address, city, state, zip,
    county: finalCounty,
    email,
    phone: primary.number,
    allPhones,
    phoneStates,
    leadType,
    score: unified.score,
    listPrice,
    lastSalePrice,
    assessedValue,
    lotSizeAcres,
    yearPurchased,
    extra: {
      source: "batchleads",
      listName,
      phoneMeta: phones,
      mlsStatus: String(r["Mls Status"] || "").trim() || null,
      yearBuilt: toNum(r["Year Built"]),
      beds: toNum(r["Bedroom Count"]),
      baths: toNum(r["Bathroom Count"]),
      sqft: toNum(r["Total Building Area Square Feet"]),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────

export function parseBatchLeadsFile(buffer: Buffer): ImportRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (rows.length === 0) return [];

  const format = detectFormat(rows[0]);
  console.log(`[Import] Detected format: ${format} (${rows.length} rows)`);

  const out: ImportRow[] = [];
  let parser: (r: any) => ImportRow | null;
  if (format === "landvoice-listing") parser = parseLandVoiceListingRow;
  else if (format === "landvoice-expired") parser = parseLandVoiceExpiredRow;
  else if (format === "batchleads") parser = parseBatchLeadsRow;
  else return [];

  for (const r of rows) {
    try {
      const row = parser(r);
      if (row) out.push(row);
    } catch (err: any) {
      console.warn(`[Import] Skipping row due to parse error: ${err?.message || err}`);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERT
// ─────────────────────────────────────────────────────────────────────────────

export function insertImportedLeads(rawDb: any, rows: ImportRow[]): {
  inserted: number;
  skippedDuplicate: number;
  byType: Record<string, number>;
  byCounty: Record<string, number>;
} {
  // v14.75 — Address normalization that survives LandVoice re-export drift.
  // Real-world case: "123 Oak Street" vs "123 Oak St" vs "123 Oak St." all
  // point to the same parcel but hash to different keys under the naive
  // alnum-only scheme. We collapse common USPS suffixes to canonical stems,
  // strip punctuation, and drop the unit indicator so "#4" doesn't split.
  const SUFFIX_MAP: Record<string, string> = {
    street: "st", st: "st",
    avenue: "ave", ave: "ave", av: "ave",
    drive: "dr", dr: "dr",
    road: "rd", rd: "rd",
    boulevard: "blvd", blvd: "blvd",
    lane: "ln", ln: "ln",
    court: "ct", ct: "ct",
    circle: "cir", cir: "cir",
    place: "pl", pl: "pl",
    terrace: "ter", ter: "ter",
    parkway: "pkwy", pkwy: "pkwy",
    highway: "hwy", hwy: "hwy",
    trail: "trl", trl: "trl",
    way: "way",
    north: "n", n: "n",
    south: "s", s: "s",
    east: "e", e: "e",
    west: "w", w: "w",
  };
  const normalizeAddress = (raw: string): string => {
    if (!raw) return "";
    const cleaned = String(raw)
      .toLowerCase()
      .replace(/[.,#]/g, " ")           // periods, commas, unit '#' → space
      .replace(/\bapt\b|\bunit\b|\bste\b|\bsuite\b/g, " ") // strip unit words
      .replace(/\s+/g, " ")
      .trim();
    const tokens = cleaned.split(" ").map(t => SUFFIX_MAP[t] || t);
    return tokens.join("").replace(/[^a-z0-9]/g, "");
  };

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
    if (l.address) existingAddresses.add(normalizeAddress(l.address));
  }

  const insertStmt = rawDb.prepare(`
    INSERT OR IGNORE INTO leads (
      owner_name, address, city, state, zip, county,
      phone, phones, phone_states, email,
      lead_type, status, score,
      list_price, assessed_value, last_sale_price, lot_size_acres, year_purchased,
      source, batch_id, extra_data, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const batchId = `batchleads_csv_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  let inserted = 0;
  let skippedDuplicate = 0;
  const byType: Record<string, number> = {};
  const byCounty: Record<string, number> = {};

  const tx = rawDb.transaction((items: ImportRow[]) => {
    for (const r of items) {
      const addrKey = normalizeAddress(r.address);
      // v14.75 — Check ALL phones on the incoming row against existing pool,
      // not just the primary. LandVoice sometimes shuffles which contact is
      // "primary" between exports; we treat any shared phone as a match.
      const anyPhoneMatch = (r.allPhones || [r.phone]).some(p =>
        existingPhones.has(String(p).replace(/\D/g, "").slice(-10))
      );
      if (anyPhoneMatch || existingAddresses.has(addrKey)) {
        skippedDuplicate++;
        continue;
      }
      const sourceTag = r.extra?.source === "landvoice-expired" ? "landvoice_expired"
        : r.extra?.source === "landvoice-listing" ? "landvoice_listing"
        : "batchleads_csv";
      const result = insertStmt.run(
        r.ownerName, r.address, r.city, r.state, r.zip, r.county,
        r.phone, JSON.stringify(r.allPhones), JSON.stringify(r.phoneStates), r.email,
        r.leadType, r.score,
        r.listPrice, r.assessedValue, r.lastSalePrice, r.lotSizeAcres, r.yearPurchased,
        sourceTag, batchId, JSON.stringify(r.extra || {}),
      );
      if (result.changes > 0) {
        inserted++;
        byType[r.leadType] = (byType[r.leadType] || 0) + 1;
        if (r.county) byCounty[r.county] = (byCounty[r.county] || 0) + 1;
        // v14.75 — Seed ALL phones from this row so a later row in the same
        // CSV can't sneak in via a shared secondary.
        for (const p of (r.allPhones || [r.phone])) {
          existingPhones.add(String(p).replace(/\D/g, "").slice(-10));
        }
        existingAddresses.add(addrKey);
      } else {
        skippedDuplicate++;
      }
    }
  });

  tx(rows);
  return { inserted, skippedDuplicate, byType, byCounty };
}
