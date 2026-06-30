import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { pushAppointmentToFUB, pushKeepInTouchToFUB } from "./fubClient";

export function registerRoutes(httpServer: ReturnType<typeof createServer>, app: Express) {

  // AUTH
  app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
    const agent = storage.getAgentByEmail(email.toLowerCase().trim());
    if (!agent || agent.password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role } });
  });

  // AGENTS
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

  app.delete("/api/agents/:id", (req, res) => {
    storage.deleteAgent(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // LEADS
  app.get("/api/leads", (req, res) => {
    const all = storage.getAllLeads();
    res.json(all);
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

  app.get("/api/leads/my-history/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    if (isNaN(agentId)) return res.status(400).json({ error: "Invalid agentId" });
    const history = storage.getActivityHistoryForAgent(agentId);
    res.json({ history });
  });

  app.post("/api/leads/upload", (req, res) => {
    const { leads: leadRows, leadType, uploadedBy, batchId } = req.body;
    if (!leadRows || !Array.isArray(leadRows) || !leadType) {
      return res.status(400).json({ error: "Invalid upload payload" });
    }

    const now = new Date().toISOString();
    const agentCount = storage.getAllAgents().filter(a => a.role === "agent" && a.isActive).length;

    const created = storage.createLeadsFromBatch(
      leadRows.map((row: any) => {
        const firstName = row["First Name"] || row["LandvoiceOwnerFirstName"] || row["LandvoiceContact1FirstName"] || "";
        const lastName  = row["Last Name"]  || row["LandvoiceOwnerLastName"]  || row["LandvoiceContact1LastName"]  || "";
        const fullName  = row["Owner Name"] || row.ownerName || row.name || row.Name
          || (firstName || lastName ? `${firstName} ${lastName}`.trim() : "");

        const primaryPhone = row["Primary Phone"] || row.phone || row.Phone || row["Phone Number"]
          || row["LandvoiceContact1Phone"] || "";

        const propAddress = row["Property Address"] || row.address || row.Address || "";
        const city  = row.City  || row.city  || "";
        const state = row.State || row.state || "";
        const zip   = row.Zip   || row.zip   || row["Postal Code"] || "";
        const fullAddress = propAddress
          ? (city ? `${propAddress}, ${city}, ${state} ${zip}`.trim() : propAddress)
          : "";

        const email = row.email || row.Email || row["LandvoiceOwnerEmail"] || "";

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

    if (agentCount > 0) {
      for (const lead of created) {
        const nextAgent = storage.getNextAgentInRotation();
        if (nextAgent) {
          storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
          storage.updateRoundRobinState(nextAgent.id);
        }
      }
    }

    res.json({ created: created.length, batchId });
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

  // OUTCOMES
  app.post("/api/leads/:id/outcome", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, outcome, notes, lpmamab, callbackDate, apptDetails, kitDetails } = req.body;

    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // declined_service: log activity then hard-delete the lead
    if (outcome === "declined_service") {
      storage.createLeadActivity({
        leadId,
        agentId: agentId || null,
        outcome: "declined_service",
        notes: "Lead declined services - removed from system.",
        lpmamabSnapshot: null,
        createdAt: new Date().toISOString(),
      });
      storage.deleteLead(leadId);
      return res.json({ ok: true, deleted: true });
    }

    let newStatus = lead.status;
    let newAssignedId = lead.assignedAgentId;
    let newCallbackDate = lead.callbackDate;

    // Dead outcomes - no more calls, lead stays for records
    const deadOutcomes = ["contacted_not_interested", "contacted_appointment", "keep_in_touch", "wrong_number"];
    // Recycle outcomes - reassign to next agent in rotation
    const recycleOutcomes = ["no_answer", "left_voicemail"];

    if (deadOutcomes.includes(outcome)) {
      newStatus = outcome;
    } else if (recycleOutcomes.includes(outcome)) {
      newStatus = outcome;
      const nextAgent = storage.getNextAgentInRotation();
      if (nextAgent) {
        newAssignedId = nextAgent.id;
        storage.updateRoundRobinState(nextAgent.id);
      }
    } else if (outcome === "callback_requested") {
      newStatus = "callback_requested";
      newCallbackDate = callbackDate || null;
    }

    const lpmamabUpdate = lpmamab ? {
      lLocation: lpmamab.location || lead.lLocation,
      lPricePaid: lpmamab.price || lead.lPricePaid,
      lMotivation: lpmamab.motivation || lead.lMotivation,
      lAgentHistory: lpmamab.agent || lead.lAgentHistory,
      lMortgage: lpmamab.mortgage || lead.lMortgage,
      lAppointment: lpmamab.appointment || lead.lAppointment,
      lBuy: lpmamab.buy || lead.lBuy,
    } : {};

    // Build enriched notes including appointment / keep-in-touch details
    let enrichedNotes = notes || "";
    if (outcome === "contacted_appointment" && apptDetails) {
      const locLine = apptDetails.atProperty
        ? `Location: Subject property (${apptDetails.address})`
        : `Location: Different from subject property`;
      enrichedNotes = [
        `Listing Appointment Set`,
        `Date/Time: ${apptDetails.dateTime || "TBD"}`,
        locLine,
        notes ? `Notes: ${notes}` : "",
      ].filter(Boolean).join(" | ");
    } else if (outcome === "keep_in_touch" && kitDetails) {
      enrichedNotes = [
        `Keep In Touch`,
        kitDetails.email ? `Email: ${kitDetails.email}` : "",
        kitDetails.tempo ? `Tempo: ${kitDetails.tempo}` : "",
        notes ? `Notes: ${notes}` : "",
      ].filter(Boolean).join(" | ");
    }

    const updatedLead = storage.updateLead(leadId, {
      status: newStatus,
      assignedAgentId: newAssignedId,
      callbackDate: newCallbackDate,
      attemptCount: lead.attemptCount + 1,
      // Update email if KIT provided a confirmed one
      ...(outcome === "keep_in_touch" && kitDetails?.email ? { email: kitDetails.email } : {}),
      ...lpmamabUpdate,
    });

    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome,
      notes: enrichedNotes || null,
      lpmamabSnapshot: lpmamab ? JSON.stringify(lpmamab) : null,
      createdAt: new Date().toISOString(),
    });

    // Push to Follow Up Boss (fire-and-forget — don't block the response)
    const agentRecord = agentId ? storage.getAgentById(agentId) : null;
    if (outcome === "contacted_appointment" && process.env.FUB_API_KEY) {
      pushAppointmentToFUB({
        ownerName: lead.ownerName || "Unknown",
        phone: lead.phone || "",
        email: lead.email || "",
        address: lead.address,
        apptDetails: apptDetails || { dateTime: "", atProperty: true, address: lead.address },
        lpmamab: lpmamab || null,
        notes: notes || "",
        leadType: lead.leadType,
        agentName: agentRecord?.name,
      }).catch(err => console.error("[FUB] Appointment push failed:", err.message));
    } else if (outcome === "keep_in_touch" && process.env.FUB_API_KEY) {
      pushKeepInTouchToFUB({
        ownerName: lead.ownerName || "Unknown",
        phone: lead.phone || "",
        email: lead.email || "",
        address: lead.address,
        kitDetails: kitDetails || { email: lead.email || "", tempo: "" },
        lpmamab: lpmamab || null,
        notes: notes || "",
        leadType: lead.leadType,
        agentName: agentRecord?.name,
      }).catch(err => console.error("[FUB] Keep In Touch push failed:", err.message));
    }

    res.json(updatedLead);
  });

  // ACTIVITY
  app.get("/api/leads/:id/activity", (req, res) => {
    const activities = storage.getActivitiesForLead(parseInt(req.params.id));
    const allAgents = storage.getAllAgents();
    const annotated = activities.map(a => ({
      ...a,
      agentName: a.agentId ? allAgents.find(ag => ag.id === a.agentId)?.name || "Unknown" : "System",
    }));
    res.json(annotated);
  });


  // ADMIN: PER-AGENT STATS
  app.get("/api/admin/agent-stats", (req, res) => {
    const allAgents = storage.getAllAgents().filter(a => a.role === "agent");
    const allLeads = storage.getAllLeads();
    const allActivities = (() => {
      const acts: any[] = [];
      for (const lead of allLeads) {
        const la = storage.getActivitiesForLead(lead.id);
        acts.push(...la);
      }
      return acts;
    })();

    const stats = allAgents.map(agent => {
      const agentLeads = allLeads.filter(l => l.assignedAgentId === agent.id);
      const agentActs = allActivities.filter(a => a.agentId === agent.id);

      const outcomes = {
        contacted_appointment: agentActs.filter(a => a.outcome === "contacted_appointment").length,
        keep_in_touch: agentActs.filter(a => a.outcome === "keep_in_touch").length,
        contacted_not_interested: agentActs.filter(a => a.outcome === "contacted_not_interested").length,
        declined_service: agentActs.filter(a => a.outcome === "declined_service").length,
        no_answer: agentActs.filter(a => a.outcome === "no_answer").length,
        left_voicemail: agentActs.filter(a => a.outcome === "left_voicemail").length,
        callback_requested: agentActs.filter(a => a.outcome === "callback_requested").length,
        wrong_number: agentActs.filter(a => a.outcome === "wrong_number").length,
      };

      const totalAttempts = agentActs.length;
      const contactRate = totalAttempts > 0
        ? Math.round(((outcomes.contacted_appointment + outcomes.keep_in_touch + outcomes.contacted_not_interested) / totalAttempts) * 100)
        : 0;

      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        leadsReceived: agentLeads.length,
        activeLeads: agentLeads.filter(l => ["assigned","no_answer","left_voicemail","callback_requested"].includes(l.status)).length,
        appointmentsSet: outcomes.contacted_appointment,
        keepInTouch: outcomes.keep_in_touch,
        totalAttempts,
        contactRate,
        outcomes,
      };
    });

    stats.sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts);
    res.json(stats);
  });

  // ADMIN: PIPELINE VIEW
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
      left_voicemail: enriched.filter(l => l.status === "left_voicemail"),
      callback_requested: enriched.filter(l => l.status === "callback_requested"),
      contacted_appointment: enriched.filter(l => l.status === "contacted_appointment"),
      keep_in_touch: enriched.filter(l => l.status === "keep_in_touch"),
      contacted_not_interested: enriched.filter(l => l.status === "contacted_not_interested"),
      wrong_number: enriched.filter(l => l.status === "wrong_number"),
    };

    res.json({ leads: enriched, byStatus, total: allLeads.length });
  });

  // ADMIN: LEADS FOR SPECIFIC AGENT
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


  // SCRIPTS (DB-backed, editable)
  const initScript = (leadType: string, defaultContent: string) => {
    const sqlite3 = require("better-sqlite3");
    const db3 = new sqlite3("data.db");
    const exists = db3.prepare("SELECT id FROM scripts WHERE lead_type = ?").get(leadType);
    if (!exists) {
      db3.prepare("INSERT INTO scripts (lead_type, content, updated_at) VALUES (?, ?, ?)").run(leadType, defaultContent, new Date().toISOString());
    }
    db3.close();
  };

  const expiredScript = `EXPIRED LISTING SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING

"Hi, is this [Owner's Name]? Great — my name is [Your Name] with Brothers Group at Momentum Realty here in Northeast Florida. I'm reaching out because I noticed your home on [Street Address] was recently on the market and the listing came off without selling. I know that's not what you were hoping for, and I just wanted to reach out personally — not to pitch you, but to have an honest conversation about what might have gotten in the way and whether there's a better path forward. Do you have just a couple of minutes?"

─────────────────────────────────────────────────
TRANSITION / BRIDGE

"I appreciate that. We work with a lot of sellers in your area, and honestly, when a listing expires it's almost never the property — it's usually the strategy. Pricing, presentation, marketing reach, or some combination. What we do differently is take a data-driven approach before we ever go to market, and our team has a strong track record of getting homes sold that didn't sell the first time. I'd love to learn a little more about your situation and share what we're seeing in your specific area right now. Can I ask you a few quick questions?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

OBJECTION 1 — "I'm not interested in listing again right now."
"That's completely fair — going through a listing that didn't sell is exhausting. I'm not asking you to jump back in tomorrow. I just want to understand what happened and give you a clearer picture of what the market is doing now. Even if you wait six months, that information will serve you. Would it be okay if we just talked for a few minutes?"

OBJECTION 2 — "I already have another agent lined up."
"That's great — I'm glad you have a plan. I'll respect that completely. The only thing I'd ask is, before you sign anything, make sure you've had a chance to compare approaches. After a listing expires, the way you re-enter the market really matters. If you ever want a second opinion, even just as a gut check, I'm happy to be that resource."

OBJECTION 3 — "The market is bad. I'll just wait."
"I hear that a lot, and it's worth thinking through — but in Northeast Florida specifically, we're still seeing motivated buyers active in certain price points and neighborhoods. The market isn't one-size-fits-all. What I'd want to do is show you exactly what's happened in your zip code over the last 90 days — what sold, what didn't, and why. Would that be worth 20 minutes?"

─────────────────────────────────────────────────
DISCOVERY — LPMAMAB

  L — Location: "Just so I'm looking at the right comps — is the property still at [address], or have there been any changes to what you'd be selling?"

  P — Price: "When you listed before, what were you hoping to net out of the sale? And looking back, do you feel the price was right, or do you think that played a role in it not selling?"

  M — Motivation: "When you originally listed, what was driving the timing? Is that same motivation still there, or has your situation changed since then?"

  A — Agent: "Without getting into the details — what do you feel was missing from your last experience? Was it communication, marketing, the price strategy, something else?"

  M — Mortgage: "Do you have an existing mortgage on the property, or do you own it free and clear? I ask because that affects what flexibility you have on price and timing."

  A — Appointment: "Based on everything you've told me, I think it'd be worth 20 to 30 minutes to sit down and show you exactly what we'd do differently. Would [Day] or [Day] work better — morning or afternoon?"

  B — Buy: "Once this home sells, what's the plan — are you moving within the area, relocating, or is this more of an investment situation?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
"Perfect. I'll send you a confirmation right now with my contact info. Before we meet, I'm going to pull a full market analysis specific to your address so we're not guessing — we'll have real numbers in front of us. I'll see you [Day] at [Time]. Thanks for giving us a shot, [Name]."

If not ready:
"No pressure at all. I'll send you a quick market snapshot for your neighborhood so you have something useful regardless of what you decide. And if it's okay, I'd like to check back in with you in a few weeks — just to see if anything's shifted. What's the best way to reach you, email or text?"

─────────────────────────────────────────────────`;

  const distressedScript = `DISTRESSED PROPERTY SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING

"Hi, is this [Owner's Name]? My name is [Your Name] — I'm with Brothers Group at Momentum Realty in Northeast Florida. I'm calling about your property over on [Street Address]. We work closely with a group of investors and buyers who are specifically looking for properties in that area, including homes that may need some work or updating. I'm not sure if selling is something you're thinking about, but properties like yours are actually in high demand right now with a certain type of buyer. Do you have just a minute?"

─────────────────────────────────────────────────
TRANSITION / BRIDGE

"What I've found is that a lot of owners in your situation assume they'd have to do a ton of repairs before they could sell — and that's just not the case anymore. We have buyers and investors who want properties as-is. They handle everything after closing. No repairs, no hassle. My job is just to figure out if there's a number that makes sense for you and connect the right party. Can I ask you a few questions about the property?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

OBJECTION 1 — "The house needs a lot of work. Nobody would want it."
"That's actually exactly why I'm calling. Our investors aren't looking for move-in ready — they're looking for properties with potential, and yours fits that profile. The condition isn't a problem for them. What matters is the location, the lot, and the numbers. You might be surprised what the number looks like."

OBJECTION 2 — "I'm not looking to give it away."
"Completely understood — and that's not what we're proposing. What we do is look at what the property could be worth after updates, work backward from there, and make sure the offer reflects a fair deal for you. You'd know exactly how we arrived at the number. If it doesn't make sense, no hard feelings — but at least you'd have a real offer to compare against."

OBJECTION 3 — "I need to talk to my family first."
"That makes total sense — a decision like this should involve everyone with a stake. What I'd suggest is let's set up a brief conversation, no pressure, where I can walk everyone through what we're seeing in the market and what an offer might look like. That way your family has actual numbers to discuss, not just a general idea. Would it be easier to do that when everyone's available?"

─────────────────────────────────────────────────
DISCOVERY — LPMAMAB

  L — Location: "Just to make sure I have the right property — is [address] the only structure, or are there additional lots or buildings on that same site?"

  P — Price: "I don't want to waste your time with numbers that don't work for you — do you have a ballpark in mind of what you'd need to walk away feeling good about the sale?"

  M — Motivation: "Has selling been on your radar at all, or is this more of a 'right number would change my mind' situation? Just want to understand where you're coming from."

  A — Agent: "Have you spoken with any other agents or investors about the property? I just want to know what you've already heard so I'm not repeating things."

  M — Mortgage: "Is there a mortgage or any liens on the property, or do you own it outright? That helps me understand how much flexibility we're working with."

  A — Appointment: "I'd love to take a quick look at the property in person — even just a 15-minute walk-through. Would [Day] or [Day] work for you? I'll come to you."

  B — Buy: "Once this property is off your plate, do you have plans for the proceeds — investing in something else, or just simplifying things?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
"Great — I'll be there [Day] at [Time]. I'll do some homework on the property before I come so I'm not walking in blind. I'll have a realistic range ready to discuss. No paperwork, no pressure — just a conversation with real numbers. Thanks, [Name], I'll see you then."

If not ready:
"No problem at all. I'll put together a quick profile of what similar properties in your area have sold for recently, including some as-is sales to investors, and send it your way. That'll give you a baseline to think about. What's the best email or number to reach you?"

─────────────────────────────────────────────────`;

  const landScript = `LAND LEAD SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────

OPENING

"Hi, is this [Owner's Name]? My name is [Your Name] with Brothers Group at Momentum Realty in Northeast Florida. I'm reaching out because your name came up in connection with a parcel of vacant land over on [Parcel Address / Cross Streets]. I work with a lot of land buyers and developers in this region, and I just wanted to touch base — I'm not sure if selling that parcel is something you've thought about, but I've been seeing real activity in that corridor lately and wanted to give you a heads-up. Do you have just a minute?"

─────────────────────────────────────────────────
TRANSITION / BRIDGE

"I appreciate it. Here's where I'm coming from — Northeast Florida land has been moving in a way I haven't seen in a while. Developers, investors, and private buyers are actively looking for parcels, and a lot of landowners haven't revisited what their land is actually worth in today's market. I'm not here to pressure you into anything — I just think you deserve to know what's going on around you and what options might be on the table. Can I ask you a few questions about the parcel?"

─────────────────────────────────────────────────
COMMON OBJECTIONS

OBJECTION 1 — "I'm holding onto it as an investment."
"That's a smart approach — land can be a great long-term hold. The question I'd gently push back on is: are you holding because you believe it'll appreciate more, or because selling just hasn't been top of mind? In some areas right now, the appreciation people expected over five to ten years has already happened in the last two. I'm not saying sell — I'm saying let's make sure your decision is based on current data, not old assumptions."

OBJECTION 2 — "I don't even know much about the parcel."
"That's more common than you'd think — a lot of owners have land they inherited or bought years ago and haven't revisited. That's actually where we can help. We can pull the county records, give you the parcel details, zoning, utilities access, and a real picture of what it's worth. No cost, no obligation. Would it help just to know what you're actually sitting on?"

OBJECTION 3 — "Someone else already approached me about it."
"That's good to hear — it means the market is active around your parcel. The only thing I'd make sure of is that whoever approached you is giving you a fair number. A lot of direct buyer offers lowball because the owner doesn't have representation. We'd want to make sure you have the full picture before making any decisions. Would you be open to a quick comparison?"

─────────────────────────────────────────────────
DISCOVERY — LPMAMAB

  L — Location: "Just to confirm I'm looking at the right parcel — is it [address / cross streets], and roughly how large is it? Acreage, frontage, anything you remember?"

  P — Price: "Have you had any sense of what the parcel might be worth today, or has it been a while since you looked at that?"

  M — Motivation: "What was the original plan when you acquired it — build on it, hold it, or was it more of an opportunistic buy at the time?"

  A — Agent: "Has anyone else reached out about it recently — agents, investors, developers? I just want to know if you're in the middle of something or if this is a fresh conversation."

  M — Mortgage: "Is there any debt tied to the parcel, or is it owned free and clear? That's helpful when we look at what makes sense financially."

  A — Appointment: "What I'd love to do is pull a full land comps report for your area and walk you through it — in person or over the phone, whatever's easier. Would [Day] or [Day] work for a quick 20-minute call or meeting?"

  B — Buy: "If you did decide to sell, would you be looking to reinvest in other land or property, or would this be more of a liquidity event?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
"Perfect. I'll pull the county parcel data and run comps before we meet so you're not walking in blind. It'll be 20 minutes and you'll walk away with a much clearer picture of where you stand. I'll see you [Day] at [Time] — confirmation coming your way now. Thanks, [Name]."

If not ready:
"No problem — I appreciate you taking the call. I'll put together a quick land market summary for your area and send it your way. No pitch, just information. What's the best way to get that to you — email or text?"

─────────────────────────────────────────────────`;

  const websiteLeadScript = `WEBSITE LEAD SCRIPT
Brothers Group at Momentum Realty
─────────────────────────────────────────────────
LEAD SOURCE: MotivatedSellers.com — Inbound Seller Inquiry
TYPE: Motivated Seller (they reached out to us)

─────────────────────────────────────────────────
OPENING

"Hi, is this [Owner's Name]? This is [Your Name] calling from Brothers Group at Momentum Realty — I'm following up because you submitted your property info through our website a little while ago. Thank you for reaching out — I wanted to make sure I got back to you quickly because these situations move fast and I didn't want you waiting around. Is now a decent time to talk for a few minutes?"

─────────────────────────────────────────────────
TRANSITION / BRIDGE

"Great. So you reached out through our site, which tells me you're at least considering your options — and I want to make sure I understand exactly where you're at and what would be most helpful. We work with sellers across Northeast Florida, and whether you want to sell fast, sell for top dollar, or just explore what's possible, we can walk you through all of it. I just want to ask you a few quick questions so I can point you in the right direction."

─────────────────────────────────────────────────
COMMON OBJECTIONS

OBJECTION 1 — "I was just browsing, I'm not sure I'm ready to sell."
"That's totally fine — and that's exactly what the site is there for. A lot of people just want to see what their home might be worth before making any decisions, and that's smart. There's no commitment involved. What I can do is give you a real picture of where your home sits in today's market — no pressure, just useful information. Would that help?"

OBJECTION 2 — "I want to try selling it myself first."
"I respect that — FSBOs can work. What I'd encourage is at least having a conversation with us before you go that route. There are a few things we're seeing right now on buyer activity and pricing in your area that could actually help you even if you go on your own. And if after talking you still want to try it yourself, at least you'll have better data. Fair enough?"

OBJECTION 3 — "I'm not in a rush."
"Good — that actually puts you in a stronger position. The sellers who get the best results are usually the ones who aren't desperate to close by next week. If you've got time, we can be more strategic about how we go to market. Let me ask you a few questions to understand your timeline and what outcome looks best for you."

─────────────────────────────────────────────────
DISCOVERY — LPMAMAB

  L — Location: "Tell me about the property — what's the address, and is it your primary home, a rental, or something else?"

  P — Price: "Do you have a number in mind that you'd want to walk away with, or are you still figuring that out based on what the market says?"

  M — Motivation: "What prompted you to reach out now — is there a specific timeline driving this, or are you more open-ended at this point?"

  A — Agent: "Are you currently working with anyone else, or is Brothers Group the first team you've connected with?"

  M — Mortgage: "Roughly, do you know what you owe on the property? That helps me understand what you'd net and whether the timing makes financial sense for you."

  A — Appointment: "I'd love to come by, take a look, and give you a real number — not an algorithm estimate, but an actual market analysis based on your specific home. Would [Day] or [Day] work for a 30-minute visit?"

  B — Buy: "After the sale, are you planning to buy something else in the area, or are you heading in a different direction?"

─────────────────────────────────────────────────
CLOSE

If appointment set:
"Perfect — I'll confirm that right now with a text so you have my contact info. Before I come out I'll pull your address and do prep work so we're using our time efficiently. Expect a full market analysis when I arrive — something specific to your home, not a generic estimate. Looking forward to meeting you, [Name]. I'll see you [Day] at [Time]."

If not ready:
"Understood — and I'm glad you reached out, even just to start the conversation. I'll send over a current market report for your neighborhood so you have something to look at on your own time. Whenever you're ready to take the next step, I'm here. Do you prefer text or email going forward?"

─────────────────────────────────────────────────`;

  initScript("expired", expiredScript);
  initScript("distressed", distressedScript);
  initScript("land", landScript);
  initScript("website_lead", websiteLeadScript);

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




  // SETTINGS — global lead flow toggle
  app.get("/api/settings/lead-flow", (req, res) => {
    const val = storage.getSetting("lead_flow_active");
    res.json({ active: val !== "false" });
  });

  app.post("/api/settings/lead-flow", (req, res) => {
    const { active } = req.body;
    if (typeof active !== "boolean") return res.status(400).json({ error: "Missing active boolean" });
    storage.setSetting("lead_flow_active", active ? "true" : "false");
    res.json({ active });
  });

  // AGENT TOGGLE — activate / deactivate individual agent lead flow
  app.post("/api/agents/:id/toggle-active", (req, res) => {
    const id = parseInt(req.params.id);
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const newActive = !agent.isActive;
    const updated = storage.updateAgent(id, { isActive: newActive });
    res.json({ ...updated, password: undefined });
  });

  return httpServer;
}
