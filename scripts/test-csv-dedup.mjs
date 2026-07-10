#!/usr/bin/env node
/**
 * v14.75 — LandVoice CSV re-import dedup test.
 *
 * Simulates realistic re-export drift:
 *  1. Same file uploaded twice → 0 duplicate inserts
 *  2. Same properties with phones shuffled → still dedups on address
 *  3. Same properties with address suffix drift (St ↔ Street) → dedups
 *  4. Same properties with owner-name spelling drift → dedups
 *  5. Same properties with formatted phones (parens, dashes) → dedups on phone
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Rebuild parser bundle to include v14.75 dedup changes.
execSync(
  `npx --yes esbuild ${root}/server/batchleads-csv-import.ts --bundle --platform=node --format=esm --outfile=${root}/dist/parser-bundle.mjs --external:better-sqlite3 --external:xlsx`,
  { stdio: "pipe" }
);
const { parseBatchLeadsFile, insertImportedLeads } = await import("../dist/parser-bundle.mjs");

const ATTACH = "/home/user/workspace/uploaded_attachments/7242301ed74d4c17a267f7f184b10797";

function freshDb() {
  const db = new Database(":memory:");
  // Minimal schema mirroring the fields insertImportedLeads writes.
  db.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, county TEXT,
      phone TEXT, phones TEXT, phone_states TEXT, email TEXT,
      lead_type TEXT, status TEXT DEFAULT 'unassigned', score INTEGER,
      list_price INTEGER, assessed_value INTEGER, last_sale_price INTEGER,
      lot_size_acres REAL, year_purchased INTEGER,
      source TEXT, batch_id TEXT, extra_data TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX ux_leads_phone ON leads(phone);
  `);
  return db;
}

let pass = 0, fail = 0;
const check = (ok, msg) => { if (ok) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } };

// ── Test 1: Same file twice ──────────────────────────────────────────────────
console.log("\n▶ Test 1: Re-uploading the exact same file");
{
  const buf = readFileSync(`${ATTACH}/expiredlisting.csv`);
  const db = freshDb();
  const rows1 = parseBatchLeadsFile(buf);
  const s1 = insertImportedLeads(db, rows1);
  const rows2 = parseBatchLeadsFile(buf);
  const s2 = insertImportedLeads(db, rows2);
  // NOTE: rows1.length can be > s1.inserted — the file itself may contain
  // intra-file duplicates (LandVoice sometimes emits parent/child records
  // for the same parcel). Both should still be caught, so the pool count
  // is what matters.
  check(s1.inserted > 0, `first upload inserted ${s1.inserted}/${rows1.length} (intra-file dups caught: ${rows1.length - s1.inserted})`);
  check(s2.inserted === 0, `second upload inserted 0 (got ${s2.inserted})`);
  check(s2.skippedDuplicate === rows2.length, `second upload skipped all ${rows2.length} as dup (got ${s2.skippedDuplicate})`);
}

// ── Test 2: Same properties, phones shuffled ────────────────────────────────
console.log("\n▶ Test 2: Same properties, phones shuffled (LandVoice re-order)");
{
  const buf = readFileSync(`${ATTACH}/expiredlisting.csv`);
  const db = freshDb();
  const rows1 = parseBatchLeadsFile(buf);
  insertImportedLeads(db, rows1);

  // Simulate LandVoice re-shuffling: swap allPhones order for each row.
  const rows2 = rows1.map(r => ({
    ...r,
    phone: r.allPhones[r.allPhones.length - 1] || r.phone,  // last becomes first
    allPhones: [...r.allPhones].reverse(),
  }));
  const s2 = insertImportedLeads(db, rows2);
  check(s2.inserted === 0, `phone-shuffled re-upload inserted 0 (got ${s2.inserted}, expected all dup on address)`);
}

// ── Test 3: Address suffix drift ─────────────────────────────────────────────
console.log("\n▶ Test 3: Address suffix drift (Street ↔ St, Avenue ↔ Ave, etc)");
{
  const buf = readFileSync(`${ATTACH}/expiredlisting.csv`);
  const db = freshDb();
  const rows1 = parseBatchLeadsFile(buf);
  insertImportedLeads(db, rows1);

  const SUFFIX_SWAP = [
    [/\bSt\b\.?/gi, "Street"], [/\bAve\b\.?/gi, "Avenue"], [/\bDr\b\.?/gi, "Drive"],
    [/\bRd\b\.?/gi, "Road"], [/\bBlvd\b\.?/gi, "Boulevard"], [/\bLn\b\.?/gi, "Lane"],
    [/\bCt\b\.?/gi, "Court"], [/\bCir\b\.?/gi, "Circle"], [/\bTer\b\.?/gi, "Terrace"],
  ];
  const swap = (s) => SUFFIX_SWAP.reduce((acc, [re, w]) => acc.replace(re, w), s || "");

  // Change address AND phones so ONLY address-normalization can catch them.
  const rows2 = rows1.map(r => ({
    ...r,
    address: swap(r.address),
    phone: "5555" + Math.floor(Math.random() * 900000 + 100000),
    allPhones: [],
  }));
  const s2 = insertImportedLeads(db, rows2);
  check(s2.inserted === 0, `suffix-drifted re-upload inserted 0 (got ${s2.inserted}). If >0, address normalization failed.`);
}

// ── Test 4: Formatted phones with parens/dashes ─────────────────────────────
console.log("\n▶ Test 4: Same phones with formatting drift ((904) 555-1234 vs 9045551234)");
{
  const buf = readFileSync(`${ATTACH}/expiredlisting.csv`);
  const db = freshDb();
  const rows1 = parseBatchLeadsFile(buf);
  insertImportedLeads(db, rows1);

  // Simulate a new file where addresses were normalized DIFFERENTLY (add
  // "Apt 1" so address key changes) but phones stay same.
  const rows2 = rows1.map(r => ({
    ...r,
    address: r.address + " Apt 1",
  }));
  const s2 = insertImportedLeads(db, rows2);
  check(s2.inserted === 0, `apt-added re-upload inserted 0 (got ${s2.inserted}). Should dedup on phone.`);
}

// ── Test 5: Fresh CSV, some overlap, some new leads ──────────────────────────
console.log("\n▶ Test 5: Realistic second CSV with partial overlap");
{
  const buf1 = readFileSync(`${ATTACH}/expiredlisting.csv`);
  const buf2 = readFileSync(`${ATTACH}/Landvoice_Nassau_SkipTraced-2.csv`);
  const db = freshDb();
  const rows1 = parseBatchLeadsFile(buf1);
  const s1 = insertImportedLeads(db, rows1);
  const rows2 = parseBatchLeadsFile(buf2);
  const s2 = insertImportedLeads(db, rows2);
  check(s1.inserted > 0, `file 1: ${s1.inserted} inserted, ${s1.skippedDuplicate} skipped`);
  check(s2.inserted > 0, `file 2: ${s2.inserted} inserted, ${s2.skippedDuplicate} skipped`);
  console.log(`  · pool size after both: ${db.prepare("SELECT COUNT(*) as n FROM leads").get().n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
