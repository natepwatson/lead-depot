/**
 * Follow Up Boss API Integration — Lead Depot
 * Watson Brothers Group / Brothers Group at Momentum Realty
 *
 * Key rule: ALWAYS use POST /v1/events to send leads — never POST /v1/people.
 * /v1/events triggers Lead Flow, Action Plans, agent assignment, and deduplication.
 */

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_API_KEY = process.env.FUB_API_KEY || "";
const FUB_SYSTEM = "LeadDepot";
// Source names per lead type — these appear as the Lead Source in FUB
const FUB_SOURCE_MAP: Record<string, string> = {
  expired:      "Expired Listing",
  distressed:   "Distressed Property",
  fsbo:         "FSBO",
  land:         "Vacant Land",
  website_lead: "Website Lead",
  network:      "Network Referral",
};

function getFubSource(leadType: string, rawSource?: string): string {
  // If it's a network referral, override regardless of leadType
  if (rawSource?.toLowerCase().includes("network")) return "Network Referral";
  return FUB_SOURCE_MAP[leadType] ?? "Lead Depot";
}

function fubAuth(): string {
  return "Basic " + Buffer.from(FUB_API_KEY + ":").toString("base64");
}

async function fubRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!FUB_API_KEY) {
    console.warn("[FUB] FUB_API_KEY not set — skipping FUB call");
    return { ok: false, status: 0, data: null };
  }

  try {
    const res = await fetch(`${FUB_BASE}${path}`, {
      method,
      headers: {
        Authorization: fubAuth(),
        "Content-Type": "application/json",
        "X-System": FUB_SYSTEM,
        "X-System-Key": FUB_API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch {}

    if (!res.ok) {
      console.error(`[FUB] ${method} ${path} → ${res.status}`, data);
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[FUB] Network error on ${method} ${path}:`, err);
    return { ok: false, status: 0, data: null };
  }
}

// ─── EVENT TYPE MAPPING ────────────────────────────────────────────────────────
// Maps Lead Depot outcome → FUB event type that triggers automations
function outcomeToFubType(outcome: string, leadType: string): string {
  if (outcome === "contacted_appointment") return "Property Inquiry";
  if (outcome === "keep_in_touch") return "General Inquiry";
  if (leadType === "website_lead") return "Registration";
  return "General Inquiry";
}

// ─── STAGE MAPPING ────────────────────────────────────────────────────────────
function outcomeToFubStage(outcome: string): string {
  switch (outcome) {
    case "contacted_appointment":    return "Hot Prospect";
    case "keep_in_touch":           return "Nurture";
    case "contacted_not_interested": return "Unresponsive";
    default:                         return "Lead";
  }
}

// ─── TAG BUILDER ─────────────────────────────────────────────────────────────
function buildTags(leadType: string, outcome: string, source?: string): string[] {
  const tags: string[] = [];

  // Lead type
  const typeMap: Record<string, string> = {
    expired:      "expired-listing",
    distressed:   "distressed",
    website_lead: "website-lead",
    fsbo:         "fsbo",
    land:         "land",
  };
  if (typeMap[leadType]) tags.push(typeMap[leadType]);

  // Outcome
  if (outcome === "contacted_appointment") tags.push("appointment-set");
  if (outcome === "keep_in_touch")        tags.push("kit");

  // Source
  if (source?.toLowerCase().includes("network")) tags.push("network-referral");

  // Geography (NE Florida focus)
  tags.push("ne-florida");

  return tags;
}

// ─── LPMAMAB NOTE BUILDER ─────────────────────────────────────────────────────
function buildLpmamabNote(opts: {
  agentName: string;
  outcome: string;
  notes?: string;
  lpmamab?: {
    location?: string;
    price?: string;
    motivation?: string;
    agent?: string;
    mortgage?: string;
    appointment?: string;
    buy?: string;
  };
  apptDate?: string;
  apptTime?: string;
  stage?: string;
  intention?: string;
  confirmedAddress?: string;
  apptEmail?: string;
  address?: string;
}): string {
  const { agentName, outcome, notes, lpmamab, apptDate, apptTime, stage, intention, confirmedAddress, apptEmail, address } = opts;

  const outcomeLabel: Record<string, string> = {
    contacted_appointment:    "✅ APPOINTMENT SET",
    keep_in_touch:           "📞 KEEP IN TOUCH",
    contacted_not_interested: "❌ NOT INTERESTED",
    no_answer:               "📵 NO ANSWER",
    callback_requested:      "🔁 CALLBACK REQUESTED",
    wrong_number:            "⚠️ WRONG NUMBER",
  };

  const lines: string[] = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Lead Depot Call Log`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Outcome: ${outcomeLabel[outcome] || outcome.toUpperCase()}`,
    `Agent: ${agentName}`,
    `Date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "short", day: "numeric" })}`,
    ``,
  ];

  if (lpmamab && Object.values(lpmamab).some(Boolean)) {
    lines.push(`── LPMAMAB ──────────────────`);
    if (lpmamab.location)    lines.push(`L — Location:    ${lpmamab.location}`);
    if (lpmamab.price)       lines.push(`P — Price:       ${lpmamab.price}`);
    if (lpmamab.motivation)  lines.push(`M — Motivation:  ${lpmamab.motivation}`);
    if (lpmamab.agent)       lines.push(`A — Agent Hist:  ${lpmamab.agent}`);
    if (lpmamab.mortgage)    lines.push(`M — Mortgage:    ${lpmamab.mortgage}`);
    if (lpmamab.appointment) lines.push(`A — Appointment: ${lpmamab.appointment}`);
    if (lpmamab.buy)         lines.push(`B — Buyer:       ${lpmamab.buy}`);
    lines.push(``);
  }

  if (outcome === "contacted_appointment") {
    lines.push(`── APPOINTMENT DETAILS ──────`);
    if (confirmedAddress) lines.push(`Address:  ${confirmedAddress}`);
    if (apptDate)         lines.push(`Date:     ${apptDate}`);
    if (apptTime)         lines.push(`Time:     ${apptTime}`);
    if (apptEmail)        lines.push(`Email:    ${apptEmail}`);
    if (stage)            lines.push(`Stage:    ${stage}`);
    if (intention)        lines.push(`Intention: ${intention}`);
    lines.push(``);
  }

  if (notes) {
    lines.push(`── CALL NOTES ───────────────`);
    lines.push(notes);
    lines.push(``);
  }

  lines.push(`Source: Lead Depot — Watson Brothers Group`);
  lines.push(`Property: ${address || "—"}`);

  return lines.join("\n");
}

// ─── MAIN: PUSH OUTCOME TO FUB ────────────────────────────────────────────────
export interface FubOutcomePayload {
  lead: {
    id: number;
    ownerName?: string;
    phone?: string;
    email?: string;
    address?: string;
    leadType: string;
    source?: string;
    lLocation?: string;
    lPricePaid?: string;
    lMotivation?: string;
    lAgentHistory?: string;
    lMortgage?: string;
    lAppointment?: string;
    lBuy?: string;
  };
  agent: {
    id: number;
    name: string;
    email?: string;
  };
  outcome: string;
  notes?: string;
  lpmamab?: {
    location?: string;
    price?: string;
    motivation?: string;
    agent?: string;
    mortgage?: string;
    appointment?: string;
    buy?: string;
  };
  apptDate?: string;
  apptTime?: string;
  apptEmail?: string;
  confirmedAddress?: string;
  stage?: string;
  intention?: string;
}

export async function pushOutcomeToFub(payload: FubOutcomePayload): Promise<void> {
  if (!FUB_API_KEY) return;

  const { lead, agent, outcome, notes, lpmamab, apptDate, apptTime, apptEmail, confirmedAddress, stage, intention } = payload;

  // Only push meaningful outcomes to FUB — skip no_answer / wrong_number
  const pushOutcomes = ["contacted_appointment", "keep_in_touch", "contacted_not_interested"];
  if (!pushOutcomes.includes(outcome)) return;

  const fubType = outcomeToFubType(outcome, lead.leadType);
  const fubStage = outcomeToFubStage(outcome);
  const tags = buildTags(lead.leadType, outcome, lead.source);
  const fubSource = getFubSource(lead.leadType, lead.source);

  // Parse name
  const nameParts = (lead.ownerName || "").trim().split(" ");
  const firstName = nameParts[0] || "Unknown";
  const lastName = nameParts.slice(1).join(" ") || "";

  // Step 1: Send event (creates or updates contact, fires automations)
  const eventPayload: any = {
    source: fubSource,
    system: FUB_SYSTEM,
    type: fubType,
    message: `Lead Depot — ${outcome === "contacted_appointment" ? "Appointment Set" : outcome === "keep_in_touch" ? "Keep in Touch" : "Contacted"} by ${agent.name}`,
    sourceUrl: `https://depot.watsonbrothersgroup.com`,
    person: {
      firstName,
      lastName,
      stage: fubStage,
      tags,
      assignedTo: agent.name,
      background: `Lead Type: ${fubSource}\nProperty: ${lead.address || "—"}\nSource: ${fubSource}`,
    },
  };

  // Add phone if available
  if (lead.phone) {
    eventPayload.person.phones = [{ value: lead.phone }];
  }

  // Add email if available
  const emailToUse = apptEmail || lead.email;
  if (emailToUse) {
    eventPayload.person.emails = [{ value: emailToUse }];
  }

  console.log(`[FUB] Pushing ${outcome} for lead ${lead.id} (${lead.ownerName}) to FUB...`);
  const eventResult = await fubRequest("POST", "/events", eventPayload);

  if (!eventResult.ok) {
    console.error("[FUB] Failed to push event:", eventResult.data);
    return;
  }

  console.log(`[FUB] Event pushed — FUB responded ${eventResult.status} (${eventResult.status === 201 ? "new contact" : "existing contact updated"})`);

  // Step 2: Get the person ID from the event response
  const personId = eventResult.data?.person?.id;
  if (!personId) {
    console.warn("[FUB] No person ID returned — skipping note post");
    return;
  }

  // Step 3: Post LPMAMAB note to their timeline
  const noteBody = buildLpmamabNote({
    agentName: agent.name,
    outcome,
    notes,
    lpmamab: lpmamab || {
      location:    lead.lLocation    || undefined,
      price:       lead.lPricePaid   || undefined,
      motivation:  lead.lMotivation  || undefined,
      agent:       lead.lAgentHistory || undefined,
      mortgage:    lead.lMortgage    || undefined,
      appointment: lead.lAppointment || undefined,
      buy:         lead.lBuy         || undefined,
    },
    apptDate,
    apptTime,
    stage,
    intention,
    confirmedAddress,
    apptEmail,
    address: lead.address,
  });

  const noteResult = await fubRequest("POST", "/notes", {
    personId,
    body: noteBody,
    isHtml: false,
  });

  if (noteResult.ok) {
    console.log(`[FUB] LPMAMAB note posted to contact ${personId}`);
  } else {
    console.error("[FUB] Failed to post note:", noteResult.data);
  }
}

// ─── PUSH NEW LEAD (website/network leads) ───────────────────────────────────
export async function pushNewLeadToFub(opts: {
  ownerName?: string;
  phone?: string;
  email?: string;
  address?: string;
  leadType: string;
  source?: string;
  agentName?: string;
  notes?: string;
  tags?: string[];
}): Promise<void> {
  if (!FUB_API_KEY) return;

  const nameParts = (opts.ownerName || "").trim().split(" ");
  const firstName = nameParts[0] || "Unknown";
  const lastName = nameParts.slice(1).join(" ") || "";

  const fubSource = getFubSource(opts.leadType, opts.source);

  const payload: any = {
    source: fubSource,
    system: FUB_SYSTEM,
    type: "Registration",
    message: opts.notes || `New ${fubSource} lead via Lead Depot`,
    sourceUrl: "https://depot.watsonbrothersgroup.com",
    person: {
      firstName,
      lastName,
      tags: opts.tags || ["ne-florida", opts.leadType.replace("_", "-")],
      background: `Lead Type: ${fubSource}\nProperty: ${opts.address || "—"}`,
    },
  };

  if (opts.agentName) payload.person.assignedTo = opts.agentName;
  if (opts.phone)     payload.person.phones = [{ value: opts.phone }];
  if (opts.email)     payload.person.emails = [{ value: opts.email }];

  const result = await fubRequest("POST", "/events", payload);
  if (result.ok) {
    console.log(`[FUB] New lead pushed — ${result.status === 201 ? "created" : "updated"}`);
  }
}
