// ─── Shared SQLite connection ─────────────────────────────────────────────────
// A single better-sqlite3 instance reused across all routes.
// Opening a new Database() on every request was causing 9-second freezes.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

// Seed territories
const TERRITORIES = [
  'North Jax & Nassau', 'Jacksonville West', 'Jacksonville East',
  'Intracoastal/Beaches', 'Ponte Vedra/Nocatee/St. Aug', 'St. Johns County', 'Clay County'
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
};

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

// ─── FREC Scraper columns (v11.71) ──────────────────────────────────────────
// Added to agent_leads for FREC licensee integration
const agentLeadCols = rawDb.prepare("PRAGMA table_info(agent_leads)").all().map((c: any) => c.name);
if (!agentLeadCols.includes("frec_license_id"))    rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN frec_license_id TEXT").run();
if (!agentLeadCols.includes("license_issue_date")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN license_issue_date TEXT").run();
if (!agentLeadCols.includes("license_expire_date")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN license_expire_date TEXT").run();
if (!agentLeadCols.includes("last_scraped_at"))    rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN last_scraped_at INTEGER").run();
if (!agentLeadCols.includes("dedup_hash"))         rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN dedup_hash TEXT").run();

// ─── v11.80 — Recruiting module: canRecruit, reactivate_at ────────────────────
const agentColsV80 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV80.includes("can_recruit")) rawDb.prepare("ALTER TABLE agents ADD COLUMN can_recruit INTEGER NOT NULL DEFAULT 0").run();
const alColsV80 = rawDb.prepare("PRAGMA table_info(agent_leads)").all().map((c: any) => c.name);
if (!alColsV80.includes("reactivate_at")) rawDb.prepare("ALTER TABLE agent_leads ADD COLUMN reactivate_at TEXT").run();
// Index for thaw queries
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_reactivate ON agent_leads(reactivate_at) WHERE reactivate_at IS NOT NULL`).run();
// Auto-ice any FREC agent whose license was issued within the last 6 months (joined a brokerage recently)
rawDb.prepare(`
  UPDATE agent_leads
  SET status = 'just_signed',
      reactivate_at = date(license_issue_date, '+6 months')
  WHERE source = 'frec_scrape'
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

// Unique index on dedup_hash — prevents within-run and cross-run duplicates
rawDb.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_leads_dedup_hash ON agent_leads(dedup_hash) WHERE dedup_hash IS NOT NULL`).run();
// Index for freshness queries (last_scraped_at)
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_last_scraped ON agent_leads(last_scraped_at)`).run();
// Index for FREC license ID lookups
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_leads_frec_license ON agent_leads(frec_license_id) WHERE frec_license_id IS NOT NULL`).run();

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

console.log("[db] WAL mode active, foreign keys ON, indexes verified");
