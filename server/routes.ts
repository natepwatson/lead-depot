import { createRequire } from "node:module";
import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { rawDb } from "./db";
import { Resend } from "resend";
import { broadcast } from "./ws";
import { randomBytes } from "node:crypto";
import { pushOutcomeToFub, fubCreateAgentRecruit, pushEmailNoteToFub, scheduleFubEmailEvidence } from "./fub";
import {
  initAuthSchema,
  migrateLegacyPasswords,
  purgeOldSessions,
  hashPassword,
  verifyPassword,
  createSession,
  revokeSession,
  revokeAllSessionsForAgent,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  requireSelfOrAdmin,
  requireAdmin,
  sha256,
  SESSION_COOKIE,
} from "./auth";
import { logAgentEvent, getAgentAuditLog, isWithinReactivateWindow } from "./audit";
// v14.46 — BatchLeads auto-pipeline removed. CSV import path is the sole seller intake.
import { parseBatchLeadsFile, insertImportedLeads } from "./batchleads-csv-import";
// @ts-expect-error — no @types/multer installed; runtime-only import
import multer from "multer";
import { runDbprPipeline } from "./dbpr-pipeline";
import { getTerritoryForZip, TERRITORIES as TERRITORY_META } from "./territories";
import { normalizeFirstName, normalizeFullName, normalizeAddressCasual } from "./normalize";
// v14.46 — LandVoice OAuth module removed. LandVoice exports come in via CSV upload only.
import fs from "node:fs";
import path from "node:path";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── POINTS HELPER (v14.18 ladder) ───────────────────────────────────────────
// Total points = base dial (2) + outcome-specific points. Each outcome key below
// is the FULL award for that outcome (dial base already folded in). Referral is
// a separate reward (no dial base) because it's a networking event, not a call.
//
//   Referral                 25  (networking win — no dial)
//   Appt Set                 20
//   Keep In Touch            15
//   Not Interested            8
//   Listed                    8
//   Value email (Stage 2)     5   (v14.18 email system)
//   Recycle                   4
//   Left VM                   4
//   Wrong #                   3
//   Disconnected              3
//   No Answer                 3
//   Cold email (Stage 1)      3   (v14.18 email system)
//   Any other dial (base)     2
//
// v12.5 — scoped: "seller" (default, existing seller-side call flow) or
// "recruiting" (agent-recruiting depot). Leaderboards + hard resets filter by
// scope so the two systems stay fully isolated.
function awardPoints(
  agentId: number | null | undefined,
  outcome: string,
  leadId?: number,
  scope: "seller" | "recruiting" = "seller",
) {
  if (!agentId) return;
  const pts: Record<string, number> = {
    network_referral:          25,
    contacted_appointment:     20,
    keep_in_touch:             15,
    contacted_not_interested:   8,
    listed:                     8,
    email_sent_value:           5,   // v14.18 Stage 2 email
    recycled:                   4,
    left_voicemail:             4,
    wrong_number:               3,
    disconnected:               3,
    no_answer:                  3,
    email_sent:                 3,   // v14.18 Stage 1 email (aka cold outreach)
    // any other outcome falls back to base dial (2)
  };
  const points = pts[outcome] ?? 2;
  const reason = outcome;
  rawDb.prepare(
    `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, points, reason, leadId ?? null, scope, new Date().toISOString());
}


// v14.29.4 — Shared branded email shell for Flows 2, 3, 4.
// Wraps plain-text template body in a client-facing HTML shell with the agent's
// headshot, name, phone, email, and Brothers Group Real Estate signature card.
// Falls back to text signature when headshot URL is missing.
function renderBrandedEmail(opts: {
  bodyText: string;                 // plain text body (already placeholder-rendered)
  agentName: string;                // "Alex Watson"
  agentTitle?: string;              // e.g. "Realtor · Brothers Group Real Estate"
  agentPhone?: string;
  agentEmail?: string;
  agentHeadshotUrl?: string | null; // relative or absolute
  publicHost?: string;              // e.g. https://depot.watsonbrothersgroup.com
}): string {
  const host = (opts.publicHost || process.env.APP_URL || "https://depot.watsonbrothersgroup.com").replace(/\/$/, "");
  let headshotAbs: string | null = null;
  if (opts.agentHeadshotUrl) {
    headshotAbs = opts.agentHeadshotUrl.startsWith("http")
      ? opts.agentHeadshotUrl
      : `${host}${opts.agentHeadshotUrl.startsWith("/") ? "" : "/"}${opts.agentHeadshotUrl}`;
  }
  const title = opts.agentTitle || "Brothers Group Real Estate Team · Momentum Realty";

  // Strip any trailing signature the template already includes, so we don't render two.
  // Templates end with lines like:
  //   — {agentFull}
  //   Brothers Group Real Estate Team at Momentum Realty
  //   {agentPhone} · {agentEmail}
  // We keep the body up through the last conversational paragraph, then append our own signature.
  const bodyLines = opts.bodyText.split("\n");
  // Find the last "— <name>" line (em dash sign-off) and truncate there
  let cutIdx = -1;
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    if (/^\s*[\u2014-]\s*\S+/.test(bodyLines[i])) { cutIdx = i; break; }
  }
  const bodyOnly = cutIdx >= 0 ? bodyLines.slice(0, cutIdx).join("\n").replace(/\s+$/,"") : opts.bodyText;

  // Build paragraphs from bodyOnly, preserving bullet blocks and website link lines
  const paragraphs = bodyOnly.split(/\n\s*\n/).map(block => {
    const lines = block.split("\n");
    // Bullet list (lines starting with •)
    if (lines.every(l => l.trim().startsWith("•") || !l.trim())) {
      const items = lines.filter(l => l.trim().startsWith("•"))
        .map(l => `<li style="margin:6px 0;color:#2a2620">${escapeHtml(l.replace(/^\s*•\s*/,""))}</li>`).join("");
      return `<ul style="margin:0 0 18px 0;padding-left:22px;list-style:disc">${items}</ul>`;
    }
    // Link block (lines like "Website → brothersgroup.realestate")
    if (lines.every(l => /brothersgroup\.realestate/.test(l) || !l.trim())) {
      const rows = lines.filter(l => l.trim()).map(l => {
        const linked = escapeHtml(l).replace(/(brothersgroup\.realestate[/\w\-]*)/g, m => `<a href="https://${m}" style="color:#8a6a20;text-decoration:none;border-bottom:1px solid rgba(138,106,32,0.4)">${m}</a>`);
        return `<div style="margin:4px 0;font-size:15px">${linked}</div>`;
      }).join("");
      return `<div style="margin:0 0 18px 0;padding:14px 16px;background:#faf8f3;border-left:3px solid #c8aa5a;border-radius:2px">${rows}</div>`;
    }
    // Default paragraph
    return `<p style="margin:0 0 16px 0">${escapeHtml(block).replace(/\n/g,"<br>")}</p>`;
  }).join("\n");

  // Signature card
  const initials = opts.agentName.split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
  const avatarHtml = headshotAbs
    ? `<img src="${headshotAbs}" width="72" height="72" alt="${escapeHtml(opts.agentName)}" style="display:block;width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #c8aa5a"/>`
    : `<div style="width:72px;height:72px;border-radius:50%;background:#1a1a1a;border:2px solid #c8aa5a;display:table-cell;text-align:center;vertical-align:middle;color:#c8aa5a;font-family:Georgia,serif;font-size:26px">${initials}</div>`;
  const phoneRow = opts.agentPhone ? `<div style="font-size:13px;color:#2a2620;margin-top:2px">${escapeHtml(opts.agentPhone)}</div>` : "";
  const emailRow = opts.agentEmail ? `<div style="font-size:13px;color:#2a2620"><a href="mailto:${escapeHtml(opts.agentEmail)}" style="color:#8a6a20;text-decoration:none">${escapeHtml(opts.agentEmail)}</a></div>` : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#efece5;font-family:Georgia,'Times New Roman',serif;color:#2a2620;font-size:16px;line-height:1.65">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#efece5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e5e2dc;border-radius:8px;overflow:hidden">

        <!-- Header wordmark -->
        <tr><td style="background:#0f0f0f;padding:20px 32px;border-bottom:3px solid #c8aa5a">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;color:#c8aa5a;letter-spacing:.06em">Brothers Group Real Estate</div>
          <div style="font-size:11px;color:#a8a8a5;letter-spacing:.16em;text-transform:uppercase;margin-top:4px">Momentum Realty · Northeast Florida</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px 12px 32px;font-size:16px;line-height:1.65;color:#2a2620">
          ${paragraphs}
        </td></tr>

        <!-- Signature card -->
        <tr><td style="padding:8px 32px 28px 32px">
          <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-top:1px solid #eae6de;padding-top:20px">
            <tr>
              <td width="88" valign="top" style="padding-right:16px">${avatarHtml}</td>
              <td valign="middle">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#1a1a1a;letter-spacing:.01em">${escapeHtml(opts.agentName)}</div>
                <div style="font-size:12px;color:#797876;letter-spacing:.06em;text-transform:uppercase;margin:3px 0 6px 0">${escapeHtml(title)}</div>
                ${phoneRow}
                ${emailRow}
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer strip -->
        <tr><td style="background:#faf8f3;padding:14px 32px;border-top:1px solid #eae6de;font-size:11px;color:#797876;letter-spacing:.04em">
          <a href="https://brothersgroup.realestate" style="color:#8a6a20;text-decoration:none;margin-right:14px">brothersgroup.realestate</a>
          <a href="https://brothersgroup.realestate/our-agents" style="color:#8a6a20;text-decoration:none;margin-right:14px">Meet the team</a>
          <a href="https://brothersgroup.realestate/reviews" style="color:#8a6a20;text-decoration:none">Reviews</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Source label map
const SOURCE_LABELS: Record<string, string> = {
  expired: "Expired Listing",
  absentee: "Absentee Owner",
  network: "Network / Inbound Lead",
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

  // ── Table cell styles — declared BEFORE any template literal that uses them ──
  const tdL = "padding:9px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:160px;vertical-align:top";
  const tdR = "padding:9px 0;font-size:14px;color:#f0f0f0;vertical-align:top";

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
    <tr><td style="${tdL}">Source</td><td style="${tdR}">${opts.source || "—"}</td></tr>
  ` : "";

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

  <!-- Client Intention Banner -->
  <div style="background:#1a1500;border-left:4px solid #c8aa5a;padding:18px 32px;border-bottom:1px solid #2a2520">
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#c8aa5a;font-weight:700">Client Intention</p>
    <p style="margin:0;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-.01em">${opts.intention || "Not specified"}</p>
    ${opts.intention && opts.intention.includes(" + ") ? `<p style="margin:8px 0 0;display:inline-block;background:#92400e;color:#fbbf24;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:4px 10px;border-radius:6px">⚡ Multi-Transaction Client</p>` : ""}
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
    <span>Lead Depot v14.81.1 — Brothers Group · Momentum Realty</span>
  </div>
</div>
</body>
</html>`;

  await resend.emails.send({
    from:    "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:      ["denise@watsonbrothersgroup.com"],
    cc:      ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
    subject,
    html,
  });
}

// ─── APPOINTMENT ALERT ──────────────────────────────────────────────────────────────────────
// Fires immediately when any agent logs an appointment (seller or recruiting)
async function sendAppointmentAlert(opts: {
  type: "seller" | "recruiting";
  agentName: string;
  clientName: string;
  clientPhone?: string;
  address?: string;       // seller leads
  brokerage?: string;     // recruiting leads
  territory?: string;     // recruiting leads
  apptDate?: string;
  apptTime?: string;
  notes?: string;
}) {
  if (!resend) return;
  const isSeller = opts.type === "seller";
  const subject = isSeller
    ? `🏠 Appointment Set — ${opts.clientName} | ${opts.address || "Address TBD"}`
    : `🎯 Recruiting Appointment — ${opts.clientName} | ${opts.brokerage || "Brokerage TBD"}`;

  const html = `
<!DOCTYPE html><html>
<body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid #2a2520">
  <div style="background:linear-gradient(135deg,${isSeller ? '#c8aa5a 0%,#a8893a' : '#4fb8a3 0%,#2a8a7a'} 100%);padding:24px 28px">
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:${isSeller ? '#5a3e00' : '#003a33'};font-weight:700">
      ${isSeller ? 'Seller Lead' : 'Recruiting Lead'} — Appointment Alert
    </p>
    <h1 style="margin:0;font-size:20px;color:#080808;font-weight:700">${opts.clientName}</h1>
    <p style="margin:6px 0 0;font-size:13px;color:${isSeller ? '#3a2800' : '#003a33'}">Booked by ${opts.agentName}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse">
      ${isSeller ? `<tr><td style="padding:8px 0;color:#c8aa5a;font-size:11px;text-transform:uppercase;letter-spacing:.1em;width:140px">Address</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.address || '—'}</td></tr>` : ''}
      ${!isSeller ? `<tr><td style="padding:8px 0;color:#4fb8a3;font-size:11px;text-transform:uppercase;letter-spacing:.1em;width:140px">Brokerage</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.brokerage || '—'}</td></tr>` : ''}
      ${!isSeller && opts.territory ? `<tr><td style="padding:8px 0;color:#4fb8a3;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Territory</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.territory}</td></tr>` : ''}
      ${opts.clientPhone ? `<tr><td style="padding:8px 0;color:${isSeller ? '#c8aa5a' : '#4fb8a3'};font-size:11px;text-transform:uppercase;letter-spacing:.1em">Phone</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.clientPhone}</td></tr>` : ''}
      ${opts.apptDate ? `<tr><td style="padding:8px 0;color:${isSeller ? '#c8aa5a' : '#4fb8a3'};font-size:11px;text-transform:uppercase;letter-spacing:.1em">Date</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.apptDate}${opts.apptTime ? ' at ' + opts.apptTime : ''}</td></tr>` : ''}
      ${opts.notes ? `<tr><td style="padding:8px 0;color:${isSeller ? '#c8aa5a' : '#4fb8a3'};font-size:11px;text-transform:uppercase;letter-spacing:.1em">Notes</td><td style="padding:8px 0;font-size:14px;color:#f0f0f0">${opts.notes}</td></tr>` : ''}
    </table>
    <div style="margin-top:20px;padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.08);font-size:13px;color:rgba(255,255,255,0.6)">
      📋 Attend or delegate? Reply to this email or check Lead Depot: <a href="https://depot.watsonbrothersgroup.com" style="color:${isSeller ? '#c8aa5a' : '#4fb8a3'}">depot.watsonbrothersgroup.com</a>
    </div>
  </div>
  <div style="padding:12px 28px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v14.81.1 — Brothers Group · Momentum Realty</div>
</div></body></html>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:   ["alex@watsonbrothersgroup.com"],
    cc:   ["nate@watsonbrothersgroup.com"],
    subject,
    html,
  });
}

// ─── EXPIRED CREDIBILITY EMAIL (v14.18) ───────────────────────────────────────────
// Fires immediately on Expired KIT save. Sends a warm intro email to the seller
// from the agent (Reply-To = agent.email). Rate-limited to once per lead per
// 60 days via lead_activity ('email_sent' with notes containing 'expired-credibility').
const FOLLOW_UP_TIMING_PHRASE: Record<string, string> = {
  a_few_days:  "in a few days",
  few_weeks:   "in 2–3 weeks",
  few_months:  "in 2–3 months",
  six_months:  "in about six months — no rush",
};
async function sendExpiredCredibilityEmail(opts: {
  leadId: number;
  agentId?: number | null;   // v14.29 — needed to award points
  ownerEmail: string;
  ownerFirstName: string;
  ownerPhone?: string;       // v14.27 — needed to push FUB note
  address: string;
  followUpTiming: string;
  agent: { name?: string; email?: string; phone?: string };
}) {
  if (!resend) { console.log("[CredibilityEmail] skipped — no RESEND_API_KEY"); return; }
  if (!opts.ownerEmail || !opts.ownerEmail.includes("@")) {
    console.log(`[CredibilityEmail] skipped lead ${opts.leadId} — no owner email`);
    return;
  }

  // 60-day rate limit — do NOT re-send if we've already sent one for this lead
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const recent = rawDb.prepare(`
    SELECT id FROM lead_activity
     WHERE lead_id = ?
       AND outcome = 'email_sent'
       AND notes LIKE '%expired-credibility%'
       AND created_at > ?
     LIMIT 1
  `).get(opts.leadId, cutoff);
  if (recent) {
    console.log(`[CredibilityEmail] skipped lead ${opts.leadId} — sent within last 60 days`);
    return;
  }

  // v14.18 — normalize owner + agent names, and use casual address in email body
  // so it reads like a human wrote it (no ALL CAPS names, no "SE / Apt 3B" suffixes).
  const firstName    = normalizeFirstName(opts.ownerFirstName) || "there";
  const agentFull    = normalizeFullName(opts.agent.name) || "Your Brothers Group Real Estate Team agent";
  const agentFirst   = normalizeFirstName(agentFull.split(/\s+/)[0]) || agentFull.split(/\s+/)[0];
  const casualAddress = normalizeAddressCasual(opts.address) || opts.address;
  const agentEmail   = opts.agent.email || "noreply@watsonbrothersgroup.com";
  const agentPhone   = opts.agent.phone || "";
  const timingPhrase = FOLLOW_UP_TIMING_PHRASE[opts.followUpTiming] || "soon";

  // v14.26 — Prefer editable DB template for Flow 2. Falls back to hardcoded copy if missing.
  const _loadTpl = (globalThis as any).__leadDepotLoadEmailTemplate as ((k: string) => { subject: string; body: string } | null) | undefined;
  const _render  = (globalThis as any).__leadDepotRenderTemplate as ((t: string, v: Record<string,string|undefined>) => string) | undefined;
  const _tpl = _loadTpl ? _loadTpl("email_flow2") : null;
  const _vars = {
    ownerFirst: firstName,
    ownerName:  firstName,
    address:    casualAddress,
    agentFirst,
    agentFull,
    agentPhone: agentPhone || "",
    agentEmail: agentEmail || "",
    timing:     `in ${timingPhrase}`,
  };
  const subject = _tpl && _render
    ? _render(_tpl.subject, _vars)
    : `Hey ${firstName} \u2014 nice talking earlier`;
  const plainText = _tpl && _render
    ? _render(_tpl.body, _vars)
    : [
        `Hey ${firstName} \u2014`,
        "",
        `Really glad we got to chat about the house at ${casualAddress}. Sounded like the timing's not quite right yet, and honestly, that's the best kind of answer \u2014 you know where you stand.`,
        "",
        `Wanted to properly introduce myself since I skipped the formalities on the phone. I'm ${agentFirst} with the Brothers Group Real Estate Team at Momentum Realty. We work with a lot of folks in your spot \u2014 the first listing didn't land, life kept moving, and the house is just sitting there in the background. Nothing wrong with letting it sit. But when you're ready to actually think about it, we're the ones you want in the room.`,
        "",
        "No agenda on this email. Just wanted you to have a name and a face for the number that called.",
        "",
        `If you ever want a quick five-minute walk-through \u2014 no clipboard, no pitch, just an honest read on what your home would take to move \u2014 say the word. Otherwise I'll check back in ${timingPhrase} and see where you're at.`,
        "",
        ...(agentPhone ? [`Real quick \u2014 my direct line is ${agentPhone} if anything comes up before then.`, ""] : []),
        "Talk soon,",
        agentFull,
        "Brothers Group Real Estate Team at Momentum Realty",
        [agentPhone, agentEmail].filter(Boolean).join(" \u00b7 "),
      ].join("\n");

  // v14.29.4 — Branded HTML shell with agent headshot signature card.
  const _agent = opts.agentId ? (storage.getAgentById(opts.agentId) as any) : null;
  const html = renderBrandedEmail({
    bodyText: plainText,
    agentName: agentFull,
    agentPhone,
    agentEmail,
    agentHeadshotUrl: _agent?.headshotUrl || null,
  });

  try {
    await resend.emails.send({
      from:      `${agentFull} <${agentEmail || "noreply@watsonbrothersgroup.com"}>`,
      to:        [opts.ownerEmail],
      cc:        ["alex@watsonbrothersgroup.com"],
      bcc:       agentEmail ? [agentEmail] : undefined,
      reply_to:  agentEmail,
      subject,
      html,
      text:      plainText,
    } as any);
    // Log to activity so rate limit works next time + audit trail
    // v14.29 — log agent_id so points/attribution work
    const nowIso = new Date().toISOString();
    rawDb.prepare(`
      INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
      VALUES (?, ?, 'email_sent', ?, NULL, ?)
    `).run(opts.leadId, opts.agentId || null, `expired-credibility sent to ${opts.ownerEmail} (follow-up: ${opts.followUpTiming})`, nowIso);
    // v14.29 — Fix 2: award points for Flow 2 credibility email
    if (opts.agentId) awardPoints(opts.agentId, "email_sent", opts.leadId);
    // v14.27 — push FUB note recording the send (subject + timestamp + preview)
    pushEmailNoteToFub({
      ownerPhone: opts.ownerPhone,
      ownerName:  `${opts.ownerFirstName}`,
      subject,
      sentAt:     nowIso,
      preview:    plainText.slice(0, 260),
      kind:       "Flow 2 \u2014 Expired Credibility (auto on KIT)",
    }).catch(err => console.error("[FUB] Flow 2 note push failed:", err));
    console.log(`[CredibilityEmail] sent for lead ${opts.leadId} to ${opts.ownerEmail} (agent ${opts.agentId || "unknown"})`);
  } catch (e: any) {
    console.error(`[CredibilityEmail] send failed for lead ${opts.leadId}:`, e.message);
  }
}

// ─── QUEUE DEPTH ALERT ───────────────────────────────────────────────────────────────
// Fires when active seller lead queue drops to or below LOW_QUEUE_THRESHOLD per active agent

// v14.27 — Flow 4: Appointment Warm Email.
// Fires on contacted_appointment. Uses editable email_flow4 template. Respects 24h/lead cap.
async function sendAppointmentWarmEmail(opts: {
  leadId: number;
  agentId?: number | null;
  ownerEmail: string;
  ownerFirstName: string;
  ownerPhone?: string;
  address: string;
  apptDate?: string;
  apptTime?: string;
  agent: { name?: string; email?: string; phone?: string };
}) {
  if (!resend) { console.log("[ApptWarmEmail] skipped \u2014 no RESEND_API_KEY"); return; }
  if (!opts.ownerEmail || !opts.ownerEmail.includes("@")) {
    console.log(`[ApptWarmEmail] skipped lead ${opts.leadId} \u2014 no owner email`);
    return;
  }
  // 24h/lead cap across all flows
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = rawDb.prepare(`
    SELECT id FROM lead_activity
     WHERE lead_id = ?
       AND outcome = 'email_sent'
       AND created_at > ?
     LIMIT 1
  `).get(opts.leadId, dayAgo);
  if (recent) {
    console.log(`[ApptWarmEmail] skipped lead ${opts.leadId} \u2014 within 24h cap`);
    return;
  }

  const firstName    = normalizeFirstName(opts.ownerFirstName) || "there";
  const agentFull    = normalizeFullName(opts.agent.name) || "Your Brothers Group Real Estate Team agent";
  const agentFirst   = normalizeFirstName(agentFull.split(/\s+/)[0]) || agentFull.split(/\s+/)[0];
  const casualAddress = normalizeAddressCasual(opts.address) || opts.address;
  const agentEmail   = opts.agent.email || "noreply@watsonbrothersgroup.com";
  const agentPhone   = opts.agent.phone || "";

  const _loadTpl = (globalThis as any).__leadDepotLoadEmailTemplate as ((k: string) => { subject: string; body: string } | null) | undefined;
  const _render  = (globalThis as any).__leadDepotRenderTemplate as ((t: string, v: Record<string,string|undefined>) => string) | undefined;
  const _tpl = _loadTpl ? _loadTpl("email_flow4") : null;
  const _vars = {
    ownerFirst: firstName,
    ownerName:  firstName,
    address:    casualAddress,
    agentFirst,
    agentFull,
    agentPhone,
    agentEmail,
    apptDate:   opts.apptDate || "our confirmed date",
    apptTime:   opts.apptTime || "our confirmed time",
  };
  const subject = _tpl && _render
    ? _render(_tpl.subject, _vars)
    : `Looking forward to meeting you, ${firstName}`;
  const plainText = _tpl && _render
    ? _render(_tpl.body, _vars)
    : `Hey ${firstName} \u2014\n\nJust wanted to say thanks for setting up a time to meet about ${casualAddress}. Really looking forward to it.\n\nIf anything comes up before then, my direct line is ${agentPhone}.\n\nExcited to meet,\n${agentFull}`;

  // v14.29.4 — Branded HTML shell with agent headshot signature card.
  const _agent4 = opts.agentId ? (storage.getAgentById(opts.agentId) as any) : null;
  const html = renderBrandedEmail({
    bodyText: plainText,
    agentName: agentFull,
    agentPhone,
    agentEmail,
    agentHeadshotUrl: _agent4?.headshotUrl || null,
  });

  try {
    await resend.emails.send({
      from:      `${agentFull} <${agentEmail || "noreply@watsonbrothersgroup.com"}>`,
      to:        [opts.ownerEmail],
      cc:        ["alex@watsonbrothersgroup.com"],
      bcc:       agentEmail ? [agentEmail] : undefined,
      reply_to:  agentEmail,
      subject,
      html,
      text:      plainText,
    } as any);
    const nowIso = new Date().toISOString();
    rawDb.prepare(`
      INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
      VALUES (?, ?, 'email_sent', ?, NULL, ?)
    `).run(opts.leadId, opts.agentId || null, `appointment-warm sent to ${opts.ownerEmail}`, nowIso);
    // No separate awardPoints \u2014 the contacted_appointment outcome awards 20 pts already.
    pushEmailNoteToFub({
      ownerPhone: opts.ownerPhone,
      ownerName:  firstName,
      subject,
      sentAt:     nowIso,
      preview:    plainText.slice(0, 260),
      kind:       "Flow 4 \u2014 Appointment Warm (auto on appt set)",
    }).catch(err => console.error("[FUB] Flow 4 note push failed:", err));
    console.log(`[ApptWarmEmail] sent for lead ${opts.leadId} to ${opts.ownerEmail}`);
  } catch (e: any) {
    console.error(`[ApptWarmEmail] send failed for lead ${opts.leadId}:`, e.message);
  }
}

const LOW_QUEUE_THRESHOLD = 5; // leads per active agent
async function checkQueueDepthAlert(rawDb: any) {
  if (!resend) return;
  try {
    const activeLeads = (rawDb.prepare(`SELECT COUNT(*) as n FROM leads WHERE status NOT IN ('retired','contacted_not_interested','contacted_appointment','keep_in_touch','wrong_number','listed')`).get() as any)?.n ?? 0;
    // v14.48 — Flow is the only gate for receiving leads.
    const activeAgents = (rawDb.prepare(`SELECT COUNT(*) as n FROM agents WHERE lead_flow_on = 1`).get() as any)?.n ?? 1;
    const perAgent = Math.floor(activeLeads / Math.max(activeAgents, 1));
    if (perAgent > LOW_QUEUE_THRESHOLD) return; // queue is healthy

    // Rate-limit: only send once per 6 hours (track in app_settings)
    const lastAlert = (rawDb.prepare(`SELECT value FROM app_settings WHERE key = 'queue_depth_alert_sent_at'`).get() as any)?.value;
    if (lastAlert) {
      const elapsed = Date.now() - new Date(lastAlert).getTime();
      if (elapsed < 6 * 60 * 60 * 1000) return; // sent within last 6h
    }
    rawDb.prepare(`INSERT INTO app_settings (key, value) VALUES ('queue_depth_alert_sent_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());

    await resend.emails.send({
      from: "Lead Depot <noreply@watsonbrothersgroup.com>",
      to:   ["alex@watsonbrothersgroup.com"],
      subject: `⚠️ Lead Depot — Seller Queue Running Low (${activeLeads} leads, ~${perAgent}/agent)`,
      html: `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:500px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid #2a2520">
  <div style="background:linear-gradient(135deg,#92400e,#78350f);padding:22px 26px">
    <h1 style="margin:0;font-size:18px;color:#fbbf24;font-weight:700">⚠️ Seller Queue Running Low</h1>
    <p style="margin:6px 0 0;font-size:13px;color:#a16207">Lead Depot — Action Required</p>
  </div>
  <div style="padding:22px 26px">
    <p style="font-size:15px;color:#f0f0f0;margin:0 0 16px">
      The active seller lead queue has dropped to <strong style="color:#fbbf24">${activeLeads} leads</strong> across ${activeAgents} active agents (~${perAgent} per agent).
    </p>
    <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:0 0 20px">Lead intake is CSV-only. Upload the latest LandVoice or BatchLeads export from the Admin panel to refill the queue.</p>
    <a href="https://depot.watsonbrothersgroup.com" style="display:inline-block;background:#c8aa5a;color:#080808;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:12px 20px;border-radius:8px;text-decoration:none">Open Lead Depot</a>
  </div>
  <div style="padding:12px 26px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v14.81.1 — Brothers Group · Momentum Realty</div>
</div></body></html>`,
    });
    console.log(`[QueueAlert] Sent low-queue alert: ${activeLeads} leads / ${activeAgents} agents`);
  } catch (err: any) {
    console.error("[QueueAlert] Error:", err.message);
  }
}

// Works in both ESM (tsx dev) and CJS (esbuild production bundle)
const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

// v14.6 — Convert a raw snake_case DB row into the camelCase shape the client
// expects. Used by any endpoint that returns a raw `SELECT * FROM leads` row.
// Without this the client sees `undefined` for ownerName / leadType / phoneStates
// and renders "Unknown Owner" plus "No script saved for this lead type."
function toApiLead(r: any): any {
  if (!r || typeof r !== "object") return r;
  return {
    id: r.id,
    ownerName: r.owner_name,
    address: r.address,
    city: r.city,
    state: r.state,
    zip: r.zip,
    county: r.county,
    phone: r.phone,
    phones: r.phones,
    phoneStates: r.phone_states,
    email: r.email,
    leadType: r.lead_type,
    status: r.status,
    motivation: r.motivation,
    extraData: r.extra_data,
    assignedAgentId: r.assigned_agent_id,
    attemptCount: r.attempt_count,
    callbackDate: r.callback_date,
    lLocation: r.l_location,
    lPricePaid: r.l_price_paid,
    lMotivation: r.l_motivation,
    lAgentHistory: r.l_agent_history,
    lMortgage: r.l_mortgage,
    lAppointment: r.l_appointment,
    lBuy: r.l_buy,
    alsoBuying: r.also_buying,
    intent: r.intent,  // v14.53 — 3-way seller/buyer intent
    bLocation: r.b_location,
    bPrice: r.b_price,
    bMotivation: r.b_motivation,
    bAgent: r.b_agent,
    bMortgage: r.b_mortgage,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    batchId: r.batch_id,
    score: r.score,
    territory: r.territory,
    source: r.source,
    listPrice: r.list_price,
    assessedValue: r.assessed_value,
    lastSalePrice: r.last_sale_price,
    lotSizeAcres: r.lot_size_acres,
    yearPurchased: r.year_purchased,
    // v14.39 — unified 14d Recycle cooldown (Expired + Absentee)
    recycleCooldownUntil: r.recycle_cooldown_until,
    // v14.40 — per-line no-answer counter (6 attempts per phone → struck)
    phoneAttempts: r.phone_attempts,
  };
}

export function registerRoutes(httpServer: ReturnType<typeof createServer>, app: Express) {

  // ─── v14.58 — Phase A: Auth schema + bcrypt migration (fire-and-forget) ───
  // initAuthSchema is idempotent (CREATE IF NOT EXISTS). The password migration
  // runs async so we don't block server startup on hashing existing rows.
  initAuthSchema();
  purgeOldSessions();
  migrateLegacyPasswords()
    .then(({ migrated, alreadyHashed }) => {
      if (migrated > 0) {
        console.log(`[v14.58 auth] bcrypt-migrated ${migrated} legacy plaintext password(s); ${alreadyHashed} already hashed`);
      } else {
        console.log(`[v14.58 auth] all ${alreadyHashed} agent password(s) already bcrypt-hashed`);
      }
    })
    .catch(err => console.error("[v14.58 auth] migration failed:", err));

  // ─── v14.10 — RETIRE-ON-DEPLOY SWEEP (one-time, runs on every boot) ──────
  // Any active lead with attemptCount >= 6 flips to status='retired'. Applies
  // the new 6-attempt cap retroactively so old high-attempt leads leave the pool.
  // Idempotent: on subsequent boots there's nothing left to retire.
  try {
    const RETIRE_CAP = 6;
    const result = rawDb.prepare(`
      UPDATE leads
         SET status = 'retired'
       WHERE attempt_count >= ?
         AND status NOT IN ('retired', 'contacted_appointment', 'contacted_not_interested', 'keep_in_touch', 'wrong_number', 'listed')
    `).run(RETIRE_CAP);
    if (result.changes > 0) {
      console.log(`[v14.10 retire-sweep] Retired ${result.changes} leads with attemptCount >= ${RETIRE_CAP}`);
    }
  } catch (err) {
    console.error("[v14.10 retire-sweep] Failed:", err);
  }

  // ─── v14.50 — ASSIGNMENT-RULE SWEEP (one-time, runs on every boot) ─────
  // NEW RULE: A lead is assigned to an agent ONLY IF the most recent activity
  // outcome is `keep_in_touch` or `contacted_appointment`. Everything else
  // (no_answer, wrong_number, left_voicemail, disconnected, email_sent,
  // recycled, listed, contacted_not_interested, or NO activity at all) means
  // the lead belongs to the shared pool.
  //
  // Also: preserve `contacted_appointment` closed leads as-is. This sweep only
  // touches leads whose status is NOT terminal.
  try {
    const KEEP_OUTCOMES = ["keep_in_touch", "contacted_appointment"];
    // Skip terminal statuses that shouldn't be touched.
    const TERMINAL_STATUS = ["contacted_not_interested", "contacted_appointment", "retired", "listed", "deleted"];
    const terminalPlaceholders = TERMINAL_STATUS.map(() => "?").join(",");
    // Find every currently-assigned lead whose last activity outcome is NOT in KEEP_OUTCOMES.
    const toUnassign: any[] = rawDb.prepare(`
      SELECT l.id,
             (SELECT la.outcome
                FROM lead_activity la
               WHERE la.lead_id = l.id
               ORDER BY la.created_at DESC
               LIMIT 1) AS last_outcome
        FROM leads l
       WHERE l.assigned_agent_id IS NOT NULL
         AND l.status NOT IN (${terminalPlaceholders})
    `).all(...TERMINAL_STATUS);
    let unassigned = 0;
    const unassignStmt = rawDb.prepare(`
      UPDATE leads
         SET assigned_agent_id = NULL,
             status = 'unassigned'
       WHERE id = ?
    `);
    const tx = rawDb.transaction((rows: any[]) => {
      for (const r of rows) {
        if (!r.last_outcome || !KEEP_OUTCOMES.includes(r.last_outcome)) {
          unassignStmt.run(r.id);
          unassigned++;
        }
      }
    });
    tx(toUnassign);
    if (unassigned > 0) {
      console.log(`[v14.50 assignment-sweep] Unassigned ${unassigned} leads whose last outcome was not KIT/Appt.`);
    } else {
      console.log("[v14.50 assignment-sweep] Nothing to unassign — all assignments align with new rule.");
    }
  } catch (err) {
    console.error("[v14.50 assignment-sweep] Failed:", err);
  }

  // ─── v14.64 — STUCK-LEAD SWEEP (one-time, runs on every boot) ─────────
  // Fixes the v14.63 pre-existing bug where Wrong # / Disconnected on the last
  // untried line wrote status='unassigned' instead of 'no_answer'. Those leads
  // are still in the my-next pool with every phone in state 'no_answer_today'
  // or 'struck'. This sweep finds them and flips them to status='no_answer' so
  // the puller stops re-serving them until tomorrow's 8am reset.
  try {
    const stuckRows: any[] = rawDb.prepare(`
      SELECT id, phones, phone_states FROM leads
      WHERE status = 'unassigned' AND phone_states IS NOT NULL AND phones IS NOT NULL
    `).all();
    let flipped = 0;
    for (const r of stuckRows) {
      try {
        const phones: string[] = JSON.parse(r.phones);
        const states: Record<string, string> = JSON.parse(r.phone_states);
        // If ANY phone is still "untried", this lead is legitimately in the pool.
        // If ZERO untried remain, every viable line has been tried today → stuck.
        const anyUntried = phones.some(p => states[p] === "untried");
        if (!anyUntried && phones.length > 0) {
          rawDb.prepare(`UPDATE leads SET status = 'no_answer' WHERE id = ?`).run(r.id);
          rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(r.id);
          flipped++;
        }
      } catch {}
    }
    if (flipped > 0) {
      console.log(`[v14.64 stuck-lead-sweep] Flipped ${flipped} stuck 'unassigned' leads to 'no_answer' (all phones tried today).`);
    }
  } catch (err) {
    console.error("[v14.64 stuck-lead-sweep] Failed:", err);
  }

  // ─── v14.65 — STRUCK-PHONE PURGE SWEEP (one-time per boot, idempotent) ───
  // Bring existing leads into line with the new candidate-list model: struck
  // phones are physically removed from `phones` (and from phoneStates +
  // phoneAttempts), moved to `dead_lines`. Slot label 'Line X of N' then
  // naturally renumbers on the client. Purely a data-migration — no behavior
  // change for leads that already have no struck history.
  try {
    const struckRows: any[] = rawDb.prepare(`
      SELECT id, phones, phone_states, phone_attempts, dead_lines FROM leads
      WHERE phone_states LIKE '%"struck"%' AND phones IS NOT NULL
    `).all();
    let purged = 0;
    for (const r of struckRows) {
      try {
        let phones: string[] = JSON.parse(r.phones || "[]");
        const states: Record<string, string> = JSON.parse(r.phone_states || "{}");
        const attempts: Record<string, number> = r.phone_attempts ? JSON.parse(r.phone_attempts) : {};
        let deadLines: string[] = r.dead_lines ? JSON.parse(r.dead_lines) : [];
        const struckPhones = phones.filter(p => states[p] === "struck");
        if (struckPhones.length === 0) continue;
        phones = phones.filter(p => states[p] !== "struck");
        for (const sp of struckPhones) {
          delete states[sp];
          delete attempts[sp];
          if (!deadLines.includes(sp)) deadLines.push(sp);
        }
        rawDb.prepare(`
          UPDATE leads
             SET phones = ?, phone_states = ?, phone_attempts = ?, dead_lines = ?
           WHERE id = ?
        `).run(
          JSON.stringify(phones),
          JSON.stringify(states),
          JSON.stringify(attempts),
          JSON.stringify(deadLines),
          r.id
        );
        purged++;
      } catch {}
    }
    if (purged > 0) {
      console.log(`[v14.65 struck-phone-purge] Removed struck phones from ${purged} leads (moved to dead_lines).`);
    }
  } catch (err) {
    console.error("[v14.65 struck-phone-purge] Failed:", err);
  }

  // ─── v14.14 — CALLBACK-RETIRE SWEEP (one-time, runs on every boot) ─────
  // Callback outcome fully retired in v14.14. Any remaining `callback_requested`
  // rows flip to `unassigned` (clear assigned agent + callback_date) so they
  // rejoin the shared pool for anyone to pull. Idempotent: 0 rows after first boot.
  try {
    const cbResult = rawDb.prepare(`
      UPDATE leads
         SET status = 'unassigned',
             assigned_agent_id = NULL,
             callback_date = NULL
       WHERE status = 'callback_requested'
    `).run();
    if (cbResult.changes > 0) {
      console.log(`[v14.14 callback-retire] Migrated ${cbResult.changes} callback_requested leads to unassigned`);
    }
  } catch (err) {
    console.error("[v14.14 callback-retire] Failed:", err);
  }

  // ─── AUTH ──────────────────────────────────────────────────────────────────
  // ─── SAFEGUARDS: MIDDLEWARE (v11.70) ──────────────────────────────────────

  // ─ Admin-only route guard ──────────────────────────────────────────────────
  // v14.63 — SECURITY FIX. Previously this checked only the `X-Agent-Id` header,
  // which is spoofable (any curl with `-H "X-Agent-Id: 1"` passed). Now uses the
  // session cookie via attachSession + req.currentAgent (same pattern used by
  // the newer merge / admin-reset-password / audit-log routes). Any tool without
  // a valid session cookie now gets 401 regardless of headers.
  //
  // Cron trigger routes are exempt (they run server-side with no session).
  // They MUST authenticate themselves via INGEST_SECRET or a similar mechanism
  // inside the route body — the exempt list here just skips the session gate.
  const CRON_EXEMPT_PATHS = [
    "/api/admin/stale-lead-audit",
    "/api/admin/dbpr-run",
    "/api/admin/missed-appointments",
  ];
  app.use("/api/admin", (req: any, res: any, next: any) => {
    const fullPath = req.baseUrl + req.path;
    if (CRON_EXEMPT_PATHS.some(p => fullPath.startsWith(p))) return next();
    // req.currentAgent is populated by attachSession middleware iff a valid
    // session cookie is present. Not spoofable.
    if (!req.currentAgent) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.currentAgent.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });

  // ─ Pipeline double-fire guard ──────────────────────────────────────────────
  // Prevents pipeline triggers from firing more than once per 5-minute
  // window, protecting against runaway crons or rapid manual triggers.
  const pipelineLastRun: Record<string, number> = {};
  const PIPELINE_COOLDOWN_MS = 5 * 60 * 1000;
  function pipelineGuard(name: string, req: any, res: any, next: any) {
    const now = Date.now();
    const last = pipelineLastRun[name] || 0;
    if (now - last < PIPELINE_COOLDOWN_MS) {
      const waitSec = Math.ceil((PIPELINE_COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({
        error: `Pipeline '${name}' already ran recently. Wait ${waitSec}s.`,
        cooldownRemaining: waitSec,
      });
    }
    pipelineLastRun[name] = now;
    next();
  }

  // v14.63 — Login rate limiter. 5 failed attempts per IP → 5-minute 429 lockout.
  // In-memory only (no dependency, no DB). Auto-purges old entries.
  const LOGIN_LIMIT_MAX = 5;
  const LOGIN_LIMIT_WINDOW_MS = 5 * 60 * 1000;
  const loginAttempts: Map<string, { count: number; firstFailAt: number; blockedUntil: number | null }> = new Map();
  function loginRateGate(req: any, res: any): boolean {
    const ip = (req.ip || req.socket?.remoteAddress || "unknown") as string;
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    // Purge stale entries occasionally (cheap: every ~50 lookups)
    if (loginAttempts.size > 50 && Math.random() < 0.02) {
      for (const [k, v] of loginAttempts) {
        if ((v.blockedUntil ?? 0) < now && now - v.firstFailAt > LOGIN_LIMIT_WINDOW_MS) loginAttempts.delete(k);
      }
    }
    if (rec && rec.blockedUntil && rec.blockedUntil > now) {
      const waitSec = Math.ceil((rec.blockedUntil - now) / 1000);
      res.status(429).json({ error: `Too many failed login attempts. Try again in ${waitSec} seconds.` });
      return false;
    }
    return true;
  }
  function loginRecordFail(req: any) {
    const ip = (req.ip || req.socket?.remoteAddress || "unknown") as string;
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec || (now - rec.firstFailAt) > LOGIN_LIMIT_WINDOW_MS) {
      loginAttempts.set(ip, { count: 1, firstFailAt: now, blockedUntil: null });
      return;
    }
    rec.count++;
    if (rec.count >= LOGIN_LIMIT_MAX) {
      rec.blockedUntil = now + LOGIN_LIMIT_WINDOW_MS;
    }
  }
  function loginRecordSuccess(req: any) {
    const ip = (req.ip || req.socket?.remoteAddress || "unknown") as string;
    loginAttempts.delete(ip);
  }

  app.post("/api/login", async (req, res) => {
    if (!loginRateGate(req, res)) return;
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
    const agent = storage.getAgentByEmail(email.toLowerCase().trim());
    if (!agent) { loginRecordFail(req); return res.status(401).json({ error: "Invalid email or password" }); }

    // v14.58 — Phase A: bcrypt verify with legacy plaintext fallback.
    // If the row is still legacy plaintext at login time (e.g. boot migration
    // hasn't finished yet), verifyPassword returns ok + needsRehash so we
    // upgrade on the fly.
    const { ok, needsRehash } = await verifyPassword(password, (agent as any).password);
    if (!ok) { loginRecordFail(req); return res.status(401).json({ error: "Invalid email or password" }); }
    if (needsRehash) {
      try {
        const h = await hashPassword(password);
        rawDb.prepare(`UPDATE agents SET password = ? WHERE id = ?`).run(h, agent.id);
      } catch (e) { console.error("[v14.58 auth] on-the-fly rehash failed:", e); }
    }
    if (!agent.isActive) {
      return res.status(403).json({ error: "Your account has been deactivated. Contact an admin." });
    }

    // v14.63 — Successful login clears the rate-limit bucket for this IP.
    loginRecordSuccess(req);

    // Mint a server-side session and set httpOnly cookie. Client also gets a
    // legacy user payload for localStorage compatibility with existing UI.
    const { token } = createSession(agent.id, {
      userAgent: (req.headers["user-agent"] as string) ?? undefined,
      ip: (req.ip || (req.socket && req.socket.remoteAddress)) ?? undefined,
    });
    setSessionCookie(res, token);

    res.json({ agent: {
      id: agent.id, name: agent.name, email: agent.email, role: agent.role,
      headshotUrl: (agent as any).headshotUrl || (agent as any).headshot_url || null,
      homeCounty: (agent as any).homeCounty || (agent as any).home_county || null,
      // v14.81.1 — onboarding gate flags, echoed camelCase from DB snake_case.
      profileCompletedAt: (agent as any).profileCompletedAt || (agent as any).profile_completed_at || null,
      tutorialCompletedAt: (agent as any).tutorialCompletedAt || (agent as any).tutorial_completed_at || null,
    } });
  });

  // v14.58 — Phase A: explicit logout revokes the current session.
  app.post("/api/logout", (req, res) => {
    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (token) revokeSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ─── FORGOT PASSWORD ─────────────────────────────────────────────────────
  app.post("/api/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const agent = storage.getAgentByEmail(email.toLowerCase().trim());
    // Always respond 200 to prevent email enumeration
    res.json({ success: true });
    if (!agent || !agent.isActive) return;

    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1hr
    rawDb.prepare("UPDATE agents SET setup_token = ?, setup_expires = ? WHERE id = ?")
      .run(token, expires, agent.id);

    const appBase = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
    const resetLink = `${appBase}/#/reset-password/${token}`;

    if (resend) {
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: agent.email,
        subject: "Reset your Lead Depot password",
        html: `
          <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:40px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
            <div style="text-align:center;margin-bottom:28px;">
              <svg width="44" height="44" viewBox="0 0 36 36" fill="none" style="margin-bottom:10px;">
                <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" stroke-width="1.6"/>
                <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" stroke-width="1.6" stroke-linejoin="round" fill="none"/>
                <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" stroke-width="1.4"/>
              </svg>
              <p style="color:#c8aa5a;letter-spacing:0.18em;font-size:11px;text-transform:uppercase;margin:0;">Lead Depot</p>
            </div>
            <h1 style="color:#fff;font-weight:300;font-size:24px;margin:0 0 10px;">Password Reset</h1>
            <p style="color:rgba(255,255,255,0.55);font-size:14px;line-height:1.7;margin:0 0 28px;">We received a request to reset the password for your Lead Depot account. Click below to set a new password. This link expires in 1 hour.</p>
            <div style="text-align:center;margin-bottom:28px;">
              <a href="${resetLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#c8aa5a,#a8893a);color:#080808;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;text-decoration:none;">Reset My Password</a>
            </div>
            <p style="color:rgba(255,255,255,0.25);font-size:12px;line-height:1.6;border-top:1px solid rgba(200,170,90,0.1);padding-top:18px;">If you didn't request a password reset, you can safely ignore this email. Your password will not change.<br/><br/>Lead Depot · Brothers Group at Momentum Realty</p>
          </div>
        `,
      });
    }
  });

  // GET /api/reset-password/:token — validate reset token
  app.get("/api/reset-password/:token", (req, res) => {
    const { token } = req.params;
    const agent = rawDb.prepare("SELECT id, name, email, setup_expires FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired reset link" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "This reset link has expired. Request a new one." });
    res.json({ id: agent.id, name: agent.name, email: agent.email });
  });

  // POST /api/reset-password/:token — set new password (bcrypt-hashed)
  app.post("/api/reset-password/:token", async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const agent = rawDb.prepare("SELECT id, setup_expires FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired reset link" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Link expired" });
    const hash = await hashPassword(password);
    rawDb.prepare("UPDATE agents SET password = ?, setup_token = NULL, setup_expires = NULL WHERE id = ?")
      .run(hash, agent.id);
    // Password change from an unauthenticated reset flow revokes all existing
    // sessions for that agent — forces the attacker off if this was a takeover.
    revokeAllSessionsForAgent(agent.id);
    logAgentEvent({
      actorId: agent.id, // token-proven mailbox control
      targetId: agent.id,
      event: "password_reset",
      before: null,
      after: null,
      notes: "Password set via /reset-password token (forgot-password flow). All sessions revoked.",
    });
    res.json({ success: true });
  });

  // Session validation — called on app load to verify stored user is still active
  // v14.58 — Phase A: prefers the httpOnly session cookie when present; falls
  // back to :id-lookup only when the caller session is that :id OR is admin
  // OR there is no session yet (transition compatibility for existing
  // localStorage-only clients that haven't logged in since v14.58 shipped).
  app.get("/api/me/:id", (req, res) => {
    const id = parseInt(req.params.id);
    // If session is present but points at a different agent (and caller is not
    // admin), reject — the client's stored id is stale/spoofed.
    if (req.currentAgent && req.currentAgent.id !== id && req.currentAgent.role !== "admin") {
      return res.status(403).json({ error: "Session mismatch — please log in again" });
    }
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Not found" });
    if (!agent.isActive) return res.status(403).json({ error: "Account deactivated" });
    // v14.81.1 — Drizzle exposes camelCase (headshotUrl, homeAddress) not snake_case.
    // Previous version read agent.headshot_url which is always undefined, so the
    // profile page fell back to initials even when the DB had a real headshot.
    const a = agent as any;
    res.json({ agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      phone: a.phone ?? "",
      brokerage: a.brokerage ?? "",
      homeAddress: a.homeAddress ?? a.home_address ?? "",
      headshotUrl: a.headshotUrl ?? a.headshot_url ?? "",
      homeCounty: a.homeCounty ?? a.home_county ?? null,
      // v14.81.1 — onboarding gate flags (camelCase, echoing DB values).
      profileCompletedAt: a.profileCompletedAt ?? a.profile_completed_at ?? null,
      tutorialCompletedAt: a.tutorialCompletedAt ?? a.tutorial_completed_at ?? null,
    }});
  });

  // ─── AGENTS ───────────────────────────────────────────────────────────────
  app.get("/api/agents", (req, res) => {
    const all = storage.getAllAgents();
    res.json(all.map(a => ({ ...a, password: undefined })));
  });

  app.post("/api/agents", async (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Admin-only create.
    if (!requireAdmin(req, res)) return;
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    // v14.58 — Phase A: legacy admin-create endpoint (unused by current UI, kept
    // for backwards compat + test tooling). Hash the password like every other path.
    const hash = await hashPassword(password);
    try {
      const agent = storage.createAgent({
        name,
        email: email.toLowerCase().trim(),
        password: hash,
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
    // v14.63 — SECURITY: was fully ungated. Anyone could rewrite any agent's
    // profile fields. Now: self-or-admin.
    const id = parseInt(req.params.id);
    if (!requireSelfOrAdmin(req, res, id)) return;
    // Safeguard (v11.70): whitelist allowed fields — never let client overwrite
    // role, password, id, or receiveLeads without going through dedicated routes
    // v12.5 — territory1/territory2 replace territory. Legacy "territory" is still
    // accepted for one release as a compatibility shim (goes into territory1).
    const ALLOWED_AGENT_PATCH_FIELDS = [
      "name", "email", "phone", "brokerage", "homeAddress", "headshotUrl",
      "isActive", "leadFlowOn", "territory", "territory1", "territory2",
      "territoryClosedNotice", "onboarded",
    ] as const;
    const patch: Record<string, any> = {};
    for (const key of ALLOWED_AGENT_PATCH_FIELDS) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No valid fields to update" });

    // v14.58 — Email hygiene on agent edits. Login resolves via
    // storage.getAgentByEmail(email.toLowerCase().trim()), so we (a) normalize the
    // stored value to lowercase+trim to keep it canonical, and (b) block any change
    // that would collide with a different agent's login. Without this guard, an admin
    // could accidentally point two rows at the same email and one of them would
    // silently become unloginnable (whichever row loses the getAgentByEmail race).
    if (typeof patch.email === "string") {
      const normalized = patch.email.toLowerCase().trim();
      if (!normalized) {
        return res.status(400).json({ error: "Email cannot be blank" });
      }
      if (normalized.startsWith("tombstone:")) {
        return res.status(400).json({ error: "Refusing to write a tombstone sentinel as an email." });
      }
      // v14.60 — exclude tombstoned rows from the collision check so re-inviting a
      // merged agent's original email works. Tombstones have merged_into_agent_id
      // set AND email prefixed with 'tombstone:'.
      const collision = rawDb.prepare(
        "SELECT id, name FROM agents WHERE LOWER(email) = ? AND id <> ? AND merged_into_agent_id IS NULL"
      ).get(normalized, id) as { id: number; name: string } | undefined;
      if (collision) {
        return res.status(409).json({
          error: `Email ${normalized} is already used by agent id=${collision.id} (${collision.name}). Pick a different email or merge the two accounts via /api/admin/agents/merge.`,
        });
      }
      patch.email = normalized;
    }

    const updated = storage.updateAgent(id, patch);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // ─── AGENT INVITATION ─────────────────────────────────────────────────────
  // POST /api/agents/invite — admin sends invite with just name + email
  app.post("/api/agents/invite", async (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Anyone could send Lead Depot
    // invite emails from noreply@ (spam / deliverability / DB injection risk).
    if (!requireAdmin(req, res)) return;
    const { name, email, role: reqRole } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Name and email required" });
    const cleanEmail = email.toLowerCase().trim();
    // v12.5 — recruiter role is gone; only admin/agent supported.
    const assignedRole = ["admin", "agent"].includes(reqRole) ? reqRole : "agent";

    // Check duplicate email (case-insensitive; email is stored lowercased so LOWER on
    // the column is a defensive belt-and-suspenders in case any legacy row drifted).
    // v14.60 — exclude tombstoned rows so re-inviting a merged agent's original
    // email is allowed (tombstones have merged_into_agent_id set).
    const existing = rawDb.prepare(
      "SELECT id FROM agents WHERE LOWER(email) = ? AND merged_into_agent_id IS NULL"
    ).get(cleanEmail);
    if (existing) return res.status(409).json({ error: "An agent with this email already exists" });

    // v14.58 — Same-name duplicate warning. Merged rows have their email renamed to
    // a tombstone sentinel (v14.60 shape: 'tombstone:<sourceId>:<oldEmail>';
    // v14.58 legacy shape: '_merged_into_<targetId>_from_<sourceId>_<oldEmail>').
    // Either way the email uniqueness check above passes for a re-invite with the
    // pre-merge email. This lets duplicates slip through if an admin re-invites
    // the same person after a merge.
    // Guard: if an ACTIVE agent already exists with the same name, block the invite
    // and instruct the admin to edit the existing agent's email instead.
    // Bypass by passing { forceDuplicateName: true } in the request body.
    if (!req.body?.forceDuplicateName) {
      const sameNameActive = rawDb.prepare(
        "SELECT id, email FROM agents WHERE LOWER(name) = LOWER(?) AND is_active = 1"
      ).get(name);
      if (sameNameActive) {
        return res.status(409).json({
          error: `An active agent named "${name}" already exists (id=${sameNameActive.id}, ${sameNameActive.email}). If you want them to use a different email, edit their profile instead of sending a new invite. To create anyway (rare), retry with forceDuplicateName: true.`,
          existingAgentId: sameNameActive.id,
          existingAgentEmail: sameNameActive.email,
        });
      }
    }

    // Create account with random temp password (they'll set their own via /setup link)
    // v14.58 — Phase A: hash the throwaway too so no plaintext ever hits disk.
    const tempPass = randomBytes(12).toString("hex");
    const tempHash = await hashPassword(tempPass);
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72h

    let agent: any;
    try {
      agent = storage.createAgent({
        name,
        email: cleanEmail,
        password: tempHash,
        role: assignedRole,
        roundRobinOrder: 0,
        isActive: true,
      });
    } catch (e: any) {
      return res.status(409).json({ error: "Email already exists" });
    }

    // Store token + mark not yet onboarded
    rawDb.prepare("UPDATE agents SET setup_token = ?, setup_expires = ?, onboarded = 0 WHERE id = ?")
      .run(token, expires, agent.id);

    // Determine app base URL
    const appBase = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
    const setupLink = `${appBase}/#/setup/${token}`;

    // Send invitation email
    if (resend) {
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: cleanEmail,
        subject: "You're invited to Lead Depot — Complete your account setup",
        html: `
          <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:40px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
            <div style="text-align:center;margin-bottom:32px;">
              <svg width="44" height="44" viewBox="0 0 36 36" fill="none" style="margin-bottom:12px;">
                <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" stroke-width="1.6"/>
                <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" stroke-width="1.6" stroke-linejoin="round" fill="none"/>
                <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" stroke-width="1.4"/>
              </svg>
              <p style="color:#c8aa5a;letter-spacing:0.18em;font-size:11px;text-transform:uppercase;margin:0;">Brothers Group · Momentum Realty</p>
            </div>
            <h1 style="color:#fff;font-weight:300;font-size:28px;margin:0 0 8px;">Welcome, ${name}.</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.7;margin:0 0 32px;">You've been invited to <strong style="color:#c8aa5a;">Lead Depot</strong> — the lead management platform for Brothers Group at Momentum Realty. Click below to set up your account with a secure password and complete your agent profile.</p>
            <div style="text-align:center;margin-bottom:32px;">
              <a href="${setupLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#c8aa5a,#a8893a);color:#080808;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;text-decoration:none;">Complete My Account Setup</a>
            </div>
            <p style="color:rgba(255,255,255,0.35);font-size:12px;line-height:1.6;border-top:1px solid rgba(200,170,90,0.15);padding-top:20px;">This invitation link expires in 72 hours. If you did not expect this invitation, you can safely ignore this email.<br/><br/>Lead Depot · Brothers Group at Momentum Realty · Fernandina Beach, FL</p>
          </div>
        `,
      });
    }

    console.log(`[invite] agent created id=${agent.id} name="${name}" email=${cleanEmail} role=${assignedRole} at ${new Date().toISOString()}`);
    res.json({ success: true, agentId: agent.id });
  });

  // GET /api/agents/setup/:token — validate token and return agent name/email
  app.get("/api/agents/setup/:token", (req, res) => {
    const { token } = req.params;
    const agent = rawDb.prepare("SELECT id, name, email, setup_expires, onboarded FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired setup link" });
    if (agent.onboarded) return res.status(410).json({ error: "This setup link has already been used" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Setup link has expired. Ask your admin to resend the invite." });
    res.json({ id: agent.id, name: agent.name, email: agent.email });
  });

  // POST /api/agents/setup/:token — complete onboarding
  app.post("/api/agents/setup/:token", async (req, res) => {
    const { token } = req.params;
    const { password, phone, brokerage, homeAddress, headshotUrl } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const agent = rawDb.prepare("SELECT id, name, email, setup_expires, onboarded FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired setup link" });
    if (agent.onboarded) return res.status(410).json({ error: "Already set up" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Link expired" });

    // v14.58 — Phase A: bcrypt-hash the chosen password before persisting.
    const passwordHash = await hashPassword(password);

    // Update agent — set real password + profile + mark onboarded, clear token
    rawDb.prepare(`
      UPDATE agents SET
        password = ?,
        phone = ?,
        brokerage = ?,
        home_address = ?,
        headshot_url = ?,
        onboarded = 1,
        setup_token = NULL,
        setup_expires = NULL
      WHERE id = ?
    `).run(passwordHash, phone ?? "", brokerage ?? "", homeAddress ?? "", headshotUrl ?? "", agent.id);

    // Fresh setup wipes any stale session for this agent (defense-in-depth).
    revokeAllSessionsForAgent(agent.id);

    res.json({ success: true, name: agent.name, email: agent.email });
  });


  // ─── HELPER: count agents currently able to receive leads ──────────────────
  // v14.48 — Flow is the ONLY gate. No isActive, no receiveLeads, no role checks.
  function countLeadReceivers(excludeId?: number): number {
    const allAgents = storage.getAllAgents ? storage.getAllAgents() : [];
    return allAgents.filter((a: any) => {
      if (a.id === excludeId) return false;
      return a.leadFlowOn !== false && a.leadFlowOn !== 0;
    }).length;
  }

  // Soft-delete: mark agent as inactive, redistribute leads with correct rules per status
  // v14.61 Phase C — requires admin session, stamps deactivated_at (unix ms), revokes
  // all live sessions for the target agent, and logs a `deactivated` audit event.
  app.delete("/api/agents/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    // Guard: must always have at least one lead receiver after deactivation
    const receiversAfter = countLeadReceivers(id);
    if (receiversAfter === 0) {
      return res.status(409).json({
        error: "Cannot deactivate — at least one agent must be able to receive leads at all times. Activate another agent first, or enable lead flow on an admin.",
      });
    }
    const before = storage.getAgentById(id);
    if (!before) return res.status(404).json({ error: "Agent not found" });
    const deactivatedAt = Date.now();
    const updated = storage.updateAgent(id, { isActive: false, leadFlowOn: false, deactivatedAt } as any);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    // v14.61 — kick any live sessions so the agent can't stay logged in after
    // deactivation. Was previously stale-until-refresh.
    revokeAllSessionsForAgent(id);
    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: id,
      event: "deactivated",
      before: { isActive: true, leadFlowOn: before.leadFlowOn, deactivatedAt: null },
      after:  { isActive: false, leadFlowOn: false, deactivatedAt },
      notes: `Deactivated by ${req.currentAgent?.name ?? "unknown admin"}.`,
    });

    // SQL: only fetch this agent's leads — avoids loading all leads (v11.70)
    const agentLeadsToProcess: any[] = rawDb.prepare(
      `SELECT id, status, lead_type as leadType FROM leads WHERE assigned_agent_id = ?`
    ).all(id);
    let reassigned = 0;
    let callbackHeld = 0;
    let preserved = 0;

    for (const lead of agentLeadsToProcess) {
      if (lead.status === "keep_in_touch" || lead.status === "contacted_appointment") {
        // Agent already won these — relationship established, appt set. Leave untouched.
        preserved++;
        continue;
      }

      if (lead.status === "callback_requested") {
        // v14.50 — PULL MODE: callback leads go back to the shared pool on deactivation.
        storage.createLeadActivity({
          leadId: lead.id,
          agentId: null,
          outcome: "recycled",
          notes: `Agent deactivated. Callback lead returned to shared pool from ${updated.name}.`,
          lpmamabSnapshot: null,
          createdAt: new Date().toISOString(),
        });
        storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
        callbackHeld++;
        continue;
      }

      // v14.50 — PULL MODE: everything else also returns to the shared pool.
      // Next agent will pick it up via Load Next Lead.
      storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
    }

    broadcast({ type: "leads_updated" });
    broadcast({ type: "activity_event", event: { type: "agent_deactivated", agentId: id, agentName: updated.name, ts: new Date().toISOString() } });
    res.json({ ...updated, password: undefined, reassigned, callbackHeld, preserved });
  });

  // v14.58 — Admin-only agent merge endpoint. Merges a duplicate/stale agent record
  // into a canonical agent record: reassigns every child row that references the source
  // agent to point at the target, then deactivates + hides the source. All in a single
  // SQLite transaction so we never leave orphaned FKs behind.
  //
  // Ships specifically for the Denise Jacobs dedupe (source id=11 djacobs312@gmail.com →
  // target id=10 denise@watsonbrothersgroup.com) but is generic — any admin can point
  // it at any (source, target) pair via the admin-guarded /api/admin route family.
  //
  // Preflight guards:
  //   - source_id !== target_id
  //   - both agents must exist
  //   - target must be active (don't merge into a deleted account)
  //   - source must be inactive (safety: use DELETE first to deactivate)
  //
  // FK tables covered (matches shared/schema.ts):
  //   leads.assigned_agent_id
  //   lead_activity.agent_id
  //   round_robin_state.last_assigned_agent_id
  //   agent_points.agent_id
  //   agent_leads.assigned_admin_id
  //   agent_leads.uploaded_by
  //   agent_lead_activity.caller_id
  //   lead_locks.agent_id
  app.post("/api/admin/agents/merge", (req: any, res: any) => {
    const sourceId = parseInt(String(req.body?.sourceId ?? ""));
    const targetId = parseInt(String(req.body?.targetId ?? ""));
    if (!sourceId || !targetId || isNaN(sourceId) || isNaN(targetId)) {
      return res.status(400).json({ error: "sourceId and targetId are required integers" });
    }
    if (sourceId === targetId) {
      return res.status(400).json({ error: "sourceId and targetId must be different" });
    }
    const source = storage.getAgentById(sourceId);
    const target = storage.getAgentById(targetId);
    if (!source) return res.status(404).json({ error: `Source agent ${sourceId} not found` });
    if (!target) return res.status(404).json({ error: `Target agent ${targetId} not found` });
    if (!target.isActive) {
      return res.status(409).json({
        error: `Target agent ${targetId} (${target.name}) is inactive. Merge target must be active.`,
      });
    }
    if (source.isActive) {
      return res.status(409).json({
        error: `Source agent ${sourceId} (${source.name}) is still active. Deactivate the source first (DELETE /api/agents/${sourceId}) before merging.`,
      });
    }

    const counts: Record<string, number> = {};
    const tx = rawDb.transaction(() => {
      counts.leads = rawDb.prepare(`UPDATE leads SET assigned_agent_id = ? WHERE assigned_agent_id = ?`).run(targetId, sourceId).changes;
      counts.lead_activity = rawDb.prepare(`UPDATE lead_activity SET agent_id = ? WHERE agent_id = ?`).run(targetId, sourceId).changes;
      counts.round_robin_state = rawDb.prepare(`UPDATE round_robin_state SET last_assigned_agent_id = ? WHERE last_assigned_agent_id = ?`).run(targetId, sourceId).changes;
      counts.agent_points = rawDb.prepare(`UPDATE agent_points SET agent_id = ? WHERE agent_id = ?`).run(targetId, sourceId).changes;
      counts.agent_leads_assigned_admin = rawDb.prepare(`UPDATE agent_leads SET assigned_admin_id = ? WHERE assigned_admin_id = ?`).run(targetId, sourceId).changes;
      counts.agent_leads_uploaded_by = rawDb.prepare(`UPDATE agent_leads SET uploaded_by = ? WHERE uploaded_by = ?`).run(targetId, sourceId).changes;
      counts.agent_lead_activity = rawDb.prepare(`UPDATE agent_lead_activity SET caller_id = ? WHERE caller_id = ?`).run(targetId, sourceId).changes;
      counts.lead_locks = rawDb.prepare(`UPDATE lead_locks SET agent_id = ? WHERE agent_id = ?`).run(targetId, sourceId).changes;
      // v14.60 tombstone shape (Bucket 5 Phase B). Hide the source:
      // force-deactivate + null out lead-flow + rewrite email to sentinel
      // 'tombstone:<sourceId>:<origEmail>' so no real email can ever match it in
      // login. Also set merged_into_agent_id = <targetId> so tombstones are
      // programmatically discoverable via `WHERE merged_into_agent_id IS NOT NULL`.
      // Belt-and-suspenders uniqueness guard: append "#N" only if a prior tombstone
      // with identical sentinel already exists (extremely rare but possible if the
      // same source is somehow processed twice).
      let tsEmail = `tombstone:${sourceId}:${source.email}`;
      let n = 0;
      while (rawDb.prepare("SELECT 1 FROM agents WHERE email = ? AND id <> ?").get(tsEmail, sourceId)) {
        n++;
        tsEmail = `tombstone:${sourceId}:${source.email}#${n}`;
        if (n > 5) break;
      }
      rawDb.prepare(`UPDATE agents SET is_active = 0, lead_flow_on = 0, receive_leads = 0, email = ?, merged_into_agent_id = ? WHERE id = ?`).run(
        tsEmail,
        targetId,
        sourceId,
      );
      // Also revoke any active sessions the tombstoned agent may hold. Phase A
      // sessions are keyed to agent_id, so this closes any lingering logged-in
      // browser window that was authenticated as the now-merged source.
      rawDb.prepare(`UPDATE sessions SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`)
        .run(new Date().toISOString(), sourceId);
    });

    try {
      tx();
    } catch (err: any) {
      console.error("[merge] Transaction failed:", err);
      return res.status(500).json({ error: `Merge failed: ${err.message}` });
    }

    // v14.61 Phase C — audit both sides of the merge.
    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: sourceId,
      event: "merged_into",
      before: { email: source.email, isActive: source.isActive, merged_into_agent_id: null },
      after:  { email: `tombstone:${sourceId}:${source.email}`, isActive: false, merged_into_agent_id: targetId },
      notes: `Merged into agent ${targetId} (${target.name}). Rows reassigned: ${JSON.stringify(counts)}. By ${req.currentAgent?.name ?? "unknown admin"}.`,
    });
    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: targetId,
      event: "merge_received",
      before: null,
      after: { rows_absorbed: counts },
      notes: `Absorbed agent ${sourceId} (${source.name} / ${source.email}). By ${req.currentAgent?.name ?? "unknown admin"}.`,
    });

    console.log(`[merge] Merged agent ${sourceId} (${source.name} / ${source.email}) → ${targetId} (${target.name} / ${target.email})`, counts);

    broadcast({ type: "leads_updated" });
    broadcast({ type: "activity_event", event: {
      type: "agent_merged",
      sourceId, sourceName: source.name, sourceEmail: source.email,
      targetId, targetName: target.name, targetEmail: target.email,
      counts,
      ts: new Date().toISOString(),
    } });

    res.json({
      ok: true,
      source: { id: sourceId, name: source.name, email: source.email },
      target: { id: targetId, name: target.name, email: target.email },
      counts,
      total_rows_reassigned: Object.values(counts).reduce((a, b) => a + b, 0),
    });
  });

  // ─── EMAIL CHANGE (Bucket 5 Phase B — v14.60) ─────────────────────
  //
  // The correct way to change an agent's login email. Two paths:
  //   • ADMIN actor  → instant change + revokes all sessions for that agent so
  //     any active browser must re-login with the new email.
  //   • SELF actor   → stashes the new address in pending_email + mints a
  //     verification token, sends a link to the NEW address. Only when the agent
  //     clicks the link (proving control of the new mailbox) does email flip.
  //
  // The generic PATCH /api/agents/:id still accepts email edits for admin UIs that
  // haven't migrated yet, but self-service flows should route through here.
  app.patch("/api/agents/:id/email", async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (!requireSelfOrAdmin(req, res, id)) return;
    const newEmailRaw = req.body?.newEmail;
    if (typeof newEmailRaw !== "string" || !newEmailRaw.trim()) {
      return res.status(400).json({ error: "newEmail is required" });
    }
    const normalized = newEmailRaw.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: "newEmail is not a valid email address" });
    }
    if (normalized.startsWith("tombstone:")) {
      return res.status(400).json({ error: "Refusing to write a tombstone sentinel as an email." });
    }
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.email === normalized) return res.status(400).json({ error: "That is already your email." });

    // Collision check — excludes tombstoned rows.
    const collision = rawDb.prepare(
      "SELECT id, name FROM agents WHERE LOWER(email) = ? AND id <> ? AND merged_into_agent_id IS NULL"
    ).get(normalized, id) as { id: number; name: string } | undefined;
    if (collision) {
      return res.status(409).json({
        error: `Email ${normalized} is already used by agent id=${collision.id} (${collision.name}).`,
      });
    }

    const isAdminActor = req.currentAgent?.role === "admin" && req.currentAgent.id !== id;

    if (isAdminActor) {
      // Admin path — instant change, revoke all sessions, log it.
      rawDb.prepare("UPDATE agents SET email = ?, pending_email = NULL, pending_email_token = NULL, pending_email_expires = NULL WHERE id = ?")
        .run(normalized, id);
      revokeAllSessionsForAgent(id);
      console.log(`[email-change] admin ${req.currentAgent?.email} (${req.currentAgent?.id}) changed agent ${id} email: ${agent.email} → ${normalized}`);
      logAgentEvent({
        actorId: req.currentAgent?.id ?? null,
        targetId: id,
        event: "email_changed",
        before: { email: agent.email },
        after:  { email: normalized },
        notes: `Admin instant change by ${req.currentAgent?.name ?? "admin"}. All sessions revoked.`,
      });
      broadcast({ type: "activity_event", event: {
        type: "agent_email_changed_by_admin",
        adminId: req.currentAgent?.id, adminEmail: req.currentAgent?.email,
        agentId: id, oldEmail: agent.email, newEmail: normalized,
        ts: new Date().toISOString(),
      } });
      return res.json({ ok: true, path: "admin_instant", newEmail: normalized });
    }

    // Self-service path — pending + verification token to the NEW address.
    const token = randomBytes(32).toString("hex");
    const tokenHash = sha256(token);
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
    rawDb.prepare("UPDATE agents SET pending_email = ?, pending_email_token = ?, pending_email_expires = ? WHERE id = ?")
      .run(normalized, tokenHash, expires, id);

    const appBase = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
    const verifyLink = `${appBase}/api/agents/verify-email/${token}`;

    if (resend) {
      try {
        await resend.emails.send({
          from: "Lead Depot <noreply@watsonbrothersgroup.com>",
          to: normalized,
          subject: "Confirm your new Lead Depot email address",
          html: `
            <div style="font-family:Georgia,serif;background:#09090b;color:#e5e5e5;padding:40px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
              <h2 style="color:#facc15;margin-top:0;">Confirm your new email</h2>
              <p>Hi ${agent.name},</p>
              <p>You (or someone with your Lead Depot login) requested to change your login email from <strong>${agent.email}</strong> to <strong>${normalized}</strong>.</p>
              <p>Click the button below within 24 hours to confirm. If you didn't request this, ignore this email — your login will not change.</p>
              <p style="text-align:center;margin:32px 0;">
                <a href="${verifyLink}" style="background:#facc15;color:#09090b;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Confirm new email</a>
              </p>
              <p style="color:#71717a;font-size:12px;">If the button doesn't work, paste this link into your browser:<br>${verifyLink}</p>
              <p style="color:#71717a;font-size:12px;margin-top:24px;">— Brothers Group Real Estate Team at Momentum Realty<br>Lead Depot v14.81.1</p>
            </div>
          `,
        });
      } catch (e: any) {
        console.error("[email-change] resend send failed:", e?.message);
        // Do not roll back — the pending state is still valid, agent can retry.
      }
    }

    console.log(`[email-change] self-request: agent ${id} (${agent.email}) requested → ${normalized}, verify link sent`);
    logAgentEvent({
      actorId: id,
      targetId: id,
      event: "email_change_requested",
      before: { email: agent.email },
      after:  { pending_email: normalized, expires_at: expires },
      notes: "Self-service email change: verification link sent to new address.",
    });
    res.json({ ok: true, path: "self_pending_verification", pendingEmail: normalized, expiresAt: expires });
  });

  // GET /api/agents/verify-email/:token — apply pending_email after user clicks link.
  // No session required: the token IS the proof of mailbox control.
  app.get("/api/agents/verify-email/:token", (req, res) => {
    const token = req.params.token;
    if (!token || token.length < 32) return res.status(400).send("Invalid token");
    const tokenHash = sha256(token);
    const now = new Date().toISOString();
    const row = rawDb.prepare(
      "SELECT id, email, pending_email, pending_email_expires FROM agents WHERE pending_email_token = ?"
    ).get(tokenHash) as { id: number; email: string; pending_email: string; pending_email_expires: string } | undefined;
    if (!row) return res.status(404).type("html").send("<h1>Link is invalid or already used.</h1>");
    if (row.pending_email_expires < now) {
      return res.status(410).type("html").send("<h1>This link has expired.</h1><p>Request a new email change from your profile.</p>");
    }
    // Collision recheck — someone else may have grabbed this email between request and click.
    const collision = rawDb.prepare(
      "SELECT id, name FROM agents WHERE LOWER(email) = ? AND id <> ? AND merged_into_agent_id IS NULL"
    ).get(row.pending_email, row.id) as { id: number; name: string } | undefined;
    if (collision) {
      // Clear the pending state so the agent can request again with a different address.
      rawDb.prepare("UPDATE agents SET pending_email = NULL, pending_email_token = NULL, pending_email_expires = NULL WHERE id = ?").run(row.id);
      return res.status(409).type("html").send("<h1>Email already in use.</h1><p>Someone else claimed that address while you were verifying. Please pick a different one.</p>");
    }
    rawDb.prepare("UPDATE agents SET email = ?, pending_email = NULL, pending_email_token = NULL, pending_email_expires = NULL WHERE id = ?")
      .run(row.pending_email, row.id);
    // Revoke all sessions for the agent — they'll re-login with the new email everywhere.
    revokeAllSessionsForAgent(row.id);
    console.log(`[email-change] verified: agent ${row.id} ${row.email} → ${row.pending_email}`);
    logAgentEvent({
      actorId: row.id, // self-verified via mailbox proof
      targetId: row.id,
      event: "email_change_verified",
      before: { email: row.email },
      after:  { email: row.pending_email },
      notes: "Self-service email change verified via link click. All sessions revoked.",
    });
    broadcast({ type: "activity_event", event: {
      type: "agent_email_changed_verified",
      agentId: row.id, oldEmail: row.email, newEmail: row.pending_email,
      ts: new Date().toISOString(),
    } });
    res.type("html").send(`
      <div style="font-family:Georgia,serif;background:#09090b;color:#e5e5e5;padding:60px 24px;max-width:600px;margin:0 auto;text-align:center;min-height:100vh;">
        <h1 style="color:#facc15;">Email updated</h1>
        <p>Your Lead Depot login is now <strong>${row.pending_email}</strong>.</p>
        <p>Any signed-in browser sessions have been logged out for security. Please sign in again with your new email.</p>
        <p style="margin-top:32px;"><a href="https://depot.watsonbrothersgroup.com/" style="background:#facc15;color:#09090b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Go to Lead Depot</a></p>
      </div>
    `);
  });

  // Reactivate a trashed agent
  // v14.48 — Legacy endpoint kept for backward compatibility. UI no longer calls it
  // (there is no Inactive Agents section anymore). Restores account + turns Flow on.
  // v14.61 Phase C — requires admin session, enforces 7-day undo window from
  // deactivated_at (grandfathered rows with NULL are always allowed), clears the
  // timestamp on success, and logs a `reactivated` audit event.
  app.patch("/api/agents/:id/reactivate", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const before = storage.getAgentById(id);
    if (!before) return res.status(404).json({ error: "Agent not found" });
    const deactivatedAt = (before as any).deactivatedAt ?? null;
    // v14.81.1 — Removed the 7-day reactivate window. Admins should be able to
    // reactivate ANY inactive agent (including legacy rows with no timestamp)
    // at any time. If they want the row gone permanently, they use hard-delete
    // instead. Removed the isWithinReactivateWindow gate entirely.
    const updated = storage.updateAgent(id, { isActive: true, leadFlowOn: true, deactivatedAt: null } as any);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: id,
      event: "reactivated",
      before: { isActive: false, deactivatedAt },
      after:  { isActive: true, deactivatedAt: null },
      notes: `Reactivated by ${req.currentAgent?.name ?? "unknown admin"} within ${Math.floor((Date.now() - (deactivatedAt ?? Date.now())) / (60*60*1000))}h of deactivation.`,
    });
    res.json({ ...updated, password: undefined });
  });

  // v14.61 Phase C — admin-only audit log fetch for one agent.
  // Returns the full lifecycle trail (most recent first) so Phase D's admin
  // Agent Lifecycle tab can render "who did what, when".
  app.get("/api/admin/agents/:id/audit-log", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const limit = Math.min(500, parseInt(String(req.query?.limit ?? "200")) || 200);
    const rows = getAgentAuditLog(id, limit);
    res.json({ agentId: id, count: rows.length, entries: rows });
  });

  // v14.62 Phase D — admin-triggered password reset for a specific agent.
  // Thin wrapper around the forgot-password flow that (a) accepts an agent ID
  // instead of an email lookup so admin can trigger from a row click without
  // retyping, (b) requires admin session, (c) returns real success/failure so
  // the admin sees a toast instead of the silent 200-always contract used on
  // the public forgot-password endpoint (which is silent to prevent email
  // enumeration). Both endpoints go through the same underlying token-mint +
  // Resend email path, so admin-initiated + self-initiated resets cannot
  // diverge. Audit-logs as password_reset with actor=admin, notes=admin_triggered.
  app.post("/api/admin/agents/:id/reset-password", async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!agent.isActive) return res.status(400).json({ error: "Cannot reset password on deactivated / tombstoned agent" });
    if (!agent.email || agent.email.startsWith("tombstone:")) {
      return res.status(400).json({ error: "Agent has no valid email address" });
    }

    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1hr
    rawDb.prepare("UPDATE agents SET setup_token = ?, setup_expires = ? WHERE id = ?")
      .run(token, expires, agent.id);

    const appBase = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
    const resetLink = `${appBase}/#/reset-password/${token}`;

    let emailSent = false;
    let emailError: string | null = null;
    if (resend) {
      try {
        await resend.emails.send({
          from: "Lead Depot <noreply@watsonbrothersgroup.com>",
          to: agent.email,
          subject: "Reset your Lead Depot password",
          html: `
            <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:40px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
              <div style="text-align:center;margin-bottom:28px;">
                <p style="color:#c8aa5a;letter-spacing:0.18em;font-size:11px;text-transform:uppercase;margin:0;">Lead Depot</p>
              </div>
              <h1 style="color:#fff;font-weight:300;font-size:24px;margin:0 0 10px;">Password Reset</h1>
              <p style="color:rgba(255,255,255,0.55);font-size:14px;line-height:1.7;margin:0 0 28px;">Your Brothers Group admin sent you a password reset link for your Lead Depot account. Click below to set a new password. This link expires in 1 hour.</p>
              <div style="text-align:center;margin-bottom:28px;">
                <a href="${resetLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#c8aa5a,#a8893a);color:#080808;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;text-decoration:none;">Reset My Password</a>
              </div>
              <p style="color:rgba(255,255,255,0.25);font-size:12px;line-height:1.6;border-top:1px solid rgba(200,170,90,0.1);padding-top:18px;">If you weren't expecting this reset, ignore this email — your password will not change. Lead Depot v14.81.1 · Brothers Group Real Estate Team at Momentum Realty</p>
            </div>
          `,
        });
        emailSent = true;
      } catch (err: any) {
        emailError = err?.message ?? "send_failed";
      }
    } else {
      emailError = "resend_not_configured";
    }

    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: id,
      event: "password_reset",
      before: { hasSetupToken: false },
      after: { hasSetupToken: true, expires },
      notes: `Admin-triggered password reset by ${req.currentAgent?.name ?? "unknown admin"}. email_sent=${emailSent}${emailError ? " error="+emailError : ""}.`,
    });

    if (!emailSent) {
      return res.status(502).json({
        error: emailError === "resend_not_configured"
          ? "Resend is not configured on this server"
          : `Email send failed: ${emailError}`,
      });
    }
    res.json({ success: true, email: agent.email });
  });

  // ─── AGENT PROFILE SELF-SERVICE ──────────────────────────────────────────────

  // Update own profile (name, email, phone, brokerage, homeAddress, headshotUrl)
  app.patch("/api/agents/:id/profile", (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Now self-or-admin.
    const id = parseInt(req.params.id);
    if (!requireSelfOrAdmin(req, res, id)) return;
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const { name, email, phone, brokerage, homeAddress, headshotUrl } = req.body;
    // Validate email uniqueness if changed
    if (email && email.toLowerCase().trim() !== agent.email) {
      const existing = storage.getAgentByEmail(email.toLowerCase().trim());
      if (existing) return res.status(409).json({ error: "Email already in use" });
    }
    const updates: any = {};
    if (name        !== undefined) updates.name        = name.trim();
    if (email       !== undefined) updates.email       = email.toLowerCase().trim();
    if (phone       !== undefined) updates.phone       = phone.trim();
    if (brokerage   !== undefined) updates.brokerage   = brokerage.trim();
    if (homeAddress !== undefined) updates.homeAddress = homeAddress.trim();
    if (headshotUrl !== undefined) updates.headshotUrl = headshotUrl.trim();
    const updated = storage.updateAgent(id, updates);
    if (!updated) return res.status(500).json({ error: "Update failed" });
    res.json({ ...updated, password: undefined });
  });

  // ─── ONBOARDING: Profile gate + Tutorial flow (v14.81.1) ────────────────────

  // POST /api/agent/complete-profile — marks the CURRENT authenticated agent's
  // profile as complete. Validates name/phone/brokerage/home_address are all
  // non-empty first (server-side re-check even though ProfileGate already
  // enforces this client-side) — returns 400 + missing[] if not.
  app.post("/api/agent/complete-profile", (req, res) => {
    if (!requireSession(req, res)) return;
    const id = req.currentAgent!.id;
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const a = agent as any;
    const missing: string[] = [];
    if (!a.name || !String(a.name).trim())               missing.push("name");
    if (!a.phone || !String(a.phone).trim())              missing.push("phone");
    if (!a.brokerage || !String(a.brokerage).trim())      missing.push("brokerage");
    const homeAddr = a.homeAddress ?? a.home_address;
    if (!homeAddr || !String(homeAddr).trim())            missing.push("home_address");
    if (missing.length > 0) {
      return res.status(400).json({ error: "profile_incomplete", missing });
    }
    const now = new Date().toISOString();
    rawDb.prepare(`UPDATE agents SET profile_completed_at = ? WHERE id = ?`).run(now, id);
    res.json({ ok: true, profileCompletedAt: now });
  });

  // POST /api/agent/complete-tutorial — marks the CURRENT authenticated agent's
  // tutorial as complete. No validation — fires on natural finish (Chapter 7
  // "TAKE ME TO MY FIRST REAL LEAD") or on rewatch skip.
  app.post("/api/agent/complete-tutorial", (req, res) => {
    if (!requireSession(req, res)) return;
    const id = req.currentAgent!.id;
    const now = new Date().toISOString();
    rawDb.prepare(`UPDATE agents SET tutorial_completed_at = ? WHERE id = ?`).run(now, id);
    res.json({ ok: true, tutorialCompletedAt: now });
  });

  // POST /api/agent/reset-tutorial — clears tutorial_completed_at for the
  // current authenticated agent. Used by the "Replay tutorial" button in
  // Profile so a veteran agent can rewatch (with skip enabled).
  app.post("/api/agent/reset-tutorial", (req, res) => {
    if (!requireSession(req, res)) return;
    const id = req.currentAgent!.id;
    rawDb.prepare(`UPDATE agents SET tutorial_completed_at = NULL WHERE id = ?`).run(id);
    res.json({ ok: true, tutorialCompletedAt: null });
  });

  // Change own password — v14.58 Phase A: requires session, verifies caller
  // matches :id, bcrypt-compares currentPassword, bcrypt-hashes newPassword,
  // and revokes all OTHER sessions on success (keeps current cookie live).
  // Min length unified to 8 across setup / reset / self-change.
  app.patch("/api/agents/:id/password", async (req, res) => {
    const id = parseInt(req.params.id);
    if (!requireSelfOrAdmin(req, res, id)) return;

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // Verify current password via bcrypt (legacy plaintext also accepted for
    // the one-deploy overlap window).
    const { ok } = await verifyPassword(currentPassword, (agent as any).password);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

    const newHash = await hashPassword(newPassword);
    storage.updateAgent(id, { password: newHash });

    // Revoke all sessions for this agent EXCEPT the caller's current session.
    // Simpler + safer: revoke everything, then mint a fresh session for the
    // current cookie so the user stays logged in.
    revokeAllSessionsForAgent(id);
    const { token } = createSession(id, {
      userAgent: (req.headers["user-agent"] as string) ?? undefined,
      ip: (req.ip || (req.socket && req.socket.remoteAddress)) ?? undefined,
    });
    setSessionCookie(res, token);

    logAgentEvent({
      actorId: req.currentAgent?.id ?? id,
      targetId: id,
      event: "password_changed",
      before: null,
      after: null,
      notes: `Self-service password change${req.currentAgent?.id === id ? "" : ` by admin ${req.currentAgent?.name ?? ""}`}. Other sessions revoked.`,
    });

    res.json({ ok: true });
  });

  // Upload headshot — accepts any image, server-side face-detect + smart crop to 400×400 JPEG
  app.post("/api/agents/:id/headshot", async (req: any, res: any) => {
    // v14.63 — SECURITY: was fully ungated. Now self-or-admin.
    const id = parseInt(req.params.id);
    if (!requireSelfOrAdmin(req, res, id)) return;
    const { imageData, mimeType } = req.body; // imageData = base64 string
    if (!imageData || !mimeType) return res.status(400).json({ error: "Missing imageData or mimeType" });
    const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
    if (!supportedTypes.includes(mimeType)) return res.status(400).json({ error: "Unsupported image type" });
    // Allow up to 10MB raw (base64 of 10MB ≈ 13.6M chars)
    if (imageData.length > 14000000) return res.status(413).json({ error: "Image too large. Max 10MB." });

    try {
      const sharp = require("sharp");
      const inputBuf = Buffer.from(imageData, "base64");
      // Auto-rotate first so dimensions are post-EXIF-rotation
      const rotated = await sharp(inputBuf).rotate().toBuffer();
      const meta = await sharp(rotated).metadata();
      const w = meta.width ?? 800;
      const h = meta.height ?? 800;

      // Smart face-region crop:
      // Portrait (h > w): take upper 75% vertically, full width — face is usually centered top
      // Landscape (w > h): take center-left 60% of width as a square — face usually left/center
      // Square: take upper-center square biased 10% from top
      let left: number, top: number, cropW: number, cropH: number;
      if (h > w) {
        // Portrait — full width, upper 75%
        cropW = w;
        cropH = Math.round(Math.min(w, h * 0.75));
        left = 0;
        top = Math.round(h * 0.04); // slight top bias
      } else if (w > h * 1.3) {
        // Wide landscape — extract a square from upper-center
        cropW = h;
        cropH = h;
        left = Math.max(0, Math.round((w - cropW) / 2)); // horizontal center
        top = Math.round(h * 0.04);
      } else {
        // Near-square — standard upper-center crop
        cropW = Math.min(w, h);
        cropH = Math.min(w, h);
        left = Math.max(0, Math.round((w - cropW) / 2));
        top = Math.max(0, Math.round(h * 0.08));
      }

      // Clamp to image bounds
      left = Math.min(left, Math.max(0, w - cropW));
      top = Math.min(top, Math.max(0, h - cropH));
      cropW = Math.min(cropW, w - left);
      cropH = Math.min(cropH, h - top);

      const processed = await sharp(rotated)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(400, 400, { fit: "cover", position: "top" })
        .jpeg({ quality: 88, progressive: true })
        .toBuffer();

      // Save to persistent volume in production (/app/data/headshots/) or dist/public/headshots/ in dev
      const isProduction = process.env.NODE_ENV === "production";
      const headshotsDir = isProduction
        ? "/app/data/headshots"
        : path.resolve(__dirname, "public", "headshots");
      fs.mkdirSync(headshotsDir, { recursive: true });
      const filename = `${id}.jpg`;
      fs.writeFileSync(path.join(headshotsDir, filename), processed);

      const headshotUrl = `/headshots/${filename}?v=${Date.now()}`;
      const updated = storage.updateAgent(id, { headshotUrl });
      if (!updated) return res.status(404).json({ error: "Agent not found" });
      res.json({ headshotUrl });
    } catch (err: any) {
      console.error("Headshot processing error:", err);
      res.status(500).json({ error: "Failed to process image. Please try a different photo." });
    }
  });

  // Delete own account — removes all activity, unassigns leads, then deletes agent
  // v14.81.1 — Admin-only HARD DELETE. Permanently removes an agent row.
  // Historical rows (lead_activity, agent_lead_activity, agent_scope_points,
  // round_robin_state) referencing this agent_id have their agent_id set to
  // NULL so history is preserved but the agent record itself is gone. Any
  // leads still assigned to this agent are unassigned (returned to shared
  // pool). Requires: agent is already inactive (must deactivate first) AND
  // isn't the currently logged-in admin. Logs a `hard_deleted` audit event
  // BEFORE the delete so we have a permanent record of who deleted whom.
  app.delete("/api/agents/:id/hard-delete", (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid agent id" });

    const before = storage.getAgentById(id);
    if (!before) return res.status(404).json({ error: "Agent not found" });
    if (before.isActive) return res.status(400).json({ error: "Deactivate the agent first, then hard-delete." });
    if (req.currentAgent?.id === id) return res.status(400).json({ error: "Cannot hard-delete yourself." });

    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: id,
      event: "hard_deleted" as any,
      before: { name: before.name, email: before.email, isActive: before.isActive },
      after:  null,
      notes: `Hard-deleted by ${req.currentAgent?.name ?? "unknown admin"}. Row permanently removed; historical activity orphaned to NULL agent_id.`,
    });

    // v14.81.1 — Orphan history so FKs don't block delete. Corrected column names
    // per shared/schema.ts (prior v14.78 attempt used wrong names and threw
    // "no such column: agent_id" on agent_lead_activity, rolling back the whole
    // transaction). Actual columns:
    //   leads.assigned_agent_id            → nullable, set NULL
    //   lead_activity.agent_id             → nullable, set NULL
    //   agent_lead_activity.caller_id      → nullable, set NULL  (NOT agent_id!)
    //   round_robin_state.last_assigned_agent_id → nullable, set NULL
    //   lead_locks.agent_id                → NOT NULL → must DELETE rows
    //   agent_points.agent_id              → NOT NULL → must DELETE rows
    //     (agent_points is historical scoring; deleting rows for a hard-deleted
    //      agent is fine — they're gone from the roster anyway. Aggregate
    //      leaderboard totals were already reflected in prior periods.)
    const orphanTx = rawDb.transaction(() => {
      rawDb.prepare(`UPDATE leads SET assigned_agent_id = NULL, status = 'unassigned', callback_date = NULL WHERE assigned_agent_id = ?`).run(id);
      rawDb.prepare(`UPDATE lead_activity SET agent_id = NULL WHERE agent_id = ?`).run(id);
      rawDb.prepare(`UPDATE agent_lead_activity SET caller_id = NULL WHERE caller_id = ?`).run(id);
      rawDb.prepare(`UPDATE round_robin_state SET last_assigned_agent_id = NULL WHERE last_assigned_agent_id = ?`).run(id);
      rawDb.prepare(`DELETE FROM lead_locks WHERE agent_id = ?`).run(id);
      rawDb.prepare(`DELETE FROM agent_points WHERE agent_id = ?`).run(id);
      // Finally: delete the agent row itself.
      storage.deleteAgent(id);
    });
    orphanTx();

    revokeAllSessionsForAgent(id);
    res.json({ ok: true, deletedId: id, deletedName: before.name });
  });

  app.delete("/api/agents/:id/self", async (req, res) => {
    // v14.63 — SECURITY: was fully ungated + plaintext password compare (which
    // never matched post-bcrypt-migration, so this endpoint was dead). Now:
    // requires session for the target agent, verifies password via bcrypt.
    const id = parseInt(req.params.id);
    if (!requireSelfOrAdmin(req, res, id)) return;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const { ok } = await verifyPassword(password, (agent as any).password);
    if (!ok) return res.status(401).json({ error: "Password incorrect" });
    // Must have at least one receiver remaining
    const receiversAfter = countLeadReceivers(id);
    if (receiversAfter === 0) {
      return res.status(409).json({ error: "Cannot delete — you are the last active lead receiver. Transfer your leads first or activate another agent." });
    }
    // SQL: only fetch this agent's redistributable leads (v11.70)
    const leadsToRecycle: any[] = rawDb.prepare(
      `SELECT id, lead_type as leadType FROM leads
       WHERE assigned_agent_id = ?
         AND status NOT IN ('keep_in_touch','contacted_appointment')`
    ).all(id);
    for (const lead of leadsToRecycle) {
      // v14.50 — PULL MODE: return recycled leads to the shared pool. Agents pull.
      storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
    }
    // Soft-delete: mark inactive so activity history is preserved
    storage.updateAgent(id, { isActive: false, leadFlowOn: false });
    broadcast({ type: "leads_updated" });
    res.json({ deleted: true });
  });



  // Redistribute ALL unseen/untouched leads (no activity logged yet) regardless of assignment.
  // Use when adding a new agent — redistributes every lead no agent has interacted with yet
  // so the new agent and all others get an even share immediately.

  app.post("/api/admin/redistribute-unseen", (req, res) => {
    try {
      // SQL: LEFT JOIN to exclude leads with any activity — single query (v11.70)
      const SKIP = ["contacted_not_interested", "contacted_appointment", "keep_in_touch", "callback_requested", "wrong_number", "listed"];
      const skipPlaceholders = SKIP.map(() => "?").join(",");
      const unseen: any[] = rawDb.prepare(
        `SELECT l.id, l.lead_type as leadType FROM leads l
         WHERE l.status NOT IN (${skipPlaceholders})
           AND NOT EXISTS (SELECT 1 FROM lead_activity la WHERE la.lead_id = l.id)`
      ).all(...SKIP);
      let reassigned = 0;
      let skipped = 0;
      for (const lead of unseen) {
        try {
          // v14.50 — PULL MODE: reset any assignment on unseen leads so anybody can grab them.
          storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
          reassigned++;
          if (false) { skipped++; }
        } catch (leadErr) {
          console.error(`[redistribute-unseen] Failed on lead ${lead.id}:`, leadErr);
          skipped++;
        }
      }
      if (reassigned > 0) broadcast({ type: "leads_updated" });
      res.json({ total: unseen.length, reassigned, skipped });
    } catch (err) {
      console.error("[redistribute-unseen] Fatal error:", err);
      res.status(500).json({ error: "Failed to redistribute leads. Check server logs." });
    }
  });

  // v14.39 — THAW: manually clear a lead's Recycle cooldown so it's eligible again immediately.
  // POST /api/admin/leads/:id/clear-cooldown
  //   Admin-only override for the 14d on-ice timer set by the Recycle outcome.
  //   Idempotent — clears the timer whether or not one was set.
  app.post("/api/admin/leads/:id/clear-cooldown", (req, res) => {
    const leadId = parseInt(req.params.id);
    if (!leadId || isNaN(leadId)) return res.status(400).json({ error: "Invalid lead id" });
    const result = rawDb.prepare(
      `UPDATE leads SET recycle_cooldown_until = NULL WHERE id = ?`
    ).run(leadId);
    if (result.changes === 0) return res.status(404).json({ error: "Lead not found" });
    broadcast({ type: "leads_updated" });
    res.json({ ok: true, leadId, cooldownCleared: true });
  });

  // Toggle admin as lead receiver
  app.patch("/api/agents/:id/receive-leads", (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Admin-only toggle.
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const { receiveLeads } = req.body;
    const updated = storage.updateAgent(id, { receiveLeads: !!receiveLeads });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // Toggle individual agent lead flow on/off
  // If turning flow OFF, also force website leads off
  // Rule: at least one receiver must remain at all times.
  // Admins are the final fallback — they can only turn off lead flow if a non-admin agent is active with flow on.
  app.patch("/api/agents/:id/lead-flow", (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Admin-only toggle.
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const { leadFlowOn } = req.body;
    if (!leadFlowOn) {
      // Would this leave zero receivers? Count excluding this agent with flow off.
      const allAgents = storage.getAllAgents ? storage.getAllAgents() : [];
      const target = allAgents.find((a: any) => a.id === id);
      if (target) {
        // Simulate turning flow off for this agent
        const receiversAfter = allAgents.filter((a: any) => {
          if (a.id === id) return false; // this agent will have flow off
          if (!a.isActive) return false;
          if (a.role === "agent") return a.leadFlowOn !== false;
          if (a.role === "admin") return a.receiveLeads && a.leadFlowOn !== false;
          return false;
        }).length;
        if (receiversAfter === 0) {
          return res.status(409).json({
            error: "Cannot turn off lead flow — at least one agent must be able to receive leads. If no non-admin agents are active, admins must remain as the fallback.",
          });
        }
      }
    }
    const updated = storage.updateAgent(id, { leadFlowOn: !!leadFlowOn });
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

    // Dedup: SQL json_extract check — avoids loading all leads (v11.70)
    if (leadSourceId) {
      const existing = rawDb.prepare(
        `SELECT id FROM leads WHERE json_extract(extra_data, '$.leadSourceId') = ? LIMIT 1`
      ).get(leadSourceId) as any;
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
    // v14.48 — Flow is the only gate.
    const agentCount = allA.filter((a: any) => a.leadFlowOn !== false && a.leadFlowOn !== 0).length;

    // Always start unassigned — assignment happens after creation to avoid assigned+null state
    const [created] = storage.createLeadsFromBatch([{
      leadType: "network",
      address: fullAddress,
      ownerName,
      phone: phone || "",
      email: email || "",
      motivation,
      extraData,
      status: "unassigned",
      assignedAgentId: null,
      attemptCount: 0,
      uploadedAt: now,
      uploadedBy: null,
      batchId: `ms_${leadSourceId || Date.now()}`,
    }]);

    // v14.13 — PULL MODE: no round-robin auto-assign. Lead stays in pool;
    // agents pull via /api/leads/my-next which respects home-county.

    res.json({ created: true, leadId: created.id, ownerName, address: fullAddress });
  });

  // ─── LEADS (legacy endpoint — returns up to 500 leads via indexed SQL) ──────
  app.get("/api/leads", (req, res) => {
    const rows = rawDb.prepare(
      `SELECT * FROM leads ORDER BY uploaded_at DESC LIMIT 500`
    ).all();
    res.json(rows);
  });

  // ─── PAGINATED LEAD LIST (v11.57) — use for admin list view at scale ─────
  app.get("/api/leads/paginated", (req: any, res: any) => {
    const limit  = Math.min(parseInt(String(req.query.limit  || "50")), 200);
    const offset = parseInt(String(req.query.offset || "0"));
    const status = String(req.query.status || "all");
    const search = String(req.query.search || "").trim();
    const agentId = req.query.agentId ? parseInt(String(req.query.agentId)) : undefined;

    const { rows, total } = storage.getLeadsPaginated({ status, agentId, search, limit, offset });

    // Enrich with agent name
    const allAgents = storage.getAllAgents();
    const agentMap = Object.fromEntries(allAgents.map(a => [a.id, a.name]));
    const enriched = rows.map(l => ({ ...l, assignedAgentName: l.assignedAgentId ? agentMap[l.assignedAgentId] || "Unknown" : null }));

    res.json({ leads: enriched, total, limit, offset, hasMore: offset + limit < total });
  });

  // Map endpoint — returns lightweight lead data for geocoding
  // ── Server-side geocoding helpers ────────────────────────────────────────
  function geoKey(addr: string) { return addr.toLowerCase().trim(); }

  function getCached(key: string): { lat: number; lng: number } | null {
    const row = rawDb.prepare("SELECT lat, lng FROM geo_cache WHERE address_key = ?").get(key) as any;
    return row ? { lat: row.lat, lng: row.lng } : null;
  }

  function putCache(key: string, lat: number, lng: number) {
    rawDb.prepare("INSERT OR REPLACE INTO geo_cache (address_key, lat, lng, cached_at) VALUES (?, ?, ?, ?)").run(key, lat, lng, new Date().toISOString());
  }

  // Census Bureau bulk geocoder — up to 1000 addresses per call, no key needed
  // CSV format required by Census: Unique ID, Street Address, City, State, ZIP
  async function censusGeocodeAddresses(items: { id: number; addr: string; street: string; city: string; state: string; zip: string }[]): Promise<Map<number, { lat: number; lng: number }>> {
    const results = new Map<number, { lat: number; lng: number }>();
    if (items.length === 0) return results;

    // Census requires separate columns: ID,Street,City,State,ZIP
    const esc = (s: string) => s.replace(/"/g, "'").replace(/,/g, " ");
    const csv = items.map(i =>
      `${i.id},"${esc(i.street)}","${esc(i.city)}","${esc(i.state || "FL")}","${esc(i.zip)}"`
    ).join("\n");

    const form = new FormData();
    form.append("benchmark", "Public_AR_Current");
    const blob = new Blob([csv], { type: "text/csv" });
    form.append("addressFile", blob, "addresses.csv");

    try {
      const resp = await fetch("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
      const text = await resp.text();
      // Response CSV: id,inputAddr,matchStatus,matchType,outputAddr,"lng,lat",tigerLineId,side
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        // Handle quoted fields properly
        const cols = line.match(/(?:"[^"]*"|[^,])+/g)?.map(c => c.replace(/^"|"$/g, "").trim()) ?? [];
        if (cols.length < 6) continue;
        const id = parseInt(cols[0]);
        const matched = cols[2]?.trim().toLowerCase();
        if (isNaN(id) || matched !== "match") continue;
        // Census returns coords as "lng,lat" in column 5
        const coordStr = cols[5]?.trim();
        if (!coordStr) continue;
        const parts = coordStr.split(",");
        if (parts.length < 2) continue;
        const lng = parseFloat(parts[0]); const lat = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) results.set(id, { lat, lng });
      }
    } catch (e) {
      console.error("[geocode] Census batch failed:", e);
    }

    // Nominatim fallback for any that Census couldn't match
    const unmatched = items.filter(i => !results.has(i.id));
    for (const item of unmatched) {
      if (!item.street) continue;
      try {
        const q = encodeURIComponent([item.street, item.city, item.state || "FL", "USA"].filter(Boolean).join(", "));
        const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`, {
          headers: { "User-Agent": "LeadDepot/1.0 (lead-depot@watsonbrothersgroup.com)" },
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json() as any[];
        if (data.length > 0) {
          const lat = parseFloat(data[0].lat); const lng = parseFloat(data[0].lon);
          if (!isNaN(lat) && !isNaN(lng)) results.set(item.id, { lat, lng });
        }
        // Respect Nominatim rate limit (1 req/sec)
        await new Promise(res => setTimeout(res, 1100));
      } catch {}
    }

    return results;
  }

  // v14.30 — helper: enrich a lead row with parsed city/state/zip + fullAddr
  function enrichLeadForMap(l: any) {
    let city = l.city || ""; let state = l.state || "FL"; let zip = l.zip || "";
    if (!city && l.extraData) {
      try {
        const ex = JSON.parse(l.extraData);
        city  = ex.city  || ex.City  || ex.PropertyCity  || ex["Property City"]  || "";
        state = state || ex.state || ex.State || ex.PropertyState || ex["Property State"] || "FL";
        zip   = zip || ex.zip   || ex.Zip   || ex.zipcode || ex.Zipcode || ex.PostalCode ||
                ex["Postal Code"] || ex.PropertyZip || ex["Property Zip"] || "";
      } catch {}
    }
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
    const fullAddr = [l.address, city, state || "FL", zip].filter(Boolean).join(", ");
    return { id: l.id, address: l.address, ownerName: l.ownerName, status: l.status, leadType: l.leadType, city, state, zip, fullAddr };
  }

  // v14.30 — background geocoder: fills geo_cache for any lead missing coords.
  // Runs at boot (once) and after any large ingest. Idempotent — skips cached rows.
  // Chunks of 1000 with a 3s gap so we never crush the Census API or block the request loop.
  let bgGeocodeRunning = false;
  async function runBackgroundGeocode(reason: string = "boot") {
    if (bgGeocodeRunning) return;
    bgGeocodeRunning = true;
    try {
      const all: any[] = rawDb.prepare(
        `SELECT id, address, owner_name as ownerName, status, lead_type as leadType,
                city, state, zip, extra_data as extraData
         FROM leads`
      ).all();
      const uncached: { id: number; addr: string; street: string; city: string; state: string; zip: string; fullAddr: string }[] = [];
      for (const raw of all) {
        const l = enrichLeadForMap(raw);
        const key = geoKey(l.fullAddr);
        if (getCached(key)) continue;
        if (!l.address) continue;
        const street = l.address.split(",")[0].trim();
        uncached.push({ id: l.id, addr: l.fullAddr, street, city: l.city, state: l.state, zip: l.zip, fullAddr: l.fullAddr });
      }
      if (uncached.length === 0) { console.log(`[bg-geocode] ${reason}: nothing to do`); return; }
      console.log(`[bg-geocode] ${reason}: geocoding ${uncached.length} uncached leads in chunks of 1000`);
      const BATCH = 1000;
      let cachedNew = 0;
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH);
        try {
          const results = await censusGeocodeAddresses(batch);
          for (const [id, coords] of results) {
            const item = uncached.find(u => u.id === id);
            if (!item) continue;
            putCache(geoKey(item.fullAddr), coords.lat, coords.lng);
            cachedNew++;
          }
        } catch (e) {
          console.error(`[bg-geocode] batch ${i} failed:`, e);
        }
        if (i + BATCH < uncached.length) await new Promise(r => setTimeout(r, 3000));
      }
      console.log(`[bg-geocode] ${reason}: done — cached ${cachedNew}/${uncached.length} new leads`);
    } finally {
      bgGeocodeRunning = false;
    }
  }
  // Kick off background geocode 5s after routes are wired so we don't compete with startup traffic.
  setTimeout(() => { void runBackgroundGeocode("boot"); }, 5000);

  app.get("/api/leads/map", (req, res) => {
    // v14.30 — viewport rebuild:
    //   1. Cap REMOVED. Return every lead that has coords cached.
    //   2. Sync request path does zero geocoding. Uncached rows come back with pending flag.
    //   3. Background geocoder (see runBackgroundGeocode above) fills geo_cache.
    const totalRow: any = rawDb.prepare(`SELECT COUNT(*) as c FROM leads`).get();
    const totalCount = totalRow?.c ?? 0;

    // INNER JOIN geo_cache directly for max speed — one SQL, no per-row cache lookup.
    // Address key format: lowercase trimmed full address (matches geoKey()).
    const rows: any[] = rawDb.prepare(
      `SELECT l.id, l.address, l.owner_name as ownerName, l.status, l.lead_type as leadType,
              l.city, l.state, l.zip, l.extra_data as extraData,
              g.lat, g.lng
       FROM leads l
       INNER JOIN geo_cache g ON g.address_key = lower(trim(
         l.address || ', ' ||
         coalesce(nullif(l.city,''), '') || ', ' ||
         coalesce(nullif(l.state,''), 'FL') || ', ' ||
         coalesce(nullif(l.zip,''), '')
       ))`
    ).all();

    const leads = rows.map((r: any) => {
      const enriched = enrichLeadForMap(r);
      return { ...enriched, lat: r.lat, lng: r.lng };
    });

    // If the SQL JOIN missed some rows because addresses were parsed differently at cache
    // time (extraData-derived city/zip), fall back to per-row lookup for anything not
    // already in `leads`. This is O(totalCount) getCached calls but each is a fast PK lookup.
    if (leads.length < totalCount) {
      const seen = new Set(leads.map(l => l.id));
      const remaining: any[] = rawDb.prepare(
        `SELECT id, address, owner_name as ownerName, status, lead_type as leadType,
                city, state, zip, extra_data as extraData
         FROM leads`
      ).all();
      for (const raw of remaining) {
        if (seen.has(raw.id)) continue;
        const enriched = enrichLeadForMap(raw);
        const cached = getCached(geoKey(enriched.fullAddr));
        if (cached) leads.push({ ...enriched, lat: cached.lat, lng: cached.lng });
      }
    }

    const geocodedCount = leads.length;
    const pending = totalCount - geocodedCount;
    res.json({ leads, totalCount, geocodedCount, pending, bgRunning: bgGeocodeRunning });
  });

  // v14.30 — manual trigger for background geocode (admin-only in practice; no auth
  // check here because whole app is behind login, but harmless to expose).
  app.post("/api/leads/map/refresh-geocode", async (_req, res) => {
    if (bgGeocodeRunning) return res.json({ started: false, reason: "already running" });
    void runBackgroundGeocode("manual");
    res.json({ started: true });
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

  // ─── AGENT: NEXT LEAD (v14.4 — home-county-first, cross-county overflow) ─────
  // Priority order:
  //   1. Callbacks due now (agent's own, any county)
  //   2. Home-county unassigned pool: expired → absentee
  //   3. Overflow to other counties ONLY when home county is completely dry
  //      (expired → absentee across all other counties)
  // Admins with home_county=NULL skip step 2/3 gating — they see everything.
  //
  // Locks a lead to the agent for 60 min so no other agent gets it.
  app.get("/api/leads/my-next", (req, res) => {
    const agentId = parseInt(String(req.query.agentId || ""));
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });

    const agent: any = rawDb.prepare(`SELECT id, home_county, role FROM agents WHERE id = ?`).get(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // Sweep expired locks so recycled leads are eligible again.
    rawDb.prepare(`DELETE FROM lead_locks WHERE expires_at < datetime('now')`).run();

    // If this agent already has a lead locked, return it (idempotent Load).
    const alreadyLocked: any = rawDb.prepare(`
      SELECT l.* FROM leads l
      JOIN lead_locks lk ON lk.lead_id = l.id
      WHERE lk.agent_id = ?
      ORDER BY lk.locked_at DESC
      LIMIT 1
    `).get(agentId);
    // v14.81.1 — Helper: count how many times THIS agent has dialed THIS lead
    // TODAY. Used to add myAttemptsToday to every lead card the agent sees.
    const dialOutcomesForCounter = ["tried", "no_answer", "voicemail", "appointment_set", "keep_in_touch", "recycled", "wrong_number", "not_interested"];
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    const countMyAttemptsToday = (leadId: number): number => (rawDb.prepare(`
      SELECT COUNT(*) AS c FROM lead_activity
       WHERE lead_id = ? AND agent_id = ? AND created_at >= ?
         AND outcome IN (${dialOutcomesForCounter.map(() => "?").join(",")})
    `).get(leadId, agentId, todayMidnight.toISOString(), ...dialOutcomesForCounter) as any)?.c ?? 0;

    if (alreadyLocked) return res.json({ ...toApiLead(alreadyLocked), myAttemptsToday: countMyAttemptsToday(alreadyLocked.id) });

    // 1. Callbacks due now (agent's own, all counties).
    const today = new Date().toISOString().split("T")[0];
    const callback: any = rawDb.prepare(`
      SELECT * FROM leads
      WHERE assigned_agent_id = ?
        AND status = 'callback_requested'
        AND (callback_date IS NULL OR callback_date <= ?)
      ORDER BY callback_date ASC
      LIMIT 1
    `).get(agentId, today);
    if (callback) return res.json({ ...toApiLead(callback), myAttemptsToday: countMyAttemptsToday(callback.id) });

    // Lead-type priority order (v14.4: FSBO and Land removed).
    const TYPE_ORDER = ["expired", "absentee"];

    // Helper: pull next unassigned+unlocked lead matching WHERE. Sorted score DESC.
    // v14.39 — excludes leads under active Recycle cooldown ("on ice"). Applies uniformly
    // to Expired + Absentee. Grandfathered rows have recycle_cooldown_until = NULL and pass.
    const nowMs = Date.now();
    const pullPool = (leadType: string, countyClause: string, countyParams: any[]): any => {
      return rawDb.prepare(`
        SELECT l.* FROM leads l
        LEFT JOIN lead_locks lk ON lk.lead_id = l.id
        WHERE l.lead_type = ?
          AND l.status = 'unassigned'
          AND lk.lead_id IS NULL
          AND (l.recycle_cooldown_until IS NULL OR l.recycle_cooldown_until <= ?)
          ${countyClause}
        ORDER BY l.score DESC, l.uploaded_at ASC, l.id ASC
        LIMIT 1
      `).get(leadType, nowMs, ...countyParams);
    };

    let next: any = null;
    const homeCounty = agent.home_county;

    if (homeCounty) {
      // 2. Home-county leads, in type-priority order.
      for (const t of TYPE_ORDER) {
        next = pullPool(t, `AND LOWER(l.county) = LOWER(?)`, [homeCounty]);
        if (next) break;
      }

      // 3. Overflow — only if home county produced nothing.
      if (!next) {
        for (const t of TYPE_ORDER) {
          next = pullPool(t, `AND (l.county IS NULL OR LOWER(l.county) <> LOWER(?))`, [homeCounty]);
          if (next) break;
        }
      }
    } else {
      // Admin / no county restriction — killer mode across all counties.
      for (const t of TYPE_ORDER) {
        next = pullPool(t, ``, []);
        if (next) break;
      }
    }

    if (!next) return res.status(204).end();

    // Lock it for 60 min so no other agent grabs the same lead.
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000);
    rawDb.prepare(`
      INSERT OR REPLACE INTO lead_locks (lead_id, agent_id, locked_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(next.id, agentId, now.toISOString(), expires.toISOString());

    // v14.81.1 — Per-agent, per-lead, per-day dial counter (see comment above where
    // countMyAttemptsToday is defined).
    res.json({ ...toApiLead(next), myAttemptsToday: countMyAttemptsToday(next.id) });
  });

  // ─── LEAD LOCK RELEASE ─────────────────────────────────────────────────
  // POST /api/leads/:id/release  { agentId }
  //   Releases the lock (agent bailed out without an outcome). Anyone can pick
  //   the lead up again immediately. Only the lock owner may release.
  //   (v14.19 — removed dead v13.8 /api/leads/next, /pool-counts, /locks routes
  //    superseded by /api/leads/my-next PULL MODE.)
  app.post("/api/leads/:id/release", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId } = req.body || {};
    if (!leadId || isNaN(leadId)) return res.status(400).json({ error: "Invalid lead id" });
    if (!agentId) return res.status(400).json({ error: "Missing agentId" });

    // Only the lock owner can release (prevents griefing).
    const lock: any = rawDb.prepare(
      `SELECT agent_id FROM lead_locks WHERE lead_id = ?`
    ).get(leadId);
    if (!lock) return res.json({ released: false, reason: "no_lock" });
    if (lock.agent_id !== agentId) {
      return res.status(403).json({ error: "lock_owned_by_another_agent" });
    }

    rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
    res.json({ released: true });
  });



  app.post("/api/leads/upload", (req, res) => {
    const { leads: leadRows, leadType, uploadedBy, batchId } = req.body;
    if (!leadRows || !Array.isArray(leadRows) || !leadType) {
      return res.status(400).json({ error: "Invalid upload payload" });
    }
    // Safeguard (v11.70): cap batch size to prevent runaway memory usage
    const MAX_UPLOAD_BATCH = 2000;
    if (leadRows.length > MAX_UPLOAD_BATCH) {
      return res.status(400).json({
        error: `Batch too large: ${leadRows.length} rows. Max is ${MAX_UPLOAD_BATCH} per upload. Split into smaller files.`,
      });
    }
    // Safeguard: validate leadType is a known value
    const VALID_LEAD_TYPES = ["expired", "absentee", "network"];
    if (!VALID_LEAD_TYPES.includes(leadType)) {
      return res.status(400).json({ error: `Unknown lead type: ${leadType}` });
    }

    const now = new Date().toISOString();
    // v14.48 — Flow is the only gate for receiving leads.
    const allA = storage.getAllAgents();
    const agentCount = allA.filter(a => !!a.leadFlowOn).length;

    let disqualified = 0;
    const validRows = leadRows.filter((row: any) => {
      const name = row["Owner Name"] || row.ownerName || row.name || row.Name ||
        row["First Name"] || "";
      const phone = row["Primary Phone"] || row.phone || row.Phone ||
        row["Phone Number"] || "";
      const hasName = name.trim().length > 0;
      const hasPhone = phone.replace(/\D/g, "").length >= 7;
      if (!hasName || !hasPhone) { disqualified++; return false; }
      return true;
    });

    const created = storage.createLeadsFromBatch(
      validRows.map((row: any) => {
        const firstName = row["First Name"] || "";
        const lastName  = row["Last Name"]  || "";
        const fullName  = row["Owner Name"] || row.ownerName || row.name || row.Name
          || (firstName || lastName ? `${firstName} ${lastName}`.trim() : "");

        // Collect all unique non-empty phone numbers from all sources
        const rawPhones = [
          row["Primary Phone"], row["Secondary Phone"],
          row["phone"], row["Phone"], row["Phone Number"],

        ]
          .map((p: any) => String(p || "").replace(/\D/g, "").trim())
          .filter((p: string) => p.length >= 7);
        const uniquePhones = [...new Set(rawPhones)];
        const primaryPhone = uniquePhones[0] || "";
        // phoneStates: each number starts as 'untried'
        const phoneStates: Record<string, string> = {};
        uniquePhones.forEach((p: string) => { phoneStates[p] = "untried"; });

        // Address: prefer "Property Address" col, fall back to Address + City
        const propAddress = row["Property Address"] || row.address || row.Address || "";
        const city  = row.City  || row.city  || "";
        const state = row.State || row.state || "";
        const zip   = row.Zip   || row.zip   || row["Postal Code"] || "";
        const fullAddress = propAddress
          ? (city ? `${propAddress}, ${city}, ${state} ${zip}`.trim() : propAddress)
          : "";

        const email = row.email || row.Email || "";

        // Price as motivation context
        const price = row.Price || row.price || row["Listing Price"] || "";
        const beds  = row.Beds  || row.beds  || "";
        const motivation = row.motivation || row.Motivation
          || (price ? `Listed at $${Number(String(price).replace(/[^0-9.]/g,'')||0).toLocaleString()}${beds ? `, ${beds}bd` : ""}` : "");

        // Territory — stamp from zip code
        const territory = getTerritoryForZip(zip) || null;

        return {
          leadType,
          address: fullAddress,
          ownerName: fullName,
          phone: primaryPhone,
          email,
          motivation,
          extraData: JSON.stringify(row),
          status: "unassigned",
          assignedAgentId: null,
          attemptCount: 0,
          uploadedAt: now,
          uploadedBy: uploadedBy || null,
          batchId: batchId || null,
          phones: JSON.stringify(uniquePhones),
          phoneStates: JSON.stringify(phoneStates),
          territory,
          source: "csv_upload",
        };
      })
    );

    // v14.13 — PULL MODE: no round-robin push. CSV-uploaded leads land in
    // the pool; agents pull via /api/leads/my-next which respects home-county.

    broadcast({ type: "activity_event", event: { type: "csv_uploaded", agentId: uploadedBy || null, agentName: "Admin", count: created.length, leadType, ts: new Date().toISOString() } });
    res.json({ created: created.length, disqualified, batchId });
  });

  // ─── v14.18 — CALLBACK LOOKUP ────────────────────────────────────────────
  // Agent gets a call from an unknown number and needs to know who's on the
  // other end. Look up any lead by the last-4 of any phone number attached to
  // that lead. Returns matches with the last outcome + agent that touched them.
  //
  // IMPORTANT: this route MUST live above `/api/leads/:id` so express doesn't
  // route "callback-lookup" as a numeric id.
  app.get("/api/leads/callback-lookup", (req, res) => {
    try {
      const raw = String(req.query.last4 || "").replace(/\D/g, "");
      if (raw.length < 4) {
        return res.status(400).json({ error: "Last 4 digits required", results: [] });
      }
      const last4 = raw.slice(-4);

      // Match on primary `phone` column OR any digit in the `phones` JSON array.
      // Use LIKE '%XXXX' on the raw digits so formatting (dashes, parens, +1) doesn't matter.
      // We normalize phone digits inside SQL with REPLACE chains — simpler than pulling
      // every lead into memory.
      const stripSql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),'-',''),'(',''),')',''),' ',''),'.',''),'+','')`;
      const stripPhonesSql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phones,''),'-',''),'(',''),')',''),' ',''),'.',''),'+','')`;
      const like = `%${last4}%`;

      const rows: any[] = rawDb.prepare(`
        SELECT id, owner_name, address, city, state, phone, phones, status,
               assigned_agent_id, follow_up_timing, lead_type, uploaded_at
          FROM leads
         WHERE ${stripSql}        LIKE ?
            OR ${stripPhonesSql} LIKE ?
         ORDER BY uploaded_at DESC
         LIMIT 25
      `).all(like, like);

      // For each match, verify the last-4 actually lines up with a phone tail
      // (avoids false-positives where 1234 appears mid-number like 555-1234-999).
      const filtered = rows.filter(r => {
        const stripped = (s: string) => String(s || "").replace(/\D/g, "");
        const primary = stripped(r.phone);
        let phonesArr: string[] = [];
        try { phonesArr = JSON.parse(r.phones || "[]").map(stripped); } catch { phonesArr = []; }
        const allPhones = [primary, ...phonesArr].filter(Boolean);
        return allPhones.some(p => p.endsWith(last4));
      });

      // Enrich with last activity (outcome + agent + timestamp) for each match
      const results = filtered.map(r => {
        const lastAct: any = rawDb.prepare(`
          SELECT la.outcome, la.notes, la.created_at, a.name AS agent_name
            FROM lead_activity la
            LEFT JOIN agents a ON a.id = la.agent_id
           WHERE la.lead_id = ?
           ORDER BY la.created_at DESC
           LIMIT 1
        `).get(r.id) || {};
        const assignedAgent: any = r.assigned_agent_id
          ? rawDb.prepare(`SELECT name FROM agents WHERE id = ?`).get(r.assigned_agent_id) || {}
          : {};
        let phonesArr: string[] = [];
        try { phonesArr = JSON.parse(r.phones || "[]"); } catch {}
        return {
          leadId: r.id,
          ownerName: r.owner_name || null,
          address: r.address || null,
          city: r.city || null,
          state: r.state || null,
          phone: r.phone || null,
          phones: phonesArr,
          status: r.status || null,
          leadType: r.lead_type || null,
          followUpTiming: r.follow_up_timing || null,
          assignedAgentId: r.assigned_agent_id || null,
          assignedAgentName: assignedAgent.name || null,
          lastOutcome: lastAct.outcome || null,
          lastOutcomeAt: lastAct.created_at || null,
          lastOutcomeByAgent: lastAct.agent_name || null,
          lastOutcomeNotes: lastAct.notes || null,
        };
      });

      res.json({ last4, count: results.length, results });
    } catch (e: any) {
      console.error("[callback-lookup] failed:", e.message);
      res.status(500).json({ error: "Callback lookup failed", details: e.message, results: [] });
    }
  });

  // ─── MY PIPELINE (restored v14.81.1, no date filter) ────────────────────────
  // v14.81.1 (moved here v14.81.1 hotfix) — MUST be registered BEFORE `/api/leads/:id`
  // or Express routes `/api/leads/my-pipeline` to the `:id` handler and returns
  // "Lead not found". Read-only over existing columns — no routing changes.
  app.get("/api/leads/my-pipeline", (req, res) => {
    const agentId = parseInt(String(req.query.agentId || ""));
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "agentId required" });
    // v14.81.1 — SECURITY FIX: this endpoint took agentId from the query string with
    // no session check, so any logged-in agent could pass a different agent's id
    // and read their pipeline. Now scoped to self-or-admin, same guard used
    // elsewhere in this file (e.g. /api/agents/:id).
    if (!requireSelfOrAdmin(req, res, agentId)) return;

    const owned: any[] = rawDb.prepare(`
      SELECT l.*,
             (SELECT outcome    FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_outcome,
             (SELECT created_at FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_activity_at,
             (SELECT lpmamab_snapshot FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_snapshot
        FROM leads l
       WHERE l.assigned_agent_id = ?
         AND l.status IN ('keep_in_touch','contacted_appointment')

      UNION

      SELECT l.*,
             (SELECT outcome    FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_outcome,
             (SELECT created_at FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_activity_at,
             (SELECT lpmamab_snapshot FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_snapshot
        FROM leads l
       WHERE l.uploaded_by = ?
         AND l.lead_type = 'network'
       ORDER BY last_activity_at DESC
    `).all(agentId, agentId);

    // v14.81.1 — Agent Pipeline redesign: surface apptDate/apptTime/intention/stage
    // from the most recent activity's lpmamab_snapshot so the client can render
    // appointment date/time and KIT intention + follow-up trigger per row.
    for (const l of owned) {
      let snap: any = {};
      try { snap = JSON.parse(l.last_snapshot || "{}"); } catch {}
      l.appt_date = snap.apptDate || null;
      l.appt_time = snap.apptTime || null;
      l.intention = snap.intention || null;
      l.stage = snap.stage || null;
      delete l.last_snapshot;
    }

    const appts   = owned.filter(l => l.status === 'contacted_appointment');
    const kit     = owned.filter(l => l.status === 'keep_in_touch');
    const network = owned.filter(l => l.lead_type === 'network' && l.status !== 'keep_in_touch' && l.status !== 'contacted_appointment');

    res.json({
      counts: { appts: appts.length, kit: kit.length, network: network.length, total: owned.length },
      appts, kit, network,
    });
  });

  app.get("/api/leads/:id", (req, res) => {
    const lead = storage.getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    res.json(lead);
  });

  app.patch("/api/leads/:id", (req, res) => {
    const id = parseInt(req.params.id);
    // Safeguard (v11.70): whitelist editable fields — prevent client from
    // overwriting assignedAgentId, status, score, or source directly
    const ALLOWED_LEAD_PATCH_FIELDS = [
      "ownerName", "firstName", "lastName", "email", "phone", "phones",
      "address", "city", "state", "zip", "county",
      "leadType", "estimatedValue", "timeframe", "reasonForSelling",
      "propertyType", "extraData", "notes", "callbackDate",
    ] as const;
    const patch: Record<string, any> = {};
    for (const key of ALLOWED_LEAD_PATCH_FIELDS) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No valid fields to update" });
    const updated = storage.updateLead(id, patch);
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    res.json(updated);
  });

  // ─── OUTCOMES ─────────────────────────────────────────────────────────────
  app.post("/api/leads/:id/outcome", async (req, res) => {
    const leadId = parseInt(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: "Invalid lead id" });

    const { agentId, outcome, notes, lpmamab, callbackDate,
            apptEmail, confirmedAddress, apptDate, apptTime, stage, intention,
            followUpTiming } = req.body; // v14.18 — KIT follow-up timing

    // Whitelist valid outcomes — prevents garbage data from getting into the activity log
    // v14.10 — added `recycled` so client can route Recycle through /outcome if needed;
    // primary Recycle endpoint remains /api/leads/:id/recycle.
    // v14.18 — 3×3 outcome grid additions: `listed`, `disconnected`, `left_voicemail`,
    // plus `email_sent_value` for the Stage-2 value email (v14.18). Every route below
    // handles its own exhaustion — no code path can leave a lead in a stuck state.
    const VALID_OUTCOMES = [
      "no_answer", "contacted_appointment", "keep_in_touch", "callback_requested",
      "contacted_not_interested", "wrong_number", "email_sent", "network_referral",
      "recycled", "listed", "disconnected", "left_voicemail", "email_sent_value",
    ];
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}` });
    }

    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Determine new lead status based on outcome
    let newStatus = lead.status;
    let newAssignedId = lead.assignedAgentId;
    let newCallbackDate = lead.callbackDate;
    let newPhoneStates = lead.phoneStates ? JSON.parse(lead.phoneStates) : {} as Record<string, string>;
    let newPhones = lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []) as string[];

    // Helper: get the next untried/viable number for today
    const getNextViablePhone = (states: Record<string, string>, allPhones: string[]): string | null => {
      return allPhones.find(p => states[p] === "untried") ?? null;
    };

    const deadOutcomes = ["contacted_not_interested", "contacted_appointment"];

    if (deadOutcomes.includes(outcome)) {
      // v14.12 — Appointments stay owned by the closer so they surface in the
      // agent's "My Leads" pipeline. Not Interested still unassigns (dead lead, no pipeline entry).
      // v14.18 — Release the lock in both cases so the agent's next Load Next call
      // doesn't return this same lead. Appointments get filtered out by status anyway,
      // but the lock row would still trip the `alreadyLocked` shortcut.
      newStatus = outcome;
      newAssignedId = outcome === "contacted_appointment" ? agentId : null;
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

    } else if (outcome === "recycled" || outcome === "callback_requested") {
      // v14.14 — Callback retired. Recycle is the successor: one-tap unassign to pool.
      // v14.45 — `callback_requested` still accepted for stale clients but treated as recycled.
      //          NETWORK ORPHAN FIX: Network leads have no shared pool (TYPE_ORDER excludes
      //          "network"), so recycling would strand them. Instead, restore assignment to
      //          the original submitter (uploaded_by) — they stay owned by the referrer.
      //          Cooldown is skipped for network leads (referrer-owned, not pool leads).
      // v14.18 — Release the lock so my-next doesn't hand this lead right back.
      // v14.39 — Unified 14d cooldown for Expired + Absentee "on ice" behavior.
      const isNetwork = lead.leadType === "network";
      const referrerId = (lead as any).uploadedBy || (lead as any).uploaded_by || null;
      if (isNetwork && referrerId) {
        newStatus = "assigned";
        newAssignedId = referrerId;
        newCallbackDate = null;
      } else {
        newStatus = "unassigned";
        newAssignedId = null;
        newCallbackDate = null;
        const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
        const cooldownUntil = Date.now() + COOLDOWN_MS;
        rawDb.prepare(`UPDATE leads SET recycle_cooldown_until = ? WHERE id = ?`).run(cooldownUntil, leadId);
      }
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

    } else if (outcome === "no_answer") {
      // v14.40 — Per-LINE no-answer cap. Increment this phone's counter. At CAP it flips
      // from "no_answer_today" to permanently "struck". When every phone is struck the
      // lead auto-deletes (same exhaustion path as Wrong # / Disconnected).
      // v14.65 — Raised from 6 → 10 to give more attempts to hunt the true owner
      //           before retiring a line.
      // v14.81.1 — Raised from 10 → 12. With higher-quality LandVoice lists we expect
      //           the marginal 2 attempts to lift cumulative contact rate from ~72% to ~78%
      //           (at p≈0.12 per-dial). Diminishing returns kick in hard past this;
      //           don't go higher without a UI warning at 9+ attempts.
      const PHONE_ATTEMPT_CAP = 12;
      const currentPhone = req.body.dialedPhone || lead.phone || "";
      let phoneAttempts: Record<string, number> = {};
      try { phoneAttempts = lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch {}

      if (currentPhone && newPhoneStates[currentPhone] !== undefined) {
        phoneAttempts[currentPhone] = (phoneAttempts[currentPhone] || 0) + 1;
        if (phoneAttempts[currentPhone] >= PHONE_ATTEMPT_CAP) {
          newPhoneStates[currentPhone] = "struck";
        } else {
          newPhoneStates[currentPhone] = "no_answer_today";
        }
      }

      // Persist the updated phone_attempts JSON now (before exhaustion check)
      rawDb.prepare(`UPDATE leads SET phone_attempts = ? WHERE id = ?`).run(JSON.stringify(phoneAttempts), leadId);

      // If every viable phone is now struck → exhaustion delete (parity with Wrong #).
      const anyViable = newPhones.some((p: string) => newPhoneStates[p] !== "struck");
      if (!anyViable) {
        // Log activity BEFORE deleting so daily-digest "Retired — all lines struck" can pick it up.
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
          VALUES (?, ?, 'retired_no_answer', ?, NULL, ?)
        `).run(leadId, agentId || null,
          `Auto-retired: every phone hit ${PHONE_ATTEMPT_CAP} no-answer attempts (per-line cap).`,
          new Date().toISOString());
        awardPoints(agentId, "no_answer", leadId);
        rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_lines_struck_no_answer" });
      }

      // Check if there's another untried number to try today
      const nextPhone = getNextViablePhone(newPhoneStates, newPhones);
      if (nextPhone) {
        // v14.65 — Still has untried numbers. Do NOT reorder the phones array;
        // slot order is the owner-priority order and must stay stable for the
        // "Line X of N" label. Just update lead.phone to the next untried.
        newStatus = "no_answer";
        rawDb.prepare("UPDATE leads SET phone = ? WHERE id = ?").run(nextPhone, leadId);
      } else {
        // v14.10 — PULL MODE: all numbers tried today, return to shared pool.
        // v14.18 — Also release the lead_locks row so my-next doesn't hand this
        // exhausted lead right back to the same agent on their next Load Next tap.
        newStatus = "no_answer";
        newAssignedId = null;
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
      }

    } else if (outcome === "keep_in_touch") {
      // v14.12 — KIT stays owned by the closer so it appears in "My Leads" pipeline
      // (60-day rolling window). FUB still owns the long-term nurture, but the closer
      // needs to see it in Lead Depot until it drops out of the window.
      // v14.18 — Release the lock so my-next doesn't hand this same lead back.
      newStatus = "keep_in_touch";
      newAssignedId = agentId;
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

      // v14.18 — Persist the follow-up timing selection so the agent's My Leads
      // pipeline can filter/segment KIT leads by follow-up window.
      if (followUpTiming) {
        try {
          rawDb.prepare(`UPDATE leads SET follow_up_timing = ? WHERE id = ?`).run(followUpTiming, leadId);
        } catch (e: any) {
          console.error("[KIT] follow_up_timing persist failed:", e.message);
        }
      }

    } else if (outcome === "listed") {
      // v14.18 — Listed = seller told us they've relisted with another agent.
      // Full lead kill: mark status='listed', unassign, release lock so my-next
      // never surfaces this lead again. Historical activity stays for the record.
      newStatus = "listed";
      newAssignedId = null;
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

    } else if (outcome === "disconnected") {
      // v14.18 — Disconnected line = per-line cleanup, NOT a full lead kill.
      // v14.65 — REWRITE: struck phones are physically REMOVED from phones[]
      //   (also purged from phoneStates + phoneAttempts). What remains is our
      //   candidate set of "actual owner" numbers. Slot label 'Line X of N'
      //   naturally renumbers as candidates die. Dead numbers persist only in
      //   dead_lines JSON for audit/history.
      const dialedPhone = req.body.dialedPhone || lead.phone || "";
      let phones: string[] = lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []);
      const phoneStates: Record<string, string> = lead.phoneStates ? JSON.parse(lead.phoneStates) : {};
      let phoneAttempts: Record<string, number> = {};
      try { phoneAttempts = lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch {}
      let deadLines: string[] = [];
      try { deadLines = JSON.parse((lead as any).deadLines || (lead as any).dead_lines || "[]"); } catch {}

      // v14.65 — Physically remove the dialed phone from the candidate list
      if (dialedPhone) {
        phones = phones.filter(p => p !== dialedPhone);
        delete phoneStates[dialedPhone];
        delete phoneAttempts[dialedPhone];
        if (!deadLines.includes(dialedPhone)) deadLines.push(dialedPhone);
      }

      // Log activity ourselves (matches Wrong # pattern) BEFORE deletion path
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
        VALUES (?, ?, 'disconnected', ?, NULL, ?)
      `).run(leadId, agentId || null,
        notes || (dialedPhone ? `Disconnected: ${dialedPhone} removed from candidate list. ${phones.length} candidate(s) remaining.` : null),
        new Date().toISOString());

      if (phones.length === 0) {
        // All candidate numbers exhausted — exhaustion path. Award, clear, delete.
        awardPoints(agentId, "disconnected", leadId);
        rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_lines_disconnected" });
      }

      // v14.65 — Slot 1 (lowest index) is always the next candidate we dial.
      // Prefer untried; if none untried but candidates remain, they're all
      // no_answer_today — lead exits pool until tomorrow.
      const untriedNext = phones.find(p => phoneStates[p] === "untried") ?? null;
      const nextViable  = untriedNext ?? phones[0];
      if (untriedNext) {
        rawDb.prepare(`UPDATE leads SET phone = ?, phones = ?, phone_states = ?, phone_attempts = ?, dead_lines = ?, status = 'assigned', assigned_agent_id = ? WHERE id = ?`).run(
          nextViable, JSON.stringify(phones), JSON.stringify(phoneStates),
          JSON.stringify(phoneAttempts), JSON.stringify(deadLines), agentId, leadId
        );
      } else {
        // v14.64 fix preserved: write status='no_answer' so puller skips it
        // until tomorrow's 8am EDT reset. Release lock.
        rawDb.prepare(`UPDATE leads SET phone = ?, phones = ?, phone_states = ?, phone_attempts = ?, dead_lines = ?, status = 'no_answer', assigned_agent_id = NULL WHERE id = ?`).run(
          nextViable, JSON.stringify(phones), JSON.stringify(phoneStates),
          JSON.stringify(phoneAttempts), JSON.stringify(deadLines), leadId
        );
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
      }
      awardPoints(agentId, "disconnected", leadId);
      broadcast({ type: "activity_event", event: { type: "disconnected", agentId, leadId, agentName: storage.getAgentById(agentId)?.name || "Agent", address: lead.address } });
      broadcast({ type: "lead_updated", leadId });
      // v14.81.1 — `remaining` was undefined here since v14.65 refactor (would have
      // thrown ReferenceError → 500 on every Disconnected outcome that landed in
      // this branch). Use surviving phones count from the mutated `phones` array.
      return res.json({ updated: true, leadId, nextPhone: nextViable, remaining: phones.length, keptOnLead: !!untriedNext });

    } else if (outcome === "left_voicemail") {
      // v14.40 — Left VM counts toward the per-line no-answer cap (same as No Answer).
      // At CAP the phone flips to "struck" instead of "no_answer_today".
      // When every phone is struck, the lead auto-deletes (exhaustion delete).
      // v14.65 — Raised from 6 → 10 to give more attempts to hunt the true owner
      //           before retiring a line.
      // v14.81.1 — Raised from 10 → 12 (see PHONE_ATTEMPT_CAP comment above).
      const PHONE_ATTEMPT_CAP_VM = 12;
      const currentPhone = req.body.dialedPhone || lead.phone || "";
      let phoneAttemptsVm: Record<string, number> = {};
      try { phoneAttemptsVm = lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch {}

      if (currentPhone && newPhoneStates[currentPhone] !== undefined) {
        phoneAttemptsVm[currentPhone] = (phoneAttemptsVm[currentPhone] || 0) + 1;
        if (phoneAttemptsVm[currentPhone] >= PHONE_ATTEMPT_CAP_VM) {
          newPhoneStates[currentPhone] = "struck";
        } else {
          newPhoneStates[currentPhone] = "no_answer_today";
        }
      }

      rawDb.prepare(`UPDATE leads SET phone_attempts = ? WHERE id = ?`).run(JSON.stringify(phoneAttemptsVm), leadId);

      // Exhaustion delete when all lines struck
      const anyViableVm = newPhones.some((p: string) => newPhoneStates[p] !== "struck");
      if (!anyViableVm) {
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
          VALUES (?, ?, 'retired_no_answer', ?, NULL, ?)
        `).run(leadId, agentId || null,
          `Auto-retired: every phone hit ${PHONE_ATTEMPT_CAP_VM} no-answer/voicemail attempts (per-line cap).`,
          new Date().toISOString());
        awardPoints(agentId, "left_voicemail", leadId);
        rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_lines_struck_voicemail" });
      }

      const nextPhone = getNextViablePhone(newPhoneStates, newPhones);
      if (nextPhone) {
        newStatus = "assigned";
        newAssignedId = agentId;
        newPhones = [nextPhone, ...newPhones.filter((p: string) => p !== nextPhone)];
        rawDb.prepare("UPDATE leads SET phone = ? WHERE id = ?").run(nextPhone, leadId);
      } else {
        // All lines tried today — return to pool, release lock
        newStatus = "no_answer";
        newAssignedId = null;
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
      }
    }
    // v14.14 — The old `callback_requested` branch that scheduled a date and kept the
    // lead assigned to the agent has been removed. It's now handled above alongside
    // `recycled` as an immediate unassign to pool.


    // Save LPMAMAB fields if provided
    // v14.20 — Buyer LPMAMA is stored on the lead when alsoBuying=true.
    // The seller "buy" checkbox (lBuy) is retired in the UI but the column stays for backfill.
    const lpmamabUpdate = lpmamab ? {
      lLocation: lpmamab.location || lead.lLocation,
      lPricePaid: lpmamab.price || lead.lPricePaid,
      lMotivation: lpmamab.motivation || lead.lMotivation,
      lAgentHistory: lpmamab.agent || lead.lAgentHistory,
      lMortgage: lpmamab.mortgage || lead.lMortgage,
      lAppointment: lpmamab.appointment || lead.lAppointment,
      lBuy: lpmamab.buy || lead.lBuy,
      alsoBuying: (typeof lpmamab.alsoBuying === "boolean")
        ? (lpmamab.alsoBuying ? 1 : 0)
        : (lead.alsoBuying ?? 0),
      // v14.53 — persist intent when provided; fall back to existing value
      intent: (lpmamab as any).intent || (lead as any).intent || null,
      bLocation:  lpmamab.bLocation  || lead.bLocation,
      bPrice:     lpmamab.bPrice     || lead.bPrice,
      bMotivation:lpmamab.bMotivation|| lead.bMotivation,
      bAgent:     lpmamab.bAgent     || lead.bAgent,
      bMortgage:  lpmamab.bMortgage  || lead.bMortgage,
    } : {};

    // Wrong number: remove this number from the candidate list; delete lead only if it was the last one
    if (outcome === "wrong_number") {
      // v14.65 — REWRITE: struck phones are physically REMOVED from phones[]
      //   (also purged from phoneStates + phoneAttempts). What remains is our
      //   candidate set of "actual owner" numbers. Slot label 'Line X of N'
      //   naturally renumbers as candidates die. Dead numbers persist only in
      //   dead_lines JSON for audit/history.
      const dialedPhone = req.body.dialedPhone || lead.phone || "";
      let phones: string[] = lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []);
      const phoneStates: Record<string, string> = lead.phoneStates ? JSON.parse(lead.phoneStates) : {};
      let phoneAttempts: Record<string, number> = {};
      try { phoneAttempts = lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch {}
      let deadLines: string[] = [];
      try { deadLines = JSON.parse((lead as any).deadLines || (lead as any).dead_lines || "[]"); } catch {}

      // v14.65 — Physically remove the dialed phone from the candidate list
      if (dialedPhone) {
        phones = phones.filter(p => p !== dialedPhone);
        delete phoneStates[dialedPhone];
        delete phoneAttempts[dialedPhone];
        if (!deadLines.includes(dialedPhone)) deadLines.push(dialedPhone);
      }

      // Log the activity
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(leadId, agentId || null, outcome,
        notes || (dialedPhone ? `Wrong number: ${dialedPhone} removed from candidate list. ${phones.length} candidate(s) remaining.` : null),
        new Date().toISOString());

      if (phones.length === 0) {
        // All numbers confirmed bad — award points first, then clear FK-referencing rows
        // v14.10 — fix FK crash: also delete lead_locks row (previously only lead_activity was cleared)
        awardPoints(agentId, "wrong_number", leadId);
        rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_numbers_struck" });
      }

      // v14.18 — Wrong # advances phone but KEEPS the agent on the lead.
      // v14.65 — Slot 1 (lowest index) is always the next candidate we dial.
      const untriedNext = phones.find(p => phoneStates[p] === "untried") ?? null;
      const nextViable = untriedNext ?? phones[0];

      if (untriedNext) {
        rawDb.prepare(`UPDATE leads SET phone = ?, phones = ?, phone_states = ?, phone_attempts = ?, dead_lines = ?, status = 'assigned', assigned_agent_id = ? WHERE id = ?`).run(
          nextViable,
          JSON.stringify(phones),
          JSON.stringify(phoneStates),
          JSON.stringify(phoneAttempts),
          JSON.stringify(deadLines),
          agentId,
          leadId
        );
      } else {
        // v14.64 fix preserved: write status='no_answer' so puller skips it
        // until tomorrow's 8am EDT reset. Release lock.
        rawDb.prepare(`UPDATE leads SET phone = ?, phones = ?, phone_states = ?, phone_attempts = ?, dead_lines = ?, status = 'no_answer', assigned_agent_id = NULL WHERE id = ?`).run(
          nextViable,
          JSON.stringify(phones),
          JSON.stringify(phoneStates),
          JSON.stringify(phoneAttempts),
          JSON.stringify(deadLines),
          leadId
        );
        // Release the lock so my-next doesn't hand back this exhausted lead
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
      }

      awardPoints(agentId, "wrong_number", leadId);
      broadcast({ type: "activity_event", event: { type: "wrong_number", agentId, leadId, agentName: storage.getAgentById(agentId)?.name || "Agent", address: lead.address } });
      broadcast({ type: "lead_updated", leadId });
      // v14.81.1 — Same fix as Disconnected branch above: `remaining` was undefined.
      return res.json({ updated: true, leadId, nextPhone: nextViable, remaining: phones.length, keptOnLead: !!untriedNext });
    }

    // Update lead — persist phoneStates changes from no_answer handling
    const updatedLead = storage.updateLead(leadId, {
      status: newStatus,
      assignedAgentId: newAssignedId,
      callbackDate: newCallbackDate,
      attemptCount: lead.attemptCount + 1,
      phones: JSON.stringify(newPhones),
      phoneStates: JSON.stringify(newPhoneStates),
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
      // Detect network lead and build rich source string for FUB handoff
      let sourceLabel = lead.source || "—";
      let networkReferrerNote = "";
      try {
        const extra = JSON.parse((lead as any).extraData || "{}");
        if (extra.source === "network" && extra.submittedByName) {
          sourceLabel = `Network Lead — referred by ${extra.submittedByName}`;
          networkReferrerNote = extra.networkNotes ? `\n\nOriginal referral notes: ${extra.networkNotes}` : "";
        }
      } catch {}

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
        source:           sourceLabel,
        intention:        intention || "—",
        notes:            (notes || "—") + networkReferrerNote,
        apptDate:         apptDate || undefined,
        apptTime:         apptTime || undefined,
        apptEmail:        apptEmail || undefined,
      }).catch(err => console.error("CRM report email failed:", err));

      // v14.18 ── Expired KIT Credibility Email ──────────────────────────────────
      // Only fire for Expired lead KIT saves. Rate-limited to once per 60 days per lead.
      if (outcome === "keep_in_touch" && lead.leadType === "expired") {
        const targetEmail = (apptEmail || (lead as any).email || "").trim();
        const ownerFirstName = ((lead.ownerName || "").trim().split(/\s+/)[0]) || "";
        if (targetEmail && targetEmail.includes("@")) {
          sendExpiredCredibilityEmail({
            leadId,
            agentId,                                 // v14.29 — pass through for points
            ownerEmail: targetEmail,
            ownerFirstName,
            ownerPhone: (lead as any).phone || undefined,   // v14.27 — for FUB note
            address: confirmedAddress || lead.address || "your property",
            followUpTiming: followUpTiming || "few_weeks",
            agent: {
              name:  agent?.name || undefined,
              email: (agent as any)?.email || undefined,
              phone: (agent as any)?.phone || undefined,
            },
          }).catch(err => console.error("[CredibilityEmail] top-level error:", err));
        }
      }

      // ── Appointment Alert — instant ping to Alex/Nate for appt outcomes only
      if (outcome === "contacted_appointment") {
        sendAppointmentAlert({
          type:       "seller",
          agentName:  agent?.name || "Unknown Agent",
          clientName: lead.ownerName || "Unknown Client",
          clientPhone: lead.phone || undefined,
          address:    confirmedAddress || lead.address || undefined,
          apptDate:   apptDate || undefined,
          apptTime:   apptTime || undefined,
          notes:      notes || undefined,
        }).catch(err => console.error("Appointment alert email failed:", err));

        // v14.27 — Flow 4: send warm confirmation email to the seller (respects 24h cap)
        const _apptTarget = (apptEmail || (lead as any).email || "").trim();
        const _apptFirst = ((lead.ownerName || "").trim().split(/\s+/)[0]) || "";
        if (_apptTarget && _apptTarget.includes("@")) {
          sendAppointmentWarmEmail({
            leadId,
            agentId,
            ownerEmail: _apptTarget,
            ownerFirstName: _apptFirst,
            ownerPhone: (lead as any).phone || undefined,
            address: confirmedAddress || lead.address || "your property",
            apptDate: apptDate || undefined,
            apptTime: apptTime || undefined,
            agent: {
              name:  agent?.name || undefined,
              email: (agent as any)?.email || undefined,
              phone: (agent as any)?.phone || undefined,
            },
          }).catch(err => console.error("[ApptWarmEmail] top-level error:", err));
        }
      }
    }

    // ── FUB Integration — push outcome to Follow Up Boss (v11.40) ────────────
    const fubAgent = agentId ? storage.getAgentById(agentId) : null;
    if (fubAgent) {
      pushOutcomeToFub({
        lead: {
          id: leadId,
          ownerName:      lead.ownerName     || undefined,
          phone:          lead.phone          || undefined,
          email:          (lead as any).email || apptEmail || undefined,
          address:        lead.address        || undefined,
          leadType:       lead.leadType,
          source:         (lead as any).source || undefined,
          lLocation:      lead.lLocation      || undefined,
          lPricePaid:     lead.lPricePaid     || undefined,
          lMotivation:    lead.lMotivation    || undefined,
          lAgentHistory:  lead.lAgentHistory  || undefined,
          lMortgage:      lead.lMortgage      || undefined,
          lAppointment:   lead.lAppointment   || undefined,
          lBuy:           lead.lBuy           || undefined,
          // v14.20 — Buyer LPMAMA passthrough to FUB
          alsoBuying:     !!(lpmamab?.alsoBuying ?? lead.alsoBuying),
          bLocation:      (lpmamab?.bLocation)   || lead.bLocation   || undefined,
          bPrice:         (lpmamab?.bPrice)      || lead.bPrice      || undefined,
          bMotivation:    (lpmamab?.bMotivation) || lead.bMotivation || undefined,
          bAgent:         (lpmamab?.bAgent)      || lead.bAgent      || undefined,
          bMortgage:      (lpmamab?.bMortgage)   || lead.bMortgage   || undefined,
        },
        agent: {
          id:    fubAgent.id,
          name:  fubAgent.name,
          email: (fubAgent as any).email || undefined,
        },
        outcome,
        notes:            notes            || undefined,
        lpmamab:          lpmamab          || undefined,
        apptDate:         apptDate         || undefined,
        apptTime:         apptTime         || undefined,
        apptEmail:        apptEmail        || undefined,
        confirmedAddress: confirmedAddress || undefined,
        stage:            stage            || undefined,
        intention:        intention        || undefined,
      }).catch(err => console.error("[FUB] pushOutcomeToFub failed:", err));
    }

    // Award points for this outcome (v11.40)
    awardPoints(agentId, outcome, leadId);
    // Broadcast activity event for live feed (v11.40)
    const actingAgent = storage.getAgentById(agentId);
    broadcast({
      type: "activity_event",
      event: {
        type: outcome,
        agentId,
        agentName: actingAgent?.name || "Agent",
        agentHeadshot: actingAgent?.headshotUrl || null,
        leadId,
        address: updatedLead?.address || lead.address,
        ts: new Date().toISOString(),
      }
    });

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
  // v14.29 — Award email_sent points when Flow 1 mailto click is logged.
  // v14.27 — Enforces 1-email-per-lead-per-day cap (across all flows).
  app.post("/api/leads/:id/email-sent", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId } = req.body;
    const lead = storage.getLeadById(leadId) as any;
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // v14.27 — 1 email per lead per day cap
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = rawDb.prepare(`
      SELECT id FROM lead_activity
       WHERE lead_id = ?
         AND outcome = 'email_sent'
         AND created_at > ?
       LIMIT 1
    `).get(leadId, dayAgo);
    if (recent) {
      return res.status(429).json({ error: "Already emailed within last 24h", capped: true });
    }

    // v14.38 — Tag the cold-intro tap by lead type so the 24h gate can find it.
    // Absentee \u2192 flow5-mailto, Expired (and everything else) \u2192 flow1-mailto.
    const isAbsentee = (lead.leadType || "").toLowerCase() === "absentee";
    const tapNote = isAbsentee ? "flow5-mailto" : "flow1-mailto";
    const nowIso = new Date().toISOString();

    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome: "email_sent",
      notes: tapNote,
      lpmamabSnapshot: null,
      createdAt: nowIso,
    });
    // v14.29 — Fix 1: award points for the manual Flow 1/5 email
    if (agentId) awardPoints(parseInt(String(agentId)), "email_sent", leadId);

    // v14.38 \u2014 Kick off background FUB evidence poll (fire-and-forget).
    // Checks FUB /em endpoint ~5min after tap; if outbound email to lead matches, logs
    // a confirmation activity row. Never blocks the gate \u2014 gate opens at tap+24h regardless.
    scheduleFubEmailEvidence({
      leadId,
      leadEmail: lead.email || "",
      ownerPhone: lead.phone || "",
      ownerName:  lead.ownerName || "",
      tapNote,
      tappedAtIso: nowIso,
    }).catch(err => console.error("[v14.38 evidence] scheduling failed:", err?.message || err));

    res.json({ logged: true, points: 3, tapNote, unlockAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
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

    // ── Use SQL aggregation instead of in-memory iteration (scales to 1000s of leads) ──
    const resetFilter = resetAt ? `AND la.created_at > '${resetAt.replace(/'/g, "''")}' ` : "";

    // Per-agent outcome counts via GROUP BY
    const outcomeCounts: any[] = rawDb.prepare(`
      SELECT la.agent_id,
        la.outcome,
        COUNT(*) as cnt,
        MAX(la.created_at) as latest_at
      FROM lead_activity la
      WHERE la.agent_id IS NOT NULL ${resetFilter}
      GROUP BY la.agent_id, la.outcome
    `).all();

    // Per-agent lead counts
    const leadCounts: any[] = rawDb.prepare(`
      SELECT assigned_agent_id as agent_id,
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('assigned','no_answer','callback_requested') THEN 1 ELSE 0 END) as active
      FROM leads
      WHERE assigned_agent_id IS NOT NULL
      GROUP BY assigned_agent_id
    `).all();
    const leadCountMap: Record<number, { total: number; active: number }> = {};
    for (const r of leadCounts) leadCountMap[r.agent_id] = { total: r.total, active: r.active };

    // Network leads per agent (uploaded_by, extra_data contains source:network)
    const networkLeadRows: any[] = rawDb.prepare(
      `SELECT uploaded_by, COUNT(*) as cnt FROM leads WHERE uploaded_by IS NOT NULL AND extra_data LIKE '%"source":"network"%' GROUP BY uploaded_by`
    ).all();
    const networkMap: Record<number, number> = {};
    for (const r of networkLeadRows) networkMap[r.uploaded_by] = r.cnt;

    const stats = allAgents.map(agent => {
      const myOutcomes = outcomeCounts.filter((r: any) => r.agent_id === agent.id);
      const getCount = (outcome: string) => myOutcomes.find((r: any) => r.outcome === outcome)?.cnt ?? 0;

      const outcomes = {
        contacted_appointment:     getCount("contacted_appointment"),
        contacted_not_interested:  getCount("contacted_not_interested"),
        no_answer:                 getCount("no_answer"),
        keep_in_touch:             getCount("keep_in_touch"),
        callback_requested:        getCount("callback_requested"),
        wrong_number:              getCount("wrong_number"),
      };
      const emailsSent = getCount("email_sent");
      const totalAttempts = myOutcomes
        .filter((r: any) => r.outcome !== "email_sent")
        .reduce((s: number, r: any) => s + r.cnt, 0);
      const contactRate = totalAttempts > 0
        ? Math.round(((outcomes.contacted_appointment + outcomes.contacted_not_interested + outcomes.keep_in_touch) / totalAttempts) * 100)
        : 0;
      const lastActivityAt = myOutcomes.length > 0
        ? myOutcomes.reduce((latest: string, r: any) => (r.latest_at || "") > latest ? r.latest_at : latest, "")
        : null;
      const lc = leadCountMap[agent.id] || { total: 0, active: 0 };

      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        leadsReceived: lc.total,
        activeLeads: lc.active,
        appointmentsSet: outcomes.contacted_appointment,
        totalAttempts,
        emailsSent,
        networkLeads: networkMap[agent.id] ?? 0,
        contactRate,
        outcomes,
        lastActivityAt,
      };
    });

    // Sort by appointments set desc (leaderboard order)
    stats.sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts);
    res.json(stats);
  });

  // ─── ADMIN: PIPELINE VIEW ─────────────────────────────────────────────────
  app.get("/api/admin/pipeline", (req, res) => {
    // v14.81.1 — SECURITY FIX: this endpoint had NO auth guard, meaning any agent
    // (or unauthenticated caller) could see aggregate pool counts across the
    // entire lead pool. Agents must never see unassigned-pool counts — admin only.
    if (!requireAdmin(req, res)) return;
    // Return counts-only in byStatus to avoid sending thousands of leads to client.
    // The live pipeline tab shows top 50 active leads + counts.
    const limit = parseInt((req.query.limit as string) || "50");
    const offset = parseInt((req.query.offset as string) || "0");

    const allAgents = storage.getAllAgents();
    const agentMap = Object.fromEntries(allAgents.map(a => [a.id, a.name]));

    // Counts only per status (fast — single query per status)
    const statusCounts = rawDb.prepare(
      `SELECT status, COUNT(*) as cnt FROM leads GROUP BY status`
    ).all() as any[];
    const byStatus: Record<string, number> = {};
    for (const row of statusCounts) byStatus[row.status] = row.cnt;

    // Active leads (paginated) for the live pipeline list
    const ACTIVE = ["unassigned","assigned","no_answer","callback_requested"] // keep_in_touch exits to FUB;
    const activeRows = rawDb.prepare(
      `SELECT * FROM leads WHERE status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`
    ).all(...ACTIVE, limit, offset) as any[];

    const activeLeads = activeRows.map((r: any) => ({
      id: r.id, ownerName: r.owner_name, address: r.address, phone: r.phone,
      leadType: r.lead_type, status: r.status, attemptCount: r.attempt_count,
      callbackDate: r.callback_date, score: r.score ?? 0,
      territory: r.territory ?? null,
      assignedAgentId: r.assigned_agent_id,
      assignedAgentName: r.assigned_agent_id ? agentMap[r.assigned_agent_id] || "Unknown" : null,
    }));

    const totalActive = (rawDb.prepare(
      `SELECT COUNT(*) as n FROM leads WHERE status IN (${ACTIVE.map(() => "?").join(",")})`
    ).get(...ACTIVE) as any)?.n ?? 0;

    res.json({ leads: activeLeads, byStatus, total: totalActive });
  });

  // ─── ADMIN: LEADS FOR SPECIFIC AGENT ─────────────────────────────────────
  app.get("/api/admin/agent/:id/leads", (req, res) => {
    const agentId = parseInt(req.params.id);
    const agent = storage.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // SQL-indexed filter — avoids loading all leads (v11.70)
    const agentLeads: any[] = rawDb.prepare(
      `SELECT * FROM leads WHERE assigned_agent_id = ? ORDER BY uploaded_at DESC`
    ).all(agentId);
    const activities = agentLeads.flatMap((l: any) =>
      storage.getActivitiesForLead(l.id).map(a => ({ ...a, leadAddress: l.address }))
    );

    res.json({ agent: { id: agent.id, name: agent.name, email: agent.email }, leads: agentLeads, activities });
  });



  // ─── LIVE ACTIVITY FEED HISTORY (v11.40) ────────────────────────────────
  // Returns the last N agent_points rows enriched with agent info for history display
  // scope query param (v12.5): "seller" (default) | "recruiting"
  app.get("/api/admin/activity-feed", (req, res) => {
    const limit = parseInt(String(req.query.limit || "80"));
    const scope = (String(req.query.scope || "seller") === "recruiting") ? "recruiting" : "seller";
    const rows = rawDb.prepare(`
      SELECT ap.*, a.name as agent_name, a.headshot_url as agent_headshot
      FROM agent_points ap
      LEFT JOIN agents a ON a.id = ap.agent_id
      WHERE ap.scope = ?
      ORDER BY ap.created_at DESC
      LIMIT ?
    `).all(scope, limit) as any[];
    res.json(rows.reverse()); // oldest first for the feed
  });

  // ─── AGENT POINTS TOTAL ───────────────────────────────────────────────────
  // scope query param (v12.5): "seller" (default) | "recruiting"
  app.get("/api/agents/:id/points", (req, res) => {
    const agentId = parseInt(req.params.id);
    const scope = (String(req.query.scope || "seller") === "recruiting") ? "recruiting" : "seller";
    const resetKey = scope === "recruiting" ? "leaderboard_reset_at_recruiting" : "leaderboard_reset_at";
    const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(resetKey) as any;
    const resetAt: string | null = resetRow?.value || null;
    const row = rawDb.prepare(
      `SELECT SUM(points) as total FROM agent_points WHERE agent_id = ? AND scope = ? ${resetAt ? "AND created_at >= ?" : ""}`
    ).get(...([agentId, scope, ...(resetAt ? [resetAt] : [])])) as any;
    res.json({ points: row?.total || 0 });
  });

  // ─── SCRIPTS (DB-backed, editable) ────────────────────────────────────────
  // Initialize default scripts on first run
  const initScript = (leadType: string, defaultContent: string) => {
    const exists = rawDb.prepare("SELECT id FROM scripts WHERE lead_type = ?").get(leadType);
    if (!exists) {
      rawDb.prepare("INSERT INTO scripts (lead_type, content, updated_at) VALUES (?, ?, ?)").run(leadType, defaultContent, new Date().toISOString());
    }
  };

  // v14.29 — Full rewrite in Alex's voice. Guardrails moved above Mindset.
  const expiredScript = `EXPIRED LISTING SCRIPT — v14.29
Brothers Group Real Estate Team at Momentum Realty
─────────────────────────────────────────────────

AGENT GUARDRAILS — do NOT

  ✗ Sound rushed or read-y
  ✗ Announce you're "not pitching" (that IS pitching)
  ✗ Lead with the company name
  ✗ Push for an appointment before you understand the situation
  ✗ Interrupt or talk over the seller
  ✗ Use words like "quote," "consultation," "reach out"
  ✗ Make it about you or the team — make it about their house
  ✗ Fill silence — let them think

─────────────────────────────────────────────────

MINDSET (read before you dial — not spoken)
  • We're here for the easy yes's — not to force the no's.
  • They already had one agent fail them. Don't be the second
    version of that person.
  • Understand first. We win by knowing the market better,
    not by talking more.

─────────────────────────────────────────────────
OPENING

  "Hey [First Name] — it's [Agent First Name]. I'm calling
   about the house at [Address]. Did I catch you okay?"

─────────────────────────────────────────────────
CALL FLOW

  1. IDENTITY + PERMISSION
     Confirm it's them. Confirm they can talk.

  2. WHAT HAPPENED
     "So I saw it was on the market and then it came off —
      what happened there?"

  3. WHAT WAS THE PLAN
     "And if it had sold, where were you headed?"

  4. IS THE MOVE REAL
     Listen. Ask follow-ups. You're figuring out if there's a
     real life reason to move, or if they were just seeing
     what the market would do.

  5. TIMELINE (only after you know the move is real)
     "When were you thinking that would actually happen?"

  6. BRANCH → based on motivation

─────────────────────────────────────────────────
COMPANY NAME REVEAL (delayed)

Only when they ask, or after real rapport:
  "I'm [Full Name] with the Brothers Group Real Estate Team
   at Momentum Realty — we're a local team here in [City]."

─────────────────────────────────────────────────
BRANCH A — REAL MOVE, NO PLAN → APPOINTMENT

Frame: You know something they don't. Show them.

  "Here's the honest read — most expireds don't fail because
   of the house. They fail because of how it was priced and
   marketed. If you stack the cards right, the market comes
   to you instead of you chasing it."

  "It's a no-obligation 5-minute walk-through. I'll show you
   what we'd do differently and what the numbers actually
   look like right now. If it makes sense, we move. If not,
   at least you know where you stand."

BRANCH B — NOT READY, TONE WARM → KEEP IN TOUCH

  "Totally fair. When you get closer, the pricing window
   matters more than most people realize — I'd rather you
   have someone tracking that for you than figure it out
   on your own."

  Ask: "What's the best email for you?"
  Ask: "When should I check back in?"

  Send the intro email. Don't announce it, don't apologize
  for it, don't call it "just a quick note." Just send it.

BRANCH C — BUSY, NOT HOSTILE → RECYCLE

  "Got it — I'll catch you another time."

  One tap Recycle. Move on.

BRANCH D — CLEARLY NOT INTERESTED → NOT INTERESTED

  "Understood. Best of luck with the house."

  End it. Respect it.

─────────────────────────────────────────────────
WHY US (only if they ask — never volunteered)

  "26+ years of combined real estate experience. Top 1% of
   teams in NE Florida. RealProducers Top 500. Jacksonville
   Business Journal ranked team. Hundreds of five-star
   reviews. We also bring construction and roofing expertise
   from years in the industry — so when we walk your house
   we can tell you what actually matters before it lists,
   what doesn't, and what buyers and inspectors will flag."

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


  initScript("expired", expiredScript);

  const emailOutreachTemplate = `Subject: Regarding Your Property at {address}

Hi {ownerName},

My name is [YOUR NAME] with The Brothers Group at Momentum Realty. I came across your property at {address} and wanted to reach out personally.

We work with a lot of qualified buyers actively looking in your area, and I'd love to have a quick conversation to see if there's an opportunity to help you.

Would you be open to a brief call this week?

Best regards,
[YOUR NAME]
Brothers Group Real Estate Team at Momentum Realty
[YOUR PHONE]
bgre.com

---
Note: Replace {ownerName} and {address} with lead details before sending.
This template is for informational/outreach purposes only.`;
  initScript("email_outreach", emailOutreachTemplate);

  // v14.26 — Editable email templates for the four email flows.
  // Format: first non-blank line = Subject: <line>. Everything after = body.
  // Placeholders: {ownerFirst}, {ownerName}, {address}, {agentFirst}, {agentFull}, {agentPhone}, {agentEmail}, {timing}, {apptDate}, {apptTime}
  // v14.29 — All 4 email templates rewritten in Alex's voice.
  // v14.38 — Flow 5 + Flow 6 added for absentee cold outreach.
  // NOTE ON KEY MAPPING:
  //   email_flow1 = Cold Intro (mailto, expired)           — Flow 1 in user journey (expired path)
  //   email_flow3 = Value Stack (2nd attempt, expired)     — Flow 2 in user journey (expired path)
  //   email_flow2 = Thank You for Choosing Us (KIT auto)   — Flow 3 in user journey (both paths)
  //   email_flow4 = Appointment Confirmed (auto)           — Flow 4 in user journey (both paths)
  //   email_flow5 = Absentee Cold Intro (mailto, absentee) — Flow 5 in user journey (absentee path)
  //   email_flow6 = Absentee Value Stack (2nd attempt)     — Flow 6 in user journey (absentee path)
  //
  // Flow 1/2 fire for expired leads; Flow 5/6 fire for absentee leads. Same triggers (email
  // button / 2nd-attempt button) branch on lead.leadType. Flow 3/4 serve both without branching.

  // Flow 1 — Cold Intro (mailto, first touch before contact)
  const emailFlow1Template = `Subject: About the house at {address}

Hi {ownerFirst},

{agentFirst} here \u2014 I called earlier about {address}. Figured I'd drop a note in case email's easier.

If you're still thinking about selling, I'd like to show you what the house would actually move for right now, and what we'd do differently than the last listing. Five minutes, no obligation.

{agentPhone} if easier.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty`;
  initScript("email_flow1", emailFlow1Template);

  // Flow 2 (in user journey) — stored under key email_flow2 = WELCOME TO THE FAMILY, fires on KIT outcome (auto)
  const emailFlow2Template = `Subject: Thank you for choosing us, {ownerFirst}

Hey {ownerFirst},

Thank you for choosing Brothers Group. Great talking earlier \u2014 looking forward to working together whenever the time comes. We're here when you need us.

A little about the team you're now working with:

  \u2022 26+ years of combined real estate experience
  \u2022 Top 1% of teams in all of NE Florida
  \u2022 RealProducers Top 500
  \u2022 Jacksonville Business Journal ranked team
  \u2022 Hundreds of five-star reviews across the platforms

Get to know us a little better:

  Website \u2192 brothersgroup.realestate
  Meet the team \u2192 brothersgroup.realestate/our-agents
  Reviews \u2192 brothersgroup.realestate/reviews

You'll hear from us whenever something interesting comes up in your market \u2014 we don't spam.

Let us know any questions we can help with, whether it's for you or a friend or family member who needs a hand.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty
{agentPhone} \u00b7 {agentEmail}`;
  initScript("email_flow2", emailFlow2Template);

  // Flow 3 (in user journey) — stored under key email_flow3 = VALUE STACK, fires on manual 2nd-attempt button
  const emailFlow3Template = `Subject: A thought on {address}

Hi {ownerFirst},

{agentFirst} \u2014 following up on {address}.

Quick note on how we work. When we take on a listing, we build the price around real market demand and market the house the way it should be marketed. Stack the cards right and the market comes to you \u2014 you stay in control of the sale.

We also bring construction and roofing expertise from years in the industry, so we can walk a house and tell you what actually needs to be addressed before it lists, what doesn't, and what buyers and inspectors will flag. Usually saves money on repairs and protects the sale price when negotiations start.

Local, born and raised, hundreds of five-star reviews \u2192 brothersgroup.realestate/reviews

If you want to see what that looks like for {address} \u2014 no obligation, five-minute walk-through \u2014 {agentPhone} or reply here.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty
{agentPhone} \u00b7 {agentEmail}`;
  initScript("email_flow3", emailFlow3Template);

  // Flow 4 (in user journey) — Appointment Confirmed, fires on contacted_appointment outcome (auto)
  const emailFlow4Template = `Subject: {apptDate} at {apptTime} \u2014 {address}

Hey {ownerFirst},

Thank you for choosing Brothers Group. Great connecting today \u2014 we're looking forward to meeting you and taking a look at {address}.

Confirmed for {apptDate} at {apptTime}.

Here's what we'll bring to the walk-through:

  \u2022 A real read on your home \u2014 recent comps, what buyers in your area are actually paying, and how we'd price and market it to sell for the strongest possible number.
  \u2022 Our construction and roofing expertise from years in the industry \u2014 we'll walk the house with you and flag what actually matters before it lists, what doesn't, and what buyers and inspectors will notice. Usually saves money on repairs and protects the sale price in negotiation.

A little about the team you're now working with:

  \u2022 26+ years of combined real estate experience
  \u2022 Top 1% of teams in all of NE Florida
  \u2022 RealProducers Top 500
  \u2022 Jacksonville Business Journal ranked team
  \u2022 Hundreds of five-star reviews across the platforms

Get to know us a little more before we meet:

  Website \u2192 brothersgroup.realestate
  Meet the team \u2192 brothersgroup.realestate/our-agents
  Reviews \u2192 brothersgroup.realestate/reviews

Any questions before then, we're a call or text away at {agentPhone}. And if you know a friend or family member who could use a hand with real estate, we're here for them too.

See you {apptDate}.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty
{agentPhone} \u00b7 {agentEmail}`;
  initScript("email_flow4", emailFlow4Template);

  // v14.38 — Flow 5 (Absentee Cold Intro, mailto). Fires from the Email button when lead.leadType='absentee'.
  // Honest cold-outreach opener — no "following up" (there's nothing to follow up on). Peer-to-peer, hyper-local,
  // acknowledges the owner is likely out-of-area, keeps the ask small (real numbers, no obligation).
  const emailFlow5Template = `Subject: About your property at {address}

Hi {ownerFirst},

{agentFirst} here with Brothers Group Real Estate at Momentum Realty \u2014 we work this exact market every day.

I'm reaching out because I noticed you own {address} but aren't in the area. Most out-of-area owners we work with just want a local set of eyes they can trust for whenever the time comes \u2014 whether that's selling, holding, adding to the portfolio, or exploring a 1031.

If you'd like, I'm happy to send preliminary information on {address} \u2014 real comps, real rental data, real numbers on what it would actually sell or rent for today. No obligation, no clock running.

{agentPhone} if easier, or reply here.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty`;
  initScript("email_flow5", emailFlow5Template);

  // v14.38 — Flow 6 (Absentee Value Stack, server-sent 2nd attempt). Fires from the Send 2nd Attempt button
  // when lead.leadType='absentee'. Mirrors Flow 2's role but hits absentee's real decision matrix (buy / hold /
  // 1031 / sell) instead of just the listing-sale thesis.
  const emailFlow6Template = `Subject: A few real numbers on {address}

Hi {ownerFirst},

{agentFirst} again \u2014 following up on my note about {address}.

A quick word on how we work with owners like you. We don't push, we don't spam, and we don't chase. What we do is give real numbers \u2014 what {address} would sell for today, what it would rent for, what a 1031 into something easier to manage looks like on paper, or what to target if you're adding to the portfolio.

We also bring construction and roofing expertise from years in the industry, so if selling comes into play we can walk the property (in person or virtually) and tell you what actually matters before it hits the market and what doesn't. Usually saves money on repairs and protects the sale price when negotiations start.

Local, born and raised, hundreds of five-star reviews \u2192 brothersgroup.realestate/reviews

Happy to put together a snapshot for {address} whenever you want it \u2014 no obligation, and we do virtual walk-throughs if you're not local. {agentPhone} or reply here.

\u2014 {agentFull}
Brothers Group Real Estate Team at Momentum Realty
{agentPhone} \u00b7 {agentEmail}`;
  initScript("email_flow6", emailFlow6Template);

  // v14.29 — Force-update all templates on boot so prod DB rows get the new content.
  // initScript() above only inserts if missing. This block updates existing rows to match code.
  try {
    const forceUpdate = rawDb.prepare("UPDATE scripts SET content = ?, updated_at = ? WHERE lead_type = ?");
    const nowIso = new Date().toISOString();
    forceUpdate.run(expiredScript, nowIso, "expired");
    forceUpdate.run(emailFlow1Template, nowIso, "email_flow1");
    forceUpdate.run(emailFlow2Template, nowIso, "email_flow2");
    forceUpdate.run(emailFlow3Template, nowIso, "email_flow3");
    forceUpdate.run(emailFlow4Template, nowIso, "email_flow4");
    forceUpdate.run(emailFlow5Template, nowIso, "email_flow5");
    forceUpdate.run(emailFlow6Template, nowIso, "email_flow6");
    console.log("[v14.38] Force-updated expired script + 6 email templates to new voice");
  } catch (e: any) {
    console.error("[v14.38] Failed to force-update scripts:", e.message);
  }

  // v14.29 — Delete test lead id=4859 (AUDIT Network Test placeholder)
  try {
    const deleteRes = rawDb.prepare("DELETE FROM leads WHERE id = 4859 AND (owner_name LIKE '%AUDIT%' OR address LIKE '%Audit Network%')").run();
    if (deleteRes.changes > 0) console.log(`[v14.29] Deleted test lead id=4859 (${deleteRes.changes} row)`);
  } catch (e: any) {
    console.error("[v14.29] Failed to delete test lead 4859:", e.message);
  }

  // v14.26 — Load an editable script template, splitting Subject: from body.
  // Returns null if the script is missing (caller falls back to hardcoded copy).
  function loadEmailTemplate(leadType: string): { subject: string; body: string } | null {
    const row = rawDb.prepare("SELECT content FROM scripts WHERE lead_type = ?").get(leadType) as any;
    if (!row?.content) return null;
    const lines: string[] = String(row.content).split(/\r?\n/);
    let subject = "";
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = line.match(/^Subject:\s*(.*)$/i);
      if (m) { subject = m[1]; bodyStart = i + 1; }
      break;
    }
    // Skip blank lines after subject
    while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++;
    return { subject, body: lines.slice(bodyStart).join("\n").trim() };
  }

  // v14.26 — Interpolate {placeholder} tokens. Unknown/empty tokens become empty string.
  function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
    return tpl.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] ?? ""));
  }

  // Expose to module scope for use inside email senders
  (globalThis as any).__leadDepotLoadEmailTemplate = loadEmailTemplate;
  (globalThis as any).__leadDepotRenderTemplate = renderTemplate;

  // v14.29 — Email status for a lead. Used to gate the manual Flow 3/6 button on the client.
  //   flow1Sent            = any Flow 1/5 cold-intro tap exists for this lead
  //   contactedYet         = a contacted_* outcome exists — disqualifies Flow 3/6
  //   emailedToday         = any email_sent activity in last 24h — daily cap active
  //   flow3Eligible        = flow1Sent && !contactedYet && gateOpen (v14.38: 24h since cold-intro tap)
  //   secondAttemptBadge   = flow1Sent && !contactedYet (show badge even when gate closed)
  //   v14.38 additions:
  //     tappedAt           = ISO timestamp of the earliest cold-intro tap (Flow 1 or 5)
  //     unlockAt           = tappedAt + 24h (ISO)
  //     secondsUntilUnlock = clamp(unlockAt - now, 0..)
  //     gateOpen           = secondsUntilUnlock === 0
  //     evidenceConfirmed  = FUB webhook confirmed the outbound email landed in FUB timeline
  app.get("/api/leads/:id/email-status", (req, res) => {
    const leadId = parseInt(req.params.id);
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    // v14.38 \u2014 Look for the earliest cold-intro tap (Flow 1 or Flow 5).
    // Older rows may have notes='flow1-manual-mailto' (pre-v14.38). Match those too.
    const tapRow = rawDb.prepare(`
      SELECT id, created_at, notes FROM lead_activity
       WHERE lead_id = ? AND outcome = 'email_sent'
         AND (notes LIKE 'flow1%' OR notes LIKE 'flow5%')
       ORDER BY created_at ASC
       LIMIT 1
    `).get(leadId) as any;
    const contactedRow = rawDb.prepare(`
      SELECT id FROM lead_activity
       WHERE lead_id = ? AND outcome IN ('contacted_appointment','keep_in_touch','contacted_not_interested')
       LIMIT 1
    `).get(leadId);
    const capRow = rawDb.prepare(`
      SELECT id FROM lead_activity
       WHERE lead_id = ? AND outcome = 'email_sent' AND created_at > ?
       LIMIT 1
    `).get(leadId, dayAgo);
    // v14.38 \u2014 FUB evidence row logged by the background poller when the mailto
    // actually left the agent's Gmail (visible in the FUB timeline). Best-effort, non-blocking.
    const evidenceRow = rawDb.prepare(`
      SELECT id, created_at, notes FROM lead_activity
       WHERE lead_id = ? AND outcome = 'email_confirmed'
       LIMIT 1
    `).get(leadId) as any;

    const flow1Sent    = !!tapRow;
    const contactedYet = !!contactedRow;
    const emailedToday = !!capRow;

    let tappedAt: string | null = null;
    let unlockAt: string | null = null;
    let secondsUntilUnlock = 0;
    let gateOpen = false;
    if (tapRow) {
      tappedAt = String(tapRow.created_at);
      const tappedMs = new Date(tappedAt).getTime();
      const unlockMs = tappedMs + 24 * 60 * 60 * 1000;
      unlockAt = new Date(unlockMs).toISOString();
      secondsUntilUnlock = Math.max(0, Math.round((unlockMs - now) / 1000));
      gateOpen = secondsUntilUnlock === 0;
    }

    // Flow 3/6 is eligible only when: flow1 tapped, not contacted, gate open, AND not blocked by daily cap.
    // (emailedToday is preserved for the display-only "Email sent today" placeholder before the gate flip.)
    const flow3Eligible = flow1Sent && !contactedYet && gateOpen && !emailedToday;

    res.json({
      flow1Sent,
      contactedYet,
      emailedToday,
      flow3Eligible,
      secondAttemptBadge: flow1Sent && !contactedYet,
      // v14.38 additions
      tappedAt,
      unlockAt,
      secondsUntilUnlock,
      gateOpen,
      evidenceConfirmed: !!evidenceRow,
      evidenceAt: evidenceRow ? String(evidenceRow.created_at) : null,
    });
  });

  // v14.29 — Flow 3: 2nd attempt email. Sends via Resend using email_flow3 template.
  // Requires prior Flow 1 send AND no contact outcome AND daily cap not hit. Awards +5.
  app.post("/api/leads/:id/email-flow3", async (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId } = req.body;
    const lead = storage.getLeadById(leadId) as any;
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!lead.email || !String(lead.email).includes("@")) {
      return res.status(400).json({ error: "Lead has no email address" });
    }

    // Eligibility recheck server-side
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const flow1Row = rawDb.prepare(`
      SELECT id FROM lead_activity WHERE lead_id = ? AND outcome = 'email_sent' LIMIT 1
    `).get(leadId);
    if (!flow1Row) return res.status(400).json({ error: "Cannot send 2nd attempt \u2014 no prior email on this lead" });
    const contactedRow = rawDb.prepare(`
      SELECT id FROM lead_activity WHERE lead_id = ? AND outcome IN ('contacted_appointment','keep_in_touch','contacted_not_interested') LIMIT 1
    `).get(leadId);
    if (contactedRow) return res.status(400).json({ error: "Cannot send 2nd attempt \u2014 lead already contacted" });
    const capRow = rawDb.prepare(`
      SELECT id FROM lead_activity WHERE lead_id = ? AND outcome = 'email_sent' AND created_at > ? LIMIT 1
    `).get(leadId, dayAgo);
    if (capRow) return res.status(429).json({ error: "Already emailed within last 24h", capped: true });

    // v14.38 — 24h gate. Look up the earliest cold-intro tap (Flow 1 or 5) and
    // block Flow 3/6 with HTTP 425 until 24h have elapsed. Server-side hard gate
    // matching the client-side lock in AgentView.
    const tapRow = rawDb.prepare(`
      SELECT created_at FROM lead_activity
       WHERE lead_id = ? AND outcome = 'email_sent'
         AND (notes LIKE 'flow1%' OR notes LIKE 'flow5%')
       ORDER BY created_at ASC
       LIMIT 1
    `).get(leadId) as any;
    if (tapRow) {
      const tapMs = new Date(String(tapRow.created_at)).getTime();
      const unlockMs = tapMs + 24 * 60 * 60 * 1000;
      const secondsUntilUnlock = Math.max(0, Math.round((unlockMs - Date.now()) / 1000));
      if (secondsUntilUnlock > 0) {
        return res.status(425).json({
          error: "2nd attempt locked \u2014 wait 24h from first email",
          gateLocked: true,
          secondsUntilUnlock,
          unlockAt: new Date(unlockMs).toISOString(),
        });
      }
    }

    if (!resend) return res.status(503).json({ error: "Email service not configured" });

    const agent = agentId ? storage.getAgentById(parseInt(String(agentId))) as any : null;
    const ownerFirst = ((lead.ownerName || "").trim().split(/\s+/)[0] || "there");
    const agentFull = agent?.name || "";
    const agentFirst = (agentFull.trim().split(/\s+/)[0] || "");
    const agentEmail = agent?.email || "noreply@watsonbrothersgroup.com";
    const agentPhone = agent?.phone || "";
    // v14.38 — branch on lead.leadType so absentee leads use Flow 6 instead of Flow 3.
    const isAbsentee = (lead.leadType || "").toLowerCase() === "absentee";
    const templateKey = isAbsentee ? "email_flow6" : "email_flow3";
    const flowLabel = isAbsentee ? "Flow 6 \u2014 Absentee 2nd Attempt (manual)" : "Flow 3 \u2014 2nd Attempt (manual)";
    const tpl = loadEmailTemplate(templateKey);
    if (!tpl) return res.status(500).json({ error: `${templateKey} template missing` });
    const vars = {
      ownerFirst,
      ownerName: lead.ownerName || "",
      address:   lead.address || "",
      agentFirst,
      agentFull,
      agentPhone,
      agentEmail,
    };
    const subject = renderTemplate(tpl.subject, vars);
    const plainText = renderTemplate(tpl.body, vars);
    // v14.29.4 — Branded HTML shell with agent headshot signature card.
    const html = renderBrandedEmail({
      bodyText: plainText,
      agentName: agentFull || "Brothers Group",
      agentPhone,
      agentEmail,
      agentHeadshotUrl: agent?.headshotUrl || null,
    });

    try {
      await resend.emails.send({
        from:      `${agentFull || "Brothers Group"} <${agentEmail || "noreply@watsonbrothersgroup.com"}>`,
        to:        [lead.email],
        cc:        ["alex@watsonbrothersgroup.com"],
        bcc:       agentEmail ? [agentEmail] : undefined,
        reply_to:  agentEmail,
        subject,
        html,
        text:      plainText,
      } as any);
      const nowIso = new Date().toISOString();
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
        VALUES (?, ?, 'email_sent', ?, NULL, ?)
      `).run(leadId, agentId || null, `flow3-second-attempt sent to ${lead.email}`, nowIso);
      if (agentId) awardPoints(parseInt(String(agentId)), "email_sent_value", leadId);
      pushEmailNoteToFub({
        ownerPhone: lead.phone || undefined,
        ownerName:  ownerFirst,
        subject,
        sentAt:     nowIso,
        preview:    plainText.slice(0, 260),
        kind:       flowLabel,
      }).catch(err => console.error(`[FUB] ${flowLabel} note push failed:`, err));
      console.log(`[${flowLabel}] sent for lead ${leadId} to ${lead.email} (agent ${agentId || "unknown"})`);
      res.json({ sent: true, points: 5 });
    } catch (e: any) {
      console.error(`[Flow3] send failed for lead ${leadId}:`, e.message);
      res.status(500).json({ error: "Send failed", detail: e.message });
    }
  });

  // v14.26 — Public endpoint for the client to fetch a rendered mailto for Flow 1 or Flow 3.
  // GET /api/leads/:id/email-template?flow=1&agentId=3
  app.get("/api/leads/:id/email-template", (req, res) => {
    const leadId = parseInt(req.params.id);
    const flow = String(req.query.flow || "1");
    const agentId = req.query.agentId ? parseInt(String(req.query.agentId)) : null;
    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    const agent = agentId ? storage.getAgentById(agentId) : null;
    // v14.38 — branch on lead.leadType so absentee leads render Flow 5 (mailto) / Flow 6 (2nd attempt).
    const isAbsentee = ((lead as any).leadType || "").toLowerCase() === "absentee";
    let key: string;
    if (flow === "3") key = isAbsentee ? "email_flow6" : "email_flow3";
    else               key = isAbsentee ? "email_flow5" : "email_flow1";
    const tpl = loadEmailTemplate(key);
    if (!tpl) return res.status(404).json({ error: "Template not found" });
    const ownerName = (lead as any).ownerName || "";
    const ownerFirst = (ownerName.trim().split(/\s+/)[0] || "there");
    const agentFull = agent?.name || "";
    const agentFirst = (agentFull.trim().split(/\s+/)[0] || "");
    const vars = {
      ownerFirst,
      ownerName,
      address: (lead as any).address || "",
      agentFirst,
      agentFull,
      agentPhone: (agent as any)?.phone || "",
      agentEmail: (agent as any)?.email || "",
    };
    res.json({
      subject: renderTemplate(tpl.subject, vars),
      body:    renderTemplate(tpl.body, vars),
    });
  });

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


  // ─── AGENT: MY LEAD QUEUE COUNT (v13.9 — home-county aware) ─────────────
  // Counts what this agent can still call today:
  //   - Own assigned/no-answer/callback leads
  //   - PLUS eligible unassigned pool (home-county if set, else all counties)
  //   - If home-county pool is dry, falls through to overflow pool (all other counties)
  app.get("/api/leads/my-count/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    const agent: any = rawDb.prepare(`SELECT home_county FROM agents WHERE id = ?`).get(agentId);
    if (!agent) return res.json({ count: 0 });

    // Sweep expired locks first.
    rawDb.prepare(`DELETE FROM lead_locks WHERE expires_at < datetime('now')`).run();

    // Own queue.
    const own: any = rawDb.prepare(
      `SELECT COUNT(*) as n FROM leads
       WHERE assigned_agent_id = ?
         AND status IN ('assigned','no_answer','callback_requested')`
    ).get(agentId);

    // Home-county pool count.
    let poolCount = 0;
    const homeCounty = agent.home_county;
    if (homeCounty) {
      const homeRow: any = rawDb.prepare(`
        SELECT COUNT(*) as n FROM leads l
        LEFT JOIN lead_locks lk ON lk.lead_id = l.id
        WHERE l.status = 'unassigned' AND lk.lead_id IS NULL
          AND LOWER(l.county) = LOWER(?)
      `).get(homeCounty);
      poolCount = homeRow?.n ?? 0;

      // Home is dry → overflow to other counties.
      if (poolCount === 0) {
        const ovRow: any = rawDb.prepare(`
          SELECT COUNT(*) as n FROM leads l
          LEFT JOIN lead_locks lk ON lk.lead_id = l.id
          WHERE l.status = 'unassigned' AND lk.lead_id IS NULL
            AND (l.county IS NULL OR LOWER(l.county) <> LOWER(?))
        `).get(homeCounty);
        poolCount = ovRow?.n ?? 0;
      }
    } else {
      // Admin / no home-county — sees all counties.
      const allRow: any = rawDb.prepare(`
        SELECT COUNT(*) as n FROM leads l
        LEFT JOIN lead_locks lk ON lk.lead_id = l.id
        WHERE l.status = 'unassigned' AND lk.lead_id IS NULL
      `).get();
      poolCount = allRow?.n ?? 0;
    }

    res.json({ count: (own?.n ?? 0) + poolCount });
  });

  // ─── AGENT SELF-SERVICE: SET OWN HOME COUNTY (v13.10) ──────────────
  // PATCH /api/agents/:id/home-county  { homeCounty: "Nassau"|"Duval"|"St Johns" }
  // Called by the first-login gate. Agent picks their county — required to enter app.
  app.patch("/api/agents/:id/home-county", (req, res) => {
    // v14.63 — SECURITY: was fully ungated. Now self-or-admin.
    // v14.63 — PRODUCT: agents can now self-select "All counties" (killer mode)
    // by passing null / empty. Previously admin-only via /api/admin/agents/:id/home-county.
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid agent id" });
    if (!requireSelfOrAdmin(req, res, id)) return;
    const raw = req.body?.homeCounty;
    const trimmed = raw != null ? String(raw).trim() : "";
    const ALLOWED = ["Nassau", "Duval", "St Johns"];
    // Empty / null / "All counties" all mean killer mode → store as NULL.
    const isAllCounties = trimmed === "" || trimmed.toLowerCase() === "all counties";
    if (!isAllCounties && !ALLOWED.includes(trimmed)) {
      return res.status(400).json({ error: "Invalid county. Allowed: Nassau, Duval, St Johns, or 'All counties'." });
    }
    const existing = storage.getAgentById(id);
    if (!existing) return res.status(404).json({ error: "Agent not found" });
    const value = isAllCounties ? null : trimmed;
    rawDb.prepare(`UPDATE agents SET home_county = ? WHERE id = ?`).run(value, id);
    res.json({ ok: true, homeCounty: value });
  });

  // ─── ADMIN: SET AGENT HOME COUNTY (v13.9) ──────────────────────
  // PATCH /api/admin/agents/:id/home-county  { homeCounty: string|null }
  //   null / empty string → killer mode (all counties, Alex + Nate)
  //   "Nassau" | "Duval" | "St Johns" → restricted to that county + overflow
  app.patch("/api/admin/agents/:id/home-county", (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid agent id" });
    const raw = req.body?.homeCounty;
    const homeCounty: string | null = raw && String(raw).trim() ? String(raw).trim() : null;

    const existing = storage.getAgentById(id);
    if (!existing) return res.status(404).json({ error: "Agent not found" });

    rawDb.prepare(`UPDATE agents SET home_county = ? WHERE id = ?`).run(homeCounty, id);
    const updated = storage.getAgentById(id);
    res.json({ ...updated, password: undefined });
  });

  // ─── CLAIM A CALLBACK (v14.81.1) ────────────────────────────────────────────
  // v14.81.1 — Alex: "With the phone-number look-up I want anyone to grab it if
  // they call back that agent." Rule: FIRST LOOKUP WINS if lead is unassigned.
  //
  // Preconditions to claim:
  //   • Lead exists
  //   • Lead is NOT in an owned state (KIT / Appt) with a different agent
  // Effect:
  //   • assigned_agent_id = agentId, status = 'assigned'
  //   • lead.phone flipped to the callback number so Dial page shows the right one
  //   • Release any lead_lock
  //   • Log lookup_claimed activity
  //   • Broadcast lead_updated for realtime
  //
  // If already owned by another agent → 409, no-op (owner protection).
  // If already owned by THIS agent    → 200 with reason='already_yours' + full lead.
  app.post("/api/leads/:id/claim-callback", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, phone } = req.body || {};
    const parsedAgentId = parseInt(String(agentId || ""));
    if (!parsedAgentId || isNaN(parsedAgentId)) return res.status(400).json({ error: "agentId required" });
    if (!leadId || isNaN(leadId)) return res.status(400).json({ error: "lead id required" });

    const lead: any = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const OWNED_STATES = new Set(["keep_in_touch", "contacted_appointment"]);
    const alreadyOwned = OWNED_STATES.has(lead.status) && lead.assignedAgentId != null;

    if (alreadyOwned && lead.assignedAgentId !== parsedAgentId) {
      const owner: any = storage.getAgentById(lead.assignedAgentId);
      return res.status(409).json({
        claimed: false,
        reason: "owned_by_other",
        owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
      });
    }

    if (alreadyOwned && lead.assignedAgentId === parsedAgentId) {
      return res.json({ claimed: false, reason: "already_yours", lead });
    }

    // Claim it.
    const nowIso = new Date().toISOString();

    // Flip primary phone to the callback number (if provided) so the Dial page
    // opens on the right line immediately.
    if (phone && typeof phone === "string" && phone.trim()) {
      rawDb.prepare(`UPDATE leads SET phone = ?, status = 'assigned', assigned_agent_id = ? WHERE id = ?`).run(phone, parsedAgentId, leadId);
    } else {
      rawDb.prepare(`UPDATE leads SET status = 'assigned', assigned_agent_id = ? WHERE id = ?`).run(parsedAgentId, leadId);
    }

    rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
    rawDb.prepare(`
      INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
      VALUES (?, ?, 'lookup_claimed', ?, NULL, ?)
    `).run(leadId, parsedAgentId,
      phone ? `Claimed via who-called-me lookup — callback from ${phone}` : `Claimed via who-called-me lookup`,
      nowIso);

    broadcast({ type: "lead_updated", leadId });

    const full = storage.getLeadById(leadId);
    res.json({ claimed: true, lead: full });
  });

  // ─── RECYCLE LEAD ──────────────────────────────────────────────────────────
  // v14.8 — PULL MODE: recycled leads return to the shared pool.
  // Next agent to tap Load Next Lead picks it up. No round-robin push.
  app.post("/api/leads/:id/recycle", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, notes } = req.body;
    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    storage.createLeadActivity({
      leadId,
      agentId: agentId || null,
      outcome: "recycled",
      notes: notes || "Lead recycled — returned to shared pool.",
      lpmamabSnapshot: null,
      createdAt: new Date().toISOString(),
    });

    storage.updateLead(leadId, {
      assignedAgentId: null,
      status: "unassigned",
      attemptCount: (lead.attemptCount || 0) + 1,
    });

    broadcast({ type: "lead_updated", leadId });
    res.json({ recycled: true, reassignedTo: null });
  });

  // ─── DUAL LEADERBOARD (Today + Weekly) — SQL aggregated (v11.70) ─────────
  app.get("/api/admin/leaderboard", (req, res) => {
    const now = new Date();

    // Today: midnight local (server) time
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();

    // Week: Monday 00:00 of current week
    const weekStart = new Date(now);
    const day = weekStart.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    weekStart.setDate(weekStart.getDate() + diff);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartISO = weekStart.toISOString();

    const allAgents = storage.getAllAgents().filter(a => a.isActive);

    // ── SQL: aggregate activity counts per agent per outcome for today + week + all-time ──
    const aggRows: any[] = rawDb.prepare(`
      SELECT agent_id,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week_total,
        COUNT(*) as all_total,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as today_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as week_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as all_appts,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as today_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as week_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as all_kit,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as today_emails,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as week_emails,
        SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as all_emails,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as today_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as week_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as all_no_answer,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as today_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as week_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as all_not_int,
        MAX(created_at) as last_activity_at
      FROM lead_activity
      WHERE agent_id IS NOT NULL
      GROUP BY agent_id
    `).all(
      todayStartISO, weekStartISO,
      todayStartISO, weekStartISO,
      todayStartISO, weekStartISO,
      todayStartISO, weekStartISO,
      todayStartISO, weekStartISO,
      todayStartISO, weekStartISO
    );
    const aggMap: Record<number, any> = {};
    for (const r of aggRows) aggMap[r.agent_id] = r;

    // ── SQL: network referrals (leads with JSON source=network) per uploader ──
    const weekRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND json_extract(extra_data, '$.source') = 'network'
        AND uploaded_at >= ?
      GROUP BY uploaded_by
    `).all(weekStartISO);
    const weekReferralsMap: Record<number, number> = {};
    for (const r of weekRefRows) weekReferralsMap[r.uploaded_by] = r.cnt;

    const todayRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND json_extract(extra_data, '$.source') = 'network'
        AND uploaded_at >= ?
      GROUP BY uploaded_by
    `).all(todayStartISO);
    const todayReferralsMap: Record<number, number> = {};
    for (const r of todayRefRows) todayReferralsMap[r.uploaded_by] = r.cnt;

    // All-time referrals (no date filter)
    const allRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND json_extract(extra_data, '$.source') = 'network'
      GROUP BY uploaded_by
    `).all();
    const allReferralsMap: Record<number, number> = {};
    for (const r of allRefRows) allReferralsMap[r.uploaded_by] = r.cnt;

    const buildStats = (agg: any, period: "today" | "week" | "all", agentId: number) => {
      if (!agg) return { dials: 0, appts: 0, kit: 0, emails: 0, noAnswer: 0, convRate: 0, referrals: 0 };
      const p = period === "today" ? "today" : period === "week" ? "week" : "all";
      const appts    = agg[`${p}_appts`]    || 0;
      const kit      = agg[`${p}_kit`]      || 0;
      const emails   = agg[`${p}_emails`]   || 0;
      const noAnswer = agg[`${p}_no_answer`] || 0;
      const notInt   = agg[`${p}_not_int`]  || 0;
      const total    = agg[`${p}_total`]    || (p === "all" ? (agg.all_total || 0) : 0);
      const dials    = total - emails;
      const convRate = dials > 0 ? Math.round(((appts + notInt + kit) / dials) * 100) : 0;
      const referrals = period === "today" ? (todayReferralsMap[agentId] || 0)
        : period === "all" ? (allReferralsMap[agentId] || 0)
        : (weekReferralsMap[agentId] || 0);
      return { dials, appts, kit, emails, noAnswer, convRate, referrals };
    };

    const result = allAgents.map(agent => {
      const agg = aggMap[agent.id] || null;
      return {
        agent: { id: agent.id, name: agent.name, email: agent.email, headshotUrl: (agent as any).headshotUrl || null },
        lastActivityAt: agg?.last_activity_at || null,
        today:   buildStats(agg, "today", agent.id),
        weekly:  buildStats(agg, "week",  agent.id),
        allTime: buildStats(agg, "all",   agent.id),
      };
    });

    // ─── Points from agent_points table ───────────────────────────────────────
    // v12.5 — scoped points: this endpoint powers the SELLER admin dashboard, so
    // it always reads seller-scoped points. (Recruiting uses /api/admin/recruiting/leaderboard.)
    const scope = "seller";
    const resetKey2 = "leaderboard_reset_at";
    const resetRow2 = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(resetKey2) as any;
    const resetAt2: string | null = resetRow2?.value || null;
    const ptsSql = `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = ? ${resetAt2 ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
    const ptsParams = resetAt2 ? [scope, resetAt2] : [scope];
    const allPtsRows = rawDb.prepare(ptsSql).all(...ptsParams) as any[];
    const ptsMap: Record<number, number> = {};
    for (const r of allPtsRows) ptsMap[r.agent_id] = r.total || 0;
    for (const r of result) (r as any).points = ptsMap[(r.agent as any).id] || 0;

    result.sort((a, b) => b.weekly.appts - a.weekly.appts || b.weekly.dials - a.weekly.dials);
    res.json(result);
  });

  // ─── LEADERBOARD RESET (v11.57: snapshots scores before wiping) ──────────
  // v12.5 — accepts ?scope=seller|recruiting so each depot's leaderboard resets independently.
  app.post("/api/admin/leaderboard-reset", (req: any, res: any) => {
    const now = new Date().toISOString();
    const scope = (String(req.query.scope || "seller") === "recruiting") ? "recruiting" : "seller";
    const resetKey = scope === "recruiting" ? "leaderboard_reset_at_recruiting" : "leaderboard_reset_at";

    // 1. Capture current scores before reset
    const prevResetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(resetKey) as any;
    const prevResetAt: string | null = prevResetRow?.value || null;

    const allAgents = storage.getAllAgents();
    const ptsSql = `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = ? ${prevResetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
    const ptsParams = prevResetAt ? [scope, prevResetAt] : [scope];
    const ptsRows = rawDb.prepare(ptsSql).all(...ptsParams) as any[];
    const ptsMap: Record<number, number> = {};
    for (const r of ptsRows) ptsMap[r.agent_id] = r.total || 0;

    const snapshot = allAgents
      .filter(a => a.isActive)
      .map(a => ({ id: a.id, name: a.name, points: ptsMap[a.id] || 0 }))
      .sort((a, b) => b.points - a.points);

    // 2. Build a human-readable period label (e.g. "Jun 1 – Jul 3, 2026")
    const startDate = prevResetAt ? new Date(prevResetAt) : null;
    const endDate = new Date(now);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const periodLabel = startDate
      ? `${fmt(startDate)} – ${fmt(endDate)} (${scope})`
      : `Through ${fmt(endDate)} (${scope})`;

    // 3. Save snapshot
    rawDb.prepare(
      `INSERT INTO leaderboard_snapshots (period_label, reset_at, snapshot_json, created_at) VALUES (?, ?, ?, ?)`
    ).run(periodLabel, now, JSON.stringify(snapshot), now);

    // 4. Update the reset timestamp for this scope (starts new period)
    rawDb.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(resetKey, now);

    res.json({ ok: true, resetAt: now, periodLabel, snapshot, scope });
  });

  app.get("/api/admin/leaderboard-reset", (req, res) => {
    const scope = (String(req.query.scope || "seller") === "recruiting") ? "recruiting" : "seller";
    const resetKey = scope === "recruiting" ? "leaderboard_reset_at_recruiting" : "leaderboard_reset_at";
    const row = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(resetKey) as any;
    res.json({ resetAt: row?.value || null, scope });
  });

  // ─── LEADERBOARD HISTORY (v11.57) ─────────────────────────────────────────
  app.get("/api/admin/leaderboard-history", (_req, res) => {
    const rows = rawDb.prepare(
      `SELECT id, period_label, reset_at, snapshot_json, created_at FROM leaderboard_snapshots ORDER BY created_at DESC LIMIT 24`
    ).all() as any[];
    const history = rows.map(r => ({
      id: r.id,
      periodLabel: r.period_label,
      resetAt: r.reset_at,
      createdAt: r.created_at,
      snapshot: JSON.parse(r.snapshot_json || "[]"),
    }));
    res.json(history);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TERRITORY MANAGEMENT (v12.5) — admin can close/open territories.
  // Closing a territory hard-deletes its unassigned + assigned leads (activity
  // history stays for the leaderboard). Any agent with that territory in slot 1
  // or 2 has that slot cleared and gets a reselect notice.
  // ═══════════════════════════════════════════════════════════════════════════
  app.get("/api/territories", (_req, res) => {
    // Pull display names from the source module so the UI can render them cleanly.
    const TER_META = TERRITORY_META as Record<string, { displayName: string }>;
    const rows = rawDb.prepare(`SELECT name, is_open FROM territories ORDER BY name`).all() as any[];
    // Map by display name (that's what's stored in territories.name via the seed).
    const withCounts = rows.map(t => {
      const leadCount = (rawDb.prepare(
        `SELECT COUNT(*) as c FROM leads WHERE territory = ? AND status NOT IN ('retired','contacted_appointment')`
      ).get(t.name) as any)?.c || 0;
      // Reverse-map display name → key for the frontend
      const key = Object.entries(TER_META).find(([, v]) => v.displayName === t.name)?.[0] || t.name;
      return { key, name: t.name, isOpen: !!t.is_open, leadCount };
    });
    res.json(withCounts);
  });

  app.post("/api/admin/territories/:name/close", (req: any, res) => {
    const name = req.params.name;
    const row = rawDb.prepare(`SELECT id, is_open FROM territories WHERE name = ?`).get(name) as any;
    if (!row) return res.status(404).json({ error: "Territory not found" });

    // 1. Delete leads in this territory (activity history preserved for leaderboard).
    // Match by both the stored territory key AND the display name for safety.
    const TER_META = TERRITORY_META as Record<string, { displayName: string }>;
    const key = Object.entries(TER_META).find(([, v]) => v.displayName === name)?.[0];
    const territoryValues = key ? [name, key] : [name];
    const placeholders = territoryValues.map(() => "?").join(",");
    const del = rawDb.prepare(`DELETE FROM leads WHERE territory IN (${placeholders})`).run(...territoryValues);

    // 2. Clear this territory from any agent's slot 1 or slot 2. Flag them.
    // Match by both key and display name in case older records used either format.
    const affectedAgents = rawDb.prepare(`
      SELECT id, name, email, territory1, territory2 FROM agents
      WHERE territory1 IN (${placeholders}) OR territory2 IN (${placeholders})
    `).all(...territoryValues, ...territoryValues) as any[];
    for (const a of affectedAgents) {
      const clearSlot1 = territoryValues.includes(a.territory1);
      const clearSlot2 = territoryValues.includes(a.territory2);
      rawDb.prepare(`
        UPDATE agents
        SET territory1 = CASE WHEN ? THEN NULL ELSE territory1 END,
            territory2 = CASE WHEN ? THEN NULL ELSE territory2 END,
            territory_closed_notice = 1
        WHERE id = ?
      `).run(clearSlot1 ? 1 : 0, clearSlot2 ? 1 : 0, a.id);
    }

    // 3. Flip the flag.
    rawDb.prepare(`UPDATE territories SET is_open = 0 WHERE id = ?`).run(row.id);

    res.json({
      ok: true,
      territory: name,
      leadsDeleted: del.changes,
      agentsNotified: affectedAgents.length,
    });
  });

  app.post("/api/admin/territories/:name/open", (req: any, res) => {
    const name = req.params.name;
    const row = rawDb.prepare(`SELECT id FROM territories WHERE name = ?`).get(name) as any;
    if (!row) return res.status(404).json({ error: "Territory not found" });
    rawDb.prepare(`UPDATE territories SET is_open = 1 WHERE id = ?`).run(row.id);
    res.json({ ok: true, territory: name });
  });

  // Agent's territory-closed-notice: read + dismiss
  app.get("/api/agents/:id/territory-notice", (req: any, res) => {
    const id = parseInt(req.params.id);
    const a = rawDb.prepare(`SELECT territory_closed_notice, territory1, territory2 FROM agents WHERE id = ?`).get(id) as any;
    if (!a) return res.status(404).json({ error: "Agent not found" });
    res.json({
      notice: !!a.territory_closed_notice,
      territory1: a.territory1 || null,
      territory2: a.territory2 || null,
    });
  });
  app.post("/api/agents/:id/territory-notice/clear", (req: any, res) => {
    const id = parseInt(req.params.id);
    rawDb.prepare(`UPDATE agents SET territory_closed_notice = 0 WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HARD RESET (v12.5) — nukes one depot back to zero. Auto-refill resumes on
  // next scheduled cron. Requires typed confirmation to prevent misfires.
  // ═══════════════════════════════════════════════════════════════════════════
  app.post("/api/admin/seller-hard-reset", (req: any, res) => {
    if (req.body?.confirm !== "RESET") {
      return res.status(400).json({ error: 'Must send { "confirm": "RESET" } in body' });
    }
    try {
      let leadCount = 0, lockCount = 0, activityCount = 0, pointCount = 0;
      const txn = rawDb.transaction(() => {
        // Delete in FK-safe order: locks -> activity -> leads.
        // v14.81.1: lead_locks has FK to leads, must go first or DELETE FROM leads throws.
        lockCount = (rawDb.prepare(`DELETE FROM lead_locks`).run().changes) || 0;
        activityCount = (rawDb.prepare(`DELETE FROM lead_activity`).run().changes) || 0;
        leadCount = (rawDb.prepare(`DELETE FROM leads`).run().changes) || 0;
        pointCount = (rawDb.prepare(`DELETE FROM agent_points WHERE scope = 'seller'`).run().changes) || 0;
        // Reset the seller leaderboard period marker.
        rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(new Date().toISOString());
      });
      txn();
      console.log(`[hard-reset] seller depot cleared: ${leadCount} leads, ${lockCount} locks, ${activityCount} activities, ${pointCount} points`);
      res.json({ ok: true, side: "seller", cleared: { leads: leadCount, locks: lockCount, activities: activityCount, points: pointCount } });
    } catch (err: any) {
      console.error("[hard-reset] seller failed:", err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post("/api/admin/recruiting-hard-reset", (req: any, res) => {
    if (req.body?.confirm !== "RESET") {
      return res.status(400).json({ error: 'Must send { "confirm": "RESET" } in body' });
    }
    try {
      let leadCount = 0, activityCount = 0, pointCount = 0;
      const txn = rawDb.transaction(() => {
        activityCount = (rawDb.prepare(`DELETE FROM agent_lead_activity`).run().changes) || 0;
        leadCount = (rawDb.prepare(`DELETE FROM agent_leads`).run().changes) || 0;
        pointCount = (rawDb.prepare(`DELETE FROM agent_points WHERE scope = 'recruiting'`).run().changes) || 0;
        rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at_recruiting', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(new Date().toISOString());
      });
      txn();
      console.log(`[hard-reset] recruiting depot cleared: ${leadCount} leads, ${activityCount} activities, ${pointCount} points`);
      res.json({ ok: true, side: "recruiting", cleared: { leads: leadCount, activities: activityCount, points: pointCount } });
    } catch (err: any) {
      console.error("[hard-reset] recruiting failed:", err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ─── AGENT-FACING LEADERBOARD (no admin-only data) ────────────────────────
  app.get("/api/agent/leaderboard", (req, res) => {
    const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    const resetAt: string | null = resetRow?.value || null;

    // v14.81.1 — Include admins in the agent-side leaderboard when they have
    // real activity this period. Prior version only surfaced admins with
    // receiveLeads=true, which meant Alex + Nate never appeared on Bronson's
    // view even though they dial. New rule: admins are included IF they have
    // any lead_activity or points logged since the last reset. Zero-activity
    // admins are still hidden so the board isn't cluttered.
    const activityFilter = resetAt ? `AND created_at > ?` : "";
    const activeAdminIdsRow = rawDb.prepare(`
      SELECT DISTINCT agent_id FROM (
        SELECT agent_id FROM lead_activity WHERE agent_id IS NOT NULL ${activityFilter}
        UNION
        SELECT agent_id FROM agent_points WHERE scope = 'seller' ${resetAt ? "AND created_at >= ?" : ""}
      )
    `).all(...(resetAt ? [resetAt, resetAt] : [])) as { agent_id: number }[];
    const activeAdminIds = new Set(activeAdminIdsRow.map(r => r.agent_id));

    const allAgents = storage.getAllAgents().filter(a =>
      a.isActive && (
        (a.role === "agent" && a.leadFlowOn !== false) ||
        (a.role === "admin" && (a.receiveLeads || activeAdminIds.has(a.id)))
      )
    );
    // SQL aggregation — avoids loading all leads/activities (v11.70)
    const agentStatsRows: any[] = rawDb.prepare(`
      SELECT agent_id,
        COUNT(*) as total_all,
        SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as emails_sent,
        SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
        SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
        SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kit,
        SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as not_int
      FROM lead_activity
      WHERE agent_id IS NOT NULL
        ${resetAt ? "AND created_at > ?" : ""}
      GROUP BY agent_id
    `).all(...(resetAt ? [resetAt] : []));
    const agentStatsMap: Record<number, any> = {};
    for (const r of agentStatsRows) agentStatsMap[r.agent_id] = r;

    // v14.29 — pull points from agent_points table for unified leaderboard sort
    const ptsSqlA = `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' ${resetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
    const ptsRowsA: any[] = rawDb.prepare(ptsSqlA).all(...(resetAt ? [resetAt] : []));
    const ptsMapA: Record<number, number> = {};
    for (const p of ptsRowsA) ptsMapA[p.agent_id] = p.total || 0;

    const stats = allAgents.map(agent => {
      const r = agentStatsMap[agent.id] || { total_all: 0, emails_sent: 0, appts: 0, no_answer: 0, kit: 0, not_int: 0 };
      const total = (r.total_all || 0) - (r.emails_sent || 0);
      const contacted = (r.appts || 0) + (r.not_int || 0);
      return {
        agent: {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          headshotUrl: (agent as any).headshotUrl || (agent as any).headshot_url || null,
        },
        appointmentsSet: r.appts || 0,
        totalAttempts: total,
        emailsSent: r.emails_sent || 0,
        contactRate: total > 0 ? Math.round((contacted / total) * 100) : 0,
        points: ptsMapA[agent.id] || 0,
        outcomes: {
          contacted_appointment: r.appts || 0,
          no_answer: r.no_answer || 0,
          keep_in_touch: r.kit || 0,
        },
      };
    });
    // v14.29 — Unified sort: Appts → Points → Dials (appts are the #1 goal)
    stats.sort((a, b) =>
      (b.appointmentsSet - a.appointmentsSet) ||
      (b.points - a.points) ||
      (b.totalAttempts - a.totalAttempts)
    );
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
      leadType: "network",
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
    // Activity feed + referral points (v11.40)
    const _refAgent = submitterAgentId ? storage.getAgentById(submitterAgentId) : null;
    broadcast({ type: "activity_event", event: { type: "network_lead_submitted", agentId: submitterAgentId, agentName: _refAgent?.name || submittedByName || "Agent", agentHeadshot: (_refAgent as any)?.headshotUrl || null, address: created.address, ts: new Date().toISOString() } });
    awardPoints(submitterAgentId, "network_referral", created.id);

    // ── Notify admins + CRM manager on network lead submission ────────────────
    if (resend) {
      const agentName = submittedByName || "An agent";
      const tdL = "padding:8px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:140px;vertical-align:top";
      const tdR = "padding:8px 0;font-size:14px;color:#f0f0f0;vertical-align:top";
      resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to:   ["denise@watsonbrothersgroup.com"],
        cc:   ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
        subject: `\uD83E\uDD1D Network Lead Submitted \u2014 ${ownerName} | ${address || "No address"}`,
        html: `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:580px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid #2a2520">
  <div style="background:linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%);padding:22px 28px">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5a3e00;font-weight:700">Network Lead \u2014 Lead Depot</p>
    <h1 style="margin:0;font-size:20px;color:#080808;font-weight:700">\uD83E\uDD1D ${agentName} submitted a referral</h1>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="${tdL}">Client Name</td><td style="${tdR}">${ownerName}</td></tr>
      <tr><td style="${tdL}">Phone</td><td style="${tdR}">${phone}</td></tr>
      <tr><td style="${tdL}">Email</td><td style="${tdR}">${email || "\u2014"}</td></tr>
      <tr><td style="${tdL}">Address</td><td style="${tdR}">${address || "\u2014"}</td></tr>
      <tr><td style="${tdL}">Referred By</td><td style="${tdR}">${agentName}</td></tr>
      <tr><td style="${tdL}">Notes</td><td style="${tdR}">${notes || "\u2014"}</td></tr>
      <tr><td style="${tdL}">Assigned To</td><td style="${tdR}">${agentName} (auto-assigned)</td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:12px;color:#555">This lead is now live in Lead Depot assigned to ${agentName}.</p>
  </div>
  <div style="padding:12px 28px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">
    Lead Depot v14.81.1 \u2014 Brothers Group \u00b7 Momentum Realty
  </div>
</div></body></html>`,
      }).catch(err => console.error("[network lead] Notify failed:", err));
    }

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
    const allLeads = rawDb.prepare(`SELECT * FROM leads ORDER BY uploaded_at DESC`).all() as any[];
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

  // ─── CONNECTIVITY HEALTH CHECK (v11.40) ────────────────────────────────────
  // GET /api/health — checks all external service connections
  // Returns 200 if all critical services are up, 207 if some are degraded
  // ─── ACTIVITY AUDIT TRAIL CSV EXPORT (v12.0) ──────────────────────────────
  app.get("/api/export/activity", (req, res) => {
    const escape = (val: any) => {
      if (val == null) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) return '"' + str.replace(/"/g, '""') + '"';
      return str;
    };

    // Seller lead activity (lead_activity has no points_awarded column — use 0)
    const sellerActivity: any[] = rawDb.prepare(`
      SELECT la.id, 'seller' as type, la.created_at, a.name as agent_name,
             l.owner_name as client_name, l.phone, l.address, la.outcome, la.notes, 0 as points_awarded
      FROM lead_activity la
      LEFT JOIN agents a ON a.id = la.agent_id
      LEFT JOIN leads l ON l.id = la.lead_id
      ORDER BY la.created_at DESC
      LIMIT 10000
    `).all();

    // Recruiting activity
    const recruitActivity: any[] = rawDb.prepare(`
      SELECT ala.id, 'recruiting' as type, ala.created_at, a.name as agent_name,
             (al.first_name || ' ' || al.last_name) as client_name, al.phone,
             al.matched_territory as territory, ala.outcome, ala.notes, ala.points_awarded
      FROM agent_lead_activity ala
      LEFT JOIN agents a ON a.id = ala.caller_id
      LEFT JOIN agent_leads al ON al.id = ala.agent_lead_id
      ORDER BY ala.created_at DESC
      LIMIT 10000
    `).all();

    const allActivity = [...sellerActivity, ...recruitActivity]
      .sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));

    const headers = ["ID", "Type", "Date", "Agent", "Client", "Phone", "Address/Territory", "Outcome", "Notes", "Points"];
    const rows = allActivity.map((r: any) => [
      r.id, r.type, r.created_at, r.agent_name, r.client_name,
      r.phone, r.address || r.territory, r.outcome, r.notes, r.points_awarded,
    ].map(escape).join(","));

    const csv = [headers.join(","), ...rows].join("\n");
    const filename = `lead-depot-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  });

  // ─── WEEKLY DIALS SNAPSHOT (v14.0) ─────────────────────────────────────────
  // Replaces the old "Agent Inactivity Alert" (which shamed agents for missing
  // a weekly dial goal). Now returns every active seller-side agent with their
  // dial count for the current week — informational only, no goals, no misses.
  app.get("/api/admin/agent-inactivity", (_req: any, res) => {
    // v14.48 — Flow is the only gate. Admins included if Flow is on.
    const activeAgents = rawDb.prepare(
      `SELECT id, name, email, headshot_url FROM agents WHERE lead_flow_on = 1`
    ).all() as any[];

    const thisWeekStart = new Date();
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    thisWeekStart.setHours(0, 0, 0, 0);
    const isoStart = thisWeekStart.toISOString();

    const rows = activeAgents.map((a: any) => {
      const c = (rawDb.prepare(
        `SELECT COUNT(*) as c FROM agent_points WHERE agent_id = ? AND reason = 'dial' AND scope = 'seller' AND created_at >= ?`
      ).get(a.id, isoStart) as any)?.c ?? 0;
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        headshotUrl: a.headshot_url || null,
        thisWeekDials: c,
      };
    }).sort((a: any, b: any) => b.thisWeekDials - a.thisWeekDials);

    res.json({ agents: rows, weekStart: isoStart });
  });

  app.get("/api/health", async (req, res) => {
    const results: Record<string, { ok: boolean; latencyMs?: number; detail?: string }> = {};

    // 1. SQLite DB
    try {
      const start = Date.now();
      rawDb.prepare("SELECT 1").get();
      results.database = { ok: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      results.database = { ok: false, detail: e.message };
    }

    // 2. Resend (email)
    results.resend = {
      ok: !!process.env.RESEND_API_KEY,
      detail: process.env.RESEND_API_KEY ? "API key present" : "RESEND_API_KEY not set",
    };

    // 3. Follow Up Boss API
    const fubKey = process.env.FUB_API_KEY;
    if (fubKey) {
      try {
        const start = Date.now();
        const fubRes = await fetch("https://api.followupboss.com/v1/users?limit=1", {
          headers: { Authorization: "Basic " + Buffer.from(fubKey + ":").toString("base64") },
          signal: AbortSignal.timeout(5000),
        });
        results.follow_up_boss = {
          ok: fubRes.ok,
          latencyMs: Date.now() - start,
          detail: fubRes.ok ? "Connected" : `HTTP ${fubRes.status}`,
        };
      } catch (e: any) {
        results.follow_up_boss = { ok: false, detail: e.message };
      }
    } else {
      results.follow_up_boss = { ok: false, detail: "FUB_API_KEY not set" };
    }

    // 4. Railway deployment URL reachable
    try {
      const appUrl = process.env.APP_URL || "https://depot.watsonbrothersgroup.com";
      const start = Date.now();
      const r = await fetch(`${appUrl}/api/ping`, { signal: AbortSignal.timeout(4000) });
      results.app_url = { ok: r.ok, latencyMs: Date.now() - start, detail: appUrl };
    } catch (e: any) {
      results.app_url = { ok: false, detail: e.message };
    }

    // v14.58 — BatchLeads probe removed. The BatchLeads auto-pipeline was killed
    // permanently in v14.46; the vendor's live API was still being probed here and
    // was returning HTTP 500 for hours at a time, which dragged /api/health to 207
    // "degraded" and turned every browser-matrix row red on phase 6. There is no
    // production dependency on BatchLeads anymore — CSV import is the sole intake.

    // 5. WebSocket server
    results.websocket = {
      ok: true,
      detail: "WS server active (broadcast available)",
    };

    const allOk = Object.values(results).every(r => r.ok);
    const criticalOk = results.database.ok && results.resend.ok;

    // Fire-and-forget queue depth alert check
    checkQueueDepthAlert(rawDb).catch(() => {});

    res.status(allOk ? 200 : criticalOk ? 207 : 503).json({
      status: allOk ? "healthy" : criticalOk ? "degraded" : "critical",
      timestamp: new Date().toISOString(),
      version: "v14.81.1",
      services: results,
    });
  });

  // Simple ping for uptime checks
  app.get("/api/ping", (_req, res) => res.json({ pong: true, ts: Date.now() }));

  // v14.81.1.1 — Crash reason surface for out-of-band diagnostics when Railway
  // logs aren't reachable. Returns whatever the process-level handlers in
  // server/index.ts captured before the current instance booted.
  app.get("/api/boot-info", (_req, res) => {
    res.json({
      lastFatal: (globalThis as any).__lastFatal || null,
      bootTime: (globalThis as any).__bootTime || null,
      nodeVersion: process.version,
      pid: process.pid,
      uptime: process.uptime(),
    });
  });



  // ─── PUBLIC: Agent recruiting form submission ────────────────────────────────
  // Unauthenticated — served at /api/agent-leads/public from join.watsonbrothersgroup.com
  // Honeypot field: if "website" field is populated, it's a bot — silently discard
  app.post("/api/agent-leads/public", async (req: any, res: any) => {
    // Honeypot check
    if (req.body?.website) return res.json({ ok: true }); // silently accept bots

    const {
      firstName, lastName, email, phone,
      licenseStatus, licenseNumber, licenseState, yearsExperience,
      currentBrokerage, reasonForLeaving,
      gciRange, transactionsLast12mo,
      territory, referralSource, referredByName,
      applicantNotes,
    } = req.body || {};

    if (!firstName || !lastName || !licenseStatus) {
      return res.status(400).json({ error: "First name, last name, and license status are required." });
    }

    // Territory matching — map free text to one of the 7 official territories
    const TERRITORY_MAP: Record<string, string> = {
      "north jax": "North Jax & Nassau",
      "nassau": "North Jax & Nassau",
      "nassau county": "North Jax & Nassau",
      "fernandina": "North Jax & Nassau",
      "jacksonville west": "Jacksonville West",
      "west jacksonville": "Jacksonville West",
      "jacksonville east": "Jacksonville East",
      "east jacksonville": "Jacksonville East",
      "beaches": "Intracoastal/Beaches",
      "intracoastal": "Intracoastal/Beaches",
      "atlantic beach": "Intracoastal/Beaches",
      "neptune beach": "Intracoastal/Beaches",
      "jacksonville beach": "Intracoastal/Beaches",
      "ponte vedra": "Ponte Vedra/Nocatee/St. Aug",
      "nocatee": "Ponte Vedra/Nocatee/St. Aug",
      "st augustine": "Ponte Vedra/Nocatee/St. Aug",
      "st. augustine": "Ponte Vedra/Nocatee/St. Aug",
      "st johns": "St. Johns County",
      "st. johns": "St. Johns County",
    };
    let matchedTerritory: string | undefined;
    if (territory) {
      const lower = territory.toLowerCase();
      for (const [key, val] of Object.entries(TERRITORY_MAP)) {
        if (lower.includes(key)) { matchedTerritory = val; break; }
      }
    }

    const now = new Date().toISOString();

    // Insert into agent_leads
    const stmt = rawDb.prepare(`
      INSERT INTO agent_leads
        (first_name, last_name, email, phone,
         license_status, license_number, license_state, years_experience,
         current_brokerage, reason_for_leaving,
         gci_range, transactions_last_12mo,
         territory, matched_territory,
         referral_source, referred_by_name, applicant_notes,
         status, source, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new','recruiting_page',?)
    `);
    const result = stmt.run(
      (firstName || "").trim(), (lastName || "").trim(),
      email || null, phone || null,
      licenseStatus || "active", licenseNumber || null, licenseState || null, yearsExperience || null,
      currentBrokerage || null, reasonForLeaving || null,
      gciRange || null, transactionsLast12mo ? Number(transactionsLast12mo) : null,
      territory || null, matchedTerritory || null,
      referralSource || null, referredByName || null, applicantNotes || null,
      now
    );
    const agentLeadId = result.lastInsertRowid;

    // Push to FUB async (don't block the response)
    fubCreateAgentRecruit({
      firstName: (firstName || "").trim(),
      lastName: (lastName || "").trim(),
      email: email || undefined,
      phone: phone || undefined,
      licenseStatus,
      licenseState: licenseState || undefined,
      yearsExperience: yearsExperience || undefined,
      currentBrokerage: currentBrokerage || undefined,
      reasonForLeaving: reasonForLeaving || undefined,
      gciRange: gciRange || undefined,
      transactionsLast12mo: transactionsLast12mo ? Number(transactionsLast12mo) : undefined,
      territory: territory || undefined,
      matchedTerritory: matchedTerritory || undefined,
      referralSource: referralSource || undefined,
      referredByName: referredByName || undefined,
      applicantNotes: applicantNotes || undefined,
      submittedAt: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    }).then(personId => {
      if (personId) {
        rawDb.prepare("UPDATE agent_leads SET fub_person_id = ?, fub_synced_at = ? WHERE id = ?")
          .run(personId, new Date().toISOString(), agentLeadId);
      }
    }).catch(err => console.error("[FUB] Agent recruit push error:", err));

    console.log(`[Agent Leads] New submission: ${firstName} ${lastName} (${email}) — id ${agentLeadId}`);
    res.json({ ok: true, id: agentLeadId });
  });

  // ── Recruiting landing page — must be registered in registerRoutes so it fires
  // before the static middleware SPA fallback in serveStatic()
  app.get("/join", (_req, res) => {
    const distPath = path.resolve(__dirname, "public");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "join.html"));
  });

  // ── Fast Track playbook — subpage of /join, hand-crafted HTML
  app.get("/join/fast-track", (_req, res) => {
    const distPath = path.resolve(__dirname, "public");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "join-fast-track.html"));
  });

  // ── Agent Prospecting Mode setting ──────────────────────────────────────────────────────────
  app.get("/api/settings/agent-prospecting-mode", (req, res) => {
    const row = rawDb.prepare(`SELECT value FROM app_settings WHERE key = 'agent_prospecting_mode'`).get() as any;
    res.json({ enabled: row?.value === 'true' });
  });

  app.post("/api/settings/agent-prospecting-mode", (req: any, res) => {
    const { enabled } = req.body;
    rawDb.prepare(`INSERT INTO app_settings (key, value) VALUES ('agent_prospecting_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(enabled ? 'true' : 'false');
    // Broadcast to all connected WebSocket clients
    broadcast({ type: 'prospecting_mode_changed', enabled: !!enabled });
    res.json({ ok: true, enabled: !!enabled });
  });

  // ── Agent recruiting lead queue ───────────────────────────────────────────────────────
  app.get("/api/agent-leads/my-next", (req: any, res) => {
    // Round-robin pull: oldest-by-attempt-count first within each priority tier
    // Excluded: joined, not_interested, do_not_contact, not_now, just_signed (frozen)
    // Callbacks surface only when their date has arrived
    const now = new Date().toISOString().slice(0, 10); // date only for callback comparison
    // Thaw any not_now/just_signed whose reactivate_at has passed
    rawDb.prepare(`
      UPDATE agent_leads
      SET status = 'new', reactivate_at = NULL, callback_date = NULL
      WHERE status IN ('not_now', 'just_signed')
        AND reactivate_at IS NOT NULL
        AND date(reactivate_at) <= date('now')
    `).run();
    const lead = rawDb.prepare(`
      SELECT * FROM agent_leads
      WHERE status NOT IN ('joined', 'not_interested', 'do_not_contact', 'not_now', 'just_signed')
        AND (
          status IN ('new', 'contacted', 'hot_prospect', 'appointment')
          OR (status = 'callback_requested' AND callback_date IS NOT NULL AND callback_date <= ?)
        )
      ORDER BY
        CASE
          WHEN status = 'appointment' THEN 0
          WHEN status = 'hot_prospect' THEN 1
          WHEN status = 'callback_requested' THEN 2
          ELSE 3
        END,
        attempt_count ASC,
        submitted_at ASC
      LIMIT 1
    `).get(now) as any;
    if (!lead) return res.status(204).send();
    res.json(lead);
  });

  app.get("/api/agent-leads/count", (req: any, res) => {
    // Active queue: excludes frozen (not_now, just_signed), permanent exits, and do_not_contact
    const row = rawDb.prepare(`SELECT COUNT(*) as count FROM agent_leads WHERE status NOT IN ('joined','not_interested','do_not_contact','not_now','just_signed')`).get() as any;
    res.json({ count: row?.count ?? 0 });
  });

  app.post("/api/agent-leads/:id/outcome", async (req: any, res) => {
    const { id } = req.params;
    const { outcome, notes, callbackDate, callerId } = req.body;

    // Full outcome whitelist including new statuses
    const VALID_RECRUIT_OUTCOMES = [
      'dial_no_answer',    // 1pt — no answer, stays in queue
      'keep_in_touch',     // 3pt — connected, not ready, stays in rotation
      'hot_prospect',      // 15pt — very interested, priority
      'appointment',       // 15pt — meeting booked
      'callback_requested',// 1pt — specific callback date
      'not_now',           // 1pt — open but bad timing, frozen 90 days
      'just_signed',       // 1pt — recently joined another brokerage, frozen 6 months
      'joined_team',       // 50pt — they joined Watson Brothers
      'not_interested',    // 1pt — not interested (stays in DB, removed from queue)
      'do_not_contact',    // 0pt — DNC, permanent exit, blocks DBPR re-import
    ];
    if (!outcome || !VALID_RECRUIT_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `Invalid outcome. Must be one of: ${VALID_RECRUIT_OUTCOMES.join(', ')}` });
    }

    const pts: Record<string, number> = {
      keep_in_touch: 3, hot_prospect: 15, appointment: 15,
      joined_team: 50, do_not_contact: 0,
    };
    const points = pts[outcome] ?? 1;

    // Calculate reactivate_at for frozen statuses
    const now = new Date();
    let reactivateAt: string | null = null;
    if (outcome === 'not_now') {
      const d = new Date(now); d.setDate(d.getDate() + 90);
      reactivateAt = d.toISOString().slice(0, 10);
    } else if (outcome === 'just_signed') {
      const d = new Date(now); d.setMonth(d.getMonth() + 6);
      reactivateAt = d.toISOString().slice(0, 10);
    }

    const statusMap: Record<string, string> = {
      dial_no_answer:     'contacted',
      keep_in_touch:      'contacted',
      hot_prospect:       'hot_prospect',
      appointment:        'appointment',
      callback_requested: 'callback_requested',
      not_now:            'not_now',
      just_signed:        'just_signed',
      joined_team:        'joined',
      not_interested:     'not_interested',
      do_not_contact:     'do_not_contact',
    };
    const newStatus = statusMap[outcome] || 'contacted';
    const newCallbackDate = outcome === 'callback_requested' ? (callbackDate || null) : null;

    rawDb.prepare(`
      UPDATE agent_leads
      SET status = ?, attempt_count = attempt_count + 1,
          callback_date = ?, reactivate_at = ?
      WHERE id = ?
    `).run(newStatus, newCallbackDate, reactivateAt, id);

    rawDb.prepare(`INSERT INTO agent_lead_activity (agent_lead_id, caller_id, outcome, notes, points_awarded, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, callerId || null, outcome, notes || null, points, new Date().toISOString());

    if (callerId && points > 0) {
      // v12.5 — recruiting-scoped so it lands on the recruiting leaderboard only.
      rawDb.prepare(`INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, 'recruiting', ?)`)
        .run(callerId, points, `recruit_${outcome}`, id, new Date().toISOString());
    }

    // ── Appointment Alert — fire instantly when a recruiting appointment is set
    if (outcome === "appointment") {
      const agentLead = rawDb.prepare(`SELECT * FROM agent_leads WHERE id = ?`).get(id) as any;
      const callerAgent = callerId ? rawDb.prepare(`SELECT name FROM agents WHERE id = ?`).get(callerId) as any : null;
      sendAppointmentAlert({
        type:        "recruiting",
        agentName:   callerAgent?.name || "Unknown Agent",
        clientName:  agentLead ? `${agentLead.first_name} ${agentLead.last_name}` : "Unknown",
        clientPhone: agentLead?.phone || undefined,
        brokerage:   agentLead?.current_brokerage || undefined,
        territory:   agentLead?.territory || agentLead?.matched_territory || undefined,
        notes:       notes || undefined,
      }).catch(err => console.error("Recruiting appointment alert failed:", err));
    }

    // ── joined_team: auto-create agent account if none exists for this email ──
    if (outcome === "joined_team") {
      const agentLead = rawDb.prepare(`SELECT * FROM agent_leads WHERE id = ?`).get(id) as any;
      if (agentLead && agentLead.email) {
        const existingAgent = rawDb.prepare(`SELECT id FROM agents WHERE email = ?`).get(agentLead.email.toLowerCase().trim());
        if (!existingAgent) {
          try {
            const tempPass = require("crypto").randomBytes(12).toString("hex");
            const setupToken = require("crypto").randomBytes(32).toString("hex");
            const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
            const agentName = `${agentLead.first_name} ${agentLead.last_name}`.trim();
            const cleanEmail = agentLead.email.toLowerCase().trim();
            // Get next round-robin order
            const maxOrder = (rawDb.prepare(`SELECT MAX(round_robin_order) as m FROM agents`).get() as any)?.m ?? 0;
            const initialTerritory = agentLead.matched_territory || agentLead.territory || null;
            // v12.5 — write to BOTH legacy territory + new territory1 for compat during rollback window.
            rawDb.prepare(`
              INSERT INTO agents (name, email, password, role, round_robin_order, is_active, receive_leads, lead_flow_on, receive_website_leads, can_recruit, min_dials_per_week, phone, territory, territory1, setup_token, setup_expires, onboarded)
              VALUES (?, ?, ?, 'agent', ?, 1, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, 0)
            `).run(agentName, cleanEmail, tempPass, maxOrder + 1, agentLead.phone || null, initialTerritory, initialTerritory, setupToken, setupExpires);

            const newAgentRow = rawDb.prepare(`SELECT id FROM agents WHERE email = ?`).get(cleanEmail) as any;
            const appBase = process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
            const setupLink = `${appBase}/#/setup/${setupToken}`;

            // Send onboarding email
            if (resend) {
              resend.emails.send({
                from: "Lead Depot <noreply@watsonbrothersgroup.com>",
                to: cleanEmail,
                subject: "Welcome to the team — Set up your Lead Depot account",
                html: `
                  <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:40px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
                    <div style="text-align:center;margin-bottom:32px;">
                      <svg width="44" height="44" viewBox="0 0 36 36" fill="none" style="margin-bottom:12px;">
                        <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" stroke-width="1.6"/>
                        <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" stroke-width="1.6" stroke-linejoin="round" fill="none"/>
                        <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" stroke-width="1.4"/>
                      </svg>
                      <p style="color:#c8aa5a;letter-spacing:0.18em;font-size:11px;text-transform:uppercase;margin:0;">Brothers Group · Momentum Realty</p>
                    </div>
                    <h1 style="color:#fff;font-weight:300;font-size:28px;margin:0 0 8px;">Welcome to the team, ${agentName}.</h1>
                    <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.7;margin:0 0 32px;">Your Lead Depot account has been created. Complete your setup below — upload your headshot and set a secure password to activate your account and start receiving leads.</p>
                    <div style="text-align:center;margin-bottom:32px;">
                      <a href="${setupLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#c8aa5a,#a8893a);color:#080808;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;text-decoration:none;">Complete My Account Setup</a>
                    </div>
                    <p style="color:rgba(255,255,255,0.35);font-size:12px;line-height:1.6;border-top:1px solid rgba(200,170,90,0.15);padding-top:20px;">This link expires in 7 days. Lead Depot · Brothers Group at Momentum Realty · Fernandina Beach, FL</p>
                  </div>
                `,
              }).catch((err: any) => console.error("joined_team onboarding email failed:", err));
            }

            console.log(`[joined_team] Auto-created agent account for ${agentName} (${cleanEmail}), id=${newAgentRow?.id}`);
          } catch (err: any) {
            console.error("[joined_team] Auto-create agent failed:", err.message);
          }
        }
      }
    }

    res.json({ ok: true, points, status: newStatus, reactivateAt });
  });

  // ── Toggle canRecruit for an agent (admin only) ──────────────────────────────────
  app.patch("/api/agents/:id/can-recruit", (req: any, res) => {
    const agentId = parseInt(req.params.id);
    const { canRecruit } = req.body;
    if (typeof canRecruit !== 'boolean') return res.status(400).json({ error: 'canRecruit must be boolean' });
    rawDb.prepare(`UPDATE agents SET can_recruit = ? WHERE id = ?`).run(canRecruit ? 1 : 0, agentId);
    res.json({ ok: true });
  });

  // ── Set minDialsPerWeek performance gate for an agent (admin only) ────────────────────────────
  app.patch("/api/agents/:id/min-dials", (req: any, res) => {
    const agentId = parseInt(req.params.id);
    const { minDialsPerWeek } = req.body;
    const val = parseInt(minDialsPerWeek);
    if (isNaN(val) || val < 0) return res.status(400).json({ error: "minDialsPerWeek must be a non-negative integer" });
    rawDb.prepare(`UPDATE agents SET min_dials_per_week = ? WHERE id = ?`).run(val, agentId);
    res.json({ ok: true });
  });

  // ── Delete or DNC an agent lead (admin only) ─────────────────────────────────
  app.delete("/api/agent-leads/:id", (req: any, res) => {
    const { id } = req.params;
    rawDb.prepare(`DELETE FROM agent_lead_activity WHERE agent_lead_id = ?`).run(id);
    rawDb.prepare(`DELETE FROM agent_leads WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FUB WEBHOOK RECEIVER — Stage sync back to Lead Depot
  // Configure in FUB: Settings → Integrations → Webhooks
  //   URL: https://depot.watsonbrothersgroup.com/api/webhooks/fub
  //   Events: Person Stage Changed, Person Updated
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/api/webhooks/fub", (req: any, res) => {
    try {
      const payload = req.body;
      const eventType = payload?.event || payload?.type || "";
      const person = payload?.person || payload?.data?.person || {};

      console.log(`[FUB Webhook] Received: ${eventType} — person id=${person.id} name="${person.firstName} ${person.lastName}"`);

      // Only process stage change events
      if (!eventType.toLowerCase().includes("stage") && !eventType.toLowerCase().includes("person")) {
        return res.json({ ok: true, action: "ignored", reason: "unhandled event type" });
      }

      const fubPersonId = person.id;
      const newStageName = (person.stage?.name || person.stage || "").toLowerCase();
      const phone = person.phones?.[0]?.value?.replace(/\D/g, "") || "";

      if (!fubPersonId && !phone) {
        return res.json({ ok: true, action: "ignored", reason: "no identifiable person data" });
      }

      // Map FUB stage → Lead Depot status
      const stageToStatus: Record<string, string> = {
        "hot prospect":       "contacted_appointment",
        "appointment set":    "contacted_appointment",
        "active client":      "contacted_appointment",
        "nurture":            "keep_in_touch",
        "lead":               "assigned",
        "contact":            "assigned",
        "unresponsive":       "contacted_not_interested",
        "closed won":         "contacted_appointment",  // keep in pipeline
        "closed lost":        "contacted_not_interested",
      };

      const newStatus = stageToStatus[newStageName];
      if (!newStatus) {
        console.log(`[FUB Webhook] No Lead Depot mapping for stage "${newStageName}" — ignoring`);
        return res.json({ ok: true, action: "ignored", reason: `no mapping for stage: ${newStageName}` });
      }

      // Find lead in Lead Depot by phone number
      if (!phone) {
        console.log("[FUB Webhook] No phone on person — cannot match to lead");
        return res.json({ ok: true, action: "ignored", reason: "no phone to match" });
      }

      const lead = rawDb.prepare(
        `SELECT * FROM leads WHERE replace(replace(replace(phone, '-', ''), '(', ''), ')', '') LIKE ? LIMIT 1`
      ).get(`%${phone.slice(-10)}%`) as any;

      if (!lead) {
        console.log(`[FUB Webhook] No lead found for phone ${phone}`);
        return res.json({ ok: true, action: "ignored", reason: "lead not found" });
      }

      // Don't downgrade a won/appt lead from FUB noise
      const PROTECTED = ["contacted_appointment", "keep_in_touch", "wrong_number", "contacted_not_interested"];
      if (PROTECTED.includes(lead.status) && newStatus === "assigned") {
        console.log(`[FUB Webhook] Lead ${lead.id} already in terminal status "${lead.status}" — not downgrading`);
        return res.json({ ok: true, action: "protected", leadId: lead.id });
      }

      rawDb.prepare(`UPDATE leads SET status = ?, updated_at = ? WHERE id = ?`)
        .run(newStatus, new Date().toISOString(), lead.id);

      console.log(`[FUB Webhook] Updated lead ${lead.id} (${lead.owner_name}) status: "${lead.status}" → "${newStatus}" (FUB stage: ${newStageName})`);

      // Log activity note
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, created_at)
        VALUES (?, NULL, ?, ?, ?)
      `).run(
        lead.id,
        newStatus,
        `[FUB Sync] Stage changed to "${person.stage?.name || newStageName}" in Follow Up Boss`,
        new Date().toISOString()
      );

      res.json({ ok: true, action: "updated", leadId: lead.id, newStatus });

    } catch (err: any) {
      console.error("[FUB Webhook] Error:", err);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STALE LEAD AUDIT — identifies leads untouched for 7+ days
  // Called by weekly cron every Monday 9am EDT
  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/admin/missed-appointments — returns stale 'appointment' recruiting leads (> 48h no activity)
  app.get("/api/admin/missed-appointments", (req: any, res) => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const stale = rawDb.prepare(`
      SELECT al.id, al.first_name, al.last_name, al.phone,
             al.matched_territory, al.status,
             MAX(ala.created_at) as last_activity_at,
             a.name as last_caller
      FROM agent_leads al
      LEFT JOIN agent_lead_activity ala ON ala.agent_lead_id = al.id
      LEFT JOIN agents a ON a.id = ala.caller_id
      WHERE al.status = 'appointment'
      GROUP BY al.id
      HAVING last_activity_at < ? OR last_activity_at IS NULL
      ORDER BY last_activity_at ASC
      LIMIT 20
    `).all(fortyEightHoursAgo);
    res.json({ stale, count: stale.length });
  });

  // POST /api/admin/missed-appointments — manually trigger the missed-appt email
  app.post("/api/admin/missed-appointments", async (req: any, res) => {
    try {
      await checkMissedAppointments();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/stale-lead-audit", (req: any, res) => {
    try {
      const cutoffDays = parseInt(req.body?.cutoffDays || "7");
      const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000).toISOString();

      // Find active leads with no activity in the last N days
      const staleLeads = rawDb.prepare(`
        SELECT l.*, ag.name as agent_name,
          (SELECT MAX(a.created_at) FROM lead_activity a WHERE a.lead_id = l.id) as last_activity
        FROM leads l
        LEFT JOIN agents ag ON ag.id = l.assigned_agent_id
        WHERE l.status IN ('assigned', 'no_answer', 'callback_requested')
          AND (
            (SELECT MAX(a.created_at) FROM lead_activity a WHERE a.lead_id = l.id) < ?
            OR (SELECT COUNT(*) FROM lead_activity a WHERE a.lead_id = l.id) = 0
          )
        ORDER BY last_activity ASC
      `).all(cutoff) as any[];

      // Group by agent
      const byAgent: Record<string, any[]> = {};
      for (const lead of staleLeads) {
        const agentName = lead.agent_name || "Unassigned";
        if (!byAgent[agentName]) byAgent[agentName] = [];
        byAgent[agentName].push({
          id: lead.id,
          ownerName: lead.owner_name,
          phone: lead.phone,
          address: lead.address,
          status: lead.status,
          lastActivity: lead.last_activity || "Never",
          agentName,
        });
      }

      console.log(`[Stale Audit] Found ${staleLeads.length} stale leads across ${Object.keys(byAgent).length} agents`);
      res.json({ total: staleLeads.length, byAgent, cutoffDays });

    } catch (err: any) {
      console.error("[Stale Audit] Error:", err);
      res.status(500).json({ error: "Stale audit failed" });
    }
  });

  // v14.46 — BATCHLEADS AUTO-PIPELINE REMOVED.
  // Seller intake is CSV-only now. See /api/admin/import-batchleads-csv below.


  // ─── BATCHLEADS CSV/XLSX IMPORT (v14.4) ────────────────────────────────────
  // Manual upload path for BatchLeads UI exports. Bypasses the /property API.
  // Admin uploads the .xlsx from BatchLeads → Export to Excel; we parse, dedup,
  // insert, and round-robin assign.
  const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  app.post("/api/admin/import-batchleads-csv", uploadMem.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      console.log(`[BatchLeads CSV] Received ${req.file.originalname} (${req.file.size} bytes)`);

      const rows = parseBatchLeadsFile(req.file.buffer);
      console.log(`[BatchLeads CSV] Parsed ${rows.length} valid rows`);

      const stats = insertImportedLeads(rawDb, rows);
      // v14.4 — Leads stay in the shared pool (status='unassigned').
      // Agents pull from the pool via /api/leads/next. No round-robin push.

      res.json({
        ok: true,
        filename: req.file.originalname,
        rowsInFile: rows.length,
        inserted: stats.inserted,
        merged: stats.merged,
        skippedIdentical: stats.skippedIdentical,
        skippedDuplicate: stats.skippedDuplicate,   // legacy = merged + skippedIdentical
        byType: stats.byType,
        byCounty: stats.byCounty,
        message: `Imported ${stats.inserted} new + merged ${stats.merged} refresh${stats.merged !== 1 ? "es" : ""} (${stats.skippedIdentical} identical skipped). Leads are in the shared pool; agents pull via Work My Leads.`,
      });
    } catch (err: any) {
      console.error("[BatchLeads CSV] Import error:", err);
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // v14.22 — Recompute scores for existing leads using the unified scorer.
  // Safe to call repeatedly; only touches `score` column.
  app.post("/api/admin/backfill-scores", async (_req: any, res: any) => {
    try {
      const { computeUnifiedScore } = await import("../shared/scoring");
      const rows = rawDb.prepare(`
        SELECT id, phones, email, list_price, assessed_value, lot_size_acres,
               year_purchased, lead_type, source, score
        FROM leads
      `).all() as any[];
      const upd = rawDb.prepare(`UPDATE leads SET score = ? WHERE id = ?`);
      let updated = 0;
      const distribution: Record<string, number> = { hot: 0, warm: 0, cool: 0, cold: 0 };
      const tx = rawDb.transaction(() => {
        for (const l of rows) {
          let phoneCount = 0;
          try {
            const arr = l.phones ? JSON.parse(l.phones) : [];
            phoneCount = Array.isArray(arr) ? arr.length : 0;
          } catch { phoneCount = 0; }
          // BatchLeads legacy: some rows have score 45/65/85 from the old scoreCategoryToNumber.
          // Convert those back into a sourceRating hint so we don't drop it.
          let sourceRating: "high" | "medium" | "low" | null = null;
          if (l.source === "batchleads_csv") {
            if (l.score === 85) sourceRating = "high";
            else if (l.score === 65) sourceRating = "medium";
            else if (l.score === 45) sourceRating = "low";
          }
          const { score } = computeUnifiedScore({
            phoneCount,
            hasEmail: !!(l.email && String(l.email).trim()),
            listPrice: l.list_price,
            assessedValue: l.assessed_value,
            yearPurchased: l.year_purchased,
            lotSizeAcres: l.lot_size_acres,
            sourceRating,
            leadType: l.lead_type,
          });
          upd.run(score, l.id);
          updated++;
          const bucket = score >= 80 ? "hot" : score >= 65 ? "warm" : score >= 50 ? "cool" : "cold";
          distribution[bucket]++;
        }
      });
      tx();
      res.json({ ok: true, updated, distribution });
    } catch (err: any) {
      console.error("[backfill-scores] error:", err);
      res.status(500).json({ error: err.message });
    }
  });

    // ── AGENT LEADS: MANUAL QUICK-ADD (admin) ──────────────────────────
  // ─── DBPR AGENT SCRAPER PIPELINE TRIGGER ────────────────────────────────────
  // Pulls the DBPR weekly RE_rgn3.csv extract, filters to NE Florida individual
  // licensees (SL/BK/BL, Current+Active), and ingests new recruits.
  // Runs weekly Sunday 2am EDT via scheduled cron. Also triggerable manually by admins.
  const dbprRunHandler: any[] = [
    (req: any, res: any, next: any) => pipelineGuard("dbpr", req, res, next),
    async (req: any, res: any) => {
      try {
        console.log("[DBPR] Manual/cron trigger received");
        const result = await runDbprPipeline(rawDb);

        // Sanity check: if DBPR returned 0 records with no errors, CSV format may have changed
        const zeroScrape = result.scraped === 0 && result.errors.length === 0;

        res.json({
          ok: true,
          ...result,
          warning: zeroScrape
            ? "DBPR returned 0 records — CSV format may have changed. Check dbpr_csv_snapshot.csv on Railway volume."
            : undefined,
          message: result.inserted === 0
            ? `DBPR scrape complete. No new agents found (${result.updated} existing records refreshed, ${result.filtered} filtered).`
            : `DBPR scrape complete. ${result.inserted} new agents added to recruiting queue across ${Object.keys(result.byTerritory).length} territories.`,
        });
      } catch (err: any) {
        console.error("[DBPR] Pipeline error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  ];
  app.post("/api/admin/dbpr-run", ...dbprRunHandler);

  // ─── RECRUITING PIPELINE (admin) ────────────────────────────────────────────
  // Full pipeline view of all agent_leads with activity history per lead.
  app.get("/api/admin/recruiting/pipeline", (req: any, res) => {
    try {
      const status = req.query.status as string | undefined;
      const where = status && status !== "all"
        ? `WHERE al.status = '${status.replace(/'/g, "''")}'  `
        : `WHERE al.status NOT IN ('joined','not_interested','do_not_contact') `;
      const rows: any[] = rawDb.prepare(`
        SELECT al.*,
          a.name as caller_name,
          (SELECT COUNT(*) FROM agent_lead_activity ala WHERE ala.agent_lead_id = al.id) as attempt_count_actual,
          (SELECT json_group_array(json_object(
            'outcome', ala.outcome, 'notes', ala.notes,
            'callerName', ca.name, 'createdAt', ala.created_at
          )) FROM agent_lead_activity ala
           LEFT JOIN agents ca ON ca.id = ala.caller_id
           WHERE ala.agent_lead_id = al.id
           ORDER BY ala.created_at DESC
           LIMIT 5
          ) as recent_activity
        FROM agent_leads al
        LEFT JOIN agents a ON a.id = al.assigned_admin_id
        ${where}
        ORDER BY
          CASE al.status
            WHEN 'appointment'        THEN 0
            WHEN 'hot_prospect'       THEN 1
            WHEN 'callback_requested' THEN 2
            WHEN 'contacted'          THEN 3
            WHEN 'new'                THEN 4
            WHEN 'not_now'            THEN 5
            WHEN 'just_signed'        THEN 6
            ELSE 7
          END,
          al.attempt_count DESC,
          al.submitted_at DESC
        LIMIT 500
      `).all();
      const parsed = rows.map((r: any) => ({
        ...r,
        recent_activity: r.recent_activity ? (() => { try { return JSON.parse(r.recent_activity); } catch { return []; } })() : [],
      }));
      // All status counts including frozen
      const counts: any[] = rawDb.prepare(`
        SELECT status, COUNT(*) as count FROM agent_leads GROUP BY status ORDER BY count DESC
      `).all();
      res.json({ leads: parsed, counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── RECRUITING LEADERBOARD (admin) ──────────────────────────────────────────
  app.get("/api/admin/recruiting/leaderboard", (req: any, res) => {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayISO = todayStart.toISOString();
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekISO = weekStart.toISOString();

      const agentRows: any[] = rawDb.prepare(`
        SELECT
          ala.caller_id,
          a.name as agent_name,
          a.headshot_url as headshot_url,
          COUNT(*) as total_dials,
          SUM(CASE WHEN ala.outcome = 'keep_in_touch'  THEN 1 ELSE 0 END) as kit,
          SUM(CASE WHEN ala.outcome = 'hot_prospect'   THEN 1 ELSE 0 END) as hot_prospects,
          SUM(CASE WHEN ala.outcome = 'joined_team'    THEN 1 ELSE 0 END) as joined,
          SUM(CASE WHEN ala.outcome = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
          SUM(CASE WHEN ala.outcome = 'dial_no_answer' THEN 1 ELSE 0 END) as no_answer,
          SUM(CASE WHEN ala.created_at >= ? THEN 1 ELSE 0 END) as today_dials,
          SUM(CASE WHEN ala.outcome = 'keep_in_touch'  AND ala.created_at >= ? THEN 1 ELSE 0 END) as today_kit,
          SUM(CASE WHEN ala.outcome = 'hot_prospect'   AND ala.created_at >= ? THEN 1 ELSE 0 END) as today_hot,
          SUM(CASE WHEN ala.outcome = 'joined_team'    AND ala.created_at >= ? THEN 1 ELSE 0 END) as today_joined,
          SUM(CASE WHEN ala.created_at >= ? THEN 1 ELSE 0 END) as week_dials,
          SUM(CASE WHEN ala.outcome = 'keep_in_touch'  AND ala.created_at >= ? THEN 1 ELSE 0 END) as week_kit,
          SUM(CASE WHEN ala.outcome = 'hot_prospect'   AND ala.created_at >= ? THEN 1 ELSE 0 END) as week_hot,
          SUM(CASE WHEN ala.outcome = 'joined_team'    AND ala.created_at >= ? THEN 1 ELSE 0 END) as week_joined,
          SUM(ala.points_awarded) as total_points,
          MAX(ala.created_at) as last_activity_at
        FROM agent_lead_activity ala
        LEFT JOIN agents a ON a.id = ala.caller_id
        WHERE ala.caller_id IS NOT NULL
        GROUP BY ala.caller_id
        ORDER BY joined DESC, hot_prospects DESC, total_dials DESC
      `).all(
        todayISO, todayISO, todayISO, todayISO,
        weekISO,  weekISO,  weekISO,  weekISO
      );
      res.json(agentRows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET — DBPR pipeline stats (for AdminDashboard tile)
  const dbprStatsHandler = (req: any, res: any) => {
    try {
      const total = (rawDb.prepare(`SELECT COUNT(*) as n FROM agent_leads WHERE source = 'dbpr_scrape'`).get() as any)?.n || 0;
      const lastRun = (rawDb.prepare(`SELECT MAX(last_scraped_at) as ts FROM agent_leads WHERE source = 'dbpr_scrape'`).get() as any)?.ts || null;
      const byTerritory = rawDb.prepare(`
        SELECT matched_territory as territory, COUNT(*) as count
        FROM agent_leads
        WHERE source = 'dbpr_scrape'
        GROUP BY matched_territory
        ORDER BY count DESC
      `).all() as any[];
      const byStatus = rawDb.prepare(`
        SELECT status, COUNT(*) as count
        FROM agent_leads
        WHERE source = 'dbpr_scrape'
        GROUP BY status
        ORDER BY count DESC
      `).all() as any[];
      res.json({ total, lastRun, byTerritory, byStatus });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  app.get("/api/admin/dbpr-stats", dbprStatsHandler);

  // v14.46 — LandVoice OAuth routes removed. LandVoice data flows in via CSV upload
  // (see /api/admin/import-batchleads-csv — the parser auto-detects LandVoice CSVs).


  // ─── REACTIVATE RETIRED LEADS (admin) ───────────────────────────────────────
  // v13.2 — Go-live helper: takes every lead currently in 'retired' status,
  // flips them back to 'unassigned', clears callbackDate, and round-robins them
  // across active seller-side agents so the team has a working queue tonight.
  app.post("/api/admin/reactivate-retired-leads", (req: any, res) => {
    try {
      // 1) Grab all retired leads
      const retired = rawDb.prepare(
        `SELECT id, lead_type as leadType, territory FROM leads WHERE status = 'retired'`
      ).all() as { id: number; leadType: string; territory: string | null }[];

      if (retired.length === 0) {
        return res.json({ ok: true, reactivated: 0, assigned: 0, message: "No retired leads to reactivate." });
      }

      // 2) Flip all to unassigned, clear callback
      const now = new Date().toISOString();
      const flipStmt = rawDb.prepare(
        `UPDATE leads SET status = 'unassigned', assigned_agent_id = NULL, callback_date = NULL, uploaded_at = ? WHERE id = ?`
      );
      const flipMany = rawDb.transaction((rows: typeof retired) => {
        for (const r of rows) flipStmt.run(now, r.id);
      });
      flipMany(retired);

      // v14.7 — PULL MODE: reactivated leads stay in the shared pool.
      const assigned = 0;

      console.log(`[Reactivate Retired] Reactivated ${retired.length} leads, assigned ${assigned} to agents.`);
      res.json({ ok: true, reactivated: retired.length, assigned });
    } catch (err: any) {
      console.error("[Reactivate Retired] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/agent-leads/manual-add", (req: any, res) => {
    const { firstName, lastName, phone, email, currentBrokerage, licenseStatus, territory, notes } = req.body;
    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ error: "firstName, lastName, and phone are required" });
    }
    const now = new Date().toISOString();
    const result = rawDb.prepare(`
      INSERT INTO agent_leads
        (first_name, last_name, email, phone, current_brokerage, license_status,
         territory, applicant_notes, status, attempt_count, source, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, 'manual_add', ?)
    `).run(
      firstName.trim(), lastName.trim(),
      (email || "").trim(), phone.replace(/\D/g, ""),
      (currentBrokerage || "").trim(), (licenseStatus || "").trim(),
      (territory || "").trim(), (notes || "").trim(),
      now
    );
    console.log(`[Agent Leads] Manual add: ${firstName} ${lastName} — id ${result.lastInsertRowid}`);
    res.json({ ok: true, id: result.lastInsertRowid });
  });

  // ── AGENT LEADS: BULK CSV UPLOAD (admin) ────────────────────────
  app.post("/api/agent-leads/bulk-upload", (req: any, res) => {
    const { leads } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const now = new Date().toISOString();
    let created = 0;
    let skipped = 0;
    const insert = rawDb.prepare(`
      INSERT INTO agent_leads
        (first_name, last_name, email, phone, current_brokerage, license_status,
         territory, applicant_notes, status, attempt_count, source, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, 'bulk_import', ?)
    `);
    const insertMany = rawDb.transaction((rows: any[]) => {
      for (const row of rows) {
        const firstName = (row["First Name"] || row.firstName || row.first_name || "").trim();
        const lastName  = (row["Last Name"]  || row.lastName  || row.last_name  || "").trim();
        const phone     = (row.Phone || row.phone || row["Phone Number"] || "").replace(/\D/g, "");
        const email     = (row.Email || row.email || "").trim();
        const brokerage = (row["Current Brokerage"] || row.currentBrokerage || row.brokerage || "").trim();
        const license   = (row["License Status"] || row.licenseStatus || row.license || "").trim();
        const territory = (row.Territory || row.territory || "").trim();
        const notes     = (row.Notes || row.notes || "").trim();

        if (!firstName || !lastName || phone.length < 7) { skipped++; continue; }
        insert.run(firstName, lastName, email, phone, brokerage, license, territory, notes, now);
        created++;
      }
    });
    insertMany(leads);
    console.log(`[Agent Leads] Bulk import: ${created} created, ${skipped} skipped`);
    res.json({ created, skipped });
  });

  // ─── GLOBAL ERROR HANDLER (v11.70) ──────────────────────────────────────
  // Catches any unhandled error thrown inside a route handler. Without this,
  // Express swallows async throws and the request hangs forever.
  // Must be registered AFTER all routes (4-argument signature tells Express
  // this is an error handler, not a regular middleware).
  app.use((err: any, req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal server error";
    console.error(`[error] ${req.method} ${req.path} → ${status}: ${message}`, err.stack || "");
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
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

  // ── Raw data ──────────────────────────────────────────────────────────────
  const activities: any[] = rawDb.prepare(
    `SELECT la.*, a.name as agentName FROM lead_activity la
     LEFT JOIN agents a ON a.id = la.agent_id
     WHERE la.created_at >= ? AND la.created_at <= ?
     ORDER BY la.created_at DESC`
  ).all(startOfDay, endOfDay);

  const allLeadsRaw: any[] = rawDb.prepare(`SELECT * FROM leads`).all();
  const allAgentsRaw: any[] = rawDb.prepare(`SELECT * FROM agents`).all();
  const agentNameMap: Record<number, string> = {};
  allAgentsRaw.forEach((a: any) => { agentNameMap[a.id] = a.name; });

  const newLeadsToday: number = (rawDb.prepare(
    `SELECT COUNT(*) as cnt FROM leads WHERE uploaded_at >= ? AND uploaded_at <= ?`
  ).get(startOfDay, endOfDay) as any)?.cnt ?? 0;

  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
  });

  // ── Per-agent breakdown ───────────────────────────────────────────────────
  const activeAgents: any[] = allAgentsRaw.filter((a: any) => a.is_active && a.role === "agent");

  const agentStats = activeAgents.map((agent: any) => {
    const acts = activities.filter((a: any) => a.agent_id === agent.id && a.outcome !== "email_sent");
    return {
      name: agent.name,
      dials:      acts.length,
      emails:     activities.filter((a: any) => a.agent_id === agent.id && a.outcome === "email_sent").length,
      appts:      acts.filter((a: any) => a.outcome === "contacted_appointment").length,
      kit:        acts.filter((a: any) => a.outcome === "keep_in_touch").length,
      callbacks:  acts.filter((a: any) => a.outcome === "callback_requested").length,
      noAnswer:   acts.filter((a: any) => a.outcome === "no_answer").length,
      notInt:     acts.filter((a: any) => a.outcome === "contacted_not_interested").length,
      wrongNum:   acts.filter((a: any) => a.outcome === "wrong_number").length,
      recycled:   acts.filter((a: any) => a.outcome === "recycled").length,
    };
  }).filter((s: any) => s.dials > 0 || s.emails > 0);

  const totalDials  = agentStats.reduce((s: number, a: any) => s + a.dials, 0);
  const totalAppts  = agentStats.reduce((s: number, a: any) => s + a.appts, 0);
  const totalKIT    = agentStats.reduce((s: number, a: any) => s + a.kit, 0);
  const totalEmails = agentStats.reduce((s: number, a: any) => s + a.emails, 0);
  const totalCB     = agentStats.reduce((s: number, a: any) => s + a.callbacks, 0);
  const totalNA     = agentStats.reduce((s: number, a: any) => s + a.noAnswer, 0);
  const totalNI     = agentStats.reduce((s: number, a: any) => s + a.notInt, 0);
  const totalWN     = agentStats.reduce((s: number, a: any) => s + a.wrongNum, 0);

  // ── Outcome detail rows ───────────────────────────────────────────────────
  function leadRow(act: any, accentColor: string, outcomeLabel: string): string {
    const lead = allLeadsRaw.find((l: any) => l.id === act.lead_id);
    let snap: any = {};
    try { snap = JSON.parse(act.lpmamab_snapshot || "{}"); } catch {}
    const name    = lead ? `${lead.owner_name || lead.first_name || ""}`.trim() || "Unknown" : "Unknown";
    const phone   = lead?.phone || "—";
    const address = snap.confirmedAddress || lead?.address || "—";
    const agent   = act.agentName || agentNameMap[act.agent_id] || "—";
    const notes   = act.notes ? `<div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.45);font-style:italic">${act.notes}</div>` : "";
    const extra   = outcomeLabel === "Appointment Set" ? `
      <div style="margin-top:4px;font-size:11px;color:#86efac">${snap.apptDate || ""} ${snap.apptTime || ""} · ${snap.stage || ""} · ${snap.intention || ""}</div>` :
      outcomeLabel === "Callback" ? `<div style="margin-top:4px;font-size:11px;color:#93c5fd">Scheduled: ${lead?.callback_date || snap.callbackDate || "—"}</div>` : "";
    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
        <td style="padding:10px 14px;vertical-align:top">
          <div style="font-size:13px;font-weight:600;color:#f0f0f0">${name}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px">${phone} · ${address}</div>
          ${extra}${notes}
        </td>
        <td style="padding:10px 14px;vertical-align:top;font-size:12px;color:${accentColor};white-space:nowrap">${agent}</td>
      </tr>`;
  }

  function outcomeSection(label: string, color: string, outcomeKey: string): string {
    const rows = activities.filter((a: any) => a.outcome === outcomeKey);
    if (rows.length === 0) return "";
    return `
    <div style="padding:20px 24px 0">
      <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:${color};font-weight:700;margin-bottom:10px;opacity:0.85">${label} (${rows.length})</div>
      <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border-radius:8px;overflow:hidden">
        <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.07)">
          <th style="padding:7px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);font-weight:600;text-transform:uppercase;letter-spacing:.08em">Lead</th>
          <th style="padding:7px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);font-weight:600;text-transform:uppercase;letter-spacing:.08em">Agent</th>
        </tr></thead>
        <tbody>${rows.map((a: any) => leadRow(a, color, label)).join("")}</tbody>
      </table>
    </div>`;
  }

  // ── Redistributed leads today ─────────────────────────────────────────────
  // v14.39 — Recycled leads carry a 14d cooldown. Show ❄ + release date so admins know
  // when the lead is eligible again. Uses the lead's current recycle_cooldown_until.
  const redistributedActs = activities.filter((a: any) => a.outcome === "recycled" && a.agent_id === null);
  const fmtReleaseDate = (ms: number | null | undefined): string => {
    if (!ms) return "";
    const d = new Date(ms);
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "America/New_York" };
    return d.toLocaleDateString("en-US", opts);
  };
  const redistributedSection = redistributedActs.length > 0 ? `
    <div style="padding:20px 24px 0">
      <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);font-weight:700;margin-bottom:10px">Recycled — On Ice (${redistributedActs.length})</div>
      <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border-radius:8px;overflow:hidden">
        <tbody>${redistributedActs.map((act: any) => {
          const lead = allLeadsRaw.find((l: any) => l.id === act.lead_id);
          const newAgent = lead?.assigned_agent_id ? agentNameMap[lead.assigned_agent_id] : "Unassigned";
          const name = lead ? (lead.owner_name || `${lead.first_name || ""} ${lead.last_name || ""}`.trim()) : "Unknown";
          const releaseDate = fmtReleaseDate(lead?.recycle_cooldown_until);
          return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:10px 14px;vertical-align:top">
              <div style="font-size:13px;font-weight:600;color:#f0f0f0">❄ ${name}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px">${lead?.phone || "—"} · ${lead?.address || "—"}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;font-style:italic">${act.notes || ""}</div>
            </td>
            <td style="padding:10px 14px;font-size:12px;color:#67e8f9;white-space:nowrap;vertical-align:top">${releaseDate ? "On ice — " + releaseDate : "Now: " + newAgent}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>` : "";

  // ── Unassigned leads (sitting in pool) ───────────────────────────────────
  const unassignedLeads = allLeadsRaw.filter((l: any) => l.status === "unassigned" || (!l.assigned_agent_id && !["contacted_not_interested","contacted_appointment","wrong_number","keep_in_touch","callback_requested"].includes(l.status)));
  const unassignedSection = unassignedLeads.length > 0 ? `
    <div style="padding:20px 24px 0">
      <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#f87171;font-weight:700;margin-bottom:8px">⚠️ Unassigned Leads (${unassignedLeads.length})</div>
      <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 10px">These leads are in the pool but have no agent — use Redistribute in the dashboard.</p>
      <table style="width:100%;border-collapse:collapse;background:rgba(239,68,68,0.04);border-radius:8px;overflow:hidden;border:1px solid rgba(239,68,68,0.12)">
        <tbody>${unassignedLeads.slice(0, 20).map((l: any) => `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:9px 14px;font-size:13px;color:#f0f0f0">${l.owner_name || `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown"}</td>
            <td style="padding:9px 14px;font-size:12px;color:rgba(255,255,255,0.35)">${l.phone || "—"}</td>
            <td style="padding:9px 14px;font-size:12px;color:rgba(255,255,255,0.35)">${l.address || "—"}</td>
          </tr>`).join("")}
          ${unassignedLeads.length > 20 ? `<tr><td colspan="3" style="padding:9px 14px;font-size:12px;color:rgba(255,255,255,0.3);font-style:italic">…and ${unassignedLeads.length - 20} more</td></tr>` : ""}
        </tbody>
      </table>
    </div>` : "";

  // ── Agent table ───────────────────────────────────────────────────────────
  const agentRows = agentStats.length > 0
    ? agentStats.sort((a: any, b: any) => b.appts - a.appts || b.dials - a.dials).map((a: any) => {
        const contactRate = a.dials > 0 ? Math.round(((a.appts + a.kit + a.notInt) / a.dials) * 100) : 0;
        return `<tr style="border-bottom:1px solid rgba(200,170,90,0.08)">
          <td style="padding:10px 14px;font-size:13px;color:#f0f0f0">${a.name}</td>
          <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#86efac;text-align:center">${a.appts}</td>
          <td style="padding:10px 14px;font-size:13px;color:#c8aa5a;text-align:center">${a.kit}</td>
          <td style="padding:10px 14px;font-size:13px;color:#93c5fd;text-align:center">${a.callbacks}</td>
          <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.6);text-align:center">${a.noAnswer}</td>
          <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.4);text-align:center">${a.notInt}</td>
          <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.3);text-align:center">${a.wrongNum}</td>
          <td style="padding:10px 14px;font-size:13px;color:#fff;text-align:center;font-weight:600">${a.dials}</td>
          <td style="padding:10px 14px;font-size:13px;color:#67e8f9;text-align:center">${contactRate}%</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="9" style="padding:20px;text-align:center;color:rgba(255,255,255,0.3);font-size:13px">No activity logged today</td></tr>`;

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:680px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid rgba(200,170,90,0.25)">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%);padding:28px 32px">
    <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(0,0,0,0.5);margin-bottom:6px">Brothers Group at Momentum Realty</div>
    <h1 style="margin:0;font-size:24px;color:#080808;font-weight:700">End of Day Report</h1>
    <p style="margin:5px 0 0;font-size:13px;color:rgba(0,0,0,0.6)">${dateLabel}</p>
  </div>

  <!-- KPI strip -->
  <div style="display:flex;border-bottom:1px solid rgba(200,170,90,0.15);flex-wrap:wrap">
    ${[
      { val: totalAppts, label: "Appts Set",      color: "#86efac" },
      { val: totalKIT,   label: "Keep in Touch",  color: "#c8aa5a" },
      { val: totalCB,    label: "Callbacks",       color: "#93c5fd" },
      { val: totalNA,    label: "No Answer",       color: "rgba(255,255,255,0.5)" },
      { val: totalNI,    label: "Not Interested",  color: "#fca5a5" },
      { val: totalWN,    label: "Wrong #",         color: "rgba(255,255,255,0.3)" },
      { val: totalDials, label: "Total Dials",     color: "#fff" },
    ].map(k => `
    <div style="flex:1;min-width:80px;padding:18px 10px;text-align:center;border-right:1px solid rgba(200,170,90,0.08)">
      <div style="font-size:26px;font-weight:700;color:${k.color}">${k.val}</div>
      <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-top:4px">${k.label}</div>
    </div>`).join("")}
  </div>

  <!-- New leads strip -->
  <div style="padding:12px 24px;background:rgba(200,170,90,0.06);border-bottom:1px solid rgba(200,170,90,0.1);font-size:13px;color:rgba(255,255,255,0.55)">
    <span style="color:#c8aa5a;font-weight:600">${newLeadsToday} new lead${newLeadsToday !== 1 ? "s" : ""}</span> added to the pool today
  </div>

  <!-- Agent breakdown table -->
  <div style="padding:24px 0 0">
    <div style="padding:0 24px 12px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(200,170,90,0.55);font-weight:600">Agent Breakdown</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:560px">
        <thead>
          <tr style="border-bottom:1px solid rgba(200,170,90,0.2)">
            ${["Agent","Appts","KIT","Callbacks","No Ans","Not Int","Wrong #","Dials","Contact%"].map(h =>
              `<th style="padding:8px 14px;text-align:${h==="Agent"?"left":"center"};font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);font-weight:600;white-space:nowrap">${h}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody>${agentRows}</tbody>
      </table>
    </div>
  </div>

  <!-- Outcome detail sections -->
  ${outcomeSection("Appointment Set",    "#86efac", "contacted_appointment")}
  ${outcomeSection("Keep in Touch",      "#c8aa5a", "keep_in_touch")}
  ${outcomeSection("Callback Scheduled", "#93c5fd", "callback_requested")}
  ${outcomeSection("Not Interested",     "#fca5a5", "contacted_not_interested")}
  ${outcomeSection("Wrong Number",       "rgba(255,255,255,0.35)", "wrong_number")}
  ${outcomeSection("Retired — all lines struck (10 no-answers each)", "rgba(255,255,255,0.45)", "retired_no_answer")}

  <!-- Redistributed -->
  ${redistributedSection}

  <!-- Unassigned warning -->
  ${unassignedSection}

  <!-- Footer -->
  <div style="padding:16px 24px;margin-top:24px;background:#080808;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:rgba(255,255,255,0.18);display:flex;justify-content:space-between">
    <span>Lead Depot v14.81.1</span><span>Brothers Group · Momentum Realty</span>
  </div>
</div>
</body>
</html>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
    subject: `📊 EOD Report — ${dateLabel} — ${totalAppts} Appt${totalAppts !== 1 ? "s" : ""} · ${totalKIT} KIT · ${totalDials} Dials`,
    html,
  });

  console.log(`[digest] Sent — ${totalAppts} appts, ${totalKIT} KIT, ${totalDials} dials`);
}

// Fires at 5:45 PM EDT = 21:45 UTC every day
// ─── CALLBACK REDISTRIBUTION (v14.14 — neutralized) ─────────────────────────
// v14.14: Callback outcome retired. Recycle is the successor (immediate unassign,
// no date, no coordination). This function is kept as a no-op so any legacy
// callback_requested rows (should be zero on prod) don't accidentally get promoted.
async function redistributeDueCallbacks() {
  // Intentional no-op — Callback fully retired in v14.14.
  // Any remaining `callback_requested` rows are migrated to `unassigned` at boot
  // by the v14.14 callback-retire sweep. No scheduled promotion needed.
  return;

  // eslint-disable-next-line no-unreachable
  const todayStr = new Date().toISOString().slice(0, 10);

  // Dead code kept for reference; unreachable due to early return above.
  const callbackLeads: any[] = rawDb.prepare(`
    SELECT l.id, l.lead_type as leadType, l.assigned_agent_id as assignedAgentId,
           l.callback_date as callbackDate,
           a.is_active as agentIsActive, a.lead_flow_on as agentLeadFlowOn, a.name as agentName
    FROM leads l
    LEFT JOIN agents a ON a.id = l.assigned_agent_id
    WHERE l.status = 'callback_requested'
      AND l.callback_date IS NOT NULL
      AND substr(l.callback_date, 1, 10) = ?
  `).all(todayStr);

  let redistributed = 0;

  for (const lead of callbackLeads) {
    // Is the assigned agent still active?
    const assignedAgent = lead.assignedAgentId
      ? { isActive: lead.agentIsActive, leadFlowOn: lead.agentLeadFlowOn, name: lead.agentName }
      : null;

    if (assignedAgent != null && assignedAgent!.leadFlowOn !== false && assignedAgent!.leadFlowOn !== 0) {
      // Agent is active — promote callback to 'no_answer' so it surfaces at top of their queue today.
      // getNextLeadForAgent prioritizes callbacks with past/today dates already, but flipping to
      // no_answer ensures it appears in the regular dial flow with no special-case logic needed.
      storage.updateLead(lead.id, { status: "no_answer", callbackDate: null });
      storage.createLeadActivity({
        leadId: lead.id,
        agentId: null,
        outcome: "recycled",
        notes: `📞 Callback due today (${lead.callbackDate}) — promoted to active dial queue for ${lead.agentName}.`,
        lpmamabSnapshot: null,
        createdAt: new Date().toISOString(),
      });
      redistributed++;
      continue;
    }

    // Agent is inactive (or unassigned) — redistribute to next active agent
    const nextAgentMaybe = storage.getNextAgentInRotation(lead.leadType);
    if (!nextAgentMaybe) continue;
    const nextAgent: { id: number } = nextAgentMaybe as { id: number };

    const originalAgentName = assignedAgent?.name || "a deactivated agent";

    storage.updateLead(lead.id, {
      assignedAgentId: nextAgent.id,
      status: "assigned",
      callbackDate: null,
    });
    storage.updateRoundRobinState(nextAgent.id);

    // Write a handoff note into activity so the new agent sees full context
    storage.createLeadActivity({
      leadId: lead.id,
      agentId: null,
      outcome: "recycled",
      notes: `📋 Callback Handoff — originally scheduled by ${originalAgentName} for ${lead.callbackDate}. Reassigned to you because that agent is no longer active. All prior notes and history are below. Pick up the conversation where they left off.`,
      lpmamabSnapshot: null,
      createdAt: new Date().toISOString(),
    });

    redistributed++;
  }

  if (redistributed > 0) {
    broadcast({ type: "leads_updated" });
    console.log(`[callbacks] Redistributed ${redistributed} due callback(s) from inactive agents`);
  }
}

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
    redistributeDueCallbacks().catch(err => console.error("[callbacks] Error:", err));
    sendDailyDigest().catch(err => console.error("[digest] Error:", err));
    setTimeout(fire, 24 * 60 * 60 * 1000); // repeat every 24h
  }, delay);
}

scheduleDailyDigest();

// ─── REDISTRIBUTION: Unassigned / Redistributed Leads ────────────────────────
// Runs at server startup and daily at 8am EDT to push any
// unassigned or redistributed leads into delegation to active agents.
async function redistributeUnassignedLeads() {
  const SKIP = [
    "contacted_not_interested",
    "contacted_appointment",
    "keep_in_touch",
    "callback_requested",
    "wrong_number",
  ];

  // ── SQL: only load no_answer leads with phone state data (v11.70) ──
  const noAnswerLeads: any[] = rawDb.prepare(
    `SELECT id, phone, phones, phone_states as phoneStates FROM leads
     WHERE status = 'no_answer' AND phone_states IS NOT NULL`
  ).all();
  for (const lead of noAnswerLeads) {
    try {
      const states: Record<string, string> = JSON.parse(lead.phoneStates!);
      let changed = false;
      for (const p of Object.keys(states)) {
        if (states[p] === "no_answer_today") { states[p] = "untried"; changed = true; }
      }
      if (changed) {
        // Also restore phone to first untried number
        const phones: string[] = lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []);
        const firstUntried = phones.find(p => states[p] === "untried");
        rawDb.prepare("UPDATE leads SET phone_states = ?, phone = COALESCE(?, phone) WHERE id = ?")
          .run(JSON.stringify(states), firstUntried ?? null, lead.id);
      }
    } catch {}
  }

  // SQL: only fetch unassigned/eligible leads — much faster at scale (v11.70)
  const skipList = SKIP.map(() => "?").join(",");
  const eligible: any[] = rawDb.prepare(
    `SELECT id, lead_type as leadType FROM leads
     WHERE status NOT IN (${skipList})
       AND (assigned_agent_id IS NULL OR status = 'unassigned')`
  ).all(...SKIP);
  if (eligible.length === 0) {
    console.log("[redistribution] No unassigned leads to redistribute.");
    return;
  }
  let reassigned = 0;
  let skipped = 0;
  for (const lead of eligible) {
    const nextAgent = storage.getNextAgentInRotation(lead.leadType);
    if (nextAgent) {
      storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
      storage.updateRoundRobinState(nextAgent.id);
      reassigned++;
    } else {
      skipped++;
    }
  }
  if (reassigned > 0) {
    broadcast({ type: "leads_updated" });
  }
  console.log(`[redistribution] Reset no_answer_today flags. Redistributed ${reassigned} lead(s), skipped ${skipped}.`);
}

function scheduleRedistribution() {
  // Fire once daily at 8am EDT = 12:00 UTC
  function msUntil8amEDT(): number {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(12, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntil8amEDT();
    console.log(`[redistribution] Next morning run in ${Math.round(delay / 60000)} min (8:00 AM EDT)`);
    setTimeout(async () => {
      await redistributeUnassignedLeads().catch((err) =>
        console.error("[redistribution] Error:", err)
      );
      scheduleNext(); // schedule the next day's run
    }, delay);
  }

  scheduleNext();
}

// v14.7 — PULL MODE ONLY. Auto-redistribution disabled.
// Agents pull from the shared pool via /api/leads/my-next. No round-robin push.
// (Startup redistribution + daily 8 AM redistribution both removed.)
console.log("[redistribution] Auto-redistribution DISABLED (v14.7 pull mode).");

// ─── WEEKLY RECRUITING FUNNEL EMAIL ──────────────────────────────────────────
// Sends every Sunday at 7am EDT (11:00 UTC)
// Summarises: new DBPR leads added, contacted, hot prospects, appointments, joined
async function sendWeeklyRecruitingFunnel() {
  if (!resend) return;

  const now = new Date();
  // Week window: last 7 days
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const stats = rawDb.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE source = 'dbpr_scrape' AND submitted_at >= ?) as new_dbpr,
      COUNT(*) FILTER (WHERE status IN ('contacted','hot_prospect','appointment','callback_requested') AND submitted_at >= ?) as engaged,
      COUNT(*) FILTER (WHERE status = 'hot_prospect') as hot,
      COUNT(*) FILTER (WHERE status = 'appointment') as appt,
      COUNT(*) FILTER (WHERE status = 'joined') as joined,
      COUNT(*) FILTER (WHERE status NOT IN ('not_interested','do_not_contact','joined')) as pipeline,
      COUNT(*) as total
    FROM agent_leads
  `).get(weekAgo, weekAgo) as any;

  // Top callers this week
  const topCallers = rawDb.prepare(`
    SELECT a.name, COUNT(*) as calls
    FROM agent_lead_activity ala
    JOIN agents a ON a.id = ala.caller_id
    WHERE ala.created_at >= ?
    GROUP BY ala.caller_id
    ORDER BY calls DESC
    LIMIT 5
  `).all(weekAgo) as any[];

  // Recent joins
  const recentJoins = rawDb.prepare(`
    SELECT first_name, last_name, matched_territory
    FROM agent_leads WHERE status = 'joined'
    ORDER BY rowid DESC LIMIT 5
  `).all() as any[];

  const dateLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  const topCallersHtml = topCallers.length > 0
    ? topCallers.map((c: any) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:#e5e5e5;font-size:13px">${c.name}</span><span style="color:#4fb8a3;font-size:13px;font-weight:700">${c.calls} calls</span></div>`).join("")
    : `<div style="color:rgba(255,255,255,0.35);font-size:13px">No recruiting calls this week</div>`;

  const recentJoinsHtml = recentJoins.length > 0
    ? recentJoins.map((j: any) => `<div style="padding:4px 0;font-size:13px;color:#22c55e">✓ ${j.first_name} ${j.last_name}${j.matched_territory ? ` · ${j.matched_territory}` : ""}</div>`).join("")
    : `<div style="color:rgba(255,255,255,0.35);font-size:13px">No joins yet — keep pushing</div>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
    subject: `📊 Weekly Recruiting Funnel — ${dateLabel}`,
    html: `
      <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:0;max-width:600px;margin:0 auto;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#0f1f1d,#071210);padding:32px 28px;border-bottom:1px solid rgba(79,184,163,0.2)">
          <p style="color:#4fb8a3;letter-spacing:.18em;font-size:11px;text-transform:uppercase;margin:0 0 8px">Brothers Group · Lead Depot</p>
          <h1 style="color:#fff;font-weight:300;font-size:26px;margin:0">Weekly Recruiting Funnel</h1>
          <p style="color:rgba(255,255,255,0.4);font-size:13px;margin:6px 0 0">${dateLabel}</p>
        </div>

        <div style="padding:24px 28px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px">
            ${[
              { label: "New DBPR Leads", val: stats?.new_dbpr ?? 0, color: "#4fb8a3" },
              { label: "Hot Prospects", val: stats?.hot ?? 0, color: "#f97316" },
              { label: "Appointments", val: stats?.appt ?? 0, color: "#c8aa5a" },
            ].map(s => `
              <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:14px 12px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:${s.color};font-family:sans-serif">${s.val}</div>
                <div style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.1em;margin-top:4px">${s.label}</div>
              </div>`).join("")}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
            <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:14px 12px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#22c55e;font-family:sans-serif">${stats?.joined ?? 0}</div>
              <div style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.1em;margin-top:4px">Joined Team</div>
            </div>
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 12px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#e5e5e5;font-family:sans-serif">${stats?.pipeline ?? 0}</div>
              <div style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.1em;margin-top:4px">Total Pipeline</div>
            </div>
          </div>

          <div style="margin-bottom:20px">
            <p style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#4fb8a3;font-weight:700;margin:0 0 10px">Top Callers This Week</p>
            ${topCallersHtml}
          </div>

          <div style="margin-bottom:24px">
            <p style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#22c55e;font-weight:700;margin:0 0 10px">Recent Joins</p>
            ${recentJoinsHtml}
          </div>

          <div style="text-align:center">
            <a href="https://depot.watsonbrothersgroup.com" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#4fb8a3,#2d7f72);color:#fff;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;border-radius:8px;text-decoration:none">Open Lead Depot</a>
          </div>
        </div>

        <div style="padding:16px 28px;border-top:1px solid rgba(255,255,255,0.05);text-align:center">
          <p style="color:rgba(255,255,255,0.25);font-size:11px;margin:0">Lead Depot · Brothers Group at Momentum Realty · Fernandina Beach, FL</p>
        </div>
      </div>
    `,
  });
  console.log("[recruiting-funnel] Weekly email sent");
}

function scheduleWeeklyRecruitingFunnel() {
  function msUntilSunday7amEDT(): number {
    // Sunday 7am EDT = Sunday 11:00 UTC
    const now = new Date();
    const next = new Date(now);
    // Find next Sunday
    const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
    next.setUTCDate(now.getUTCDate() + daysUntilSunday);
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntilSunday7amEDT();
    console.log(`[recruiting-funnel] Next weekly email in ${Math.round(delay / 60000)} min (Sunday 7am EDT)`);
    setTimeout(() => {
      sendWeeklyRecruitingFunnel().catch(err => console.error("[recruiting-funnel] Error:", err));
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}
scheduleWeeklyRecruitingFunnel();

// ─── MISSED APPOINTMENT FOLLOW-UP CHECK ──────────────────────────────────────
// Runs daily at 9am EDT (13:00 UTC). Finds recruiting leads in 'appointment' status
// where the last activity is > 48h ago with no subsequent outcome logged.
// Sends an alert email to Alex when gaps are found.
async function checkMissedAppointments() {
  if (!resend) return;

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Find appointment-status leads where latest activity was > 48h ago
  const stale: any[] = rawDb.prepare(`
    SELECT al.id, al.first_name, al.last_name, al.phone, al.email,
           al.matched_territory, al.status,
           MAX(ala.created_at) as last_activity_at,
           a.name as last_caller
    FROM agent_leads al
    LEFT JOIN agent_lead_activity ala ON ala.agent_lead_id = al.id
    LEFT JOIN agents a ON a.id = ala.caller_id
    WHERE al.status = 'appointment'
    GROUP BY al.id
    HAVING last_activity_at < ? OR last_activity_at IS NULL
    ORDER BY last_activity_at ASC
    LIMIT 20
  `).all(fortyEightHoursAgo) as any[];

  if (stale.length === 0) {
    console.log("[missed-appt] No stale appointment leads found.");
    return;
  }

  const rows = stale.map((s: any) => {
    const lastAgo = s.last_activity_at
      ? `${Math.round((Date.now() - new Date(s.last_activity_at).getTime()) / (1000 * 60 * 60))}h ago`
      : "Never";
    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:10px 14px;font-size:13px;color:#f0f0f0;font-weight:600">${s.first_name} ${s.last_name}</td>
        <td style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.5)">${s.phone || "—"}</td>
        <td style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.5)">${s.matched_territory || "—"}</td>
        <td style="padding:10px 14px;font-size:12px;color:#ef4444">${lastAgo}</td>
        <td style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.4)">${s.last_caller || "—"}</td>
      </tr>`;
  }).join("");

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to: "alex@watsonbrothersgroup.com",
    subject: `⚠️ ${stale.length} Recruiting Appointment(s) Need Follow-Up`,
    html: `
      <div style="font-family:'Georgia',serif;background:#09090b;color:#e5e5e5;padding:32px 24px;max-width:600px;margin:0 auto;border-radius:12px;">
        <h2 style="color:#ef4444;font-weight:400;font-size:22px;margin:0 0 6px">Missed Appointment Follow-Up</h2>
        <p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 24px">
          ${stale.length} recruiting lead(s) are in <strong style="color:#c8aa5a">Appointment</strong> status
          with no activity logged in the last 48 hours. These may be missed or need a post-appointment outcome logged.
        </p>
        <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border-radius:8px;overflow:hidden;margin-bottom:24px">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="padding:8px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em">Agent</th>
              <th style="padding:8px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em">Phone</th>
              <th style="padding:8px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em">Territory</th>
              <th style="padding:8px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em">Last Activity</th>
              <th style="padding:8px 14px;text-align:left;font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em">Last Caller</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="text-align:center">
          <a href="https://depot.watsonbrothersgroup.com" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#c8aa5a,#a8893a);color:#080808;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;border-radius:8px;text-decoration:none">Open Lead Depot</a>
        </div>
      </div>
    `,
  });
  console.log(`[missed-appt] Alert sent for ${stale.length} stale appointment lead(s)`);
}

function scheduleMissedAppointmentCheck() {
  // Daily at 9am EDT = 13:00 UTC
  function msUntil9amEDT(): number {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(13, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntil9amEDT();
    console.log(`[missed-appt] Next check in ${Math.round(delay / 60000)} min (9am EDT)`);
    setTimeout(() => {
      checkMissedAppointments().catch(err => console.error("[missed-appt] Error:", err));
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}
scheduleMissedAppointmentCheck();

// ─── v13.8 — STALE LOCK RELEASER ─────────────────────────────────────────
// Every 5 minutes, delete lead_locks rows whose expires_at is in the past.
// This lets abandoned leads flow back into the pool without agent action.
// Cheap sweep — one indexed DELETE with a WHERE on expires_at.
function scheduleStaleLockReleaser() {
  setInterval(() => {
    try {
      const info = rawDb.prepare(
        `DELETE FROM lead_locks WHERE expires_at < datetime('now')`
      ).run();
      if (info.changes && info.changes > 0) {
        console.log(`[lead-locks] Released ${info.changes} stale lock(s)`);
      }
    } catch (err) {
      console.error("[lead-locks] Sweep error:", err);
    }
  }, 5 * 60 * 1000);
  console.log("[lead-locks] Stale-lock releaser running every 5 min");
}
scheduleStaleLockReleaser();

// v14.46 — BatchLeads auto-pipeline scheduler removed. CSV upload is the sole seller intake path.
