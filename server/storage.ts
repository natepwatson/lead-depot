import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, or, isNull, asc, desc, inArray, ne } from "drizzle-orm";
import {
  agents, leads, leadActivity, roundRobinState,
  type Agent, type InsertAgent,
  type Lead, type InsertLead,
  type LeadActivity, type InsertLeadActivity,
} from "@shared/schema";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = process.env.NODE_ENV === "production" ? "/app/data" : ".";
const DB_PATH = join(DB_DIR, "data.db");
try { mkdirSync(DB_DIR, { recursive: true }); } catch {}
const sqlite = new Database(DB_PATH);
const db = drizzle(sqlite);

// Initialize tables
sqlite.exec(`
  PRAGMA journal_mode=WAL;
`);

// ─── MIGRATION RULE ─────────────────────────────────────────────────────────
// ANY new column added to schema.ts or the CREATE TABLE below MUST also have
// an ALTER TABLE migration here AND in server/db.ts before it can be queried.
// Skipping this = SqliteError: no such column on the live Railway DB (crash).
// ─────────────────────────────────────────────────────────────────────────────
// Migrations — add new columns to existing tables (safe to run repeatedly)
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN receive_leads INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN lead_flow_on INTEGER NOT NULL DEFAULT 1`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN receive_website_leads INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN phones TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN phone_states TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN territory TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN source TEXT DEFAULT 'csv_upload'`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN city TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN state TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN zip TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN territory TEXT`); } catch {}
// Profile columns (v11.37) — must run before Drizzle prepares any query against agents
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN phone TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN brokerage TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN home_address TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN headshot_url TEXT`); } catch {}
// Onboarding token columns (v11.37)
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN setup_token TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN setup_expires TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN onboarded INTEGER DEFAULT 0`); } catch {}
// leads — core columns that may be missing on older DBs
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN owner_name TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN email TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN motivation TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN extra_data TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN assigned_agent_id INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN callback_date TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN uploaded_at TEXT NOT NULL DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN uploaded_by INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN batch_id TEXT`); } catch {}
// LPMAMAB columns on leads (v11.38)
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_location TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_price_paid TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_motivation TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_agent_history TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_mortgage TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_appointment TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN l_buy TEXT`); } catch {}
// v14.20 — Buyer LPMAMA (only used when also_buying=1)
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN also_buying INTEGER DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN b_location TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN b_price TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN b_motivation TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN b_agent TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN b_mortgage TEXT`); } catch {}
// lead_activity — lpmamab_snapshot column (v11.38)
try { sqlite.exec(`ALTER TABLE lead_activity ADD COLUMN lpmamab_snapshot TEXT`); } catch {}

// v11.80 — Recruiting module: canRecruit flag, new statuses, reactivate_at
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN can_recruit INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN reactivate_at TEXT`); } catch {}

// v11.82 — Performance gate: minDialsPerWeek column
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN min_dials_per_week INTEGER NOT NULL DEFAULT 0`); } catch {}
// v12.5 — Two-territory support + territory-closed notice + points scoping
// These MUST run here (not just in db.ts) because storage.ts's Drizzle bootstrap
// selects agents at module-eval time — any missing column crashes boot on Railway.
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN territory1 TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN territory2 TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN territory_closed_notice INTEGER NOT NULL DEFAULT 0`); } catch {}
// v13.9 — home_county for home-county-first lead serving
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN home_county TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_points ADD COLUMN scope TEXT NOT NULL DEFAULT 'seller'`); } catch {}
// DBPR fields (v11.71, renamed from FREC in v13.4 — in case table was created before these existed)
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN dbpr_license_id TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN license_issue_date TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN license_expire_date TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN last_scraped_at INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE agent_leads ADD COLUMN dedup_hash TEXT`); } catch {}

// ─── Agent Prospecting tables (v11.46) ──────────────────────────────────────
try { sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT, phone TEXT,
  license_status TEXT NOT NULL DEFAULT 'active',
  license_number TEXT, license_state TEXT, years_experience TEXT,
  current_brokerage TEXT, reason_for_leaving TEXT,
  gci_range TEXT, transactions_last_12mo INTEGER,
  territory TEXT, matched_territory TEXT,
  referral_source TEXT, referred_by_name TEXT, applicant_notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_admin_id INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
  callback_date TEXT,
  r_license TEXT, r_production TEXT, r_motivation TEXT,
  r_timeline TEXT, r_objections TEXT, r_territory TEXT, r_appointment TEXT,
  fub_person_id INTEGER, fub_synced_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'recruiting_page',
  uploaded_at TEXT, uploaded_by INTEGER, batch_id TEXT
)`); } catch {}

try { sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_lead_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_lead_id INTEGER NOT NULL,
  caller_id INTEGER, outcome TEXT NOT NULL,
  notes TEXT, latte_snapshot TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
)`); } catch {}

try { sqlite.exec(`CREATE TABLE IF NOT EXISTS territories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_open INTEGER NOT NULL DEFAULT 1
)`); } catch {}

try { sqlite.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL
)`); } catch {}
// v11.39 — agent_points table (gamification)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS agent_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    lead_id INTEGER,
    created_at TEXT NOT NULL DEFAULT ''
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    round_robin_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    receive_leads INTEGER NOT NULL DEFAULT 0,
    lead_flow_on INTEGER NOT NULL DEFAULT 1,
    receive_website_leads INTEGER NOT NULL DEFAULT 0
  );
  -- phones: JSON array of phone number strings e.g. ["9041234567","9047654321"]
  -- phoneStates: JSON object keyed by phone number e.g. {"9041234567":"untried","9047654321":"struck"}
  --   values: "untried" | "no_answer_today" | "struck"
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_type TEXT NOT NULL,
    address TEXT NOT NULL,
    owner_name TEXT,
    phone TEXT,
    email TEXT,
    motivation TEXT,
    extra_data TEXT,
    status TEXT NOT NULL DEFAULT 'unassigned',
    assigned_agent_id INTEGER REFERENCES agents(id),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    callback_date TEXT,
    l_location TEXT,
    l_price_paid TEXT,
    l_motivation TEXT,
    l_agent_history TEXT,
    l_mortgage TEXT,
    l_appointment TEXT,
    l_buy TEXT,
    also_buying INTEGER DEFAULT 0,
    b_location TEXT,
    b_price TEXT,
    b_motivation TEXT,
    b_agent TEXT,
    b_mortgage TEXT,
    uploaded_at TEXT NOT NULL DEFAULT '',
    uploaded_by INTEGER REFERENCES agents(id),
    batch_id TEXT,
    phones TEXT,
    phone_states TEXT
  );
  CREATE TABLE IF NOT EXISTS lead_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    agent_id INTEGER REFERENCES agents(id),
    outcome TEXT NOT NULL,
    notes TEXT,
    lpmamab_snapshot TEXT,
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_type TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS geo_cache (
    address_key TEXT PRIMARY KEY,
    lat         REAL,
    lng         REAL,
    cached_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS round_robin_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_assigned_agent_id INTEGER REFERENCES agents(id),
    updated_at TEXT NOT NULL DEFAULT ''
  );
`);

export interface IStorage {
  // Auth
  getAgentByEmail(email: string): Agent | undefined;
  getAgentById(id: number): Agent | undefined;
  getAllAgents(): Agent[];
  createAgent(data: InsertAgent): Agent;
  updateAgent(id: number, data: Partial<InsertAgent>): Agent | undefined;
  deleteAgent(id: number): void;

  // Leads
  createLead(data: InsertLead): Lead;
  createLeadsFromBatch(leads: InsertLead[]): Lead[];
  getLeadById(id: number): Lead | undefined;
  getAllLeads(): Lead[];
  getLeadsByStatus(status: string): Lead[];
  getLeadsForAgent(agentId: number): Lead[];
  getNextLeadForAgent(agentId: number): Lead | undefined;
  updateLead(id: number, data: Partial<InsertLead>): Lead | undefined;
  deleteLead(id: number): void;
  getActiveLeadCountForAgent(agentId: number): number;

  // Lead Activity
  createLeadActivity(data: InsertLeadActivity): LeadActivity;
  getActivitiesForLead(leadId: number): LeadActivity[];

  // Round Robin
  getNextAgentInRotation(leadType?: string, leadTerritory?: string | null): Agent | undefined;
  updateRoundRobinState(agentId: number): void;

  // Stats
  getAdminStats(): {
    totalLeads: number;
    assignedLeads: number;
    unassignedLeads: number;
    appointmentsSet: number;
    activeLeads: number;
    deadLeads: number;
  };
}

const ACTIVE_STATUSES = ["assigned", "no_answer", "callback_requested"]; // keep_in_touch exits to FUB
const DEAD_STATUSES = ["contacted_not_interested", "wrong_number", "retired", "contacted_appointment"];

export class Storage implements IStorage {
  getAgentByEmail(email: string): Agent | undefined {
    return db.select().from(agents).where(eq(agents.email, email)).get();
  }

  getAgentById(id: number): Agent | undefined {
    return db.select().from(agents).where(eq(agents.id, id)).get();
  }

  getAllAgents(): Agent[] {
    return db.select().from(agents).orderBy(asc(agents.roundRobinOrder)).all();
  }

  createAgent(data: InsertAgent): Agent {
    const existing = db.select().from(agents).all();
    const order = existing.length;
    return db.insert(agents).values({ ...data, roundRobinOrder: order }).returning().get();
  }

  updateAgent(id: number, data: Partial<InsertAgent>): Agent | undefined {
    return db.update(agents).set(data).where(eq(agents.id, id)).returning().get();
  }

  deleteAgent(id: number): void {
    db.delete(agents).where(eq(agents.id, id)).run();
  }

  createLead(data: InsertLead): Lead {
    const now = new Date().toISOString();
    return db.insert(leads).values({ ...data, uploadedAt: now }).returning().get();
  }

  createLeadsFromBatch(batch: InsertLead[]): Lead[] {
    const now = new Date().toISOString();
    const results: Lead[] = [];
    for (const lead of batch) {
      const result = db.insert(leads).values({ ...lead, uploadedAt: now }).returning().get();
      results.push(result);
    }
    return results;
  }

  getLeadById(id: number): Lead | undefined {
    return db.select().from(leads).where(eq(leads.id, id)).get();
  }

  getAllLeads(): Lead[] {
    return db.select().from(leads).orderBy(desc(leads.uploadedAt)).all();
  }

  // Paginated + filtered lead query — use this for all admin list views at scale
  getLeadsPaginated(opts: {
    status?: string;
    agentId?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): { rows: Lead[]; total: number } {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    // Build conditions with raw SQL for flexibility
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.status && opts.status !== "all") {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts.agentId) {
      conditions.push("assigned_agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.search) {
      const s = `%${opts.search.toLowerCase()}%`;
      conditions.push("(LOWER(address) LIKE ? OR LOWER(owner_name) LIKE ? OR phone LIKE ?)");
      params.push(s, s, s);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRow = sqlite.prepare(`SELECT COUNT(*) as n FROM leads ${where}`).get(...params) as any;
    const rows = sqlite.prepare(`SELECT * FROM leads ${where} ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

    // Map snake_case DB columns to camelCase Lead shape
    const mapped: Lead[] = rows.map((r: any) => ({
      id: r.id,
      ownerName: r.owner_name,
      address: r.address,
      phone: r.phone,
      phones: r.phones,
      phoneStates: r.phone_states,
      email: r.email,
      leadType: r.lead_type,
      status: r.status,
      motivation: r.motivation,
      extraData: r.extra_data,
      assignedAgentId: r.assigned_agent_id,
      attemptCount: r.attempt_count,
      callbackDate: r.callback_date,
      uploadedAt: r.uploaded_at,
      uploadedBy: r.uploaded_by,
      batchId: r.batch_id,
      score: r.score ?? 0,
      territory: r.territory ?? null,
      source: r.source ?? "csv_upload",
      city: r.city ?? null,
      state: r.state ?? null,
      zip: r.zip ?? null,
      lLocation: r.l_location,
      lPricePaid: r.l_price_paid,
      lMotivation: r.l_motivation,
      lAgentHistory: r.l_agent_history,
      lMortgage: r.l_mortgage,
      lAppointment: r.l_appointment,
      lBuy: r.l_buy,
      alsoBuying: r.also_buying,
      bLocation: r.b_location,
      bPrice: r.b_price,
      bMotivation: r.b_motivation,
      bAgent: r.b_agent,
      bMortgage: r.b_mortgage,
    }));

    return { rows: mapped, total: countRow?.n ?? 0 };
  }

  getLeadsByStatus(status: string): Lead[] {
    return db.select().from(leads).where(eq(leads.status, status)).all();
  }

  getLeadsForAgent(agentId: number): Lead[] {
    return db.select().from(leads)
      .where(and(eq(leads.assignedAgentId, agentId), inArray(leads.status, ACTIVE_STATUSES)))
      .orderBy(asc(leads.attemptCount), asc(leads.uploadedAt))
      .all();
  }

  getNextLeadForAgent(agentId: number): Lead | undefined {
    // Prioritize leads with callback dates that have passed
    const now = new Date().toISOString().split("T")[0];
    const callbackReady = db.select().from(leads)
      .where(and(
        eq(leads.assignedAgentId, agentId),
        eq(leads.status, "callback_requested"),
      ))
      .orderBy(asc(leads.callbackDate))
      .all()
      .find(l => !l.callbackDate || l.callbackDate <= now);

    if (callbackReady) return callbackReady;

    // Otherwise return the next active assigned lead
    // Note: keep_in_touch leads are excluded — they exit to FUB, not back into the dial queue
    return db.select().from(leads)
      .where(and(
        eq(leads.assignedAgentId, agentId),
        inArray(leads.status, ["assigned", "no_answer"])
      ))
      .orderBy(asc(leads.attemptCount), asc(leads.uploadedAt))
      .get();
  }

  updateLead(id: number, data: Partial<InsertLead>): Lead | undefined {
    return db.update(leads).set(data).where(eq(leads.id, id)).returning().get();
  }

  deleteLead(id: number): void {
    db.delete(leads).where(eq(leads.id, id)).run();
  }

  getActiveLeadCountForAgent(agentId: number): number {
    // Use raw SQL COUNT — avoids loading all rows into memory at scale
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const row = sqlite.prepare(
      `SELECT COUNT(*) as cnt FROM leads WHERE assigned_agent_id = ? AND status IN (${placeholders})`
    ).get(agentId, ...ACTIVE_STATUSES) as any;
    return row?.cnt || 0;
  }

  createLeadActivity(data: InsertLeadActivity): LeadActivity {
    const now = new Date().toISOString();
    return db.insert(leadActivity).values({ ...data, createdAt: now }).returning().get();
  }

  getActivitiesForLead(leadId: number): LeadActivity[] {
    return db.select().from(leadActivity)
      .where(eq(leadActivity.leadId, leadId))
      .orderBy(desc(leadActivity.createdAt))
      .all();
  }

  getNextAgentInRotation(leadType?: string, leadTerritory?: string | null): Agent | undefined {
    // Include: regular active agents with leadFlowOn=true, OR admins who opted in via receiveLeads=true
    const allActive = db.select().from(agents)
      .where(and(eq(agents.isActive, true), eq(agents.leadFlowOn, true)))
      .orderBy(asc(agents.roundRobinOrder))
      .all()
      .filter(a => {
        if (a.role === "admin" && !a.receiveLeads) return false;
        // Performance gate: skip agents below their weekly dial threshold
        const minDials = (a as any).minDialsPerWeek ?? 0;
        if (minDials > 0) {
          const weekStart = new Date();
          weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
          weekStart.setHours(0, 0, 0, 0);
          const dialCount = (sqlite.prepare(
            `SELECT COUNT(*) as cnt FROM agent_points WHERE agent_id = ? AND reason = 'dial' AND created_at >= ?`
          ).get(a.id, weekStart.toISOString()) as any)?.cnt ?? 0;
          if (dialCount < minDials) return false;
        }
        return true;
      });

    // If ALL agents are gated, fall back to ungated pool to avoid deadlock
    if (allActive.length === 0) {
      const ungated = db.select().from(agents)
        .where(and(eq(agents.isActive, true), eq(agents.leadFlowOn, true)))
        .orderBy(asc(agents.roundRobinOrder))
        .all()
        .filter(a => {
          if (a.role === "admin" && !a.receiveLeads) return false;
          return true;
        });
      if (ungated.length === 0) return undefined;
      const rrFallback = db.select().from(roundRobinState).get();
      const lastIdxF = ungated.findIndex(a => a.id === rrFallback?.lastAssignedAgentId);
      return ungated[(lastIdxF + 1) % ungated.length];
    }

    // ── Territory-aware filtering ──────────────────────────────────────────────
    // If lead has a territory AND at least one agent covers that territory,
    // restrict the pool to territory-matching agents only.
    // If no territory match exists (or lead has no territory), use all active agents.
    let pool = allActive;
    if (leadTerritory) {
      // v12.5 — agents can hold up to TWO territories (territory1 + territory2).
      // Match if EITHER slot matches the lead's territory. Legacy `territory` column
      // stays supported as a fallback until fully backfilled/deprecated.
      const territoryAgents = allActive.filter(a => {
        const t1 = (a as any).territory1 || null;
        const t2 = (a as any).territory2 || null;
        const legacy = (a as any).territory || null;
        const covers = !t1 && !t2 && !legacy; // no territory set → covers everything
        return covers || t1 === leadTerritory || t2 === leadTerritory || legacy === leadTerritory;
      });
      // Only restrict to territory agents if at least one exists
      if (territoryAgents.length > 0) pool = territoryAgents;
    }

    const rrState = db.select().from(roundRobinState).get();
    if (!rrState || !rrState.lastAssignedAgentId) {
      return pool[0];
    }

    // Find last assigned in pool; if not found (they cover a different territory), start from top
    const lastIdx = pool.findIndex(a => a.id === rrState.lastAssignedAgentId);
    const nextIdx = (lastIdx + 1) % pool.length;
    return pool[nextIdx];
  }

  updateRoundRobinState(agentId: number): void {
    const now = new Date().toISOString();
    const existing = db.select().from(roundRobinState).get();
    if (existing) {
      db.update(roundRobinState)
        .set({ lastAssignedAgentId: agentId, updatedAt: now })
        .where(eq(roundRobinState.id, existing.id))
        .run();
    } else {
      db.insert(roundRobinState).values({ lastAssignedAgentId: agentId, updatedAt: now }).run();
    }
  }

  getAdminStats() {
    // Use SQL aggregation — much faster with 1000s of leads than loading all rows
    const row: any = sqlite.prepare(`
      SELECT
        COUNT(*)                                                                          AS totalLeads,
        SUM(CASE WHEN assigned_agent_id IS NOT NULL THEN 1 ELSE 0 END)                   AS assignedLeads,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END)                           AS unassignedLeads,
        SUM(CASE WHEN status = 'contacted_appointment' THEN 1 ELSE 0 END)                AS appointmentsSet,
        SUM(CASE WHEN status IN ('assigned','no_answer','callback_requested') THEN 1 ELSE 0 END) AS activeLeads,
        SUM(CASE WHEN status IN ('contacted_not_interested','wrong_number','retired','contacted_appointment') THEN 1 ELSE 0 END) AS deadLeads
      FROM leads
    `).get();
    return {
      totalLeads:      row?.totalLeads ?? 0,
      assignedLeads:   row?.assignedLeads ?? 0,
      unassignedLeads: row?.unassignedLeads ?? 0,
      appointmentsSet: row?.appointmentsSet ?? 0,
      activeLeads:     row?.activeLeads ?? 0,
      deadLeads:       row?.deadLeads ?? 0,
    };
  }

  // Clear active queue — retire all active leads back to 'retired' status.
  // Activity history and master record are fully preserved.
  clearQueue(retiredBy?: number): number {
    const activeLeads = db.select().from(leads)
      .where(inArray(leads.status, ACTIVE_STATUSES))
      .all();
    const now = new Date().toISOString();
    for (const lead of activeLeads) {
      db.update(leads).set({ status: "retired" }).where(eq(leads.id, lead.id)).run();
      db.insert(leadActivity).values({
        leadId: lead.id,
        agentId: retiredBy || null,
        outcome: "retired",
        notes: "Cleared from queue by admin — master record preserved.",
        lpmamabSnapshot: null,
        createdAt: now,
      }).run();
    }
    return activeLeads.length;
  }
}

export const storage = new Storage();

// Seed admin account if none exists
const adminExists = db.select().from(agents).where(eq(agents.role, "admin")).get();
if (!adminExists) {
  db.insert(agents).values({
    name: "Alex Watson",
    email: "alex@watsonbrothersgroup.com",
    password: "brothers2026",
    role: "admin",
    roundRobinOrder: -1,
    isActive: true,
  }).run();
}

// Seed Nate Watson admin if not present
const nateExists = db.select().from(agents).where(eq(agents.email, "nate@watsonbrothersgroup.com")).get();
if (!nateExists) {
  db.insert(agents).values({
    name: "Nate Watson",
    email: "nate@watsonbrothersgroup.com",
    password: "brothers2026",
    role: "admin",
    roundRobinOrder: -1,
    isActive: true,
  }).run();
}

// Seed real team agents if not present
const realAgents = [
  { name: "Bronson Sarmento", email: "brbzsa@gmail.com" },
  { name: "Cory Deroin",      email: "corylderoin@gmail.com" },
  // v14.29.1 — Luis Marquez removed as default entry agent per Alex.
  { name: "Noah Tomlinson",   email: "noahtomlinson.re@gmail.com" },
  { name: "Gabriel Duran",    email: "gabrielduran.realtor@gmail.com" },
  { name: "Vonda Jewell",     email: "diamondjewell0712@gmail.com" },
  { name: "Usman Jan",        email: "usmanjan33@gmail.com" },
  { name: "Denise Jacobs",    email: "djacobs312@gmail.com" },
];
realAgents.forEach((a, idx) => {
  const exists = db.select().from(agents).where(eq(agents.email, a.email)).get();
  if (!exists) {
    db.insert(agents).values({
      name: a.name,
      email: a.email,
      password: "brothers2026",
      role: "agent",
      roundRobinOrder: idx,
      isActive: true,
    }).run();
  }
});
