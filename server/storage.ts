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

// Migrations — add new columns to existing tables (safe to run repeatedly)
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN receive_leads INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN lead_flow_on INTEGER NOT NULL DEFAULT 1`); } catch {}
try { sqlite.exec(`ALTER TABLE agents ADD COLUMN receive_website_leads INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN phones TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE leads ADD COLUMN phone_states TEXT`); } catch {}

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
  getNextAgentInRotation(): Agent | undefined;
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

const ACTIVE_STATUSES = ["assigned", "no_answer", "keep_in_touch", "callback_requested"];
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
    return db.select().from(leads)
      .where(and(
        eq(leads.assignedAgentId, agentId),
        inArray(leads.status, ["assigned", "no_answer", "keep_in_touch"])
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
    return db.select().from(leads)
      .where(and(eq(leads.assignedAgentId, agentId), inArray(leads.status, ACTIVE_STATUSES)))
      .all().length;
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

  getNextAgentInRotation(leadType?: string): Agent | undefined {
    // Include: regular active agents with leadFlowOn=true, OR admins who opted in via receiveLeads=true
    const activeAgents = db.select().from(agents)
      .where(and(eq(agents.isActive, true), eq(agents.leadFlowOn, true)))
      .orderBy(asc(agents.roundRobinOrder))
      .all()
      .filter(a => {
        // Must be an active agent or admin opted-in
        if (a.role === "admin" && !a.receiveLeads) return false;
        // Website leads: only agents with receiveWebsiteLeads flag
        if (leadType === "website_lead" && !a.receiveWebsiteLeads) return false;
        return true;
      });

    if (activeAgents.length === 0) return undefined;

    const rrState = db.select().from(roundRobinState).get();
    if (!rrState || !rrState.lastAssignedAgentId) {
      return activeAgents[0];
    }

    const lastIdx = activeAgents.findIndex(a => a.id === rrState.lastAssignedAgentId);
    const nextIdx = (lastIdx + 1) % activeAgents.length;
    return activeAgents[nextIdx];
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
    const all = db.select().from(leads).all();
    return {
      totalLeads: all.length,
      assignedLeads: all.filter(l => l.assignedAgentId !== null).length,
      unassignedLeads: all.filter(l => l.status === "unassigned").length,
      appointmentsSet: all.filter(l => l.status === "contacted_appointment").length,
      activeLeads: all.filter(l => ACTIVE_STATUSES.includes(l.status)).length,
      deadLeads: all.filter(l => DEAD_STATUSES.includes(l.status)).length,
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
  { name: "Luis Marquez",     email: "luis.sellsjax@gmail.com" },
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
