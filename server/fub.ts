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

// v20.32.13 Part 4 — module-level FUB user IDs, hoisted out of pushOutcomeToFub
// so the generic milestone-task engine below can reuse them as default assignees.
export const DENISE_FUB_USER_ID = 16;
export const NATE_FUB_USER_ID = 1;
export const ALEX_FUB_USER_ID = 2;
export const COLLAB_USER_IDS = [DENISE_FUB_USER_ID, NATE_FUB_USER_ID, ALEX_FUB_USER_ID];

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

export async function fubRequest(
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
  intent?: "sell_only" | "sell_and_buy" | "buy_only" | "rent_only" | "sell_and_rent",
  warmLeadSource?: string,
): string[] {
  const tags: string[] = [];

  // v15.3 — Intent tags per INTENT_SPEC Q5 (plain English, no prefix).
  // v17.2 — Renter + Sell-and-Rent added.
  // These sit alongside intention-derived tags so FUB smart lists can key off intent alone.
  // v20.7.9 — Combos now emit BOTH single-side tags in addition to the combo
  // marker so FUB smart lists that filter by `Seller` or `Buyer` alone still
  // catch combo leads (the person.type field can only hold one value, so
  // buyer-side automations that key off type==Buyer used to miss combos).
  if (intent === "sell_only")     tags.push("Seller");
  if (intent === "buy_only")      tags.push("Buyer");
  if (intent === "sell_and_buy") { tags.push("Seller"); tags.push("Buyer"); tags.push("Buy&Sell"); }
  if (intent === "rent_only")     tags.push("Renter");
  if (intent === "sell_and_rent") { tags.push("Seller"); tags.push("Renter"); tags.push("Sell&Rent"); }

  // Lead type → FUB source-style tag
  // v17.2 — absentee retired; open_house / door_knock / direct_mail added as warm sources.
  const typeMap: Record<string, string> = {
    expired:      "expired-listing",
    network:      "network-lead",
    open_house:   "open-house-lead",
    door_knock:   "door-knock-lead",
    direct_mail:  "direct-mail-lead",
  };
  if (typeMap[leadType]) tags.push(typeMap[leadType]);

  // Outcome
  if (outcome === "contacted_appointment") tags.push("appointment-set");
  if (outcome === "keep_in_touch")        tags.push("kit");

  // v17.2 — warm-lead source tag (in case leadType wasn't set correctly upstream)
  const warmMap: Record<string, string> = {
    network:     "warm-network",
    open_house:  "warm-open-house",
    door_knock:  "warm-door-knock",
    direct_mail: "warm-direct-mail",
  };
  if (warmLeadSource && warmMap[warmLeadSource] && !tags.includes(warmMap[warmLeadSource])) {
    tags.push(warmMap[warmLeadSource]);
  }

  // Source override (legacy)
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
    // v17.2 — Renter LPMA passthrough (rendered as its own block)
    rLocation?: string;
    rPrice?: string;
    rMotivation?: string;
    rAppointment?: string;
  };
  // v14.53 — intent decides seller vs buyer vs both
  // v17.2 — renter + sell_and_rent added
  intent?: "sell_only" | "sell_and_buy" | "buy_only" | "rent_only" | "sell_and_rent";
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
  // v17.2 — renter surfaces added. Same show-flag pattern as buyer/seller.
  const showSeller = effectiveIntent === "sell_only" || effectiveIntent === "sell_and_buy" || effectiveIntent === "sell_and_rent";
  const showBuyer  = effectiveIntent === "buy_only"  || effectiveIntent === "sell_and_buy";
  const showRenter = effectiveIntent === "rent_only" || effectiveIntent === "sell_and_rent";
  // Renter LPMA fields live on lpmamab (renamed r*). Buyer keeps buyerLpmama.
  const renterLpma: any = lpmamab || {};

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

  const intentLabel = ({
    sell_only: "SELL ONLY",
    buy_only: "BUY ONLY",
    rent_only: "RENT ONLY",
    sell_and_buy: "SELL & BUY",
    sell_and_rent: "SELL & RENT",
  } as Record<string, string>)[effectiveIntent] || effectiveIntent.toUpperCase();
  lines.push(`Intent: ${intentLabel}`);
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

  // v17.2 — Renter LPMA block (renders when intent = rent_only OR sell_and_rent).
  //         Renters have Location / Price / Motivation / Appointment only — no Agent, no Mortgage.
  if (showRenter) {
    lines.push(`── RENTER LPMA ─────────────`);
    if (renterLpma?.rLocation)    lines.push(`R-L — Location:    ${renterLpma.rLocation}`);
    if (renterLpma?.rPrice)       lines.push(`R-P — Price/Rent:  ${renterLpma.rPrice}`);
    if (renterLpma?.rMotivation)  lines.push(`R-M — Motivation:  ${renterLpma.rMotivation}`);
    if (renterLpma?.rAppointment) lines.push(`R-A — Appointment: ${renterLpma.rAppointment}`);
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
    // v17.2 — renter + sell_and_rent added
    intent?: "sell_only" | "sell_and_buy" | "buy_only" | "rent_only" | "sell_and_rent";
    bLocation?: string;
    bPrice?: string;
    bMotivation?: string;
    bAgent?: string;
    bMortgage?: string;
    // v17.2 — warm-lead source + intent (stored in extraData; passed through here for FUB)
    warmLeadSource?: string;
    warmLeadIntent?: string;
    // v17.2 — Renter LPMA (stored in extraData.renterLpma; passed through here)
    rLocation?: string;
    rPrice?: string;
    rMotivation?: string;
    rAppointment?: string;
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
    // v17.2 — Renter LPMA fields (Location / Price / Motivation / Appointment — no Agent / no Mortgage)
    rLocation?: string;
    rPrice?: string;
    rMotivation?: string;
    rAppointment?: string;
    // v17.2 — broadened intent alias (warm-lead intent overrides lead.intent when present)
    warmLeadIntent?: string;
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

  // v15.11.8 — Alex's final rule: FUB is ONLY updated on Keep in Touch or
  // Appointment Set. No Answer, Recycle, Not Interested, and Wrong # stay
  // Lead-Depot-only. The lead never enters FUB until we have a real
  // relationship signal from the agent.
  const pushOutcomes = ["contacted_appointment", "keep_in_touch"];
  if (!pushOutcomes.includes(outcome)) return;

  // v20.7.9 — Multi-side detection (Buyer / Seller / Renter). The intention
  // string joins labels with " + " (e.g. "Sell Now + Rental Later"). Use the
  // full intention text PLUS the mapped `effectiveIntent` (sell_only/buy_only/
  // rent_only/sell_and_buy/sell_and_rent) for a belt-and-braces check.
  //
  // FIX: prior versions only matched /\bbuy\b/ and /\bsell\b/, so a pure
  // renter ("Rental Now") defaulted to kitSide="seller" — pushing them to the
  // Sellers pipeline with the seller Action Plan, and dropping the rental
  // side entirely on sell_and_rent combos.
  const intentionLower = (intention || "").toLowerCase();
  const effIntent = (payload as any)?._effectiveIntent as string | undefined; // set below after `effectiveIntent`
  // We can't use effectiveIntent here because it's declared later in the
  // function — instead we inline the same detection off the raw intent/lpmamab.
  const rawEff = (lpmamab as any)?.intent || (lead as any).intent || "";
  const isBuyer  = /\bbuy\b/.test(intentionLower)  || /buy_only|sell_and_buy/.test(String(rawEff));
  const isSeller = /\bsell\b/.test(intentionLower) || /sell_only|sell_and_buy|sell_and_rent/.test(String(rawEff));
  const isRenter = /\brent(al)?\b|\blandlord\b/.test(intentionLower) || /rent_only|sell_and_rent/.test(String(rawEff));

  // Sides is a Set of independent tags — a lead can be any combination.
  const sidesSet = new Set<"seller" | "buyer" | "renter">();
  if (isSeller) sidesSet.add("seller");
  if (isBuyer)  sidesSet.add("buyer");
  if (isRenter) sidesSet.add("renter");
  if (sidesSet.size === 0) sidesSet.add("seller"); // safety default preserves old behavior

  // kitSide is retained for backward-compat with the Action Plan map. Order of
  // precedence for the "one string" label: multi (both/mixed) → seller → buyer → renter.
  const isMulti = sidesSet.size > 1;
  const kitSide: "seller" | "buyer" | "renter" | "both" =
    isMulti ? "both"
    : sidesSet.has("seller") ? "seller"
    : sidesSet.has("buyer")  ? "buyer"
    : "renter";

  // v15.11.8 — Outcome → FUB action plan + tag mapping (locked by Alex 2026-07-12).
  // v20.7.9 — Renter Action Plan not yet defined by Alex; falls through to KIT
  // plan 48 with a distinct tag until Alex provides a renter plan ID.
  const ACTION_PLAN_MAP: Record<string, { planId: number; tag: string }> = {
    // Appointments — flavors depending on intention
    "contacted_appointment:seller": { planId: 78, tag: "LeadDepot:ApptListing" },
    "contacted_appointment:buyer":  { planId: 79, tag: "LeadDepot:ApptBuyer" },
    "contacted_appointment:renter": { planId: 79, tag: "LeadDepot:ApptRenter" }, // reuse buyer plan (rental agent workflow closest to buyer)
    "contacted_appointment:both":   { planId: 80, tag: "LeadDepot:ApptBoth" },
    // KIT — all sides use the same nurture plan (id=48), tag distinguishes
    "keep_in_touch:seller":         { planId: 48, tag: "LeadDepot:KIT-Seller" },
    "keep_in_touch:buyer":          { planId: 48, tag: "LeadDepot:KIT-Buyer" },
    "keep_in_touch:renter":         { planId: 48, tag: "LeadDepot:KIT-Renter" },
    "keep_in_touch:both":           { planId: 48, tag: "LeadDepot:KIT-Both" },
  };
  const planMapping = ACTION_PLAN_MAP[`${outcome}:${kitSide}`];

  // v15.11.9 — Denise, Nate, and Alex are all added as collaborators on every
  // KIT / Appt push so leadership has full visibility on every lead entering FUB.
  // The tool auto-skips anyone already listed as assignedTo on the record.
  const DENISE_FUB_USER_ID = 16;
  const NATE_FUB_USER_ID   = 1;
  const ALEX_FUB_USER_ID   = 2;
  const COLLAB_USER_IDS = [DENISE_FUB_USER_ID, NATE_FUB_USER_ID, ALEX_FUB_USER_ID];

  // v15.11.9 — FUB pipeline + stage IDs (fetched live 2026-07-12).
  const BUYERS_PIPELINE_ID  = 1;
  const BUYERS_STAGE_INTERESTED = 14;
  const SELLERS_PIPELINE_ID = 2;
  const SELLERS_STAGE_INTERESTED = 23;

  const fubType = outcomeToFubType(outcome, lead.leadType);
  const fubStage = outcomeToFubStage(outcome);
  // v15.3 — pass intent so buildTags can add Seller / Buyer / Buy&Sell tag per INTENT_SPEC Q5
  // v17.2 — warm-lead intent (10-option, from unified capture) takes priority over legacy 3-option
  //         intent. Map the 10-option warm intent back to the 5 canonical FUB intents.
  const warmToFub: Record<string, "sell_only" | "sell_and_buy" | "buy_only" | "rent_only" | "sell_and_rent"> = {
    seller: "sell_only",
    buyer: "buy_only",
    renter: "rent_only",
    seller_and_buyer: "sell_and_buy",
    seller_and_renter: "sell_and_rent",
    future_seller: "sell_only",
    future_buyer: "buy_only",
    future_renter: "rent_only",
    future_seller_and_buyer: "sell_and_buy",
    future_seller_and_renter: "sell_and_rent",
  };
  const warmIntent = ((lpmamab as any)?.warmLeadIntent || (lead as any).warmLeadIntent) as string | undefined;
  const mappedWarmIntent = warmIntent ? warmToFub[warmIntent] : undefined;
  const effectiveIntent = mappedWarmIntent || (lpmamab as any)?.intent || (lead as any).intent || undefined;
  const warmLeadSource = ((lead as any).warmLeadSource || undefined) as string | undefined;
  const tags = buildTags(lead.leadType, outcome, lead.source, intention, effectiveIntent as any, warmLeadSource);
  // v15.11.8 — Append the outcome-specific tag so the plan and tag stay in sync
  if (planMapping && !tags.includes(planMapping.tag)) tags.push(planMapping.tag);
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
      // v17.2 — person.type now reflects effective intent. FUB still defaults
      // to Seller when intent is unknown (preserves the pre-existing safety).
      type: (effectiveIntent === "buy_only" ? "Buyer"
        : effectiveIntent === "rent_only" ? "Renter"
        : effectiveIntent === "sell_and_buy" ? "Seller"    // multi-side; Seller is the primary contract type
        : effectiveIntent === "sell_and_rent" ? "Seller"
        : "Seller"),
      stage: fubStage.name,
      tags,
      assignedTo: agent.name,
      background: `Lead Type: ${fubSource}\nProperty: ${lead.address || "—"}\nSource: ${fubSource}`,
    },
  };

  if (lead.phone) eventPayload.person.phones = [{ value: lead.phone }];
  if (emailToUse) eventPayload.person.emails = [{ value: emailToUse }];

  // v15.11.8 — Structured address on the person. FUB's /events endpoint accepts
  // person.addresses[] with type + street/city/state/code. If we only have a
  // freeform string, we send it as street-only — FUB will normalize.
  const addressStr = confirmedAddress || lead.address;
  if (addressStr && typeof addressStr === "string" && addressStr.trim()) {
    eventPayload.person.addresses = [{ type: "home", street: addressStr.trim() }];
  }

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

  // v15.11.8 — Assign the action plan for this outcome.
  if (planMapping) {
    const apRes = await fubRequest("POST", `/actionPlansPeople`, {
      personId,
      actionPlanId: planMapping.planId,
    });
    if (apRes.ok) {
      console.log(`[FUB] Action plan ${planMapping.planId} (${planMapping.tag}) assigned to person ${personId}`);
    } else {
      console.error(`[FUB] Failed to assign action plan ${planMapping.planId}:`, apRes.status, apRes.data);
    }
  }

  // v15.11.9 — Add Denise + Nate + Alex as collaborators on every FUB record
  // from Lead Depot. Sequential (not parallel) so we can log per-user status.
  for (const uid of COLLAB_USER_IDS) {
    const collabRes = await fubRequest("POST", `/collaborators`, {
      personId,
      userId: uid,
    });
    if (collabRes.ok) {
      console.log(`[FUB] Collaborator user_id=${uid} added on person ${personId}`);
    } else if (collabRes.status !== 409 && collabRes.status !== 422) {
      // 409/422 = already a collaborator or self-assign — both fine
      console.warn(`[FUB] Collaborator user_id=${uid} add returned ${collabRes.status}:`, collabRes.data);
    }
  }

  // v20.6.9 — Send Accolades Email task for Denise on every KIT + Appt Set.
  // Fires inside the pushOutcomes gate (KIT + Appt only), so we don't need
  // to re-check outcome. Task is due today (FUB accepts YYYY-MM-DD).
  // Assigned to Denise (userId=16).
  try {
    const dueDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
    const taskPayload: any = {
      personId,
      name: "Send accolades email",
      type: "Email",
      dueDate,
      assignedUserId: DENISE_FUB_USER_ID,
    };
    const taskRes = await fubRequest("POST", `/tasks`, taskPayload);
    if (taskRes.ok) {
      console.log(`[FUB] 'Send accolades email' task created for Denise (person ${personId}, outcome=${outcome})`);
    } else {
      console.warn(`[FUB] Send accolades task POST returned ${taskRes.status}:`, taskRes.data);
    }
  } catch (err) {
    console.warn("[FUB] Send accolades task failed (non-fatal):", err);
  }

  // v15.11.9 — For Appt Set: create a real FUB /appointments object AND create
  // one or two /deals rows (Sell side, Buy side, or both) based on intention.
  if (outcome === "contacted_appointment" && apptDate && apptTime) {
    // ---- 1) Appointment object ----
    try {
      const combined = new Date(`${apptDate}T${apptTime}`);
      if (!isNaN(combined.getTime())) {
        const endTime = new Date(combined.getTime() + 60 * 60 * 1000); // 1 hour default
        // v15.11.9 — Unified appointment title regardless of side (Alex's directive).
        const apptTitle = "Meet & Greet with Alex Watson @ Brothers Group Real Estate";
        const apptRes = await fubRequest("POST", `/appointments`, {
          personId,
          type: "Consultation",
          title: apptTitle,
          description: `Set by ${agent.name} via Lead Depot. Address: ${addressStr || "—"}. Intention: ${intention || "—"}.`,
          startTime: combined.toISOString(),
          endTime: endTime.toISOString(),
          location: addressStr || undefined,
          // v15.11.9 — All 3 leaders invited so it hits every calendar
          invitees: COLLAB_USER_IDS.map(uid => ({ userId: uid })),
        });
        if (apptRes.ok) {
          console.log(`[FUB] Meet & Greet appointment created on ${combined.toISOString()} for person ${personId}`);
        } else {
          console.error(`[FUB] Failed to create appointment:`, apptRes.status, apptRes.data);
        }
      } else {
        console.warn(`[FUB] apptDate/apptTime did not parse: ${apptDate} ${apptTime}`);
      }
    } catch (e) {
      console.error(`[FUB] Appointment build error:`, e);
    }

    // ---- 2) Deal(s) — one per side per Alex's spec ----
    // Extract deal value from LPMAMAB lPricePaid if numeric-ish, else leave blank
    const priceStr = (lpmamab as any)?.price || lead.lPricePaid || "";
    const priceNum = parseFloat(String(priceStr).replace(/[^0-9.]/g, ""));
    const dealValue = !isNaN(priceNum) && priceNum > 0 ? priceNum : undefined;

    // Estimated close 60 days out (editable in FUB)
    const closeDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const ownerName = (lead.ownerName || "Unknown").trim();
    // v20.7.9 — Per-side deal creation using the sidesSet. Renter path currently
    // reuses the Buyers pipeline with a "Rental" tag on the deal until Alex
    // creates a real Renters pipeline in FUB and provides the IDs. This keeps
    // rental deals visible in the FUB pipeline instead of being silently dropped.
    const sides: Array<{ side: "sell" | "buy" | "rent"; pipelineId: number; stageId: number; nameSuffix: string; extraTag?: string }> = [];
    if (sidesSet.has("seller")) {
      sides.push({ side: "sell", pipelineId: SELLERS_PIPELINE_ID, stageId: SELLERS_STAGE_INTERESTED, nameSuffix: "Sell Side" });
    }
    if (sidesSet.has("buyer")) {
      sides.push({ side: "buy",  pipelineId: BUYERS_PIPELINE_ID,  stageId: BUYERS_STAGE_INTERESTED,  nameSuffix: "Buy Side" });
    }
    if (sidesSet.has("renter")) {
      sides.push({ side: "rent", pipelineId: BUYERS_PIPELINE_ID,  stageId: BUYERS_STAGE_INTERESTED,  nameSuffix: "Rental Side", extraTag: "Rental" });
    }

    // v20.7.18 — DEAL-LEVEL DEDUP. Before creating any deal, query FUB for
    // existing open deals on this person in the same pipeline. Alex's rule:
    // never a duplicate lead, but a same person buying a SECOND property is
    // legitimate and should create a new deal. So the dedup key is:
    //   (personId, pipelineId, address in name/description)
    // If we find an open deal on this pipeline whose name/description already
    // references THIS same subject address, skip creation. If they're at a
    // different address (new property), create the new deal.
    // Stages considered "open" for dedup purposes: everything except Won/Lost.
    //
    // Address normalization: strip case, collapse whitespace, trim commas.
    const normalizeAddr = (s?: string): string => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/,+/g, ",").trim();
    const subjectAddrNorm = normalizeAddr(addressStr || undefined);

    // One lookup per pipeline is enough (Sellers and Buyers may share deals list).
    // FUB's /deals accepts ?personId=&pipelineId=&limit=; we only need open deals.
    const openDealsByPipeline: Record<number, any[]> = {};
    for (const s of sides) {
      if (openDealsByPipeline[s.pipelineId]) continue;
      const dealSearch = await fubRequest("GET", `/deals?personId=${personId}&pipelineId=${s.pipelineId}&limit=50`);
      const rows = Array.isArray(dealSearch.data?.deals) ? dealSearch.data.deals : [];
      // Filter out closed/won/lost deals — those don't block a fresh deal.
      // FUB deal status field is `status` with values: Open / Won / Lost (typical).
      // Some tenants use `stageName` including "Won" / "Lost" tokens. Guard both.
      openDealsByPipeline[s.pipelineId] = rows.filter((d: any) => {
        const status = String(d?.status || "").toLowerCase();
        const stageName = String(d?.stageName || "").toLowerCase();
        if (status === "won" || status === "lost" || status === "closed") return false;
        if (stageName.includes("won") || stageName.includes("lost") || stageName.includes("closed")) return false;
        return true;
      });
    }

    for (const s of sides) {
      // Dedup check: does an open deal for this pipeline already reference this address?
      const existingOpen = (openDealsByPipeline[s.pipelineId] || []).filter((d: any) => {
        // Match by address token in name OR description. If subject address is
        // empty, fall back to "any open deal on this pipeline for this person"
        // (better to skip than to spawn a fresh deal every retry).
        if (!subjectAddrNorm) return true;
        const hay = `${d?.name || ""} ${d?.description || ""}`.toLowerCase();
        return hay.includes(subjectAddrNorm);
      });
      if (existingOpen.length > 0) {
        const first = existingOpen[0];
        console.log(`[FUB] Deal dedup: person ${personId} already has open ${s.side} deal id=${first.id} name='${first.name}' matching address='${subjectAddrNorm || "(none)"}' — skipping create`);
        continue;
      }

      const dealPayload: any = {
        name: `${ownerName} — ${s.nameSuffix}`,
        stageId: s.stageId,
        personIds: [personId],
        assignedUserId: undefined, // resolved below by name lookup
        projectedCloseDate: closeDate,
        description: `Auto-created by Lead Depot on Meet & Greet with ${agent.name}. Address: ${addressStr || "—"}. Intention: ${intention || "—"}.`,
      };
      if (dealValue) dealPayload.price = dealValue;

      const dealRes = await fubRequest("POST", `/deals`, dealPayload);
      if (dealRes.ok) {
        console.log(`[FUB] Deal created (${s.side}) for person ${personId}: ${dealPayload.name} — deal id=${dealRes.data?.id}`);
      } else {
        console.error(`[FUB] Failed to create ${s.side} deal:`, dealRes.status, dealRes.data);
      }
    }
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

// ─── COLD OUTCOME SYNC-BACK — keeps FUB record fresh after LD state changes ────────
// v20.7.9 — Prior to this, once a lead was pushed to FUB via KIT/Appt, any
// subsequent cold outcome (Recycle / Not Interested / Wrong # / No Answer /
// Nice Not Interested) never touched FUB. The record sat in Nurture or Hot
// Prospect stage with an Action Plan running forever, even after the lead was
// dead. This helper looks up the FUB person by phone (only if they already
// exist — no new records created) and appends a status note. On terminal
// outcomes (not_interested, wrong_number) it also moves the stage to Unresponsive.
// This is idempotent — if the person doesn't exist in FUB, it's a no-op.
export async function pushColdOutcomeToFub(opts: {
  phone?: string;
  ownerName?: string;
  outcome: string; // recycled | contacted_not_interested | wrong_number | no_answer | nice_not_interested
  agentName?: string;
  notes?: string;
}): Promise<void> {
  if (!FUB_API_KEY) return;
  const { phone, outcome, agentName, notes, ownerName } = opts;
  if (!phone) return; // Nothing to match on.

  // Only sync-back on outcomes that meaningfully change lead state.
  const COLD_OUTCOMES = new Set([
    "recycled",
    "contacted_not_interested",
    "wrong_number",
    "nice_not_interested",
    "disconnected",
  ]);
  if (!COLD_OUTCOMES.has(outcome)) return;

  try {
    // Look up person by phone (only match — don't create).
    const cleanedPhone = String(phone).replace(/\D/g, "");
    if (cleanedPhone.length < 10) return;
    const last10 = cleanedPhone.slice(-10);

    const searchRes = await fubRequest("GET", `/people?phone=${encodeURIComponent(last10)}&limit=5`);
    if (!searchRes.ok || !searchRes.data) return;
    const people = (searchRes.data as any)?.people || [];
    if (!Array.isArray(people) || people.length === 0) {
      console.log(`[FUB cold-sync] No FUB person for phone ${last10} — skipping (not previously KIT/Appt'd)`);
      return;
    }

    const person = people[0];
    const personId = person.id;

    // Compose the note body.
    const outcomeLabels: Record<string, string> = {
      recycled:                 "Recycled to shared pool",
      contacted_not_interested: "Not Interested (dead)",
      wrong_number:             "Wrong # (data cleanup)",
      nice_not_interested:      "Nice Not Interested (soft decline, 180d nurture)",
      disconnected:             "Disconnected number",
    };
    const label = outcomeLabels[outcome] || outcome;
    const noteBody = `[Lead Depot Sync] ${label}${agentName ? ` by ${agentName}` : ""}${notes ? ` — ${notes}` : ""}${ownerName ? ` (${ownerName})` : ""} at ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EDT`;
    const noteRes = await fubRequest("POST", "/notes", {
      personId,
      body: noteBody,
      isHtml: false,
    });
    if (noteRes.ok) {
      console.log(`[FUB cold-sync] Note posted to person ${personId} (${label})`);
    } else {
      console.error(`[FUB cold-sync] Failed to post note:`, noteRes.status, noteRes.data);
    }

    // For terminal outcomes, also move stage to Unresponsive (blank-slate).
    const TERMINAL = new Set(["contacted_not_interested", "wrong_number", "disconnected"]);
    if (TERMINAL.has(outcome)) {
      const stageRes = await fubRequest("PUT", `/people/${personId}`, {
        stage: "Unresponsive",
      });
      if (stageRes.ok) {
        console.log(`[FUB cold-sync] Person ${personId} stage → Unresponsive`);
      } else {
        console.error(`[FUB cold-sync] Failed to update stage:`, stageRes.status, stageRes.data);
      }
    }
  } catch (err: any) {
    console.error(`[FUB cold-sync] Error:`, err?.message || err);
  }
}

// ─── INGEST-TIME FUB PUSH — warm-lead capture goes to FUB immediately ────────
// v20.7.11 — Whenever a warm lead is captured (Network Referral, Open House Lead,
// Door Knock Lead, Direct Mail Lead, Add Lead, external API ingest), push a
// lightweight FUB record with the right intent tags + "New Referral" tag +
// Nurture stage. NO Action Plan is installed — the agent's first-touch KIT/Appt
// still owns Action Plan installation. This ensures FUB has the person from day
// one so smart lists and reporting are complete.
//
// Idempotent — if the phone already exists in FUB, no-op (returns silently).
export async function pushIngestToFub(opts: {
  ownerName: string;
  phone: string;
  email?: string;
  address?: string;
  agentId?: number | null;
  agentName?: string;
  source: string;         // network | open_house | door_knock | direct_mail | social_post | api_ingest | csv_upload
  intent?: string | null; // buyer | seller | renter | seller_and_buyer | seller_and_renter | future_*
  notes?: string;
}): Promise<void> {
  if (!FUB_API_KEY) return;
  const { ownerName, phone, email, address, agentId, agentName, source, intent, notes } = opts;
  if (!ownerName || !phone) return;

  try {
    // Idempotency check — skip if person already in FUB.
    const cleaned = String(phone).replace(/\D/g, "");
    if (cleaned.length < 10) return;
    const last10 = cleaned.slice(-10);
    const searchRes = await fubRequest("GET", `/people?phone=${encodeURIComponent(last10)}&limit=1`);
    if (searchRes.ok) {
      const people = (searchRes.data as any)?.people || [];
      if (Array.isArray(people) && people.length > 0) {
        console.log(`[FUB ingest] Person exists for ${last10} — skipping ingest push (id=${people[0].id})`);
        return;
      }
    }

    // Map LD intent → buildTags-style intent so tags come out right.
    // (buildTags is scoped to the KIT/Appt flow; we replicate the intent → tag
    //  logic here so ingest tags stay identical to what KIT/Appt would emit.)
    const intentMap: Record<string, string> = {
      buyer: "buy_only",
      seller: "sell_only",
      renter: "rent_only",
      seller_and_buyer: "sell_and_buy",
      seller_and_renter: "sell_and_rent",
      future_buyer: "buy_only",
      future_seller: "sell_only",
      future_renter: "rent_only",
      future_seller_and_buyer: "sell_and_buy",
      future_seller_and_renter: "sell_and_rent",
    };
    const mappedIntent = intent ? (intentMap[intent] || "") : "";

    // Build tags (compact, no Action Plan tags — those come at KIT/Appt).
    const tags: string[] = ["LeadDepot", "New Referral"];
    // Intent tags (mirror buildTags exactly for single/combo coverage)
    if (mappedIntent === "sell_only")     tags.push("Seller");
    if (mappedIntent === "buy_only")      tags.push("Buyer");
    if (mappedIntent === "sell_and_buy") { tags.push("Seller"); tags.push("Buyer"); tags.push("Buy&Sell"); }
    if (mappedIntent === "rent_only")     tags.push("Renter");
    if (mappedIntent === "sell_and_rent") { tags.push("Seller"); tags.push("Renter"); tags.push("Sell&Rent"); }
    // Future-* leads get an additional tag so nurture cadence differs
    if (intent && /^future_/.test(intent)) tags.push("Future Lead");

    // Source tag
    const sourceTagMap: Record<string, string> = {
      network: "Source:Network Referral",
      open_house: "Source:Open House",
      door_knock: "Source:Door Knock",
      direct_mail: "Source:Direct Mail",
      social_post: "Source:Social Post",
      api_ingest: "Source:External API",
      csv_upload: "Source:CSV Upload",
    };
    if (sourceTagMap[source]) tags.push(sourceTagMap[source]);

    // Split name
    const nameParts = String(ownerName).trim().split(/\s+/);
    const firstName = nameParts[0] || ownerName;
    const lastName  = nameParts.slice(1).join(" ") || "";

    // Assign to the submitting agent if we have a mapping; otherwise leave unassigned.
    // FUB user mapping: Nate=1, Alex=2, Denise=16 (leaders). Other agents fall back
    // to name-lookup (best-effort — skip assignment if no FUB user found).
    const FUB_USER_MAP: Record<string, number> = {
      "Nate Watson": 1, "Nate": 1,
      "Alex Watson": 2, "Alex": 2,
      "Denise": 16,
    };
    const assignedFubUserId = agentName ? FUB_USER_MAP[agentName] : undefined;

    // Person payload
    const personPayload: any = {
      firstName,
      lastName,
      emails: email ? [{ value: email, type: "work" }] : [],
      phones: [{ value: phone, type: "mobile" }],
      addresses: address ? [{ street: address, type: "home" }] : [],
      source: "Lead Depot",
      sourceUrl: "https://depot.watsonbrothersgroup.com",
      stage: "Nurture",
      tags,
      collaboratorIds: [1, 2, 16], // Nate, Alex, Denise — leaders always cc'd
    };
    if (assignedFubUserId) personPayload.assignedUserId = assignedFubUserId;
    // person.type per intent (mirror KIT logic)
    if (mappedIntent === "sell_only" || mappedIntent === "sell_and_buy" || mappedIntent === "sell_and_rent") personPayload.type = "Seller";
    else if (mappedIntent === "buy_only") personPayload.type = "Buyer";
    else if (mappedIntent === "rent_only") personPayload.type = "Renter";

    // POST /people (creates the person; Action Plans handled at first KIT/Appt)
    const createRes = await fubRequest("POST", "/people", personPayload);
    if (!createRes.ok) {
      console.error(`[FUB ingest] Failed to create person for ${firstName} ${lastName}:`, createRes.status, createRes.data);
      return;
    }
    const personId = (createRes.data as any)?.id;
    if (!personId) {
      console.error(`[FUB ingest] Created person response missing id:`, createRes.data);
      return;
    }

    // Attach a note describing the ingest.
    const noteBody = `[Lead Depot Ingest] Source: ${source.replace(/_/g, " ")}${agentName ? ` by ${agentName}` : ""}${address ? ` at ${address}` : ""}${notes ? `\n\nNotes: ${notes.slice(0, 500)}` : ""}`;
    await fubRequest("POST", "/notes", {
      personId,
      body: noteBody,
      isHtml: false,
    });

    console.log(`[FUB ingest] Created person ${personId} for ${firstName} ${lastName} (source=${source}, intent=${intent || "?"})`);
  } catch (err: any) {
    console.error(`[FUB ingest] Error:`, err?.message || err);
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

// ─── v15.5 — Onboarding candidate (Stage 4: post-yes) ────────────────────
// Different from fubCreateAgentRecruit (which handles Stage-1 cold inquiries
// from the public /join form). This is for the admin-initiated invite AFTER
// a real-world conversation ended in "yes, I want to look at this seriously".
//
// Entry path drives FUB stage + tags per the locked grid:
//   1) dbpr_phone_kit         → Agent Recruit Lead  (Nurture tier)
//   2) f2f_nurture            → Agent Recruit Lead  (Nurture tier)
//   3) phone_tell_me_more     → Agent Prospect      (Hot Prospect tier)
//   4) f2f_hot_prospect       → Agent Prospect      (Hot Prospect tier)
//   5) marketing_phone_yes    → Vendor              (Vendor tier)
//   6) f2f_sit_down_yes       → Vendor              (Vendor tier)
//   7) referral_yes           → Vendor              (Vendor tier)
export type CandidateEntryPath =
  | "dbpr_phone_kit"
  | "f2f_nurture"
  | "phone_tell_me_more"
  | "f2f_hot_prospect"
  | "marketing_phone_yes"
  | "f2f_sit_down_yes"
  | "referral_yes";

export type CandidateTemperature = "nurture" | "hot_prospect" | "vendor";

export interface EntryPathConfig {
  temperature: CandidateTemperature;
  fubStage: string;      // exact label matching Alex's FUB pipeline
  fubStageId?: number;   // known IDs (Agent Recruit Lead = 31); others left undefined —
                         // stage NAME will be sent and FUB usually honors it. If not,
                         // Alex corrects in FUB manually. Non-blocking.
  extraTags: string[];   // path-specific tags added on top of default recruiting tags
  humanLabel: string;    // shown in admin UI + Nate brief
}

export const ENTRY_PATH_CONFIG: Record<CandidateEntryPath, EntryPathConfig> = {
  dbpr_phone_kit: {
    temperature: "nurture",
    fubStage: "Agent Recruit Lead",
    fubStageId: 31,
    extraTags: ["DBPR List", "Phone", "Nurture"],
    humanLabel: "DBPR list → phone KIT",
  },
  f2f_nurture: {
    temperature: "nurture",
    fubStage: "Agent Recruit Lead",
    fubStageId: 31,
    extraTags: ["F2F", "Networking", "Nurture"],
    humanLabel: "F2F networking — dream alive",
  },
  phone_tell_me_more: {
    temperature: "hot_prospect",
    fubStage: "Agent Prospect",
    extraTags: ["Phone", "Warm"],
    humanLabel: "Phone — tell me more",
  },
  f2f_hot_prospect: {
    temperature: "hot_prospect",
    fubStage: "Agent Prospect",
    extraTags: ["F2F", "Warm"],
    humanLabel: "F2F — hot prospect",
  },
  marketing_phone_yes: {
    temperature: "vendor",
    fubStage: "Vendor",
    extraTags: ["Marketing-primed", "Phone", "BGRE Agent - Onboarding"],
    humanLabel: "Marketing-primed — phone yes",
  },
  f2f_sit_down_yes: {
    temperature: "vendor",
    fubStage: "Vendor",
    extraTags: ["F2F", "BGRE Agent - Onboarding"],
    humanLabel: "F2F sit-down — said yes",
  },
  referral_yes: {
    temperature: "vendor",
    fubStage: "Vendor",
    extraTags: ["Referral", "BGRE Agent - Onboarding"],
    humanLabel: "Referral — said yes",
  },
};

export interface CandidateFubPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  entryPath: CandidateEntryPath;
  invitedByName?: string;    // "Alex Watson" or "Nate Watson" for the note
  applicationUrl: string;    // the /join/:token URL Alex generated
}

// Creates the FUB person, sets the right stage, tags it per the entry path,
// and posts a structured onboarding-intake note. Returns FUB person ID.
// NON-BLOCKING per invitation flow — caller catches errors and continues.
export async function fubCreateCandidate(data: CandidateFubPayload): Promise<number | null> {
  if (!FUB_API_KEY) {
    console.warn("[FUB] FUB_API_KEY not set — skipping fubCreateCandidate");
    return null;
  }

  const cfg = ENTRY_PATH_CONFIG[data.entryPath];
  if (!cfg) {
    console.error(`[FUB] Unknown entry path: ${data.entryPath}`);
    return null;
  }

  const tags = ["Recruiting", "Candidate", ...cfg.extraTags];

  const noteLines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Lead Depot — Onboarding Candidate Invited`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Invited: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EDT`,
    `Invited by: ${data.invitedByName || "Lead Depot admin"}`,
    ``,
    `── ENTRY PATH ────────────────`,
    `Path: ${cfg.humanLabel}`,
    `Temperature: ${cfg.temperature.replace("_", " ")}`,
    `Stage: ${cfg.fubStage}`,
    ``,
    `── NEXT STEP ────────────────`,
    `Application link: ${data.applicationUrl}`,
    ``,
    `Application status will be updated in Lead Depot as they progress.`,
    `Source: depot.watsonbrothersgroup.com`,
  ];

  const eventPayload: any = {
    source: "Lead Depot Onboarding",
    system: FUB_SYSTEM,
    type: "Agent Inquiry",
    message: `Onboarding candidate invited — ${data.firstName} ${data.lastName} (${cfg.humanLabel})`,
    sourceUrl: "https://depot.watsonbrothersgroup.com",
    person: {
      firstName: data.firstName,
      lastName: data.lastName,
      stage: cfg.fubStage,
      tags,
      assignedTo: "Alex Watson",
    },
  };

  if (data.phone) eventPayload.person.phones = [{ value: data.phone }];
  if (data.email) eventPayload.person.emails = [{ value: data.email }];

  console.log(`[FUB] Pushing candidate: ${data.firstName} ${data.lastName} (${cfg.humanLabel} → ${cfg.fubStage})`);
  const result = await fubRequest("POST", "/events", eventPayload);

  if (!result.ok) {
    console.error("[FUB] Failed to push candidate:", result.data);
    return null;
  }

  const personId = result.data?.person?.id ?? null;

  if (personId) {
    // Force stage via PUT if we know the ID (name-only can be silently ignored)
    if (cfg.fubStageId) {
      await fubRequest("PUT", `/people/${personId}`, { stageId: cfg.fubStageId });
      console.log(`[FUB] Candidate stage forced → ${cfg.fubStage} (id=${cfg.fubStageId}) for person ${personId}`);
    } else {
      // No known ID — rely on stage name from POST. Try PUT with stage string as fallback.
      const putRes = await fubRequest("PUT", `/people/${personId}`, { stage: cfg.fubStage });
      console.log(`[FUB] Candidate stage set via name → ${cfg.fubStage} for person ${personId} (put ok=${putRes.ok})`);
    }

    // Post the intake note
    await fubRequest("POST", "/notes", {
      personId,
      body: noteLines.join("\n"),
      isHtml: false,
    });
    console.log(`[FUB] Candidate note posted — person ${personId}`);
  }

  return personId;
}

// ─── v15.6 — Post questionnaire submission note + tag update ────────────────
// Called from POST /api/candidates/by-token/:token/submit after saving locally.
// NON-BLOCKING — caller catches errors.
export interface CandidateSubmitFubPayload {
  fubPersonId: number;
  candidateName: string;
  recommendation: string;        // STRONG_FIT | WORTH_A_CALL | SOFT_PASS | HARD_PASS
  score: number;                 // 0..100
  reason: string;                // one-line
  questionnaireBody: string;     // formatted answer dump
}

export async function fubPostQuestionnaireNote(payload: CandidateSubmitFubPayload): Promise<boolean> {
  if (!FUB_API_KEY) {
    console.warn("[FUB] FUB_API_KEY not set — skipping fubPostQuestionnaireNote");
    return false;
  }

  const noteBody = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Lead Depot — Application Submitted`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Recommendation: ${payload.recommendation} (${payload.score}/100)`,
    `Reason: ${payload.reason}`,
    ``,
    `Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EDT`,
    `Candidate: ${payload.candidateName}`,
    ``,
    `── QUESTIONNAIRE ──────────────`,
    payload.questionnaireBody,
    ``,
    `Review in Admin Dashboard: https://depot.watsonbrothersgroup.com`,
  ].join("\n");

  const noteRes = await fubRequest("POST", "/notes", {
    personId: payload.fubPersonId,
    body: noteBody,
    isHtml: false,
  });
  if (!noteRes.ok) {
    console.error("[FUB] Failed to post questionnaire note:", noteRes.data);
    return false;
  }
  console.log(`[FUB] Questionnaire note posted — person ${payload.fubPersonId}`);

  // Refresh tags: fetch current, add "Application Submitted", keep the rest
  const getRes = await fubRequest("GET", `/people/${payload.fubPersonId}`, undefined);
  const existingTags: string[] = Array.isArray(getRes.data?.tags) ? getRes.data.tags : [];
  const nextTags = Array.from(new Set([...existingTags, "Application Submitted"]));
  const putRes = await fubRequest("PUT", `/people/${payload.fubPersonId}`, { tags: nextTags });
  if (!putRes.ok) {
    console.warn("[FUB] Failed to update tags after submit:", putRes.data);
    return false;
  }
  console.log(`[FUB] Tags updated — person ${payload.fubPersonId} (added Application Submitted)`);
  return true;
}

// ─── v20.2 — Approve flow: create Vendor + set Person Stage=Vendor + create user seat
// Called by POST /api/admin/candidates/:id/approve after the local agent row is created.
// NON-BLOCKING per approve flow — caller catches errors and continues.
export interface AgentApprovalFubPayload {
  candidateId: number;
  agentId: number;            // local Lead Depot agent id (for note reference)
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  invitedByName: string | null;
  questionnaireSummary: string; // pre-formatted bullet block from approve endpoint
  // v20.1 test-mode redirect flag — when true we log the payloads and use the test email
  // for the FUB Person + User records so a fake test approve doesn't create a real Vendor
  // or burn a $69/mo seat on the account.
  isTestApproval?: boolean;
  testInbox?: string;
}

export interface AgentApprovalFubResult {
  personId: number | null;    // FUB Person row (Vendor)
  userId: number | null;      // FUB User row (Agent seat)
  vendorNoteId: number | null;
  skipped: string[];
  errors: string[];
  // v20.4.9 — Pro plan seat accounting. Set when this approve creates a seat.
  //  seatUsageBefore/After: total billable seats visible in FUB before/after.
  //  includedSeats: 10 on Pro (contract cap).
  //  overageTriggered: true when the newly-created seat pushed the total > includedSeats.
  seatUsageBefore?: number;
  seatUsageAfter?: number;
  includedSeats?: number;
  overageTriggered?: boolean;
}

// v20.4.9 — FUB Pro plan seat cap. First 10 users included in the $499/mo base;
// each additional seat is $49/mo. Use fubGetSeatUsage() to check headroom before
// approve or from the admin dashboard.
export const FUB_PRO_INCLUDED_SEATS = 10;
export const FUB_PRO_OVERAGE_PER_SEAT_USD = 49;

export interface FubSeatUsage {
  used: number;              // total non-disabled billable seats currently in FUB
  included: number;          // 10 on Pro
  remaining: number;         // included - used, floored at 0
  overageSeats: number;      // seats above included, 0 if under cap
  overageMonthlyCost: number;// overageSeats * $49
  users: Array<{ id: number; email: string; role: string; name: string }>;
  fetchedAt: string;
  error?: string;
}

// Fetch current FUB user seat usage. Called by approve flow (to detect overage)
// and by the admin dashboard (to display headroom).
export async function fubGetSeatUsage(): Promise<FubSeatUsage> {
  const base: FubSeatUsage = {
    used: 0,
    included: FUB_PRO_INCLUDED_SEATS,
    remaining: FUB_PRO_INCLUDED_SEATS,
    overageSeats: 0,
    overageMonthlyCost: 0,
    users: [],
    fetchedAt: new Date().toISOString(),
  };
  if (!FUB_API_KEY) {
    base.error = "no_api_key";
    return base;
  }
  const res = await fubRequest("GET", "/users?limit=100");
  if (!res.ok || !Array.isArray(res.data?.users)) {
    base.error = `fetch_failed:${res.status}`;
    return base;
  }
  // Every non-disabled user counts against the seat cap regardless of role
  // (FUB bills disabled users as $0). Guard against a missing `disabled` field
  // by treating undefined as false.
  const users = res.data.users.filter((u: any) => !u.disabled);
  base.users = users.map((u: any) => ({
    id: u.id,
    email: String(u.email || ""),
    role: String(u.role || ""),
    name: String(u.name || ""),
  }));
  base.used = users.length;
  base.remaining = Math.max(0, base.included - base.used);
  base.overageSeats = Math.max(0, base.used - base.included);
  base.overageMonthlyCost = base.overageSeats * FUB_PRO_OVERAGE_PER_SEAT_USD;
  return base;
}

export async function fubApproveAgentAsVendor(payload: AgentApprovalFubPayload): Promise<AgentApprovalFubResult> {
  const result: AgentApprovalFubResult = {
    personId: null,
    userId: null,
    vendorNoteId: null,
    skipped: [],
    errors: [],
  };

  if (!FUB_API_KEY) {
    console.warn("[FUB] FUB_API_KEY not set — skipping fubApproveAgentAsVendor");
    result.skipped.push("no_api_key");
    return result;
  }

  // v20.1 test-mode: don't touch real FUB records for test approves. Just log what
  // would have happened so Alex can verify shape.
  if (payload.isTestApproval) {
    console.log(`[FUB approve/test-mode] Would create Vendor + Agent seat for ${payload.fullName} <${payload.email}>. SKIPPING real FUB calls (test mode).`);
    result.skipped.push("test_mode_active");
    return result;
  }

  // v20.4.9 — Pro plan seat accounting. Snapshot pre-approve usage so we can
  // detect whether this approve pushed us into $49/mo overage territory.
  const seatsBefore = await fubGetSeatUsage();
  result.seatUsageBefore = seatsBefore.used;
  result.includedSeats = seatsBefore.included;
  if (seatsBefore.remaining <= 0 && !seatsBefore.error) {
    console.warn(`[FUB approve] SEAT OVERAGE INCOMING — currently at ${seatsBefore.used}/${seatsBefore.included} included seats. Approving ${payload.fullName} will add a $${FUB_PRO_OVERAGE_PER_SEAT_USD}/mo seat.`);
  } else if (!seatsBefore.error) {
    console.log(`[FUB approve] Pro seat headroom: ${seatsBefore.used}/${seatsBefore.included} used, ${seatsBefore.remaining} remaining before overage.`);
  }

  const displayName = payload.fullName;

  // 1. Find existing FUB Person by email (preferred) or phone. Dedup before creating.
  let personId: number | null = null;
  if (payload.email) {
    const q = encodeURIComponent(payload.email);
    const findRes = await fubRequest("GET", `/people?query=${q}&limit=1`);
    if (findRes.ok && findRes.data?.people?.length) {
      personId = findRes.data.people[0].id;
      console.log(`[FUB approve] Existing Person found by email → id=${personId}`);
    }
  }
  if (!personId && payload.phone) {
    const q = encodeURIComponent(payload.phone);
    const findRes = await fubRequest("GET", `/people?query=${q}&limit=1`);
    if (findRes.ok && findRes.data?.people?.length) {
      personId = findRes.data.people[0].id;
      console.log(`[FUB approve] Existing Person found by phone → id=${personId}`);
    }
  }

  // 2. If no existing Person, create one via /events (per fub.ts hard rule — never POST /people).
  //    Set Stage=Vendor + tags on creation.
  const tagsForApproved = ["Recruiting", "Approved Agent", "Team", "Brothers Group"];

  if (!personId) {
    const eventPayload: any = {
      source: "Lead Depot Approval",
      system: FUB_SYSTEM,
      type: "Registration",
      message: `Agent approved to Brothers Group — ${displayName}`,
      sourceUrl: "https://depot.watsonbrothersgroup.com",
      person: {
        firstName: payload.firstName,
        lastName:  payload.lastName,
        stage:     "Vendor",
        tags:      tagsForApproved,
        assignedTo: "Alex Watson",
      },
    };
    if (payload.email) eventPayload.person.emails = [{ value: payload.email }];
    if (payload.phone) eventPayload.person.phones = [{ value: payload.phone }];

    const evRes = await fubRequest("POST", "/events", eventPayload);
    if (!evRes.ok) {
      console.error("[FUB approve] Failed to create Person via /events:", evRes.data);
      result.errors.push(`person_create_failed:${evRes.status}`);
    } else {
      personId = evRes.data?.person?.id ?? null;
      console.log(`[FUB approve] Person created → id=${personId} (Stage=Vendor)`);
    }
  }

  // 3. Force Stage=Vendor and merge tags. Do this whether the Person was found or created —
  //    an existing Recruit Lead needs to get moved to Vendor now that they're approved.
  if (personId) {
    // Merge tags on top of whatever the Person already has.
    const getRes = await fubRequest("GET", `/people/${personId}`);
    const existingTags: string[] = Array.isArray(getRes.data?.tags) ? getRes.data.tags : [];
    const nextTags = Array.from(new Set([...existingTags, ...tagsForApproved]));

    const putRes = await fubRequest("PUT", `/people/${personId}`, {
      stage: "Vendor",
      tags:  nextTags,
    });
    if (!putRes.ok) {
      console.error(`[FUB approve] Failed to force Stage=Vendor for Person ${personId}:`, putRes.data);
      result.errors.push(`stage_put_failed:${putRes.status}`);
    } else {
      console.log(`[FUB approve] Stage=Vendor forced + tags merged for Person ${personId}`);
    }

    // Post an approval note
    const noteBody = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "Lead Depot — Agent Approved",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `Approved: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EDT`,
      `Invited by: ${payload.invitedByName || "Lead Depot admin"}`,
      `Local Lead Depot agent ID: ${payload.agentId}`,
      "",
      "── STAGE MOVED ──",
      "→ Vendor (approved agent, active on team)",
      "",
      "── QUESTIONNAIRE ──",
      payload.questionnaireSummary || "(no answers on file)",
      "",
      "── PARALLEL ONBOARDING ──",
      "• Momentum brokerage kickoff email sent to Brittany + Michelle",
      "• Team onboarding brief sent to Nate (CC Alex, Denise)",
      "• Setup link email sent to candidate",
      "",
      "Source: depot.watsonbrothersgroup.com",
    ].join("\n");

    const noteRes = await fubRequest("POST", "/notes", {
      personId,
      body: noteBody,
      isHtml: false,
    });
    if (noteRes.ok) {
      result.vendorNoteId = noteRes.data?.id ?? null;
      console.log(`[FUB approve] Approval note posted → note ${result.vendorNoteId}`);
    } else {
      console.warn("[FUB approve] Note post failed:", noteRes.data);
      result.errors.push(`note_failed:${noteRes.status}`);
    }
  }
  result.personId = personId;

  // 4. Create the FUB User seat (Agent role). On Pro, the first 10 users are
  //    included in the $499/mo base; seats 11+ cost $49/mo. Approving is never
  //    blocked by seat cost — we just surface the overage state to the admin.
  //    Skip if a user with this email already exists (idempotent — approve twice = one seat).
  if (!payload.email) {
    console.warn("[FUB approve] No candidate email — cannot create FUB User seat");
    result.skipped.push("user_no_email");
  } else {
    // Check existing users by email
    const existingRes = await fubRequest("GET", `/users?limit=100`);
    if (existingRes.ok && Array.isArray(existingRes.data?.users)) {
      const match = existingRes.data.users.find(
        (u: any) => String(u.email || "").toLowerCase() === payload.email.toLowerCase()
      );
      if (match) {
        result.userId = match.id;
        console.log(`[FUB approve] User seat already exists → id=${match.id} (skipping create, no new seat charge)`);
        result.skipped.push("user_already_exists");
      }
    }

    if (!result.userId) {
      // POST /v1/users — creates a new billable Agent seat.
      const userPayload = {
        name:  displayName,
        email: payload.email,
        role:  "Agent",
      };
      const createRes = await fubRequest("POST", "/users", userPayload);
      if (createRes.ok) {
        result.userId = createRes.data?.id ?? null;
        console.log(`[FUB approve] User seat CREATED → id=${result.userId}`);
      } else {
        console.error("[FUB approve] User seat creation failed:", createRes.status, createRes.data);
        result.errors.push(`user_create_failed:${createRes.status}`);
      }
    }
  }

  // v20.4.9 — Post-approve seat accounting. Fetch again so the caller (and the
  // Nate brief / admin dashboard) know whether this approve triggered overage.
  try {
    const seatsAfter = await fubGetSeatUsage();
    if (!seatsAfter.error) {
      result.seatUsageAfter = seatsAfter.used;
      const before = result.seatUsageBefore ?? seatsAfter.used;
      result.overageTriggered = before < FUB_PRO_INCLUDED_SEATS && seatsAfter.used > FUB_PRO_INCLUDED_SEATS;
      if (result.overageTriggered) {
        console.warn(`[FUB approve] Seat overage TRIGGERED by this approve. Now at ${seatsAfter.used}/${seatsAfter.included} — next FUB invoice will include $${FUB_PRO_OVERAGE_PER_SEAT_USD}/mo overage.`);
      }
    }
  } catch (err: any) {
    console.warn("[FUB approve] Post-approve seat usage check failed:", err?.message);
  }

  return result;
}

// ─── v20.4.9 — TAG SCAN + OPPORTUNITY / BUYER SWEEP ────────────────────────────

export type FubTag = { name: string; peopleCount?: number };

/**
 * v20.4.9 — List all FUB tags in the account. Used by Admin → Inventory Sources
 * to configure which tags feed the Pocket Listing bucket and which feed the
 * Active Buyer bucket.
 */
export async function fubListTags(): Promise<FubTag[]> {
  if (!FUB_API_KEY) return [];
  try {
    // v20.4.9b — FUB has no documented /v1/tags account-wide list endpoint.
    // Try the undocumented endpoints first (in case FUB adds them), then fall
    // back to aggregating from /v1/people?fields=tags across pages.
    const endpoints = [
      "https://api.followupboss.com/v1/people/tags?limit=250",
      "https://api.followupboss.com/v1/tags?limit=250",
    ];
    for (const url of endpoints) {
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: fubAuth(),
            "X-System": "LeadDepot",
            "X-System-Key": FUB_API_KEY,
          },
        });
        if (!r.ok) continue;
        const data: any = await r.json();
        const raw: any[] = data.tags || data.data || (Array.isArray(data) ? data : []);
        const tags = raw
          .map(t => (typeof t === "string" ? { name: t } : { name: String(t.name || t.tag || ""), peopleCount: t.peopleCount || t.count }))
          .filter(t => t.name);
        if (tags.length > 0) return tags.sort((a, b) => a.name.localeCompare(b.name));
      } catch { /* try next */ }
    }

    // Fallback: aggregate tags from /v1/people pages (up to 5k people scanned).
    const counts = new Map<string, number>();
    const pageSize = 100;
    let offset = 0;
    let scanned = 0;
    const maxScan = 5000;
    while (scanned < maxScan) {
      const url = `https://api.followupboss.com/v1/people?limit=${pageSize}&offset=${offset}&fields=tags`;
      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: fubAuth(),
          "X-System": "LeadDepot",
          "X-System-Key": FUB_API_KEY,
        },
      });
      if (!r.ok) break;
      const data: any = await r.json();
      const people: any[] = data.people || data.data || [];
      if (people.length === 0) break;
      for (const p of people) {
        const tags: any[] = Array.isArray(p.tags) ? p.tags : [];
        for (const t of tags) {
          const name = typeof t === "string" ? t : String(t?.name || "");
          if (!name) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      scanned += people.length;
      offset += pageSize;
      if (people.length < pageSize) break;
    }
    const out: FubTag[] = [];
    for (const [name, peopleCount] of counts.entries()) out.push({ name, peopleCount });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: any) {
    console.warn("[FUB] fubListTags failed:", err?.message);
    return [];
  }
}

/**
 * v20.4.9 — Return the list of people (with property + preference data) tagged
 * with a specific FUB tag. Paginated automatically.
 */
export async function fubListPeopleByTag(tag: string, limitPerPage = 100): Promise<any[]> {
  if (!FUB_API_KEY || !tag) return [];
  const all: any[] = [];
  let offset = 0;
  const maxPages = 20; // hard cap 2000 people per tag
  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `https://api.followupboss.com/v1/people?tags=${encodeURIComponent(tag)}&limit=${limitPerPage}&offset=${offset}&fields=allFields`;
      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: fubAuth(),
          "X-System": "LeadDepot",
          "X-System-Key": FUB_API_KEY,
        },
      });
      if (!r.ok) break;
      const data: any = await r.json();
      const people: any[] = data.people || [];
      all.push(...people);
      if (people.length < limitPerPage) break;
      offset += limitPerPage;
    } catch (err: any) {
      console.warn(`[FUB] fubListPeopleByTag(${tag}) failed at offset ${offset}:`, err?.message);
      break;
    }
  }
  return all;
}

/**
 * v20.4.9 — Extract the best available property address string from a FUB person.
 * FUB stores addresses in multiple shapes across versions; try each.
 */
export function fubPersonAddress(p: any): { address: string | null; city: string | null; state: string | null; zip: string | null } {
  if (!p) return { address: null, city: null, state: null, zip: null };
  const addrs = p.addresses || p.address || [];
  const list = Array.isArray(addrs) ? addrs : [addrs];
  for (const a of list) {
    if (!a) continue;
    const street = a.street || a.line1 || a.streetAddress || a.address1;
    if (street) {
      return {
        address: String(street).trim(),
        city:    a.city ? String(a.city).trim() : null,
        state:   a.state ? String(a.state).trim() : null,
        zip:     a.zip || a.postalCode ? String(a.zip || a.postalCode).trim() : null,
      };
    }
  }
  // Some teams stash property address on customFields as "Property Address"
  const cf = p.customFields || {};
  for (const key of Object.keys(cf)) {
    if (/property.*address|listing.*address/i.test(key) && cf[key]) {
      return { address: String(cf[key]).trim(), city: null, state: null, zip: null };
    }
  }
  return { address: null, city: null, state: null, zip: null };
}

/**
 * v20.4.9 — Buyer preferences from a FUB person's custom fields.
 * FUB has no fixed schema for buyer prefs; scan customFields for known keywords.
 */
// v20.5.0 — Fetch all notes for a FUB person (chronological concat for intent parser)
export async function fubListPersonNotes(personId: string | number, limit = 25): Promise<string> {
  if (!FUB_API_KEY || !personId) return "";
  try {
    const r = await fubRequest("GET", `/notes?personId=${personId}&limit=${limit}&sort=-created`);
    if (!r?.ok) return "";
    const items: any[] = r?.data?.notes || [];
    if (!Array.isArray(items) || !items.length) return "";
    // Concat newest-first, oldest-last, separated by " \u2014 " for parser context
    return items
      .map(n => String(n.body || "").trim())
      .filter(Boolean)
      .join(" \u2014 ");
  } catch (err: any) {
    console.warn(`[FUB] fubListPersonNotes(${personId}) failed:`, err?.message);
    return "";
  }
}

// v20.5.0 — Combine a FUB person's background/customFields/notes into one text blob
//           for the intent parser. Cheap: uses fields already on the person object,
//           optionally calls /notes for deeper history.
export async function fubPersonIntentBlob(p: any, includeNotes = true): Promise<string> {
  const parts: string[] = [];
  if (p.background) parts.push(String(p.background).trim());
  const cf: Record<string, any> = p.customFields || {};
  for (const [k, v] of Object.entries(cf)) {
    if (v == null || v === "") continue;
    // Only include free-text-looking customFields (skip yes/no, dates, numbers-only)
    const sv = String(v).trim();
    if (sv.length > 3 && !/^[0-9.\-\/]+$/.test(sv) && !/^(yes|no|true|false)$/i.test(sv)) {
      parts.push(`[${k}] ${sv}`);
    }
  }
  if (includeNotes && p.id) {
    const notes = await fubListPersonNotes(p.id, 25);
    if (notes) parts.push(notes);
  }
  return parts.join(" \u2014 ").slice(0, 8000); // hard cap to keep parser fast
}

export function fubPersonBuyerPrefs(p: any): {
  price_min: number | null; price_max: number | null;
  beds_min:  number | null; baths_min: number | null; sqft_min: number | null;
  preferred_areas: string | null; timeline: string | null; must_haves: string | null; no_gos: string | null;
  pre_approved: number; lender: string | null;
} {
  const cf: Record<string, any> = p.customFields || {};
  const empty = {
    price_min: null as number | null, price_max: null as number | null,
    beds_min: null as number | null, baths_min: null as number | null, sqft_min: null as number | null,
    preferred_areas: null as string | null, timeline: null as string | null,
    must_haves: null as string | null, no_gos: null as string | null,
    pre_approved: 0, lender: null as string | null,
  };
  const out = { ...empty };
  const priceParse = (v: any): number | null => {
    if (v == null) return null;
    const s = String(v).replace(/[$,\s]/g, "").toLowerCase();
    const m = s.match(/^([0-9.]+)\s*(k|m)?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2] === "k") n *= 1000;
    if (m[2] === "m") n *= 1_000_000;
    return isFinite(n) ? Math.round(n) : null;
  };
  for (const [k, v] of Object.entries(cf)) {
    if (v == null || v === "") continue;
    const lk = k.toLowerCase();
    if (/price.*min|min.*price|budget.*min/.test(lk)) out.price_min = priceParse(v);
    else if (/price.*max|max.*price|budget|price.*range/.test(lk) && !out.price_max) out.price_max = priceParse(v);
    else if (/bed/.test(lk) && !out.beds_min) out.beds_min = parseInt(String(v), 10) || null;
    else if (/bath/.test(lk) && !out.baths_min) out.baths_min = parseFloat(String(v)) || null;
    else if (/sqft|square|size/.test(lk) && !out.sqft_min) out.sqft_min = parseInt(String(v).replace(/,/g,""), 10) || null;
    else if (/area|neighborhood|location|zip/.test(lk) && !out.preferred_areas) out.preferred_areas = String(v).trim();
    else if (/timeline|when|urgency/.test(lk) && !out.timeline) out.timeline = String(v).trim();
    else if (/must.*have|require|need/.test(lk) && !out.must_haves) out.must_haves = String(v).trim();
    else if (/no.*go|exclude|avoid|deal.*break/.test(lk) && !out.no_gos) out.no_gos = String(v).trim();
    else if (/pre.*approv|preapprov/.test(lk)) out.pre_approved = /y|yes|true|1|approved/i.test(String(v)) ? 1 : 0;
    else if (/lender|bank|mortgage/.test(lk) && !out.lender) out.lender = String(v).trim();
  }
  return out;
}

// ─── v20.4.9 — STAGE-BASED SWEEP ────────────────────────────────────────────
// Alex confirmed: only the "Active Client" stage is treated as an active-buyer
// signal for Lead Depot. All other FUB stages (Lead, Nurture, Hot Prospect,
// Past Client, Trash) are ignored by the stage sweep.

/**
 * List people currently in a specific FUB stage. Uses /v1/people?stage=<id-or-name>.
 * FUB accepts either the stage ID or the stage name in the `stage` filter.
 */
export async function fubListPeopleByStage(stageName: string, limitPerPage = 100): Promise<any[]> {
  if (!FUB_API_KEY || !stageName) return [];
  const all: any[] = [];
  let offset = 0;
  const maxScan = 5000;
  while (all.length < maxScan) {
    const url = `https://api.followupboss.com/v1/people?stage=${encodeURIComponent(stageName)}&limit=${limitPerPage}&offset=${offset}&fields=allFields`;
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: fubAuth(),
          "X-System": "LeadDepot",
          "X-System-Key": FUB_API_KEY,
        },
      });
      if (!r.ok) break;
      const data: any = await r.json();
      const people: any[] = data.people || data.data || [];
      if (people.length === 0) break;
      all.push(...people);
      if (people.length < limitPerPage) break;
      offset += limitPerPage;
    } catch (err: any) {
      console.warn(`[FUB] fubListPeopleByStage(${stageName}) failed:`, err?.message);
      break;
    }
  }
  return all;
}

// ─── v20.4.9 — DEAL / OPPORTUNITY SWEEP ─────────────────────────────────────
// FUB Deals are transactions in progress. Buyer-side deals with property
// addresses give us pending listings. Listing-side deals give us active
// listings we might not have in the workbook yet.

export type FubDeal = {
  id: number;
  name?: string;
  stage?: string;
  status?: string;
  type?: string;                // 'buyer' | 'listing' | 'referral' etc
  price?: number;
  commissionValue?: number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  peopleIds?: number[];
  assignedUserName?: string;
  closeDate?: string;
  created?: string;
  updated?: string;
  raw?: any;
};

/**
 * List all open FUB deals. FUB paginates; we cap at 2500 deals to keep the
 * nightly sweep bounded. Endpoint: /v1/deals
 * See https://docs.followupboss.com/reference/deals-get
 */
export async function fubListDeals(limitPerPage = 100): Promise<FubDeal[]> {
  if (!FUB_API_KEY) return [];
  const all: FubDeal[] = [];
  let offset = 0;
  const maxScan = 2500;
  while (all.length < maxScan) {
    const url = `https://api.followupboss.com/v1/deals?limit=${limitPerPage}&offset=${offset}`;
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: fubAuth(),
          "X-System": "LeadDepot",
          "X-System-Key": FUB_API_KEY,
        },
      });
      if (!r.ok) break;
      const data: any = await r.json();
      const rows: any[] = data.deals || data.data || [];
      if (rows.length === 0) break;
      for (const d of rows) {
        const addr = d.address || d.propertyAddress || d.property?.address || {};
        const address = typeof addr === "string" ? addr : (addr.street || addr.line1 || null);
        all.push({
          id: d.id,
          name: d.name,
          stage: d.stage || d.stageName,
          status: d.status,
          type: d.type || d.dealType,
          price: d.price ?? d.value ?? null,
          commissionValue: d.commissionValue ?? null,
          address,
          city:  typeof addr === "object" ? addr.city  : undefined,
          state: typeof addr === "object" ? addr.state : undefined,
          zip:   typeof addr === "object" ? addr.zipCode || addr.zip : undefined,
          peopleIds: d.peopleIds || d.personIds || (d.people || []).map((p: any) => p.id),
          assignedUserName: d.assignedUserName || d.assignedTo,
          closeDate: d.closeDate || d.projectedCloseDate,
          created: d.created,
          updated: d.updated,
          raw: d,
        });
      }
      if (rows.length < limitPerPage) break;
      offset += limitPerPage;
    } catch (err: any) {
      console.warn("[FUB] fubListDeals failed:", err?.message);
      break;
    }
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────
// v20.32.13 Part 4 — Generic FUB milestone-task engine
// Replaces the single hardcoded "Send accolades email" pattern with an
// admin-configurable table of trigger_event -> task definitions. Each app
// lifecycle event (inspection scheduled/completed, repair contract signed,
// repair start date set, work order sent, final payment due, offer
// submitted, invoice sent) can fan out to zero or more FUB tasks.
// ─────────────────────────────────────────────────────────────────────────

export const FUB_MILESTONE_TRIGGER_EVENTS = [
  "inspection_scheduled",
  "inspection_completed",
  "repair_contract_signed",
  "repair_start_date",
  "repair_punch_out",
  "repair_final_payment_due",
  "offer_submitted",
  "invoice_sent",
] as const;

export type FubMilestoneTriggerEvent = typeof FUB_MILESTONE_TRIGGER_EVENTS[number];

const DEFAULT_MILESTONE_TASKS: Array<{ trigger: FubMilestoneTriggerEvent; name: string; daysOffset: number }> = [
  { trigger: "inspection_scheduled", name: "Confirm inspection scheduling with client", daysOffset: 0 },
  { trigger: "inspection_completed", name: "Follow up with client on inspection results", daysOffset: 1 },
  { trigger: "repair_contract_signed", name: "Initial Start Meeting", daysOffset: 1 },
  { trigger: "repair_start_date", name: "On-site reminder — repair start date", daysOffset: 0 },
  { trigger: "repair_punch_out", name: "Schedule Punch-Out Meeting", daysOffset: 3 },
  { trigger: "repair_final_payment_due", name: "Final/Payment Meeting", daysOffset: 0 },
  { trigger: "offer_submitted", name: "Track offer deadline", daysOffset: 0 },
  { trigger: "invoice_sent", name: "Payment due reminder", daysOffset: 3 },
];

// Idempotent — safe to call at every server startup.
export function ensureFubMilestoneSchema() {
  const { rawDb } = require("./db");
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS fub_milestone_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_event TEXT NOT NULL,
      task_name TEXT NOT NULL,
      days_offset INTEGER NOT NULL DEFAULT 0,
      assigned_fub_user_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_fub_milestone_tasks_trigger ON fub_milestone_tasks(trigger_event);`);

  const count = (rawDb.prepare(`SELECT COUNT(*) as c FROM fub_milestone_tasks`).get() as any).c;
  if (count === 0) {
    const ins = rawDb.prepare(
      `INSERT INTO fub_milestone_tasks (trigger_event, task_name, days_offset, assigned_fub_user_id) VALUES (?, ?, ?, ?)`
    );
    for (const t of DEFAULT_MILESTONE_TASKS) {
      ins.run(t.trigger, t.name, t.daysOffset, DENISE_FUB_USER_ID);
    }
    console.log(`[FUB Milestone] Seeded ${DEFAULT_MILESTONE_TASKS.length} default milestone task rows.`);
  }
}

// Best-effort FUB person lookup by phone, then email, then name — same
// search pattern already proven in pushOutcomeToFub / pushColdOutcomeToFub.
// Used as a fallback when the caller doesn't already have a personId on hand
// (e.g. repair_consults has no stored FUB contact link today).
export async function resolveFubPersonId(contact: {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
}): Promise<number | null> {
  if (contact.phone) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(contact.phone)}&limit=1`);
    const id = r.ok ? r.data?.people?.[0]?.id : null;
    if (id) return id;
  }
  if (contact.email) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(contact.email)}&limit=1`);
    const id = r.ok ? r.data?.people?.[0]?.id : null;
    if (id) return id;
  }
  if (contact.name) {
    const r = await fubRequest("GET", `/people?query=${encodeURIComponent(contact.name)}&limit=1`);
    const id = r.ok ? r.data?.people?.[0]?.id : null;
    if (id) return id;
  }
  return null;
}

// Fires every active fub_milestone_tasks row configured for `triggerEvent`.
// Non-fatal by design — a FUB outage or unresolved contact must never block
// the app-side lifecycle transition that triggered it. Caller may pass an
// already-known personId (preferred/fast path) or raw contact fields to fall
// back on resolveFubPersonId. `anchorDate` defaults to now; days_offset is
// added to it per-row to compute each task's dueDate.
export async function fireMilestoneTasks(
  triggerEvent: FubMilestoneTriggerEvent,
  opts: {
    personId?: number | null;
    clientName?: string | null;
    clientPhone?: string | null;
    clientEmail?: string | null;
    anchorDate?: Date;
    contextNote?: string;
  }
): Promise<Array<{ taskId: number | null; taskName: string }>> {
  const created: Array<{ taskId: number | null; taskName: string }> = [];
  try {
    const { rawDb } = require("./db");
    const rows = rawDb
      .prepare(`SELECT * FROM fub_milestone_tasks WHERE trigger_event = ? AND active = 1`)
      .all(triggerEvent) as any[];
    if (rows.length === 0) return created;

    let personId = opts.personId ?? null;
    if (!personId) {
      personId = await resolveFubPersonId({
        phone: opts.clientPhone,
        email: opts.clientEmail,
        name: opts.clientName,
      });
    }
    if (!personId) {
      console.warn(
        `[FUB Milestone] trigger=${triggerEvent} — no FUB contact resolved, skipping ${rows.length} task(s).`
      );
      return created;
    }

    const anchor = opts.anchorDate ? new Date(opts.anchorDate) : new Date();
    for (const row of rows) {
      try {
        const due = new Date(anchor);
        due.setDate(due.getDate() + (row.days_offset || 0));
        const dueDate = due.toISOString().slice(0, 10);
        const taskPayload: any = {
          personId,
          name: row.task_name,
          type: "To-Do",
          dueDate,
          assignedUserId: row.assigned_fub_user_id || DENISE_FUB_USER_ID,
        };
        if (opts.contextNote) taskPayload.description = opts.contextNote;
        const taskRes = await fubRequest("POST", `/tasks`, taskPayload);
        if (taskRes.ok) {
          console.log(
            `[FUB Milestone] '${row.task_name}' created (trigger=${triggerEvent}, person=${personId}, due=${dueDate})`
          );
          created.push({ taskId: taskRes.data?.id ?? null, taskName: row.task_name });
        } else {
          console.warn(`[FUB Milestone] task POST failed (trigger=${triggerEvent}):`, taskRes.status);
          created.push({ taskId: null, taskName: row.task_name });
        }
      } catch (err: any) {
        console.warn(`[FUB Milestone] task creation error (trigger=${triggerEvent}):`, err?.message || err);
        created.push({ taskId: null, taskName: row.task_name });
      }
    }
  } catch (err: any) {
    console.warn(`[FUB Milestone] fireMilestoneTasks failed (trigger=${triggerEvent}):`, err?.message || err);
  }
  return created;
}
