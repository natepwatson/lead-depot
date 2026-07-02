import { createRequire } from "node:module";
import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { rawDb } from "./db";
import { Resend } from "resend";
import { broadcast } from "./ws";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Source label map
const SOURCE_LABELS: Record<string, string> = {
  expired: "Expired Listing",
  distressed: "Distressed Property",
  website_lead: "Website / Network Lead",
  fsbo: "FSBO",
  land: "Land Lead",
};

async function sendCrmReport(opts: {
  outcome: string;       // "contacted_appointment" | "keep_in_touch"
  agentName: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  address: string;           // original lead address
  confirmedAddress: string;  // agent-confirmed address
  addressMatch: boolean;     // true if confirmed == original
  stage: string;
  source: string;
  intention: string;
  notes: string;
  // Appt-only
  apptDate?: string;
  apptTime?: string;
  apptEmail?: string;        // client email captured at appt modal
}) {
  if (!resend) return;
  const isAppt = opts.outcome === "contacted_appointment";
  const label  = isAppt ? "Appointment Set" : "Follow Up Boss Entry";
  const emoji  = isAppt ? "🏠" : "📋";
  const subject = isAppt
    ? `BGRE NEW LEAD: Follow Up Boss Entry/Appt — ${opts.ownerName} | ${opts.confirmedAddress || opts.address}`
    : `BGRE NEW LEAD: Follow Up Boss Entry — ${opts.ownerName} | ${opts.confirmedAddress || opts.address}`;

  const displayAddress = opts.confirmedAddress || opts.address || "—";
  const addressNote    = opts.confirmedAddress && opts.address && opts.confirmedAddress !== opts.address
    ? `<span style="color:#f87171;font-size:11px;margin-left:8px">⚠️ differs from original: ${opts.address}</span>`
    : `<span style="color:#6ee7b7;font-size:11px;margin-left:8px">✓ confirmed</span>`;

  // Next step row
  const nextStep = isAppt
    ? `Appointment on ${opts.apptDate || "—"} at ${opts.apptTime || "—"} — add to FUB calendar`
    : `Keep in Touch — add to nurture sequence in FUB`;

  // Appt section (only shown for APPT)
  const apptSection = isAppt ? `
    <tr><td colspan="2" style="padding:16px 0 6px;font-size:11px;color:#c8aa5a;text-transform:uppercase;letter-spacing:.12em;border-top:1px solid #222;font-weight:700">Appointment Details</td></tr>
    <tr><td style="${tdL}">Date</td><td style="${tdR}">${opts.apptDate || "—"}</td></tr>
    <tr><td style="${tdL}">Time</td><td style="${tdR}">${opts.apptTime || "—"}</td></tr>
    <tr><td style="${tdL}">With Agent</td><td style="${tdR}">${opts.agentName}</td></tr>
    <tr><td style="${tdL}">Client Email</td><td style="${tdR}">${opts.apptEmail || opts.ownerEmail || "—"}</td></tr>
  ` : "";

  const tdL = "padding:9px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:160px;vertical-align:top";
  const tdR = "padding:9px 0;font-size:14px;color:#f0f0f0;vertical-align:top";

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:620px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid #2a2520">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%);padding:26px 32px">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5a3e00;font-weight:700">CRM Report — Brothers Group at Momentum Realty</p>
    <h1 style="margin:0;font-size:22px;color:#080808;font-weight:700">BGRE NEW LEAD: ${label}</h1>
    <p style="margin:6px 0 0;font-size:13px;color:#3a2800">Logged by ${opts.agentName}</p>
  </div>

  <!-- Body -->
  <div style="padding:28px 32px">

    <!-- Client Info -->
    <p style="margin:0 0 12px;font-size:11px;color:#c8aa5a;text-transform:uppercase;letter-spacing:.12em;font-weight:700">Client Information</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="${tdL}">Name</td><td style="${tdR}">${opts.ownerName}</td></tr>
      <tr><td style="${tdL}">Phone</td><td style="${tdR}">${opts.ownerPhone || "—"}</td></tr>
      <tr><td style="${tdL}">Email</td><td style="${tdR}">${opts.ownerEmail || "—"}</td></tr>
      <tr><td style="${tdL}">Address</td><td style="${tdR}">${displayAddress}${addressNote}</td></tr>

      <!-- Lead Details -->
      <tr><td colspan="2" style="padding:16px 0 6px;font-size:11px;color:#c8aa5a;text-transform:uppercase;letter-spacing:.12em;border-top:1px solid #222;font-weight:700">Lead Details</td></tr>
      <tr><td style="${tdL}">Stage</td><td style="${tdR}">${opts.stage || "—"}</td></tr>
      <tr><td style="${tdL}">Source</td><td style="${tdR}">${opts.source || "—"}</td></tr>
      <tr><td style="${tdL}">Client Intention</td><td style="${tdR}">${opts.intention || "—"}</td></tr>
      <tr><td style="${tdL}">Notes</td><td style="${tdR}">${opts.notes || "—"}</td></tr>

      ${apptSection}

      <!-- Next Step -->
      <tr><td colspan="2" style="padding:16px 0 6px;font-size:11px;color:#c8aa5a;text-transform:uppercase;letter-spacing:.12em;border-top:1px solid #222;font-weight:700">Next Step for FUB</td></tr>
      <tr><td colspan="2" style="padding:9px 0;font-size:14px;color:#f0f0f0">${nextStep}</td></tr>
    </table>
  </div>

  <!-- Footer -->
  <div style="padding:14px 32px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444;display:flex;justify-content:space-between">
    <span>Lead Depot v11.19 — Brothers Group · Momentum Realty</span>
  </div>
</div>
</body>
</html>`;

  await resend.emails.send({
    from:    "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:      ["djacobs312@gmail.com"],
    cc:      ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
    subject,
    html,
  });
}

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

  // Soft-delete: mark agent as trashed, redistribute their active leads via round-robin as if freshly uploaded
  app.delete("/api/agents/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateAgent(id, { isActive: false, leadFlowOn: false, receiveWebsiteLeads: false });
    if (!updated) return res.status(404).json({ error: "Agent not found" });

    const ACTIVE = ["assigned", "no_answer", "keep_in_touch", "callback_requested"];
    const allLeads = storage.getAllLeads();
    let repooled = 0;
    let reassigned = 0;

    for (const lead of allLeads) {
      if (lead.assignedAgentId !== id || !ACTIVE.includes(lead.status)) continue;
      repooled++;

      // Try to immediately assign to the next agent in rotation (same as fresh upload)
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        storage.updateLead(lead.id, {
          assignedAgentId: nextAgent.id,
          status: "assigned",
        });
        storage.updateRoundRobinState(nextAgent.id);
        reassigned++;
      } else {
        // No active agents available — park as unassigned so it auto-assigns when next agent activates
        storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
      }
    }

    broadcast({ type: "leads_updated" });
    res.json({ ...updated, password: undefined, repooled, reassigned });
  });

  // Reactivate a trashed agent
  app.patch("/api/agents/:id/reactivate", (req, res) => {
    const id = parseInt(req.params.id);
    const updated = storage.updateAgent(id, { isActive: true, leadFlowOn: true });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Admin: redistribute all currently unassigned leads via round-robin (fixes orphaned leads after deactivations)
  app.post("/api/admin/redistribute-unassigned", (req, res) => {
    const allLeads = storage.getAllLeads();
    const unassigned = allLeads.filter(l => l.status === "unassigned" || (!l.assignedAgentId && l.status !== "contacted_not_interested" && l.status !== "contacted_appointment" && l.status !== "wrong_number"));
    let reassigned = 0;
    let skipped = 0;
    for (const lead of unassigned) {
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
        storage.updateRoundRobinState(nextAgent.id);
        reassigned++;
      } else {
        skipped++;
      }
    }
    broadcast({ type: "leads_updated" });
    res.json({ total: unassigned.length, reassigned, skipped });
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
  app.post("/api/leads/:id/outcome", async (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, outcome, notes, lpmamab, callbackDate,
            apptEmail, confirmedAddress, apptDate, apptTime, stage, intention } = req.body;

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
      // Insert activity directly via rawDb to avoid FK constraint issues on delete
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(leadId, agentId || null, outcome, notes || null, new Date().toISOString());
      // Delete activities first to satisfy FK constraint, then delete lead
      rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
      storage.deleteLead(leadId);
      broadcast({ type: "lead_deleted", leadId });
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

    // Log activity — merge appt/kit details into snapshot
    const snapshotData = {
      ...(lpmamab || {}),
      ...(apptDate       ? { apptDate }       : {}),
      ...(apptTime       ? { apptTime }        : {}),
      ...(stage          ? { stage }           : {}),
      ...(intention      ? { intention }       : {}),
      ...(confirmedAddress ? { confirmedAddress } : {}),
      ...(apptEmail      ? { apptEmail }       : {}),
    };
    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome,
      notes: notes || null,
      lpmamabSnapshot: Object.keys(snapshotData).length ? JSON.stringify(snapshotData) : null,
      createdAt: new Date().toISOString(),
    });

    // ── CRM Report — send immediately for KIT and APPT outcomes ───────────
    if (outcome === "keep_in_touch" || outcome === "contacted_appointment") {
      const agent = storage.getAgentById(agentId);
      sendCrmReport({
        outcome,
        agentName:        agent?.name || "Unknown Agent",
        ownerName:        lead.ownerName || "—",
        ownerPhone:       lead.phone || "—",
        ownerEmail:       apptEmail || lead.email || "—",
        address:          lead.address || "—",
        confirmedAddress: confirmedAddress || lead.address || "—",
        addressMatch:     !confirmedAddress || confirmedAddress === lead.address,
        stage:            stage || "—",
        source:           lead.source || "—",
        intention:        intention || "—",
        notes:            notes || "—",
        apptDate:         apptDate || undefined,
        apptTime:         apptTime || undefined,
        apptEmail:        apptEmail || undefined,
      }).catch(err => console.error("CRM report email failed:", err));
    }

    res.json(updatedLead);
  });

  // ─── OUTCOME REPORT ──────────────────────────────────────────────────────
  app.get("/api/reports/outcomes", (req, res) => {
    const allLeads = rawDb.prepare(`SELECT * FROM leads`).all();
    const allAgents = storage.getAllAgents();
    const agentMap: Record<number, string> = {};
    allAgents.forEach((a: any) => { agentMap[a.id] = a.name; });

    const allActivities = rawDb.prepare(`SELECT * FROM lead_activity ORDER BY created_at DESC`).all();

    // Build lead map for quick lookup
    const leadMap: Record<number, any> = {};
    allLeads.forEach((l: any) => { leadMap[l.id] = l; });

    const outcomeLabels: Record<string, string> = {
      contacted_appointment: "Appointment Set",
      keep_in_touch: "Keep in Touch",
      callback_requested: "Callback",
      no_answer: "No Answer",
      contacted_not_interested: "Not Interested",
      wrong_number: "Wrong Number",
      recycled: "Recycled",
      email_sent: "Email Sent",
    };

    // Group activities by outcome
    const grouped: Record<string, any[]> = {};
    allActivities.forEach((act: any) => {
      const label = outcomeLabels[act.outcome] || act.outcome;
      if (!grouped[label]) grouped[label] = [];
      let snapshot: any = {};
      try { snapshot = JSON.parse(act.lpmamab_snapshot || "{}"); } catch {}
      const lead = leadMap[act.lead_id];
      grouped[label].push({
        activityId: act.id,
        leadId: act.lead_id,
        ownerName: lead?.owner_name || "—",
        address: lead?.address || "—",
        phone: lead?.phone || "—",
        agent: agentMap[act.agent_id] || "—",
        notes: act.notes || "—",
        date: act.created_at,
        apptDate: snapshot.apptDate || null,
        apptTime: snapshot.apptTime || null,
        stage: snapshot.stage || null,
        intention: snapshot.intention || null,
        confirmedAddress: snapshot.confirmedAddress || null,
        apptEmail: snapshot.apptEmail || null,
        callbackDate: lead?.callback_date || null,
      });
    });

    const summary = Object.entries(grouped).map(([label, items]) => ({
      outcome: label,
      count: items.length,
      entries: items,
    })).sort((a, b) => b.count - a.count);

    res.json({ generatedAt: new Date().toISOString(), summary });
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


  // ─── EMAIL SENT TRACKING ─────────────────────────────────────────────────
  app.post("/api/leads/:id/email-sent", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId } = req.body;
    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome: "email_sent",
      notes: null,
      lpmamabSnapshot: null,
      createdAt: new Date().toISOString(),
    });
    res.json({ logged: true });
  });

  // ─── ADMIN: PER-AGENT STATS ───────────────────────────────────────────────
  app.get("/api/admin/agent-stats", (req, res) => {
    // Load leaderboard reset timestamp
    const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
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

      const emailsSent = agentActs.filter(a => a.outcome === "email_sent").length;
      // Exclude email_sent from call attempt count
      const totalAttempts = agentActs.filter(a => a.outcome !== "email_sent").length;
      const contactRate = totalAttempts > 0
        ? Math.round(((outcomes.contacted_appointment + outcomes.contacted_not_interested + outcomes.keep_in_touch) / totalAttempts) * 100)
        : 0;

      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        leadsReceived: agentLeads.length,
        activeLeads: agentLeads.filter(l => ["assigned","no_answer","keep_in_touch","callback_requested"].includes(l.status)).length,
        appointmentsSet: outcomes.contacted_appointment,
        totalAttempts,
        emailsSent,
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
    const exists = rawDb.prepare("SELECT id FROM scripts WHERE lead_type = ?").get(leadType);
    if (!exists) {
      rawDb.prepare("INSERT INTO scripts (lead_type, content, updated_at) VALUES (?, ?, ?)").run(leadType, defaultContent, new Date().toISOString());
    }
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
    const row = rawDb.prepare("SELECT * FROM scripts WHERE lead_type = ?").get(leadType);
    if (!row) return res.status(404).json({ error: "Script not found" });
    res.json({ leadType: row.lead_type, content: row.content, updatedAt: row.updated_at });
  });

  app.get("/api/scripts", (req, res) => {
    const rows = rawDb.prepare("SELECT lead_type, updated_at FROM scripts").all();
    res.json(rows);
  });

  app.patch("/api/scripts/:type", (req, res) => {
    const leadType = req.params.type;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "Missing content" });
    const now = new Date().toISOString();
    rawDb.prepare("UPDATE scripts SET content = ?, updated_at = ? WHERE lead_type = ?").run(content, now, leadType);
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

  // ─── MY PIPELINE (callbacks + KIT, 60-day window) ────────────────────────
  app.get("/api/leads/my-pipeline/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString();

    const allLeads = storage.getAllLeads().filter((l: any) =>
      l.assignedAgentId === agentId &&
      (l.status === "callback_requested" || l.status === "keep_in_touch" || l.status === "contacted_appointment") &&
      l.uploadedAt >= cutoffStr
    );

    // Enrich with last activity notes
    const enriched = allLeads.map((l: any) => {
      const acts = storage.getActivitiesForLead(l.id);
      const lastAct = acts.length > 0 ? acts[acts.length - 1] : null;
      return {
        ...l,
        lastNote: lastAct?.notes || null,
        activityCount: acts.filter((a: any) => a.outcome !== "email_sent").length,
        emailCount: acts.filter((a: any) => a.outcome === "email_sent").length,
      };
    });

    const callbacks = enriched
      .filter((l: any) => l.status === "callback_requested")
      .sort((a: any, b: any) => (a.callbackDate || "").localeCompare(b.callbackDate || ""));

    const kitLeads = enriched
      .filter((l: any) => l.status === "keep_in_touch")
      .sort((a: any, b: any) => b.uploadedAt.localeCompare(a.uploadedAt));

    const appointments = enriched
      .filter((l: any) => l.status === "contacted_appointment")
      .sort((a: any, b: any) => b.uploadedAt.localeCompare(a.uploadedAt));

    res.json({ callbacks, kitLeads, appointments });
  });

  // ─── RECYCLE LEAD ──────────────────────────────────────────────────────────
  // Agent connected but believes another agent can do better.
  // Removes assignment claim, returns lead to pool for round-robin reassignment.
  app.post("/api/leads/:id/recycle", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, notes } = req.body;
    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Log the recycle — still counts as a dial attempt
    storage.logActivity({
      leadId,
      agentId: agentId || null,
      outcome: "recycled",
      notes: notes || "Lead recycled — returned to pool for reassignment.",
      createdAt: new Date().toISOString(),
    });

    // Unassign and bump attempt count
    storage.updateLead(leadId, {
      assignedAgentId: null,
      status: "unassigned",
      attemptCount: (lead.attemptCount || 0) + 1,
    });

    // Immediately reassign via round-robin
    const nextAgent = storage.getNextAgentInRotation(lead.leadType);
    if (nextAgent) {
      storage.updateLead(leadId, { assignedAgentId: nextAgent.id, status: "assigned" });
      storage.updateRoundRobinState(nextAgent.id);
    }

    broadcast({ type: "lead_updated", leadId });
    res.json({ recycled: true, reassignedTo: nextAgent?.name || null });
  });

  // ─── LEADERBOARD RESET ────────────────────────────────────────────────────
  app.post("/api/admin/leaderboard-reset", (req, res) => {
    const now = new Date().toISOString();
    rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now);
    res.json({ ok: true, resetAt: now });
  });

  app.get("/api/admin/leaderboard-reset", (req, res) => {
    const row = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    res.json({ resetAt: row?.value || null });
  });

  // ─── AGENT-FACING LEADERBOARD (no admin-only data) ────────────────────────
  app.get("/api/agent/leaderboard", (req, res) => {
    const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
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
      const emailsSent = agentActs.filter((a: any) => a.outcome === "email_sent").length;
      const total = agentActs.filter((a: any) => a.outcome !== "email_sent").length;
      const contacted = agentActs.filter((a: any) => ["contacted_appointment","contacted_not_interested"].includes(a.outcome)).length;
      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        appointmentsSet: appts,
        totalAttempts: total,
        emailsSent,
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
    broadcast({ type: "lead_created", leadId: created.id, assignedAgentId: submitterAgentId });
    res.json({ created: true, leadId: created.id });
  });

  // ─── REFERRALS (agent refers a person to join the team) ───────────────────
  app.post("/api/referrals", (req, res) => {
    const { name, phone, email, brokerage, notes, referredBy, referredByName } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });
    const now = new Date().toISOString();
    const info = rawDb.prepare(
      `INSERT INTO referrals (name, phone, email, brokerage, notes, referred_by, referred_by_name, created_at) VALUES (?,?,?,?,?,?,?,?)`
    ).run(name, phone, email || "", brokerage || "", notes || "", referredBy || null, referredByName || "", now);
    res.json({ created: true, id: info.lastInsertRowid });
  });

  // ─── ADMIN: VIEW REFERRALS ─────────────────────────────────────────────────
  app.get("/api/referrals", (req, res) => {
    const rows = rawDb.prepare(`SELECT * FROM referrals ORDER BY created_at DESC`).all();
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

// ─── DAILY DIGEST EMAIL ────────────────────────────────────────────────────────
async function sendDailyDigest() {
  if (!resend) {
    console.log("[digest] RESEND_API_KEY not set — skipping digest");
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const startOfDay = `${todayStr}T00:00:00`;
  const endOfDay   = `${todayStr}T23:59:59`;

  const activities: any[] = rawDb.prepare(
    `SELECT la.*, a.name as agentName FROM lead_activity la
     LEFT JOIN agents a ON a.id = la.agent_id
     WHERE la.created_at >= ? AND la.created_at <= ?`
  ).all(startOfDay, endOfDay);

  const newLeadsToday: number = rawDb.prepare(
    `SELECT COUNT(*) as cnt FROM leads WHERE uploaded_at >= ? AND uploaded_at <= ?`
  ).get(startOfDay, endOfDay)?.cnt ?? 0;

  const agents2: any[] = rawDb.prepare(
    `SELECT * FROM agents WHERE role = 'agent' AND is_active = 1`
  ).all();

  const agentStats = agents2.map((agent: any) => {
    const agentActs  = activities.filter((a: any) => a.agent_id === agent.id);
    const dials      = agentActs.filter((a: any) => a.outcome !== "email_sent").length;
    const emails     = agentActs.filter((a: any) => a.outcome === "email_sent").length;
    const appts      = agentActs.filter((a: any) => a.outcome === "contacted_appointment").length;
    const kit        = agentActs.filter((a: any) => a.outcome === "keep_in_touch").length;
    const notInt     = agentActs.filter((a: any) => a.outcome === "contacted_not_interested").length;
    const contactRate = dials > 0 ? Math.round(((appts + kit + notInt) / dials) * 100) : 0;
    return { name: agent.name, dials, emails, appts, kit, contactRate };
  }).filter((s: any) => s.dials > 0 || s.emails > 0);

  const totalDials  = agentStats.reduce((s: number, a: any) => s + a.dials, 0);
  const totalAppts  = agentStats.reduce((s: number, a: any) => s + a.appts, 0);
  const totalEmails = agentStats.reduce((s: number, a: any) => s + a.emails, 0);
  const totalKIT    = agentStats.reduce((s: number, a: any) => s + a.kit, 0);

  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
  });

  const agentRows = agentStats.length > 0
    ? agentStats
        .sort((a: any, b: any) => b.appts - a.appts || b.dials - a.dials)
        .map((a: any) => `
      <tr style="border-bottom:1px solid rgba(200,170,90,0.1)">
        <td style="padding:10px 14px;font-size:13px;color:#f0f0f0">${a.name}</td>
        <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#86efac;text-align:center">${a.appts}</td>
        <td style="padding:10px 14px;font-size:13px;color:#c8aa5a;text-align:center">${a.kit}</td>
        <td style="padding:10px 14px;font-size:13px;color:#fff;text-align:center">${a.dials}</td>
        <td style="padding:10px 14px;font-size:13px;color:#fbcfe8;text-align:center">${a.emails}</td>
        <td style="padding:10px 14px;font-size:13px;color:#67e8f9;text-align:center">${a.contactRate}%</td>
      </tr>`).join("")
    : `<tr><td colspan="6" style="padding:20px;text-align:center;color:rgba(255,255,255,0.3);font-size:13px">No activity logged today</td></tr>`;

  const html = `
<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:0 auto;background:#0c0c0c;color:#f0f0f0;border-radius:14px;overflow:hidden;border:1px solid rgba(200,170,90,0.25)">
  <div style="background:linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%);padding:28px 32px">
    <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(0,0,0,0.55);margin-bottom:6px">Brothers Group at Momentum Realty</div>
    <h1 style="margin:0;font-size:24px;color:#080808;font-weight:700">Daily Results</h1>
    <p style="margin:5px 0 0;font-size:13px;color:rgba(0,0,0,0.6)">${dateLabel}</p>
  </div>
  <div style="display:flex;border-bottom:1px solid rgba(200,170,90,0.15)">
    <div style="flex:1;padding:20px 12px;text-align:center;border-right:1px solid rgba(200,170,90,0.1)">
      <div style="font-size:30px;font-weight:700;color:#86efac">${totalAppts}</div>
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-top:5px">Appts Set</div>
    </div>
    <div style="flex:1;padding:20px 12px;text-align:center;border-right:1px solid rgba(200,170,90,0.1)">
      <div style="font-size:30px;font-weight:700;color:#c8aa5a">${totalKIT}</div>
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-top:5px">Keep in Touch</div>
    </div>
    <div style="flex:1;padding:20px 12px;text-align:center;border-right:1px solid rgba(200,170,90,0.1)">
      <div style="font-size:30px;font-weight:700;color:#fff">${totalDials}</div>
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-top:5px">Total Dials</div>
    </div>
    <div style="flex:1;padding:20px 12px;text-align:center">
      <div style="font-size:30px;font-weight:700;color:#fbcfe8">${totalEmails}</div>
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-top:5px">Emails Sent</div>
    </div>
  </div>
  <div style="padding:13px 24px;background:rgba(200,170,90,0.06);border-bottom:1px solid rgba(200,170,90,0.1);font-size:13px;color:rgba(255,255,255,0.55)">
    <span style="color:#c8aa5a;font-weight:600">${newLeadsToday} new lead${newLeadsToday !== 1 ? "s" : ""}</span> added to the pool today
  </div>
  <div style="padding:24px 0 8px">
    <div style="padding:0 24px 12px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(200,170,90,0.55);font-weight:600">Agent Breakdown</div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:1px solid rgba(200,170,90,0.2)">
          <th style="padding:8px 14px;text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">Agent</th>
          <th style="padding:8px 14px;text-align:center;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">Appts</th>
          <th style="padding:8px 14px;text-align:center;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">KIT</th>
          <th style="padding:8px 14px;text-align:center;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">Dials</th>
          <th style="padding:8px 14px;text-align:center;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">Emails</th>
          <th style="padding:8px 14px;text-align:center;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600">Contact%</th>
        </tr>
      </thead>
      <tbody>${agentRows}</tbody>
    </table>
  </div>
  <div style="padding:16px 24px;background:#080808;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:rgba(255,255,255,0.18);display:flex;justify-content:space-between">
    <span>Lead Depot v11.19</span><span>Brothers Group · Momentum Realty</span>
  </div>
</div>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
    subject: `📊 Daily Results — ${dateLabel} — ${totalAppts} Appt${totalAppts !== 1 ? "s" : ""}, ${totalDials} Dials`,
    html,
  });

  console.log(`[digest] Sent — ${totalAppts} appts, ${totalDials} dials, ${agentStats.length} active agents`);
}

// Fires at 5:45 PM EDT = 21:45 UTC every day
function scheduleDailyDigest() {
  function msUntilNext(): number {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(21, 45, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  const delay = msUntilNext();
  console.log(`[digest] Scheduled in ${Math.round(delay / 60000)} min (5:45 PM EDT)`);

  setTimeout(function fire() {
    sendDailyDigest().catch(err => console.error("[digest] Error:", err));
    setTimeout(fire, 24 * 60 * 60 * 1000); // repeat every 24h
  }, delay);
}

scheduleDailyDigest();
