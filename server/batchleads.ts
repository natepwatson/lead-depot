// ─── BATCHLEADS LEAD GEN PIPELINE ─────────────────────────────────────────────
// Primary automated lead source. Pulls from saved lists in BatchLeads account.
// Runs daily at 6:00 AM EDT (10:00 UTC) via scheduled cron.
//
// SETUP: Set BATCHLEADS_API_KEY environment variable in Railway
//   Profile → Integrations → Integration Keys → Add Integration Key
// ─────────────────────────────────────────────────────────────────────────────

// v13.8 — territories removed as a routing/tagging construct. Location is still
// tracked as raw fields (city/state/zip/county/lat/lng). ZIP scope for the 8-county
// footprint is kept as a static list here to gate ingest — no territory logic.
import { ALL_NE_FLORIDA_ZIPS } from "./territories";
import { rawDb } from "./db";

const BATCHLEADS_API_KEY = process.env.BATCHLEADS_API_KEY || "";
const BATCHLEADS_BASE = "https://app.batchleads.io/api/v1";

// v14.1 — Two-flow model: Expired + Absentee only (FSBO and Land removed).
// Per lead type per county cap. Priority: Expired >> Absentee.
//   Expired  × 3 counties × 1500 = 4,500  (Nassau/Duval/St. Johns — 44% list rate, urgent)
//   Absentee × 3 counties ×  800 = 2,400  (slow drip, 14% list rate, 6-18mo LTV)
//   Total = 6,900 raw pulls/mo
const INGEST_CAPS: Record<string, number> = {
  expired:  1500,
  absentee:  800,
};
export function getIngestCap(leadType: string): number {
  return INGEST_CAPS[leadType] ?? 500;
}

// ─── TRUST / ENTITY DETECTION ─────────────────────────────────────────────────
const ENTITY_KEYWORDS = [
  "trust", "llc", "l.l.c", "inc", "corp", "incorporated", "partners", "partnership",
  "holdings", "properties", "investments", "realty", "group", "fund", "estate of",
  "revocable", "irrevocable", "family trust", "living trust", "land trust",
];

// v13.8.3 — Portfolio/institutional wording (definitely block on absentee).
// Simple single-property LLCs (e.g. "123 Main St LLC", "Smith Family LLC") are ALLOWED
// for absentee only — wealth-mindset owners often use a pass-through LLC per property.
const PORTFOLIO_KEYWORDS = [
  "holdings", "properties", "investments", "realty", "group", "fund", "partners",
  "partnership", "capital", "management", "ventures", "equity", "reit",
];

function isEntityOwner(ownerName: string): boolean {
  const lower = (ownerName || "").toLowerCase();
  return ENTITY_KEYWORDS.some(kw => lower.includes(kw));
}

function isPortfolioEntity(ownerName: string): boolean {
  const lower = (ownerName || "").toLowerCase();
  return PORTFOLIO_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── BLANK / LAW ENFORCEMENT ADDRESS DETECTION ────────────────────────────────
function hasBlankAddress(address: string): boolean {
  if (!address || address.trim().length < 5) return true;
  const lower = address.toLowerCase().trim();
  const BLANK_PATTERNS = ["unknown", "confidential", "private", "redacted", "n/a", "none", "withheld", "protected"];
  return BLANK_PATTERNS.some(p => lower.includes(p));
}

// ─── PHONE VALIDATION ─────────────────────────────────────────────────────────
function isCallablePhone(phone: string): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return false;
  const area = digits.slice(-10, -7);
  const NON_CALLABLE = ["000", "555", "900", "976", "800", "888", "877", "866", "855", "844", "833", "822"];
  if (NON_CALLABLE.includes(area)) return false;
  return true;
}

// ─── DATA SHAPE ───────────────────────────────────────────────────────────────
// v13.8.1 — DBPR agent-owned filter. Cross-reference each lead against the
// recruiting-side DBPR licensees table (populated weekly by dbpr-pipeline.ts).
// Match on (a) first + last name OR (b) phone number — either is enough to drop.
let _dbprCache: {
  names: Set<string>;      // "first|last" lowercase
  phones: Set<string>;     // 10-digit
  refreshedAt: number;
} | null = null;
const DBPR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — DBPR table only changes weekly

function refreshDbprCache(): void {
  try {
    // Recruiting-side table populated weekly by dbpr-pipeline.ts.
    // Only pull rows that came from the DBPR scrape (source='dbpr_scrape').
    const rows: any[] = rawDb.prepare(
      `SELECT first_name, last_name, phone FROM agent_leads
       WHERE source = 'dbpr_scrape' AND first_name IS NOT NULL AND last_name IS NOT NULL`
    ).all();
    const names = new Set<string>();
    const phones = new Set<string>();
    for (const r of rows) {
      const fn = String(r.first_name || "").trim().toLowerCase();
      const ln = String(r.last_name  || "").trim().toLowerCase();
      if (fn && ln) names.add(`${fn}|${ln}`);
      const ph = String(r.phone || "").replace(/\D/g, "").slice(-10);
      if (ph.length === 10) phones.add(ph);
    }
    _dbprCache = { names, phones, refreshedAt: Date.now() };
    console.log(`[BatchLeads] DBPR cache refreshed: ${names.size} names, ${phones.size} phones`);
  } catch (err) {
    console.warn("[BatchLeads] DBPR cache refresh failed (table may not exist yet):", err);
    _dbprCache = { names: new Set(), phones: new Set(), refreshedAt: Date.now() };
  }
}

function isOwnerLicensedAgent(raw: BatchRawLead): boolean {
  if (!_dbprCache || (Date.now() - _dbprCache.refreshedAt) > DBPR_CACHE_TTL_MS) {
    refreshDbprCache();
  }
  if (!_dbprCache) return false;

  // Phone match — strongest signal (works even if lead uses spouse's name / trust)
  for (const ph of raw.allPhones) {
    const normalized = ph.replace(/\D/g, "").slice(-10);
    if (_dbprCache.phones.has(normalized)) return true;
  }

  // Name match — owner_name format is typically "LAST, FIRST" or "FIRST LAST"
  const own = (raw.ownerName || "").toLowerCase().trim();
  if (!own) return false;

  // Try "LAST, FIRST" pattern
  const commaSplit = own.split(",").map(s => s.trim());
  if (commaSplit.length === 2) {
    const ln = commaSplit[0].split(/\s+/)[0];
    const fn = commaSplit[1].split(/\s+/)[0];
    if (fn && ln && _dbprCache.names.has(`${fn}|${ln}`)) return true;
  }

  // Try "FIRST LAST" pattern (also handles "FIRST M LAST")
  const parts = own.split(/\s+/).filter(p => p.length > 1);
  if (parts.length >= 2) {
    const fn = parts[0];
    const ln = parts[parts.length - 1];
    if (_dbprCache.names.has(`${fn}|${ln}`)) return true;
  }

  return false;
}

export interface BatchRawLead {
  ownerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  lat?: number;
  lng?: number;
  phone: string;
  phone2?: string;
  phone3?: string;
  phone4?: string;
  phone5?: string;
  allPhones: string[];           // all valid phone numbers from BatchLeads
  email?: string;
  listPrice?: number;
  estimatedValue?: number;       // v13.8: used as Land assessed-value floor ($75K+)
  assessedValue?: number;
  mortgageBalance?: number;
  equityPct?: number;
  daysOnMarket?: number;
  daysSinceExpiration?: number;
  lastSaleDate?: string;      // v13.8.1 — ISO date of most recent recorded sale
  offMarketDate?: string;     // v13.8.1 — ISO date the failed listing came off market
  expirationCount?: number;
  priceReductions?: number;
  ownerOccupied?: boolean;
  absenteeOutOfState?: boolean;
  leadType: string;              // v13.8.3: "expired" | "fsbo" | "land" | "absentee"
  sourceId: string;              // BatchLeads address ID for dedup
  isFsbo?: boolean;
  hasActiveListing?: boolean;
  batchRankScore?: number;       // BatchLeads AI distress score (0-10)
  phoneTypes?: string[];         // ["mobile","landline", ...] per phone
  dnc?: boolean[];               // DNC status per phone
  isLitigator?: boolean[];       // litigator flag per phone
  // v13.8 fields
  lotSizeAcres?: number;         // Land 1AC+ filter
  yearPurchased?: number;        // Land 5yr+ ownership filter (year owner acquired)
  propertyType?: string;         // "Single Family", "Vacant Land", etc.
}

export interface ScoredBatchLead extends BatchRawLead {
  score: number;
  scoreBreakdown: string[];
  priority: "priority" | "standard" | "reserve" | "discard";
  filterReason?: string;
}

// ─── LEAD SCORER ──────────────────────────────────────────────────────────────
// v13.8 — scoring is used only for prioritization inside a lead type's FIFO pool.
// Higher-scoring leads sort to the top of the type queue, but all leads served FIFO.
export function scoreBatchLead(raw: BatchRawLead): ScoredBatchLead {
  const breakdown: string[] = [];
  let score = 0;

  // ── BatchRank AI distress score (0-10 from BatchLeads)
  if (raw.batchRankScore !== undefined) {
    if (raw.batchRankScore >= 8)      { score += 5; breakdown.push(`+5 BatchRank ${raw.batchRankScore}/10 (high distress)`); }
    else if (raw.batchRankScore >= 6) { score += 3; breakdown.push(`+3 BatchRank ${raw.batchRankScore}/10 (moderate distress)`); }
    else if (raw.batchRankScore >= 4) { score += 1; breakdown.push(`+1 BatchRank ${raw.batchRankScore}/10 (mild distress)`); }
  }

  // ── Expired-specific
  if (raw.leadType === "expired") {
    const expCount = raw.expirationCount || 1;
    if (expCount >= 2) { score += 5; breakdown.push(`+5 expired ${expCount}x`); }

    const dse = raw.daysSinceExpiration || 0;
    if (dse <= 30)        { score += 4; breakdown.push("+4 expired <30 days ago"); }
    else if (dse <= 90)   { score += 3; breakdown.push("+3 expired 31–90 days ago"); }

    if ((raw.priceReductions || 0) >= 2) { score += 3; breakdown.push("+3 price reduced 2+ times"); }
  }

  // v14.1 — FSBO and Land removed. Expired + Absentee flows only.

  // v13.8.3 — Absentee owner (wealth-mindset investor lead)
  if (raw.leadType === "absentee") {
    const yp = raw.yearPurchased || 0;
    const currentYear = new Date().getFullYear();
    const tenure = yp > 0 ? currentYear - yp : 0;
    if (tenure >= 15)      { score += 5; breakdown.push(`+5 owned ${tenure}yr (landlord fatigue)`); }
    else if (tenure >= 10) { score += 4; breakdown.push(`+4 owned ${tenure}yr`); }
    else if (tenure >= 7)  { score += 2; breakdown.push(`+2 owned ${tenure}yr`); }

    if (raw.absenteeOutOfState) { score += 3; breakdown.push("+3 out-of-state absentee"); }

    const ev = raw.estimatedValue || 0;
    if (ev >= 1000000)     { score += 3; breakdown.push(`+3 estValue $${(ev/1e6).toFixed(1)}M`); }
    else if (ev >= 500000) { score += 2; breakdown.push(`+2 estValue $${Math.round(ev/1000)}k`); }
  }

  // ── Equity (applies to all types where we have it)
  const equity = raw.equityPct || 0;
  if (equity >= 50)      { score += 5; breakdown.push(`+5 equity ~${equity}% (high)`); }
  else if (equity >= 30) { score += 3; breakdown.push(`+3 equity ~${equity}% (moderate)`); }

  // ── Owner occupied
  if (raw.ownerOccupied) { score += 2; breakdown.push("+2 owner-occupied"); }

  // ── Absentee out of state (motivated seller signal)
  if (raw.absenteeOutOfState) { score += 1; breakdown.push("+1 absentee out-of-state"); }

  // ── Mobile phone confirmed
  if (raw.phoneTypes && raw.phoneTypes.some(t => t === "mobile" || t === "2")) {
    score += 3; breakdown.push("+3 mobile phone confirmed");
  }

  // ── Priority tier (used for insert order into the type pool)
  let priority: ScoredBatchLead["priority"];
  if (score >= 12)      priority = "priority";
  else if (score >= 7)  priority = "standard";
  else if (score >= 4)  priority = "reserve";
  else                  priority = "discard";

  return { ...raw, score, scoreBreakdown: breakdown, priority };
}

// ─── HARD FILTER CHAIN ────────────────────────────────────────────────────────
export function filterBatchLead(
  raw: BatchRawLead,
  existingPhones: Set<string>,
  existingAddresses: Set<string>,
  recentWrongNumbers: Set<string>,
  recentNotInterested: Set<string>,
): { pass: boolean; reason?: string } {

  // 1. Trust / LLC / corporate owner
  //    v13.8.3 — for ABSENTEE only, allow single-property LLCs (Smith LLC, 123 Main St LLC)
  //    but still block trusts and portfolio-wording entities (Holdings, Investments, etc.)
  if (raw.leadType === "absentee") {
    const lower = (raw.ownerName || "").toLowerCase();
    const isTrust = /\btrust\b|revocable|irrevocable|estate of/.test(lower);
    if (isTrust) {
      return { pass: false, reason: "entity_owner (trust — blocked on absentee)" };
    }
    if (isPortfolioEntity(raw.ownerName)) {
      return { pass: false, reason: "portfolio_entity (multi-property investor LLC)" };
    }
    // single-property LLCs / corp allowed — fall through
  } else if (isEntityOwner(raw.ownerName)) {
    return { pass: false, reason: "entity_owner (trust/LLC/corp)" };
  }

  // 2. v13.8.2 — Blank address is OK if there's a callable phone (LEO leads).
  //     Drop only when BOTH address is missing AND no callable phone exists.
  const callablePhones = raw.allPhones.filter(isCallablePhone);
  const addressBlank = hasBlankAddress(raw.address);
  if (addressBlank && callablePhones.length === 0) {
    return { pass: false, reason: "unworkable (no address and no phone)" };
  }

  // 3. No callable phone (with or without address, unworkable)
  if (callablePhones.length === 0) {
    return { pass: false, reason: "no_callable_phone" };
  }

  // 4. All phones are DNC — skip if every phone is on DNC
  if (raw.dnc && raw.dnc.length > 0 && raw.dnc.every(d => d === true)) {
    return { pass: false, reason: "all_phones_dnc" };
  }

  // 5. Litigator — hard block
  if (raw.isLitigator && raw.isLitigator.some(l => l === true)) {
    return { pass: false, reason: "litigator_flag" };
  }

  // 6. Re-listed with active agent
  if (raw.hasActiveListing) {
    return { pass: false, reason: "re_listed_with_active_agent" };
  }

  // 7. Already in Lead Depot (phone match — any of the phones)
  for (const ph of raw.allPhones) {
    const normalized = ph.replace(/\D/g, "").slice(-10);
    if (existingPhones.has(normalized)) {
      return { pass: false, reason: `duplicate_phone (${normalized})` };
    }
  }

  // 8. Already in Lead Depot (address match) — skip check when address is blank (LEO)
  if (!addressBlank) {
    const normalizedAddr = raw.address.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (existingAddresses.has(normalizedAddr)) {
      return { pass: false, reason: "duplicate_address" };
    }
  }

  // 9. Recently marked wrong number (90-day block)
  for (const ph of raw.allPhones) {
    const normalized = ph.replace(/\D/g, "").slice(-10);
    if (recentWrongNumbers.has(normalized)) {
      return { pass: false, reason: `wrong_number_logged_90d (${normalized})` };
    }
  }

  // 10. Recently marked not interested (180-day block)
  for (const ph of raw.allPhones) {
    const normalized = ph.replace(/\D/g, "").slice(-10);
    if (recentNotInterested.has(normalized)) {
      return { pass: false, reason: `not_interested_logged_180d (${normalized})` };
    }
  }

  // 11. Only goes back 24 months for expired (v13.8.1 — was 18 months)
  if (raw.leadType === "expired" && (raw.daysSinceExpiration || 0) > 720) {
    return { pass: false, reason: "expired_too_old (>24 months)" };
  }

  // 11a. v13.8.1 — LEO / address-confidentiality leads are KEPT (Watson Brothers works with LEOs).
  //  AgentView renders "Address confidential" when address is blank.

  // 11b. v13.8.1 — Sold after expiration (Failed listing but property has since sold to someone else).
  //  Uses BatchLeads sale-date fields if present. If last_sale_date > off_market_date, drop.
  if (raw.leadType === "expired" && raw.lastSaleDate && raw.offMarketDate) {
    const saleTs = Date.parse(raw.lastSaleDate);
    const offTs = Date.parse(raw.offMarketDate);
    if (!isNaN(saleTs) && !isNaN(offTs) && saleTs > offTs) {
      return { pass: false, reason: "sold_after_expiration" };
    }
  }

  // 11c. v13.8.1 — Owner is a licensed real estate agent (DBPR match on name OR phone).
  //  We built the DBPR table on the recruiting side; reuse it here to block agent-owned homes.
  if (isOwnerLicensedAgent(raw)) {
    return { pass: false, reason: "owner_is_licensed_agent" };
  }

  // 12. v14.0 — 7-county ZIP scope (Nassau/Duval/St.Johns/Baker FL + Camden/Charlton/Glynn GA)
  if (raw.zip && !ALL_NE_FLORIDA_ZIPS.has(raw.zip.slice(0, 5))) {
    return { pass: false, reason: `zip_out_of_footprint (${raw.zip})` };
  }

  // 13. v14.1 — Expired: $500K minimum list price
  if (raw.leadType === "expired") {
    const lp = raw.listPrice || 0;
    if (lp < 500000) {
      return { pass: false, reason: `list_price_under_500k ($${lp})` };
    }
  }

  // 15. v13.8.3 — Absentee: equity ≥ 60%, owned ≥ 7 years, residential property.
  //     LLC handling already done in filter #1 above.
  if (raw.leadType === "absentee") {
    // Must be absentee (not owner-occupied) — BatchLeads flag or out-of-state mailing
    if (raw.ownerOccupied === true) {
      return { pass: false, reason: "absentee_but_owner_occupied" };
    }

    const equity = raw.equityPct || 0;
    if (equity < 60) {
      return { pass: false, reason: `absentee_equity_under_60 (${equity}%)` };
    }

    const yp = raw.yearPurchased || 0;
    const currentYear = new Date().getFullYear();
    if (yp === 0 || (currentYear - yp) < 7) {
      return { pass: false, reason: `absentee_tenure_under_7yr (bought ${yp || "unknown"})` };
    }

    // Residential only (single-family, condo, townhouse, duplex, multi-family) — exclude vacant land
    if (raw.propertyType && /vacant|land|lot/i.test(raw.propertyType)) {
      return { pass: false, reason: `absentee_is_land (${raw.propertyType})` };
    }

    // Minimum estimated value $200K (avoid low-value manufactured / mobile home leads)
    const ev = raw.estimatedValue || raw.assessedValue || 0;
    if (ev < 200000) {
      return { pass: false, reason: `absentee_value_under_200k ($${ev})` };
    }
  }

  // v14.1 — Land filter removed. Reject any land/FSBO leads that slip through.
  if (raw.leadType === "land" || raw.leadType === "fsbo") {
    return { pass: false, reason: `disabled_lead_type (${raw.leadType})` };
  }

  return { pass: true };
}

// ─── BATCHLEADS API — FETCH SAVED LEADS ───────────────────────────────────────
// BatchLeads API is pull-based: you query leads you've already saved to lists.
// Strategy: maintain named lists in BatchLeads for each lead type (expired, FSBO, etc.)
// The pipeline pulls all leads from those lists added in the last 24 hours.

interface BatchLeadsProperty {
  id: number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  owner_name?: string;
  owner_first_name?: string;
  owner_last_name?: string;
  mailing_address?: string;
  lead_score?: number;         // BatchRank AI score
  lead_status?: number;
  vacant?: boolean;
  absentee?: boolean;
  out_of_state?: boolean;
  owner_occupied?: boolean;
  pre_foreclosure?: boolean;
  active_listing?: boolean;
  equity_percent?: number;
  estimated_value?: number;
  mortgage_balance?: number;
  list_price?: number;
  days_on_market?: number;
  times_expired?: number;
  price_reductions?: number;
  is_fsbo?: boolean;
  created_at?: string;
  updated_at?: string;
  contacts?: {
    id: number;
    number: string;
    type: number;          // 1=Landline, 2=Mobile
    status: number;        // 1=Unknown, 2=DNC, 3=WrongNumber, 4=Verified
    national_dnc_status?: boolean;
    is_litigator?: boolean;
    reachable?: boolean;
  }[];
}

// v14.1 — map BatchLeads list names to our 2 active lead types by PREFIX.
// Alex builds one list per county (e.g. "Lead Depot - Expired - Duval"), so we
// match the type by the leading segment and ignore the county suffix.
// Naming convention (case-insensitive):
//   Lead Depot - Expired[ - <County>]
//   Lead Depot - Absentee[ - <County>]
function listNameToLeadType(name: string | null | undefined): string | null {
  if (!name || typeof name !== "string") return null;
  const n = name.trim().toLowerCase();
  if (!n.startsWith("lead depot -")) return null;
  if (/\blead depot\s*-\s*expired\b/.test(n))  return "expired";
  if (/\blead depot\s*-\s*absentee\b/.test(n)) return "absentee";
  return null;
}

async function fetchBatchLeadsPage(
  listIds: number[],
  page: number,
  pagesize: number = 50,
  sortBy: string = "lead_score",
  sortOrder: "asc" | "desc" = "desc",
): Promise<{ properties: BatchLeadsProperty[]; total: number }> {
  const resp = await fetch(`${BATCHLEADS_BASE}/property`, {
    method: "POST",
    headers: {
      "api-key": BATCHLEADS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      list_ids: listIds,
      page,
      per_page: pagesize,
      sort_by: sortBy,
      sort_type: sortOrder,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`BatchLeads API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return {
    properties: data.data || data.properties || data.results || [],
    total: data.total || data.count || 0,
  };
}

async function fetchPhoneDetails(addressId: number): Promise<BatchLeadsProperty["contacts"]> {
  try {
    const resp = await fetch(
      `${BATCHLEADS_BASE}/filter/addresses/phone-detail?address_id=${addressId}`,
      {
        headers: {
          "api-key": BATCHLEADS_API_KEY,
          "Accept": "application/json",
        },
      }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.data || data.contacts || [];
  } catch {
    return [];
  }
}

async function fetchUserLists(): Promise<{ id: number; name: string }[]> {
  const resp = await fetch(`${BATCHLEADS_BASE}/lists`, {
    headers: {
      "api-key": BATCHLEADS_API_KEY,
      "Accept": "application/json",
    },
  });
  if (!resp.ok) throw new Error(`BatchLeads lists fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.data || data.lists || [];
}

function normalizeBatchProperty(
  prop: BatchLeadsProperty,
  leadType: string,
  contacts: NonNullable<BatchLeadsProperty["contacts"]>,
): BatchRawLead {
  const ownerName = prop.owner_name
    || `${prop.owner_first_name || ""} ${prop.owner_last_name || ""}`.trim();

  // Collect all phones, types, dnc flags
  const allPhones: string[] = [];
  const phoneTypes: string[] = [];
  const dncFlags: boolean[] = [];
  const litigatorFlags: boolean[] = [];

  for (const c of contacts) {
    const digits = (c.number || "").replace(/\D/g, "");
    if (digits.length >= 10) {
      allPhones.push(digits);
      phoneTypes.push(c.type === 2 ? "mobile" : "landline");
      dncFlags.push(c.national_dnc_status === true || c.status === 2);
      litigatorFlags.push(c.is_litigator === true);
    }
  }

  // Pick first non-DNC phone as primary
  const primaryIdx = dncFlags.findIndex(d => !d);
  const primaryPhone = allPhones[primaryIdx >= 0 ? primaryIdx : 0] || "";

  // v13.8 — accept a few new optional BatchLeads fields we now depend on.
  const anyProp = prop as any;
  const lotSizeAcres = anyProp.lot_size_acres ?? anyProp.acres ?? anyProp.lot_acres;
  const yearPurchased = anyProp.year_purchased ?? anyProp.year_bought ?? anyProp.owner_purchase_year ?? anyProp.last_sale_year;
  const propertyType = anyProp.property_type ?? anyProp.property_class ?? anyProp.type;
  const assessedValue = anyProp.assessed_value ?? anyProp.tax_assessed_value;
  const county = anyProp.county ?? anyProp.county_name;
  const lat = anyProp.latitude ?? anyProp.lat;
  const lng = anyProp.longitude ?? anyProp.lng;
  // v13.8.1 — sale-history fields used by "sold after expiration" filter
  const lastSaleDate = anyProp.last_sale_date ?? anyProp.sale_date ?? anyProp.last_sold_date;
  const offMarketDate = anyProp.off_market_date ?? anyProp.expiration_date ?? anyProp.mls_expired_date ?? anyProp.failed_date;

  return {
    ownerName,
    address: prop.address || "",
    city: prop.city || "",
    state: prop.state || "FL",
    zip: prop.zip || "",
    county,
    lat: typeof lat === "number" ? lat : undefined,
    lng: typeof lng === "number" ? lng : undefined,
    phone: primaryPhone,
    allPhones,
    leadType,
    sourceId: String(prop.id),
    isFsbo: prop.is_fsbo === true || leadType === "fsbo",
    hasActiveListing: prop.active_listing === true,
    ownerOccupied: prop.owner_occupied === true,
    absenteeOutOfState: prop.out_of_state === true,
    batchRankScore: prop.lead_score,
    equityPct: prop.equity_percent,
    estimatedValue: prop.estimated_value,
    assessedValue: typeof assessedValue === "number" ? assessedValue : undefined,
    mortgageBalance: prop.mortgage_balance,
    listPrice: prop.list_price,
    daysOnMarket: prop.days_on_market,
    daysSinceExpiration: prop.days_on_market, // BatchLeads uses DOM for expired
    expirationCount: prop.times_expired,
    priceReductions: prop.price_reductions,
    phoneTypes,
    dnc: dncFlags,
    isLitigator: litigatorFlags,
    // v13.8 fields
    lotSizeAcres: typeof lotSizeAcres === "number" ? lotSizeAcres : undefined,
    yearPurchased: typeof yearPurchased === "number" ? yearPurchased : undefined,
    propertyType: typeof propertyType === "string" ? propertyType : undefined,
    lastSaleDate: typeof lastSaleDate === "string" ? lastSaleDate : undefined,
    offMarketDate: typeof offMarketDate === "string" ? offMarketDate : undefined,
  };
}

export async function fetchBatchLeadsForPipeline(
  sinceHours: number = 24
): Promise<BatchRawLead[]> {
  if (!BATCHLEADS_API_KEY) {
    console.warn("[BatchLeads] No API key set — skipping fetch");
    return [];
  }

  // 1. Get user's lists and find our Lead Depot lists
  let userLists: { id: number; name: string }[] = [];
  try {
    userLists = await fetchUserLists();
  } catch (err) {
    console.error("[BatchLeads] Failed to fetch lists:", err);
    return [];
  }

  const matchedLists: { id: number; leadType: string }[] = [];
  for (const list of userLists) {
    const leadType = listNameToLeadType(list.name);
    if (leadType) {
      matchedLists.push({ id: list.id, leadType });
      console.log(`[BatchLeads] Found list: "${list.name}" → ${leadType} (id=${list.id})`);
    }
  }

  if (matchedLists.length === 0) {
    console.warn("[BatchLeads] No matching Lead Depot lists found. Create lists named:");
    console.warn("  Expected naming: 'Lead Depot - Expired - <County>', 'Lead Depot - Absentee - <County>'");
    return [];
  }

  // 2. Pull top-N leads from each list (sorted by BatchRank lead_score desc).
  // v13.8.4 — sinceHours param retained for backwards compatibility but not used;
  // frugal mode ingests top-of-list up to the per-type cap on every run.
  void sinceHours;
  const allLeads: BatchRawLead[] = [];

  for (const { id: listId, leadType } of matchedLists) {
    // v13.8.4 — Frugal mode: per-list cap enforced (one list = one county × one type).
    // Sort by BatchRank lead_score DESC so we ingest the highest-value leads first.
    const cap = getIngestCap(leadType);
    console.log(`[BatchLeads] Pulling ${leadType} leads from list ${listId} (cap=${cap}, sort=lead_score desc)`);
    let page = 1;
    let fetched = 0;
    let ingested = 0;
    let total = Infinity;
    let capHit = false;

    while (fetched < total && ingested < cap) {
      try {
        const { properties, total: t } = await fetchBatchLeadsPage(
          [listId], page, 50, "lead_score", "desc",
        );
        total = t;

        if (properties.length === 0) break;

        for (const prop of properties) {
          if (ingested >= cap) {
            capHit = true;
            break;
          }

          // Fetch phone details for this property
          const contacts = await fetchPhoneDetails(prop.id);
          const normalized = normalizeBatchProperty(prop, leadType, contacts);
          allLeads.push(normalized);
          ingested++;
        }

        fetched += properties.length;
        page++;

        if (capHit) break;
      } catch (err) {
        console.error(`[BatchLeads] Error fetching list ${listId} page ${page}:`, err);
        break;
      }
    }

    if (capHit) {
      console.log(`[BatchLeads] ${leadType} list ${listId}: cap ${cap} reached (source total=${total})`);
    }
    console.log(`[BatchLeads] ${leadType} list ${listId}: ingested ${ingested} / cap ${cap}`);
  }

  return allLeads;
}

// ─── MAIN PIPELINE RUNNER ─────────────────────────────────────────────────────
export async function runBatchLeadsPipeline(rawDb: any): Promise<{
  fetched: number;
  filtered: number;
  priority: number;
  standard: number;
  reserve: number;
  discarded: number;
  byType: Record<string, number>;
}> {
  console.log("[BatchLeads] Starting daily lead gen pipeline...");

  if (!BATCHLEADS_API_KEY) {
    console.warn("[BatchLeads] BATCHLEADS_API_KEY not set. Skipping pipeline.");
    return { fetched: 0, filtered: 0, priority: 0, standard: 0, reserve: 0, discarded: 0, byType: {} };
  }

  // Build dedup sets from existing leads — check ALL phone numbers, not just primary
  const existingLeads = rawDb.prepare(`SELECT phone, phones, address FROM leads`).all() as any[];
  const existingPhones = new Set<string>();
  for (const l of existingLeads) {
    if (l.phone) existingPhones.add((l.phone).replace(/\D/g, "").slice(-10));
    if (l.phones) {
      try {
        const arr: string[] = JSON.parse(l.phones);
        for (const p of arr) existingPhones.add(p.replace(/\D/g, "").slice(-10));
      } catch {}
    }
  }
  const existingAddresses = new Set<string>(
    existingLeads.map((l: any) => (l.address || "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)
  );

  // Wrong number in last 90 days — use correct table name: lead_activity
  const wrongNumbers = rawDb.prepare(`
    SELECT DISTINCT l.phone FROM leads l
    JOIN lead_activity a ON a.lead_id = l.id
    WHERE a.outcome = 'wrong_number'
      AND a.created_at > datetime('now', '-90 days')
  `).all() as any[];
  const recentWrongNumbers = new Set<string>(
    wrongNumbers.map((r: any) => (r.phone || "").replace(/\D/g, "").slice(-10))
  );

  // Not interested in last 180 days — use correct table name: lead_activity
  const notInterested = rawDb.prepare(`
    SELECT DISTINCT l.phone FROM leads l
    JOIN lead_activity a ON a.lead_id = l.id
    WHERE a.outcome = 'contacted_not_interested'
      AND a.created_at > datetime('now', '-180 days')
  `).all() as any[];
  const recentNotInterested = new Set<string>(
    notInterested.map((r: any) => (r.phone || "").replace(/\D/g, "").slice(-10))
  );

  // Fetch from BatchLeads
  const rawLeads = await fetchBatchLeadsForPipeline(24);
  console.log(`[BatchLeads] Fetched ${rawLeads.length} total leads from API`);

  const stats = {
    fetched: rawLeads.length,
    filtered: 0,
    priority: 0,
    standard: 0,
    reserve: 0,
    discarded: 0,
    byType: {} as Record<string, number>,
  };

  const toInsert: ScoredBatchLead[] = [];

  for (const lead of rawLeads) {
    const filter = filterBatchLead(
      lead, existingPhones, existingAddresses, recentWrongNumbers, recentNotInterested
    );
    if (!filter.pass) {
      console.log(`[BatchLeads] FILTERED (${filter.reason}): ${lead.ownerName} — ${lead.address}`);
      stats.filtered++;
      continue;
    }

    const scored = scoreBatchLead(lead);
    if (scored.priority === "discard") { stats.discarded++; continue; }

    toInsert.push(scored);
    stats.byType[lead.leadType] = (stats.byType[lead.leadType] || 0) + 1;
    if (scored.priority === "priority") stats.priority++;
    else if (scored.priority === "standard") stats.standard++;
    else if (scored.priority === "reserve") stats.reserve++;
  }

  // Insert priority-first so they get lower IDs and go first in round-robin
  const sorted = [
    ...toInsert.filter(l => l.priority === "priority"),
    ...toInsert.filter(l => l.priority === "standard"),
    ...toInsert.filter(l => l.priority === "reserve"),
  ];

  // v13.8 — insert includes new geo + property fields. Status is 'unassigned'
  // (the shared FIFO pool). No territory column. Agents claim via /api/leads/next.
  const insertStmt = rawDb.prepare(`
    INSERT OR IGNORE INTO leads (
      owner_name, address, city, state, zip, county, lat, lng,
      phone, phones, phone_states, email,
      lead_type, status, score,
      list_price, assessed_value, lot_size_acres, year_purchased,
      source, batch_id, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, ?, ?, ?, 'batchleads', ?, datetime('now'))
  `);

  const batchId = `batchleads_${new Date().toISOString().slice(0, 10)}`;
  const insertAll = rawDb.transaction((leads: ScoredBatchLead[]) => {
    for (const l of leads) {
      const primaryPhone = l.phone.replace(/\D/g, "").slice(-10);
      const allPhones = JSON.stringify(l.allPhones.map(p => p.replace(/\D/g, "").slice(-10)));
      const phoneStates = JSON.stringify(
        Object.fromEntries(l.allPhones.map(p => [p.replace(/\D/g, "").slice(-10), "untried"]))
      );
      insertStmt.run(
        l.ownerName, l.address, l.city, l.state, l.zip,
        l.county || null, l.lat ?? null, l.lng ?? null,
        primaryPhone, allPhones, phoneStates, l.email || "",
        l.leadType, l.score,
        l.listPrice ?? null, l.assessedValue ?? null,
        l.lotSizeAcres ?? null, l.yearPurchased ?? null,
        batchId
      );
    }
  });
  insertAll(sorted);

  console.log(
    `[BatchLeads] Pipeline complete. Inserted ${sorted.length} leads. ` +
    `Priority: ${stats.priority}, Standard: ${stats.standard}, Reserve: ${stats.reserve}. ` +
    `Filtered: ${stats.filtered}, Discarded: ${stats.discarded}.`
  );
  return stats;
}
