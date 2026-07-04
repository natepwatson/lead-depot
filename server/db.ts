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
  // Deactivate Usman Jan if no headshot on file
  if (agent.name === "Usman Jan") {
    rawDb.prepare("UPDATE agents SET is_active = 0 WHERE id = ? AND (headshot_url IS NULL OR headshot_url = '')").run(agent.id);
    continue;
  }

  const slug = headshotMap[agent.name];
  if (!slug) continue;

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

// v11.53 — turn off lead flow for agents with no headshot (incomplete onboarding)
rawDb.prepare(`
  UPDATE agents SET lead_flow_on = 0
  WHERE (headshot_url IS NULL OR headshot_url = '')
  AND role = 'agent'
  AND is_active = 1
`).run();
