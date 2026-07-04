// ─── FREC LICENSEE PIPELINE ───────────────────────────────────────────────────
// v13.3 — Switched from HTML scraping (myfloridalicense.com/wl11.asp) to the
// official DBPR weekly CSV extract (RE_rgn3.csv), which covers our NE Florida
// footprint (Baker, Clay, Duval, Flagler, Nassau, St. Johns).
//
// The CSV is refreshed weekly by DBPR. NULL & VOID records are already
// excluded server-side. We further filter to Current+Active individual
// licensees (SL Sales Associate, BK Broker, BL Broker Sales) in our target
// counties (Nassau, Duval, St. Johns, Clay).
//
// Docs: https://www2.myfloridalicense.com/real-estate-commission/public-records/
// File: https://www2.myfloridalicense.com/sto/file_download/extracts/RE_rgn3.csv
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

// DBPR weekly CSV extract for NE Florida real estate licensees
// (Baker, Clay, Duval, Flagler, Nassau, St. Johns + overflow)
const DBPR_CSV_URL = "https://www2.myfloridalicense.com/sto/file_download/extracts/RE_rgn3.csv";

// Counties that cover our 7 NE Florida territories
export const FREC_TARGET_COUNTIES = ["Nassau", "Duval", "St. Johns", "Clay"];

// Rank codes we care about — only individuals, no corps/branch offices
const TARGET_RANKS = new Set([
  "SL Sales Associate",
  "BK Broker",
  "BL Broker Sales",
]);

// Safety cap in case DBPR ever publishes a corrupt/oversized file
const MAX_PER_RUN = 25_000;

export interface FrecRecord {
  frecLicenseId: string;      // e.g. "SL3456789" — prefix from rank + license #
  firstName: string;
  lastName: string;
  fullName: string;
  licenseType: string;        // "SL" | "BK" | "BL"
  licenseStatus: string;      // "Current Active"
  licenseIssueDate: string;   // YYYY-MM-DD
  licenseExpireDate: string;  // YYYY-MM-DD
  county: string;             // Nassau | Duval | St. Johns | Clay
  rawAddress: string;         // full mailing address (addr1 + addr2 + addr3 + city, state zip)
  zip: string;                // from address
  currentBrokerage: string;   // employer name (blank for brokers who own their own shop)
  phone: string;              // DBPR does not publish phone — enriched later
  email: string;              // DBPR does not publish email — enriched later
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function extractZipFromAddress(address: string): string {
  const match = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : "";
}

function toIsoDate(mdy: string): string {
  const parts = mdy.trim().split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  return mdy;
}

function rankToLicensePrefix(rank: string): string {
  // "SL Sales Associate" -> "SL", "BK Broker" -> "BK", "BL Broker Sales" -> "BL"
  const m = rank.trim().match(/^([A-Z]{2})\b/);
  return m ? m[1] : "";
}

function parseFullName(name: string): { firstName: string; lastName: string } {
  // DBPR stores as "LAST, FIRST MIDDLE" for individuals
  const trimmed = name.trim();
  if (trimmed.includes(",")) {
    const [last, rest] = trimmed.split(",", 2);
    const firstMid = (rest || "").trim().split(/\s+/);
    return { firstName: firstMid[0] || "", lastName: last.trim() };
  }
  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" ") || parts[0] || "",
  };
}

// ─── CSV PARSER ──────────────────────────────────────────────────────────────
// DBPR CSV is quote-comma delimited. Column layout (from readme + probe):
//   [0]  License code (always "25" for real estate)
//   [1]  License type name (e.g. "2501 Real Estate Broker or Sales Ass")
//   [2]  Licensee Name           ("LAST, FIRST" for individuals)
//   [3]  DBA Name
//   [4]  Rank                    ("SL Sales Associate" | "BK Broker" | ...)
//   [5]  Address 1
//   [6]  Address 2
//   [7]  Address 3
//   [8]  City
//   [9]  State
//   [10] Zip
//   [11] County code
//   [12] County Name
//   [13] License Number          (numeric — combine with rank prefix)
//   [14] Primary Status          ("Current" | "Involuntary Inactive" | ...)
//   [15] Secondary Status        ("Active" | "Inactive")
//   [16] Original License Date   MM/DD/YYYY
//   [17] Status Effective Date   MM/DD/YYYY
//   [18] License Expiration Date MM/DD/YYYY
//   [19] Alternate License Number
//   [20] Self Proprietor Name
//   [21] Employer's Name         (the brokerage the agent is hung with)
//   [22] Employer's License Number

function parseDbprCsvLine(line: string): string[] {
  // DBPR uses quoted CSV: "field","field, with comma","..."
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseDbprCsv(csvText: string): FrecRecord[] {
  const lines = csvText.split(/\r?\n/);
  const records: FrecRecord[] = [];
  const targetCounties = new Set(FREC_TARGET_COUNTIES);

  for (const line of lines) {
    if (!line.trim()) continue;
    if (records.length >= MAX_PER_RUN) break;

    const cols = parseDbprCsvLine(line);
    if (cols.length < 22) continue;

    const county = (cols[12] || "").trim();
    if (!targetCounties.has(county)) continue;

    const rank = (cols[4] || "").trim();
    if (!TARGET_RANKS.has(rank)) continue;

    const primary = (cols[14] || "").trim();
    const secondary = (cols[15] || "").trim();
    if (primary !== "Current" || secondary !== "Active") continue;

    const rawName = (cols[2] || "").trim();
    const { firstName, lastName } = parseFullName(rawName);
    if (!firstName || !lastName) continue;

    const licenseNumber = (cols[13] || "").trim();
    const prefix = rankToLicensePrefix(rank);
    const frecLicenseId = prefix && licenseNumber ? `${prefix}${licenseNumber}` : licenseNumber;

    const addr1 = (cols[5] || "").trim();
    const addr2 = (cols[6] || "").trim();
    const addr3 = (cols[7] || "").trim();
    const city  = (cols[8] || "").trim();
    const state = (cols[9] || "").trim();
    const zipCol = (cols[10] || "").trim();
    const rawAddress = [addr1, addr2, addr3].filter(Boolean).join(" ")
      + (city ? `, ${city}` : "")
      + (state ? ` ${state}` : "")
      + (zipCol ? ` ${zipCol}` : "");

    records.push({
      frecLicenseId,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim(),
      licenseType: prefix,
      licenseStatus: `${primary} ${secondary}`,
      licenseIssueDate: toIsoDate(cols[16] || ""),
      licenseExpireDate: toIsoDate(cols[18] || ""),
      county,
      rawAddress,
      zip: extractZipFromAddress(zipCol) || extractZipFromAddress(rawAddress),
      currentBrokerage: (cols[21] || "").trim(),
      phone: "",
      email: "",
    });
  }

  return records;
}

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────

async function downloadDbprCsv(): Promise<string> {
  console.log(`[FREC] Downloading DBPR CSV from ${DBPR_CSV_URL}`);
  const resp = await fetch(DBPR_CSV_URL, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/csv,text/plain,*/*",
      "Referer": "https://www2.myfloridalicense.com/real-estate-commission/public-records/",
    },
    signal: AbortSignal.timeout(120_000), // CSV is ~8MB, generous timeout
  });
  if (!resp.ok) {
    throw new Error(`DBPR CSV HTTP ${resp.status}`);
  }
  const text = await resp.text();
  console.log(`[FREC] Downloaded ${text.length} bytes`);
  return text;
}

// ─── COUNTY SCRAPER (BACK-COMPAT SHIM) ───────────────────────────────────────
// The old API sliced calls by (county, licenseType). We now pull the whole
// region CSV once and filter in-memory. Legacy callers still work.

let _cachedCsv: string | null = null;
let _cachedAt: number = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getCsvCached(): Promise<string> {
  const now = Date.now();
  if (_cachedCsv && (now - _cachedAt) < CACHE_TTL_MS) return _cachedCsv;
  _cachedCsv = await downloadDbprCsv();
  _cachedAt = now;
  return _cachedCsv;
}

export async function scrapeFrecByCounty(
  county: string,
  licenseType: string = "SL",
): Promise<FrecRecord[]> {
  const csv = await getCsvCached();
  const all = parseDbprCsv(csv);
  const prefix = licenseType === "BK" ? new Set(["BK", "BL"]) : new Set(["SL"]);
  return all.filter(r => r.county === county && prefix.has(r.licenseType));
}

// ─── FULL SCRAPE (all target counties × all target ranks) ────────────────────

export async function scrapeAllFrec(): Promise<{
  records: FrecRecord[];
  countByCounty: Record<string, number>;
  errors: string[];
}> {
  const countByCounty: Record<string, number> = {};
  const errors: string[] = [];
  let records: FrecRecord[] = [];

  try {
    const csv = await downloadDbprCsv();
    // Save a snapshot for debugging (first 100KB is plenty)
    try {
      const fs = require("node:fs");
      const snapshotPath = process.env.NODE_ENV === "production"
        ? "/app/data/dbpr_csv_snapshot.csv"
        : "./dbpr_csv_snapshot.csv";
      fs.writeFileSync(snapshotPath, csv.slice(0, 100_000));
    } catch { /* non-fatal */ }

    records = parseDbprCsv(csv);
    for (const c of FREC_TARGET_COUNTIES) countByCounty[c] = 0;
    for (const r of records) countByCounty[r.county] = (countByCounty[r.county] || 0) + 1;

    console.log(
      `[FREC] Full DBPR extract complete. Total: ${records.length} records across ${FREC_TARGET_COUNTIES.length} counties.`,
    );
  } catch (err: any) {
    const msg = `DBPR CSV fetch/parse failed: ${err.message}`;
    console.error(`[FREC] ${msg}`);
    errors.push(msg);
  }

  return { records, countByCounty, errors };
}
