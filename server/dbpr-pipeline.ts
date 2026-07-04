// ─── DBPR AGENT RECRUITING PIPELINE ───────────────────────────────────────────
// Consumes DbprRecord[] from dbpr-scraper.ts, deduplicates against existing
// agent_leads, territory-filters to our 7 NE Florida territories, and inserts
// new recruits into the pipeline as status='new', source='dbpr_scrape'.
//
// Runs weekly (Sunday 2am EDT) via scheduled cron.
// Also triggerable manually via POST /api/admin/dbpr-run.
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { scrapeAllDbpr } from "./dbpr-scraper";
import { getTerritoryForZip, ALL_NE_FLORIDA_ZIPS } from "./territories";

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

// ─── DEDUP HASH ───────────────────────────────────────────────────────────────
// Primary key: dbprLicenseId (most stable)
// Fallback composite: normalized email + zip (for overlap with manually entered agents)

function makeDedupHash(dbprLicenseId: string, email: string, zip: string): string {
  const crypto = require("node:crypto");
  const key = `${dbprLicenseId || ""}:${(email || "").toLowerCase().trim()}:${(zip || "").trim()}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// ─── EXPIRY FILTER ────────────────────────────────────────────────────────────
// Skip agents whose license expires within 90 days — high churn risk

const EXPIRY_BUFFER_DAYS = 90;

function isLicenseExpiringSoon(expireDateIso: string): boolean {
  if (!expireDateIso) return false;
  try {
    const expiry = new Date(expireDateIso).getTime();
    const cutoff = Date.now() + EXPIRY_BUFFER_DAYS * 24 * 60 * 60 * 1000;
    return expiry <= cutoff;
  } catch {
    return false;
  }
}

// ─── RESULT SHAPE ─────────────────────────────────────────────────────────────

export interface DbprPipelineResult {
  scraped: number;          // total raw records from DBPR
  inFootprint: number;      // passed territory/zip filter
  inserted: number;         // net-new records added to agent_leads
  updated: number;          // existing records refreshed (brokerage, expiry)
  skipped: number;          // duplicates (already in pipeline)
  filtered: number;         // expiring soon, out-of-footprint, etc.
  errors: string[];         // non-fatal scraper errors
  byTerritory: Record<string, number>;  // inserted count per territory
  runDurationMs: number;
}

// ─── PIPELINE RUNNER ─────────────────────────────────────────────────────────

export async function runDbprPipeline(rawDb: any): Promise<DbprPipelineResult> {
  const startMs = Date.now();
  console.log("[DBPR Pipeline] Starting weekly recruiting scrape...");

  // 1. Run full scrape across all counties × license types
  const { records: allRecords, countByCounty, errors } = await scrapeAllDbpr();

  console.log(`[DBPR Pipeline] Scrape complete: ${allRecords.length} raw records. By county:`, countByCounty);

  const result: DbprPipelineResult = {
    scraped: allRecords.length,
    inFootprint: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    filtered: 0,
    errors,
    byTerritory: {},
    runDurationMs: 0,
  };

  // 2. Build dedup sets from existing agent_leads (both dbprLicenseId and email)
  const existingHashes = new Set<string>(
    (rawDb.prepare(`SELECT dedup_hash FROM agent_leads WHERE dedup_hash IS NOT NULL`).all() as any[])
      .map((r: any) => r.dedup_hash)
  );
  const existingLicenseIds = new Set<string>(
    (rawDb.prepare(`SELECT dbpr_license_id FROM agent_leads WHERE dbpr_license_id IS NOT NULL`).all() as any[])
      .map((r: any) => r.dbpr_license_id)
  );
  const existingEmails = new Map<string, number>(
    (rawDb.prepare(`SELECT id, email FROM agent_leads WHERE email IS NOT NULL AND email != ''`).all() as any[])
      .map((r: any) => [r.email.toLowerCase().trim(), r.id])
  );

  // Prepared statements
  const insertStmt = rawDb.prepare(`
    INSERT INTO agent_leads (
      first_name, last_name, email, phone,
      license_status, license_number, license_state,
      current_brokerage,
      territory, matched_territory,
      status, source,
      submitted_at, uploaded_at,
      dbpr_license_id, license_issue_date, license_expire_date,
      last_scraped_at, dedup_hash
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, 'FL',
      ?,
      ?, ?,
      'new', 'dbpr_scrape',
      datetime('now'), datetime('now'),
      ?, ?, ?,
      ?, ?
    )
  `);

  const refreshStmt = rawDb.prepare(`
    UPDATE agent_leads
    SET current_brokerage = ?,
        license_expire_date = ?,
        last_scraped_at = ?,
        dbpr_license_id = COALESCE(dbpr_license_id, ?)
    WHERE dedup_hash = ?
  `);

  const refreshByLicenseIdStmt = rawDb.prepare(`
    UPDATE agent_leads
    SET current_brokerage = ?,
        license_expire_date = ?,
        last_scraped_at = ?,
        dedup_hash = COALESCE(dedup_hash, ?)
    WHERE dbpr_license_id = ?
  `);

  const now = Date.now();

  // 3. Process each record
  for (const record of allRecords) {

    // Territory filter — must be in our NE FL footprint
    const territory = record.zip ? getTerritoryForZip(record.zip) : null;

    // If zip is blank, try to match via county (approximate — accepts record for admin review)
    const inFootprint = territory !== null || (
      record.zip === "" && DBPR_TARGET_COUNTIES.includes(record.county)
    );

    if (!inFootprint) {
      result.filtered++;
      continue;
    }
    result.inFootprint++;

    // Skip licenses expiring within 90 days
    if (record.licenseExpireDate && isLicenseExpiringSoon(record.licenseExpireDate)) {
      result.filtered++;
      continue;
    }

    const hash = makeDedupHash(record.dbprLicenseId, record.email, record.zip);
    const territoryKey = territory || ""; // blank = no zip; admin assigns manually

    // ── Check 1: exact dedup_hash match (most precise)
    if (existingHashes.has(hash)) {
      // Refresh staleness fields without disturbing pipeline status
      refreshStmt.run(
        record.currentBrokerage, record.licenseExpireDate, now,
        record.dbprLicenseId, hash
      );
      result.updated++;
      result.skipped++;
      continue;
    }

    // ── Check 2: dbprLicenseId match (same agent, different hash due to email change)
    if (record.dbprLicenseId && existingLicenseIds.has(record.dbprLicenseId)) {
      refreshByLicenseIdStmt.run(
        record.currentBrokerage, record.licenseExpireDate, now,
        hash, record.dbprLicenseId
      );
      result.updated++;
      result.skipped++;
      continue;
    }

    // ── Check 3: email match (recruited via other source — link DBPR data)
    const emailKey = (record.email || "").toLowerCase().trim();
    if (emailKey && existingEmails.has(emailKey)) {
      const existingId = existingEmails.get(emailKey)!;
      rawDb.prepare(`
        UPDATE agent_leads
        SET dbpr_license_id = ?, license_expire_date = ?,
            current_brokerage = ?, last_scraped_at = ?, dedup_hash = COALESCE(dedup_hash, ?)
        WHERE id = ?
      `).run(
        record.dbprLicenseId, record.licenseExpireDate,
        record.currentBrokerage, now, hash, existingId
      );
      result.updated++;
      result.skipped++;
      continue;
    }

    // ── Net-new record: insert into pipeline
    try {
      insertStmt.run(
        record.firstName,
        record.lastName,
        record.email || null,
        record.phone || null,
        "active",
        record.dbprLicenseId,
        record.currentBrokerage || null,
        territoryKey || null,
        territoryKey || null,
        record.dbprLicenseId,
        record.licenseIssueDate || null,
        record.licenseExpireDate || null,
        now,
        hash
      );

      result.inserted++;
      existingHashes.add(hash); // prevent within-run duplicates
      if (record.dbprLicenseId) existingLicenseIds.add(record.dbprLicenseId);

      if (territoryKey) {
        result.byTerritory[territoryKey] = (result.byTerritory[territoryKey] || 0) + 1;
      } else {
        result.byTerritory["no_zip"] = (result.byTerritory["no_zip"] || 0) + 1;
      }
    } catch (err: any) {
      // UNIQUE constraint on dedup_hash — means a concurrent insert, not a real error
      if (err.message?.includes("UNIQUE")) {
        result.skipped++;
      } else {
        console.error("[DBPR Pipeline] Insert error:", err.message, record.dbprLicenseId);
        result.errors.push(`insert:${record.dbprLicenseId}:${err.message}`);
      }
    }
  }

  result.runDurationMs = Date.now() - startMs;

  console.log(
    `[DBPR Pipeline] Done. Scraped=${result.scraped} InFootprint=${result.inFootprint} ` +
    `Inserted=${result.inserted} Updated=${result.updated} Filtered=${result.filtered} ` +
    `Duration=${(result.runDurationMs / 1000).toFixed(1)}s`
  );

  return result;
}
