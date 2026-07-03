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
