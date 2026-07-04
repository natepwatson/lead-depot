// ─── FREC AGENT SCRAPER ────────────────────────────────────────────────────────
// Scrapes Florida DBPR (myfloridalicense.com) for active real estate licensees
// in NE Florida counties, then feeds them into the recruiting pipeline.
//
// FREC has no public API — this uses the form-POST HTML search endpoint.
// We parse paginated HTML tables with cheerio. Rate-limited to 1.5s/page.
//
// Target counties: Nassau, Duval, St. Johns, Clay
// License types: SL (Sales Associate), BK (Broker)
// Status filter: Current Active only
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

// FREC search endpoint
const FREC_SEARCH_URL = "https://www.myfloridalicense.com/wl11.asp";

// Counties that cover our 7 NE Florida territories
export const FREC_TARGET_COUNTIES = ["Nassau", "Duval", "St. Johns", "Clay"];

// License types to pull (Sales Associate + Broker)
const LICENSE_TYPES = ["SL", "BK"];

// Delay between pages to avoid FREC rate-limiting
const PAGE_DELAY_MS = 1500;

// Max records per county/type combo (safety cap)
const MAX_PER_RUN = 1000;

export interface FrecRecord {
  frecLicenseId: string;      // e.g. "SL3456789" — FREC's unique identifier
  firstName: string;
  lastName: string;
  fullName: string;
  licenseType: string;        // "SL" | "BK"
  licenseStatus: string;      // "Current Active"
  licenseIssueDate: string;   // "MM/DD/YYYY" as returned by FREC
  licenseExpireDate: string;  // "MM/DD/YYYY"
  county: string;             // source county of the search
  rawAddress: string;         // mailing address from FREC record
  zip: string;                // extracted from rawAddress
  currentBrokerage: string;   // employer/brokerage from FREC
  phone: string;              // usually absent in FREC — enriched later
  email: string;              // rarely present — enriched later
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

function extractZipFromAddress(address: string): string {
  // FREC addresses: "123 Main St, Jacksonville FL 32210" or "32210-1234"
  const match = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : "";
}

function toIsoDate(mdy: string): string {
  // Convert "MM/DD/YYYY" → "YYYY-MM-DD"
  const parts = mdy.trim().split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  return mdy;
}

// ─── FREC HTML PARSER ─────────────────────────────────────────────────────────

function parseFrecTable(html: string): FrecRecord[] {
  let $: any;
  try {
    const cheerio = require("cheerio");
    $ = cheerio.load(html);
  } catch {
    console.error("[FREC] cheerio not installed — run: npm install cheerio");
    return [];
  }

  const records: FrecRecord[] = [];

  // FREC result table: rows with class "search-result" or inside #searchResults
  // The table structure changes occasionally — we parse all TR rows and look for
  // cells that match the expected column count (8+).
  $("table tr").each((_: any, row: any) => {
    const cells = $(row).find("td");
    if (cells.length < 6) return; // header or spacer row

    const cols = cells.map((_: any, td: any) => $(td).text().trim()).get() as string[];

    // FREC table columns (as of 2026):
    // [0] License Number  [1] Name  [2] Rank/Type  [3] Status
    // [4] Issue Date      [5] Expire Date  [6] County  [7] Employer/Brokerage
    const licenseId = (cols[0] || "").trim();
    if (!licenseId.match(/^[A-Z]{2}\d+$/)) return; // skip non-license rows

    const rawName = (cols[1] || "").trim();
    // FREC stores names as "LAST, FIRST MIDDLE" — normalize
    let firstName = "";
    let lastName = "";
    if (rawName.includes(",")) {
      const [last, rest] = rawName.split(",", 2);
      lastName = last.trim();
      firstName = (rest || "").trim().split(" ")[0]; // take first of given names
    } else {
      const parts = rawName.split(" ");
      lastName = parts[parts.length - 1] || rawName;
      firstName = parts[0] || "";
    }

    const licenseType = licenseId.slice(0, 2); // "SL" or "BK"
    const licenseStatus = (cols[3] || "").trim();

    // Only keep Current Active licenses
    if (!licenseStatus.toLowerCase().includes("current active")) return;

    const issueDate = toIsoDate(cols[4] || "");
    const expireDate = toIsoDate(cols[5] || "");
    const county = (cols[6] || "").trim();
    const employer = (cols[7] || "").trim();

    // Some rows have an address cell — try to get zip from it
    const addressCell = cols[8] || cols[7] || "";
    const zip = extractZipFromAddress(addressCell) || extractZipFromAddress(employer);

    records.push({
      frecLicenseId: licenseId,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim(),
      licenseType,
      licenseStatus,
      licenseIssueDate: issueDate,
      licenseExpireDate: expireDate,
      county,
      rawAddress: addressCell,
      zip,
      currentBrokerage: employer,
      phone: "",
      email: "",
    });
  });

  return records;
}

// ─── FREC FORM POST ───────────────────────────────────────────────────────────

async function postFrecSearch(
  county: string,
  licenseType: string,
  page: number,
): Promise<string> {
  // FREC uses a multipart-form POST. We replicate it exactly.
  // Field names observed from the live form (July 2026).
  const params = new URLSearchParams({
    LicenseType: licenseType,
    County: county,
    LicenseStatus: "Current%2CActive", // URL-encoded "Current,Active"
    FirstName: "",
    LastName: "",
    BusinessName: "",
    MidName: "",
    LicenseNumber: "",
    RecordPage: String(page),
    RecordPageSize: "50",
    btn_Search: "Search",
  });

  try {
    const resp = await fetch(FREC_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.myfloridalicense.com",
        "Referer": FREC_SEARCH_URL,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`FREC HTTP ${resp.status}`);
    }
    return await resp.text();
  } catch (err: any) {
    throw new Error(`FREC fetch failed (county=${county}, type=${licenseType}, page=${page}): ${err.message}`);
  }
}

// ─── DETECT LAST PAGE ────────────────────────────────────────────────────────

function hasNextPage(html: string): boolean {
  // FREC pagination: "Next" link appears when more results exist
  return html.includes("btn_Next") || html.toLowerCase().includes(">next<");
}

function countResultsInPage(html: string): number {
  // Quick heuristic: count license-number-looking patterns
  const matches = html.match(/\b[A-Z]{2}\d{6,}/g);
  return matches ? matches.length : 0;
}

// ─── COUNTY SCRAPER ──────────────────────────────────────────────────────────

export async function scrapeFrecByCounty(
  county: string,
  licenseType: string = "SL",
): Promise<FrecRecord[]> {
  const results: FrecRecord[] = [];
  let page = 1;

  console.log(`[FREC] Scraping county=${county} licenseType=${licenseType}`);

  while (results.length < MAX_PER_RUN) {
    let html: string;
    try {
      html = await postFrecSearch(county, licenseType, page);
    } catch (err: any) {
      console.error(`[FREC] Error on page ${page}:`, err.message);
      break;
    }

    const pageRecords = parseFrecTable(html);
    console.log(`[FREC] county=${county} type=${licenseType} page=${page}: ${pageRecords.length} records`);

    if (pageRecords.length === 0) {
      // Sanity check: if page 1 returns 0, FREC may have changed its HTML structure
      if (page === 1) {
        console.warn(
          `[FREC] ⚠️  ZERO results on page 1 for county=${county} type=${licenseType}. ` +
          `FREC HTML structure may have changed — check frec_html_snapshot.html`
        );
        // Save a snapshot for debugging
        try {
          const fs = require("node:fs");
          const snapshotPath = process.env.NODE_ENV === "production"
            ? "/app/data/frec_html_snapshot.html"
            : "./frec_html_snapshot.html";
          fs.writeFileSync(snapshotPath, html.slice(0, 50_000)); // first 50KB
          console.log(`[FREC] Saved HTML snapshot to ${snapshotPath}`);
        } catch { /* non-fatal */ }
      }
      break;
    }

    results.push(...pageRecords);

    if (!hasNextPage(html) || pageRecords.length < 50) break;

    page++;
    await sleep(PAGE_DELAY_MS);
  }

  console.log(`[FREC] county=${county} type=${licenseType}: total=${results.length} records`);
  return results;
}

// ─── FULL SCRAPE (all counties × all license types) ──────────────────────────

export async function scrapeAllFrec(): Promise<{
  records: FrecRecord[];
  countByCounty: Record<string, number>;
  errors: string[];
}> {
  const allRecords: FrecRecord[] = [];
  const countByCounty: Record<string, number> = {};
  const errors: string[] = [];

  for (const county of FREC_TARGET_COUNTIES) {
    countByCounty[county] = 0;

    for (const licenseType of LICENSE_TYPES) {
      try {
        const records = await scrapeFrecByCounty(county, licenseType);
        allRecords.push(...records);
        countByCounty[county] += records.length;
      } catch (err: any) {
        const msg = `county=${county} type=${licenseType}: ${err.message}`;
        console.error(`[FREC] Error: ${msg}`);
        errors.push(msg);
      }

      // Pause between county+type combos to be gentle on FREC servers
      await sleep(2000);
    }
  }

  console.log(`[FREC] Full scrape complete. Total: ${allRecords.length} records across ${FREC_TARGET_COUNTIES.length} counties.`);
  return { records: allRecords, countByCounty, errors };
}
