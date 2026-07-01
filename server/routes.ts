import { createRequire } from "node:module";
import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";

// Works in both ESM (tsx dev) and CJS (esbuild production bundle)
const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

export function registerRoutes(httpServer: ReturnType<typeof createServer>, app: Express) {

  // ─── AUTH ──────────────────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
    const agent = storage.getAgentByEmail(email.toLowerCase().trim());
    if (!agent || agent.password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role } });
  });

  // ─── AGENTS ───────────────────────────────────────────────────────────────
  app.get("/api/agents", (req, res) => {
    const all = storage.getAllAgents();
    res.json(all.map(a => ({ ...a, password: undefined })));
  });

  app.post("/api/agents", (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    try {
      const agent = storage.createAgent({
        name,
        email: email.toLowerCase().trim(),
        password,
        role: role || "agent",
        roundRobinOrder: 0,
        isActive: true,
      });
      res.json({ ...agent, password: undefined });
    } catch (e: any) {
      res.status(409).json({ error: "Email already exists" });
    }
  });

  app.patch("/api/agents/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateAgent(id, req.body);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Soft-delete: mark agent as trashed, re-pool their active leads back to unassigned
  app.delete("/api/agents/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateAgent(id, { isActive: false, leadFlowOn: false, receiveWebsiteLeads: false });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    // Re-pool: unassign all active leads belonging to this agent
    const ACTIVE = ["assigned", "no_answer", "keep_in_touch", "callback_requested"];
    const allLeads = storage.getAllLeads();
    let repooled = 0;
    for (const lead of allLeads) {
      if (lead.assignedAgentId === id && ACTIVE.includes(lead.status)) {
        storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
        repooled++;
      }
    }
    res.json({ ...updated, password: undefined, repooled });
  });

  // Reactivate a trashed agent
  app.patch("/api/agents/:id/reactivate", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateAgent(id, { isActive: true, leadFlowOn: true });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Toggle admin as lead receiver
  app.patch("/api/agents/:id/receive-leads", (req, res) => {
    const id = parseInt(req.params.id);
    const { receiveLeads } = req.body;
    const updated = storage.updateAgent(id, { receiveLeads: !!receiveLeads });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Toggle individual agent lead flow on/off
  // If turning flow OFF, also force website leads off
  app.patch("/api/agents/:id/lead-flow", (req, res) => {
    const id = parseInt(req.params.id);
    const { leadFlowOn } = req.body;
    const patch: any = { leadFlowOn: !!leadFlowOn };
    if (!leadFlowOn) patch.receiveWebsiteLeads = false;
    const updated = storage.updateAgent(id, patch);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Toggle whether agent receives website leads
  app.patch("/api/agents/:id/website-leads", (req, res) => {
    const id = parseInt(req.params.id);
    const { receiveWebsiteLeads } = req.body;
    const updated = storage.updateAgent(id, { receiveWebsiteLeads: !!receiveWebsiteLeads });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // ─── CLEAR QUEUE ──────────────────────────────────────────────────────────
  app.post("/api/leads/clear-queue", (req, res) => {
    const { clearedBy } = req.body;
    const count = (storage as any).clearQueue(clearedBy || null);
    res.json({ cleared: count, message: `${count} active leads retired. Master records and history preserved.` });
  });

  // ─── INGEST: MotivatedSellers.com email → Lead ────────────────────────────
  // Called by the external cron parser. Accepts a pre-parsed lead payload,
  // deduplicates by leadSourceId, then inserts and round-robins it.
  app.post("/api/leads/ingest", (req, res) => {
    const {
      firstName, lastName, email, phone,
      address, city, state, zip, county,
      propertyType, reasonForSelling, estimatedValue, timeframe,
      leadSourceId, // MotivatedSellers LEAD ID field — used for dedup
      ingestSecret,
    } = req.body;

    // Simple shared-secret auth so only our cron can hit this endpoint
    const INGEST_SECRET = process.env.INGEST_SECRET || "ms-ingest-2026";
    if (ingestSecret !== INGEST_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: "Lead must have phone or email" });
    }

    // Dedup: if we already have a lead with this source ID, skip
    if (leadSourceId) {
      const existing = storage.getAllLeads().find(l => {
        try {
          const extra = JSON.parse(l.extraData || "{}");
          return extra.leadSourceId === leadSourceId;
        } catch { return false; }
      });
      if (existing) {
        return res.json({ skipped: true, reason: "Duplicate lead source ID", leadId: existing.id });
      }
    }

    const ownerName = [firstName, lastName].filter(Boolean).join(" ").trim() || "Unknown";
    const fullAddress = [address, city, state, zip].filter(Boolean).join(", ");
    const motivation = reasonForSelling || (estimatedValue ? `Estimated value: $${Number(String(estimatedValue).replace(/[^0-9.]/g,"")).toLocaleString()}` : "");

    const extraData = JSON.stringify({
      leadSourceId, county, propertyType, reasonForSelling,
      estimatedValue, timeframe,
      City: city, State: state, Zip: zip,
      ingestedAt: new Date().toISOString(),
      source: "motivatedsellers.com",
    });

    const now = new Date().toISOString();
    const allA = storage.getAllAgents();
    const agentCount = allA.filter((a: any) => a.isActive && a.leadFlowOn !== false && (a.role === "agent" || (a.role === "admin" && a.receiveLeads))).length;

    const [created] = storage.createLeadsFromBatch([{
      leadType: "website_lead",
      address: fullAddress,
      ownerName,
      phone: phone || "",
      email: email || "",
      motivation,
      extraData,
      status: agentCount > 0 ? "assigned" : "unassigned",
      assignedAgentId: null,
      attemptCount: 0,
      uploadedAt: now,
      uploadedBy: null,
      batchId: `ms_${leadSourceId || Date.now()}`,
    }]);

    if (agentCount > 0) {
      const nextAgent = storage.getNextAgentInRotation("website_lead");
      if (nextAgent) {
        storage.updateLead(created.id, { assignedAgentId: nextAgent.id, status: "assigned" });
        storage.updateRoundRobinState(nextAgent.id);
      }
    }

    res.json({ created: true, leadId: created.id, ownerName, address: fullAddress });
  });

  // ─── LEADS ────────────────────────────────────────────────────────────────
  app.get("/api/leads", (req, res) => {
    const all = storage.getAllLeads();
    res.json(all);
  });

  // Map endpoint — returns lightweight lead data for geocoding
  app.get("/api/leads/map", (req, res) => {
    const all = storage.getAllLeads();
    const mapLeads = all.map(l => {
      let city = ""; let state = "FL"; let zip = "";
      if (l.extraData) {
        try {
          const ex = JSON.parse(l.extraData);
          // Support all CSV column variants (Landvoice, MotivatedSellers, manual)
          city  = ex.city  || ex.City  || ex.PropertyCity  || ex["Property City"]  || "";
          state = ex.state || ex.State || ex.PropertyState || ex["Property State"] || "FL";
          zip   = ex.zip   || ex.Zip   || ex.zipcode || ex.Zipcode || ex.PostalCode ||
                  ex["Postal Code"] || ex.PropertyZip || ex["Property Zip"] || "";
        } catch {}
      }
      // Also try to parse city/state/zip out of the address string as last resort
      if (!city && l.address) {
        const parts = l.address.split(",").map((s: string) => s.trim());
        if (parts.length >= 3) {
          city = parts[parts.length - 3] || "";
          const stateZip = (parts[parts.length - 2] || "").split(" ").filter(Boolean);
          if (stateZip.length >= 1) state = stateZip[0];
          if (stateZip.length >= 2) zip   = stateZip[1];
        } else if (parts.length === 2) {
          const stateZip = (parts[1] || "").split(" ").filter(Boolean);
          if (stateZip.length >= 1) state = stateZip[0];
          if (stateZip.length >= 2) zip   = stateZip[1];
        }
      }
      return {
        id: l.id,
        address: l.address,
        ownerName: l.ownerName,
        status: l.status,
        leadType: l.leadType,
        city, state, zip,
      };
    });
    res.json(mapLeads);
  });

  app.get("/api/leads/stats", (req, res) => {
    res.json(storage.getAdminStats());
  });

  app.get("/api/leads/my/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    const next = storage.getNextLeadForAgent(agentId);
    const total = storage.getActiveLeadCountForAgent(agentId);
    res.json({ lead: next || null, totalActive: total });
  });

  // ─── AGENT: NEXT LEAD (query-param version used by AgentView) ─────────────
  app.get("/api/leads/my-next", (req, res) => {
    const agentId = parseInt(String(req.query.agentId || ""));
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });
    const next = storage.getNextLeadForAgent(agentId);
    if (!next) return res.status(204).end();
    res.json(next);
  });

  app.post("/api/leads/upload", (req, res) => {
    const { leads: leadRows, leadType, uploadedBy, batchId } = req.body;
    if (!leadRows || !Array.isArray(leadRows) || !leadType) {
      return res.status(400).json({ error: "Invalid upload payload" });
    }

    const now = new Date().toISOString();
    // Count eligible receivers for this specific lead type
    const allA = storage.getAllAgents();
    const agentCount = allA.filter(a => {
      if (!a.isActive || !a.leadFlowOn) return false;
      if (a.role === "admin" && !a.receiveLeads) return false;
      if (leadType === "website_lead" && !a.receiveWebsiteLeads) return false;
      return true;
    }).length;

    let disqualified = 0;
    const validRows = leadRows.filter((row: any) => {
      const name = row["Owner Name"] || row.ownerName || row.name || row.Name ||
        row["First Name"] || row["LandvoiceOwnerFirstName"] || "";
      const phone = row["Primary Phone"] || row.phone || row.Phone ||
        row["Phone Number"] || row["LandvoiceContact1Phone"] || "";
      const hasName = name.trim().length > 0;
      const hasPhone = phone.replace(/\D/g, "").length >= 7;
      if (!hasName || !hasPhone) { disqualified++; return false; }
      return true;
    });

    const created = storage.createLeadsFromBatch(
      validRows.map((row: any) => {
        // Landvoice Expired format: First Name + Last Name columns
        const firstName = row["First Name"] || row["LandvoiceOwnerFirstName"] || row["LandvoiceContact1FirstName"] || "";
        const lastName  = row["Last Name"]  || row["LandvoiceOwnerLastName"]  || row["LandvoiceContact1LastName"]  || "";
        const fullName  = row["Owner Name"] || row.ownerName || row.name || row.Name
          || (firstName || lastName ? `${firstName} ${lastName}`.trim() : "");

        // Prefer primary phone; fall back to Landvoice contact 1
        const primaryPhone = row["Primary Phone"] || row.phone || row.Phone || row["Phone Number"]
          || row["LandvoiceContact1Phone"] || "";

        // Address: prefer "Property Address" col, fall back to Address + City
        const propAddress = row["Property Address"] || row.address || row.Address || "";
        const city  = row.City  || row.city  || "";
        const state = row.State || row.state || "";
        const zip   = row.Zip   || row.zip   || row["Postal Code"] || "";
        const fullAddress = propAddress
          ? (city ? `${propAddress}, ${city}, ${state} ${zip}`.trim() : propAddress)
          : "";

        const email = row.email || row.Email || row["LandvoiceOwnerEmail"] || "";

        // Price as motivation context
        const price = row.Price || row.price || row["Listing Price"] || "";
        const beds  = row.Beds  || row.beds  || "";
        const motivation = row.motivation || row.Motivation
          || (price ? `Listed at $${Number(String(price).replace(/[^0-9.]/g,'')||0).toLocaleString()}${beds ? `, ${beds}bd` : ""}` : "");

        return {
          leadType,
          address: fullAddress,
          ownerName: fullName,
          phone: primaryPhone,
          email,
          motivation,
          extraData: JSON.stringify(row),
          status: agentCount > 0 ? "assigned" : "unassigned",
          assignedAgentId: null,
          attemptCount: 0,
          uploadedAt: now,
          uploadedBy: uploadedBy || null,
          batchId: batchId || null,
        };
      })
    );

    // Auto assign via round robin if agents exist
    if (agentCount > 0) {
      for (const lead of created) {
        const nextAgent = storage.getNextAgentInRotation(leadType);
        if (nextAgent) {
          storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
          storage.updateRoundRobinState(nextAgent.id);
        }
      }
    }

    res.json({ created: created.length, disqualified, batchId });
  });

  app.get("/api/leads/:id", (req, res) => {
    const lead = storage.getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    res.json(lead);
  });

  app.patch("/api/leads/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateLead(id, req.body);
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    res.json(updated);
  });

  // ─── OUTCOMES ─────────────────────────────────────────────────────────────
  app.post("/api/leads/:id/outcome", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, outcome, notes, lpmamab, callbackDate } = req.body;

    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Determine new lead status based on outcome
    let newStatus = lead.status;
    let newAssignedId = lead.assignedAgentId;
    let newCallbackDate = lead.callbackDate;

    const deadOutcomes = ["contacted_not_interested", "contacted_appointment"];
    const recycleOutcomes = ["no_answer"];

    if (deadOutcomes.includes(outcome)) {
      newStatus = outcome;
      // Keep assigned agent for record keeping, but lead is done
    } else if (recycleOutcomes.includes(outcome)) {
      newStatus = outcome;
      // Round-robin reassign to next agent (respect lead type eligibility)
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        newAssignedId = nextAgent.id;
        storage.updateRoundRobinState(nextAgent.id);
      }
    } else if (outcome === "keep_in_touch") {
      newStatus = "keep_in_touch";
      // Connected call — not ready now but trust us for future; stays with same agent
    } else if (outcome === "callback_requested") {
      newStatus = "callback_requested";
      newCallbackDate = callbackDate || null;
      // Keep same agent for callback
    }

    // Save LPMAMAB fields if provided
    const lpmamabUpdate = lpmamab ? {
      lLocation: lpmamab.location || lead.lLocation,
      lPricePaid: lpmamab.price || lead.lPricePaid,
      lMotivation: lpmamab.motivation || lead.lMotivation,
      lAgentHistory: lpmamab.agent || lead.lAgentHistory,
      lMortgage: lpmamab.mortgage || lead.lMortgage,
      lAppointment: lpmamab.appointment || lead.lAppointment,
      lBuy: lpmamab.buy || lead.lBuy,
    } : {};

    // Wrong number: log the attempt then permanently delete the lead
    if (outcome === "wrong_number") {
      storage.createLeadActivity({
        leadId,
        agentId: agentId || null,
        outcome,
        notes: notes || null,
        lpmamabSnapshot: null,
        createdAt: new Date().toISOString(),
      });
      storage.deleteLead(leadId);
      return res.json({ deleted: true, leadId });
    }

    // Update lead
    const updatedLead = storage.updateLead(leadId, {
      status: newStatus,
      assignedAgentId: newAssignedId,
      callbackDate: newCallbackDate,
      attemptCount: lead.attemptCount + 1,
      ...lpmamabUpdate,
    });

    // Log activity
    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome,
      notes: notes || null,
      lpmamabSnapshot: lpmamab ? JSON.stringify(lpmamab) : null,
      createdAt: new Date().toISOString(),
    });

    res.json(updatedLead);
  });

  // ─── ACTIVITY ─────────────────────────────────────────────────────────────
  app.get("/api/leads/:id/activity", (req, res) => {
    const activities = storage.getActivitiesForLead(parseInt(req.params.id));
    // Annotate with agent names
    const allAgents = storage.getAllAgents();
    const annotated = activities.map(a => ({
      ...a,
      agentName: a.agentId ? allAgents.find(ag => ag.id === a.agentId)?.name || "Unknown" : "System",
    }));
    res.json(annotated);
  });


  // ─── ADMIN: PER-AGENT STATS ───────────────────────────────────────────────
  app.get("/api/admin/agent-stats", (req, res) => {
    // Load leaderboard reset timestamp
    const sqlite3r = require("better-sqlite3");
    const dbr = new sqlite3r("data.db");
    dbr.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const resetRow = dbr.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    dbr.close();
    const resetAt: string | null = resetRow?.value || null;

    // Show agents (active + flow on) AND admins with receiveLeads=true
    const allAgents = storage.getAllAgents().filter(a =>
      a.isActive &&
      (
        (a.role === "agent" && a.leadFlowOn !== false) ||
        (a.role === "admin" && a.receiveLeads)
      )
    );
    const allLeads = storage.getAllLeads();
    const allActivities = (() => {
      const acts: any[] = [];
      for (const lead of allLeads) {
        const la = storage.getActivitiesForLead(lead.id);
        // Filter activities after reset date if set
        acts.push(...(resetAt ? la.filter((a: any) => a.createdAt > resetAt) : la));
      }
      return acts;
    })();

    const stats = allAgents.map(agent => {
      const agentLeads = allLeads.filter(l => l.assignedAgentId === agent.id);
      const agentActs = allActivities.filter(a => a.agentId === agent.id);

      const outcomes = {
        contacted_appointment: agentActs.filter(a => a.outcome === "contacted_appointment").length,
        contacted_not_interested: agentActs.filter(a => a.outcome === "contacted_not_interested").length,
        no_answer: agentActs.filter(a => a.outcome === "no_answer").length,
        keep_in_touch: agentActs.filter(a => a.outcome === "keep_in_touch").length,
        callback_requested: agentActs.filter(a => a.outcome === "callback_requested").length,
        wrong_number: agentActs.filter(a => a.outcome === "wrong_number").length,
      };

      const totalAttempts = agentActs.length;
      const contactRate = totalAttempts > 0
        ? Math.round(((outcomes.contacted_appointment + outcomes.contacted_not_interested + outcomes.keep_in_touch) / totalAttempts) * 100)
        : 0;

      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        leadsReceived: agentLeads.length,
        activeLeads: agentLeads.filter(l => ["assigned","no_answer","keep_in_touch","callback_requested"].includes(l.status)).length,
        appointmentsSet: outcomes.contacted_appointment,
        totalAttempts,
        contactRate,
        outcomes,
      };
    });

    // Sort by appointments set desc (leaderboard order)
    stats.sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts);
    res.json(stats);
  });

  // ─── ADMIN: PIPELINE VIEW ─────────────────────────────────────────────────
  app.get("/api/admin/pipeline", (req, res) => {
    const allLeads = storage.getAllLeads();
    const allAgents = storage.getAllAgents();
    const agentMap = Object.fromEntries(allAgents.map(a => [a.id, a.name]));

    const enriched = allLeads.map(l => ({
      ...l,
      assignedAgentName: l.assignedAgentId ? agentMap[l.assignedAgentId] || "Unknown" : null,
    }));

    const byStatus = {
      unassigned: enriched.filter(l => l.status === "unassigned"),
      assigned: enriched.filter(l => l.status === "assigned"),
      no_answer: enriched.filter(l => l.status === "no_answer"),
      keep_in_touch: enriched.filter(l => l.status === "keep_in_touch"),
      callback_requested: enriched.filter(l => l.status === "callback_requested"),
      contacted_appointment: enriched.filter(l => l.status === "contacted_appointment"),
      contacted_not_interested: enriched.filter(l => l.status === "contacted_not_interested"),
      wrong_number: enriched.filter(l => l.status === "wrong_number"),
    };

    res.json({ leads: enriched, byStatus, total: allLeads.length });
  });

  // ─── ADMIN: LEADS FOR SPECIFIC AGENT ─────────────────────────────────────
  app.get("/api/admin/agent/:id/leads", (req, res) => {
    const agentId = parseInt(req.params.id);
    const agent = storage.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const allLeads = storage.getAllLeads().filter(l => l.assignedAgentId === agentId);
    const activities = allLeads.flatMap(l =>
      storage.getActivitiesForLead(l.id).map(a => ({ ...a, leadAddress: l.address }))
    );

    res.json({ agent: { id: agent.id, name: agent.name, email: agent.email }, leads: allLeads, activities });
  });


  // ─── SCRIPTS (DB-backed, editable) ────────────────────────────────────────
  // Initialize default scripts on first run
  const initScript = (leadType: string, defaultContent: string) => {
    const db2 = (storage as any);
    // Use raw sqlite to check/insert scripts
    const { drizzle } = require("drizzle-orm/better-sqlite3");
    const Database = require("better-sqlite3");
    const sqlite2 = new Database("data.db");
    const exists = sqlite2.prepare("SELECT id FROM scripts WHERE lead_type = ?").get(leadType);
    if (!exists) {
      sqlite2.prepare("INSERT INTO scripts (lead_type, content, updated_at) VALUES (?, ?, ?)").run(leadType, defaultContent, new Date().toISOString());
    }
    sqlite2.close();
  };

  const expiredScript = `EXPIRED LISTING SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING
"Hi, this is [YOUR NAME] from The Brothers Group Real Estate Team. I was looking at [ADDRESS] here in [CITY] — it looks like the home was for sale but came off the market. What happened there? Did it sell?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

If they ask "Who is this again?"
  → "Great question — my name is [NAME], I'm with The Brothers Group at Momentum Realty. We're one of the top producing teams in Northeast Florida. We keep a close eye on everything happening in this market."

If they ask "Why are you calling?"
  → "We work with a lot of active buyers right now, and this home caught our attention. We'd love to be able to show it — but I also wanted to see if you were still thinking about selling."

If they say "We're not in a rush" or "We just took it down for now"
  → "Totally understandable. A lot of sellers do that. Can I ask — what would need to change for you to move forward?"

─────────────────────────────────────────────────
ABOUT US (when they're open — keep it brief)
"I'm [NAME] — my partner and I run The Brothers Group here in [CITY]. We've been recognized as a top 1% producing team and top team in Northeast Florida, JBJ Award winners, and we have an office right on the island. We sell homes fast and at strong prices — but more importantly, we take care of our clients the right way."

─────────────────────────────────────────────────
GATHER — LPMAMAB (let them talk, ask one at a time)

  L — Location:     "Where are you planning to go after you sell?"
  P — Price:        "What were you listed at? What do you need to net to make the move work?"
  M — Motivation:   "What's driving the move — job, family, lifestyle change?"
  A — Agent:        "Were you working with an agent? What do you feel could have gone better?"
  M — Mortgage:     "Do you have a sense of what you owe on the property right now?"
  A — Appointment:  "I'd love to come by and walk through what we'd do differently. What does [DAY] or [DAY] look like for a quick 20-minute visit?"
  B — Buyer:          "Once you sell — will you be buying something here or in your destination?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "Perfect — we'll send you a calendar invite and a quick email with our team info and what to expect. We're looking forward to it."

If not ready yet:
  "I completely understand. Can I at least send you our info so you know who we are when you're ready? And would it be okay if I checked back in [X weeks]?"

─────────────────────────────────────────────────`;

  const flipScript = `FLIP LEAD SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING
"Hi, this is [YOUR NAME] from The Brothers Group Real Estate Team. I came across [ADDRESS] in [CITY] — it looks like an investment property and I wanted to reach out. Are you the owner?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

If they ask "How did you get my number?"
  → "We monitor investment activity closely in this market — we work with both buyers and sellers in this space and stay very dialed in to what's moving."

If they say "I'm not interested"
  → "Totally fair. Can I just ask — are you planning to hold it, flip it, or is the strategy still being worked out?" (Re-engage with curiosity)

If they say "I already have an agent"
  → "No problem at all — we work alongside a lot of investors who already have relationships. We're really just staying connected so if anything changes, you know who to call."

─────────────────────────────────────────────────
ABOUT US (brief — investors don't want a pitch)
"We specialize in helping investors move properties quickly and at strong margins. We also help them find their next deal. The Brothers Group is a top 1% team in Northeast Florida — we move fast and keep things simple."

─────────────────────────────────────────────────
GATHER — LPMAMAB

  L — Location:     "Are you local, or are you investing from out of area?"
  P — Price:        "What did you pay for it? What are you targeting for your resale or exit?"
  M — Motivation:   "What's the play — fix and flip, wholesale, hold as a rental?"
  A — Agent:        "Do you have a buyer's agent or listing agent you're already working with?"
  M — Mortgage:     "Are you in it with cash, hard money, or conventional financing?"
  A — Appointment:  "Would it make sense to connect — even just a quick 15-minute call — to see how we can help you move it or find your next one?"
  B — Buyer:          "Are you actively looking for the next deal, or are you focused on exiting this one first?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "Great — let's lock that in. I'll send a calendar invite and our info so you have it. We'll keep it short and make it worth your time."

If not ready:
  "I hear you. Mind if I follow up in [X weeks] once you're closer to making a move? We'd love to be in your corner when the time comes."

─────────────────────────────────────────────────`;

  const websiteLeadScript = `WEBSITE LEAD SCRIPT
─────────────────────────────────────────────────
LEAD SOURCE: MotivatedSellers.com — Inbound Seller Inquiry
TYPE: Motivated Seller (they reached out to us)

─────────────────────────────────────────────────
OPENING

"Hi, is this [First Name]? Hey [First Name], this is [Your Name] calling from Brothers Group at Momentum Realty. I'm reaching out because you submitted your property at [Address] through our website — I just wanted to follow up and see how we can help. Is now an okay time?"

─────────────────────────────────────────────────
IF GOOD TIME → TRANSITION

"Great. So I see your home is at [Address] in [City] — [Property Type], estimated around $[Value]. I just want to make sure I understand your situation so I can point you in the right direction."

─────────────────────────────────────────────────
GATHER — LPMAMAB

  L — Location:
    "Are you currently living in the home, or is it a rental / vacant?"

  P — Price:
    "I see the estimated value came in around $[Estimated Value] — does that feel accurate to you? What were you hoping to walk away with?"

  M — Motivation:
    "You mentioned [Reason for Selling] — can you tell me a little more about what's driving the timeline?"
    (If blank: "What's the main reason you're looking to sell?")

  A — Agent:
    "Have you spoken with any other agents or companies about selling?"

  M — Mortgage:
    "Is there currently a mortgage on the property, or do you own it free and clear?"

  A — Appointment:
    "It sounds like we should connect in person — I'd love to come take a look at the property and put together some real numbers for you. Would [Day] or [Day] work better?"

  B — Buyer:
    "Once this sells, are you planning to buy something else, or are you done for now?"

─────────────────────────────────────────────────
TIMEFRAME CHECK

"You put down [Timeframe] — is that still accurate? Are you flexible, or is there a hard deadline driving that?"

─────────────────────────────────────────────────
OBJECTION HANDLERS

If "I'm just exploring options":
  → "Totally understand — that's exactly what this call is for. No pressure at all. I just want to make sure you have accurate information so you can make the best decision for your situation."

If "I already have an agent":
  → "No problem. Are you under contract with them, or just in conversation? We work with a lot of sellers who are still weighing their options."

If "What can you get me for it?":
  → "That's the most important question — I don't want to give you a number without seeing it. That's why I'd love to come by. It won't take long and I'll have real comps in hand."

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "Perfect — I'll lock that in and send you a confirmation. I'll also pull some comparable sales so we come prepared. Looking forward to it."

If not ready:
  "No worries at all. When would be a better time to reconnect? I want to make sure you have everything you need when you're ready to move forward."

─────────────────────────────────────────────────`;

  const distressedScript = `DISTRESSED PROPERTY SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING
"Hi, is this [Owner Name]? This is [YOUR NAME] with The Brothers Group at Momentum Realty. I specialize in helping homeowners in difficult or time-sensitive situations — and I came across your property at [ADDRESS]. I just wanted to reach out and see if there's anything I could help with. Is now an okay time?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

If they ask "How did you get my information?"
  → "We track properties in this area closely — sometimes homes show signs that the owner might be weighing options. I'm not here to pressure you, just to let you know we have options and can move quickly if needed."

If they say "I'm handling it myself"
  → "I respect that. Can I ask — what direction are you leaning right now? Sometimes having a real estate professional in your corner can open up options you didn't know were there."

If they say "I'm not interested"
  → "That's okay. Would it be alright if I at least shared what your home might be worth in today's market? No strings attached."

─────────────────────────────────────────────────
GATHER — LPMAMAB

  L — Location:    "Where are you hoping to be after this is resolved?"
  P — Price:       "Do you have a sense of what the home might be worth right now?"
  M — Motivation:  "What's the main challenge you're facing with the property?"
  A — Agent:       "Have you spoken with an agent or attorney about this yet?"
  M — Mortgage:    "Is there still a mortgage on the property, and do you know roughly what's owed?"
  A — Appointment: "Would it make sense for me to come out, take a look, and put together some options for you? I can usually do that within 24-48 hours."
  B — Buyer:         "After this situation is resolved — will you be looking to buy somewhere else?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "We'll be in touch to confirm. We work fast and treat every situation with care."

If not ready:
  "Completely understand. Let me send you our info so you have it when you're ready. May I follow up in [X days]?"
─────────────────────────────────────────────────`;

  const fsboScript = `FOR SALE BY OWNER (FSBO) SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING
"Hi, is this [Owner Name]? Hey [Name] — I'm [YOUR NAME] with The Brothers Group at Momentum Realty. I saw your home at [ADDRESS] listed for sale by owner. I'm not calling to convince you to list with an agent — I actually work with a lot of buyers and wanted to see if I could bring one of them through. Would you be open to that?"

(If yes) → Great. Then naturally move into LPMAMAB.
(If "I'm only selling direct") → "Totally respect that. Out of curiosity, how long have you been on the market? Are you getting much traffic?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

If they say "I don't want to pay commission"
  → "That makes total sense. If I bring you a buyer, my commission comes from the buyer side — it doesn't have to cost you anything. Can I share how that typically works?"

If they say "We have a buyer already"
  → "Perfect! How far along are you? If that falls through, I work with multiple backup buyers and can move fast."

If they say "I'm handling it myself"
  → "Respect that. How long have you been trying? We have a lot of buyer inquiries we send to FSBO homes. If the traffic hasn't been there, we can change that fast."

─────────────────────────────────────────────────
GATHER — LPMAMAB

  L — Location:    "Where are you planning to go once this sells?"
  P — Price:       "What are you listed at? Is that firm, or do you have some flexibility?"
  M — Motivation:  "What's pushing you to sell right now?"
  A — Agent:       "Have you worked with an agent before, or is this your first time going at it solo?"
  M — Mortgage:    "Do you owe anything on the property currently?"
  A — Appointment: "Can I swing by to see it in person? Sometimes just walking through helps me match it to the right buyer faster. What does [Day] look like?"
  B — Buyer:         "After this closes — will you be buying your next place or moving on?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "Great — I'll send a quick email with my info and what to expect. We'll keep it brief and make it worth your time."

If not ready:
  "No pressure. Mind if I send over a quick market report for your area? And I'll check back in [X weeks] — deal?"
─────────────────────────────────────────────────`;

  const landScript = `LAND / VACANT LOT SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING
"Hi, is this [Owner Name]? Hey — this is [YOUR NAME] with The Brothers Group at Momentum Realty. I came across your parcel at [ADDRESS/PARCEL ID] in [CITY/COUNTY]. We've been getting a lot of inquiries from buyers looking for land in that area, and I wanted to reach out to see if you'd ever considered selling. Is now a good time?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

If they say "I'm not interested in selling"
  → "Totally understand. Would you be open to knowing what it might be worth right now? The land market in this area has moved a lot."

If they say "What would I get for it?"
  → "Great question — it really depends on the acreage, utilities available, and zoning. Can I get a few quick details from you so I can put together a number?"

If they say "I bought it as an investment"
  → "Smart move. Has it appreciated the way you hoped? We work with builders and developers who pay strong prices for the right parcels right now."

─────────────────────────────────────────────────
GATHER — LPMAMAB

  L — Location:    "Are you local, or do you own this parcel from out of the area?"
  P — Price:       "Do you have a number in mind, or are you open to hearing what the market supports?"
  M — Motivation:  "What was the original plan for the land? Has that changed?"
  A — Agent:       "Have you worked with a real estate agent on land before?"
  M — Mortgage:    "Is there any debt on the parcel, or do you own it free and clear?"
  A — Appointment: "I'd love to put together a land analysis and bring it to you. Could we schedule a quick call this week?"
  B — Buyer:         "If you do sell — would you be looking to reinvest in another property?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
  "Great — I'll pull the comps and reach out to confirm. We work with land all the time and can give you an honest picture of what it's worth."

If not ready:
  "No rush. Would it be okay if I sent you a quick overview of recent land sales nearby? And I'll check in with you in [X weeks]."
─────────────────────────────────────────────────`;

  initScript("expired", expiredScript);
  initScript("distressed", distressedScript);
  initScript("website_lead", websiteLeadScript);
  initScript("fsbo", fsboScript);
  initScript("land", landScript);

  const emailOutreachTemplate = `Subject: Regarding Your Property at {address}

Hi {ownerName},

My name is [YOUR NAME] with The Brothers Group at Momentum Realty. I came across your property at {address} and wanted to reach out personally.

We work with a lot of qualified buyers actively looking in your area, and I'd love to have a quick conversation to see if there's an opportunity to help you.

Would you be open to a brief call this week?

Best regards,
[YOUR NAME]
Brothers Group Real Estate at Momentum Realty
[YOUR PHONE]
bgre.com

---
Note: Replace {ownerName} and {address} with lead details before sending.
This template is for informational/outreach purposes only.`;
  initScript("email_outreach", emailOutreachTemplate);

  app.get("/api/scripts/:type", (req, res) => {
    const leadType = req.params.type;
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    const row = db3.prepare("SELECT * FROM scripts WHERE lead_type = ?").get(leadType);
    db3.close();
    if (!row) return res.status(404).json({ error: "Script not found" });
    res.json({ leadType: row.lead_type, content: row.content, updatedAt: row.updated_at });
  });

  app.get("/api/scripts", (req, res) => {
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    const rows = db3.prepare("SELECT lead_type, updated_at FROM scripts").all();
    db3.close();
    res.json(rows);
  });

  app.patch("/api/scripts/:type", (req, res) => {
    const leadType = req.params.type;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "Missing content" });
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    const now = new Date().toISOString();
    db3.prepare("UPDATE scripts SET content = ?, updated_at = ? WHERE lead_type = ?").run(content, now, leadType);
    db3.close();
    res.json({ leadType, content, updatedAt: now });
  });


  // ─── ADMIN: MY LEAD QUEUE COUNT ──────────────────────────────────────────
  app.get("/api/leads/my-count/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    const allLeads = storage.getAllLeads();
    const activeStatuses = ["assigned", "no_answer", "keep_in_touch", "callback_requested"];
    const count = allLeads.filter(l => l.assignedAgentId === agentId && activeStatuses.includes(l.status)).length;
    res.json({ count });
  });

  // ─── LEADERBOARD RESET ────────────────────────────────────────────────────
  app.post("/api/admin/leaderboard-reset", (req, res) => {
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    const now = new Date().toISOString();
    // Upsert a single-row settings record with leaderboard_reset_at
    db3.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    db3.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now);
    db3.close();
    res.json({ ok: true, resetAt: now });
  });

  app.get("/api/admin/leaderboard-reset", (req, res) => {
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    db3.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const row = db3.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    db3.close();
    res.json({ resetAt: row?.value || null });
  });

  // ─── AGENT-FACING LEADERBOARD (no admin-only data) ────────────────────────
  app.get("/api/agent/leaderboard", (req, res) => {
    const sqlite3a = require("better-sqlite3");
    const dba = new sqlite3a("data.db");
    dba.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const resetRow = dba.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    dba.close();
    const resetAt: string | null = resetRow?.value || null;

    const allAgents = storage.getAllAgents().filter(a =>
      a.isActive && (
        (a.role === "agent" && a.leadFlowOn !== false) ||
        (a.role === "admin" && a.receiveLeads)
      )
    );
    const allLeads = storage.getAllLeads();
    const allActivities = (() => {
      const acts: any[] = [];
      for (const lead of allLeads) {
        const la = storage.getActivitiesForLead(lead.id);
        acts.push(...(resetAt ? la.filter((a: any) => a.createdAt > resetAt) : la));
      }
      return acts;
    })();

    const stats = allAgents.map(agent => {
      const agentActs = allActivities.filter((a: any) => a.agentId === agent.id);
      const appts = agentActs.filter((a: any) => a.outcome === "contacted_appointment").length;
      const total = agentActs.length;
      const contacted = agentActs.filter((a: any) => ["contacted_appointment","contacted_not_interested"].includes(a.outcome)).length;
      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        appointmentsSet: appts,
        totalAttempts: total,
        contactRate: total > 0 ? Math.round((contacted / total) * 100) : 0,
        outcomes: {
          contacted_appointment: appts,
          no_answer: agentActs.filter((a: any) => a.outcome === "no_answer").length,
          keep_in_touch: agentActs.filter((a: any) => a.outcome === "keep_in_touch").length,
        },
      };
    });
    stats.sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts);
    res.json(stats);
  });

  // ─── NETWORK LEAD (agent submits a referral seller lead) ──────────────────
  app.post("/api/leads/network", (req, res) => {
    const { ownerName, phone, email, address, notes, submittedBy, submittedByName } = req.body;
    if (!ownerName || !phone) return res.status(400).json({ error: "Name and phone required" });
    const now = new Date().toISOString();
    const extraData = JSON.stringify({
      source: "network",
      submittedByName: submittedByName || "Unknown",
      submittedById: submittedBy,
      networkNotes: notes || "",
      ingestedAt: now,
    });
    const submitterAgentId = submittedBy ? parseInt(String(submittedBy)) : null;
    const [created] = storage.createLeadsFromBatch([{
      leadType: "website_lead",
      address: address || "",
      ownerName,
      phone,
      email: email || "",
      motivation: notes || "",
      extraData,
      status: submitterAgentId ? "assigned" : "unassigned",
      assignedAgentId: submitterAgentId,
      attemptCount: 0,
      uploadedAt: now,
      uploadedBy: submitterAgentId,
      batchId: `network_${Date.now()}`,
    }]);
    res.json({ created: true, leadId: created.id });
  });

  // ─── REFERRALS (agent refers a person to join the team) ───────────────────
  app.post("/api/referrals", (req, res) => {
    const { name, phone, email, brokerage, notes, referredBy, referredByName } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });
    const sqlite3r2 = require("better-sqlite3");
    const dbr2 = new sqlite3r2("data.db");
    dbr2.prepare(`
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
    const now = new Date().toISOString();
    const info = dbr2.prepare(
      `INSERT INTO referrals (name, phone, email, brokerage, notes, referred_by, referred_by_name, created_at) VALUES (?,?,?,?,?,?,?,?)`
    ).run(name, phone, email || "", brokerage || "", notes || "", referredBy || null, referredByName || "", now);
    dbr2.close();
    res.json({ created: true, id: info.lastInsertRowid });
  });

  // ─── ADMIN: VIEW REFERRALS ─────────────────────────────────────────────────
  app.get("/api/referrals", (req, res) => {
    const sqlite3r3 = require("better-sqlite3");
    const dbr3 = new sqlite3r3("data.db");
    dbr3.prepare(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, brokerage TEXT,
        notes TEXT, referred_by INTEGER, referred_by_name TEXT,
        created_at TEXT NOT NULL DEFAULT ''
      )
    `).run();
    const rows = dbr3.prepare(`SELECT * FROM referrals ORDER BY created_at DESC`).all();
    dbr3.close();
    res.json(rows);
  });

  // ─── CSV EXPORT ───────────────────────────────────────────────────────────
  app.get("/api/export/leads", (req, res) => {
    const allLeads = storage.getAllLeads();
    const agents = storage.getAllAgents();
    const agentMap = Object.fromEntries(agents.map(a => [a.id, a.name]));

    const headers = [
      "ID", "Lead Type", "First Name", "Last Name", "Email", "Phone",
      "Address", "City", "State", "Zip", "County",
      "Property Type", "Reason for Selling", "Estimated Value", "Timeframe",
      "Status", "Assigned Agent", "Uploaded At", "Lead Source ID"
    ];

    const escape = (val: any) => {
      if (val == null) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = allLeads.map(lead => {
      const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();
      return [
        lead.id,
        lead.leadType || "",
        lead.firstName || "",
        lead.lastName || "",
        lead.email || "",
        lead.phone || "",
        extra.address || lead.address || "",
        extra.city || lead.city || "",
        extra.state || lead.state || "",
        extra.zip || lead.zip || "",
        extra.county || lead.county || "",
        extra.propertyType || "",
        extra.reasonForSelling || "",
        extra.estimatedValue || "",
        extra.timeframe || "",
        lead.status || "",
        agentMap[lead.assignedAgentId ?? 0] || "",
        lead.uploadedAt || "",
        extra.leadSourceId || lead.leadSourceId || "",
      ].map(escape).join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    const filename = `lead-depot-export-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  });

  return httpServer;
}
