// ─── NE FLORIDA TERRITORY → ZIP CODE MAPPING ─────────────────────────────────
// Source: USPS, county records, July 2026
// Boundary judgment calls marked with ⚠️ — see notes below each territory
//
// PENDING DECISIONS FROM ALEX:
//   1. 32082 (Ponte Vedra Beach) — currently under Ponte Vedra/Nocatee/St. Aug
//      Move to Intracoastal/Beaches? It straddles both.
//   2. 32220 (Whitehouse) — currently under North Jax & Nassau
//      Move to Jacksonville West? It's westside-oriented.
//   3. 32234 (Baldwin) — listed under both North Jax & Clay County (multi-county zip)
//      Assign to one only. Suggest: North Jax & Nassau (town is in Duval).
//   4. 32223 / 32258 (Mandarin/South Duval) — currently Jacksonville East
//      Cross-listed with St. Johns County. Primary assignment: Jacksonville East.
// ─────────────────────────────────────────────────────────────────────────────

export const TERRITORIES: Record<string, {
  displayName: string;
  cities: string[];
  zipcodes: string[];
  notes: string;
}> = {
  "north_jax_nassau": {
    displayName: "North Jax & Nassau",
    cities: ["Fernandina Beach", "Amelia Island", "Yulee", "Callahan", "Hilliard", "Bryceville", "Northside Jacksonville", "Oceanway", "Dinsmore", "Baldwin"],
    zipcodes: ["32034", "32035", "32041", "32097", "32011", "32046", "32009", "32218", "32219", "32226", "32234"],
    notes: "All Nassau County + northern Duval. 32234 (Baldwin) is multi-county — assigned here as town sits in Duval."
  },
  "jacksonville_west": {
    displayName: "Jacksonville West",
    cities: ["Argyle", "Oakleaf", "Cecil Field", "Herlong", "Normandy", "Westside", "Jacksonville Heights", "Ortega", "Confederate Point", "Whitehouse"],
    zipcodes: ["32210", "32220", "32221", "32222", "32244", "32254", "32073"],
    notes: "West Duval County including Whitehouse (32220). 32073 included at Oakleaf/Clay edge."
  },
  "jacksonville_east": {
    displayName: "Jacksonville East",
    cities: ["Arlington", "Regency", "Southside", "Baymeadows", "Mandarin", "San Marco", "Beauclerc", "Fort Caroline"],
    zipcodes: ["32207", "32211", "32216", "32217", "32223", "32225", "32246", "32256", "32257", "32258", "32277"],
    notes: "East/southeast Jacksonville. 32223/32258 are Mandarin/South Duval — see file header."
  },
  "intracoastal_beaches": {
    displayName: "Intracoastal/Beaches",
    cities: ["Atlantic Beach", "Neptune Beach", "Jacksonville Beach", "Ponte Vedra Beach (Duval portion)", "Mayport"],
    zipcodes: ["32233", "32266", "32250", "32240", "32227"],
    notes: "Duval County beach communities. 32082 is currently under Ponte Vedra — see header decision #1."
  },
  "ponte_vedra_nocatee_st_aug": {
    displayName: "Ponte Vedra/Nocatee/St. Aug",
    cities: ["Ponte Vedra", "Ponte Vedra Beach", "Nocatee", "St. Augustine", "St. Augustine Beach", "Vilano Beach", "World Golf Village"],
    zipcodes: ["32081", "32082", "32004", "32095", "32080", "32084", "32085", "32086", "32092"],
    notes: "Nocatee + Ponte Vedra + St. Augustine corridor."
  },
  "st_johns_county": {
    displayName: "St. Johns County",
    cities: ["Fruit Cove", "Julington Creek", "Switzerland", "St. Johns", "Hastings", "Elkton", "Flagler Estates"],
    zipcodes: ["32259", "32260", "32033", "32145"],
    notes: "St. Johns County remainder (not covered by Ponte Vedra/Nocatee/St. Aug)."
  },
  "clay_county": {
    displayName: "Clay County",
    cities: ["Orange Park", "Fleming Island", "Green Cove Springs", "Middleburg", "Keystone Heights", "Penney Farms", "Doctors Inlet"],
    zipcodes: ["32003", "32006", "32030", "32043", "32050", "32065", "32067", "32068", "32073", "32079", "32656", "32160"],
    notes: "Full Clay County. 32234 (Baldwin) assigned to North Jax — see file header."
  },
};

// Flat lookup: zip → territory key (for scoring/assignment)
export const ZIP_TO_TERRITORY: Record<string, string> = {};
for (const [key, t] of Object.entries(TERRITORIES)) {
  for (const zip of t.zipcodes) {
    ZIP_TO_TERRITORY[zip] = key;
  }
}

// v13.8 — SE Georgia footprint zips (Camden, Charlton, Glynn counties).
// Used only for BatchLeads ingest scope; recruiting/DBPR side unchanged.
const SE_GEORGIA_ZIPS = [
  // Camden County GA
  "31537", "31548", "31558", "31565", "31569",
  // Charlton County GA
  "31537", "31631", "31533", "31647",
  // Glynn County GA
  "31520", "31521", "31522", "31523", "31524", "31525", "31527", "31561",
];

// All NE Florida zips in one flat array (for BatchLeads and DBPR territory filtering).
// Kept as an array for backwards compatibility with existing callers.
export const ALL_NE_FLORIDA_ZIPS_ARRAY = [
  ...new Set(Object.values(TERRITORIES).flatMap(t => t.zipcodes)),
];

// v13.8 — 8-county ingest footprint (5 FL + 3 GA) as a Set for fast .has() lookups.
// This is what BatchLeads filterBatchLead uses to gate ZIP scope.
export const ALL_NE_FLORIDA_ZIPS: Set<string> = new Set([
  ...ALL_NE_FLORIDA_ZIPS_ARRAY,
  ...SE_GEORGIA_ZIPS,
]);

export function getTerritoryForZip(zip: string): string | null {
  return ZIP_TO_TERRITORY[zip.trim().slice(0, 5)] || null;
}
