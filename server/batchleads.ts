// ─── BATCHLEADS LEAD GEN PIPELINE ─────────────────────────────────────────────
// Primary automated lead source. Pulls from saved lists in BatchLeads account.
// Runs daily at 6:00 AM EDT (10:00 UTC) via scheduled cron.
//
// SETUP: Set BATCHLEADS_API_KEY environment variable in Railway
//   Profile → Integrations → Integration Keys → Add Integration Key
// ─────────────────────────────────────────────────────────────────────────────

import { ALL_NE_FLORIDA_ZIPS, getTerritoryForZip } from "./territories";

const BATCHLEADS_API_KEY = process.env.BATCHLEADS_API_KEY || "";
const BATCHLEADS_BASE = "https://app.batchleads.io/api/v1";

// ─── TRUST / ENTITY DETECTION ─────────────────────────────────────────────────
const ENTITY_KEYWORDS = [
  "trust", "llc", "l.l.c", "inc", "corp", "incorporated", "partners", "partnership",
  "holdings", "properties", "investments", "realty", "group", "fund", "estate of",
  "revocable", "irrevocable", "family trust", "living trust", "land trust",
];

function isEntityOwner(ownerName: string): boolean {
  const lower = (ownerName || "").toLowerCase();
  return ENTITY_KEYWORDS.some(kw => lower.includes(kw));
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
export interface BatchRawLead {
  ownerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  phone2?: string;
  phone3?: string;
  phone4?: string;
  phone5?: string;
  allPhones: string[];           // all valid phone numbers from BatchLeads
  email?: string;
  listPrice?: number;
  estimatedValue?: number;
  mortgageBalance?: number;
  equityPct?: number;
  daysOnMarket?: number;
  daysSinceExpiration?: number;
  expirationCount?: number;
  priceReductions?: number;
  ownerOccupied?: boolean;
  absenteeOutOfState?: boolean;
  leadType: string;
  sourceId: string;              // BatchLeads address ID for dedup
  isPreforeclosure?: boolean;
  isFsbo?: boolean;
  isVacant?: boolean;
  hasActiveListing?: boolean;
  batchRankScore?: number;       // BatchLeads AI distress score (0-10)
  phoneTypes?: string[];         // ["mobile","landline", ...] per phone
  dnc?: boolean[];               // DNC status per phone
  isLitigator?: boolean[];       // litigator flag per phone
}

export interface ScoredBatchLead extends BatchRawLead {
  score: number;
  scoreBreakdown: string[];
  territory: string | null;
  priority: "priority" | "standard" | "reserve" | "discard";
  filterReason?: string;
}

// ─── LEAD SCORER ──────────────────────────────────────────────────────────────
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
  const expCount = raw.expirationCount || 1;
  if (expCount >= 2) { score += 5; breakdown.push(`+5 expired ${expCount}x`); }

  const dse = raw.daysSinceExpiration || 0;
  if (dse <= 30)        { score += 4; breakdown.push("+4 expired <30 days ago"); }
  else if (dse <= 90)   { score += 3; breakdown.push("+3 expired 31–90 days ago"); }
  else if (dse <= 180)  { score += 2; breakdown.push("+2 expired 91–180 days ago"); }
  else if (dse <= 540)  { score += 1; breakdown.push("+1 expired 181–540 days ago"); }

  // ── Price reductions
  if ((raw.priceReductions || 0) >= 2) { score += 3; breakdown.push("+3 price reduced 2+ times"); }

  // ── Equity
  const equity = raw.equityPct || 0;
  if (equity >= 50)      { score += 5; breakdown.push(`+5 equity ~${equity}% (high)`); }
  else if (equity >= 30) { score += 3; breakdown.push(`+3 equity ~${equity}% (moderate)`); }

  // ── Pre-foreclosure
  if (raw.isPreforeclosure) { score += 4; breakdown.push("+4 pre-foreclosure (NOD filed)"); }

  // ── Owner occupied
  if (raw.ownerOccupied) { score += 2; breakdown.push("+2 owner-occupied"); }

  // ── Absentee out of state
  if (raw.absenteeOutOfState) { score += 1; breakdown.push("+1 absentee out-of-state"); }

  // ── FSBO
  if (raw.isFsbo) { score += 2; breakdown.push("+2 FSBO"); }

  // ── Vacant / distressed
  if (raw.isVacant) { score += 2; breakdown.push("+2 vacant/distressed signal"); }

  // ── Mobile phone confirmed
  if (raw.phoneTypes && raw.phoneTypes.some(t => t === "mobile" || t === "2")) {
    score += 3; breakdown.push("+3 mobile phone confirmed");
  }

  // ── Territory match
  const territory = getTerritoryForZip(raw.zip);
  if (territory) { score += 2; breakdown.push(`+2 in active territory (${territory})`); }

  // ── Priority tier
  let priority: ScoredBatchLead["priority"];
  if (score >= 12)      priority = "priority";
  else if (score >= 7)  priority = "standard";
  else if (score >= 4)  priority = "reserve";
  else                  priority = "discard";

  return { ...raw, score, scoreBreakdown: breakdown, territory, priority };
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
  if (isEntityOwner(raw.ownerName)) {
    return { pass: false, reason: "entity_owner (trust/LLC/corp)" };
  }

  // 2. Blank or privacy-blocked address
  if (hasBlankAddress(raw.address)) {
    return { pass: false, reason: "blank_address (law enforcement privacy block)" };
  }

  // 3. No callable phone
  const callablePhones = raw.allPhones.filter(isCallablePhone);
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

  // 8. Already in Lead Depot (address match)
  const normalizedAddr = raw.address.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (existingAddresses.has(normalizedAddr)) {
    return { pass: false, reason: "duplicate_address" };
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

  // 11. Only goes back 18 months for expired
  if (raw.leadType === "expired" && (raw.daysSinceExpiration || 0) > 540) {
    return { pass: false, reason: "expired_too_old (>18 months)" };
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

// Map BatchLeads list names to our internal lead types
// You set these list names up in BatchLeads UI → My Lists
const LIST_NAME_TO_TYPE: Record<string, string> = {
  "Lead Depot - Expired":          "expired",
  "Lead Depot - FSBO":             "fsbo",
  "Lead Depot - Pre-Foreclosure":  "preforeclosure",
  "Lead Depot - Distressed":       "distressed",
  "Lead Depot - Vacant":           "vacant",
  "Lead Depot - Land":             "land",
};

async function fetchBatchLeadsPage(
  listIds: number[],
  page: number,
  pagesize: number = 50,
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
      pagesize,
      sort_by: "created_at",
      sort_order: "desc",
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

  return {
    ownerName,
    address: prop.address || "",
    city: prop.city || "",
    state: prop.state || "FL",
    zip: prop.zip || "",
    phone: primaryPhone,
    allPhones,
    leadType,
    sourceId: String(prop.id),
    isPreforeclosure: prop.pre_foreclosure === true || leadType === "preforeclosure",
    isFsbo: prop.is_fsbo === true || leadType === "fsbo",
    isVacant: prop.vacant === true || leadType === "vacant",
    hasActiveListing: prop.active_listing === true,
    ownerOccupied: prop.owner_occupied === true,
    absenteeOutOfState: prop.out_of_state === true,
    batchRankScore: prop.lead_score,
    equityPct: prop.equity_percent,
    estimatedValue: prop.estimated_value,
    mortgageBalance: prop.mortgage_balance,
    listPrice: prop.list_price,
    daysOnMarket: prop.days_on_market,
    daysSinceExpiration: prop.days_on_market, // BatchLeads uses DOM for expired
    expirationCount: prop.times_expired,
    priceReductions: prop.price_reductions,
    phoneTypes,
    dnc: dncFlags,
    isLitigator: litigatorFlags,
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
    const leadType = LIST_NAME_TO_TYPE[list.name];
    if (leadType) {
      matchedLists.push({ id: list.id, leadType });
      console.log(`[BatchLeads] Found list: "${list.name}" → ${leadType} (id=${list.id})`);
    }
  }

  if (matchedLists.length === 0) {
    console.warn("[BatchLeads] No matching Lead Depot lists found. Create lists named:");
    Object.keys(LIST_NAME_TO_TYPE).forEach(name => console.warn(`  • ${name}`));
    return [];
  }

  // 2. Pull leads from each list, filter by recency
  const sinceMs = sinceHours * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const allLeads: BatchRawLead[] = [];

  for (const { id: listId, leadType } of matchedLists) {
    console.log(`[BatchLeads] Pulling ${leadType} leads from list ${listId} since ${cutoff}`);
    let page = 1;
    let fetched = 0;
    let total = Infinity;

    while (fetched < total) {
      try {
        const { properties, total: t } = await fetchBatchLeadsPage([listId], page);
        total = t;

        if (properties.length === 0) break;

        for (const prop of properties) {
          // Only process leads added within sinceHours
          const createdAt = prop.created_at || prop.updated_at || "";
          if (createdAt && createdAt < cutoff) {
            // Since sorted desc by created_at, once we hit older records we can stop
            fetched = total; // signal loop exit
            break;
          }

          // Fetch phone details for this property
          const contacts = await fetchPhoneDetails(prop.id);
          const normalized = normalizeBatchProperty(prop, leadType, contacts);
          allLeads.push(normalized);
        }

        fetched += properties.length;
        page++;

        // Safety: max 500 per list per run
        if (fetched >= 500) break;
      } catch (err) {
        console.error(`[BatchLeads] Error fetching list ${listId} page ${page}:`, err);
        break;
      }
    }

    console.log(`[BatchLeads] ${leadType}: pulled ${allLeads.filter(l => l.leadType === leadType).length} leads`);
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

  // Build dedup sets from existing leads
  const existingLeads = rawDb.prepare(`SELECT phone, address FROM leads`).all() as any[];
  const existingPhones = new Set<string>(
    existingLeads.map((l: any) => (l.phone || "").replace(/\D/g, "").slice(-10)).filter(Boolean)
  );
  const existingAddresses = new Set<string>(
    existingLeads.map((l: any) => (l.address || "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)
  );

  // Wrong number in last 90 days
  const wrongNumbers = rawDb.prepare(`
    SELECT DISTINCT l.phone FROM leads l
    JOIN activities a ON a.lead_id = l.id
    WHERE a.outcome = 'wrong_number'
      AND a.created_at > datetime('now', '-90 days')
  `).all() as any[];
  const recentWrongNumbers = new Set<string>(
    wrongNumbers.map((r: any) => (r.phone || "").replace(/\D/g, "").slice(-10))
  );

  // Not interested in last 180 days
  const notInterested = rawDb.prepare(`
    SELECT DISTINCT l.phone FROM leads l
    JOIN activities a ON a.lead_id = l.id
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

  const insertStmt = rawDb.prepare(`
    INSERT OR IGNORE INTO leads (
      owner_name, address, city, state, zip, phone, phones, phone_states, email,
      lead_type, status, score, territory, source, batch_id, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, 'batchleads', ?, datetime('now'))
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
        primaryPhone, allPhones, phoneStates, l.email || "",
        l.leadType, l.score, l.territory || "", batchId
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
