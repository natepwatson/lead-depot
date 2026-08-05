// v20.6.9 — Universal ingestion pipeline.
//
// Every uploaded CSV/XLSX row — regardless of source — is normalized into the
// canonical ImportRow shape below and then merged into the leads table. The
// FULL original row is preserved on extra.raw so future field-mapper upgrades
// can retroactively surface columns without a re-upload (the /api/admin/leads
// /re-normalize endpoint walks this and upgrades legacy leads on deploy).
//
// Supports three LandVoice export shapes, the legacy BatchLeads xlsx, and
// falls back to a generic best-effort parser for anything else — so no upload
// is ever silently dropped.
//
// Known formats:
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

// v20.7.0 — Excel serial date normalizer.
//
// XLSX/CSV pipelines sometimes leak raw Excel date serials as numeric strings
// like "46191.208333333336" — these are days since 1899-12-30. Any date-shaped
// value >= 25569 (= 1970-01-01) is safe to convert. Anything else falls back
// to `new Date(v)` and finally the raw string.
//
// Returns ISO date shape "YYYY-MM-DD" when it can, otherwise the trimmed input.
export function normalizeDate(v: any): string | null {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  // Excel serial: pure numeric with fractional day component OR integer > 25569
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 25569 && asNum < 60000) {
    // Excel's epoch is 1899-12-30 (Lotus 1-2-3 leap year bug preserved).
    const ms = Math.round((asNum - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Fallback: JS Date parser handles "2026-07-10", "07/10/2026", ISO datetime.
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return raw;
}

// v20.7.0 — Owner-name normalizer for cross-property linking.
//
// Two owners with the SAME normalized key = same person (even if one row says
// "John Smith Jr" and another says "JOHN SMITH LLC" and a third says "Smith,
// John"). Powers the "Owner of N properties" badge on the LeadCard.
//
// Rules:
//   - Lowercase; strip punctuation to spaces; collapse whitespace
//   - Strip business/trust suffixes (LLC, INC, TRUST, ESTATE, PROPERTIES, LP, LLLP, HOLDINGS, GROUP, CO, CORP)
//   - Strip name suffixes (JR, SR, II, III, IV, V, MD, DDS, ESQ)
//   - Convert "LAST, FIRST" → "FIRST LAST" before returning
//   - Empty / unknown / '[object Object]' → null (never key on these)
export function normalizeOwnerName(name: any): string | null {
  if (name === null || name === undefined) return null;
  let s = String(name).trim();
  if (!s || /^\s*(unknown|n\/?a|none|null|undefined|\[object object\])\s*$/i.test(s)) return null;
  // "LAST, FIRST" swap (only when a single comma splits into two non-empty tokens)
  const commaParts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (commaParts.length === 2 && !/\d/.test(commaParts[0]) && !/\d/.test(commaParts[1])) {
    s = `${commaParts[1]} ${commaParts[0]}`;
  }
  s = s.toLowerCase()
       .replace(/[^a-z0-9\s]/g, " ")
       .replace(/\s+/g, " ")
       .trim();
  // Suffix stripping — walk tokens and drop matches
  const DROP = new Set([
    "llc", "inc", "corp", "co", "trust", "trustee", "estate", "holdings",
    "properties", "property", "group", "lp", "lllp", "pa", "pllc",
    "jr", "sr", "ii", "iii", "iv", "v", "md", "dds", "esq",
  ]);
  const tokens = s.split(" ").filter((t) => t && !DROP.has(t));
  const key = tokens.join(" ").trim();
  return key.length >= 2 ? key : null;
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

export type CsvFormat = "landvoice-listing" | "landvoice-expired" | "batchleads" | "generic" | "unknown";

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
  // v20.6.9 — Generic fallback: any row with SOME phone-ish + name-ish column
  // still ingests. We map best-effort and preserve the full raw row so nothing
  // is dropped.
  const hasNameish = keys.some(k => /name|owner/i.test(k));
  const hasPhoneish = keys.some(k => /phone|mobile|cell/i.test(k));
  const hasAddrish = keys.some(k => /address|property/i.test(k));
  if (hasNameish && hasPhoneish && hasAddrish) return "generic";
  return "unknown";
}

// v20.6.9 — Canonical column-name mapper. Any CSV row (regardless of source)
// is scanned for these keys — first non-empty match wins. Used by parseGenericRow
// and by the re-normalize backfill sweep. Order matters: more specific first.
const CANONICAL_FIELD_MAP: Record<string, string[]> = {
  ownerFirstName: ["OwnerFirstName", "First Name", "first_name", "firstName"],
  ownerLastName:  ["OwnerLastName", "Last Name", "last_name", "lastName"],
  ownerFullName:  ["Owner Name", "OwnerName", "Full Name", "ownerName", "name"],
  propAddress:    ["Property Address", "PropertyStreet", "Address", "address", "property_address"],
  propCity:       ["Property City", "PropertyCity", "City", "city"],
  propState:      ["Property State", "PropertyState", "State", "state"],
  propZip:        ["Property Zip", "PropertyZip", "Zip", "Postal Code", "zip", "postal_code"],
  propCounty:     ["Property County", "PropertyCounty", "County", "county"],
  primaryPhone:   ["Primary Phone", "OwnerPhone", "Phone", "Phone Number", "phone", "Mobile", "Cell"],
  secondaryPhone: ["Secondary Phone", "Phone 2", "Phone2"],
  email:          ["Email", "OwnerEmail", "email"],
  listPrice:      ["Price", "List Price", "Mls Listing Amount", "listPrice"],
  parcelId:       ["Parcel Number", "TaxId", "Parcel ID", "APN", "parcelId", "parcel_id"],
  mlsNumber:      ["MLSNumber", "MLS #", "MLS Number", "mlsNumber"],
  beds:           ["Bedrooms", "Beds", "Bedroom Count", "beds"],
  baths:          ["Bathrooms", "Baths", "Bathroom Count", "baths"],
  sqft:           ["SquareFeet", "Square Footage", "Total Building Area Square Feet", "sqft"],
  yearBuilt:      ["YearBuilt", "Year Built", "yearBuilt"],
  lotSizeAcres:   ["Acreage", "Lot Size Acres", "lot_size_acres"],
};

function pickFirst(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") return row[k];
  }
  return "";
}

// v20.6.9 — Which columns we know how to map. Used to compute UNKNOWN columns
// so admin sees what we're not surfacing.
function knownColumnSet(): Set<string> {
  const out = new Set<string>();
  for (const arr of Object.values(CANONICAL_FIELD_MAP)) for (const k of arr) out.add(k.toLowerCase());
  // Landvoice-specific columns we handle in dedicated parsers:
  for (const k of [
    "LandvoiceID", "Date", "Status", "OwnerOccupied", "OwnerStreet", "OwnerCity", "OwnerState",
    "OwnerZip", "MlsOwnerInfo", "MlsOwnerPhone", "OwnerHouseNumber", "OwnerStreetName",
    "PropertyHouseNumber", "PropertyStreetName", "PropertyUnitNumber", "OwnerAgent", "Relisted",
    "Remarks", "DOM", "StatusDate", "ListAgent", "ListAgentPhone", "ListOffice", "OwnerPhoneDNC",
    "OwnerMiddleName", "MlsOwnerFirstName", "MlsOwnerLastName",
    "Notes", "Tags", "Type", "List",
    "Batchrank Score Category", "Estimated Value", "Total Assessed Value", "Last Sale Price",
    "Last Sale Date", "Lot Size Square Feet", "Mls Status", "Mls Listing Amount",
  ]) out.add(k.toLowerCase());
  for (let i = 1; i <= 4; i++) {
    for (const suf of ["", "FirstName", "MiddleName", "LastName", "Phone", "DNC"]) {
      out.add(`landvoicecontact${i}${suf}`.toLowerCase());
      out.add(`contact${i}${suf}`.toLowerCase());
    }
    out.add(`phone${i}`.toLowerCase());
    out.add(`dnc${i}`.toLowerCase());
    out.add(`phone ${i}`.toLowerCase());
    out.add(`phone ${i} dnc`.toLowerCase());
  }
  for (const suf of ["FirstName", "MiddleName", "LastName", "Street", "City", "State", "Zip", "Email", "XProfile", "LinkedinProfile", "Notes", "Tags"]) {
    out.add(`landvoiceowner${suf}`.toLowerCase());
  }
  return out;
}
const KNOWN_COLUMNS = knownColumnSet();

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
    // v20.6.9 — Full raw row preserved for future re-normalize sweeps.
    raw: r,
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
  // v20.7.0 — normalizeDate rescues raw Excel serials (e.g. "46191.20833")
  // that used to leak through into the LISTING INTEL panel unchanged.
  const statusDate = normalizeDate(r["StatusDate"]);
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
    // v20.6.9 — Full raw row preserved for future re-normalize sweeps.
    raw: r,
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
      // v20.6.9 — Full raw row preserved for future re-normalize sweeps.
      raw: r,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// v20.6.9 — GENERIC FALLBACK PARSER. Any CSV format we haven't seen before
// still lands in the leads table. Best-effort canonical mapping via
// CANONICAL_FIELD_MAP; unmapped columns are preserved on extra.raw so a future
// parser upgrade can surface them via /api/admin/leads/re-normalize.
// ──────────────────────────────────────────────────────────────────────────

export function parseGenericRow(r: any): ImportRow | null {
  const first = String(pickFirst(r, CANONICAL_FIELD_MAP.ownerFirstName) || "").trim();
  const last  = String(pickFirst(r, CANONICAL_FIELD_MAP.ownerLastName) || "").trim();
  const full  = String(pickFirst(r, CANONICAL_FIELD_MAP.ownerFullName) || "").trim();
  const ownerName = full || [first, last].filter(Boolean).join(" ").trim() || "Unknown";

  const address = String(pickFirst(r, CANONICAL_FIELD_MAP.propAddress) || "").trim();
  if (!address) return null;

  const city  = String(pickFirst(r, CANONICAL_FIELD_MAP.propCity) || "").trim();
  const state = String(pickFirst(r, CANONICAL_FIELD_MAP.propState) || "FL").trim();
  const zip   = String(pickFirst(r, CANONICAL_FIELD_MAP.propZip) || "").split("-")[0].trim();
  const email = String(pickFirst(r, CANONICAL_FIELD_MAP.email) || "").trim();

  // Gather every phone-ish column value.
  const phones: PhoneMeta[] = [];
  const primary = normalizePhone(pickFirst(r, CANONICAL_FIELD_MAP.primaryPhone));
  if (primary) phones.push({ number: primary, dnc: false, rank: 1, role: "primary", personName: ownerName !== "Unknown" ? ownerName : undefined });
  const secondary = normalizePhone(pickFirst(r, CANONICAL_FIELD_MAP.secondaryPhone));
  if (secondary && !phones.some(p => p.number === secondary)) {
    phones.push({ number: secondary, dnc: false, rank: 2, role: "secondary" });
  }
  // Sweep for any other Phone-shaped column values.
  let rank = phones.length + 1;
  for (const k of Object.keys(r)) {
    if (!/phone|mobile|cell/i.test(k)) continue;
    if (CANONICAL_FIELD_MAP.primaryPhone.includes(k) || CANONICAL_FIELD_MAP.secondaryPhone.includes(k)) continue;
    const p = normalizePhone(r[k]);
    if (!p || phones.some(x => x.number === p)) continue;
    // Try to find a paired DNC column: same base name + "DNC" or " DNC".
    const dncKey1 = `${k} DNC`;
    const dncKey2 = `${k}DNC`;
    const dnc = truthy(r[dncKey1]) || truthy(r[dncKey2]);
    phones.push({ number: p, dnc, rank: rank++, role: k });
  }
  const primaryPhone = phones.find(p => !p.dnc);
  if (!primaryPhone) return null;

  const county = inferCountyFromZip(zip);
  const listPrice    = toNum(pickFirst(r, CANONICAL_FIELD_MAP.listPrice));
  const beds         = toNum(pickFirst(r, CANONICAL_FIELD_MAP.beds));
  const baths        = toNum(pickFirst(r, CANONICAL_FIELD_MAP.baths));
  const sqft         = toNum(pickFirst(r, CANONICAL_FIELD_MAP.sqft));
  const yearBuilt    = toNum(pickFirst(r, CANONICAL_FIELD_MAP.yearBuilt));
  const lotSizeAcres = toNum(pickFirst(r, CANONICAL_FIELD_MAP.lotSizeAcres));
  const parcelId     = String(pickFirst(r, CANONICAL_FIELD_MAP.parcelId) || "").trim();
  const mlsNumber    = String(pickFirst(r, CANONICAL_FIELD_MAP.mlsNumber) || "").trim();

  const extra: Record<string, any> = {
    source: "generic",
    parcelId: parcelId || null,
    mlsNumber: mlsNumber || null,
    beds, baths, sqft, yearBuilt, lotSizeAcres,
    listPrice,
    phoneMeta: phones,
    raw: r,
  };

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
  for (const p of phones) phoneStates[p.number] = p.dnc ? "struck" : "untried";

  return {
    ownerName,
    address,
    city,
    state,
    zip,
    county,
    email,
    phone: primaryPhone.number,
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
// PUBLIC ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────

// v20.6.9 — Result shape now includes format detected + unknown-column report.
export interface ParseResult {
  rows: ImportRow[];
  format: CsvFormat;
  unknownColumns: string[];
  rowCount: number;
}

export function parseBatchLeadsFile(buffer: Buffer): ImportRow[] {
  // Legacy signature kept for existing callers. Returns just the rows.
  return parseBatchLeadsFileWithReport(buffer).rows;
}

export function parseBatchLeadsFileWithReport(buffer: Buffer): ParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (rows.length === 0) return { rows: [], format: "unknown", unknownColumns: [], rowCount: 0 };

  const format = detectFormat(rows[0]);
  console.log(`[Import] Detected format: ${format} (${rows.length} rows)`);

  const out: ImportRow[] = [];
  let parser: ((r: any) => ImportRow | null) | null = null;
  if (format === "landvoice-listing") parser = parseLandVoiceListingRow;
  else if (format === "landvoice-expired") parser = parseLandVoiceExpiredRow;
  else if (format === "batchleads") parser = parseBatchLeadsRow;
  else if (format === "generic") parser = parseGenericRow;

  // Compute unknown columns — columns present in the file we don't have a canonical mapping for.
  const seenColumns = new Set<string>();
  for (const r of rows.slice(0, 5)) for (const k of Object.keys(r)) seenColumns.add(k);
  const unknownColumns: string[] = [];
  for (const c of seenColumns) if (!KNOWN_COLUMNS.has(c.toLowerCase())) unknownColumns.push(c);

  if (!parser) return { rows: [], format, unknownColumns, rowCount: rows.length };

  for (const r of rows) {
    try {
      const row = parser(r);
      if (row) out.push(row);
    } catch (err: any) {
      console.warn(`[Import] Skipping row due to parse error: ${err?.message || err}`);
    }
  }
  return { rows: out, format, unknownColumns, rowCount: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERT
// ─────────────────────────────────────────────────────────────────────────────

export function insertImportedLeads(rawDb: any, rows: ImportRow[]): {
  inserted: number;
  merged: number;
  skippedIdentical: number;
  skippedDuplicate: number;   // legacy alias = merged + skippedIdentical
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

  // v14.76 — Track BOTH phone → leadId and address → leadId. On a duplicate
  // hit we merge fresh CSV intel into the existing row rather than dropping it.
  const phoneToLead = new Map<string, number>();
  const addrToLead = new Map<string, number>();
  const existing = rawDb.prepare(`SELECT id, phone, phones, address FROM leads`).all() as any[];
  for (const l of existing) {
    if (l.phone) {
      const norm = String(l.phone).replace(/\D/g, "").slice(-10);
      if (norm && !phoneToLead.has(norm)) phoneToLead.set(norm, l.id);
    }
    if (l.phones) {
      try {
        const arr: string[] = JSON.parse(l.phones);
        for (const p of arr) {
          const norm = String(p).replace(/\D/g, "").slice(-10);
          if (norm && !phoneToLead.has(norm)) phoneToLead.set(norm, l.id);
        }
      } catch {}
    }
    if (l.address) {
      const norm = normalizeAddress(l.address);
      if (norm && !addrToLead.has(norm)) addrToLead.set(norm, l.id);
    }
  }

  const insertStmt = rawDb.prepare(`
    INSERT OR IGNORE INTO leads (
      owner_name, owner_name_key, address, city, state, zip, county,
      phone, phones, phone_states, email,
      lead_type, status, score,
      list_price, assessed_value, last_sale_price, lot_size_acres, year_purchased,
      source, batch_id, extra_data, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // v14.76 — UPDATE statement used on duplicate hit. We merge fresh CSV intel
  // into the existing lead row. Rules:
  //   • phones[]: UNION of existing + new (dedup by last-10 digits)
  //   • phoneStates: preserve existing state for existing phones; new phones
  //     start as untried unless DNC (then struck)
  //   • phone (primary): keep existing UNLESS existing phone is empty/DNC and
  //     new one is dialable, then upgrade
  //   • extra_data: shallow-merge, with CSV "MLS fields" (mlsNumber, mlsStatus,
  //     daysOnMarket, listPrice, listAgent, listAgentPhone, listOffice, remarks,
  //     statusDate, relisted) OVERWRITING the DB values — LandVoice is the
  //     source of truth for MLS state. Union phoneMeta so agent-facing intel
  //     accumulates instead of being replaced.
  //   • list_price column: overwrite if CSV has a fresher value.
  //   • NEVER touch: assigned_id, status, callback_date, notes, l_location,
  //     l_price, l_motivation, l_agent, l_mortgage, l_appointment, l_buyer,
  //     confirmed_address, stage, intention, source (network flag), or any
  //     agent-authored field. Those all get selected but not written.
  const updateStmt = rawDb.prepare(`
    UPDATE leads
       SET phones = ?, phone_states = ?, phone = ?,
           list_price = COALESCE(?, list_price),
           extra_data = ?,
           owner_name = COALESCE(NULLIF(?, ''), owner_name),
           owner_name_key = COALESCE(NULLIF(?, ''), owner_name_key)
     WHERE id = ?
  `);

  const MLS_FIELDS = [
    "mlsNumber", "mlsStatus", "daysOnMarket", "listPrice", "listAgent",
    "listAgentPhone", "listOffice", "remarks", "statusDate", "relisted",
    "beds", "baths", "sqft", "yearBuilt", "acreage", "parcelId",
    "ownerMailing", "ownerOccupied", "ownerIsAgent",
  ];

  const batchId = `batchleads_csv_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  let inserted = 0;
  let merged = 0;
  let skippedIdentical = 0;
  const byType: Record<string, number> = {};
  const byCounty: Record<string, number> = {};

  const tx = rawDb.transaction((items: ImportRow[]) => {
    for (const r of items) {
      const addrKey = normalizeAddress(r.address);
      const incomingNorms = (r.allPhones || [r.phone]).map(p => String(p).replace(/\D/g, "").slice(-10)).filter(Boolean);

      // Find matching existing lead ID (by any shared phone OR normalized addr).
      let matchId: number | null = null;
      for (const n of incomingNorms) {
        if (phoneToLead.has(n)) { matchId = phoneToLead.get(n)!; break; }
      }
      if (matchId == null && addrKey && addrToLead.has(addrKey)) {
        matchId = addrToLead.get(addrKey)!;
      }

      if (matchId != null) {
        // ---- MERGE PATH — fold new CSV intel into existing row ----
        const existingRow = rawDb.prepare(`
          SELECT phones, phone, phone_states, extra_data, list_price, owner_name
            FROM leads WHERE id = ?
        `).get(matchId) as any;
        if (!existingRow) { skippedIdentical++; continue; }

        // v20.6.9 — Owner-mismatch check. If existing lead has a real owner name
        // AND the incoming owner name differs meaningfully, flag the lead for
        // admin review (extra_data.mergeReview) but still merge phone data —
        // property may have changed hands, and admin should confirm via the
        // county tax record. We do NOT auto-replace the owner name in this
        // case; the UPDATE's COALESCE(NULLIF(...)) below preserves the DB name.
        const existingOwner = String(existingRow.owner_name || "").trim().toLowerCase();
        const incomingOwner = String(r.ownerName || "").trim().toLowerCase();
        const ownerMismatch = existingOwner && incomingOwner &&
                              existingOwner !== "unknown" && incomingOwner !== "unknown" &&
                              existingOwner !== incomingOwner &&
                              // Loose: don't flag if one is a prefix of the other (e.g. Smith vs Smith Jr).
                              !existingOwner.includes(incomingOwner) && !incomingOwner.includes(existingOwner);

        let existingPhonesArr: string[] = [];
        try { existingPhonesArr = JSON.parse(existingRow.phones || "[]"); } catch {}
        let existingStates: Record<string, string> = {};
        try { existingStates = JSON.parse(existingRow.phone_states || "{}"); } catch {}
        let existingExtra: any = {};
        try { existingExtra = JSON.parse(existingRow.extra_data || "{}"); } catch {}

        // Union phones (dedup on last-10 digits, preserve existing order first).
        const seen = new Set<string>();
        const mergedPhones: string[] = [];
        for (const p of existingPhonesArr) {
          const n = String(p).replace(/\D/g, "").slice(-10);
          if (n && !seen.has(n)) { seen.add(n); mergedPhones.push(p); }
        }
        let addedPhoneCount = 0;
        for (const p of (r.allPhones || [])) {
          const n = String(p).replace(/\D/g, "").slice(-10);
          if (n && !seen.has(n)) {
            seen.add(n);
            mergedPhones.push(p);
            addedPhoneCount++;
            // New phone — pull its state from the incoming row (untried|struck).
            existingStates[p] = r.phoneStates?.[p] || "untried";
          }
        }

        // Primary phone: keep existing unless existing is empty; then use
        // incoming primary. Never DOWNGRADE agent-progressed primary.
        const newPrimary = existingRow.phone || r.phone || mergedPhones[0] || "";

        // MLS fields: overwrite. Everything else in extra: keep existing.
        const mergedExtra: any = { ...existingExtra };
        for (const f of MLS_FIELDS) {
          if (r.extra && r.extra[f] != null && r.extra[f] !== "") mergedExtra[f] = r.extra[f];
        }
        // phoneMeta: union by phone number.
        const existingMeta = Array.isArray(existingExtra.phoneMeta) ? existingExtra.phoneMeta : [];
        const incomingMeta = Array.isArray(r.extra?.phoneMeta) ? r.extra.phoneMeta : [];
        const metaByPhone: Record<string, any> = {};
        for (const m of existingMeta) if (m?.number) metaByPhone[String(m.number).replace(/\D/g, "").slice(-10)] = m;
        for (const m of incomingMeta) {
          const n = String(m?.number || "").replace(/\D/g, "").slice(-10);
          if (!n) continue;
          // Incoming wins for DNC status (LandVoice re-scans DNC every export).
          metaByPhone[n] = { ...metaByPhone[n], ...m };
        }
        mergedExtra.phoneMeta = Object.values(metaByPhone);
        // Track merge history for debugging.
        mergedExtra.mergeHistory = [
          ...(existingExtra.mergeHistory || []),
          { at: new Date().toISOString(), source: r.extra?.source || "unknown", addedPhones: addedPhoneCount, batchId, ownerMismatch: ownerMismatch || undefined },
        ].slice(-5);   // keep last 5 merges max
        if (ownerMismatch) {
          mergedExtra.mergeReview = {
            reason: "owner_name_mismatch",
            existing: existingRow.owner_name,
            incoming: r.ownerName,
            flaggedAt: new Date().toISOString(),
            resolved: false,
            note: "Property may have changed hands. Verify via county tax record.",
          };
        }
        // Preserve incoming raw row so re-normalize can rehydrate later.
        if (r.extra?.raw) mergedExtra.raw = r.extra.raw;

        // Detect "nothing new": no added phones AND no MLS field changed.
        let mlsChanged = false;
        for (const f of MLS_FIELDS) {
          if (r.extra?.[f] != null && r.extra[f] !== "" && JSON.stringify(existingExtra[f]) !== JSON.stringify(r.extra[f])) {
            mlsChanged = true; break;
          }
        }
        if (addedPhoneCount === 0 && !mlsChanged) {
          skippedIdentical++;
          continue;
        }

        // v20.7.0 — owner_name_key is populated whenever we're allowed to write
        // owner_name. On owner mismatch we keep both existing values.
        const mergedOwnerKey = ownerMismatch ? "" : (normalizeOwnerName(r.ownerName) || "");
        updateStmt.run(
          JSON.stringify(mergedPhones),
          JSON.stringify(existingStates),
          newPrimary,
          r.listPrice ?? null,
          JSON.stringify(mergedExtra),
          // v20.6.9 — On owner mismatch, keep existing owner. Admin resolves
          // via /api/admin/leads/:id/merge-review after checking tax record.
          ownerMismatch ? "" : (r.ownerName || ""),
          mergedOwnerKey,
          matchId,
        );
        merged++;
        // Update maps so a later row in the same CSV also sees the merged state.
        for (const p of mergedPhones) {
          const n = String(p).replace(/\D/g, "").slice(-10);
          if (n) phoneToLead.set(n, matchId);
        }
        if (addrKey) addrToLead.set(addrKey, matchId);
        continue;
      }

      // ---- INSERT PATH — brand new lead ----
      const sourceTag = r.extra?.source === "landvoice-expired" ? "landvoice_expired"
        : r.extra?.source === "landvoice-listing" ? "landvoice_listing"
        : "batchleads_csv";
      // v20.7.0 — populate owner_name_key on insert (backfill fills legacy rows separately).
      const ownerKey = normalizeOwnerName(r.ownerName);
      const result = insertStmt.run(
        r.ownerName, ownerKey, r.address, r.city, r.state, r.zip, r.county,
        r.phone, JSON.stringify(r.allPhones), JSON.stringify(r.phoneStates), r.email,
        r.leadType, r.score,
        r.listPrice, r.assessedValue, r.lastSalePrice, r.lotSizeAcres, r.yearPurchased,
        sourceTag, batchId, JSON.stringify(r.extra || {}),
      );
      if (result.changes > 0) {
        const newId = Number(result.lastInsertRowid);
        inserted++;
        byType[r.leadType] = (byType[r.leadType] || 0) + 1;
        if (r.county) byCounty[r.county] = (byCounty[r.county] || 0) + 1;
        for (const p of (r.allPhones || [r.phone])) {
          const n = String(p).replace(/\D/g, "").slice(-10);
          if (n) phoneToLead.set(n, newId);
        }
        if (addrKey) addrToLead.set(addrKey, newId);
      } else {
        skippedIdentical++;
      }
    }
  });

  tx(rows);
  return {
    inserted,
    merged,
    skippedIdentical,
    skippedDuplicate: merged + skippedIdentical,
    byType,
    byCounty,
  };
}
