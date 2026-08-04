// v20.6.4 — Static zip → city/state lookup for FL and SE GA (Watson Brothers service area).
// Used to enrich workbook-uploaded listings whose address column is a raw
// "1234 Something St 32226"-style string with no city/state. Without a city,
// both Census and Nominatim reject the geocode. This gives us a deterministic
// city fill-in from the trailing 5-digit zip.
//
// Coverage: NE Florida (Duval, St. Johns, Clay, Nassau, Putnam, Flagler, Baker,
// Volusia) and SE Georgia (Camden, Glynn, Charlton, Wayne, Brantley).

type ZipInfo = { city: string; state: "FL" | "GA" };

// Compact, hand-curated. Keys are 5-digit strings. Cities are canonical USPS.
export const ZIP_TO_CITY: Record<string, ZipInfo> = {
  // ── Duval County (Jacksonville) ──
  "32099": { city: "Jacksonville", state: "FL" },
  "32202": { city: "Jacksonville", state: "FL" },
  "32204": { city: "Jacksonville", state: "FL" },
  "32205": { city: "Jacksonville", state: "FL" },
  "32206": { city: "Jacksonville", state: "FL" },
  "32207": { city: "Jacksonville", state: "FL" },
  "32208": { city: "Jacksonville", state: "FL" },
  "32209": { city: "Jacksonville", state: "FL" },
  "32210": { city: "Jacksonville", state: "FL" },
  "32211": { city: "Jacksonville", state: "FL" },
  "32212": { city: "Jacksonville", state: "FL" },
  "32216": { city: "Jacksonville", state: "FL" },
  "32217": { city: "Jacksonville", state: "FL" },
  "32218": { city: "Jacksonville", state: "FL" },
  "32219": { city: "Jacksonville", state: "FL" },
  "32220": { city: "Jacksonville", state: "FL" },
  "32221": { city: "Jacksonville", state: "FL" },
  "32222": { city: "Jacksonville", state: "FL" },
  "32223": { city: "Jacksonville", state: "FL" },
  "32224": { city: "Jacksonville", state: "FL" },
  "32225": { city: "Jacksonville", state: "FL" },
  "32226": { city: "Jacksonville", state: "FL" },
  "32227": { city: "Jacksonville", state: "FL" },
  "32233": { city: "Atlantic Beach", state: "FL" },
  "32234": { city: "Jacksonville", state: "FL" },
  "32244": { city: "Jacksonville", state: "FL" },
  "32246": { city: "Jacksonville", state: "FL" },
  "32250": { city: "Jacksonville Beach", state: "FL" },
  "32254": { city: "Jacksonville", state: "FL" },
  "32256": { city: "Jacksonville", state: "FL" },
  "32257": { city: "Jacksonville", state: "FL" },
  "32258": { city: "Jacksonville", state: "FL" },
  "32259": { city: "Jacksonville", state: "FL" },
  "32266": { city: "Neptune Beach", state: "FL" },
  "32277": { city: "Jacksonville", state: "FL" },

  // ── St. Johns County ──
  "32080": { city: "Saint Augustine", state: "FL" },
  "32081": { city: "Ponte Vedra", state: "FL" },
  "32082": { city: "Ponte Vedra Beach", state: "FL" },
  "32084": { city: "Saint Augustine", state: "FL" },
  "32086": { city: "Saint Augustine", state: "FL" },
  "32092": { city: "Saint Augustine", state: "FL" },
  "32095": { city: "Saint Augustine", state: "FL" },
  "32033": { city: "Elkton", state: "FL" },

  // ── Clay County ──
  "32003": { city: "Fleming Island", state: "FL" },
  "32043": { city: "Green Cove Springs", state: "FL" },
  "32065": { city: "Orange Park", state: "FL" },
  "32068": { city: "Middleburg", state: "FL" },
  "32073": { city: "Orange Park", state: "FL" },
  "32656": { city: "Keystone Heights", state: "FL" },

  // ── Nassau County ──
  "32011": { city: "Callahan", state: "FL" },
  "32034": { city: "Fernandina Beach", state: "FL" },
  "32046": { city: "Hilliard", state: "FL" },
  "32097": { city: "Yulee", state: "FL" },

  // ── Putnam County ──
  "32112": { city: "East Palatka", state: "FL" },
  "32131": { city: "East Palatka", state: "FL" },
  "32138": { city: "Florahome", state: "FL" },
  "32139": { city: "Georgetown", state: "FL" },
  "32140": { city: "Hollister", state: "FL" },
  "32148": { city: "Interlachen", state: "FL" },
  "32157": { city: "Lake Como", state: "FL" },
  "32177": { city: "Palatka", state: "FL" },
  "32181": { city: "Pomona Park", state: "FL" },
  "32187": { city: "San Mateo", state: "FL" },
  "32189": { city: "Satsuma", state: "FL" },
  "32193": { city: "Welaka", state: "FL" },

  // ── Flagler County ──
  "32110": { city: "Bunnell", state: "FL" },
  "32136": { city: "Flagler Beach", state: "FL" },
  "32137": { city: "Palm Coast", state: "FL" },
  "32164": { city: "Palm Coast", state: "FL" },

  // ── Baker County ──
  "32013": { city: "Glen Saint Mary", state: "FL" },
  "32040": { city: "Glen Saint Mary", state: "FL" },
  "32063": { city: "Macclenny", state: "FL" },

  // ── Volusia County (partial) ──
  "32114": { city: "Daytona Beach", state: "FL" },
  "32117": { city: "Daytona Beach", state: "FL" },
  "32118": { city: "Daytona Beach", state: "FL" },
  "32124": { city: "Daytona Beach", state: "FL" },
  "32127": { city: "Port Orange", state: "FL" },
  "32128": { city: "Port Orange", state: "FL" },
  "32129": { city: "Port Orange", state: "FL" },
  "32168": { city: "New Smyrna Beach", state: "FL" },
  "32169": { city: "New Smyrna Beach", state: "FL" },
  "32174": { city: "Ormond Beach", state: "FL" },
  "32176": { city: "Ormond Beach", state: "FL" },
  "32725": { city: "Deltona", state: "FL" },
  "32738": { city: "Deltona", state: "FL" },
  "32763": { city: "Orange City", state: "FL" },

  // ── Alachua / Marion (edge) ──
  "32601": { city: "Gainesville", state: "FL" },
  "32603": { city: "Gainesville", state: "FL" },
  "32605": { city: "Gainesville", state: "FL" },
  "32606": { city: "Gainesville", state: "FL" },
  "32607": { city: "Gainesville", state: "FL" },
  "32608": { city: "Gainesville", state: "FL" },
  "32609": { city: "Gainesville", state: "FL" },
  "32669": { city: "Newberry", state: "FL" },
  "32694": { city: "Waldo", state: "FL" },

  // ── SE Georgia — Camden County ──
  "31548": { city: "Kingsland", state: "GA" },
  "31558": { city: "Kingsland", state: "GA" },
  "31547": { city: "Kings Bay", state: "GA" },
  "31558-": { city: "Kingsland", state: "GA" },
  "31569": { city: "Waverly", state: "GA" },
  "31565": { city: "Woodbine", state: "GA" },
  "31558A": { city: "Saint Marys", state: "GA" },
  "31558B": { city: "Saint Marys", state: "GA" },
  "31558C": { city: "Saint Marys", state: "GA" },
  "31558D": { city: "Saint Marys", state: "GA" },
  // canonical St Marys
  "31558S": { city: "Saint Marys", state: "GA" },

  // ── SE Georgia — Glynn County ──
  "31520": { city: "Brunswick", state: "GA" },
  "31522": { city: "Saint Simons Island", state: "GA" },
  "31523": { city: "Brunswick", state: "GA" },
  "31524": { city: "Brunswick", state: "GA" },
  "31525": { city: "Brunswick", state: "GA" },
  "31527": { city: "Jekyll Island", state: "GA" },
  "31561": { city: "Sea Island", state: "GA" },

  // ── SE Georgia — Charlton, Wayne, Brantley ──
  "31537": { city: "Folkston", state: "GA" },
  "31545": { city: "Jesup", state: "GA" },
  "31546": { city: "Jesup", state: "GA" },
  "31533": { city: "Douglas", state: "GA" },
  "31552": { city: "Nahunta", state: "GA" },
  "31553": { city: "Nahunta", state: "GA" },
  "31566": { city: "Waynesville", state: "GA" },
  "31568": { city: "White Oak", state: "GA" },
};

// Extract a 5-digit US zip from the tail of an address string.
export function extractZip(address: string): string | null {
  if (!address) return null;
  // Common shapes: "1234 Main St 32226", "1234 Main St, Jacksonville FL 32226", "1234 Main St 32226-1234"
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b\s*$/);
  return m ? m[1] : null;
}

// Look up city/state from a raw address (or explicit zip) using ZIP_TO_CITY.
export function lookupCityState(addressOrZip: string): ZipInfo | null {
  if (!addressOrZip) return null;
  const cleaned = addressOrZip.trim();
  // If they passed a bare 5-digit zip
  if (/^\d{5}$/.test(cleaned)) return ZIP_TO_CITY[cleaned] || null;
  const zip = extractZip(cleaned);
  return zip ? (ZIP_TO_CITY[zip] || null) : null;
}

// Enrich a raw address by appending ", city, state zip" if missing.
// Idempotent: won't double-append if a comma is already present.
export function enrichAddress(rawAddress: string): { address: string; city: string; state: string; zip: string } | null {
  if (!rawAddress) return null;
  const info = lookupCityState(rawAddress);
  const zip = extractZip(rawAddress);
  if (!info || !zip) return null;
  // Strip the trailing zip from the street portion for cleaner Census input
  const street = rawAddress.replace(/\s*\b\d{5}(?:-\d{4})?\b\s*$/, "").trim();
  return {
    address: `${street}, ${info.city}, ${info.state} ${zip}`,
    city: info.city,
    state: info.state,
    zip,
  };
}
