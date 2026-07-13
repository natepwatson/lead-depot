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
// v15.3 — Backfill intent from legacy also_buying flag once per boot (idempotent).
// Rows with also_buying=1 and no intent set become 'sell_and_buy'; also_buying=0/null with no intent stay null (UI defaults to sell_only).
try {
  const backfilled = rawDb.prepare(
    "UPDATE leads SET intent = 'sell_and_buy' WHERE intent IS NULL AND also_buying = 1"
  ).run();
  if (backfilled.changes > 0) console.log(`[db] v15.3 backfill: set intent='sell_and_buy' on ${backfilled.changes} legacy rows`);
} catch (e) { console.error("[db] v15.3 intent backfill failed:", e); }
if (!leadCols.includes("b_location"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN b_location TEXT").run();
if (!leadCols.includes("b_price"))         rawDb.prepare("ALTER TABLE leads ADD COLUMN b_price TEXT").run();
if (!leadCols.includes("b_motivation"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN b_motivation TEXT").run();
if (!leadCols.includes("b_agent"))         rawDb.prepare("ALTER TABLE leads ADD COLUMN b_agent TEXT").run();
if (!leadCols.includes("b_mortgage"))      rawDb.prepare("ALTER TABLE leads ADD COLUMN b_mortgage TEXT").run();
// v15.11.27 — Buyer Target (future home) JSON blob: beds, baths, sqft, budget, garage, pool, areas, mustHaves.
// Distinct from extraData (which describes the lead's CURRENT home from LandVoice/BatchLeads/MLS import).
if (!leadCols.includes("buyer_target"))    rawDb.prepare("ALTER TABLE leads ADD COLUMN buyer_target TEXT").run();
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
// v15.4 — RETIRED. Column kept for backward compatibility but never read/written by app.
// Boot sweep below thaws any leads still on cooldown from before v15.4.
if (!leadCols.includes("recycle_cooldown_until")) rawDb.prepare("ALTER TABLE leads ADD COLUMN recycle_cooldown_until INTEGER").run();
try {
  const thawed = rawDb.prepare("UPDATE leads SET recycle_cooldown_until = NULL WHERE recycle_cooldown_until IS NOT NULL").run().changes;
  if (thawed > 0) console.log(`[v15.4 thaw] Cleared cooldown on ${thawed} leads. Recycle cooldown is retired.`);
} catch (err) {
  console.error("[v15.4 thaw] Sweep failed (non-fatal):", err);
}

// ─── v15.4 — Phone attempt outcome tracker ───────────────────────────────────
// Logs the fate of each phone line that hits the 12-attempt strike cap so we can
// answer: "of lines struck at 12, what happens next?" (auto-delete? other line
// connects? recycled back and later contacted?).
// After 2 weeks of data we'll know whether 12 is the right floor or whether it's
// worth pushing to 16. Written from the no_answer path in server/routes.ts.
try {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS phone_attempt_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      lead_type TEXT NOT NULL,
      struck_at INTEGER NOT NULL,
      struck_by_agent_id INTEGER,
      lead_score INTEGER,
      resolution TEXT,
      resolution_at INTEGER,
      resolution_notes TEXT,
      UNIQUE(lead_id, phone)
    )
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_phone_attempt_outcomes_resolution ON phone_attempt_outcomes(resolution)`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_phone_attempt_outcomes_lead ON phone_attempt_outcomes(lead_id)`);
} catch (err) {
  console.error("[v15.4 phone_attempt_outcomes] Migration failed:", err);
}

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

// v15.11 — Push subscription tables (mirror of storage.ts migration; migration
// parity rule per skill doc)
if (!existingTables.includes('push_subscriptions')) rawDb.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT ''
)`);
if (!existingTables.includes('push_fire_log')) rawDb.exec(`CREATE TABLE IF NOT EXISTS push_fire_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key TEXT NOT NULL UNIQUE,
  fired_at TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
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
  "Gabriel Marcano":  "gabriel-marcano", // v15.11.6
};

// v15.11.6 — One-shot reactivate Gabriel Marcano: he was added in a prior
// deploy without a mapped slug and the boot sweep auto-deactivated him.
// Now that his slug is mapped + jpg is on disk, flip him back on.
try {
  rawDb.prepare(`
    UPDATE agents
       SET is_active = 1, lead_flow_on = 1
     WHERE name = 'Gabriel Marcano'
       AND (is_active = 0 OR lead_flow_on = 0)
  `).run();
} catch (e) {
  console.error("[v15.11.6 gabriel-marcano-reactivate] Failed:", e);
}

// v15.11.7 — One-shot backfill: 13 agents had NULL tutorial_completed_at because
// their finish() call silently 401'd on iOS PWAs. Mark everyone who was already
// added and active as tutorial-complete NOW so nobody has to re-watch. Idempotent —
// only affects rows that are still NULL. New agents added after this deploy will
// go through the tutorial normally.
try {
  const info = rawDb.prepare(`
    UPDATE agents
       SET tutorial_completed_at = ?
     WHERE tutorial_completed_at IS NULL
       AND is_active = 1
  `).run(new Date().toISOString());
  if (info.changes > 0) console.log(`[v15.11.7 tutorial-backfill] Marked ${info.changes} agents as tutorial-complete.`);
} catch (e) {
  console.error("[v15.11.7 tutorial-backfill] Failed:", e);
}

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

// ─── v14.81 — Onboarding: profile_completed_at + tutorial_completed_at ───────
// profile_completed_at: nullable ISO timestamp. Set once the agent completes
// the mandatory ProfileGate (name/phone/brokerage/home_address all filled).
// tutorial_completed_at: nullable ISO timestamp. Set once the agent finishes
// (or, on rewatch, skips) the 7-chapter TutorialFlow. NULL on either column
// means the corresponding gate still shows on next login. Wrapped in
// try/catch — ALTER TABLE ADD COLUMN is safe to re-run but we guard anyway
// per the codebase's convention for schema-touching migrations.
try {
  const agentColsV1481 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
  if (!agentColsV1481.includes("profile_completed_at")) {
    rawDb.prepare("ALTER TABLE agents ADD COLUMN profile_completed_at TEXT").run();
  }
  if (!agentColsV1481.includes("tutorial_completed_at")) {
    rawDb.prepare("ALTER TABLE agents ADD COLUMN tutorial_completed_at TEXT").run();
  }
} catch (err) {
  console.error("[db] v14.81 onboarding column migration failed:", err);
}

// v14.81 — Backfill on startup. Existing agents who already have name+phone
// on file have effectively already "completed" the profile step manually —
// don't gate them retroactively. Alex + Nate (admins who built the tutorial)
// are marked tutorial-complete too so they aren't shown their own onboarding
// flow; every other existing agent still sees the tutorial once on next login
// (their tutorial_completed_at stays NULL here).
try {
  const nowIso = new Date().toISOString();
  rawDb.prepare(`
    UPDATE agents
       SET profile_completed_at = ?
     WHERE profile_completed_at IS NULL
       AND name IS NOT NULL
       AND phone IS NOT NULL
  `).run(nowIso);
  rawDb.prepare(`
    UPDATE agents
       SET tutorial_completed_at = ?
     WHERE email IN ('alex@watsonbrothersgroup.com', 'nate@watsonbrothersgroup.com')
       AND tutorial_completed_at IS NULL
  `).run(nowIso);
} catch (err) {
  console.error("[db] v14.81 onboarding backfill failed:", err);
}

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

// v14.81.3 — busy_timeout on rawDb. Paired with the same setting in storage.ts
// so the two connections (rawDb here, storage.ts's own sqlite handle) retry
// briefly on contention instead of failing immediately with "database is
// locked". Root cause of probe agent id=15 hard-delete failures.
rawDb.pragma("busy_timeout = 5000");

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

// v15.11.18 — agent_lead_holdouts: per-agent "do not show me this lead again until X"
// table. Populated by:
//   • Skip outcome (new v15.11.18) — 3/day, 1/hr rate limit, holdout until tomorrow midnight EDT
//   • Recycle outcome — holdout until tomorrow midnight EDT to prevent the
//     high-score bounce-back where a just-recycled lead gets served back to
//     the same agent by pullPool's score DESC ordering.
// my-next reads this table and excludes matching (agent_id, lead_id) rows.
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS agent_lead_holdouts (
    agent_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    until TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, lead_id)
  )
`);
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_holdouts_agent_until ON agent_lead_holdouts(agent_id, until)`).run();
// Sweep expired holdouts on boot.
rawDb.prepare(`DELETE FROM agent_lead_holdouts WHERE until < datetime('now')`).run();

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

// ─── v15.5 — Bucket 5 Half 2, Phase 1: Onboarding candidate ingress ────────
// New tables + agents columns to support the Stage-4 application flow:
//   1) Admin invites a candidate (name/phone/email + entry path) after a
//      real-world yes (F2F meet, phone yes, marketing-primed yes, referral).
//   2) Candidate row + FUB HOT PROSPECT / AGENT RECRUIT LEAD / VENDOR created
//      (stage depends on entry path — see server/fub.ts fubCreateCandidate).
//   3) Admin picks delivery mode: Show QR on phone, Text link (sms: deep
//      link), Email link, or Create only (Nurture default).
//   4) Candidate opens /join/:token, completes 28-question form (Phase 2),
//      Alex approves, agent row is created, onboarding_checklist rows fire.
//
// See references/ONBOARDING_SPEC.md for the full spec and 7-path entry grid.

// candidates: the row backing the whole flow. status transitions:
//   invited → started → submitted → approved → active  (happy path)
//              ↘ ghosted (48h no-open) ↘ expired (14d no-submit) ↘ declined
if (!rawDb.prepare("PRAGMA table_info(candidates)").all().length) {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- identity (3 fields captured at invite time)
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      -- entry path (locks in FUB stage + tags): dbpr_phone_kit | f2f_nurture |
      -- phone_tell_me_more | f2f_hot_prospect | marketing_phone_yes |
      -- f2f_sit_down_yes | referral_yes
      entry_path TEXT NOT NULL,
      -- temperature tier derived from entry_path (nurture | hot_prospect | vendor)
      temperature TEXT NOT NULL,
      -- FUB stage label applied on create (Agent Recruit Lead | Agent Prospect | Vendor)
      fub_stage TEXT NOT NULL,
      -- current lifecycle status
      status TEXT NOT NULL DEFAULT 'invited',
      -- one-time token for /join/:token public landing + questionnaire
      token TEXT UNIQUE,
      token_expires_at TEXT,
      -- delivery mode picked at invite: show_qr | text | email | create_only
      delivery_mode TEXT NOT NULL DEFAULT 'create_only',
      -- attribution
      invited_by_agent_id INTEGER,
      referred_by_agent_id INTEGER,
      -- FUB sync
      fub_person_id INTEGER,
      fub_synced_at TEXT,
      -- 28-question form (Phase 2) — stored as JSON blob when submitted
      questionnaire_json TEXT,
      questionnaire_submitted_at TEXT,
      -- Alex's approval
      approved_at TEXT,
      approved_by_agent_id INTEGER,
      -- If approved, the resulting agents.id (foreign key back once agent row created)
      resulting_agent_id INTEGER,
      -- decline path
      declined_at TEXT,
      declined_reason TEXT,
      -- lifecycle timestamps
      created_at TEXT NOT NULL DEFAULT '',
      first_opened_at TEXT,
      last_activity_at TEXT,
      -- nurture nudge scheduling (30/90/180d admin reminders)
      next_nurture_at TEXT
    )
  `);
  console.log("[db] v15.5 candidates table created");
}
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status)`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_candidates_token ON candidates(token) WHERE token IS NOT NULL`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email) WHERE email IS NOT NULL`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates(phone) WHERE phone IS NOT NULL`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_candidates_temp ON candidates(temperature)`).run();

// v15.7 — Phase 2 columns for questionnaire submission flow.
// Idempotent adds so existing prod DB gets them on next boot.
const candColsV156 = rawDb.prepare("PRAGMA table_info(candidates)").all().map((c: any) => c.name);
if (!candColsV156.includes("recommendation"))       rawDb.prepare("ALTER TABLE candidates ADD COLUMN recommendation TEXT").run();          // STRONG_FIT | WORTH_A_CALL | SOFT_PASS | HARD_PASS
if (!candColsV156.includes("recommendation_score")) rawDb.prepare("ALTER TABLE candidates ADD COLUMN recommendation_score INTEGER").run(); // 0..100
if (!candColsV156.includes("recommendation_reason")) rawDb.prepare("ALTER TABLE candidates ADD COLUMN recommendation_reason TEXT").run();  // one-line why
if (!candColsV156.includes("admin_notes"))          rawDb.prepare("ALTER TABLE candidates ADD COLUMN admin_notes TEXT").run();
if (!candColsV156.includes("questionnaire_draft_json"))       rawDb.prepare("ALTER TABLE candidates ADD COLUMN questionnaire_draft_json TEXT").run();       // partial answers, saved as they type
if (!candColsV156.includes("questionnaire_draft_updated_at")) rawDb.prepare("ALTER TABLE candidates ADD COLUMN questionnaire_draft_updated_at TEXT").run();

// onboarding_checklist: the 13-item post-approval task list (Phase 3).
// Rows are inserted when Alex approves a candidate and creates their agent row.
// The Nate brief email fires on approval and links here.
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS onboarding_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,          -- e.g. "team_agreement_signed", "headshot_uploaded", "personal_address"
    item_label TEXT NOT NULL,        -- human label shown in the checklist UI
    item_order INTEGER NOT NULL,     -- display order 1..13
    completed_at TEXT,               -- NULL until done
    completed_by_agent_id INTEGER,   -- who checked it off (Alex/Nate or the agent themselves)
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT ''
  )
`);
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_onboarding_agent ON onboarding_checklist(agent_id)`).run();
rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_onboarding_pending ON onboarding_checklist(agent_id) WHERE completed_at IS NULL`).run();

// agents: 9 new columns to hold the onboarding-derived fields.
// These come from the 28-question form + Alex's approve step + FUB post-approve push.
const agentColsV155 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV155.includes("bio"))              rawDb.prepare("ALTER TABLE agents ADD COLUMN bio TEXT").run();
if (!agentColsV155.includes("license_status"))   rawDb.prepare("ALTER TABLE agents ADD COLUMN license_status TEXT").run();  // "active" | "inactive" | "pending" | "pre_license"
if (!agentColsV155.includes("license_number"))   rawDb.prepare("ALTER TABLE agents ADD COLUMN license_number TEXT").run();
if (!agentColsV155.includes("license_state"))    rawDb.prepare("ALTER TABLE agents ADD COLUMN license_state TEXT").run();
if (!agentColsV155.includes("years_experience")) rawDb.prepare("ALTER TABLE agents ADD COLUMN years_experience TEXT").run();
if (!agentColsV155.includes("candidate_id"))     rawDb.prepare("ALTER TABLE agents ADD COLUMN candidate_id INTEGER").run();
if (!agentColsV155.includes("onboarding_started_at")) rawDb.prepare("ALTER TABLE agents ADD COLUMN onboarding_started_at TEXT").run();
if (!agentColsV155.includes("onboarding_completed_at")) rawDb.prepare("ALTER TABLE agents ADD COLUMN onboarding_completed_at TEXT").run();
if (!agentColsV155.includes("tcpa_consent_at")) rawDb.prepare("ALTER TABLE agents ADD COLUMN tcpa_consent_at TEXT").run();

// v15.8 — optional distinct published phone for cold email templates. Falls
// back to `phone` when null. Alex needed this because his personal cell in
// `phone` shouldn't be exposed in cold outreach to strangers.
const agentColsV158 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV158.includes("published_phone")) rawDb.prepare("ALTER TABLE agents ADD COLUMN published_phone TEXT").run();

// v15.11.10 — 15-min-before On Air push opt-in
const agentColsV15110 = rawDb.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
if (!agentColsV15110.includes("push_notif_on_air")) rawDb.prepare("ALTER TABLE agents ADD COLUMN push_notif_on_air INTEGER NOT NULL DEFAULT 0").run();

console.log("[db] WAL mode active, foreign keys ON, indexes verified");
console.log("[db] v13.8 pool-serving schema ready (lead_locks table + new lead columns)");
console.log("[db] v15.5 onboarding candidate schema ready (candidates + onboarding_checklist + 9 agents cols)");
