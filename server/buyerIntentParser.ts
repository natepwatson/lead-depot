// ─── buyerIntentParser.ts ──────────────────────────────────────────────────
// v20.5.0 — Parses jumbled buyer intent phrases from Denise's Excel notes AND
// concatenated FUB notes into a structured intent object with confidence score.
//
// Design philosophy: buyers describe what they want in scattered, jumbled prose.
// This parser is *deliberately forgiving* — it grabs whatever signals it can
// (price, area, beds, condition, financing) without demanding structure.
// Anything it can't extract stays in `raw_phrase` for the human agent.
//
// Called from:
//   - workbookParser.ts (on each Excel buyer row's notes column)
//   - fubSweep.ts (on concatenated FUB notes per person, chronological)
//   - routes.ts /api/leads/create (parses free-text on manual lead entry)

export interface ParsedIntent {
  raw_phrase: string;
  price_min: number | null;
  price_max: number | null;
  beds_min: number | null;
  baths_min: number | null;
  sqft_min: number | null;
  land_acres_min: number | null;
  lot_width_min: number | null;
  arv_min: number | null;
  arv_max: number | null;
  areas: string[];              // ["Yulee", "Jacksonville", "St Marys"]
  zip_codes: string[];          // ["32259", "32223"]
  property_types: string[];     // ["SFH", "land", "commercial", "condo"]
  conditions: string[];         // ["new_build", "reno", "fixer", "flip"]
  verbs: string[];              // ["downsize", "move_up", "investor", "gift"]
  financing: string | null;     // "cash" | "conventional" | "FHA" | "VA"
  is_investor: boolean;
  // v20.5.0 rental detection — rentals do NOT go to buyer inventory / map;
  // they route to a separate rentals bucket so the Buyers-on-the-Hunt list
  // stays clean for actual purchase buyers.
  is_rental: boolean;
  rental_type: string | null;   // "commercial_lease" | "residential_rental" | "land_lease" | null
  confidence: number;           // 0..1
}

// ─── Dictionaries ─────────────────────────────────────────────────────────

// Northeast Florida + Southeast Georgia known areas. Case-insensitive matching.
// Ordered by specificity: longer names first so "Ponte Vedra" matches before "Vedra".
const KNOWN_AREAS = [
  // Southeast GA (Camden County)
  "St Marys", "St. Marys", "Saint Marys", "Kingsland", "Woodbine",
  "Brunswick", "Jekyll Island", "St Simons", "Sea Island",
  // Nassau County FL
  "Fernandina Beach", "Fernandina", "Amelia Island", "Amelia", "Yulee",
  "Callahan", "Hilliard",
  // Duval County FL
  "Jax Beach", "Jacksonville Beach", "Neptune Beach", "Atlantic Beach",
  "Ponte Vedra", "Ponte Vedra Beach", "PVB",
  "Mandarin", "San Marco", "Riverside", "Avondale", "Ortega",
  "Southside", "Arlington", "Northside", "Westside",
  "Jax", "Jacksonville", "Duval",
  // St Johns County FL
  "St Augustine", "St. Augustine", "Saint Augustine", "St Johns",
  "Nocatee", "World Golf Village", "WGV",
  // Clay County
  "Orange Park", "Fleming Island", "Middleburg", "Green Cove Springs",
  // Broader
  "Nassau", "Georgia", "GA", "Florida", "FL", "NEFL",
];

// Property type dictionary — normalized values
const PROPERTY_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sfh|sfr|single[- ]family(?:\s+home)?)\b/i, "SFH"],
  [/\b(?:condo|condominium)s?\b/i, "condo"],
  [/\btownhouse|town[- ]home|townhome/i, "townhouse"],
  [/\bland|lot|acreage|acre[a-z]*\b/i, "land"],
  [/\bcommercial|retail|office|warehouse|industrial\b/i, "commercial"],
  [/\bmanufactured|mobile\s+home|manufac|singlewide|doublewide/i, "manufactured"],
  [/\branch\b/i, "ranch"],
  [/\bfarm\b/i, "farm"],
  [/\bmulti[- ]family|duplex|triplex|quadplex|fourplex/i, "multifamily"],
  [/\bhome|house|residential\b/i, "SFH"],  // catch-all, evaluated last
];

// Condition / renovation state
const CONDITION_PATTERNS: Array<[RegExp, string]> = [
  [/\bnew\s+(?:build|construction|home)|newly\s+built|new[- ]construction/i, "new_build"],
  [/\breno(?:vation|vate|vated)?\b/i, "reno"],
  [/\bfixer|fix[- ]?upper|handyman/i, "fixer"],
  [/\bflip(?:per)?\b/i, "flip"],
  [/\bturnkey|turn[- ]key|move[- ]?in\s+ready/i, "turnkey"],
  [/\bteardown|tear[- ]down|scrape/i, "teardown"],
];

// Verbs / intent
const VERB_PATTERNS: Array<[RegExp, string]> = [
  [/\bdownsiz(?:e|ing)/i, "downsize"],
  [/\bmove[- ]up|upsize|upsiz(?:e|ing)/i, "move_up"],
  [/\binvestor|invest(?:ing|ment)?/i, "investor"],
  [/\bfirst[- ]?time(?:\s+home)?\s*buyer/i, "first_time"],
  [/\brelocat(?:e|ing|ion)/i, "relocation"],
  [/\b(?:for|to)\s+(?:my|our)\s+(?:daughter|son|kids?|children|parents?|mom|dad)/i, "gift"],
  [/\b1031\s*exchange|1031/i, "1031"],
  [/\brental|income\s+property|cash[- ]?flow/i, "rental"],
  [/\bsecond\s+home|vacation\s+home|beach\s+house/i, "second_home"],
  [/\bmove\s+up|trad(?:e|ing)\s+up/i, "move_up"],
  [/\bbuild\b/i, "build"],
];

// Financing type
const FINANCING_PATTERNS: Array<[RegExp, string]> = [
  [/\bcash\s+(?:buyer|deal|offer|purchase)?|all[- ]cash/i, "cash"],
  [/\bconventional\b/i, "conventional"],
  [/\bFHA\b/i, "FHA"],
  [/\bVA\s+loan|VA\s+buyer|\bVA\b/i, "VA"],
  [/\bUSDA\b/i, "USDA"],
  [/\bhard[- ]?money|private\s+lender/i, "hard_money"],
];

// Luxury signal
const LUXURY_PATTERNS = /\bluxury|premium|high[- ]end|estate\b/i;

// ─── Rental detection ────────────────────────────────────────────────────────────────────
// A buyer note that says "lease", "rental", "renting", "want to rent", or
// "looking to rent" is a renter, not a buyer. We classify into commercial
// lease vs residential rental vs land lease so routing sends them to the
// right bucket (or skips inventory entirely).
//
// NEGATION guard: "lease-purchase" / "lease to own" / "rent-to-own" mean
// PURCHASE intent, so we return is_rental=false in those cases.
function detectRental(text: string): { is_rental: boolean; rental_type: string | null } {
  // Negation: lease-purchase / lease-to-own / rent-to-own is a BUY intent
  if (/\blease[- ]?(?:to[- ]?)?(?:purchase|own|buy)\b/i.test(text)) {
    return { is_rental: false, rental_type: null };
  }
  if (/\brent[- ]?to[- ]?own\b/i.test(text)) {
    return { is_rental: false, rental_type: null };
  }

  // Strong rental signals
  const rentalSignal =
    /\b(?:lease|rent(?:al|ing|er)?|leas(?:ing|ed)|looking\s+to\s+rent|want\s+to\s+rent|need\s+to\s+rent)\b/i.test(text);
  if (!rentalSignal) return { is_rental: false, rental_type: null };

  // Classify the rental type
  if (/\b(?:commercial|retail|office|warehouse|industrial)\b/i.test(text)) {
    return { is_rental: true, rental_type: "commercial_lease" };
  }
  if (/\b(?:land|lot|acre[a-z]*|farm|pasture)\b/i.test(text)) {
    // Only mark as land_lease if no beds/baths signal exists.
    if (!/\b[1-9]\s*(?:br|bd|bed(?:room)?s?|ba|bath(?:room)?s?)\b/i.test(text) &&
        !/\b[1-9]\s*\/\s*[1-9]/.test(text)) {
      return { is_rental: true, rental_type: "land_lease" };
    }
  }
  return { is_rental: true, rental_type: "residential_rental" };
}

// ─── Price extraction ─────────────────────────────────────────────────────

// Handle: "300-600k", "$300k-$600k", "under 300k", "over 200k", "$1.5M", "660k", "≤$550k"
function extractPrice(text: string): { min: number | null; max: number | null } {
  const t = text
    .replace(/\u2013|\u2014/g, "-")       // en/em dash → hyphen
    .replace(/\u2264/g, "<=")             // ≤ → <=
    .replace(/\u2265/g, ">=");            // ≥ → >=

  // Try range first — but ONLY if:
  //   (a) at least one side has $ prefix or k/m suffix, AND
  //   (b) the range is NOT immediately followed by an acreage unit (ac/acre)
  //       to avoid grabbing "2-10ac" as a price range.
  const rangeRe = /(\$?)([0-9]+(?:\.[0-9]+)?)(k|m)?\s*[-–—]\s*(\$?)([0-9]+(?:\.[0-9]+)?)(k|m)?(?!\s*(?:ac|acre))/gi;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangeRe.exec(t)) !== null) {
    const [, dollar1, n1, unit1raw, dollar2, n2, unit2raw] = rangeMatch;
    const hasMoneySignal = !!(dollar1 || dollar2 || unit1raw || unit2raw);
    if (!hasMoneySignal) continue;  // "3-2" is beds/baths, skip
    const unit1 = unit1raw || unit2raw || "k";
    const unit2 = unit2raw || unit1raw || "k";
    return {
      min: applyUnit(parseFloat(n1), unit1),
      max: applyUnit(parseFloat(n2), unit2),
    };
  }

  // "under 300k" / "less than 400k" / "<= 550k"
  const underMatch = t.match(/(?:under|less\s+than|<=|<|max|up\s+to|≤)\s*\$?([0-9]+(?:\.[0-9]+)?)(k|m)?/i);
  if (underMatch) {
    return { min: null, max: applyUnit(parseFloat(underMatch[1]), underMatch[2] || "k") };
  }

  // "over 200" / ">= 300k"
  const overMatch = t.match(/(?:over|more\s+than|>=|>|min|starting)\s*\$?([0-9]+(?:\.[0-9]+)?)(k|m)?/i);
  if (overMatch) {
    return { min: applyUnit(parseFloat(overMatch[1]), overMatch[2] || "k"), max: null };
  }

  // Single price: "$660k", "660k", "$1.5M", "$65k"
  const singleMatch = t.match(/\$?([0-9]+(?:\.[0-9]+)?)(k|m)\b/i);
  if (singleMatch) {
    const v = applyUnit(parseFloat(singleMatch[1]), singleMatch[2]);
    return { min: v, max: v };
  }

  return { min: null, max: null };
}

function applyUnit(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "k") return Math.round(n * 1000);
  if (u === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

// ─── Beds/baths extraction ────────────────────────────────────────────────

// Handles: "4 BR", "2BR", "3/2", "4br 2ba", "4 bed 3 bath", "3 bd", "4 bedroom"
function extractBedsBaths(text: string): { beds: number | null; baths: number | null } {
  // "3/2" or "4/3.5" style
  const slash = text.match(/\b([1-9])\s*\/\s*([1-9](?:\.5)?)\b/);
  if (slash) {
    return { beds: parseInt(slash[1], 10), baths: parseFloat(slash[2]) };
  }

  let beds: number | null = null;
  let baths: number | null = null;

  const bedsMatch = text.match(/\b([1-9])\s*(?:br|bd|bed(?:room)?s?)\b/i);
  if (bedsMatch) beds = parseInt(bedsMatch[1], 10);

  const bathsMatch = text.match(/\b([1-9](?:\.5)?)\s*(?:ba|bath(?:room)?s?)\b/i);
  if (bathsMatch) baths = parseFloat(bathsMatch[1]);

  return { beds, baths };
}

// ─── Sqft extraction ──────────────────────────────────────────────────────
// "2000 SF", "over 2000 SF", "1500 sqft", "1500 square feet"
function extractSqft(text: string): number | null {
  const m = text.match(/(?:over\s+)?([0-9,]+)\s*(?:sf|sqft|sq\s*ft|square\s*feet)\b/i);
  if (m) return parseInt(m[1].replace(/,/g, ""), 10);
  return null;
}

// ─── Land/acreage extraction ──────────────────────────────────────────────
// "1+acre", "2-10ac", "5 acres", "1 acre"
function extractLandAcres(text: string): number | null {
  // "2-10ac" or "2-10 acres" — take the min
  const range = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[-–]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:ac|acres?)\b/i);
  if (range) return parseFloat(range[1]);
  // "1+acre"
  const plus = text.match(/([0-9]+(?:\.[0-9]+)?)\s*\+\s*(?:ac|acres?)\b/i);
  if (plus) return parseFloat(plus[1]);
  // "1 acre" / "2.5 acres"
  const single = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:ac|acres?)\b/i);
  if (single) return parseFloat(single[1]);
  return null;
}

// ─── Lot width extraction (luxury signal) ─────────────────────────────────
// "80'+ lot", "100' lot", "80 foot lot"
function extractLotWidth(text: string): number | null {
  const m = text.match(/([0-9]{2,3})\s*['']?\s*\+?\s*(?:foot|ft|')\s*lot\b/i);
  if (m) return parseInt(m[1], 10);
  const m2 = text.match(/([0-9]{2,3})\s*['']?\s*\+?\s*lot\b/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// ─── ARV extraction (investor buyers) ─────────────────────────────────────
// "ARV 250-300k", "ARV of $400k"
function extractARV(text: string): { min: number | null; max: number | null } {
  const arvMatch = text.match(/\bARV\s*(?:of)?\s*\$?([0-9]+(?:\.[0-9]+)?)(k|m)?(?:\s*[-–]\s*\$?([0-9]+(?:\.[0-9]+)?)(k|m)?)?/i);
  if (!arvMatch) return { min: null, max: null };
  const unit1 = arvMatch[2] || arvMatch[4] || "k";
  const unit2 = arvMatch[4] || arvMatch[2] || "k";
  return {
    min: applyUnit(parseFloat(arvMatch[1]), unit1),
    max: arvMatch[3] ? applyUnit(parseFloat(arvMatch[3]), unit2) : null,
  };
}

// ─── ZIP code extraction ──────────────────────────────────────────────────
// "32259, 32223, 32095"
function extractZips(text: string): string[] {
  const zips = new Set<string>();
  const re = /\b(3[0-9]{4})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    zips.add(m[1]);
  }
  return Array.from(zips);
}

// ─── Area extraction ──────────────────────────────────────────────────────
// Match known Northeast FL / Southeast GA area names, case-insensitive
function extractAreas(text: string): string[] {
  const found = new Set<string>();
  for (const area of KNOWN_AREAS) {
    // Whole-word boundary match, case-insensitive
    const escaped = area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) {
      // Canonicalize a few common aliases
      let canonical = area;
      if (/^(jax|jacksonville|duval)$/i.test(area)) canonical = "Jacksonville";
      if (/^(jax\s*beach|jacksonville\s*beach)$/i.test(area)) canonical = "Jax Beach";
      if (/^(st|saint|st\.)\s*marys$/i.test(area)) canonical = "St Marys";
      if (/^(st|saint|st\.)\s*augustine$/i.test(area)) canonical = "St Augustine";
      if (/^(st|saint|st\.)\s*johns$/i.test(area)) canonical = "St Johns";
      if (/^(ponte\s*vedra|pvb)$/i.test(area)) canonical = "Ponte Vedra";
      if (/^amelia\s*(island)?$/i.test(area)) canonical = "Amelia Island";
      if (/^fernandina\s*(beach)?$/i.test(area)) canonical = "Fernandina Beach";
      found.add(canonical);
    }
  }
  return Array.from(found);
}

// ─── Multi-pattern extraction helpers ─────────────────────────────────────
function extractMatchingPatterns(text: string, patterns: Array<[RegExp, string]>): string[] {
  const found = new Set<string>();
  for (const [re, label] of patterns) {
    if (re.test(text)) found.add(label);
  }
  return Array.from(found);
}

function extractFirstMatch(text: string, patterns: Array<[RegExp, string]>): string | null {
  for (const [re, label] of patterns) {
    if (re.test(text)) return label;
  }
  return null;
}

// ─── Confidence scoring ───────────────────────────────────────────────────
// Weighted: price + area = highest signal. beds/baths medium. verbs bonus.
function computeConfidence(p: Omit<ParsedIntent, "confidence">): number {
  let score = 0;
  let signals = 0;

  if (p.price_min != null || p.price_max != null) { score += 0.30; signals++; }
  if (p.areas.length > 0)              { score += 0.25; signals++; }
  if (p.property_types.length > 0)     { score += 0.15; signals++; }
  if (p.beds_min != null || p.baths_min != null) { score += 0.12; signals++; }
  if (p.conditions.length > 0)         { score += 0.05; signals++; }
  if (p.verbs.length > 0)              { score += 0.05; signals++; }
  if (p.financing != null)             { score += 0.03; signals++; }
  if (p.land_acres_min != null)        { score += 0.03; signals++; }
  if (p.sqft_min != null)              { score += 0.02; signals++; }
  if (p.is_rental)                     { score += 0.20; signals++; }

  return Math.min(1, score);
}

// ─── Main entry point ─────────────────────────────────────────────────────

export function parseIntent(rawText: string | null | undefined): ParsedIntent {
  const text = (rawText || "").trim();

  const empty: ParsedIntent = {
    raw_phrase: text,
    price_min: null, price_max: null,
    beds_min: null, baths_min: null,
    sqft_min: null, land_acres_min: null, lot_width_min: null,
    arv_min: null, arv_max: null,
    areas: [], zip_codes: [], property_types: [], conditions: [], verbs: [],
    financing: null, is_investor: false,
    is_rental: false, rental_type: null,
    confidence: 0,
  };

  if (!text) return empty;

  const rental = detectRental(text);
  const price = extractPrice(text);
  const bedsBaths = extractBedsBaths(text);
  const arv = extractARV(text);
  const verbs = extractMatchingPatterns(text, VERB_PATTERNS);
  const propertyTypes = extractMatchingPatterns(text, PROPERTY_TYPE_PATTERNS);

  // Dedupe property_types — "SFH" wins over generic "home" if both matched
  const uniqueTypes = Array.from(new Set(propertyTypes));

  const parsed: Omit<ParsedIntent, "confidence"> = {
    raw_phrase: text,
    price_min: price.min,
    price_max: price.max,
    beds_min: bedsBaths.beds,
    baths_min: bedsBaths.baths,
    sqft_min: extractSqft(text),
    land_acres_min: extractLandAcres(text),
    lot_width_min: extractLotWidth(text),
    arv_min: arv.min,
    arv_max: arv.max,
    areas: extractAreas(text),
    zip_codes: extractZips(text),
    property_types: uniqueTypes,
    conditions: extractMatchingPatterns(text, CONDITION_PATTERNS),
    verbs,
    financing: extractFirstMatch(text, FINANCING_PATTERNS),
    is_investor: verbs.includes("investor") || /\binvestor\b/i.test(text),
    is_rental: rental.is_rental,
    rental_type: rental.rental_type,
  };

  return { ...parsed, confidence: computeConfidence(parsed) };
}

// ─── Multi-phrase parsing (for FUB notes concatenation) ───────────────────
//
// When we sweep a person from FUB, we concatenate ALL their notes chronologically.
// The parser should treat that as a single blob but preserve the most recent
// note's signals when there's a conflict (e.g., "originally 300k, now 500k").
//
// Strategy: parse the whole blob first, then reparse the LAST 500 chars separately
// and let the "recent" values override the "historical" ones for price/beds/areas.

export function parseMultiPhrase(phrases: string[]): ParsedIntent {
  if (!phrases.length) return parseIntent("");
  const combined = phrases.join(" • ");
  const combinedParsed = parseIntent(combined);
  const recent = phrases[phrases.length - 1];
  const recentParsed = parseIntent(recent);

  // Recent wins for price/beds/baths/rental if present.
  // Rental: if EITHER combined or recent detected rental, treat as rental.
  // Someone who said "looking to rent" 6 months ago and now says "$400k Yulee"
  // has flipped to buy — but we stay conservative and keep rental=true unless
  // recent parse explicitly shows purchase signals (price + no rental words).
  const recentIsPurchase = !recentParsed.is_rental && (recentParsed.price_min || recentParsed.price_max);
  const finalIsRental = recentIsPurchase ? false : (recentParsed.is_rental || combinedParsed.is_rental);
  return {
    ...combinedParsed,
    raw_phrase: combined,
    price_min:  recentParsed.price_min  ?? combinedParsed.price_min,
    price_max:  recentParsed.price_max  ?? combinedParsed.price_max,
    beds_min:   recentParsed.beds_min   ?? combinedParsed.beds_min,
    baths_min:  recentParsed.baths_min  ?? combinedParsed.baths_min,
    financing:  recentParsed.financing  ?? combinedParsed.financing,
    is_rental:  finalIsRental,
    rental_type: finalIsRental ? (recentParsed.rental_type || combinedParsed.rental_type) : null,
    // Areas and types accumulate (union), not overwrite
    areas: Array.from(new Set([...combinedParsed.areas, ...recentParsed.areas])),
    property_types: Array.from(new Set([...combinedParsed.property_types, ...recentParsed.property_types])),
    conditions: Array.from(new Set([...combinedParsed.conditions, ...recentParsed.conditions])),
    verbs: Array.from(new Set([...combinedParsed.verbs, ...recentParsed.verbs])),
    zip_codes: Array.from(new Set([...combinedParsed.zip_codes, ...recentParsed.zip_codes])),
    confidence: Math.max(combinedParsed.confidence, recentParsed.confidence),
  };
}

// ─── DB serialization helpers ─────────────────────────────────────────────

export function intentToDbRow(intent: ParsedIntent): Record<string, any> {
  return {
    intent_phrases:         JSON.stringify([intent.raw_phrase]),
    price_min:              intent.price_min,
    price_max:              intent.price_max,
    beds_min:               intent.beds_min,
    baths_min:              intent.baths_min,
    sqft_min:               intent.sqft_min,
    land_acres_min:         intent.land_acres_min,
    lot_width_min:          intent.lot_width_min,
    arv_min:                intent.arv_min,
    arv_max:                intent.arv_max,
    preferred_areas:        intent.areas.join(",") || null,
    zip_codes:              intent.zip_codes.join(",") || null,
    intent_property_types:  intent.property_types.join(",") || null,
    intent_conditions:      intent.conditions.join(",") || null,
    intent_verbs:           intent.verbs.join(",") || null,
    financing:              intent.financing,
    is_investor:            intent.is_investor ? 1 : 0,
    is_rental:              intent.is_rental ? 1 : 0,
    rental_type:            intent.rental_type,
    confidence:             intent.confidence,
    notes:                  intent.raw_phrase || null,
  };
}
