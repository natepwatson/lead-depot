// server/normalize.ts — v14.16
// Universal normalization helpers for names, addresses, cities, and states.
// Used across email templates, script previews, lead card display, and FUB payloads.
//
// Two address styles:
//   normalizeAddressCasual  → "456 Main"  (used in email bodies + script openers)
//   normalizeAddressFull    → "456 SE Main St Apt 3B"  (used in lead cards + FUB + maps)

// ─── PROPER CASE ────────────────────────────────────────────────────────────
// Title-case a token while preserving hyphens (Sarah-Anne), apostrophes (O'Brien),
// and Mc/Mac prefixes (McDonald, MacGregor).
function properCaseToken(token: string): string {
  if (!token) return "";
  const lower = token.toLowerCase();

  // Handle hyphenated: Sarah-Anne
  if (lower.includes("-")) {
    return lower.split("-").map(properCaseToken).join("-");
  }
  // Handle apostrophes: O'Brien, D'Angelo
  if (lower.includes("'")) {
    return lower.split("'").map((p, i) => (i === 0 ? properCaseToken(p) : properCaseToken(p))).join("'");
  }
  // Handle Mc / Mac prefixes
  if (lower.startsWith("mc") && lower.length > 2) {
    return "Mc" + lower.charAt(2).toUpperCase() + lower.slice(3);
  }
  if (lower.startsWith("mac") && lower.length > 3) {
    return "Mac" + lower.charAt(3).toUpperCase() + lower.slice(4);
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function properCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map(properCaseToken)
    .join(" ");
}

// ─── FIRST NAME ─────────────────────────────────────────────────────────────
// Handles: "SMITH, SARAH J" → "Sarah"
//          "JOHN & MARY WATSON" → "John"
//          "robert m jr." → "Robert"
//          "SARAH-ANNE MCDONALD" → "Sarah-Anne"
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "esq", "phd", "md"]);

export function normalizeFirstName(raw: string | null | undefined): string {
  if (!raw) return "there";
  let s = String(raw).trim();
  if (!s) return "there";

  // Handle "LAST, FIRST" — take after comma
  if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length >= 2) s = parts[1].trim();
  }

  // Handle "JOHN & MARY" or "JOHN AND MARY" — take first person
  s = s.split(/\s+&\s+|\s+and\s+/i)[0].trim();

  // Split on whitespace, filter out suffixes and single-letter middles
  const tokens = s.split(/\s+/).filter((t) => {
    const clean = t.toLowerCase().replace(/\./g, "");
    if (!clean) return false;
    if (SUFFIXES.has(clean)) return false;
    if (clean.length === 1) return false; // drop middle initials
    return true;
  });

  const first = tokens[0];
  if (!first || first.length < 2) return "there";
  return properCaseToken(first);
}

// ─── FULL NAME ──────────────────────────────────────────────────────────────
// Handles: "SMITH, SARAH J" → "Sarah Smith"
//          "JOHN WATSON JR" → "John Watson"
//          "MARY O'BRIEN" → "Mary O'Brien"
export function normalizeFullName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";

  let firstName = "";
  let lastName = "";

  if (s.includes(",")) {
    // "LAST, FIRST MIDDLE" format
    const [last, rest] = s.split(",", 2).map((p) => p.trim());
    lastName = last;
    const restTokens = (rest || "").split(/\s+/).filter((t) => {
      const clean = t.toLowerCase().replace(/\./g, "");
      return clean && !SUFFIXES.has(clean) && clean.length > 1;
    });
    firstName = restTokens[0] || "";
  } else {
    // "FIRST MIDDLE LAST" or "FIRST LAST"
    s = s.split(/\s+&\s+|\s+and\s+/i)[0].trim();
    const tokens = s.split(/\s+/).filter((t) => {
      const clean = t.toLowerCase().replace(/\./g, "");
      return clean && !SUFFIXES.has(clean);
    });
    // Filter middle initials from the middle
    const filtered = tokens.filter((t, i) => {
      if (i === 0 || i === tokens.length - 1) return true;
      return t.replace(/\./g, "").length > 1;
    });
    if (filtered.length === 1) return properCase(filtered[0]);
    firstName = filtered[0] || "";
    lastName = filtered[filtered.length - 1] || "";
  }

  const result = [firstName, lastName].filter(Boolean).map(properCase).join(" ");
  return result || properCase(s);
}

// ─── ADDRESS ────────────────────────────────────────────────────────────────
// Directionals to strip in casual mode + normalize in full mode
const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);

// Street-type suffixes (strip in casual mode)
const STREET_TYPES = new Set([
  "st", "street",
  "ave", "avenue", "av",
  "blvd", "boulevard",
  "rd", "road",
  "dr", "drive",
  "ln", "lane",
  "ct", "court",
  "pl", "place",
  "way",
  "ter", "terrace",
  "cir", "circle",
  "pkwy", "parkway",
  "hwy", "highway",
  "trl", "trail",
  "loop",
  "row",
  "cv", "cove",
  "run",
  "path",
  "ridge",
  "walk",
]);

// Unit designators + everything after (strip in casual mode)
const UNIT_DESIGNATORS = new Set(["apt", "apartment", "unit", "ste", "suite", "#", "no", "number", "lot", "bldg", "building", "fl", "floor"]);

// Casual: "456 SE MAIN ST APT 3B" → "456 Main"
// Rules:
// - Keep house number
// - Strip directionals (SE, N, etc.)
// - Strip unit designators + everything after
// - Strip street-type suffix (ST, AVE, BLVD, etc.)
// - Keep everything else that's part of the street name (proper-cased)
// - Two-word street names stay two words ("Ponte Vedra")
// - Numbered streets drop the type ("42nd", not "42nd St")
export function normalizeAddressCasual(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";

  // Split off city/state/zip if present (comma delimiter)
  s = s.split(",")[0].trim();

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  // Find where units start — strip that token and everything after
  let unitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase().replace(/[.,]/g, "");
    if (UNIT_DESIGNATORS.has(t) || t.startsWith("#")) {
      unitIdx = i;
      break;
    }
  }
  const trimmed = unitIdx >= 0 ? tokens.slice(0, unitIdx) : tokens;

  // House number is first token if numeric
  const first = trimmed[0];
  const houseNumber = first && /^\d+[a-z]?$/i.test(first) ? first : "";
  const streetTokens = houseNumber ? trimmed.slice(1) : trimmed;

  // Strip directionals from anywhere in street tokens
  let streetWords = streetTokens.filter((t) => {
    const clean = t.toLowerCase().replace(/[.,]/g, "");
    return !DIRECTIONALS.has(clean);
  });

  // Strip trailing street-type suffix
  while (streetWords.length > 0) {
    const last = streetWords[streetWords.length - 1].toLowerCase().replace(/[.,]/g, "");
    if (STREET_TYPES.has(last)) {
      streetWords = streetWords.slice(0, -1);
    } else {
      break;
    }
  }

  if (streetWords.length === 0) {
    return houseNumber || "";
  }

  // Proper-case each street word, preserving numbered streets ("42nd", "3rd")
  const streetName = streetWords
    .map((w) => {
      const clean = w.replace(/[.,]/g, "");
      // Keep numbered ordinals lowercase (42nd, 3rd, 1st)
      if (/^\d+(st|nd|rd|th)$/i.test(clean)) return clean.toLowerCase();
      return properCaseToken(clean);
    })
    .join(" ");

  return houseNumber ? `${houseNumber} ${streetName}` : streetName;
}

// Full: "456 SE MAIN ST APT 3B" → "456 SE Main St Apt 3B"
export function normalizeAddressFull(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";

  // Preserve original comma-separated parts (street, city, state, zip)
  const parts = s.split(",").map((p) => p.trim());
  const streetPart = parts[0];

  const tokens = streetPart.split(/\s+/).filter(Boolean);
  const normalized = tokens.map((t, i) => {
    const clean = t.replace(/\./g, "");
    const lower = clean.toLowerCase();

    // Preserve numbered ordinals lowercase
    if (/^\d+(st|nd|rd|th)$/i.test(clean)) return clean.toLowerCase();
    // Pure numbers stay as-is
    if (/^\d+[a-z]?$/i.test(clean)) return clean;
    // Directionals — uppercase
    if (DIRECTIONALS.has(lower)) return clean.toUpperCase();
    // Street types — title-case abbreviation form
    if (STREET_TYPES.has(lower)) {
      // Common short forms
      const map: Record<string, string> = {
        st: "St", street: "St",
        ave: "Ave", avenue: "Ave", av: "Ave",
        blvd: "Blvd", boulevard: "Blvd",
        rd: "Rd", road: "Rd",
        dr: "Dr", drive: "Dr",
        ln: "Ln", lane: "Ln",
        ct: "Ct", court: "Ct",
        pl: "Pl", place: "Pl",
        way: "Way",
        ter: "Ter", terrace: "Ter",
        cir: "Cir", circle: "Cir",
        pkwy: "Pkwy", parkway: "Pkwy",
        hwy: "Hwy", highway: "Hwy",
        trl: "Trl", trail: "Trl",
        loop: "Loop", row: "Row",
        cv: "Cv", cove: "Cv",
        run: "Run", path: "Path", ridge: "Ridge", walk: "Walk",
      };
      return map[lower] || properCaseToken(clean);
    }
    // Unit designators — abbreviate
    if (UNIT_DESIGNATORS.has(lower)) {
      const map: Record<string, string> = {
        apt: "Apt", apartment: "Apt",
        unit: "Unit",
        ste: "Ste", suite: "Ste",
        no: "No", number: "No",
        lot: "Lot",
        bldg: "Bldg", building: "Bldg",
        fl: "Fl", floor: "Fl",
      };
      return map[lower] || properCaseToken(clean);
    }
    return properCaseToken(clean);
  });

  const streetOut = normalized.join(" ");
  const rest = parts.slice(1).join(", ");
  return rest ? `${streetOut}, ${rest}` : streetOut;
}

// ─── CITY ───────────────────────────────────────────────────────────────────
// Handles: "JACKSONVILLE" → "Jacksonville"
//          "ST AUGUSTINE" → "St. Augustine"
//          "PONTE VEDRA BEACH" → "Ponte Vedra Beach"
const CITY_ABBREVIATIONS: Record<string, string> = {
  st: "St.",
  mt: "Mt.",
  ft: "Ft.",
};

export function normalizeCity(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";

  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const clean = word.toLowerCase().replace(/\./g, "");
      if (CITY_ABBREVIATIONS[clean]) return CITY_ABBREVIATIONS[clean];
      return properCaseToken(word);
    })
    .join(" ");
}

// ─── STATE ──────────────────────────────────────────────────────────────────
// Always 2-letter uppercase: "florida" → "FL", "fl" → "FL"
const STATE_MAP: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

export function normalizeState(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim().toLowerCase().replace(/\./g, "");
  if (!s) return "";
  if (s.length === 2) return s.toUpperCase();
  return STATE_MAP[s] || s.toUpperCase();
}
