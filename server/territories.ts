// ─── NE FLORIDA TERRITORY → ZIP CODE MAPPING (v20.58.8 — 8 territories) ───────
// Source of truth for dial + CSV: zip → territory key via getTerritoryForZip.
// Display names locked by Alex Watson (Sep 2026).
//
// Notes:
//   • intercoastal_towncenter: draft zips 32246, 32256 only (ICW/Town Center core).
//     Nearby beach zips stay under jax_beaches; Mandarin/southside under east_jax.
//   • ALL_NE_FLORIDA_ZIPS / SE GA set retained for BatchLeads ingest scope only.
// ─────────────────────────────────────────────────────────────────────────────

export const TERRITORIES: Record<string, {
  displayName: string;
  cities: string[];
  zipcodes: string[];
  notes: string;
}> = {
  nassau: {
    displayName: "Nassau",
    cities: ["Fernandina Beach", "Amelia Island", "Yulee", "Callahan", "Hilliard", "Bryceville"],
    zipcodes: ["32009", "32011", "32034", "32035", "32041", "32046", "32097"],
    notes: "Nassau County proper.",
  },
  northside: {
    displayName: "Northside",
    cities: ["Northside Jacksonville", "Oceanway", "Dinsmore", "Baldwin"],
    zipcodes: ["32218", "32219", "32226", "32234"],
    notes: "Northern Duval / Northside. 32234 (Baldwin) assigned here (town in Duval).",
  },
  east_jax: {
    displayName: "East Jax",
    cities: ["Arlington", "Regency", "Southside", "Baymeadows", "Mandarin", "San Marco", "Beauclerc", "Fort Caroline"],
    zipcodes: ["32207", "32211", "32216", "32217", "32223", "32225", "32257", "32258", "32277"],
    notes: "East/southeast Jacksonville excluding ICW/Town Center and beaches.",
  },
  intercoastal_towncenter: {
    displayName: "Intercoastal/Towncenter",
    cities: ["Town Center", "Intracoastal West", "Deerwood"],
    zipcodes: ["32246", "32256"],
    notes: "ICW / Town Center core only (32246, 32256). No nearby beach or Mandarin zips added — those stay jax_beaches / east_jax.",
  },
  jax_beaches: {
    displayName: "Jax Beaches",
    cities: ["Atlantic Beach", "Neptune Beach", "Jacksonville Beach", "Mayport"],
    zipcodes: ["32227", "32233", "32240", "32250", "32266"],
    notes: "Duval beach communities.",
  },
  ponte_vedra: {
    displayName: "Ponte Vedra",
    cities: ["Ponte Vedra", "Ponte Vedra Beach", "Nocatee", "St. Augustine", "St. Augustine Beach", "Vilano Beach", "World Golf Village"],
    zipcodes: ["32081", "32082", "32004", "32095", "32080", "32084", "32085", "32086", "32092"],
    notes: "Ponte Vedra / Nocatee / St. Augustine corridor.",
  },
  west_jax: {
    displayName: "West Jax",
    cities: ["Argyle", "Oakleaf", "Cecil Field", "Herlong", "Normandy", "Westside", "Jacksonville Heights", "Ortega", "Whitehouse"],
    zipcodes: ["32210", "32220", "32221", "32222", "32244", "32254", "32073"],
    notes: "West Duval including Whitehouse (32220). 32073 at Oakleaf/Clay edge.",
  },
  st_johns_inland: {
    displayName: "St Johns Inland",
    cities: ["Fruit Cove", "Julington Creek", "Switzerland", "St. Johns", "Hastings", "Elkton"],
    zipcodes: ["32259", "32260", "32033", "32145"],
    notes: "St. Johns inland remainder (not Ponte Vedra corridor).",
  },
};

/** Ordered list for UI pickers (key + displayName). */
export const TERRITORY_LIST = Object.entries(TERRITORIES).map(([key, t]) => ({
  key,
  displayName: t.displayName,
  zipcodes: t.zipcodes,
}));

export const TERRITORY_KEYS = Object.keys(TERRITORIES);

// Flat lookup: zip → territory key
export const ZIP_TO_TERRITORY: Record<string, string> = {};
for (const [key, t] of Object.entries(TERRITORIES)) {
  for (const zip of t.zipcodes) {
    ZIP_TO_TERRITORY[zip] = key;
  }
}

// v13.8 — SE Georgia footprint zips (Camden, Charlton, Glynn). BatchLeads ingest only.
const SE_GEORGIA_ZIPS = [
  "31537", "31548", "31558", "31565", "31569",
  "31537", "31631", "31533", "31647",
  "31520", "31521", "31522", "31523", "31524", "31525", "31527", "31561",
];

export const ALL_NE_FLORIDA_ZIPS_ARRAY = [
  ...new Set(Object.values(TERRITORIES).flatMap(t => t.zipcodes)),
];

export const ALL_NE_FLORIDA_ZIPS: Set<string> = new Set([
  ...ALL_NE_FLORIDA_ZIPS_ARRAY,
  ...SE_GEORGIA_ZIPS,
]);

export function getTerritoryForZip(zip: string): string | null {
  if (!zip) return null;
  return ZIP_TO_TERRITORY[String(zip).trim().slice(0, 5)] || null;
}

/** Legacy home_county → territory1 migration helper.
 *  Nassau is unambiguous → nassau. Duval / St Johns are ambiguous → null (force pick).
 */
export function mapHomeCountyToTerritory1(homeCounty: string | null | undefined): string | null {
  if (!homeCounty) return null;
  const c = String(homeCounty).trim().toLowerCase();
  if (c === "nassau") return "nassau";
  // Duval spans northside/east_jax/intercoastal/beaches/west — force pick
  // St Johns spans ponte_vedra / st_johns_inland — force pick
  return null;
}
