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
  // Agent profile fields
  phone: text("phone"),
  brokerage: text("brokerage"),
  homeAddress: text("home_address"),
  headshotUrl: text("headshot_url"),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Leads table
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Lead type
  leadType: text("lead_type").notNull(), // "expired" | "distressed" | "website_lead" | "fsbo" | "land"
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
  lBuy: text("l_buy"),                  // B - Buyer (do they want to buy after selling?)
  // Upload metadata
  uploadedAt: text("uploaded_at").notNull().default(""),
  uploadedBy: integer("uploaded_by").references(() => agents.id),
  batchId: text("batch_id"), // groups leads from same CSV upload
  // Multi-number dialing
  phones: text("phones"),       // JSON array: ["9041234567", "9047654321", ...]
  phoneStates: text("phone_states"), // JSON object: {"9041234567": "untried" | "no_answer_today" | "struck"}
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
export const agentPoints = sqliteTable("agent_points", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull().references(() => agents.id),
  points: integer("points").notNull().default(0),
  reason: text("reason").notNull(), // "appointment" | "kit" | "dial" | "wrong_number" | "referral"
  leadId: integer("lead_id"),       // optional reference
  createdAt: text("created_at").notNull().default(""),
});
export type AgentPoints = typeof agentPoints.$inferSelect;
