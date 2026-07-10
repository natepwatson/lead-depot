#!/usr/bin/env node
/**
 * v14.74 — CSV import parser test.
 *
 * Validates that all 3 uploaded LandVoice/BatchLeads samples flow through the
 * parser cleanly, produce the expected structure, and DO NOT break downstream
 * assumptions (phoneStates only uses untried|tried|no_answer_today|struck,
 * county spelling matches admin dropdown, phone dedup, dnc as display-only).
 *
 * Run: node scripts/test-csv-import.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Since batchleads-csv-import.ts is a TS module compiled by esbuild into
// dist/index.cjs at build time, we can't import it directly with node.
// Use tsx via a subprocess if available, else fall back to reading the .ts
// and validating structural expectations against fixture files.

async function loadParser() {
  try {
    const mod = await import("../dist/parser-bundle.mjs");
    return mod;
  } catch {
    // Build a temporary bundle just for this test.
    const { execSync } = await import("node:child_process");
    execSync(
      `npx --yes esbuild ${root}/server/batchleads-csv-import.ts --bundle --platform=node --format=esm --outfile=${root}/dist/parser-bundle.mjs --external:better-sqlite3 --external:xlsx`,
      { stdio: "inherit" }
    );
    const mod = await import("../dist/parser-bundle.mjs");
    return mod;
  }
}

const { parseBatchLeadsFile, detectFormat } = await loadParser();

const ATTACH = "/home/user/workspace/uploaded_attachments/7242301ed74d4c17a267f7f184b10797";
// v14.74 — Expected counts after all-DNC skip: 192 rows across the 3 files
// are dropped because every phone was DNC-flagged. Dialable pool is 504.
const FILES = [
  { name: "Landvoice_Nassau_SkipTraced-2.csv",   fmt: "landvoice-listing", minRows: 300 },
  { name: "customUploadslisting-18-3.csv",       fmt: "landvoice-listing", minRows: 140 },
  { name: "expiredlisting.csv",                  fmt: "landvoice-expired", minRows: 50 },
];

const PHONE_STATE_ALLOWED = new Set(["untried", "tried", "no_answer_today", "struck"]);
const COUNTY_ALLOWED = new Set(["Nassau", "Duval", "St Johns"]);

let pass = 0, fail = 0;
const check = (ok, msg) => { if (ok) { pass++; } else { fail++; console.log(`  ❌ ${msg}`); } };

for (const f of FILES) {
  console.log(`\n▶ ${f.name}`);
  const buf = readFileSync(`${ATTACH}/${f.name}`);
  const rows = parseBatchLeadsFile(buf);

  // Format detection
  let firstRaw;
  try {
    if (f.name.endsWith(".csv")) {
      // Re-parse header for detectFormat sanity check.
      const text = buf.toString("utf8").replace(/^\uFEFF/, "");
      const lines = text.split(/\r?\n/);
      const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
      const values = lines[1] ? lines[1].split(",") : [];
      firstRaw = Object.fromEntries(headers.map((h, i) => [h, values[i] || ""]));
    }
  } catch {}
  if (firstRaw) {
    const detected = detectFormat(firstRaw);
    check(detected === f.fmt, `detectFormat = ${detected} (expected ${f.fmt})`);
  }

  check(rows.length >= f.minRows, `parsed ${rows.length} rows (>= ${f.minRows})`);
  console.log(`  ✓ parsed ${rows.length} rows`);

  // Downstream integrity
  let phoneStateBad = 0, countyBad = 0, dncAsState = 0, emptyPhones = 0, dupPhonesInLead = 0;
  let intelCount = 0, extraCount = 0, dncPhoneCount = 0;
  for (const r of rows) {
    const phones = r.allPhones || [];
    if (phones.length === 0) emptyPhones++;
    const seen = new Set();
    for (const p of phones) {
      if (seen.has(p)) dupPhonesInLead++;
      seen.add(p);
      if (!PHONE_STATE_ALLOWED.has(r.phoneStates?.[p] || "untried")) phoneStateBad++;
      if (r.phoneStates?.[p] === "dnc") dncAsState++;
    }
    if (r.county && !COUNTY_ALLOWED.has(r.county)) countyBad++;
    const extra = r.extra || {};
    if (extra.phoneMeta && extra.phoneMeta.length) {
      extraCount++;
      for (const m of extra.phoneMeta) if (m.dnc) dncPhoneCount++;
    }
    if (extra.mlsNumber || extra.daysOnMarket != null) intelCount++;
  }

  check(phoneStateBad === 0, `${phoneStateBad} rows with illegal phoneState value`);
  check(dncAsState === 0, `${dncAsState} rows had "dnc" as phoneState (DNC must be display metadata only)`);
  check(countyBad === 0, `${countyBad} rows with county not in {Nassau, Duval, St Johns} — routing WILL fail`);
  check(dupPhonesInLead === 0, `${dupPhonesInLead} rows had duplicate phones within same lead`);
  console.log(`  ✓ ${extraCount} rows carry phoneMeta (${dncPhoneCount} DNC phones flagged)`);
  if (f.fmt === "landvoice-expired") {
    check(intelCount > 0, `expected MLS intel on expired file (got ${intelCount})`);
    console.log(`  ✓ ${intelCount} rows carry MLS intel`);
  }
  console.log(`  · empty phone rows: ${emptyPhones}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
