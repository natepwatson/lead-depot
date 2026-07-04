// ─── LANDVOICE LEAD GEN PIPELINE ─────────────────────────────────────────────
// Item 14 — Gather, Refine, Score, Dedupe, Upload
// Runs daily at 6:00 AM EDT (10:00 UTC) via scheduled cron
//
// SETUP: Set LANDVOICE_API_KEY environment variable in Railway
// ─────────────────────────────────────────────────────────────────────────────

import { ALL_NE_FLORIDA_ZIPS, getTerritoryForZip } from "./territories";

const LANDVOICE_API_KEY = process.env.LANDVOICE_API_KEY || "";
const LANDVOICE_BASE = "https://api.landvoice.com/v1"; // confirm with Landvoice docs

// ─── LEAD TYPES TO PULL ───────────────────────────────────────────────────────
const LEAD_TYPE_MAP: Record<string, string> = {
  expired:         "expired",
  fsbo:            "fsbo",
  preforeclosure:  "preforeclosure",
  distressed:      "distressed",
  land:            "land",
};

// ─── TRUST / ENTITY DETECTION ─────────────────────────────────────────────────
const ENTITY_KEYWORDS = [
  "trust", "llc", "l.l.c", "inc", "corp", "incorporated", "partners", "partnership",
  "holdings", "properties", "investments", "realty", "group", "fund", "estate of",
  "revocable", "irrevocable", "family trust", "living trust", "land trust",
];

function isEntityOwner(ownerName: string): boolean {
  const lower = ownerName.toLowerCase();
  return ENTITY_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── BLANK / LAW ENFORCEMENT ADDRESS DETECTION ────────────────────────────────
function hasBlankAddress(address: string): boolean {
  if (!address || address.trim().length < 5) return true;
  const lower = address.toLowerCase().trim();
  // Law enforcement privacy blocks often produce placeholder values
  const BLANK_PATTERNS = ["unknown", "confidential", "private", "redacted", "n/a", "none", "withheld", "protected"];
  return BLANK_PATTERNS.some(p => lower.includes(p));
}

// ─── PHONE VALIDATION ─────────────────────────────────────────────────────────
function isCallablePhone(phone: string): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return false;
  const area = digits.slice(-10, -7);
  // Known non-callable prefixes
  const NON_CALLABLE = ["000", "555", "900", "976", "800", "888", "877", "866", "855", "844", "833", "822"];
  if (NON_CALLABLE.includes(area)) return false;
  return true;
}

// ─── EQUITY ESTIMATION ────────────────────────────────────────────────────────
function estimateEquityPct(listPrice: number, estimatedValue: number, mortgageBalance?: number): number {
  if (!listPrice && !estimatedValue) return 0;
  const value = estimatedValue || listPrice;
  if (!mortgageBalance) return 40; // assume moderate equity if unknown
  return Math.round(((value - mortgageBalance) / value) * 100);
}

// ─── LEAD SCORER ──────────────────────────────────────────────────────────────
export interface LandvoiceRawLead {
  ownerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  phone2?: string;
  email?: string;
  listPrice?: number;
  estimatedValue?: number;
  mortgageBalance?: number;
  daysOnMarket?: number;
  daysSinceExpiration?: number;
  expirationCount?: number;    // how many times expired
  priceReductions?: number;
  ownerOccupied?: boolean;
  absenteeOutOfState?: boolean;
  leadType: string;
  sourceId?: string;           // Landvoice internal ID for dedup
  isPreforeclosure?: boolean;
  isFsbo?: boolean;
  isVacant?: boolean;
  hasActiveListing?: boolean;  // re-listed with an active agent
  listedWithAgent?: boolean;
  phoneType?: string;          // "mobile" | "landline" | "voip"
}

export interface ScoredLead extends LandvoiceRawLead {
  score: number;
  scoreBreakdown: string[];
  territory: string | null;
  priority: "priority" | "standard" | "reserve" | "discard";
  filterReason?: string;       // set if filtered out
}

export function scoreLead(raw: LandvoiceRawLead): ScoredLead {
  const breakdown: string[] = [];
  let score = 0;

  // ── Expired-specific ──
  const expCount = raw.expirationCount || 1;
  if (expCount >= 2) { score += 5; breakdown.push(`+5 expired ${expCount}x`); }

  const dse = raw.daysSinceExpiration || 0;
  if (dse <= 30)        { score += 4; breakdown.push("+4 expired <30 days ago"); }
  else if (dse <= 90)   { score += 3; breakdown.push("+3 expired 31–90 days ago"); }
  else if (dse <= 180)  { score += 2; breakdown.push("+2 expired 91–180 days ago"); }
  else if (dse <= 540)  { score += 1; breakdown.push("+1 expired 181–540 days ago"); }

  // ── Price reductions ──
  if ((raw.priceReductions || 0) >= 2) { score += 3; breakdown.push("+3 price reduced 2+ times"); }

  // ── Equity ──
  const equity = estimateEquityPct(raw.listPrice || 0, raw.estimatedValue || 0, raw.mortgageBalance);
  if (equity >= 50)      { score += 5; breakdown.push(`+5 equity ~${equity}% (high)`); }
  else if (equity >= 30) { score += 3; breakdown.push(`+3 equity ~${equity}% (moderate)`); }

  // ── Pre-foreclosure ──
  if (raw.isPreforeclosure) { score += 4; breakdown.push("+4 pre-foreclosure (NOD filed)"); }

  // ── Owner occupied ──
  if (raw.ownerOccupied) { score += 2; breakdown.push("+2 owner-occupied"); }

  // ── Absentee out of state ──
  if (raw.absenteeOutOfState) { score += 1; breakdown.push("+1 absentee out-of-state"); }

  // ── FSBO ──
  if (raw.isFsbo) { score += 2; breakdown.push("+2 FSBO"); }

  // ── Vacant / distressed ──
  if (raw.isVacant) { score += 2; breakdown.push("+2 vacant/distressed signal"); }

  // ── Mobile phone confirmed ──
  if (raw.phoneType === "mobile") { score += 3; breakdown.push("+3 mobile phone confirmed"); }

  // ── Territory match ──
  const territory = getTerritoryForZip(raw.zip);
  if (territory) { score += 2; breakdown.push(`+2 in active territory (${territory})`); }

  // ── Priority tier ──
  let priority: ScoredLead["priority"];
  if (score >= 12)      priority = "priority";
  else if (score >= 7)  priority = "standard";
  else if (score >= 4)  priority = "reserve";
  else                  priority = "discard";

  return { ...raw, score, scoreBreakdown: breakdown, territory, priority };
}

// ─── HARD FILTER CHAIN ────────────────────────────────────────────────────────
export function filterLead(
  raw: LandvoiceRawLead,
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

  // 3. No phone number
  if (!raw.phone && !raw.phone2) {
    return { pass: false, reason: "no_phone" };
  }

  // 4. Non-callable phone
  const primaryPhone = (raw.phone || raw.phone2 || "").replace(/\D/g, "");
  if (!isCallablePhone(primaryPhone)) {
    return { pass: false, reason: `non_callable_phone (${raw.phone})` };
  }

  // 5. Re-listed with active agent
  if (raw.hasActiveListing || raw.listedWithAgent) {
    return { pass: false, reason: "re_listed_with_active_agent" };
  }

  // 6. Already in Lead Depot (phone match)
  if (existingPhones.has(primaryPhone.slice(-10))) {
    return { pass: false, reason: "duplicate_phone" };
  }

  // 7. Already in Lead Depot (address match)
  const normalizedAddr = raw.address.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (existingAddresses.has(normalizedAddr)) {
    return { pass: false, reason: "duplicate_address" };
  }

  // 8. Recently marked wrong number (90-day block)
  if (recentWrongNumbers.has(primaryPhone.slice(-10))) {
    return { pass: false, reason: "wrong_number_logged_90d" };
  }

  // 9. Recently marked not interested (180-day block)
  if (recentNotInterested.has(primaryPhone.slice(-10))) {
    return { pass: false, reason: "not_interested_logged_180d" };
  }

  // 10. Only goes back 18 months for expired
  if (raw.leadType === "expired" && (raw.daysSinceExpiration || 0) > 540) {
    return { pass: false, reason: "expired_too_old (>18 months)" };
  }

  return { pass: true };
}

// ─── LANDVOICE API FETCHER ────────────────────────────────────────────────────
// NOTE: Exact endpoints/params to be confirmed once API key + docs are in hand
export async function fetchLandvoiceLeads(
  leadType: string,
  zipcodes: string[],
  daysSince: number = 1, // pull last N days on each run
): Promise<LandvoiceRawLead[]> {
  if (!LANDVOICE_API_KEY) {
    console.warn("[Landvoice] No API key set — skipping fetch");
    return [];
  }

  const results: LandvoiceRawLead[] = [];

  // Landvoice may require zip-by-zip queries — batch them
  const BATCH = 10;
  for (let i = 0; i < zipcodes.length; i += BATCH) {
    const batch = zipcodes.slice(i, i + BATCH);
    try {
      const params = new URLSearchParams({
        api_key: LANDVOICE_API_KEY,
        type: leadType,
        zips: batch.join(","),
        days: String(daysSince),
        limit: "1000",
      });
      const url = `${LANDVOICE_BASE}/leads?${params}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[Landvoice] ${leadType} batch ${i}–${i + BATCH} failed: ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      const rawLeads = data.leads || data.data || data.results || [];

      for (const r of rawLeads) {
        // Normalize Landvoice field names → our LandvoiceRawLead shape
        // Field names will need confirming against actual API docs
        results.push({
          ownerName:          r.owner_name || r.ownerName || r.name || "",
          address:            r.property_address || r.address || "",
          city:               r.city || "",
          state:              r.state || "FL",
          zip:                r.zip || r.postal_code || "",
          phone:              r.phone1 || r.phone || "",
          phone2:             r.phone2 || "",
          email:              r.email || "",
          listPrice:          parseFloat(r.list_price || r.listPrice || "0") || 0,
          estimatedValue:     parseFloat(r.estimated_value || r.avm || "0") || 0,
          mortgageBalance:    parseFloat(r.mortgage_balance || "0") || 0,
          daysOnMarket:       parseInt(r.days_on_market || "0") || 0,
          daysSinceExpiration: parseInt(r.days_since_expiration || r.days_expired || "0") || 0,
          expirationCount:    parseInt(r.expiration_count || r.times_expired || "1") || 1,
          priceReductions:    parseInt(r.price_reductions || "0") || 0,
          ownerOccupied:      r.owner_occupied === true || r.owner_occupied === "true",
          absenteeOutOfState: r.absentee_out_of_state === true,
          isPreforeclosure:   leadType === "preforeclosure",
          isFsbo:             leadType === "fsbo",
          isVacant:           r.vacant === true,
          hasActiveListing:   r.has_active_listing === true || r.active_listing === true,
          listedWithAgent:    r.listed_with_agent === true,
          phoneType:          r.phone_type || r.phoneType || "",
          sourceId:           r.id || r.lead_id || "",
          leadType,
        });
      }
    } catch (err) {
      console.error(`[Landvoice] Error fetching ${leadType} batch ${i}:`, err);
    }
  }

  return results;
}

// ─── MAIN PIPELINE RUNNER ─────────────────────────────────────────────────────
export async function runLandvoicePipeline(rawDb: any): Promise<{
  fetched: number;
  filtered: number;
  priority: number;
  standard: number;
  reserve: number;
  discarded: number;
  byType: Record<string, number>;
}> {
  console.log("[Landvoice] Starting daily lead gen pipeline...");

  // Build dedup sets from existing leads
  const existingLeads = rawDb.prepare(`
    SELECT phone, address FROM leads
  `).all() as any[];

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

  const stats = { fetched: 0, filtered: 0, priority: 0, standard: 0, reserve: 0, discarded: 0, byType: {} as Record<string, number> };
  const toInsert: ScoredLead[] = [];

  for (const [typeKey, typeLabel] of Object.entries(LEAD_TYPE_MAP)) {
    // Expired goes back 18 months on first run, daily delta after
    const daysSince = typeKey === "expired" ? 540 : 1;
    const raw = await fetchLandvoiceLeads(typeKey, ALL_NE_FLORIDA_ZIPS, daysSince);
    console.log(`[Landvoice] Fetched ${raw.length} ${typeKey} leads`);
    stats.fetched += raw.length;

    for (const lead of raw) {
      const filter = filterLead(lead, existingPhones, existingAddresses, recentWrongNumbers, recentNotInterested);
      if (!filter.pass) {
        console.log(`[Landvoice] FILTERED (${filter.reason}): ${lead.ownerName} — ${lead.address}`);
        stats.filtered++;
        continue;
      }

      const scored = scoreLead(lead);
      if (scored.priority === "discard") { stats.discarded++; continue; }

      toInsert.push(scored);
      stats.byType[typeKey] = (stats.byType[typeKey] || 0) + 1;
      if (scored.priority === "priority") stats.priority++;
      else if (scored.priority === "standard") stats.standard++;
      else if (scored.priority === "reserve") stats.reserve++;
    }
  }

  // Insert all passing leads — priority first (they get lower IDs = go first in round-robin)
  const sorted = [
    ...toInsert.filter(l => l.priority === "priority"),
    ...toInsert.filter(l => l.priority === "standard"),
    ...toInsert.filter(l => l.priority === "reserve"),
  ];

  const insertStmt = rawDb.prepare(`
    INSERT INTO leads (
      owner_name, address, city, state, zip, phone, email,
      lead_type, status, score, territory, source, batch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, 'landvoice', ?, datetime('now'), datetime('now'))
  `);

  const batchId = `landvoice_${new Date().toISOString().slice(0, 10)}`;
  const insertAll = rawDb.transaction((leads: ScoredLead[]) => {
    for (const l of leads) {
      insertStmt.run(
        l.ownerName, l.address, l.city, l.state, l.zip,
        l.phone.replace(/\D/g, "").slice(-10), l.email || "",
        l.leadType, l.score, l.territory || "", batchId
      );
    }
  });
  insertAll(sorted);

  console.log(`[Landvoice] Pipeline complete. Inserted ${sorted.length} leads. Priority: ${stats.priority}, Standard: ${stats.standard}, Reserve: ${stats.reserve}. Filtered: ${stats.filtered}, Discarded: ${stats.discarded}.`);
  return stats;
}
