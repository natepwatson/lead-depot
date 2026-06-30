/**
 * Follow Up Boss API client
 * Docs: https://docs.followupboss.com/reference
 *
 * Auth: HTTP Basic with API key as username, empty password
 *   Authorization: Basic base64(apiKey + ":")
 *
 * System headers required:
 *   X-System: Lead Depot
 *   X-System-Key: lead-depot (arbitrary, identifies the integration)
 */

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_API_KEY = process.env.FUB_API_KEY || "";
const SYSTEM = "Lead Depot";
const SYSTEM_KEY = "lead-depot";

function authHeader(): string {
  return "Basic " + Buffer.from(FUB_API_KEY + ":").toString("base64");
}

function fubHeaders(): Record<string, string> {
  return {
    "Authorization": authHeader(),
    "Content-Type": "application/json",
    "X-System": SYSTEM,
    "X-System-Key": SYSTEM_KEY,
  };
}

async function fubFetch(path: string, method: string, body?: any): Promise<any> {
  const res = await fetch(`${FUB_BASE}${path}`, {
    method,
    headers: fubHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    console.error(`[FUB] ${method} ${path} → ${res.status}:`, text);
    throw new Error(`FUB API error ${res.status}: ${text}`);
  }

  return json;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FUBPersonPayload {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  source?: string;
  leadType?: string;
  tags?: string[];
}

export interface FUBAppointmentPayload {
  personId: number;
  title: string;
  startTime: string;  // ISO 8601
  endTime?: string;   // ISO 8601 — defaults to startTime + 1 hour
  location?: string;
  note?: string;
  type?: string;
}

// ── Create person via /v1/events (preferred — triggers automations, deduplicates) ──

export async function fubCreatePerson(person: FUBPersonPayload, outcomeType: "appointment" | "keep_in_touch", notes?: string): Promise<number> {
  // Map internal lead type → FUB source label
  const sourceMap: Record<string, string> = {
    expired:      "Expired",
    distressed:   "Distressed",
    land:         "Land Leads",
    website_lead: "Website",
  };
  const source = person.leadType ? (sourceMap[person.leadType] ?? "Lead Depot") : "Lead Depot";
  const type = outcomeType === "appointment" ? "Seller Inquiry" : "Seller Inquiry";

  // Build the note string
  const noteText = notes || "";

  const payload: any = {
    source,
    type,
    person: {
      ...(person.name
        ? { firstName: person.name.split(" ")[0], lastName: person.name.split(" ").slice(1).join(" ") || "" }
        : {}),
      ...(person.firstName ? { firstName: person.firstName } : {}),
      ...(person.lastName ? { lastName: person.lastName } : {}),
      ...(person.email ? { emails: [{ value: person.email }] } : {}),
      ...(person.phone ? { phones: [{ value: person.phone }] } : {}),
      ...(person.address ? { addressStreet: person.address } : {}),
      ...(person.city ? { addressCity: person.city } : {}),
      ...(person.state ? { addressState: person.state } : {}),
      ...(person.zip ? { addressZip: person.zip } : {}),
      tags: person.tags || ["Lead Depot"],
    },
    ...(noteText ? { message: noteText } : {}),
  };

  const result = await fubFetch("/events", "POST", payload);
  // Response is the person object (FUB deduplicates and returns the person)
  const personId = result?.id || result?.person?.id;
  if (!personId) {
    throw new Error("FUB did not return a person ID");
  }
  return personId;
}

// ── Set stage on a person ────────────────────────────────────────────────────

export async function fubSetStage(personId: number, stage: string): Promise<void> {
  await fubFetch(`/people/${personId}`, "PUT", { stage });
}

// ── Add a note to a person ────────────────────────────────────────────────────

export async function fubAddNote(personId: number, body: string): Promise<void> {
  await fubFetch("/notes", "POST", {
    personId,
    body,
    isHtml: false,
  });
}

// ── Create an appointment on a person ────────────────────────────────────────

export async function fubCreateAppointment(payload: FUBAppointmentPayload): Promise<void> {
  const { personId, title, startTime, endTime, location, note, type } = payload;

  // Calculate end time: default +1 hour if not provided
  let endTimeStr = endTime;
  if (!endTimeStr && startTime) {
    try {
      const d = new Date(startTime);
      d.setHours(d.getHours() + 1);
      endTimeStr = d.toISOString();
    } catch {
      endTimeStr = startTime;
    }
  }

  const body: any = {
    personId,
    title,
    startTime,
    ...(endTimeStr ? { endTime: endTimeStr } : {}),
    ...(location ? { location } : {}),
    ...(note ? { note } : {}),
    type: type || "Listing Consultation",
    sendInvitation: false, // don't auto-email the lead from Lead Depot
  };

  await fubFetch("/appointments", "POST", body);
}

// ── High-level: push appointment won to FUB ───────────────────────────────────

export async function pushAppointmentToFUB(params: {
  ownerName: string;
  phone: string;
  email: string;
  address: string;
  apptDetails: {
    dateTime: string;     // "2026-07-15 at 2:00 PM" or similar
    atProperty: boolean;
    address: string;
  };
  lpmamab: Record<string, string> | null;
  notes: string;
  leadType?: string;
  agentName?: string;
}): Promise<{ personId: number }> {
  const { ownerName, phone, email, address, apptDetails, lpmamab, notes, agentName } = params;

  // Parse address components (best-effort from "123 Main St, Jacksonville, FL 32218")
  const addrParts = address.split(",").map(s => s.trim());
  const street = addrParts[0] || address;
  const city = addrParts[1] || "";
  const stateZip = addrParts[2] || "";
  const state = stateZip.split(" ")[0] || "";
  const zip = stateZip.split(" ")[1] || "";

  // Build LPMAMAB note block
  const lpmamabLines = lpmamab ? [
    lpmamab.location    ? `Location (destination): ${lpmamab.location}` : "",
    lpmamab.price       ? `Price / equity: ${lpmamab.price}` : "",
    lpmamab.motivation  ? `Motivation: ${lpmamab.motivation}` : "",
    lpmamab.agent       ? `Prior agent: ${lpmamab.agent}` : "",
    lpmamab.mortgage    ? `Mortgage balance: ${lpmamab.mortgage}` : "",
    lpmamab.appointment ? `Availability: ${lpmamab.appointment}` : "",
    lpmamab.buy         ? `Buy after selling: ${lpmamab.buy}` : "",
  ].filter(Boolean) : [];

  const fullNotes = [
    `LISTING APPOINTMENT — set by Lead Depot${agentName ? ` (${agentName})` : ""}`,
    `Property: ${apptDetails.address}`,
    `Meeting at property: ${apptDetails.atProperty ? "Yes" : "No — different location"}`,
    apptDetails.dateTime ? `Appointment: ${apptDetails.dateTime}` : "",
    "",
    ...(lpmamabLines.length ? ["LPMAMAB:", ...lpmamabLines, ""] : []),
    notes ? `Call Notes: ${notes}` : "",
  ].filter(s => s !== undefined).join("\n").trim();

  // 1. Create / find person in FUB
  const personId = await fubCreatePerson(
    { name: ownerName, phone, email, address: street, city, state, zip, leadType: params.leadType, tags: ["Lead Depot", "Listing Appointment"] },
    "appointment",
    fullNotes
  );

  // 2. Create the appointment if we have a date
  if (apptDetails.dateTime) {
    const parsedStart = parseApptDateTime(apptDetails.dateTime);
    if (parsedStart) {
      await fubCreateAppointment({
        personId,
        title: `Listing Consultation — ${ownerName}`,
        startTime: parsedStart,
        location: apptDetails.atProperty ? apptDetails.address : "",
        note: notes || "",
        type: "Listing Consultation",
      });
    }
  }

  // 3. Set stage to Hot Prospect
  try {
    await fubSetStage(personId, "Hot Prospect");
  } catch (e) {
    console.error("[FUB] Failed to set stage Hot Prospect:", e);
  }

  return { personId };
}

// ── High-level: push keep in touch to FUB ────────────────────────────────────

export async function pushKeepInTouchToFUB(params: {
  ownerName: string;
  phone: string;
  email: string;
  address: string;
  kitDetails: { email: string; tempo: string };
  lpmamab: Record<string, string> | null;
  notes: string;
  leadType?: string;
  agentName?: string;
}): Promise<{ personId: number }> {
  const { ownerName, phone, address, kitDetails, lpmamab, notes, agentName } = params;
  const emailToUse = kitDetails.email || params.email;

  const addrParts = address.split(",").map(s => s.trim());
  const street = addrParts[0] || address;
  const city = addrParts[1] || "";
  const stateZip = addrParts[2] || "";
  const state = stateZip.split(" ")[0] || "";
  const zip = stateZip.split(" ")[1] || "";

  const lpmamabLines = lpmamab ? [
    lpmamab.location    ? `Location (destination): ${lpmamab.location}` : "",
    lpmamab.price       ? `Price / equity: ${lpmamab.price}` : "",
    lpmamab.motivation  ? `Motivation: ${lpmamab.motivation}` : "",
    lpmamab.agent       ? `Prior agent: ${lpmamab.agent}` : "",
    lpmamab.mortgage    ? `Mortgage balance: ${lpmamab.mortgage}` : "",
    lpmamab.appointment ? `Availability: ${lpmamab.appointment}` : "",
    lpmamab.buy         ? `Buy after selling: ${lpmamab.buy}` : "",
  ].filter(Boolean) : [];

  const fullNotes = [
    `KEEP IN TOUCH — logged via Lead Depot${agentName ? ` (${agentName})` : ""}`,
    `Property: ${address}`,
    kitDetails.tempo ? `Follow-up tempo: ${kitDetails.tempo}` : "",
    "",
    ...(lpmamabLines.length ? ["LPMAMAB:", ...lpmamabLines, ""] : []),
    notes ? `Call Notes: ${notes}` : "",
  ].filter(s => s !== undefined).join("\n").trim();

  // Create / find person in FUB
  const personId = await fubCreatePerson(
    { name: ownerName, phone, email: emailToUse, address: street, city, state, zip, leadType: params.leadType, tags: ["Lead Depot", "Keep In Touch"] },
    "keep_in_touch",
    fullNotes
  );

  // Set stage to Nurture
  try {
    await fubSetStage(personId, "Nurture");
  } catch (e) {
    console.error("[FUB] Failed to set stage Nurture:", e);
  }

  return { personId };
}

// ── Helper: parse "2026-07-15 at 2:00 PM" → ISO 8601 ─────────────────────────

function parseApptDateTime(str: string): string | null {
  if (!str) return null;

  // Try native Date parse first (works for ISO strings)
  const direct = new Date(str);
  if (!isNaN(direct.getTime())) return direct.toISOString();

  // Pattern: "2026-07-15 at 2:00 PM" or "2026-07-15 at 14:00"
  const match = str.match(/(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}:\d{2})\s*(AM|PM)?/i);
  if (match) {
    const [, datePart, timePart, meridiem] = match;
    let [hStr, mStr] = timePart.split(":");
    let h = parseInt(hStr);
    const m = parseInt(mStr);
    if (meridiem?.toUpperCase() === "PM" && h < 12) h += 12;
    if (meridiem?.toUpperCase() === "AM" && h === 12) h = 0;
    const d = new Date(`${datePart}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}
