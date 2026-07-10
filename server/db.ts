// ─── Shared SQLite connection ─────────────────────────────────────────────────
// A single better-sqlite3 instance reused across all routes.
// Opening a new Database() on every request was causing 9-second freezes.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EXPIRED_SCRIPT_V14_16 } from "./expired-script";

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const BetterSQLite3 = require("better-sqlite3");

// Use /app/data/data.db in production (persistent volume mount point)
// Fall back to local data.db in development
const DB_DIR = process.env.NODE_ENV === "production" ? "/app/data" : ".";
const DB_PATH = join(DB_DIR, "data.db");
try { mkdirSync(DB_DIR, { recursive: true }); } catch {}

export const rawDb: any = new BetterSQLite3(DB_PATH);

// Ensure settings table exists (used by leaderboard reset and referrals)
rawDb.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
rawDb.prepare(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    brokerage TEXT,
    notes TEXT,
    referred_by INTEGER,
    referred_by_name TEXT,
    created_at TEXT NOT NULL DEFAULT ''
  )
`).run();
rawDb.prepare(`
  CREATE TABLE IF NOT EXISTS geo_cache (
    address_key TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    cached_at TEXT NOT NULL
  )
`).run();
rawDb.prepare(`
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_type TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run();

// ─── Agent profile columns migration (v11.37) ─────────────────────────────────
// ALTER TABLE is safe to run repeatedly — SQLite ignores "duplicate column" errors
const agentCols = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentCols.includes("phone"))        rawDb.prepare("ALTER TABLE agents ADD COLUMN phone TEXT").run();
if (!agentCols.includes("brokerage"))    rawDb.prepare("ALTER TABLE agents ADD COLUMN brokerage TEXT").run();
if (!agentCols.includes("home_address")) rawDb.prepare("ALTER TABLE agents ADD COLUMN home_address TEXT").run();
if (!agentCols.includes("headshot_url")) rawDb.prepare("ALTER TABLE agents ADD COLUMN headshot_url TEXT").run();
if (!agentCols.includes("territory"))    rawDb.prepare("ALTER TABLE agents ADD COLUMN territory TEXT").run();

// ─── Agent onboarding token columns (v11.37) ──────────────────────────────────
if (!agentCols.includes("setup_token"))    rawDb.prepare("ALTER TABLE agents ADD COLUMN setup_token TEXT").run();
if (!agentCols.includes("setup_expires"))  rawDb.prepare("ALTER TABLE agents ADD COLUMN setup_expires TEXT").run();
if (!agentCols.includes("onboarded"))      rawDb.prepare("ALTER TABLE agents ADD COLUMN onboarded INTEGER DEFAULT 0").run();

// ─── LPMAMAB lead columns (v11.38) ───────────────────────────────────────────
const leadCols = rawDb.prepare("PRAGMA table_info(leads)").all().map((c: any) => c.name);
if (!leadCols.includes("l_location"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN l_location TEXT").run();
if (!leadCols.includes("l_price_paid"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN l_price_paid TEXT").run();
if (!leadCols.includes("l_motivation"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN l_motivation TEXT").run();
if (!leadCols.includes("l_agent_history")) rawDb.prepare("ALTER TABLE leads ADD COLUMN l_agent_history TEXT").run();
if (!leadCols.includes("l_mortgage"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN l_mortgage TEXT").run();
if (!leadCols.includes("l_appointment"))   rawDb.prepare("ALTER TABLE leads ADD COLUMN l_appointment TEXT").run();
if (!leadCols.includes("l_buy"))           rawDb.prepare("ALTER TABLE leads ADD COLUMN l_buy TEXT").run();
if (!leadCols.includes("also_buying"))     rawDb.prepare("ALTER TABLE leads ADD COLUMN also_buying INTEGER DEFAULT 0").run();
// v14.53 — 3-way intent selector: 'sell_only' | 'sell_and_buy' | 'buy_only'. Null defaults to 'sell_only'.
if (!leadCols.includes("intent"))          rawDb.prepare("ALTER TABLE leads ADD COLUMN intent TEXT").run();
if (!leadCols.includes("b_location"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN b_location TEXT").run();
if (!leadCols.includes("b_price"))         rawDb.prepare("ALTER TABLE leads ADD COLUMN b_price TEXT").run();
if (!leadCols.includes("b_motivation"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN b_motivation TEXT").run();
if (!leadCols.includes("b_agent"))         rawDb.prepare("ALTER TABLE leads ADD COLUMN b_agent TEXT").run();
if (!leadCols.includes("b_mortgage"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN b_mortgage TEXT").run();
if (!leadCols.includes("score"))           rawDb.prepare("ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0").run();
if (!leadCols.includes("territory"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN territory TEXT").run();
if (!leadCols.includes("source"))          rawDb.prepare("ALTER TABLE leads ADD COLUMN source TEXT DEFAULT 'csv_upload'").run();
if (!leadCols.includes("city"))            rawDb.prepare("ALTER TABLE leads ADD COLUMN city TEXT").run();
if (!leadCols.includes("state"))           rawDb.prepare("ALTER TABLE leads ADD COLUMN state TEXT").run();
if (!leadCols.includes("zip"))             rawDb.prepare("ALTER TABLE leads ADD COLUMN zip TEXT").run();

// ─── leads — core columns that may be missing on older DBs ───────────────────
if (!leadCols.includes("owner_name"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN owner_name TEXT").run();
if (!leadCols.includes("email"))            rawDb.prepare("ALTER TABLE leads ADD COLUMN email TEXT").run();
if (!leadCols.includes("motivation"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN motivation TEXT").run();
if (!leadCols.includes("extra_data"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN extra_data TEXT").run();
if (!leadCols.includes("assigned_agent_id")) rawDb.prepare("ALTER TABLE leads ADD COLUMN assigned_agent_id INTEGER").run();
if (!leadCols.includes("attempt_count"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0").run();
if (!leadCols.includes("callback_date"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN callback_date TEXT").run();
if (!leadCols.includes("uploaded_at"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN uploaded_at TEXT NOT NULL DEFAULT ''").run();
if (!leadCols.includes("uploaded_by"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN uploaded_by INTEGER").run();
if (!leadCols.includes("batch_id"))         rawDb.prepare("ALTER TABLE leads ADD COLUMN batch_id TEXT").run();

// ─── Recycle cooldown (v14.39) — unified 14d on-ice timer for Expired + Absentee ─
if (!leadCols.includes("recycle_cooldown_until")) rawDb.prepare("ALTER TABLE leads ADD COLUMN recycle_cooldown_until INTEGER").run();

// ─── Per-line no-answer counter (v14.40) — 6 attempts per phone before it's struck ─
// JSON object mapping phone → attempt count, e.g. {"9041234567": 3, "9047654321": 6}
// NULL = grandfathered (all lines treated as 0). No Answer + Left Voicemail increment.
// Wrong # + Disconnected don't touch this (they immediately strike the line).
if (!leadCols.includes("phone_attempts")) rawDb.prepare("ALTER TABLE leads ADD COLUMN phone_attempts TEXT").run();

// v14.46 — LandVoice Intake v2 columns removed. LandVoice ingest now flows through the
// CSV import path only (server/batchleads-csv-import.ts), which writes to legacy columns.
// Existing prod DBs may still have these columns dormant; SQLite doesn't drop them.
// Fresh installs will simply not create them.

// ─── lead_activity — lpmamab_snapshot column (v11.38) ────────────────────────
const actCols = rawDb.prepare("PRAGMA table_info(lead_activity)").all().map((c: any) => c.name);
if (!actCols.includes("lpmamab_snapshot"))  rawDb.prepare("ALTER TABLE lead_activity ADD COLUMN lpmamab_snapshot TEXT").run();

// ─── v11.39 — agent_points table (gamification) ──────────────────────────────
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS agent_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    lead_id INTEGER,
    created_at TEXT NOT NULL DEFAULT ''
  )
`);

// ─── v11.41 — headshot injection for existing agents ─────────────────────────
// On every boot: copies slug-named headshots to <id>.jpg in dist/public/headshots/
// and updates headshot_url in DB. Safe to repeat — only overwrites stale/missing.

// ─── Agent Prospecting tables (v11.46) ──────────────────────────────────────
const existingTables = (rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r:any) => r.name);
if (!existingTables.includes('agent_leads')) rawDb.exec(`CREATE TABLE IF NOT EXISTS agent_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
  email TEXT, phone TEXT,
  license_status TEXT NOT NULL DEFAULT 'active',
  license_number TEXT, license_state TEXT, years_experience TEXT,
  current_brokerage TEXT, reason_for_leaving TEXT,
  gci_range TEXT, transactions_last_12mo INTEGER,
  territory TEXT, matched_territory TEXT,
  referral_source TEXT, referred_by_name TEXT, applicant_notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_admin_id INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, callback_date TEXT,
  r_license TEXT, r_production TEXT, r_motivation TEXT,
  r_timeline TEXT, r_objections TEXT, r_territory TEXT, r_appointment TEXT,
  fub_person_id INTEGER, fub_synced_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'recruiting_page',
  uploaded_at TEXT, uploaded_by INTEGER, batch_id TEXT
)`);
if (!existingTables.includes('agent_lead_activity')) rawDb.exec(`CREATE TABLE IF NOT EXISTS agent_lead_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_lead_id INTEGER NOT NULL, caller_id INTEGER, outcome TEXT NOT NULL,
  notes TEXT, latte_snapshot TEXT, points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
)`);
if (!existingTables.includes('territories')) rawDb.exec(`CREATE TABLE IF NOT EXISTS territories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_open INTEGER NOT NULL DEFAULT 1
)`);
if (!existingTables.includes('app_settings')) rawDb.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL
)`);

// v14.46 — LandVoice Intake v2 tables removed (landvoice_credentials, landvoice_raw_ingest,
// lead_contacts, data_genie_lookups). CSV upload is the sole seller intake path.

// Seed territories
const TERRITORIES = [
  'North Jax & Nassau', 'Jacksonville West', 'Jacksonville East',
  'Intracoastal/Beaches', 'Ponte Vedra/Nocatee/St. Aug', 'St. Johns County'
];
for (const t of TERRITORIES) {
  try { rawDb.prepare("INSERT OR IGNORE INTO territories (name) VALUES (?)").run(t); } catch {}
}

const headshotMap: Record<string, string> = {
  "Bronson Sarmento": "bronson-sarmento",
  "Cory Deroin":      "cory-deroin",
  "Vonda Jewell":     "vonda-jewell",
  "Gabriel Duran":    "gabriel-duran",
  "Denise Jacobs":    "denise-jacobs",
  "Nate Watson":      "nate-watson",
  "Alex Watson":      "alex-watson",
  "Noah Tomlinson":   "noah-tomlinson",  // v14.17
};

// v14.17 — One-shot reactivation: Noah was auto-deactivated by the boot sweep
// (v11.54) because his slug wasn't in headshotMap yet. Now that he's mapped, flip him
// back on so he receives leads again. Idempotent — only affects id=6 if still off.
try {
  rawDb.prepare(`
    UPDATE agents
       SET is_active = 1, lead_flow_on = 1
     WHERE name = 'Noah Tomlinson'
       AND (is_active = 0 OR lead_flow_on = 0)
  `).run();
} catch (e) {
  console.error("[v14.17 noah-reactivate] Failed:", e);
}

// v14.29.4 — Full removal of Luis Marquez (agent id=5) from Lead Depot.
// Alex confirmed: delete from DB entirely, leave FUB record alone.
// Safe: verified 0 leads currently assigned to id=5. Any dependent rows
// (agent_points, lead_activity, agent_leads, lead_locks) get cleaned up.
// Idempotent — subsequent boots find no matching row and no-op.
try {
  const luis = rawDb.prepare("SELECT id FROM agents WHERE name = 'Luis Marquez' OR email = 'luis.sellsjax@gmail.com'").get() as { id: number } | undefined;
  if (luis) {
    // Safety net: if any leads still point at Luis, return them to the pool first.
    rawDb.prepare("UPDATE leads SET status = 'unassigned', assigned_agent_id = NULL, callback_date = NULL WHERE assigned_agent_id = ?").run(luis.id);
    // Clean up any related rows in tables that reference agents.id
    for (const tbl of ["agent_points", "lead_activity", "agent_leads", "lead_locks", "agent_recruiting_stats", "agent_daily_stats"]) {
      try { rawDb.prepare(`DELETE FROM ${tbl} WHERE agent_id = ?`).run(luis.id); } catch {}
    }
    rawDb.prepare("DELETE FROM agents WHERE id = ?").run(luis.id);
    console.log(`[v14.29.4 luis-delete] Removed agent id=${luis.id} (Luis Marquez) and dependent rows.`);
  }
} catch (e) {
  console.error("[v14.29.4 luis-delete] Failed:", e);
}

// In production: save to Railway persistent volume (/app/data/headshots/)
// In dev: save alongside the build in dist/public/headshots/
const isProduction = process.env.NODE_ENV === "production";
const headshotsDir = isProduction ? "/app/data/headshots" : join(__dirname, "public", "headshots");
mkdirSync(headshotsDir, { recursive: true });

// Source: slug-named files committed to dist/public/headshots/ in git
const headshotSourceDir = join(__dirname, "public", "headshots");

const allAgents = rawDb.prepare("SELECT id, name, headshot_url FROM agents").all() as any[];
for (const agent of allAgents) {
  const slug = headshotMap[agent.name];

  if (!slug) {
    // v11.54 — agents with no headshot in headshotMap are incomplete; deactivate fully
    rawDb.prepare(`
      UPDATE agents SET is_active = 0, lead_flow_on = 0
      WHERE id = ? AND (headshot_url IS NULL OR headshot_url = '' OR headshot_url NOT LIKE '/headshots/%')
    `).run(agent.id);
    continue;
  }

  // Copy slug file into persistent headshots dir on every boot
  try {
    const fs2 = require("node:fs");
    const srcFile = join(headshotSourceDir, `${slug}.jpg`);
    const destFile = join(headshotsDir, `${slug}.jpg`);
    if (fs2.existsSync(srcFile)) fs2.copyFileSync(srcFile, destFile);
  } catch (_) { /* non-fatal */ }

  // Update DB to point at the slug-named URL
  const needsUpdate = !agent.headshot_url ||
    agent.headshot_url.startsWith("data:") ||
    !agent.headshot_url.startsWith("/headshots/");

  if (needsUpdate) {
    rawDb.prepare("UPDATE agents SET headshot_url = ? WHERE id = ?").run(`/headshots/${slug}.jpg`, agent.id);
  }
}

// v11.56 — leaderboard snapshots: permanent record of every period before reset
rawDb.prepare(`
  CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_label TEXT NOT NULL,
    reset_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`).run();

// ─── DBPR Scraper columns (v11.71, renamed from FREC in v13.4) ──────────────
// Added to agent_leads for DBPR licensee integration
const agentLeadCols = rawDb.prepare("PRAGMA table_info(agent_leads)").all().map((c: any) => c.name);
if (!agentLeadCols.includes("dbpr_license_id"))    rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN dbpr_license_id TEXT").run();
if (!agentLeadCols.includes("license_issue_date")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN license_issue_date TEXT").run();
if (!agentLeadCols.includes("license_expire_date")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN license_expire_date TEXT").run();
if (!agentLeadCols.includes("last_scraped_at"))    rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN last_scraped_at INTEGER").run();
if (!agentLeadCols.includes("dedup_hash"))         rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN dedup_hash TEXT").run();

// v13.4 — one-shot migration: copy legacy frec_license_id → dbpr_license_id and
// rewrite source='frec_scrape' → 'dbpr_scrape'. Safe to re-run.
const agentLeadColsPostAdd = rawDb.prepare("PRAGMA table_info(agent_leads)").all().map((c: any) => c.name);
if (agentLeadColsPostAdd.includes("frec_license_id")) {
  rawDb.prepare(`
    UPDATE agent_leads
       SET dbpr_license_id = frec_license_id
     WHERE dbpr_license_id IS NULL
       AND frec_license_id IS NOT NULL
  `).run();
}
rawDb.prepare(`UPDATE agent_leads SET source = 'dbpr_scrape' WHERE source = 'frec_scrape'`).run();

// ─── v11.80 — Recruiting module: canRecruit, reactivate_at ────────────────────
const agentColsV80 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV80.includes("can_recruit")) rawDb.prepare("ALTER TABLE agents ADD COLUMN can_recruit INTEGER NOT NULL DEFAULT 0").run();
const alColsV80 = rawDb.prepare("PRAGMA table_info(agent_leads)").all().map((c: any) => c.name);
if (!alColsV80.includes("reactivate_at")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN reactivate_at TEXT").run();
// Index for thaw queries
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_reactivate ON agent_leads(reactivate_at) WHERE reactivate_at IS NOT NULL`).run();
// Auto-ice any DBPR agent whose license was issued within the last 6 months (joined a brokerage recently)
rawDb.prepare(`
  UPDATE agent_leads
  SET status = 'just_signed',
      reactivate_at = date(license_issue_date, '+6 months')
  WHERE source = 'dbpr_scrape'
    AND license_issue_date IS NOT NULL
    AND date(license_issue_date) >= date('now', '-6 months')
    AND status = 'new'
    AND reactivate_at IS NULL
`).run();
// Thaw any not_now / just_signed leads whose reactivate_at has passed
rawDb.prepare(`
  UPDATE agent_leads
  SET status = 'new', reactivate_at = NULL, callback_date = NULL
  WHERE status IN ('not_now', 'just_signed')
    AND reactivate_at IS NOT NULL
    AND date(reactivate_at) <= date('now')
`).run();
// v11.82 — Performance gate: minDialsPerWeek
const agentColsV82 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV82.includes("min_dials_per_week")) rawDb.prepare("ALTER TABLE agents ADD COLUMN min_dials_per_week INTEGER NOT NULL DEFAULT 0").run();

// ─── v12.5 — Two-territory support + territory-closed notice + points scoping ──
// Agents can now pick up to 2 territories (hard cap). Territory admins can close
// a territory, which clears its leads and forces any agent assigned to it to
// reselect. Points table gets a scope column so seller/recruiting leaderboards
// stay fully isolated.
const agentColsV125 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV125.includes("territory1"))               rawDb.prepare("ALTER TABLE agents ADD COLUMN territory1 TEXT").run();
if (!agentColsV125.includes("territory2"))               rawDb.prepare("ALTER TABLE agents ADD COLUMN territory2 TEXT").run();
if (!agentColsV125.includes("territory_closed_notice"))  rawDb.prepare("ALTER TABLE agents ADD COLUMN territory_closed_notice INTEGER NOT NULL DEFAULT 0").run();

// v13.9 — home_county for home-county-first lead serving
const agentColsV139 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV139.includes("home_county")) rawDb.prepare("ALTER TABLE agents ADD COLUMN home_county TEXT").run();

// v14.59 Bucket 5 Phase B — Email hygiene / tombstone + pending_email
//
// merged_into_agent_id: nullable FK-like column. Set only on merge tombstones,
// points at the surviving canonical agent id. Combined with the sentinel email
// shape 'tombstone:<sourceId>:<origEmail>' this makes tombstones login-locked
// (no real email will ever equal a `tombstone:*` string) AND easy to find
// programmatically (WHERE merged_into_agent_id IS NOT NULL).
//
// pending_email + pending_email_token + pending_email_expires: staging area for
// self-service agent email changes. Non-admin agent PATCHing their email doesn't
// rewrite email immediately — we stash the new address here, mint a token, hash it,
// send verification to the NEW address, and only flip email on token click before
// expiry. Admin-initiated changes bypass this and apply instantly.
const agentColsV1459 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV1459.includes("merged_into_agent_id"))  rawDb.prepare("ALTER TABLE agents ADD COLUMN merged_into_agent_id INTEGER").run();
if (!agentColsV1459.includes("pending_email"))         rawDb.prepare("ALTER TABLE agents ADD COLUMN pending_email TEXT").run();
if (!agentColsV1459.includes("pending_email_token"))   rawDb.prepare("ALTER TABLE agents ADD COLUMN pending_email_token TEXT").run();
if (!agentColsV1459.includes("pending_email_expires")) rawDb.prepare("ALTER TABLE agents ADD COLUMN pending_email_expires TEXT").run();

// v14.61 Bucket 5 Phase C — Deactivate reversibility window + agent audit log.
//
// deactivated_at: unix ms timestamp of the most recent deactivation. NULL means
// never deactivated OR grandfathered legacy row. The reactivate endpoint checks
// Date.now() - deactivated_at <= 7 days; past that, the row is read-only.
//
// agent_audit_log: append-only trail of every lifecycle event affecting an
// agent (deactivate, reactivate, merge, email change, password reset, etc.).
// Feeds Phase D's admin Agent Lifecycle tab.
const agentColsV1461 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV1461.includes("deactivated_at")) rawDb.prepare("ALTER TABLE agents ADD COLUMN deactivated_at INTEGER").run();
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS agent_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor_id INTEGER,
    target_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_audit_log_target ON agent_audit_log(target_id, ts DESC);
`);

// v14.61 — One-shot FK normalization for the Denise Jacobs tombstones.
//
// Legacy state (before v14.61): agent rows 11, 12, 13 are tombstones with
// `merged_into_agent_id = 10` (points at the canonical Denise on
// denise@watsonbrothersgroup.com). The tombstoned original email is
// djacobs312@gmail.com, and that email now lives on a separate active row
// id=14 (created after the merge). Pointing the FK at 10 works today but is
// tribal knowledge — it doesn't match the semantic contract that
// `merged_into_agent_id` names the row now holding the original identity.
//
// Fix: remap 11/12/13 from merged_into_agent_id=10 → 14, but ONLY if id=14
// exists and its email starts with 'djacobs312@'. Idempotent — does nothing on
// re-boot once remapped. Guarded so it can't fire in a fresh dev DB that lacks
// id=14. Logs an fk_remap audit event per row.
try {
  const denise14 = rawDb.prepare("SELECT id, email FROM agents WHERE id = 14").get() as any;
  if (denise14 && typeof denise14.email === "string" && denise14.email.toLowerCase().startsWith("djacobs312@")) {
    const remapCandidates = rawDb.prepare(
      "SELECT id, merged_into_agent_id FROM agents WHERE id IN (11, 12, 13) AND merged_into_agent_id = 10"
    ).all() as Array<{ id: number; merged_into_agent_id: number }>;
    for (const row of remapCandidates) {
      rawDb.prepare("UPDATE agents SET merged_into_agent_id = 14 WHERE id = ?").run(row.id);
      rawDb.prepare(
        `INSERT INTO agent_audit_log (ts, actor_id, target_id, event, before_json, after_json, notes)
         VALUES (?, ?, ?, 'fk_remap', ?, ?, ?)`
      ).run(
        Date.now(),
        null, // system/boot migration
        row.id,
        JSON.stringify({ merged_into_agent_id: 10 }),
        JSON.stringify({ merged_into_agent_id: 14 }),
        "v14.61 Denise FK normalization: remapped tombstone from canonical Denise (id=10) to the row now holding djacobs312@gmail.com (id=14).",
      );
    }
    if (remapCandidates.length > 0) {
      console.log(`[db] v14.61 Denise FK remap: converted ${remapCandidates.length} tombstone row(s) from merged_into_agent_id=10 → 14`);
    }
  }
} catch (err) {
  console.error("[db] v14.61 Denise FK remap failed:", err);
}

// v14.59 — Retroactive tombstone conversion. Any row still carrying the legacy
// `_merged_into_<targetId>_from_<sourceId>_<origEmail>` OR
// `_merged_into_<targetId>_<origEmail>` sentinel gets rewritten to the new shape:
//   email = 'tombstone:<sourceId>:<origEmail>'
//   merged_into_agent_id = <targetId>
// Idempotent — skips rows already in the new shape (email LIKE 'tombstone:%').
try {
  // SUBSTR match is safer than LIKE here because underscores in `_merged_into_`
  // are LIKE wildcards. SUBSTR (email, 1, 13) = '_merged_into_' is a literal match.
  const legacyTombstones = rawDb.prepare(
    "SELECT id, email FROM agents WHERE SUBSTR(email, 1, 13) = '_merged_into_'"
  ).all() as Array<{ id: number; email: string }>;
  let converted = 0;
  for (const row of legacyTombstones) {
    // Try v14.58 shape first: `_merged_into_<targetId>_from_<sourceId>_<origEmail>`
    let m = row.email.match(/^_merged_into_(\d+)_from_(\d+)_(.+)$/);
    let targetId: number | null = null;
    let sourceId: number = row.id; // fallback: the row's own id
    let origEmail = "unknown";
    if (m) {
      targetId = parseInt(m[1]);
      sourceId = parseInt(m[2]);
      origEmail = m[3];
    } else {
      // Older shape: `_merged_into_<targetId>_<origEmail>`
      m = row.email.match(/^_merged_into_(\d+)_(.+)$/);
      if (m) {
        targetId = parseInt(m[1]);
        origEmail = m[2];
      }
    }
    if (targetId === null) continue; // unparseable — leave alone
    const newEmail = `tombstone:${sourceId}:${origEmail}`;
    // Guard against unique-constraint collision on the rewrite (extremely unlikely,
    // but two rows with identical parsed sourceIds would collide). Use ROWID id as
    // the ultimate disambiguator.
    let candidate = newEmail;
    let attempt = 0;
    while (rawDb.prepare("SELECT 1 FROM agents WHERE email = ? AND id <> ?").get(candidate, row.id)) {
      attempt++;
      candidate = `${newEmail}#${attempt}`;
      if (attempt > 5) break;
    }
    rawDb.prepare("UPDATE agents SET email = ?, merged_into_agent_id = ? WHERE id = ?")
      .run(candidate, targetId, row.id);
    converted++;
  }
  if (converted > 0) console.log(`[db] v14.59 tombstone migration: converted ${converted} legacy _merged_into_ row(s) to new shape`);
} catch (err) {
  console.error("[db] v14.59 tombstone migration failed:", err);
}
// One-shot backfill: copy legacy territory into territory1 for any agent that
// hasn't been migrated yet. Safe to re-run — only fills when territory1 is null.
rawDb.prepare(`
  UPDATE agents
     SET territory1 = territory
   WHERE territory1 IS NULL
     AND territory IS NOT NULL
     AND TRIM(territory) <> ''
`).run();

const pointsColsV125 = rawDb.prepare("PRAGMA table_info(agent_points)").all().map((c: any) => c.name);
if (!pointsColsV125.includes("scope")) {
  rawDb.prepare("ALTER TABLE agent_points ADD COLUMN scope TEXT NOT NULL DEFAULT 'seller'").run();
  // Existing rows are all seller-side by definition (recruiting scope didn't exist
  // until v12.5). The DEFAULT 'seller' handles it, but we re-affirm here in case
  // any historical NULLs slipped in via direct SQL.
  rawDb.prepare("UPDATE agent_points SET scope = 'seller' WHERE scope IS NULL OR scope = ''").run();
}
// Index for scope-filtered leaderboard queries
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_points_scope_agent
  ON agent_points(scope, agent_id)`).run();

// v12.5 — recruiting is admin-only now. Any legacy "recruiter" role accounts
// are collapsed to "agent" (seller-side). Admins still have full recruiting access.
rawDb.prepare("UPDATE agents SET role = 'agent' WHERE role = 'recruiter'").run();

// Unique index on dedup_hash — prevents within-run and cross-run duplicates
rawDb.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_leads_dedup_hash ON agent_leads(dedup_hash) WHERE dedup_hash IS NOT NULL`).run();
// Index for freshness queries (last_scraped_at)
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_last_scraped ON agent_leads(last_scraped_at)`).run();
// Index for DBPR license ID lookups
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_dbpr_license ON agent_leads(dbpr_license_id) WHERE dbpr_license_id IS NOT NULL`).run();

// ─── SAFEGUARDS (v11.70) ──────────────────────────────────────────────────────

// WAL mode — concurrent reads during writes, prevents DB lock contention
rawDb.pragma("journal_mode = WAL");

// Enforce foreign key constraints at the SQLite level
rawDb.pragma("foreign_keys = ON");

// Larger page cache: 8MB — reduces disk I/O on full table scans that remain
rawDb.pragma("cache_size = -8000");

// Synchronous = NORMAL — safe with WAL, faster than FULL
rawDb.pragma("synchronous = NORMAL");

// ─── Indexes on hot columns (v11.70) ─────────────────────────────────────────
// These prevent full table scans on the most frequent query patterns.
// All are IF NOT EXISTS — safe to run on every boot.

// lead_activity: agent_id + created_at — leaderboard GROUP BY, daily digest
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lead_activity_agent_created
  ON lead_activity(agent_id, created_at)`).run();

// lead_activity: lead_id — getActivitiesForLead(), outcome log queries
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lead_activity_lead_id
  ON lead_activity(lead_id)`).run();

// leads: assigned_agent_id — all per-agent lead fetches, deactivation handler
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_assigned_agent
  ON leads(assigned_agent_id)`).run();

// leads: status — pipeline counts, redistribution filters, stale audit
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_status
  ON leads(status)`).run();

// leads: uploaded_at — ordering, BatchLeads new-lead window query
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_uploaded_at
  ON leads(uploaded_at)`).run();

// leads: uploaded_by — network referral counts
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_uploaded_by
  ON leads(uploaded_by)`).run();

// leads: callback_date — daily callback redistribution query
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_callback_date
  ON leads(callback_date)`).run();

// leads: source — BatchLeads pipeline new-lead assignment window
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_source
  ON leads(source)`).run();

// agents: email — login lookup
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agents_email
  ON agents(email)`).run();

// geo_cache: address_key — geocode cache hits (already a PK but explicit helps explain)
// (skipped — already a PRIMARY KEY, which is automatically indexed)

// ─── v12.1 — performance indexes on high-frequency recruiting/leaderboard tables ──
// agent_lead_activity: agent_lead_id — FK join in recruiting activity queries
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_lead_activity_lead_id
  ON agent_lead_activity(agent_lead_id)`).run();

// agent_lead_activity: caller_id + created_at — leaderboard aggregation, weekly dial gate
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_lead_activity_caller_created
  ON agent_lead_activity(caller_id, created_at)`).run();

// agent_points: agent_id + created_at — weekly points queries, performance gate
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_points_agent_created
  ON agent_points(agent_id, created_at)`).run();

// agent_points: reason — filter dials/wins/refs per leaderboard category
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_points_reason
  ON agent_points(reason)`).run();

// ─── v13.8 — Pool-serving model (territories & callbacks removed) ─────────────
// The 3-playbook model (Expired / FSBO / Land 1AC+) replaces territory routing
// and pre-assignment. Leads live in shared pools. Agents click Load Leads and
// get one lead at a time (FIFO), locked to them for 60 minutes.
//
// Backwards compatibility: legacy territory/callback/assigned_agent_id columns
// STAY on the leads table so historical data is preserved. New code no longer
// reads or writes them. Do not drop columns — SQLite drops are destructive.

// leads: new pool-serving columns
const leadColsV138 = rawDb.prepare("PRAGMA table_info(leads)").all().map((c: any) => c.name);
if (!leadColsV138.includes("lot_size_acres"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN lot_size_acres REAL").run();
if (!leadColsV138.includes("assessed_value"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN assessed_value INTEGER").run();
if (!leadColsV138.includes("list_price"))           rawDb.prepare("ALTER TABLE leads ADD COLUMN list_price INTEGER").run();
if (!leadColsV138.includes("year_purchased"))       rawDb.prepare("ALTER TABLE leads ADD COLUMN year_purchased INTEGER").run();
if (!leadColsV138.includes("last_sale_price"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN last_sale_price INTEGER").run(); // v14.22 — equity calc
if (!leadColsV138.includes("county"))               rawDb.prepare("ALTER TABLE leads ADD COLUMN county TEXT").run();
if (!leadColsV138.includes("lat"))                  rawDb.prepare("ALTER TABLE leads ADD COLUMN lat REAL").run();
if (!leadColsV138.includes("lng"))                  rawDb.prepare("ALTER TABLE leads ADD COLUMN lng REAL").run();

// lead_locks — 60-minute exclusive lock so two agents don't call the same lead.
// One row per active lock. Deleted on outcome, or auto-expired via cron.
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS lead_locks (
    lead_id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  )
`);
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lead_locks_agent ON lead_locks(agent_id)`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lead_locks_expires ON lead_locks(expires_at)`).run();

// leads: index on lead_type + status for FIFO pool queries ("next unclaimed")
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_type_status_uploaded
  ON leads(lead_type, status, uploaded_at)`).run();

// One-shot: any leads still in "callback_requested" status get flipped to "unassigned"
// so they re-enter the pool. Callbacks are FUB-side now.
rawDb.prepare(`
  UPDATE leads SET status = 'unassigned', assigned_agent_id = NULL, callback_date = NULL
  WHERE status = 'callback_requested'
`).run();

// One-shot: unassign every currently-assigned lead. v13.8 has no per-agent queue —
// leads flow through the shared pool. This releases the 291 pre-assigned leads and
// any others so they hit the new UI cleanly.
rawDb.prepare(`
  UPDATE leads SET status = 'unassigned', assigned_agent_id = NULL
  WHERE status = 'assigned' AND assigned_agent_id IS NOT NULL
`).run();

// ─── v14.16 — follow_up_timing column on leads ────────────────────────────────
// KIT modal captures a 4-option follow-up window (a_few_days / few_weeks /
// few_months / six_months). Used by credibility email + agent's My Leads
// window filter. Safe to re-run — ALTER TABLE ignored if column exists.
const leadColsV1416 = rawDb.prepare("PRAGMA table_info(leads)").all().map((c: any) => c.name);
if (!leadColsV1416.includes("follow_up_timing")) rawDb.prepare("ALTER TABLE leads ADD COLUMN follow_up_timing TEXT").run();

// ─── v14.16 — dead_lines JSON column on leads ─────────────────────────────────
// Wrong # and Disconnected outcomes mark a single phone line dead without
// killing the whole lead. dead_lines is a JSON array of the phone numbers
// (E.164 or normalized digits) that should be skipped in future dial rotation.
// The lead itself only fully exits the pool when ALL phones are dead OR the
// agent explicitly Lists / Not Interested / Appt Set / KIT the lead.
if (!leadColsV1416.includes("dead_lines")) rawDb.prepare("ALTER TABLE leads ADD COLUMN dead_lines TEXT DEFAULT '[]'").run();
// Ensure any legacy NULLs become empty JSON arrays so downstream JSON.parse
// never explodes on exhaustion checks. Safe to re-run.
rawDb.prepare("UPDATE leads SET dead_lines = '[]' WHERE dead_lines IS NULL OR dead_lines = ''").run();

// ─── v14.16 — Expired script seed/upsert ─────────────────────────────────────
// The scripts table is versioned via server code, not the database. On every
// boot we upsert the current Expired script content so a redeploy is enough
// to update it. Other lead_type scripts (fsbo, land, etc.) are managed via the
// admin PATCH /api/scripts/:type endpoint and are not touched here.
try {
  rawDb.prepare(`
    INSERT INTO scripts (lead_type, content, updated_at)
    VALUES ('expired', ?, ?)
    ON CONFLICT(lead_type) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(EXPIRED_SCRIPT_V14_16, new Date().toISOString());
  console.log("[db] v14.16 Expired script seeded into scripts table");
} catch (e: any) {
  console.error("[db] Expired script seed failed:", e.message);
}

console.log("[db] WAL mode active, foreign keys ON, indexes verified");
console.log("[db] v13.8 pool-serving schema ready (lead_locks table + new lead columns)");
