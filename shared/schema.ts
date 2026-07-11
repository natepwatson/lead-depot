import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Agents table
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("agent"), // "admin" | "agent"
  roundRobinOrder: integer("round_robin_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  receiveLeads: integer("receive_leads", { mode: "boolean" }).notNull().default(false),
  leadFlowOn: integer("lead_flow_on", { mode: "boolean" }).notNull().default(true),
  receiveWebsiteLeads: integer("receive_website_leads", { mode: "boolean" }).notNull().default(false),
  canRecruit: integer("can_recruit", { mode: "boolean" }).notNull().default(false),
  // Performance gate — agent is muted from round-robin until they hit this weekly dial count (0 = disabled)
  minDialsPerWeek: integer("min_dials_per_week").notNull().default(0),
  // Agent profile fields
  phone: text("phone"),
  brokerage: text("brokerage"),
  homeAddress: text("home_address"),
  headshotUrl: text("headshot_url"),
  // Territory assignment — agent receives leads from up to 2 territories (v12.5)
  // Each is one of the official territory keys, or null.
  territory1: text("territory1"),
  territory2: text("territory2"),
  // Kept for one release as a rollback safety net — no longer read/written by app (v12.5)
  territory: text("territory"),
  // Set true when one of the agent's territories was closed by admin; agent
  // sees a banner on next login prompting them to reselect (v12.5)
  territoryClosedNotice: integer("territory_closed_notice", { mode: "boolean" }).notNull().default(false),
  // v13.9 — Home county. Agent receives leads from this county first; overflows
  // to other counties ONLY when their home county is completely dry.
  // NULL = admin / no restriction (killer mode — sees everything, cross-county).
  homeCounty: text("home_county"),
  // v14.59 (Bucket 5 Phase B — Email hygiene) — tombstone + pending-email columns.
  //
  // mergedIntoAgentId: when a row is a merge tombstone, this points at the surviving
  // canonical agent row. Combined with email = 'tombstone:<sourceId>:<orig>' this
  // makes tombstones both login-locked (no real email will ever match) AND
  // programmatically discoverable (WHERE merged_into_agent_id IS NOT NULL).
  mergedIntoAgentId: integer("merged_into_agent_id"),
  // pending_email flow: when a non-admin agent requests an email change, we don't
  // rewrite `email` immediately. We stash the new address in pending_email, mint a
  // token, hash it to pending_email_token, send a verification link to the NEW
  // address, and only apply the change when they click through before
  // pending_email_expires. Admin-initiated changes bypass this and apply instantly.
  pendingEmail: text("pending_email"),
  pendingEmailToken: text("pending_email_token"),
  pendingEmailExpires: text("pending_email_expires"),
  // v14.61 (Bucket 5 Phase C — Deactivate + audit). Unix ms timestamp of the
  // most recent deactivation, or NULL if the agent is active / has never been
  // deactivated. The reactivate endpoint uses this to gate the 7-day undo
  // window. Legacy rows deactivated before v14.61 have NULL here — they can be
  // reactivated unconditionally (grandfathered).
  deactivatedAt: integer("deactivated_at"),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Leads table
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Lead type
  leadType: text("lead_type").notNull(), // v14.31: "expired" | "absentee" | "network"
  // Core fields
  address: text("address").notNull(),
  ownerName: text("owner_name"),
  phone: text("phone"),
  email: text("email"),
  // Motivation / extra fields stored as JSON text
  motivation: text("motivation"),
  extraData: text("extra_data"), // JSON string of any extra CSV columns
  // Status & assignment
  status: text("status").notNull().default("unassigned"),
  // unassigned | assigned | contacted_appointment | contacted_not_interested |
  // no_answer | left_voicemail | callback_requested | wrong_number | retired
  assignedAgentId: integer("assigned_agent_id").references(() => agents.id),
  attemptCount: integer("attempt_count").notNull().default(0),
  callbackDate: text("callback_date"), // ISO date string
  // LPMAMAB fields (populated by agent during call)
  lLocation: text("l_location"),       // L - Location (where do they want to go?)
  lPricePaid: text("l_price_paid"),     // P - Price (what did they pay / what do they want?)
  lMotivation: text("l_motivation"),    // M - Motivation (why are they selling?)
  lAgentHistory: text("l_agent_history"), // A - Agent (have they worked with an agent?)
  lMortgage: text("l_mortgage"),        // M - Mortgage (what do they owe?)
  lAppointment: text("l_appointment"),  // A - Appointment (are they available to meet?)
  lBuy: text("l_buy"),                  // B - Buyer (do they want to buy after selling?) [v14.20 — replaced in UI by alsoBuying toggle, kept for backfill]
  // v14.20 — Buyer LPMAMA (only populated when alsoBuying=true / intent !== sell_only)
  alsoBuying: integer("also_buying").default(0),   // 0 = no, 1 = yes
  // v14.53 — 3-way intent: 'sell_only' | 'sell_and_buy' | 'buy_only'
  intent: text("intent"),
  bLocation: text("b_location"),        // B-L Location — where do they want to buy?
  bPrice: text("b_price"),              // B-P Price — budget
  bMotivation: text("b_motivation"),    // B-M Motivation — why buying?
  bAgent: text("b_agent"),              // B-A Agent — working with anyone?
  bMortgage: text("b_mortgage"),        // B-M Mortgage — pre-approved / cash?
  // Geographic fields (city/state/zip — from BatchLeads, CSV, or geocoding)
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  // Lead gen metadata
  score: integer("score").default(0),          // BatchLeads pipeline score (0–20+)
  territory: text("territory"),                 // LEGACY — kept for historical data. v13.8 no longer reads/writes.
  source: text("source").default("csv_upload"), // "batchleads" | "csv_upload" | "manual" | "website" | "network"
  // v13.8 — filter/display data for the 3 playbooks
  lotSizeAcres: real("lot_size_acres"),         // Land 1AC+ filter
  assessedValue: integer("assessed_value"),     // Land $75K+ filter
  listPrice: integer("list_price"),             // Expired/FSBO $500K+ filter
  yearPurchased: integer("year_purchased"),     // Land 5yr+ ownership filter
  lastSalePrice: integer("last_sale_price"),    // v14.22 — from BatchLeads Last Sale Price, for equity calc
  county: text("county"),                       // Raw location — map view + county filter
  lat: real("lat"),                             // Map view pin
  lng: real("lng"),                             // Map view pin
  // Upload metadata
  uploadedAt: text("uploaded_at").notNull().default(""),
  uploadedBy: integer("uploaded_by").references(() => agents.id),
  batchId: text("batch_id"), // groups leads from same CSV upload
  // Multi-number dialing
  phones: text("phones"),       // JSON array: ["9041234567", "9047654321", ...]
  phoneStates: text("phone_states"), // JSON object: {"9041234567": "untried" | "no_answer_today" | "struck"}
  // v14.39 — Recycle cooldown. Unix ms timestamp. NULL = eligible. Set to now+14d when any agent taps Recycle.
  // Applies uniformly to Expired + Absentee. my-next filters out leads where recycle_cooldown_until > now.
  recycleCooldownUntil: integer("recycle_cooldown_until"),
  // v14.40 — Per-line no-answer counter. JSON object: {"9041234567": 3}. NULL = grandfathered (all 0).
  // No Answer + Left Voicemail increment. At >=6 the line is struck. All lines struck → lead auto-deletes.
  // Wrong # + Disconnected don't touch this counter (they strike immediately, independent of no-answer count).
  phoneAttempts: text("phone_attempts"),
});

export const insertLeadSchema = createInsertSchema(leads).omit({ id: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

// Lead activity log (every interaction with a lead)
export const leadActivity = sqliteTable("lead_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").notNull().references(() => leads.id),
  agentId: integer("agent_id").references(() => agents.id),
  outcome: text("outcome").notNull(),
  notes: text("notes"),
  // Snapshot of LPMAMAB at time of activity
  lpmamabSnapshot: text("lpmamab_snapshot"), // JSON
  createdAt: text("created_at").notNull().default(""),
});

export const insertLeadActivitySchema = createInsertSchema(leadActivity).omit({ id: true });
export type InsertLeadActivity = z.infer<typeof insertLeadActivitySchema>;
export type LeadActivity = typeof leadActivity.$inferSelect;

// Round-robin state tracker
export const roundRobinState = sqliteTable("round_robin_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lastAssignedAgentId: integer("last_assigned_agent_id").references(() => agents.id),
  updatedAt: text("updated_at").notNull().default(""),
});

export type RoundRobinState = typeof roundRobinState.$inferSelect;

// Agent points table — cumulative gamification scoring
// scope isolates the two depots: seller-side activity earns seller points,
// recruiting-side activity earns recruiting points. Leaderboards + hard resets
// filter by scope so the two systems never bleed into each other (v12.5).
export const agentPoints = sqliteTable("agent_points", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull().references(() => agents.id),
  points: integer("points").notNull().default(0),
  reason: text("reason").notNull(), // "appointment" | "kit" | "dial" | "wrong_number" | "referral"
  leadId: integer("lead_id"),       // optional reference
  scope: text("scope").notNull().default("seller"), // "seller" | "recruiting"
  createdAt: text("created_at").notNull().default(""),
});
export type AgentPoints = typeof agentPoints.$inferSelect;

// ─── AGENT PROSPECTING TABLES ─────────────────────────────────────────────────

// Agent leads — outside agents being recruited (NOT app users)
export const agentLeads = sqliteTable("agent_leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Identity
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  // License & experience
  licenseStatus: text("license_status").notNull().default("active"), // "active" | "inactive" | "pending"
  licenseNumber: text("license_number"),
  licenseState: text("license_state"),
  yearsExperience: text("years_experience"), // "<1" | "1-2" | "3-5" | "6-10" | "10+"
  // Current situation
  currentBrokerage: text("current_brokerage"),
  reasonForLeaving: text("reason_for_leaving"),
  // Production
  gciRange: text("gci_range"), // "$0-25k" | "$25k-75k" | "$75k-150k" | "$150k-300k" | "$300k+" | "new_agent"
  transactionsLast12mo: integer("transactions_last_12mo"),
  // Territory
  territory: text("territory"),
  matchedTerritory: text("matched_territory"),
  // Attribution
  referralSource: text("referral_source"), // "referral" | "social" | "google" | "job_board" | "event" | "other"
  referredByName: text("referred_by_name"),
  // Notes from intake form
  applicantNotes: text("applicant_notes"),
  // Pipeline status & assignment
  // new | contacted | hot_prospect | appointment | callback_requested
  // not_now | just_signed | joined | not_interested | do_not_contact
  status: text("status").notNull().default("new"),
  assignedAdminId: integer("assigned_admin_id").references(() => agents.id),
  attemptCount: integer("attempt_count").notNull().default(0),
  callbackDate: text("callback_date"),
  reactivateAt: text("reactivate_at"),           // ISO date — when not_now/just_signed agent re-enters queue
  // L.A.T.T.E. fields (populated during call)
  rLicense: text("r_license"),
  rProduction: text("r_production"),
  rMotivation: text("r_motivation"),
  rTimeline: text("r_timeline"),
  rObjections: text("r_objections"),
  rTerritory: text("r_territory"),
  rAppointment: text("r_appointment"),
  // FUB sync
  fubPersonId: integer("fub_person_id"),
  fubSyncedAt: text("fub_synced_at"),
  // DBPR scraper fields (v11.71, renamed from FREC in v13.4)
  dbprLicenseId: text("dbpr_license_id"),           // DBPR's unique license ID (e.g. "SL3456789")
  licenseIssueDate: text("license_issue_date"),     // ISO date — tenure signal
  licenseExpireDate: text("license_expire_date"),   // ISO date — filter licenses expiring <90 days
  lastScrapedAt: integer("last_scraped_at"),         // Unix ms — freshness tracking
  dedupHash: text("dedup_hash"),                    // SHA-256(dbprLicenseId:email:zip) — unique per record
  // Metadata
  submittedAt: text("submitted_at").notNull().default(""),
  source: text("source").notNull().default("recruiting_page"), // "recruiting_page" | "csv_upload" | "manual" | "dbpr_scrape" | "broker_roster"
  uploadedAt: text("uploaded_at"),
  uploadedBy: integer("uploaded_by").references(() => agents.id),
  batchId: text("batch_id"),
});

export const insertAgentLeadSchema = createInsertSchema(agentLeads).omit({ id: true });
export type InsertAgentLead = z.infer<typeof insertAgentLeadSchema>;
export type AgentLead = typeof agentLeads.$inferSelect;

// Agent lead activity log
export const agentLeadActivity = sqliteTable("agent_lead_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentLeadId: integer("agent_lead_id").notNull().references(() => agentLeads.id),
  callerId: integer("caller_id").references(() => agents.id),
  outcome: text("outcome").notNull(), // dial_no_answer | keep_in_touch | hot_prospect | joined_team | not_interested
  notes: text("notes"),
  latteSnapshot: text("latte_snapshot"), // JSON: rLicense/rProduction/rMotivation/rTimeline/rObjections/rTerritory
  pointsAwarded: integer("points_awarded").notNull().default(0),
  createdAt: text("created_at").notNull().default(""),
});

export const insertAgentLeadActivitySchema = createInsertSchema(agentLeadActivity).omit({ id: true });
export type InsertAgentLeadActivity = z.infer<typeof insertAgentLeadActivitySchema>;
export type AgentLeadActivity = typeof agentLeadActivity.$inferSelect;

// Territories reference table — LEGACY as of v13.8. Kept for historical data
// and DBPR recruiting-side use. No longer used by seller-lead routing.
export const territories = sqliteTable("territories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isOpen: integer("is_open", { mode: "boolean" }).notNull().default(true),
});

export type Territory = typeof territories.$inferSelect;

// v13.8 — Lead locks: 60-minute exclusive claim so two agents don't dial the same lead
export const leadLocks = sqliteTable("lead_locks", {
  leadId: integer("lead_id").primaryKey().references(() => leads.id),
  agentId: integer("agent_id").notNull().references(() => agents.id),
  lockedAt: text("locked_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});
export type LeadLock = typeof leadLocks.$inferSelect;

// App-wide settings (key/value)
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
