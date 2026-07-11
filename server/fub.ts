/**
 * Follow Up Boss API Integration — Lead Depot
 * Brothers Group Real Estate Team at Momentum Realty
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

// v14.27 — Push a note to a FUB contact recording that an email was sent from Lead Depot.
// Used by Flow 2 (auto credibility), Flow 3 (2nd attempt), and Flow 4 (appointment warm).
export async function pushEmailNoteToFub(opts: {
  ownerPhone?: string;
  ownerName?: string;
  subject: string;
  sentAt: string;      // ISO timestamp
  preview: string;     // first ~260 chars of plain-text body
  kind: string;        // e.g. "Flow 2 \u2014 Expired Credibility"
}): Promise<void> {
  if (!FUB_API_KEY) return;
  if (!opts.ownerPhone && !opts.ownerName) {
    console.warn("[FUB] pushEmailNoteToFub \u2014 no phone or name to resolve contact");
    return;
  }

  // Resolve personId via phone (preferred) then name
  let personId: number | undefined;
  if (opts.ownerPhone) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.ownerPhone)}&limit=1`);
    personId = r.data?.people?.[0]?.id;
  }
  if (!personId && opts.ownerName) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.ownerName)}&limit=1`);
    personId = r.data?.people?.[0]?.id;
  }
  if (!personId) {
    console.warn(`[FUB] pushEmailNoteToFub \u2014 could not resolve contact for ${opts.ownerName || opts.ownerPhone}`);
    return;
  }

  const when = new Date(opts.sentAt).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  const body = [
    `\uD83D\uDCE7 Email sent from Lead Depot`,
    ``,
    `Type:    ${opts.kind}`,
    `Sent:    ${when}`,
    `Subject: ${opts.subject}`,
    ``,
    `\u2500\u2500 Preview \u2500\u2500`,
    opts.preview,
  ].join("\n");

  const r = await fubRequest("POST", "/notes", { personId, body, isHtml: false });
  if (r.ok) console.log(`[FUB] Email note posted to contact ${personId} (${opts.kind})`);
  else console.error("[FUB] Failed to post email note:", r.data);
}

// v14.34 — Best-effort background poll for FUB email evidence.
// After an agent taps the Flow 1/5 mailto, wait ~5 min, then check FUB /em for an
// outbound email to lead.email posted at or near the tap time. If found, insert a
// lead_activity row with outcome='email_confirmed' + FUB message ID in notes.
// Never blocks the 24h gate — the gate opens at tap+24h regardless of evidence.
export async function scheduleFubEmailEvidence(opts: {
  leadId: number;
  leadEmail: string;
  ownerPhone?: string;
  ownerName?: string;
  tapNote: string;      // 'flow1-mailto' or 'flow5-mailto'
  tappedAtIso: string;  // ISO of when the tap was logged
  delayMs?: number;     // default 5 min
}): Promise<void> {
  if (!FUB_API_KEY) return;
  if (!opts.leadEmail || !String(opts.leadEmail).includes("@")) return; // nothing to correlate against

  const delay = typeof opts.delayMs === "number" ? opts.delayMs : 5 * 60 * 1000;

  // Return immediately; do the correlation in the background.
  setTimeout(async () => {
    try {
      // 1) Resolve personId (phone → name)
      let personId: number | undefined;
      if (opts.ownerPhone) {
        const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.ownerPhone)}&limit=1`);
        personId = r.data?.people?.[0]?.id;
      }
      if (!personId && opts.ownerName) {
        const r = await fubRequest("GET", `/people?query=${encodeURIComponent(opts.ownerName)}&limit=1`);
        personId = r.data?.people?.[0]?.id;
      }
      if (!personId) {
        console.warn(`[FUB evidence] lead ${opts.leadId} — could not resolve contact; skipping`);
        return;
      }

      // 2) Fetch recent emails and look for one to lead.email at/after tap (minus 2min tolerance).
      const emRes = await fubRequest("GET", `/em?personId=${personId}&limit=20`);
      if (!emRes.ok) {
        console.warn(`[FUB evidence] lead ${opts.leadId} — /em returned ${emRes.status}`);
        return;
      }

      const tapMs = new Date(opts.tappedAtIso).getTime() - 2 * 60 * 1000; // 2-min tolerance
      const targetEmail = String(opts.leadEmail).toLowerCase().trim();
      const items: any[] = emRes.data?.em || emRes.data?.emails || emRes.data || [];
      const arr = Array.isArray(items) ? items : [];

      const match = arr.find((row: any) => {
        const to = row?.to || row?.toAddress || row?.recipients || "";
        const toStr = Array.isArray(to) ? to.map((x: any) => (typeof x === "string" ? x : x?.value || x?.email || "")).join(",") : String(to);
        const sentAt = row?.sentAt || row?.sent_at || row?.created || row?.createdAt;
        const sentMs = sentAt ? new Date(sentAt).getTime() : 0;
        return toStr.toLowerCase().includes(targetEmail) && sentMs >= tapMs;
      });

      if (!match) {
        console.log(`[FUB evidence] lead ${opts.leadId} — no matching outbound email found (checked ${arr.length} rows)`);
        return;
      }

      const eventId = match?.id || match?.messageId || match?.emId || "?";
      const sentAt = match?.sentAt || match?.sent_at || match?.created || match?.createdAt || opts.tappedAtIso;

      // 3) Log the confirmation. Best-effort — swallow errors.
      try {
        // Use fubRequest's Node fetch already in scope; DB write is out of module scope
        // so we import lazily via require to avoid a circular import at load time.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { rawDb } = require("./db");
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
          VALUES (?, NULL, 'email_confirmed', ?, NULL, ?)
        `).run(opts.leadId, `FUB ${opts.tapNote} event=${eventId} sent=${sentAt}`, new Date().toISOString());
        console.log(`[FUB evidence] lead ${opts.leadId} — confirmed via FUB event ${eventId}`);
      } catch (dbErr: any) {
        console.error(`[FUB evidence] lead ${opts.leadId} — DB insert failed:`, dbErr?.message || dbErr);
      }
    } catch (err: any) {
      console.error(`[FUB evidence] lead ${opts.leadId} — poll failed:`, err?.message || err);
    }
  }, delay);
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
  if (leadType === "network") return "Registration";
  return "General Inquiry";
}

// ─── STAGE MAPPING ────────────────────────────────────────────────────────────
function outcomeToFubStage(outcome: string): { name: string; id: number } {
  switch (outcome) {
    case "contacted_appointment":    return { name: "Hot Prospect", id: 3 };
    case "keep_in_touch":           return { name: "Nurture",      id: 4 };
    case "contacted_not_interested": return { name: "Lead",         id: 2 }; // No 'Unresponsive' stage in FUB
    default:                         return { name: "Lead",         id: 2 };
  }
}

// ─── INTENTION → FUB TAG MAP ─────────────────────────────────────────────────
// Intention keys come from the ApptModal INTENTIONS array in AgentView.tsx
// These become searchable tags in FUB for smart lists + action plan triggers
const INTENTION_TAG_MAP: Record<string, string[]> = {
  sell_now:     ["seller", "sell-now"],
  future_sell:  ["seller", "future-seller", "pocket-listing"],
  buy_now:      ["buyer", "buy-now"],
  future_buy:   ["buyer", "future-buyer"],
  rental_now:   ["landlord", "rental-now"],
  rental_later: ["landlord", "rental-later"],
};

// ─── TAG BUILDER ─────────────────────────────────────────────────────────────
function buildTags(
  leadType: string,
  outcome: string,
  source?: string,
  intention?: string,
  intent?: "sell_only" | "sell_and_buy" | "buy_only",
): string[] {
  const tags: string[] = [];

  // v15.3 — Intent tags per INTENT_SPEC Q5 (plain English, no prefix).
  // These sit alongside intention-derived tags so FUB smart lists can key off intent alone.
  if (intent === "sell_only")    tags.push("Seller");
  if (intent === "buy_only")     tags.push("Buyer");
  if (intent === "sell_and_buy") tags.push("Buy&Sell");

  // Lead type → FUB source-style tag
  const typeMap: Record<string, string> = {
    expired:  "expired-listing",
    absentee: "absentee-owner",
    network:  "network-lead",
  };
  if (typeMap[leadType]) tags.push(typeMap[leadType]);

  // Outcome
  if (outcome === "contacted_appointment") tags.push("appointment-set");
  if (outcome === "keep_in_touch")        tags.push("kit");

  // Source override
  if (source?.toLowerCase().includes("network")) tags.push("network-referral");

  // Geography
  tags.push("ne-florida");

  // Intention tags — parse the joined string (e.g. "Sell Now + Buy Now" or "Future Sell")
  // The frontend joins intention keys as label strings like "Sell Now", "Future Sell"
  // Map back to tag arrays via label → key lookup
  if (intention) {
    const labelToKey: Record<string, string> = {
      "Sell Now":     "sell_now",
      "Future Sell":  "future_sell",
      "Buy Now":      "buy_now",
      "Future Buy":   "future_buy",
      "Rental Now":   "rental_now",
      "Rental Later": "rental_later",
    };
    // Intentions are joined with " + " in the frontend
    const parts = intention.split(" + ").map(s => s.trim());
    for (const part of parts) {
      const key = labelToKey[part];
      if (key && INTENTION_TAG_MAP[key]) {
        for (const t of INTENTION_TAG_MAP[key]) {
          if (!tags.includes(t)) tags.push(t);
        }
      }
    }
    // Multi-transaction flag
    if (parts.length > 1) tags.push("multi-transaction");
  }

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
  // v14.53 — intent decides seller vs buyer vs both
  intent?: "sell_only" | "sell_and_buy" | "buy_only";
  // v14.20 — Buyer LPMAMA (only rendered when alsoBuying=true / intent !== sell_only)
  alsoBuying?: boolean;
  buyerLpmama?: {
    location?: string;
    price?: string;
    motivation?: string;
    agent?: string;
    mortgage?: string;
  };
  apptDate?: string;
  apptTime?: string;
  stage?: string;
  intention?: string;
  confirmedAddress?: string;
  apptEmail?: string;
  address?: string;
}): string {
  const { agentName, outcome, notes, lpmamab, intent, alsoBuying, buyerLpmama, apptDate, apptTime, stage, intention, confirmedAddress, apptEmail, address } = opts;
  const effectiveIntent = intent || (alsoBuying ? "sell_and_buy" : "sell_only");
  const showSeller = effectiveIntent !== "buy_only";
  const showBuyer = effectiveIntent !== "sell_only";

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

  lines.push(`Intent: ${effectiveIntent === "sell_only" ? "SELL ONLY" : effectiveIntent === "buy_only" ? "BUY ONLY" : "SELL & BUY"}`);
  lines.push(``);

  if (showSeller && lpmamab && Object.values(lpmamab).some(Boolean)) {
    lines.push(`── SELLER CPMAMA ────────────`);
    if (lpmamab.location)    lines.push(`C — Condition:   ${lpmamab.location}`);
    if (lpmamab.price)       lines.push(`P — Price:       ${lpmamab.price}`);
    if (lpmamab.motivation)  lines.push(`M — Motivation:  ${lpmamab.motivation}`);
    if (lpmamab.agent)       lines.push(`A — Agent Hist:  ${lpmamab.agent}`);
    if (lpmamab.mortgage)    lines.push(`M — Mortgage:    ${lpmamab.mortgage}`);
    if (lpmamab.appointment) lines.push(`A — Appointment: ${lpmamab.appointment}`);
    if (lpmamab.buy)         lines.push(`B — Buyer:       ${lpmamab.buy}`);
    lines.push(``);
  }

  // v14.53 — Buyer LPMAMA block (renders when intent !== sell_only)
  if (showBuyer) {
    lines.push(`── BUYER LPMAMA ────────────`);
    lines.push(`Also buying: YES`);
    if (buyerLpmama?.location)   lines.push(`B-L — Location:   ${buyerLpmama.location}`);
    if (buyerLpmama?.price)      lines.push(`B-P — Price:      ${buyerLpmama.price}`);
    if (buyerLpmama?.motivation) lines.push(`B-M — Motivation: ${buyerLpmama.motivation}`);
    if (buyerLpmama?.agent)      lines.push(`B-A — Agent:      ${buyerLpmama.agent}`);
    if (buyerLpmama?.mortgage)   lines.push(`B-M — Mortgage:   ${buyerLpmama.mortgage}`);
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

  lines.push(`Source: Lead Depot — Brothers Group Real Estate Team at Momentum Realty`);
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
    // v14.20 — Buyer LPMAMA
    alsoBuying?: boolean;
    // v15.3 — persisted intent on the lead row (fall-through when lpmamab.intent absent)
    intent?: "sell_only" | "sell_and_buy" | "buy_only";
    bLocation?: string;
    bPrice?: string;
    bMotivation?: string;
    bAgent?: string;
    bMortgage?: string;
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
    // v14.20 — Buyer LPMAMA (from AgentView payload)
    alsoBuying?: boolean;
    // v14.53 — 3-way intent
    intent?: "sell_only" | "sell_and_buy" | "buy_only";
    bLocation?: string;
    bPrice?: string;
    bMotivation?: string;
    bAgent?: string;
    bMortgage?: string;
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
  // v15.3 — pass intent so buildTags can add Seller / Buyer / Buy&Sell tag per INTENT_SPEC Q5
  const effectiveIntent = (lpmamab as any)?.intent || (lead as any).intent || undefined;
  const tags = buildTags(lead.leadType, outcome, lead.source, intention, effectiveIntent);
  const fubSource = getFubSource(lead.leadType, lead.source);

  // Parse name
  const nameParts = (lead.ownerName || "").trim().split(" ");
  const firstName = nameParts[0] || "Unknown";
  const lastName = nameParts.slice(1).join(" ") || "";

  // Step 1: Send event (creates or updates contact, fires automations)
  const emailToUse = apptEmail || lead.email;
  const eventPayload: any = {
    source: fubSource,
    system: FUB_SYSTEM,
    type: fubType,
    message: `Lead Depot — ${outcome === "contacted_appointment" ? "Appointment Set" : outcome === "keep_in_touch" ? "Keep in Touch" : "Contacted"} by ${agent.name}`,
    sourceUrl: `https://depot.watsonbrothersgroup.com`,
    person: {
      firstName,
      lastName,
      type: "Seller",  // All seller leads are Sellers — prevents FUB defaulting to Buyer on General Inquiry events
      stage: fubStage.name,
      tags,
      assignedTo: agent.name,
      background: `Lead Type: ${fubSource}\nProperty: ${lead.address || "—"}\nSource: ${fubSource}`,
    },
  };

  if (lead.phone) eventPayload.person.phones = [{ value: lead.phone }];
  if (emailToUse) eventPayload.person.emails = [{ value: emailToUse }];

  console.log(`[FUB] Pushing ${outcome} for lead ${lead.id} (${lead.ownerName}) to FUB...`);
  const eventResult = await fubRequest("POST", "/events", eventPayload);

  if (!eventResult.ok) {
    console.error("[FUB] Failed to push event:", eventResult.data);
    return;
  }

  console.log(`[FUB] Event pushed — FUB responded ${eventResult.status} (${eventResult.status === 201 ? "new contact" : "existing contact updated"})`);

  // Step 2: Get person ID — try inline response first, fall back to search by phone
  let personId = eventResult.data?.person?.id;
  if (!personId && lead.phone) {
    const searchRes = await fubRequest("GET", `/people?query=${encodeURIComponent(lead.phone)}&limit=1`);
    personId = searchRes.data?.people?.[0]?.id;
    if (personId) console.log(`[FUB] Person ID resolved via phone search: ${personId}`);
  }
  if (!personId && lead.ownerName) {
    const searchRes = await fubRequest("GET", `/people?query=${encodeURIComponent(lead.ownerName)}&limit=1`);
    personId = searchRes.data?.people?.[0]?.id;
    if (personId) console.log(`[FUB] Person ID resolved via name search: ${personId}`);
  }
  if (!personId) {
    console.warn("[FUB] Could not resolve person ID — skipping stage force + note post");
    return;
  }

  // Step 2b: Force correct stageId via PUT (stage string in /events is not always honored)
  await fubRequest("PUT", `/people/${personId}`, { stageId: fubStage.id });
  console.log(`[FUB] Stage forced → ${fubStage.name} (id=${fubStage.id}) for person ${personId}`);

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
    // v14.53 — pass intent through so the note reflects the right script
    intent: (lpmamab?.intent as any) || ((lead as any).intent as any),
    // v14.20 — Buyer LPMAMA. Prefer live form payload; fall back to lead row.
    alsoBuying: !!(lpmamab?.alsoBuying ?? lead.alsoBuying),
    buyerLpmama: {
      location:   (lpmamab?.bLocation)   || lead.bLocation   || undefined,
      price:      (lpmamab?.bPrice)      || lead.bPrice      || undefined,
      motivation: (lpmamab?.bMotivation) || lead.bMotivation || undefined,
      agent:      (lpmamab?.bAgent)      || lead.bAgent      || undefined,
      mortgage:   (lpmamab?.bMortgage)   || lead.bMortgage   || undefined,
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

// ─── AGENT RECRUITING — PUSH ON FORM SUBMIT ──────────────────────────────────
export interface AgentRecruitPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  licenseStatus: string;
  licenseState?: string;
  yearsExperience?: string;
  currentBrokerage?: string;
  reasonForLeaving?: string;
  gciRange?: string;
  transactionsLast12mo?: number;
  territory?: string;
  matchedTerritory?: string;
  referralSource?: string;
  referredByName?: string;
  applicantNotes?: string;
  submittedAt?: string;
}

export async function fubCreateAgentRecruit(data: AgentRecruitPayload): Promise<number | null> {
  if (!FUB_API_KEY) return null;

  const tags = [
    "Agent Recruit",
    "ne-florida",
    `License: ${data.licenseStatus.charAt(0).toUpperCase() + data.licenseStatus.slice(1)}`,
  ];
  if (data.matchedTerritory || data.territory) {
    tags.push(`Territory: ${data.matchedTerritory || data.territory}`);
  }
  if (data.referralSource) tags.push(`Source: ${data.referralSource}`);

  // Build structured intake note
  const noteLines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Agent Recruiting Intake`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Submitted: ${data.submittedAt || new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EDT`,
    `Source: Lead Depot Recruiting — join.watsonbrothersgroup.com`,
    ``,
    `── LICENSE & EXPERIENCE ─────`,
    `License Status: ${data.licenseStatus}`,
    data.licenseState    ? `License State:  ${data.licenseState}` : "",
    data.yearsExperience ? `Years of Exp:   ${data.yearsExperience}` : "",
    ``,
    `── CURRENT SITUATION ────────`,
    data.currentBrokerage  ? `Current Brokerage: ${data.currentBrokerage}` : "",
    data.reasonForLeaving  ? `Reason for Move:   ${data.reasonForLeaving}` : "",
    ``,
    `── PRODUCTION ───────────────`,
    data.gciRange              ? `GCI Range (12mo):  ${data.gciRange}` : "",
    data.transactionsLast12mo  ? `Transactions (12mo): ${data.transactionsLast12mo}` : "",
    ``,
    `── TERRITORY ────────────────`,
    data.matchedTerritory ? `Territory (matched): ${data.matchedTerritory}` : "",
    data.territory && data.territory !== data.matchedTerritory ? `Territory (as entered): ${data.territory}` : "",
    ``,
    `── ATTRIBUTION ──────────────`,
    data.referralSource  ? `Heard about us via: ${data.referralSource}` : "",
    data.referredByName  ? `Referred by: ${data.referredByName}` : "",
    ``,
    data.applicantNotes  ? `── APPLICANT NOTES ──────────\n${data.applicantNotes}\n` : "",
    `Source: Lead Depot Recruiting — Brothers Group Real Estate Team at Momentum Realty`,
  ].filter(l => l !== "");

  const eventPayload: any = {
    source: "Lead Depot Recruiting",
    system: FUB_SYSTEM,
    type: "Agent Inquiry",
    message: `New agent recruit inquiry via join.watsonbrothersgroup.com — ${data.firstName} ${data.lastName}`,
    sourceUrl: "https://join.watsonbrothersgroup.com",
    person: {
      firstName: data.firstName,
      lastName: data.lastName,
      stage: "Agent Recruit Lead",
      tags,
      assignedTo: "Alex Watson",
    },
  };

  if (data.phone) eventPayload.person.phones = [{ value: data.phone }];
  if (data.email) eventPayload.person.emails = [{ value: data.email }];

  console.log(`[FUB] Pushing agent recruit: ${data.firstName} ${data.lastName}`);
  const result = await fubRequest("POST", "/events", eventPayload);

  if (!result.ok) {
    console.error("[FUB] Failed to push agent recruit:", result.data);
    return null;
  }

  const personId = result.data?.person?.id ?? null;

  if (personId) {
    // Force stage to "Agent Recruit Lead" (ID 31) via PATCH — the stage field
    // in POST /events person object is not always respected by FUB.
    await fubRequest("PUT", `/people/${personId}`, { stageId: 31 });
    console.log(`[FUB] Agent recruit stage set → Agent Recruit Lead (person ${personId})`);

    // Post structured intake note
    await fubRequest("POST", "/notes", {
      personId,
      body: noteLines.join("\n"),
      isHtml: false,
    });
    console.log(`[FUB] Agent recruit note posted — person ${personId}`);
  }

  return personId;
}
