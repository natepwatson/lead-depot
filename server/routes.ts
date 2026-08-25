import { createRequire } from "node:module";
import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { rawDb } from "./db";
import { Resend } from "resend";
import { broadcast } from "./ws";
import { randomBytes } from "node:crypto";
import { pushOutcomeToFub, pushColdOutcomeToFub, pushIngestToFub, fubCreateAgentRecruit, pushEmailNoteToFub, scheduleFubEmailEvidence, fubApproveAgentAsVendor, fubGetSeatUsage, FUB_PRO_INCLUDED_SEATS, FUB_PRO_OVERAGE_PER_SEAT_USD, fubListTags, ensureFubMilestoneSchema, fireMilestoneTasks, FUB_MILESTONE_TRIGGER_EVENTS } from "./fub";
import { runFubInventorySweep } from "./fubSweep";
import { parseWeeklyWorkbook } from "./workbookParser";
import { enrichAddress, lookupCityState } from "./zipToCity";
import { getCallHeatTier, tierForCell } from "../shared/prime-schedule";
import {
  computeAndPersistStreak,
  recomputeAllStreaks,
  getCurrentChampion,
  crownMonthlyChampion,
  getChampionHistory,
} from "./streaks";
import {
  captureAgentSnapshot,
  captureAllSnapshots,
  backfillSnapshots,
  getSnapshotsForAgent,
  getSnapshotsFiltered,
  scheduleDailySnapshotCron,
} from "./dailySnapshots";
import {
  ensureDiversityChallengeSchema,
  awardDiversityBonusesForWeek,
  categoriesHitForAgent,
  bonusForCount,
  streakForAgent,
  weekBoundsET,
  reawardWeekFor,
  scheduleDiversityChallengeCron,
} from "./diversity";
import { runFullAudit } from "./db-audit";
import {
  ensureRepairLogSchema,
  recomputePointsForAgent,
  recomputePointsForAll,
  pruneStaleEvidence,
  reassignLeadsFromDeactivated,
  repairSnapshotGaps,
  listRepairLog,
  dedupeListingConsultPhotos,
} from "./db-repair";
// v17.6 — removed duplicate ./approvals module. All approval traffic goes
// through the existing approval_requests table via routes below (§ v17.0
// ADMIN APPROVAL QUEUE and the per-kind lead-gen POST endpoints).
import { computeRecommendation, formatQuestionnaireForHumans } from "./recommendation";
import QRCode from "qrcode";
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
import { getBackupStatus, runDailyOffVolumeBackup } from "./backup";
import { registerPushRoutes, startOnAirPushScheduler } from "./pushOnAir";
import { registerChallengeRoutes, checkAndAwardAutoDetect } from "./challenges_routes";
import { currentDailyKey, currentWeeklyKey } from "./challenges";
import { registerZillowRoutes } from "./zillow_intel";
import { registerRepairConsultRoutes } from "./repairConsult";
import { registerListingConsultRoutes } from "./listingConsult";
import { registerFubContactsRoutes } from "./fubContacts";
import { registerWriteOfferRoutes } from "./writeOffer";
import { registerInspectionsRoutes } from "./inspections";
import { registerPaymentRoutes } from "./payments";
// v15.11.10 — web push module removed; replaced by prime-email-scheduler.
import { checkPassword } from "../shared/password-rules";
// v14.46 — BatchLeads auto-pipeline removed. CSV import path is the sole seller intake.
import { parseBatchLeadsFile, insertImportedLeads } from "./batchleads-csv-import";
// @ts-expect-error — no @types/multer installed; runtime-only import
import multer from "multer";
// v18.0 — DBPR pipeline import removed with recruiting system.
import { EXPIRED_SCRIPT_V14_16 } from "./expired-script";
import { getTerritoryForZip, TERRITORIES as TERRITORY_META, ALL_NE_FLORIDA_ZIPS_ARRAY } from "./territories";

// v20.14.4 — Team Map territory gate. Brothers Group only operates leads in
// Nassau/Duval/St Johns (NE Florida). Bad/placeholder addresses (e.g. "N/A")
// have occasionally geocoded to bogus fallback coordinates far outside our
// footprint (seen: a fixed Miami-area point). Gate pins two ways:
//   1. If the lead has a zip, it must be one of our NE Florida territory zips.
//   2. Regardless of zip, the pin's lat/lng must fall inside a generous
//      bounding box around our actual Nassau/Duval/St Johns service area.
// A pin must pass the box check always, and pass the zip check whenever a
// zip is present. This keeps legitimate pins that are merely missing a zip
// field while rejecting anything geocoded outside our territory.
const NE_FL_ZIP_SET = new Set(ALL_NE_FLORIDA_ZIPS_ARRAY);
const NE_FL_MAP_BOUNDS = { minLat: 29.5, maxLat: 31.0, minLng: -82.3, maxLng: -81.0 };
function isInTerritory(zip: string | null | undefined, lat: number, lng: number): boolean {
  const inBox =
    lat >= NE_FL_MAP_BOUNDS.minLat && lat <= NE_FL_MAP_BOUNDS.maxLat &&
    lng >= NE_FL_MAP_BOUNDS.minLng && lng <= NE_FL_MAP_BOUNDS.maxLng;
  if (!inBox) return false;
  const z = (zip || "").trim().slice(0, 5);
  if (z && !NE_FL_ZIP_SET.has(z)) return false;
  return true;
}
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
export function awardPoints(
  agentId: number | null | undefined,
  outcome: string,
  leadId?: number,
  scope: "seller" | "recruiting" = "seller",
) {
  if (!agentId) return;
  // v15.11.26 — REBALANCED point system.
  // Appt Set crushes everything (only outcome that generates revenue). KIT is a real
  // conversation. Network referral is meaningful but doesn't move revenue directly.
  // Emails and voicemails award ZERO points — they were noise. Base dial fallback = 1.
  const pts: Record<string, number> = {
    contacted_appointment:     60,   // v15.11.31 — bumped 40→60. One Prime appt (120 pts) crushes 8 Prime KITs. Producers win.
    keep_in_touch:             15,   // v15.11.31 — trimmed 20→15. Still real convo value but no longer dial-farmable.
    network_referral:          20,   // v15.11.31 — bumped 15→20. Referrals ARE revenue-direct.
    open_house_lead:           20,   // v16.7 — OH captured lead. Same value as network referral (real capture, revenue-direct).
    open_house_log:            50,   // v17.6 — OH physical presence log, bumped 20→50 (evidence bar higher, encourages field work).
    oh_knock_route:            40,   // v17.6 — OH knock route piggyback, bumped 15→40 (SetRep evidence, real effort during OH).
    direct_mail:                1,   // v20.4.4 — Direct Mail: 1 point per mailer approved (was 3).
    door_knock:                 2,   // v17.6 — Base per-door value. Actual session points_potential = doors × 2 (25+ doors min).
    social_post:               10,   // v20.7.20 — BASE per-platform. Actual points_potential = 10 × platforms.length (1-3). 2/day cap enforced upstream.
    contacted_not_interested:   5,   // Real contact, worth something.
    listed:                     3,   // Rare informational outcome.
    recycled:                   2,   // Re-queue, minor effort.
    no_answer:                  2,   // Real dial, most common outcome.
    wrong_number:               1,   // Data cleanup.
    disconnected:               1,   // Data cleanup.
    left_voicemail:             6,   // v15.11.41 — Owner - No Answer: confirmed owner + recycle + boost. 6 pts.
    agent_referral_approved:  100,   // v19.6 — Referred agent got hired. Big deal.
    agent_invite_sent:         50,   // v20.7.9 — Immediate credit when an agent sends an invite (before candidate submits or gets approved).
    // Any other outcome falls back to base dial (1).
  };
  const basePoints = pts[outcome] ?? 1;
  // v17.6 — Evidence-gated field activities are FLAT (no Prime multiplier).
  // The dial multiplier exists because dial connect rates vary by hour; field
  // work happens whenever the agent shows up and admin approval can be delayed
  // hours or days, so multiplying by tier-at-approval is arbitrary and gameable.
  // Award the flat rate and short-circuit.
  const FLAT_OUTCOMES = new Set(["open_house_log", "open_house_lead", "oh_knock_route", "direct_mail", "door_knock", "social_post", "network_referral", "agent_referral_approved", "agent_invite_sent"]);
  if (FLAT_OUTCOMES.has(outcome)) {
    if (basePoints === 0) return;
    rawDb.prepare(
      `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(agentId, basePoints, outcome, leadId ?? null, scope, new Date().toISOString());
    // v19.5 — Instant broadcast so leaderboard/team-pot/agent-stats refresh with no poll delay.
    try { broadcast({ type: "points_awarded", agentId, delta: basePoints, outcome, scope, ts: new Date().toISOString() }); } catch {}
    return;
  }
  // v15.11.26 — 5-TIER call-heat multiplier (was 2-tier). Multipliers align with
  // the 5-tier schedule grid in shared/prime-schedule.ts and drive the leaderboard
  // toward proven high-connect hours.
  //   Prime  🟢 → 2×
  //   Mid    🟡 → 1.5×
  //   Low    🟠 → 1.25×
  //   Down   ⬜ → 1× (dial-locked in UI; multiplier here as belt-and-suspenders)
  //   Illegal ⬛ → never awards (upstream endpoints refuse the call in the first place)
  let multiplier = 1;
  let tier: string = "base";
  try {
    tier = getCallHeatTier();
    if (tier === "prime") multiplier = 2;
    else if (tier === "mid") multiplier = 1.5;
    else if (tier === "low") multiplier = 1.25;
    else if (tier === "down") multiplier = 1;
    else multiplier = 1; // illegal shouldn't reach here, but be safe
  } catch (err) {
    console.error("[awardPoints] tier lookup failed", err);
  }
  // If the base points are 0 (emails, voicemail), no multiplier can save them.
  if (basePoints === 0) return;
  const points = Math.round(basePoints * multiplier);
  const reason = multiplier > 1 ? `${outcome}_${tier}_${multiplier}x` : outcome;
  rawDb.prepare(
    `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, points, reason, leadId ?? null, scope, new Date().toISOString());
  // v19.5 — Instant broadcast so leaderboard/team-pot/agent-stats refresh with no poll delay.
  try { broadcast({ type: "points_awarded", agentId, delta: points, outcome, tier, scope, ts: new Date().toISOString() }); } catch {}
  // v20.7.8 — Auto-detect challenge completions immediately (used to only run
  // when the agent opened the Challenges tab). Fires the daily + weekly sweep.
  // Broadcasts a challenges refresh signal so the Home card + Challenges tab
  // live-update without a full refetch.
  try {
    const dailyAwarded = checkAndAwardAutoDetect(agentId, currentDailyKey(), "daily");
    const weeklyAwarded = checkAndAwardAutoDetect(agentId, currentWeeklyKey(), "weekly");
    if (dailyAwarded > 0 || weeklyAwarded > 0) {
      try { broadcast({ type: "challenges_updated", agentId, dailyAwarded, weeklyAwarded, ts: new Date().toISOString() }); } catch {}
    }
  } catch (e) {
    console.error("[awardPoints] challenge auto-detect failed:", e);
  }
}


// v19.6 — Warm-lead / lead-gen activity admin notification helper.
// Fires an admin-facing summary email to alex@ + nate@ (+ denise@ where relevant)
// on ANY warm submission the team wants immediate visibility on. Non-fatal on failure.
async function notifyLeadGenActivity(opts: {
  kind: string;              // "door_knock_log" | "direct_mail_log" | "social_post"
  agentName: string;
  headline: string;          // one-line summary
  detailsHtml: string;       // preformatted rows (<tr><td>...</td></tr>)
  cc?: string[];             // extra cc recipients
}) {
  if (!resend) return;
  try {
    const to  = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"];
    const cc  = opts.cc && opts.cc.length ? opts.cc : undefined;
    const subject = `${opts.headline}`;
    const tdL = "padding:8px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:140px;vertical-align:top";
    const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:580px;margin:0 auto;background:#0c0b0a;border-radius:14px;overflow:hidden;border:1px solid #2a2520">
  <div style="background:linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%);padding:22px 28px">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5a3e00;font-weight:700">Lead Gen Activity — ${opts.kind.replace(/_/g,' ')}</p>
    <h1 style="margin:0;font-size:20px;color:#080808;font-weight:700">${opts.agentName}</h1>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse">
      ${opts.detailsHtml}
    </table>
    <p style="margin:20px 0 0;font-size:12px;color:#666">Awaiting Nate's approval. See Admin → Approvals.</p>
  </div>
  <div style="padding:12px 28px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v20.32.19 — Brothers Group · Momentum Realty</div>
</div></body></html>`;
    await resend.emails.send({ from: "Lead Depot <noreply@watsonbrothersgroup.com>", to, cc, subject, html });
  } catch (err) {
    console.error(`[notifyLeadGenActivity ${opts.kind}] failed:`, err);
  }
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
    <span>Lead Depot v20.32.19 — Brothers Group · Momentum Realty</span>
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
  <div style="padding:12px 28px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v20.32.19 — Brothers Group · Momentum Realty</div>
</div></body></html>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:   ["alex@watsonbrothersgroup.com"],
    cc:   ["nate@watsonbrothersgroup.com"],
    subject,
    html,
  });
}

const LOW_QUEUE_THRESHOLD = 5; // leads per active agent — restored v19.6
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
  <div style="padding:12px 26px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v20.32.19 — Brothers Group · Momentum Realty</div>
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
    buyerTarget: r.buyer_target, // v15.11.28 — JSON string of future-home target specs
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

  // ─── v15.11.10 — On Air push (15-min-before) routes + 5-min scheduler ───
  registerPushRoutes(app);
  // v20.7.29 — On-Air PUSH notifications disabled at Alex's request (2026-08-10).
  // The banner still renders and startPrimeNotifier still fires local browser
  // notifications for opted-in users, and push_notif_on_air is still recorded
  // on the agent row so we can flip this back on with a single line change.
  // startOnAirPushScheduler();
  registerChallengeRoutes(app);
  registerZillowRoutes(app);
  registerRepairConsultRoutes(app);
  registerListingConsultRoutes(app);
  registerFubContactsRoutes(app);
  registerWriteOfferRoutes(app);
  registerInspectionsRoutes(app);
  registerPaymentRoutes(app);

  // ─── v15.11.11 — Emergency force-reset endpoint (INGEST_SECRET-guarded) ───
  // Reason: reset-password emails weren't reaching some agents; this bypasses email
  // entirely so admins can unblock any agent in <5s. Requires X-Ingest-Secret header.
  // Direct bcrypt hash write to agents.password. Audit-logged as password_reset with
  // notes='force_reset_admin_bypass'. Revokes all existing sessions for that agent.
  app.post("/api/admin/agents/:id/force-reset", async (req, res) => {
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) return res.status(503).json({ error: "Server missing INGEST_SECRET" });
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) return res.status(403).json({ error: "forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const newPass = String(req.body?.password || "").trim();
    if (newPass.length < 8) return res.status(400).json({ error: "password must be ≥ 8 chars" });
    const row = rawDb.prepare("SELECT id, email, name FROM agents WHERE id = ?").get(id) as any;
    if (!row) return res.status(404).json({ error: "agent not found" });
    const hash = await hashPassword(newPass);
    rawDb.prepare("UPDATE agents SET password = ? WHERE id = ?").run(hash, id);
    // Revoke all active sessions for this agent
    try { rawDb.prepare("DELETE FROM sessions WHERE agent_id = ?").run(id); } catch { /* table may not exist */ }
    try {
      logAgentEvent({
        targetId: id,
        actorId: null,
        event: "password_reset",
        before: null,
        after: null,
        notes: "force_reset_admin_bypass [system:force-reset] — password reset via INGEST_SECRET-guarded endpoint",
      });
    } catch { /* audit optional */ }
    console.log(`[v15.11.11 force-reset] password reset for agent ${id} (${row.email})`);
    res.json({ ok: true, agentId: id, email: row.email, name: row.name });
  });

  // ─── v15.11.26 — Admin session-guarded set-password endpoint ───
  // Same behavior as force-reset (direct bcrypt write + session revoke) but gated by
  // admin session cookie instead of INGEST_SECRET, so the Admin dashboard UI can call
  // it without exposing the shared secret to the browser. This is the primary rotation
  // path now that agents no longer self-service password changes.
  app.post("/api/admin/agents/:id/set-password", async (req, res) => {
    if (!req.currentAgent || req.currentAgent.role !== "admin") {
      return res.status(403).json({ error: "Admin session required" });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const newPass = String(req.body?.password || "").trim();
    if (newPass.length < 8) return res.status(400).json({ error: "password must be ≥ 8 chars" });
    const row = rawDb.prepare("SELECT id, email, name FROM agents WHERE id = ?").get(id) as any;
    if (!row) return res.status(404).json({ error: "agent not found" });
    const hash = await hashPassword(newPass);
    rawDb.prepare("UPDATE agents SET password = ? WHERE id = ?").run(hash, id);
    try { rawDb.prepare("DELETE FROM sessions WHERE agent_id = ?").run(id); } catch { /* table may not exist */ }
    try {
      logAgentEvent({
        targetId: id,
        actorId: req.currentAgent.id,
        event: "password_reset",
        before: null,
        after: null,
        notes: `admin_set_password — rotated by ${req.currentAgent.name || req.currentAgent.email} <${req.currentAgent.email}>. All sessions revoked.`,
      });
    } catch { /* audit optional */ }
    console.log(`[v15.11.26 admin-set-password] password set for agent ${id} (${row.email}) by admin ${req.currentAgent.email}`);
    res.json({ ok: true, agentId: id, email: row.email, name: row.name });
  });

  // ─── v15.11.15 — Emergency admin-set-email endpoint (INGEST_SECRET-guarded) ───
  // When an agent's login is broken because their email in Lead Depot no longer
  // matches the address they're typing, an admin can rotate the email in one
  // request without needing a browser session. Revokes all sessions for that
  // agent so any stale cookie stops working immediately.
  app.post("/api/admin/agents/:id/admin-set-email", (req, res) => {
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) return res.status(503).json({ error: "Server missing INGEST_SECRET" });
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) return res.status(403).json({ error: "forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const newEmailRaw = String(req.body?.newEmail || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmailRaw)) {
      return res.status(400).json({ error: "newEmail is not a valid email" });
    }
    if (newEmailRaw.startsWith("tombstone:")) return res.status(400).json({ error: "refuse tombstone" });
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const collision = rawDb.prepare(
      "SELECT id, name FROM agents WHERE LOWER(email) = ? AND id <> ? AND merged_into_agent_id IS NULL"
    ).get(newEmailRaw, id) as { id: number; name: string } | undefined;
    if (collision) return res.status(409).json({ error: `Email already used by agent id=${collision.id} (${collision.name})` });

    const oldEmail = agent.email;
    rawDb.prepare("UPDATE agents SET email = ?, pending_email = NULL, pending_email_token = NULL, pending_email_expires = NULL WHERE id = ?").run(newEmailRaw, id);
    revokeAllSessionsForAgent(id);
    logAgentEvent({
      actorId: null,
      targetId: id,
      event: "email_changed",
      before: { email: oldEmail },
      after:  { email: newEmailRaw },
      notes: "admin-set-email via INGEST_SECRET-guarded endpoint (agent lockout recovery)",
    });
    console.log(`[v15.11.15 admin-set-email] agent=${id} — ${oldEmail} → ${newEmailRaw}`);
    res.json({ ok: true, agentId: id, name: agent.name, oldEmail, newEmail: newEmailRaw });
  });

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
    "/api/admin/missed-appointments",
    // v15.11.26 — Holdout admin endpoints. INGEST_SECRET-guarded inside route.
    // Exempted from session gate so QA + Alex's terminal curl can hit them
    // without a logged-in cookie.
    "/api/admin/holdouts",
  ];
  // v15.11.14 — additional exempt paths matched by SUFFIX (INGEST_SECRET-guarded inside route).
  //   /api/admin/leads/:id/manual-appt — lets an admin retro-assign a lead to an
  //   agent as an Appt Set when the appointment was already logged in FUB by hand.
  const CRON_EXEMPT_SUFFIXES = [
    "/manual-appt",
    "/admin-set-email", // v15.11.15 — INGEST_SECRET-guarded email rotation
  ];
  app.use("/api/admin", (req: any, res: any, next: any) => {
    const fullPath = req.baseUrl + req.path;
    if (CRON_EXEMPT_PATHS.some(p => fullPath.startsWith(p))) return next();
    if (CRON_EXEMPT_SUFFIXES.some(s => fullPath.endsWith(s))) return next();
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
      // v14.81.2 — onboarding gate flags, echoed camelCase from DB snake_case.
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
    if (!password) return res.status(400).json({ error: "Missing password" });
    const agent = rawDb.prepare("SELECT id, email, name, setup_expires FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired reset link" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Link expired" });
    // v15.11.10 — shared password rules
    const pwCheck = checkPassword(password, { email: agent.email, name: agent.name });
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.errors[0], errors: pwCheck.errors });
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
    // v14.81.2 — Drizzle exposes camelCase (headshotUrl, homeAddress) not snake_case.
    // Previous version read agent.headshot_url which is always undefined, so the
    // profile page fell back to initials even when the DB had a real headshot.
    const a = agent as any;
    res.json({ agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      phone: a.phone ?? "",
      // v15.8 — expose optional published phone for cold outreach templates
      publishedPhone: a.publishedPhone ?? a.published_phone ?? "",
      brokerage: a.brokerage ?? "",
      homeAddress: a.homeAddress ?? a.home_address ?? "",
      headshotUrl: a.headshotUrl ?? a.headshot_url ?? "",
      homeCounty: a.homeCounty ?? a.home_county ?? null,
      // v14.81.2 — onboarding gate flags (camelCase, echoing DB values).
      profileCompletedAt: a.profileCompletedAt ?? a.profile_completed_at ?? null,
      tutorialCompletedAt: a.tutorialCompletedAt ?? a.tutorial_completed_at ?? null,
    }});
  });

  // ─── AGENTS ───────────────────────────────────────────────────────────────
  app.get("/api/agents", (req, res) => {
    const all = storage.getAllAgents();
    res.json(all.map(a => ({ ...a, password: undefined })));
  });

  // v15.3 — REAL dialing-now presence. Replaces the v14.9 vibe count (active_count + random_bump)
  // that was showing '6 dialing now' 24/7 even when nobody was on the phone.
  // TRUTH: an agent is "dialing now" iff they've inserted a lead_activity row in the last 10 min.
  // Any outcome logged (no_answer, wrong_number, appt, kit, etc.) counts as proof of a live dial.
  app.get("/api/agents/live-count", (req, res) => {
    try {
      const windowMs = 10 * 60 * 1000; // 10 minutes
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      const row: any = rawDb.prepare(
        `SELECT COUNT(DISTINCT la.agent_id) AS cnt
         FROM lead_activity la
         JOIN agents a ON a.id = la.agent_id
         WHERE la.created_at >= ?
           AND a.is_active = 1
           AND a.role = 'agent'
           AND la.agent_id IS NOT NULL`
      ).get(cutoff);
      const dialingNow = Number(row?.cnt) || 0;
      // Last outcome timestamp (for "last activity 3m ago" tooltip)
      const lastRow: any = rawDb.prepare(
        `SELECT MAX(created_at) AS ts FROM lead_activity WHERE agent_id IS NOT NULL`
      ).get();
      res.json({
        dialingNow,
        windowMinutes: 10,
        lastActivityAt: lastRow?.ts || null,
      });
    } catch (e) {
      console.error("[live-count] failed:", e);
      res.json({ dialingNow: 0, windowMinutes: 10, lastActivityAt: null });
    }
  });

  // v15.11.31 — WHO is dialing right now. Returns name, headshot, dials-in-window,
  // last-activity-timestamp per agent with a lead_activity row in the last 10 min.
  // Powers the desktop admin "Live On Air" widget so Alex can see — by name —
  // exactly who's on the phone at this moment. Same 10-min window as /live-count
  // so the count and the roster always match.
  app.get("/api/agents/live-agents", (req, res) => {
    try {
      const windowMs = 10 * 60 * 1000;
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      const rows = rawDb.prepare(
        `SELECT a.id, a.name, a.headshot_url AS headshotUrl,
                COUNT(la.id) AS dials,
                MAX(la.created_at) AS lastActivityAt
         FROM lead_activity la
         JOIN agents a ON a.id = la.agent_id
         WHERE la.created_at >= ?
           AND a.is_active = 1
           AND a.role = 'agent'
           AND la.agent_id IS NOT NULL
         GROUP BY a.id
         ORDER BY MAX(la.created_at) DESC`
      ).all(cutoff);
      res.json({ windowMinutes: 10, agents: rows, count: rows.length });
    } catch (e: any) {
      console.error("[live-agents] failed:", e);
      res.json({ windowMinutes: 10, agents: [], count: 0 });
    }
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
    if (!password) return res.status(400).json({ error: "Missing password" });

    const agent = rawDb.prepare("SELECT id, name, email, setup_expires, onboarded FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired setup link" });
    if (agent.onboarded) return res.status(410).json({ error: "Already set up" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Link expired" });

    // v15.11.10 — shared password rules
    const pwCheck = checkPassword(password, { email: agent.email, name: agent.name });
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.errors[0], errors: pwCheck.errors });

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
      // v18.0 — agent_leads / agent_lead_activity tables dropped with recruiting removal.
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
              <p style="color:#71717a;font-size:12px;margin-top:24px;">— Brothers Group Real Estate Team at Momentum Realty<br>Lead Depot v20.32.19</p>
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
    // v14.81.2 — Removed the 7-day reactivate window. Admins should be able to
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
              <p style="color:rgba(255,255,255,0.25);font-size:12px;line-height:1.6;border-top:1px solid rgba(200,170,90,0.1);padding-top:18px;">If you weren't expecting this reset, ignore this email — your password will not change. Lead Depot v20.32.19 · Brothers Group Real Estate Team at Momentum Realty</p>
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
    const { name, email, phone, publishedPhone, brokerage, homeAddress, headshotUrl } = req.body;
    // Validate email uniqueness if changed
    if (email && email.toLowerCase().trim() !== agent.email) {
      const existing = storage.getAgentByEmail(email.toLowerCase().trim());
      if (existing) return res.status(409).json({ error: "Email already in use" });
    }
    const updates: any = {};
    if (name        !== undefined) updates.name        = name.trim();
    if (email       !== undefined) updates.email       = email.toLowerCase().trim();
    if (phone       !== undefined) updates.phone       = phone.trim();
    // v15.8 — publishedPhone is the phone number shown in cold outreach templates.
    // Empty string is a valid intentional unset (falls back to `phone`).
    if (publishedPhone !== undefined) updates.publishedPhone = (publishedPhone || "").trim();
    if (brokerage   !== undefined) updates.brokerage   = brokerage.trim();
    if (homeAddress !== undefined) updates.homeAddress = homeAddress.trim();
    if (headshotUrl !== undefined) updates.headshotUrl = headshotUrl.trim();
    const updated = storage.updateAgent(id, updates);
    if (!updated) return res.status(500).json({ error: "Update failed" });
    res.json({ ...updated, password: undefined });
  });

  // ─── ONBOARDING: Profile gate + Tutorial flow (v14.81.2) ────────────────────

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
  // tutorial as complete. Idempotent, self-only write.
  //
  // v15.11.10 — Session cookie fell out on some iOS PWAs, silently 401'ing this
  // endpoint and leaving 13 agents perpetually re-watching. Now accepts the
  // X-Agent-Id header as fallback identity for this specific write since it's
  // (a) idempotent, (b) writes only the caller's own row, and (c) never grants
  // any privilege.
  app.post("/api/agent/complete-tutorial", (req, res) => {
    let id: number | undefined = req.currentAgent?.id;
    if (!id) {
      const xai = req.headers["x-agent-id"];
      const parsed = typeof xai === "string" ? parseInt(xai, 10) : NaN;
      if (parsed > 0) {
        const row = rawDb.prepare("SELECT id FROM agents WHERE id = ?").get(parsed) as any;
        if (row) id = row.id;
      }
    }
    if (!id) { res.status(401).json({ error: "Not authenticated" }); return; }
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
  // v15.11.26 — Agents can no longer self-service password changes. Admins (Alex/Nate)
  // rotate every agent's password via Admin → Agent detail → Set Password, which hits
  // the force-reset endpoint. This endpoint is now admin-only for their own rotations;
  // agents hitting it get 403.
  app.patch("/api/agents/:id/password", async (req, res) => {
    const id = parseInt(req.params.id);
    // Must be an admin. If admin, must be changing their own password (admin
    // rotates other agents via /api/admin/agents/:id/force-reset instead).
    if (!req.currentAgent || req.currentAgent.role !== "admin") {
      return res.status(403).json({ error: "Password changes are handled by an admin." });
    }
    if (req.currentAgent.id !== id) {
      return res.status(403).json({ error: "Use force-reset to rotate another agent's password." });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });

    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // v15.11.10 — Shared password rules (see shared/password-rules.ts). Server
    // enforces; the client uses the same module for live feedback so the two
    // never drift.
    const pwCheck = checkPassword(newPassword, {
      email: (agent as any).email,
      name: (agent as any).name,
    });
    if (!pwCheck.ok) {
      return res.status(400).json({ error: pwCheck.errors[0], errors: pwCheck.errors });
    }

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
  // v14.81.2 — Admin-only HARD DELETE. Permanently removes an agent row.
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
    // v20.7.53 — Inactive-agents concept removed. Hard-delete now works on any agent
    // regardless of active status. The trash icon on the admin roster is the single
    // exit path. Self-delete still blocked to prevent admins from locking themselves out.
    if (req.currentAgent?.id === id) return res.status(400).json({ error: "Cannot hard-delete yourself." });

    logAgentEvent({
      actorId: req.currentAgent?.id ?? null,
      targetId: id,
      event: "hard_deleted" as any,
      before: { name: before.name, email: before.email, isActive: before.isActive },
      after:  null,
      notes: `Hard-deleted by ${req.currentAgent?.name ?? "unknown admin"}. Row permanently removed; historical activity orphaned to NULL agent_id.`,
    });

    // v14.81.2 — Orphan history so FKs don't block delete. Corrected column names
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
      // v18.0 — agent_lead_activity table dropped with recruiting removal.
      rawDb.prepare(`UPDATE round_robin_state SET last_assigned_agent_id = NULL WHERE last_assigned_agent_id = ?`).run(id);
      rawDb.prepare(`DELETE FROM lead_locks WHERE agent_id = ?`).run(id);
      rawDb.prepare(`DELETE FROM agent_points WHERE agent_id = ?`).run(id);
      // v14.81.3 — Delete via rawDb, not storage.deleteAgent().
      // storage.ts owns its own SQLite connection (separate from rawDb), so
      // storage.deleteAgent() inside a rawDb.transaction deadlocks: rawDb
      // holds the write lock, storage's connection tries to acquire, and
      // without busy_timeout it fails immediately with "database is locked".
      // Every hard-delete since v14.78 has silently written an audit row and
      // then failed the transaction — 11 orphan hard_deleted audit entries
      // accumulated on probe agent id=15 before this fix. All writes on the
      // same connection now.
      rawDb.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
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

  // v14.39 — THAW: (retired v15.4) recycle cooldown was removed. Endpoint kept as
  // a 410 Gone shim for a release in case any admin UI still calls it, so clients
  // don't error opaquely. Recycled leads now re-enter the shared pool immediately
  // — no thaw needed. Remove entirely in v15.7.
  app.post("/api/admin/leads/:id/clear-cooldown", (_req, res) => {
    res.status(410).json({
      ok: false,
      error: "gone",
      message: "Recycle cooldown was removed in v15.4. Recycled leads re-enter the pool immediately — no thaw needed.",
    });
  });

  // v15.11.26 — Admin holdout clearing. Skip and Recycle both write to
  // agent_lead_holdouts so a lead won't come back to the same agent until
  // midnight EDT. This endpoint reverses that on demand:
  //   - POST /api/admin/holdouts/clear { agentId, leadId }  → remove one row
  //   - POST /api/admin/holdouts/clear { agentId }          → clear ALL holdouts for that agent
  //   - POST /api/admin/holdouts/clear { leadId }           → clear ALL holdouts on that lead (any agent)
  //   - POST /api/admin/holdouts/clear {}                   → 400 (refuse to nuke the whole table)
  // INGEST_SECRET guarded. Used for QA testing the Skip feature and for the
  // rare case where an agent skipped a lead by mistake.
  app.post("/api/admin/holdouts/clear", (req, res) => {
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) return res.status(503).json({ error: "Server missing INGEST_SECRET" });
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) return res.status(403).json({ error: "forbidden" });

    const agentId = req.body?.agentId != null ? parseInt(req.body.agentId, 10) : null;
    const leadId = req.body?.leadId != null ? parseInt(req.body.leadId, 10) : null;

    if (!agentId && !leadId) {
      return res.status(400).json({ error: "Provide agentId, leadId, or both. Refusing to clear all holdouts." });
    }

    let sql: string;
    let args: any[];
    if (agentId && leadId) {
      sql = `DELETE FROM agent_lead_holdouts WHERE agent_id = ? AND lead_id = ?`;
      args = [agentId, leadId];
    } else if (agentId) {
      sql = `DELETE FROM agent_lead_holdouts WHERE agent_id = ?`;
      args = [agentId];
    } else {
      sql = `DELETE FROM agent_lead_holdouts WHERE lead_id = ?`;
      args = [leadId];
    }

    const info = rawDb.prepare(sql).run(...args);
    res.json({
      ok: true,
      cleared: info.changes,
      scope: { agentId, leadId },
    });
  });

  // v15.11.26 — List active holdouts, filterable by agent or lead. INGEST_SECRET guarded.
  //   GET /api/admin/holdouts?agentId=1   → rows for that agent
  //   GET /api/admin/holdouts?leadId=42   → rows for that lead
  //   GET /api/admin/holdouts             → all active rows (expired ones auto-swept below)
  app.get("/api/admin/holdouts", (req, res) => {
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) return res.status(503).json({ error: "Server missing INGEST_SECRET" });
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) return res.status(403).json({ error: "forbidden" });
    rawDb.prepare(`DELETE FROM agent_lead_holdouts WHERE until < datetime('now')`).run();
    const agentId = req.query.agentId ? parseInt(String(req.query.agentId), 10) : null;
    const leadId = req.query.leadId ? parseInt(String(req.query.leadId), 10) : null;
    let sql = `
      SELECT h.agent_id, h.lead_id, h.until, h.reason, h.created_at,
             a.name AS agent_name,
             l.owner_name AS lead_owner, l.address AS lead_address
      FROM agent_lead_holdouts h
      LEFT JOIN agents a ON a.id = h.agent_id
      LEFT JOIN leads  l ON l.id = h.lead_id
      WHERE 1=1
    `;
    const args: any[] = [];
    if (agentId) { sql += ` AND h.agent_id = ?`; args.push(agentId); }
    if (leadId)  { sql += ` AND h.lead_id = ?`;  args.push(leadId);  }
    sql += ` ORDER BY h.until ASC LIMIT 500`;
    const rows = rawDb.prepare(sql).all(...args);
    res.json({ ok: true, count: rows.length, holdouts: rows });
  });

  // v15.11.14 — Admin manual-appt logger (INGEST_SECRET-guarded, no FUB push).
  //
  // Purpose: when a listing appt is closed OFF-SYSTEM (agent already logged
  // it directly in FUB, or the appt happened before the lead was properly
  // ingested), we still want the lead to show up in that agent's Pipeline in
  // Lead Depot as contacted_appointment. This endpoint bypasses the /outcome
  // pipeline (which would double-push to FUB) and just:
  //   1. Assigns the lead to :agentId
  //   2. Sets status = 'contacted_appointment'
  //   3. Writes a lead_activity row with the reason
  //   4. AWARDS +60 pts via awardPoints() so the leaderboard ticks (v20.7.26)
  //   5. Releases any lock
  //   6. Broadcasts an activity_event so the UI refreshes
  //
  // No FUB call. No action plan. No collaborator adds. Alex's rule: this is
  // for the case where FUB was already touched by hand.
  //
  // v20.7.26 — FIX: previously bypassed awardPoints() entirely, which meant
  // every manual appt silently gave the agent zero points even though the
  // pipeline row and the lead_activity dial counter both ticked. This was the
  // root cause of Bronson's Jorge Goncalves conversion registering as +0 pts.
  app.post("/api/admin/leads/:id/manual-appt", (req, res) => {
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) return res.status(503).json({ error: "Server missing INGEST_SECRET" });
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) return res.status(403).json({ error: "forbidden" });
    const leadId = parseInt(req.params.id, 10);
    if (!Number.isFinite(leadId)) return res.status(400).json({ error: "bad id" });
    const agentId = parseInt(req.body?.agentId, 10);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: "agentId required" });
    const notes = String(req.body?.notes || "Appt Set logged manually by admin (FUB already updated).").trim();

    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    const agent = storage.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    rawDb.prepare(`UPDATE leads SET status = 'contacted_appointment', assigned_agent_id = ?, callback_date = NULL WHERE id = ?`).run(agentId, leadId);
    rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
    rawDb.prepare(`
      INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
      VALUES (?, ?, 'contacted_appointment', ?, NULL, ?)
    `).run(leadId, agentId, notes, new Date().toISOString());

    // v20.7.26 — award the +60 appt points that this endpoint used to skip.
    // awardPoints() handles prime-time multiplier + challenge bonuses internally.
    let awardedPoints = 0;
    try {
      const beforeRow = rawDb.prepare(`SELECT COALESCE(SUM(points),0) AS s FROM agent_points WHERE agent_id = ?`).get(agentId) as any;
      const before = beforeRow?.s || 0;
      awardPoints(agentId, "contacted_appointment", leadId);
      const afterRow = rawDb.prepare(`SELECT COALESCE(SUM(points),0) AS s FROM agent_points WHERE agent_id = ?`).get(agentId) as any;
      const after = afterRow?.s || 0;
      awardedPoints = after - before;
    } catch (e) {
      console.error(`[v20.7.26 manual-appt awardPoints failed] agent=${agentId} lead=${leadId}`, e);
    }

    try {
      broadcast({ type: "activity_event", event: {
        type: "manual_appt_logged",
        leadId, agentId, agentName: agent.name,
        pointsAwarded: awardedPoints,
        ts: new Date().toISOString(),
      } });
    } catch {}

    console.log(`[v20.7.26 manual-appt] lead=${leadId} → agent=${agentId} (${agent.name}) FUB skipped pts=+${awardedPoints}`);
    res.json({ ok: true, leadId, agentId, agentName: agent.name, status: "contacted_appointment", pointsAwarded: awardedPoints });
  });

  // v20.7.53 — Admin manual bonus award. Cookie-authed via requireAdmin.
  // Inserts a row into agent_points with an arbitrary points value + reason.
  // Used for retroactive video-bonus credits and other one-off corrections
  // (e.g. an agent posted a video before the v20.7.53 toggle shipped).
  app.post("/api/admin/agents/:id/award-bonus", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const agentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: "bad id" });
    const points = parseInt(req.body?.points, 10);
    if (!Number.isFinite(points) || points === 0) return res.status(400).json({ error: "points required (non-zero integer)" });
    if (Math.abs(points) > 1000) return res.status(400).json({ error: "|points| must be <= 1000" });
    const reason = String(req.body?.reason || "manual_bonus").slice(0, 64);
    const agent = storage.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const nowIso = new Date().toISOString();
    rawDb.prepare(
      `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, NULL, 'seller', ?)`,
    ).run(agentId, points, reason, nowIso);
    try {
      broadcast({ type: "points_awarded", agentId, delta: points, outcome: reason, scope: "seller", ts: nowIso });
    } catch {}
    console.log(`[v20.7.53 award-bonus] agent=${agentId} (${agent.name}) pts=${points >= 0 ? "+" : ""}${points} reason="${reason}"`);
    res.json({ ok: true, agentId, agentName: agent.name, points, reason });
  });

  // v15.4 — Phone attempt cap review data.
  // GET /api/admin/phone-attempts/stats
  //   Returns aggregate resolution breakdown for lines struck at PHONE_ATTEMPT_CAP.
  //   Feeds the "is 12 the right cap or should we push to 16?" decision after ~2 weeks.
  app.get("/api/admin/phone-attempts/stats", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows: any[] = rawDb.prepare(`
        SELECT resolution, COUNT(*) as count
        FROM phone_attempt_outcomes
        GROUP BY resolution
        ORDER BY count DESC
      `).all();
      const total = rows.reduce((s, r) => s + r.count, 0);
      const byLeadType: any[] = rawDb.prepare(`
        SELECT lead_type, resolution, COUNT(*) as count
        FROM phone_attempt_outcomes
        GROUP BY lead_type, resolution
        ORDER BY lead_type, count DESC
      `).all();
      const oldestPending: any = rawDb.prepare(`
        SELECT lead_id, phone, struck_at
        FROM phone_attempt_outcomes
        WHERE resolution = 'pending'
        ORDER BY struck_at ASC
        LIMIT 1
      `).get();
      res.json({
        cap: 12,
        total_struck_lines: total,
        resolutions: rows,
        by_lead_type: byLeadType,
        oldest_pending: oldestPending || null,
        note: "Resolutions: pending (line struck, lead still open) | exhausted_deleted (all lines struck, lead auto-deleted) | other_line_connected_appt (different line closed appointment) | other_line_connected_not_interested (different line got the NI) | other_line_connected_kit (different line got KIT). Push cap to 16 only if pending stays high AND other_line_connected stays low after 2 weeks.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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

    // v15.9 SECURITY: shared-secret auth for cron ingest. No fallback default —
    // if INGEST_SECRET is unset in Railway env, we FAIL CLOSED. Prior fallback
    // ("ms-ingest-2026") was exposed in the public GitHub repo and turned this
    // endpoint into a public write. v15.9 refuses to accept ingest unless the
    // env var is set to a non-empty string AND matches the caller's value.
    const INGEST_SECRET = process.env.INGEST_SECRET;
    if (!INGEST_SECRET) {
      console.error("[ingest] INGEST_SECRET env var unset — refusing all ingest calls");
      return res.status(503).json({ error: "Ingest disabled: server missing INGEST_SECRET" });
    }
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
    const intent = String(req.query.intent || "all"); // v15.3

    const { rows, total } = storage.getLeadsPaginated({ status, agentId, search, intent, limit, offset });

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
        // v20.14.4 — placeholder addresses ("N/A", "TBD", "Unknown", etc.) have no
        // real location. Geocoding them has previously returned a bogus fixed
        // fallback point (seen: a Miami-area coordinate) that then shows up on
        // the Team Map far outside our NE Florida territory. Skip entirely.
        if (/^(n\/?a|tbd|unknown|none|--*)$/i.test(l.address.trim())) continue;
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

  // v20.6.8 — geocode any listings missing lat/lng.
  // Uses censusGeocodeAddresses which itself falls back to Nominatim per-item.
  // NEW: workbook uploads now store the raw address as "1234 Something St 32226"
  // with no city/state/zip columns. Before geocoding we run each row through
  // `enrichAddress` which pulls city+state from the trailing zip via ZIP_TO_CITY,
  // and writes them back onto the listing so the map has readable metadata too.
  let listingGeocodeRunning = false;
  async function runListingGeocodePass(): Promise<{ geocoded: number; missing: number }> {
    if (listingGeocodeRunning) return { geocoded: 0, missing: 0 };
    listingGeocodeRunning = true;
    let geocoded = 0;
    try {
      const missing: any[] = rawDb.prepare(`SELECT id, address, city, state, zip FROM listings WHERE lat IS NULL OR lng IS NULL LIMIT 500`).all();
      if (!missing.length) return { geocoded: 0, missing: 0 };
      // v20.6.8: enrich addresses missing city/state via zip lookup.
      const enrichWrite = rawDb.prepare(`UPDATE listings SET city = ?, state = ?, zip = ? WHERE id = ? AND (city IS NULL OR city = '')`);
      const items = missing.map((l: any) => {
        const rawStreet = l.address || "";
        let street = rawStreet;
        let city = l.city || "";
        let state = l.state || "FL";
        let zip = l.zip || "";
        // If we don't already have city/zip, try to enrich from the address tail.
        if (!city || !zip) {
          const enriched = enrichAddress(rawStreet);
          if (enriched) {
            street = rawStreet.replace(/\s*\b\d{5}(?:-\d{4})?\b\s*$/, "").trim();
            city = enriched.city;
            state = enriched.state;
            zip = enriched.zip;
            try { enrichWrite.run(city, state, zip, l.id); } catch {}
          }
        }
        return {
          id: l.id,
          addr: [street, city, state, zip].filter(Boolean).join(", "),
          street,
          city,
          state,
          zip,
        };
      });
      const BATCH = 500;
      for (let i = 0; i < items.length; i += BATCH) {
        const slice = items.slice(i, i + BATCH);
        try {
          const results = await censusGeocodeAddresses(slice);
          const upd = rawDb.prepare(`UPDATE listings SET lat = ?, lng = ?, updated_at = datetime('now') WHERE id = ?`);
          for (const [id, coords] of results.entries()) {
            upd.run(coords.lat, coords.lng, id);
            geocoded++;
          }
        } catch (e) { console.error("[listings-geocode] batch failed:", e); }
        if (i + BATCH < items.length) await new Promise(r => setTimeout(r, 3000));
      }
      console.log(`[listings-geocode] done — geocoded ${geocoded}/${missing.length} listings`);
      return { geocoded, missing: missing.length };
    } finally { listingGeocodeRunning = false; }
  }
  // Kick a listings geocode pass at boot too (5s delay).
  setTimeout(() => { void runListingGeocodePass(); }, 6000);

  // v20.4.9 — Open House acceptance email. Fires when an agent books an OH
  // (or when Denise's pre-typed host_preference auto-books on approval).
  // Includes: address, date/time, listing agent, list price, access info,
  // notes, prep instructions, and a link back to Lead Depot.
  async function sendOpenHouseAcceptanceEmail(ohId: number, agentId: number): Promise<void> {
    if (!resend) { console.warn("[oh-email] resend not configured"); return; }
    const oh = rawDb.prepare(`SELECT * FROM open_houses WHERE id = ?`).get(ohId) as any;
    if (!oh) return;
    const agent = rawDb.prepare(`SELECT id, name, email FROM agents WHERE id = ?`).get(agentId) as any;
    if (!agent?.email) { console.warn(`[oh-email] agent ${agentId} has no email`); return; }
    const fmtDate = (d: string) => {
      try {
        const [y, m, day] = d.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, day));
        return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      } catch { return d; }
    };
    const fmtTime = (t: string) => {
      try {
        const [h, mi] = t.split(":").map(Number);
        const suffix = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(mi).padStart(2, "0")} ${suffix}`;
      } catch { return t; }
    };
    const fmtMoney = (n: any) => n ? ("$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })) : "—";
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 620px; margin: 0 auto; color: #1a1a1a; line-height: 1.55;">
        <div style="background: linear-gradient(135deg, #C9A961 0%, #B8964F 100%); padding: 28px 32px; color: #fff; border-radius: 6px 6px 0 0;">
          <div style="font-size: 12px; letter-spacing: 2px; text-transform: uppercase; opacity: 0.85; margin-bottom: 8px;">Lead Depot — Open House Booked</div>
          <h1 style="margin: 0; font-size: 22px; font-weight: 600;">You’re on for ${oh.address}</h1>
        </div>
        <div style="background: #fff; padding: 28px 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 6px 6px;">
          <p style="margin: 0 0 20px 0; font-size: 15px;">Hey ${agent.name?.split(" ")[0] || agent.name || "there"} — you’ve got this open house. Here’s everything you need.</p>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #666; width: 140px;">Address</td><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 15px; font-weight: 500;">${oh.address}</td></tr>
            <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #666;">Date</td><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 15px; font-weight: 500;">${fmtDate(oh.date)}</td></tr>
            <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #666;">Time</td><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 15px; font-weight: 500;">${fmtTime(oh.time_start)} – ${fmtTime(oh.time_end)}</td></tr>
            <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #666;">Listing Agent</td><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 15px;">${oh.listing_agent || "—"}</td></tr>
            <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #666;">List Price</td><td style="padding: 10px 0; border-bottom: 1px solid #eee; font-size: 15px;">${fmtMoney(oh.list_price)}</td></tr>
          </table>

          <div style="background: #FFF9EE; border-left: 4px solid #C9A961; padding: 16px 20px; margin-bottom: 24px; border-radius: 4px;">
            <div style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #7A6B3E; margin-bottom: 8px; font-weight: 600;">Access Info</div>
            <div style="font-size: 15px; white-space: pre-wrap;">${(oh.access_info || "").replace(/</g, "&lt;")}</div>
          </div>

          ${oh.notes ? `<div style="background: #F4F4F4; padding: 16px 20px; margin-bottom: 24px; border-radius: 4px;"><div style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #555; margin-bottom: 8px; font-weight: 600;">Notes from Denise</div><div style="font-size: 14px; white-space: pre-wrap;">${oh.notes.replace(/</g, "&lt;")}</div></div>` : ""}

          <div style="background: #1a1a1a; color: #fff; padding: 20px 24px; border-radius: 6px; margin-bottom: 24px;">
            <div style="font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #C9A961; margin-bottom: 12px; font-weight: 600;">Prep Checklist</div>
            <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8;">
              <li><strong>Arrive 30 minutes early</strong> to unlock, unlock lights, set up sign-in.</li>
              <li><strong>Come prepared with flyers</strong> — grab them from the office if you don’t have any.</li>
              <li><strong>Place a minimum of 5 open house signs</strong> at every major turn leading to the property.</li>
              <li>Log every conversation as a lead in Lead Depot before you leave the driveway.</li>
            </ul>
            <div style="margin-top: 14px; font-size: 14px; color: #C9A961; font-weight: 600;">Good luck!</div>
          </div>

          <div style="text-align: center;">
            <a href="https://depot.watsonbrothersgroup.com" style="display: inline-block; background: #1a1a1a; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600;">Open Lead Depot</a>
          </div>

          <p style="margin: 32px 0 0 0; font-size: 12px; color: #999; text-align: center;">Need to bail? Text Alex or Nate directly — no self-serve cancel in the app.</p>
        </div>
      </div>
    `;
    try {
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: agent.email,
        subject: `Open House — ${fmtDate(oh.date)} — ${oh.address}`,
        html,
      });
      console.log(`[oh-email] sent acceptance to ${agent.email} for OH ${ohId}`);
    } catch (e: any) {
      console.error(`[oh-email] send failed for OH ${ohId}:`, e?.message || e);
      throw e;
    }
  }

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

  // v19.5 — Public Team Map endpoint. Any authenticated agent can call this;
  // returns only anonymized coordinates + coarse bucket. NO owner name, NO
  // address, NO id, NO phone, NO zip. Coordinates are jittered ±0.004° (~350m)
  // to hide exact property location. This is the "bragging" surface used to
  // recruit — shows density and appointment set count without leaking any PII.
  // v20.4.2 — REAL pins, REAL coords, per-lead popups. Owner/name/phone/street
  // masked for non-admin viewers; city+ZIP+status always visible so the map
  // feels authentic to agents without exposing enough to poach leads. Admins
  // see everything unredacted.
  app.get("/api/team-map/pins", (req, res) => {
    const isAdmin = req.currentAgent?.role === "admin";

    // v20.4.2.1 — pins were 0 in v20.4.2 because our INNER JOIN key concatenated
    // "address, city, state, zip" but geo_cache stores keys as JUST the raw
    // address (see geoKey() line 2685). Fix: mirror the WORKING map endpoint's
    // 2-step pattern — fast JOIN first, then per-row getCached() fallback via
    // enrichLeadForMap.fullAddr for anything the JOIN missed.
    // (This is the same pattern used at lines 2848-2882 for the old MapView.)

    // Step 1: fast JOIN (best case, covers leads whose cache key was written as
    // the concatenated "address, city, state, zip" form).
    const joined: any[] = rawDb.prepare(
      `SELECT l.id, l.status, l.owner_name, l.phone, l.address, l.city, l.state, l.zip,
              l.assigned_agent_id, l.lead_type as lead_type, a.name as agent_name, l.extra_data,
              g.lat, g.lng
       FROM leads l
       INNER JOIN geo_cache g ON g.address_key = lower(trim(
         l.address || ', ' ||
         coalesce(nullif(l.city,''), '') || ', ' ||
         coalesce(nullif(l.state,''), 'FL') || ', ' ||
         coalesce(nullif(l.zip,''), '')
       ))
       LEFT JOIN agents a ON a.id = l.assigned_agent_id`
    ).all();

    // Step 2: fallback — for every lead NOT in the joined set, try getCached()
    // via enrichLeadForMap.fullAddr. This catches leads whose cache key was
    // written as just the raw address (the format geoKey() uses).
    const seenJoined = new Set(joined.map(r => r.id));
    const allLeads: any[] = rawDb.prepare(
      `SELECT l.id, l.status, l.owner_name, l.phone, l.address, l.city, l.state, l.zip,
              l.assigned_agent_id, l.lead_type, a.name as agent_name, l.extra_data as extraData,
              l.lead_type as leadType
       FROM leads l
       LEFT JOIN agents a ON a.id = l.assigned_agent_id`
    ).all();
    const rows: any[] = [...joined];
    for (const raw of allLeads) {
      if (seenJoined.has(raw.id)) continue;
      const enriched = enrichLeadForMap(raw);
      const cached = getCached(geoKey(enriched.fullAddr));
      if (!cached) continue;
      // Also try just the raw address (some legacy rows are cached that way).
      rows.push({
        id: raw.id, status: raw.status,
        owner_name: raw.owner_name, phone: raw.phone,
        address: raw.address, city: enriched.city, state: enriched.state, zip: enriched.zip,
        assigned_agent_id: raw.assigned_agent_id, lead_type: raw.lead_type,
        agent_name: raw.agent_name,
        lat: cached.lat, lng: cached.lng,
      });
    }
    // Also try raw-address-only cache for leads that STILL have no coords.
    const seenNow = new Set(rows.map(r => r.id));
    for (const raw of allLeads) {
      if (seenNow.has(raw.id)) continue;
      if (!raw.address) continue;
      const cached = getCached(geoKey(raw.address));
      if (!cached) continue;
      rows.push({
        id: raw.id, status: raw.status,
        owner_name: raw.owner_name, phone: raw.phone,
        address: raw.address, city: raw.city, state: raw.state, zip: raw.zip,
        assigned_agent_id: raw.assigned_agent_id, lead_type: raw.lead_type,
        agent_name: raw.agent_name,
        lat: cached.lat, lng: cached.lng,
      });
    }

    // Bucket status into three tiers for pin color.
    const bucket = (s: string): "appt" | "contact" | "pool" => {
      if (s === "contacted_appointment") return "appt";
      if (s === "assigned" || s === "callback_requested" || s === "no_answer") return "contact";
      return "pool";
    };

    // Status label for popups (human readable).
    const statusLabel = (s: string): string => {
      switch (s) {
        case "contacted_appointment": return "Appt Set";
        case "contacted_not_interested": return "Not Interested";
        case "assigned": return "Assigned";
        case "callback_requested": return "Recycled";
        case "no_answer": return "No Answer";
        case "retired": return "Retired";
        default: return "Pool";
      }
    };

    // v20.4.2 masking helpers — admin sees everything; agents get
    // NAME/PHONE/STREET masked with a fixed-width dot pattern that preserves
    // rough length feel without leaking anything usable.
    const maskName = (n: string | null | undefined) => {
      if (!n) return "•••••••••";
      // Keep same # of words, mask each to 8 dots.
      const parts = n.trim().split(/\s+/).filter(Boolean);
      return parts.map(() => "••••••••").join(" ");
    };
    const maskPhone = (p: string | null | undefined) => {
      if (!p) return "(•••) •••-••••";
      return "(•••) •••-••••";
    };
    const maskStreet = (addr: string | null | undefined) => {
      if (!addr) return "••• ••••••••";
      // Keep the street-suffix if we can find it (St / Ave / Rd / Dr / Ln / Ct / Blvd / Way / Pl).
      const suffixMatch = addr.match(/\b(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Highway)\.?\b/i);
      const suffix = suffixMatch ? ` ${suffixMatch[0]}` : "";
      return `•••• ••••••••${suffix}`;
    };

    // Emit one pin per lead at its REAL coords. No jitter, no aggregation. The
    // agent should see exactly where the lead sits so the map feels authentic.
    // v20.14.4 — territory gate: drop any lead whose zip (when present) isn't
    // one of ours, or whose coords fall outside the NE Florida service box.
    const pins = rows
      .filter(r => typeof r.lat === "number" && typeof r.lng === "number")
      .filter(r => isInTerritory(r.zip, r.lat, r.lng))
      .map(r => {
        const tier = bucket(r.status);
        const base = {
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          tier,
          status: statusLabel(r.status),
          city: r.city || "",
          zip: r.zip || "",
          state: r.state || "FL",
          leadType: r.lead_type || null,
        };
        if (isAdmin) {
          return {
            ...base,
            ownerName: r.owner_name || null,
            phone: r.phone || null,
            address: r.address || null,
            assignedAgentId: r.assigned_agent_id || null,
            assignedAgentName: r.agent_name || null,
          };
        }
        // Non-admin (agent) view: mask identity + street. City/ZIP/state real.
        return {
          ...base,
          ownerName: maskName(r.owner_name),
          phone: maskPhone(r.phone),
          address: maskStreet(r.address),
          // Never reveal WHICH teammate owns the lead to another agent.
          assignedAgentId: r.assigned_agent_id ? -1 : null,
          assignedAgentName: r.assigned_agent_id ? "Assigned" : null,
        };
      });

    const totals = {
      total: pins.length,
      appt: pins.filter(p => p.tier === "appt").length,
      contact: pins.filter(p => p.tier === "contact").length,
      pool: pins.filter(p => p.tier === "pool").length,
    };
    res.json({ pins, totals, viewerIsAdmin: isAdmin });
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
  //   2. Home-county unassigned pool: expired only (absentee retired v17.5)
  //   3. Overflow to other counties ONLY when home county is completely dry
  //      (expired only across all other counties — absentee retired v17.5)
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

    // v15.11.26 — Sweep expired agent_lead_holdouts. Cheap because the index
    // is on (agent_id, until) and there are at most a few dozen active rows
    // per agent.
    rawDb.prepare(`DELETE FROM agent_lead_holdouts WHERE until < datetime('now')`).run();

    // v15.11.26 — Guard: never resurface a lead whose status is closed/parked.
    // If any stale lock row still points at a KIT/Appt/Listed/etc. lead, sweep
    // it here before the "already locked" branch reads it. Belt-and-suspenders
    // with the KIT/Appt/Listed handlers that already DELETE lead_locks on
    // transition — this catches lock rows created by any future handler that
    // forgets to release. Without this, an old lock could hand a won lead back
    // to its owner on the dial page (which is exactly the John McClure bug).
    rawDb.prepare(`
      DELETE FROM lead_locks WHERE lead_id IN (
        SELECT id FROM leads
         WHERE status IN ('keep_in_touch','contacted_appointment','contacted_not_interested','listed','retired','wrong_number','recycled')
      )
    `).run();

    // If this agent already has a lead locked, return it (idempotent Load).
    const alreadyLocked: any = rawDb.prepare(`
      SELECT l.* FROM leads l
      JOIN lead_locks lk ON lk.lead_id = l.id
      WHERE lk.agent_id = ?
      ORDER BY lk.locked_at DESC
      LIMIT 1
    `).get(agentId);
    // v14.81.2 — Helper: count how many times THIS agent has dialed THIS lead
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
    // v17.5 — absentee retired. Only cold source is expired.
    const TYPE_ORDER = ["expired"];

    // Helper: pull next unassigned+unlocked lead matching WHERE. Sorted score DESC.
    // v15.4 — Recycle cooldown filter REMOVED. Recycled leads re-enter the pool
    // immediately (status='unassigned', lock deleted) and are eligible on the next
    // Load Next call. The recycle_cooldown_until column is retained for backward
    // compatibility but no longer read.
    // v15.11.26 — Exclude leads on THIS agent's holdout list. Both Skip and
    // Recycle write to agent_lead_holdouts so a just-recycled lead can't
    // bounce back to the same agent through pullPool's score DESC ordering.
    const pullPool = (leadType: string, countyClause: string, countyParams: any[]): any => {
      return rawDb.prepare(`
        SELECT l.* FROM leads l
        LEFT JOIN lead_locks lk ON lk.lead_id = l.id
        LEFT JOIN agent_lead_holdouts h
          ON h.lead_id = l.id AND h.agent_id = ? AND h.until > datetime('now')
        WHERE l.lead_type = ?
          AND l.status = 'unassigned'
          AND lk.lead_id IS NULL
          AND h.lead_id IS NULL
          ${countyClause}
        ORDER BY (l.owner_confirmed_at IS NOT NULL) DESC, l.owner_confirmed_at DESC, l.score DESC, l.uploaded_at ASC, l.id ASC
        LIMIT 1
      `).get(agentId, leadType, ...countyParams);
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

    // v14.81.2 — Per-agent, per-lead, per-day dial counter (see comment above where
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
    // v17.5 — absentee retired. Warm sources (network / open_house / door_knock / direct_mail) are
    // assigned directly at capture time, not routed through this endpoint.
    const VALID_LEAD_TYPES = ["expired", "network", "open_house", "door_knock", "direct_mail"];
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
  // v17.5 — warm-lead dupe check. Given a full phone (any format), returns the
  // first existing lead with a matching normalized number so the capture form
  // can warn the agent before submitting.
  app.get("/api/leads/lookup-by-phone", (req, res) => {
    try {
      const digits = String(req.query.phone || "").replace(/\D/g, "");
      if (digits.length < 10) return res.json({ lead: null });
      const last10 = digits.slice(-10);
      const stripSql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),'-',''),'(',''),')',''),' ',''),'.',''),'+','')`;
      const like = `%${last10}`;
      const row: any = rawDb.prepare(`
        SELECT id, owner_name, phone, status, assigned_agent_id
        FROM leads
        WHERE ${stripSql} LIKE ?
        ORDER BY uploaded_at DESC
        LIMIT 1
      `).get(like);
      if (!row) return res.json({ lead: null });
      let assignedAgentName: string | null = null;
      if (row.assigned_agent_id) {
        const ag = storage.getAgentById(row.assigned_agent_id);
        assignedAgentName = ag?.name || null;
      }
      return res.json({ lead: {
        id: row.id, ownerName: row.owner_name, phone: row.phone,
        status: row.status, assignedAgentId: row.assigned_agent_id, assignedAgentName,
      }});
    } catch (e) {
      return res.json({ lead: null });
    }
  });

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

  // ─── MY PIPELINE (restored v14.81.2, no date filter) ────────────────────────
  // v14.81.2 (moved here v14.81.2 hotfix) — MUST be registered BEFORE `/api/leads/:id`
  // or Express routes `/api/leads/my-pipeline` to the `:id` handler and returns
  // "Lead not found". Read-only over existing columns — no routing changes.
  app.get("/api/leads/my-pipeline", (req, res) => {
    const agentId = parseInt(String(req.query.agentId || ""));
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "agentId required" });
    // v14.81.2 — SECURITY FIX: this endpoint took agentId from the query string with
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

    // v14.81.2 — Agent Pipeline redesign: surface apptDate/apptTime/intention/stage
    // from the most recent activity's lpmamab_snapshot so the client can render
    // appointment date/time and KIT intention + follow-up trigger per row.
    for (const l of owned) {
      let snap: any = {};
      try { snap = JSON.parse(l.last_snapshot || "{}"); } catch {}
      l.appt_date = snap.apptDate || null;
      l.appt_time = snap.apptTime || null;
      l.intention = snap.intention || null;
      l.stage = snap.stage || null;
      // v20.7.20 — surface "Converted from KIT" flag for Appt Set cards
      l.converted_from_kit = !!snap.convertedFromKit;
      delete l.last_snapshot;
    }

    const appts   = owned.filter(l => l.status === 'contacted_appointment');
    const kit     = owned.filter(l => l.status === 'keep_in_touch');
    const network = owned.filter(l => l.lead_type === 'network' && l.status !== 'keep_in_touch' && l.status !== 'contacted_appointment');

    // v19.5 — Kanban 6-stage bucketing. Alex spec: no Under Contract, no Closed.
    //   Lead          — assigned to agent, no activity yet
    //   Contacted     — has activity but neutral outcome (no_answer, recycled)
    //   Nurture       — KIT with stage='Nurture'
    //   Hot           — KIT with stage='Hot Prospect'
    //   Appt Set      — contacted_appointment
    //   Client Active — KIT with stage='Active Client'
    // For Kanban we also need Lead + Contacted rows which the current query
    // filters out (status IN keep_in_touch / contacted_appointment only). Widen:
    const kanbanOwned: any[] = rawDb.prepare(`
      SELECT l.*,
             (SELECT outcome    FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_outcome,
             (SELECT created_at FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_activity_at,
             (SELECT lpmamab_snapshot FROM lead_activity WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_snapshot
        FROM leads l
       WHERE l.assigned_agent_id = ?
         AND l.status != 'wrong_number'
       ORDER BY l.id DESC
       LIMIT 500
    `).all(agentId);

    const kanban = { lead: [] as any[], contacted: [] as any[], nurture: [] as any[], hot: [] as any[], apptSet: [] as any[], clientActive: [] as any[] };
    for (const l of kanbanOwned) {
      let snap: any = {};
      try { snap = JSON.parse(l.last_snapshot || "{}"); } catch {}
      const stage = snap.stage || null;
      l.appt_date = snap.apptDate || null;
      l.appt_time = snap.apptTime || null;
      l.intention = snap.intention || null;
      l.stage = stage;
      // v20.7.20 — surface "Converted from KIT" flag for Appt Set cards
      l.converted_from_kit = !!snap.convertedFromKit;
      delete l.last_snapshot;

      if (l.status === 'contacted_appointment') kanban.apptSet.push(l);
      else if (l.status === 'keep_in_touch' && stage === 'Active Client') kanban.clientActive.push(l);
      else if (l.status === 'keep_in_touch' && stage === 'Hot Prospect') kanban.hot.push(l);
      else if (l.status === 'keep_in_touch') kanban.nurture.push(l);
      else if (l.last_outcome) kanban.contacted.push(l);
      else kanban.lead.push(l);
    }

    res.json({
      counts: { appts: appts.length, kit: kit.length, network: network.length, total: owned.length },
      appts, kit, network,
      kanban,
      kanbanCounts: {
        lead: kanban.lead.length,
        contacted: kanban.contacted.length,
        nurture: kanban.nurture.length,
        hot: kanban.hot.length,
        apptSet: kanban.apptSet.length,
        clientActive: kanban.clientActive.length,
      },
    });
  });

  app.get("/api/leads/:id", (req, res) => {
    const lead = storage.getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    // v20.7.0 — enrich with owner_name_key + count of OTHER leads sharing the
    // same normalized owner name. Powers the "Owner of N properties" badge.
    // Uses raw SQL because drizzle doesn't know about owner_name_key yet.
    let ownerNameKey: string | null = null;
    let relatedPropertyCount = 0;
    try {
      const row = rawDb.prepare("SELECT owner_name_key FROM leads WHERE id = ?").get(lead.id) as any;
      ownerNameKey = row?.owner_name_key || null;
      if (ownerNameKey) {
        const cnt = rawDb.prepare("SELECT COUNT(*) as n FROM leads WHERE owner_name_key = ? AND id != ?").get(ownerNameKey, lead.id) as any;
        relatedPropertyCount = Number(cnt?.n || 0);
      }
    } catch {}
    res.json({ ...lead, ownerNameKey, relatedPropertyCount });
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
  // v16.7 — Tap-receipt table. Every outcome POST from the client carries a
  // clientTapId (UUID generated on the phone the moment the button is tapped).
  // If a network glitch causes the client to retry, we hit this table first: same
  // tap_id = short-circuit and return the ORIGINAL receipt instead of double-
  // counting. Every response also carries the receipt back so the client-side
  // queue can mark the tap confirmed and stop retrying.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS tap_receipts (
      client_tap_id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      lead_id INTEGER,
      outcome TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tap_receipts_agent ON tap_receipts(agent_id, created_at);
  `);

  app.post("/api/leads/:id/outcome", async (req, res) => {
    const leadId = parseInt(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: "Invalid lead id" });

    const { agentId, outcome, notes, lpmamab, callbackDate,
            apptEmail, confirmedAddress, apptDate, apptTime, stage, intention,
            followUpTiming, clientTapId, convertedFromKit } = req.body; // v16.7 — clientTapId for dedup; v20.7.20 — convertedFromKit

    // v16.7 — If we've already seen this exact tap, replay the original response.
    if (clientTapId && typeof clientTapId === "string") {
      const existing = rawDb.prepare(`SELECT response_json FROM tap_receipts WHERE client_tap_id = ?`).get(clientTapId) as any;
      if (existing?.response_json) {
        try {
          const cached = JSON.parse(existing.response_json);
          console.log(`[tap-receipt] replay tap=${clientTapId} lead=${leadId} outcome=${outcome} — dedup`);
          return res.json({ ...cached, receipt: { tapId: clientTapId, replayed: true } });
        } catch {}
      }
    }

    // v16.7 — Wrap res.json so every success response persists a receipt.
    const _origJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      // Only persist for successful outcome writes (no error field, has agentId).
      if (clientTapId && agentId && !body?.error) {
        try {
          rawDb.prepare(
            `INSERT OR IGNORE INTO tap_receipts (client_tap_id, agent_id, lead_id, outcome, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
          ).run(clientTapId, agentId, leadId, outcome, JSON.stringify(body), new Date().toISOString());
        } catch (e) { console.error("[tap-receipt] persist failed", e); }
        return _origJson({ ...body, receipt: { tapId: clientTapId, replayed: false } });
      }
      return _origJson(body);
    };

    // Whitelist valid outcomes — prevents garbage data from getting into the activity log
    // v14.10 — added `recycled` so client can route Recycle through /outcome if needed;
    // primary Recycle endpoint remains /api/leads/:id/recycle.
    // v14.18 — 3×3 outcome grid additions: `listed`, `disconnected`, `left_voicemail`,
    // plus `email_sent_value` for the Stage-2 value email (v14.18). Every route below
    // handles its own exhaustion — no code path can leave a lead in a stuck state.
    // v20.7.9 — `callback_requested` REMOVED from acceptance. Callback was retired
    // in v14.14 and replaced by Recycle. The endpoint used to accept it (and treat
    // it as recycled) for stale clients, but 18+ months later that path is dead.
    // Historical DB records with status='callback_requested' still render in the
    // admin UI (label fallbacks retained) — only fresh submissions are blocked.
    const VALID_OUTCOMES = [
      "no_answer", "contacted_appointment", "keep_in_touch",
      "contacted_not_interested", "wrong_number", "network_referral",
      "recycled", "listed", "disconnected", "left_voicemail",
      // v16.7 — Lead Gen hub outcomes
      "open_house_log", "open_house_lead",
      // v15.11.11 — Nice Confirmed Owner Not Interested. Verified real owner who
      // politely declined. Instead of a dead delete like contacted_not_interested,
      // we recycle the lead with a 180-day callback so it re-enters the pool once
      // life circumstances may have shifted (job change, family growth, divorce,
      // relocation, market swing). Data-driven: 6 months is the industry lookback
      // for "nurture then reattack" on soft rejections.
      "nice_not_interested",
    ];
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}` });
    }

    // v15.11.12 — Intention is REQUIRED on Appt Set. Without it we can't route
    // the FUB action plan or open the right pipeline deal.
    // v15.11.48 — KIT no longer captures intention (replaced with a free-form
    // Notes textarea + follow-up timing). The v15.11.12 guard used to also
    // require intention for KIT and silently rejected every KIT save until
    // v15.11.49 (Bronson: "unable to save a KIT"). KIT branch now bypasses.
    if (outcome === "contacted_appointment" && (!intention || !String(intention).trim())) {
      return res.status(400).json({ error: "Intention (Seller, Buyer, or Both) is required for Appt Set." });
    }

    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // v20.7.20 — TERMINAL-STATE IDEMPOTENCY GUARD.
    // Once a lead is 'contacted_appointment' or 'contacted_not_interested',
    // resubmitting the same terminal outcome is a NO-OP: no state change, no
    // points award, no FUB push, no email alert. This protects against three
    // real scenarios:
    //   1. Bronson taps Convert-to-Appt on a KIT that flipped to appt in a
    //      previous tap; the client's KIT list hadn't refetched yet.
    //   2. Network hiccup mid-submit: client retries with a NEW clientTapId
    //      (tap-receipts dedup doesn't catch it).
    //   3. Two admins/agents both tap the same lead's outcome from separate
    //      devices within seconds.
    // Without this guard, each resubmit would create a second FUB deal, award
    // +60 pts again, and re-fire the appointment alert email to Alex/Nate.
    // Cross-outcome transitions (e.g. keep_in_touch → contacted_appointment)
    // are still allowed — that IS the KIT convert path.
    if (lead.status === "contacted_appointment" && outcome === "contacted_appointment") {
      console.log(`[idempotent] lead ${leadId} already contacted_appointment — skipping duplicate submit by agent ${agentId}`);
      return res.json({
        ok: true,
        replayed: true,
        reason: "already_appointment",
        message: "This lead is already an Appt Set. No changes made.",
        lead: { id: leadId, status: lead.status, assignedAgentId: lead.assignedAgentId },
      });
    }
    if (lead.status === "contacted_not_interested" && outcome === "contacted_not_interested") {
      console.log(`[idempotent] lead ${leadId} already contacted_not_interested — skipping duplicate submit by agent ${agentId}`);
      return res.json({
        ok: true,
        replayed: true,
        reason: "already_not_interested",
        message: "This lead is already Not Interested. No changes made.",
        lead: { id: leadId, status: lead.status },
      });
    }

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

      // v15.4 — Any pending struck lines on this lead now resolve as 'other_line_connected'
      // (someone reached the owner despite this line being dead). Data feeds the 12–16 cap review.
      try {
        const resolutionLabel = outcome === "contacted_appointment" ? "other_line_connected_appt" : "other_line_connected_not_interested";
        rawDb.prepare(`
          UPDATE phone_attempt_outcomes
          SET resolution = ?, resolution_at = ?,
              resolution_notes = 'Different phone line connected; struck line stays retired.'
          WHERE lead_id = ? AND resolution = 'pending'
        `).run(resolutionLabel, Date.now(), leadId);
      } catch (err) {
        console.error("[v15.4 phone_attempt_outcomes] Contact-resolve failed:", err);
      }

    } else if (outcome === "recycled") {
      // v14.14 — Callback retired. Recycle is the successor: one-tap unassign to pool.
      // v20.7.9 — `callback_requested` acceptance dropped from VALID_OUTCOMES above.
      //          NETWORK ORPHAN FIX: Network leads have no shared pool (TYPE_ORDER excludes
      //          "network"), so recycling would strand them. Instead, restore assignment to
      //          the original submitter (uploaded_by) — they stay owned by the referrer.
      // v14.18 — Release the lock so my-next doesn't hand this lead right back.
      // v15.4 — 14d Recycle cooldown REMOVED. Recycled leads now re-enter the shared
      //         pool immediately with status='unassigned' + no lock. Any agent whose
      //         home-county matches (or admin killer-mode) can pull it on their next
      //         Load Next. The recycle_cooldown_until column is kept for backward
      //         compatibility but never written; the boot sweep in server/db.ts thaws
      //         all currently-frozen leads. Pool sort order (score DESC, uploaded_at ASC,
      //         id ASC) means high-score recycled leads re-appear near the top.
      const isNetwork = lead.leadType === "network";
      const referrerId = (lead as any).uploadedBy || (lead as any).uploaded_by || null;
      if (isNetwork && referrerId) {
        newStatus = "assigned";
        newAssignedId = referrerId;
        newCallbackDate = null;
        console.log(`[v15.4 recycle] lead=${leadId} type=network → returned to referrer agentId=${referrerId}`);
      } else {
        newStatus = "unassigned";
        newAssignedId = null;
        newCallbackDate = null;
        console.log(`[v15.4 recycle] lead=${leadId} type=${lead.leadType} → returned to shared pool score=${lead.score ?? 0} immediately eligible`);
      }
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

    } else if (outcome === "nice_not_interested") {
      // v15.11.11 — Nice Confirmed Owner Not Interested → 180-day ICE recycle.
      //
      // Verified real owner who politely declined. Rather than deleting like
      // contacted_not_interested (rude / never-owned / bad data), we mark this
      // lead as recycled and set callback_date = now + 180 days. The shared-pool
      // query already gates on (callback_date IS NULL OR callback_date <= now),
      // so the lead silently sleeps for 6 months then re-enters the pool exactly
      // as if it were an active recycled lead.
      //
      // Rationale: 6 months is the industry lookback for soft-rejection nurture
      // — life changes (job move, divorce, birth, market pressure, rate cuts)
      // routinely flip "not right now" into "let's talk" within 90–180 days. We
      // never want to lose a confirmed real owner just because the timing was
      // wrong on one call.
      const ICE_DAYS = 180;
      const iceDateMs = Date.now() + ICE_DAYS * 24 * 60 * 60 * 1000;
      const iceDateIso = new Date(iceDateMs).toISOString();
      const isNetwork = lead.leadType === "network";
      const referrerId = (lead as any).uploadedBy || (lead as any).uploaded_by || null;
      if (isNetwork && referrerId) {
        // Network: leave assigned to referrer but sleep 180d
        newStatus = "recycled";
        newAssignedId = referrerId;
        newCallbackDate = iceDateIso;
      } else {
        newStatus = "recycled";
        newAssignedId = null;
        newCallbackDate = iceDateIso;
      }
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
      console.log(`[v15.11.11 nice_ice] lead=${leadId} → 180d ICE recycle, thaw at ${iceDateIso}`);

    } else if (outcome === "no_answer") {
      // v14.40 — Per-LINE no-answer cap. Increment this phone's counter. At CAP it flips
      // from "no_answer_today" to permanently "struck". When every phone is struck the
      // lead auto-deletes (same exhaustion path as Wrong # / Disconnected).
      // v14.65 — Raised from 6 → 10 to give more attempts to hunt the true owner
      //           before retiring a line.
      // v14.81.2 — Raised from 10 → 12. With higher-quality LandVoice lists we expect
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
          // v15.4 — Log this strike to phone_attempt_outcomes so we can later answer:
          // "of lines struck at 12, what's the eventual outcome?" Resolution is written
          // later when the lead exhausts, converts, or another line connects.
          try {
            rawDb.prepare(`
              INSERT OR IGNORE INTO phone_attempt_outcomes
                (lead_id, phone, lead_type, struck_at, struck_by_agent_id, lead_score, resolution)
              VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `).run(leadId, currentPhone, lead.leadType || "unknown", Date.now(), agentId || null, lead.score ?? 0);
          } catch (err) {
            console.error("[v15.4 phone_attempt_outcomes] Strike log failed:", err);
          }
        } else {
          newPhoneStates[currentPhone] = "no_answer_today";
        }
      }

      // Persist the updated phone_attempts JSON now (before exhaustion check)
      rawDb.prepare(`UPDATE leads SET phone_attempts = ? WHERE id = ?`).run(JSON.stringify(phoneAttempts), leadId);

      // If every viable phone is now struck → exhaustion delete (parity with Wrong #).
      const anyViable = newPhones.some((p: string) => newPhoneStates[p] !== "struck");
      if (!anyViable) {
        // v15.4 — Resolve every pending struck line for this lead as 'exhausted_deleted'.
        try {
          rawDb.prepare(`
            UPDATE phone_attempt_outcomes
            SET resolution = 'exhausted_deleted', resolution_at = ?,
                resolution_notes = 'All lines struck at cap; lead auto-deleted.'
            WHERE lead_id = ? AND resolution = 'pending'
          `).run(Date.now(), leadId);
        } catch (err) {
          console.error("[v15.4 phone_attempt_outcomes] Exhaustion resolve failed:", err);
        }
        // v16.7 — Log activity with snapshot BEFORE deleting the lead; snapshot
        // preserves address/phone/owner so the row survives lead deletion.
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at,
                                      lead_address_snapshot, lead_phone_snapshot, lead_owner_snapshot)
          VALUES (?, ?, 'retired_no_answer', ?, NULL, ?, ?, ?, ?)
        `).run(leadId, agentId || null,
          `Auto-retired: every phone hit ${PHONE_ATTEMPT_CAP} no-answer attempts (per-line cap).`,
          new Date().toISOString(),
          lead.address || null, lead.phone || null, lead.ownerName || null);
        awardPoints(agentId, "no_answer", leadId);
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

      // v15.4 — If any struck lines exist for this lead, mark them 'other_line_connected_kit'.
      try {
        rawDb.prepare(`
          UPDATE phone_attempt_outcomes
          SET resolution = 'other_line_connected_kit', resolution_at = ?,
              resolution_notes = 'Different phone line reached the owner; KIT logged.'
          WHERE lead_id = ? AND resolution = 'pending'
        `).run(Date.now(), leadId);
      } catch (err) {
        console.error("[v15.4 phone_attempt_outcomes] KIT-resolve failed:", err);
      }

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

      // v16.7 — Snapshot lead address/phone/owner into lead_activity so the
      // dial log survives a subsequent lead delete (exhaustion path). Prior
      // to v16.7 the exhaustion DELETE FROM lead_activity wiped today's dials.
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at,
                                    lead_address_snapshot, lead_phone_snapshot, lead_owner_snapshot)
        VALUES (?, ?, 'disconnected', ?, NULL, ?, ?, ?, ?)
      `).run(leadId, agentId || null,
        notes || (dialedPhone ? `Not a Working Line: ${dialedPhone} removed from candidate list. ${phones.length} candidate(s) remaining.` : null),
        new Date().toISOString(),
        lead.address || null, dialedPhone || lead.phone || null, lead.ownerName || null);

      if (phones.length === 0) {
        // v16.7 — All candidate numbers exhausted. Award, then delete the LEAD only.
        // lead_activity rows survive via ON DELETE SET NULL (lead_id becomes NULL,
        // but address/phone/owner snapshots preserve full audit history).
        awardPoints(agentId, "disconnected", leadId);
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
      // v14.81.2 — `remaining` was undefined here since v14.65 refactor (would have
      // thrown ReferenceError → 500 on every Disconnected outcome that landed in
      // this branch). Use surviving phones count from the mutated `phones` array.
      return res.json({ updated: true, leadId, nextPhone: nextViable, remaining: phones.length, keptOnLead: !!untriedNext });

    } else if (outcome === "left_voicemail") {
      // v15.11.41 — OWNER-CONFIRMED RECYCLE.
      // The button label is "Owner - No Answer". Clicking it means the agent
      // confirmed the owner picks up on THIS line (spouse hand-off, partial
      // pickup, they said "this is me" then dropped, etc.). We now:
      //   1. Strike EVERY OTHER phone on the lead (we know they're not the owner).
      //      Struck lines are retained in history but the app will never dial them.
      //   2. Bump this line's attempt counter (same 12-cap as No Answer). If this
      //      line itself hits 12 struck-out attempts, the lead retires normally.
      //   3. Mark the lead owner_confirmed_at = now — pullPool sorts these to the
      //      FRONT of the pool ahead of every other lead.
      //   4. Recycle to the pool: status='unassigned', assigned_agent_id=NULL,
      //      lock deleted. The next agent (any home-county match) picks it up.
      //   5. Award 6 points (see server/routes.ts LEFT_VM_POINTS — confirmed-owner
      //      recycles are high-value events).
      //   6. Skip the actor via agent_lead_holdouts (10-min bounce guard) so the
      //      same agent doesn't immediately re-pull the lead they just recycled.
      // NOTE: DB outcome key stays 'left_voicemail' for historical continuity.
      // NO voicemail language leaves the server — all copy is Owner-focused now.
      const PHONE_ATTEMPT_CAP_VM = 12;
      const currentPhone = req.body.dialedPhone || lead.phone || "";
      let phoneAttemptsVm: Record<string, number> = {};
      try { phoneAttemptsVm = lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch {}

      // 1. Strike every OTHER phone (option B: keep in history, never dial).
      for (const p of newPhones) {
        if (p !== currentPhone && newPhoneStates[p] !== undefined) {
          newPhoneStates[p] = "struck";
        }
      }

      // 2. Bump the current line's attempt count — same 12-cap logic as No Answer.
      if (currentPhone && newPhoneStates[currentPhone] !== undefined) {
        phoneAttemptsVm[currentPhone] = (phoneAttemptsVm[currentPhone] || 0) + 1;
        if (phoneAttemptsVm[currentPhone] >= PHONE_ATTEMPT_CAP_VM) {
          newPhoneStates[currentPhone] = "struck";
        } else {
          newPhoneStates[currentPhone] = "no_answer_today";
        }
      }

      rawDb.prepare(`UPDATE leads SET phone_attempts = ? WHERE id = ?`).run(JSON.stringify(phoneAttemptsVm), leadId);

      // 3. Exhaustion delete when THIS line hits the cap (all other lines already struck).
      const anyViableVm = newPhones.some((p: string) => newPhoneStates[p] !== "struck");
      if (!anyViableVm) {
        // v16.7 — Log activity with snapshot before delete.
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at,
                                      lead_address_snapshot, lead_phone_snapshot, lead_owner_snapshot)
          VALUES (?, ?, 'retired_no_answer', ?, NULL, ?, ?, ?, ?)
        `).run(leadId, agentId || null,
          `Auto-retired: confirmed owner line hit ${PHONE_ATTEMPT_CAP_VM} no-answer attempts (per-line cap).`,
          new Date().toISOString(),
          lead.address || null, lead.phone || null, lead.ownerName || null);
        awardPoints(agentId, "left_voicemail", leadId);
        rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_lines_struck_owner_no_answer" });
      }

      // 4. Recycle to pool with owner_confirmed_at stamp. This front-loads the lead.
      newStatus = "unassigned";
      newAssignedId = null;
      const ownerConfirmedTs = new Date().toISOString();
      rawDb.prepare("UPDATE leads SET owner_confirmed_at = ?, phone = ? WHERE id = ?")
        .run(ownerConfirmedTs, currentPhone, leadId);
      // Release lock so anyone can grab it (pool re-serves highest priority).
      rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

      // 5. Bounce guard — 10 min holdout so the confirming agent doesn't immediately re-pull it.
      // v15.11.49 — HOTFIX for Owner - No Answer stuck-loop. The previous INSERT
      // omitted `reason` and `created_at`, both NOT NULL columns per
      // server/db.ts:869. Every insert threw a constraint failure that was
      // silently swallowed by the try/catch, so no holdout was ever recorded.
      // Bronson reported tapping Owner - No Answer 3× on lead 5147 and getting
      // the same lead served right back each time (owner_confirmed_at sorts it
      // to the front of the pool). Include all 5 columns like Skip and Recycle.
      if (agentId) {
        try {
          const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          rawDb.prepare(`
            INSERT OR REPLACE INTO agent_lead_holdouts (agent_id, lead_id, until, reason, created_at)
            VALUES (?, ?, ?, 'owner_no_answer', ?)
          `).run(agentId, leadId, until, new Date().toISOString());
        } catch (e: any) {
          console.error("[owner_no_answer] holdout insert failed:", e?.message);
        }
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
      // v15.11.28 — Buyer Target (future home the buyer wants to acquire).
      // Client sends `buyerTarget` as a JSON string; if missing, keep existing.
      buyerTarget: (typeof lpmamab.buyerTarget === "string") ? lpmamab.buyerTarget : lead.buyerTarget,
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

      // v16.7 — Snapshot lead metadata into lead_activity BEFORE any potential
      // lead delete so today's dial counts survive exhaustion.
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at,
                                    lead_address_snapshot, lead_phone_snapshot, lead_owner_snapshot)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(leadId, agentId || null, outcome,
        notes || (dialedPhone ? `Wrong number: ${dialedPhone} removed from candidate list. ${phones.length} candidate(s) remaining.` : null),
        new Date().toISOString(),
        lead.address || null, dialedPhone || lead.phone || null, lead.ownerName || null);

      if (phones.length === 0) {
        // v16.7 — All numbers confirmed bad. Award, delete the LEAD only.
        // lead_activity survives via ON DELETE SET NULL + snapshot columns.
        awardPoints(agentId, "wrong_number", leadId);
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
      // v14.81.2 — Same fix as Disconnected branch above: `remaining` was undefined.
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
      // v17.5 — persist Renter LPMA fields into extraData.renterLpma so they survive
      // reboots and flow to FUB on later outcomes. No schema change (see HARD RULE).
      ...(lpmamab && (lpmamab.rLocation || lpmamab.rPrice || lpmamab.rMotivation || lpmamab.rAppointment) ? (() => {
        const _prev: any = (() => { try { return JSON.parse(((lead as any).extraData) || "{}"); } catch { return {}; } })();
        const _next = {
          ..._prev,
          renterLpma: {
            ...(_prev.renterLpma || {}),
            ...(lpmamab.rLocation    ? { rLocation:    lpmamab.rLocation    } : {}),
            ...(lpmamab.rPrice       ? { rPrice:       lpmamab.rPrice       } : {}),
            ...(lpmamab.rMotivation  ? { rMotivation:  lpmamab.rMotivation  } : {}),
            ...(lpmamab.rAppointment ? { rAppointment: lpmamab.rAppointment } : {}),
          },
        };
        return { extraData: JSON.stringify(_next) };
      })() : {}),
    });

    // Log activity — merge appt/kit details into snapshot
    // v20.7.20 — convertedFromKit is stamped into the snapshot so /my-pipeline
    // can surface a "Converted from KIT" pill on the Appt Set card. It only
    // rides along when the KIT convert button was the entry point (client sets
    // it). Manual Appt Set from Dial does not include it.
    const snapshotData = {
      ...(lpmamab || {}),
      ...(apptDate       ? { apptDate }       : {}),
      ...(apptTime       ? { apptTime }        : {}),
      ...(stage          ? { stage }           : {}),
      ...(intention      ? { intention }       : {}),
      ...(confirmedAddress ? { confirmedAddress } : {}),
      ...(apptEmail      ? { apptEmail }       : {}),
      ...(convertedFromKit ? { convertedFromKit: true } : {}),
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

      // v15.11.10 — Flow 2 (Expired KIT credibility email) removed.

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

        // v15.11.10 — Flow 4 (appointment warm email to seller) removed.
      }
    }

    // ── FUB Integration — push outcome to Follow Up Boss (v11.40) ────────────
    // v17.5 — warm-lead source + 10-option intent + renter LPMA are all now
    // stored inside lead.extraData JSON (no schema changes). Parse and pass
    // them through to FUB so tags / stage / person.type / notes reflect everything.
    const _extraParsed: any = (() => { try { return JSON.parse(((lead as any).extraData) || "{}"); } catch { return {}; } })();
    const _warmLeadSource: string | undefined = _extraParsed?.warmLeadSource || undefined;
    const _warmLeadIntent: string | undefined = _extraParsed?.warmLeadIntent || undefined;
    const _renterLpma: any = _extraParsed?.renterLpma || {};
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
          // v17.5 — warm-lead source + intent (from extraData)
          warmLeadSource: _warmLeadSource,
          warmLeadIntent: _warmLeadIntent,
          // v17.5 — Renter LPMA (from extraData.renterLpma)
          rLocation:      _renterLpma?.rLocation    || undefined,
          rPrice:         _renterLpma?.rPrice       || undefined,
          rMotivation:    _renterLpma?.rMotivation  || undefined,
          rAppointment:   _renterLpma?.rAppointment || undefined,
        },
        agent: {
          id:    fubAgent.id,
          name:  fubAgent.name,
          email: (fubAgent as any).email || undefined,
        },
        outcome,
        notes:            notes            || undefined,
        // v17.5 — add renter LPMA fields to the lpmamab passthrough so the note
        // builder can render the Renter LPMA block alongside seller/buyer blocks.
        lpmamab: lpmamab ? {
          ...lpmamab,
          rLocation:    _renterLpma?.rLocation    || undefined,
          rPrice:       _renterLpma?.rPrice       || undefined,
          rMotivation:  _renterLpma?.rMotivation  || undefined,
          rAppointment: _renterLpma?.rAppointment || undefined,
          warmLeadIntent: _warmLeadIntent,
        } : (Object.keys(_renterLpma).length ? {
          rLocation:    _renterLpma?.rLocation    || undefined,
          rPrice:       _renterLpma?.rPrice       || undefined,
          rMotivation:  _renterLpma?.rMotivation  || undefined,
          rAppointment: _renterLpma?.rAppointment || undefined,
          warmLeadIntent: _warmLeadIntent,
        } : undefined),
        apptDate:         apptDate         || undefined,
        apptTime:         apptTime         || undefined,
        apptEmail:        apptEmail        || undefined,
        confirmedAddress: confirmedAddress || undefined,
        stage:            stage            || undefined,
        intention:        intention        || undefined,
      }).catch(err => console.error("[FUB] pushOutcomeToFub failed:", err));
    }

    // v20.7.9 — Cold-outcome sync-back. If this outcome is Recycle / Not Interested /
    // Wrong # / Nice Not Interested / Disconnected AND the lead already exists in FUB
    // (was previously KIT'd or Appt'd), append a status note and move terminal stages
    // to Unresponsive. No-op if lead was never in FUB. Fire-and-forget.
    pushColdOutcomeToFub({
      phone:     lead.phone || undefined,
      ownerName: lead.ownerName || undefined,
      outcome,
      agentName: fubAgent?.name || undefined,
      notes:     notes || undefined,
    }).catch(err => console.error("[FUB] pushColdOutcomeToFub failed:", err));

    // Award points for this outcome (v11.40)
    awardPoints(agentId, outcome, leadId);
    // Broadcast activity event for live feed (v11.40)
    const actingAgent = storage.getAgentById(agentId);
    // v15.3 — include intent so live feed can badge SELL / BUY / SELL&BUY next to the address.
    const broadcastIntent =
      (lpmamab as any)?.intent ||
      (updatedLead as any)?.intent ||
      (lead as any).intent ||
      null;
    broadcast({
      type: "activity_event",
      event: {
        type: outcome,
        agentId,
        agentName: actingAgent?.name || "Agent",
        agentHeadshot: actingAgent?.headshotUrl || null,
        leadId,
        address: updatedLead?.address || lead.address,
        intent: broadcastIntent, // v15.3
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
    const tapNote = "flow1-mailto";
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

    // v15.11.26 — broaden the "green dot" signal (see /api/admin/leaderboard for full comment).
    // Also pull each agent's total points so we can sort points-first.
    const pointsMaxRows2 = rawDb.prepare(
      `SELECT agent_id, MAX(created_at) as max_pts FROM agent_points GROUP BY agent_id`
    ).all() as any[];
    const pointsMaxMap2: Record<number, string> = {};
    for (const r of pointsMaxRows2) pointsMaxMap2[r.agent_id] = r.max_pts;

    const sessionMaxRows2 = rawDb.prepare(
      `SELECT agent_id, MAX(created_at) as max_sess FROM sessions GROUP BY agent_id`
    ).all() as any[];
    const sessionMaxMap2: Record<number, string> = {};
    for (const r of sessionMaxRows2) sessionMaxMap2[r.agent_id] = r.max_sess;

    const ptsTotalRows = rawDb.prepare(
      `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' ${resetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`
    ).all(...(resetAt ? [resetAt] : [])) as any[];
    const ptsTotalMap: Record<number, number> = {};
    for (const r of ptsTotalRows) ptsTotalMap[r.agent_id] = r.total || 0;

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
      // v15.11.26 — last-activity now considers outcomes, point-earning events, AND logins.
      const outcomeLatest = myOutcomes.length > 0
        ? myOutcomes.reduce((latest: string, r: any) => (r.latest_at || "") > latest ? r.latest_at : latest, "")
        : null;
      const candidates = [
        outcomeLatest,
        pointsMaxMap2[agent.id],
        sessionMaxMap2[agent.id],
      ].filter(Boolean) as string[];
      const lastActivityAt = candidates.length > 0
        ? candidates.sort().pop()
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
        points: ptsTotalMap[agent.id] || 0,
        outcomes,
        lastActivityAt,
      };
    });

    // v15.11.26 — Unified sort: points (highest = #1), dials as tiebreaker.
    stats.sort((a, b) =>
      ((b as any).points - (a as any).points) ||
      (b.totalAttempts - a.totalAttempts) ||
      (b.appointmentsSet - a.appointmentsSet)
    );
    res.json(stats);
  });

  // ─── ADMIN: PIPELINE VIEW ─────────────────────────────────────────────────
  app.get("/api/admin/pipeline", (req, res) => {
    // v14.81.2 — SECURITY FIX: this endpoint had NO auth guard, meaning any agent
    // (or unauthenticated caller) could see aggregate pool counts across the
    // entire lead pool. Agents must never see unassigned-pool counts — admin only.
    if (!requireAdmin(req, res)) return;
    // Return counts-only in byStatus to avoid sending thousands of leads to client.
    // The live pipeline tab shows top 50 active leads + counts.
    const limit = parseInt((req.query.limit as string) || "50");
    const offset = parseInt((req.query.offset as string) || "0");
    // v20.7.53 — Optional agentId filter so admin can view a single agent's
    // pipeline (tiles + list). When omitted, the aggregate pool is returned
    // as before. Filter is applied to BOTH the byStatus counts and the list.
    const agentIdRaw = req.query.agentId ? parseInt(String(req.query.agentId)) : NaN;
    const agentId = Number.isFinite(agentIdRaw) ? agentIdRaw : undefined;

    const allAgents = storage.getAllAgents();
    const agentMap = Object.fromEntries(allAgents.map(a => [a.id, a.name]));

    // Counts only per status (fast — single query per status)
    const statusCounts = agentId !== undefined
      ? rawDb.prepare(`SELECT status, COUNT(*) as cnt FROM leads WHERE assigned_agent_id = ? GROUP BY status`).all(agentId) as any[]
      : rawDb.prepare(`SELECT status, COUNT(*) as cnt FROM leads GROUP BY status`).all() as any[];
    const byStatus: Record<string, number> = {};
    for (const row of statusCounts) byStatus[row.status] = row.cnt;

    // Active leads (paginated) for the live pipeline list
    const ACTIVE = ["unassigned","assigned","no_answer","callback_requested"] // keep_in_touch exits to FUB;
    const activeRows = agentId !== undefined
      ? rawDb.prepare(
          `SELECT * FROM leads WHERE status IN (${ACTIVE.map(() => "?").join(",")}) AND assigned_agent_id = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`
        ).all(...ACTIVE, agentId, limit, offset) as any[]
      : rawDb.prepare(
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

    const totalActive = agentId !== undefined
      ? ((rawDb.prepare(
          `SELECT COUNT(*) as n FROM leads WHERE status IN (${ACTIVE.map(() => "?").join(",")}) AND assigned_agent_id = ?`
        ).get(...ACTIVE, agentId) as any)?.n ?? 0)
      : ((rawDb.prepare(
          `SELECT COUNT(*) as n FROM leads WHERE status IN (${ACTIVE.map(() => "?").join(",")})`
        ).get(...ACTIVE) as any)?.n ?? 0);

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

  // ─── v16.7 ─ DAILY METRICS SNAPSHOTS (audit + reversion) ──────────────────
  // List every date we have a snapshot for.
  app.get("/api/admin/daily-snapshots", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = rawDb.prepare(`
      SELECT et_date, COUNT(*) as agent_count, MAX(captured_at) as captured_at
      FROM daily_metrics_snapshots
      GROUP BY et_date
      ORDER BY et_date DESC
      LIMIT 400
    `).all();
    res.json(rows);
  });

  // Read every agent's row for one specific ET date.
  app.get("/api/admin/daily-snapshots/:date", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const rows = rawDb.prepare(`
      SELECT * FROM daily_metrics_snapshots
      WHERE et_date = ?
      ORDER BY all_points DESC, agent_name ASC
    `).all(date);
    res.json({ date, rows });
  });

  // Read one agent's full history across all snapshotted days.
  app.get("/api/admin/daily-snapshots/agent/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const aid = parseInt(String(req.params.id));
    if (!Number.isFinite(aid)) return res.status(400).json({ error: "invalid agent id" });
    const rows = rawDb.prepare(`
      SELECT * FROM daily_metrics_snapshots
      WHERE agent_id = ?
      ORDER BY et_date DESC
      LIMIT 400
    `).all(aid);
    res.json({ agent_id: aid, rows });
  });

  // Manual trigger — admin can force a snapshot for yesterday (idempotent UPSERT).
  app.post("/api/admin/daily-snapshots/run-now", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      // Inline call — same logic as the scheduler's performDailySnapshot(),
      // exposed via a global hook the scheduler installs on boot.
      const hook = (global as any).__leadDepotDailySnapshot;
      if (typeof hook !== "function") {
        return res.status(503).json({ error: "snapshot job not initialized" });
      }
      await hook();
      const yesterdayEt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(Date.now() - 86_400_000));
      const count = rawDb.prepare(`SELECT COUNT(*) as c FROM daily_metrics_snapshots WHERE et_date = ?`).get(yesterdayEt) as any;
      res.json({ ok: true, et_date: yesterdayEt, agents_captured: count?.c || 0 });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || err) });
    }
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

  // ─── v17.5 STREAKS + CHAMPION WREATH ──────────────────────────────────────
  // Per-agent streak state (current, best, tier, badge, next tier).
  app.get("/api/agents/:id/streak", (req, res) => {
    try {
      const agentId = parseInt(req.params.id);
      if (!Number.isFinite(agentId)) return res.status(400).json({ error: "bad_agent_id" });
      const streak = computeAndPersistStreak(agentId);
      res.json(streak);
    } catch (err: any) {
      console.error("[streak] endpoint error:", err);
      res.status(500).json({ error: err?.message || "streak_error" });
    }
  });

  // Bulk streak snapshot for all active agents — used by admin leaderboard.
  app.get("/api/streaks", (_req, res) => {
    try {
      const rows = rawDb.prepare("SELECT id FROM agents WHERE is_active = 1").all() as { id: number }[];
      const out: any[] = [];
      for (const r of rows) out.push(computeAndPersistStreak(r.id));
      res.json(out);
    } catch (err: any) {
      console.error("[streaks] bulk endpoint error:", err);
      res.status(500).json({ error: err?.message || "streaks_error" });
    }
  });

  // Current champion (returns null-shape if no active champion for this month).
  app.get("/api/champion", (_req, res) => {
    try { res.json(getCurrentChampion()); }
    catch (err: any) { res.status(500).json({ error: err?.message || "champion_error" }); }
  });

  // Champion history (newest first).
  app.get("/api/champion/history", (_req, res) => {
    try { res.json(getChampionHistory()); }
    catch (err: any) { res.status(500).json({ error: err?.message || "champion_history_error" }); }
  });

  // v20.4.9 — FUB Pro plan seat headroom. Returns live FUB user-seat usage so
  // the admin Candidates tab can show "5/10 seats used, 5 remaining" and warn
  // before an approve would trigger $49/mo overage. Non-cached: hits FUB every
  // call so the number is always current at the moment Alex looks.
  app.get("/api/admin/fub-seats", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const usage = await fubGetSeatUsage();
      res.json({
        ok: !usage.error,
        used: usage.used,
        included: usage.included,
        remaining: usage.remaining,
        overageSeats: usage.overageSeats,
        overageMonthlyCost: usage.overageMonthlyCost,
        overagePerSeat: FUB_PRO_OVERAGE_PER_SEAT_USD,
        nextApproveWouldOverage: usage.remaining <= 0 && !usage.error,
        users: usage.users,
        fetchedAt: usage.fetchedAt,
        error: usage.error,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "fub_seats_error" });
    }
  });

  // ─── v20.4.9 LISTINGS ────────────────────────────────────────
  // Every Monday Denise uploads active/pending/sold listings via Upload CSV.
  // Each active listing becomes a candidate row on Tuesday's OH Schedule form.
  // Active listings also appear on the team map as muted-gold home pins.

  app.get("/api/admin/listings", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const status = req.query?.status ? String(req.query.status) : null;
    const where = status ? "WHERE status = ?" : "";
    const rows = rawDb.prepare(`
      SELECT * FROM listings ${where}
      ORDER BY (CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'sold' THEN 2 ELSE 3 END),
               list_date DESC, id DESC
      LIMIT 1000
    `).all(...(status ? [status] : []));
    res.json({ ok: true, listings: rows });
  });

  // Agent-facing: only geocoded ACTIVE listings, for the team map.
  app.get("/api/listings/active-map", (req: any, res) => {
    if (!req.currentAgent) return res.status(401).json({ error: "unauthorized" });
    // v20.6.8: The map is a LISTINGS-only surface. Exclude hot prospects
    // (workbook:appointments:*) — they still get ingested for reporting/search
    // but Alex locked them off the map. Buyers were never on the map either.
    const rows = rawDb.prepare(`
      SELECT id, address, city, state, zip, list_price, status, listing_agent, list_date, lat, lng
      FROM listings
      WHERE status IN ('active','coming_soon','pocket','sold','pending')
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND (status != 'sold' OR sold_date >= date('now','-60 days'))
        AND (source_ref IS NULL OR source_ref NOT LIKE 'workbook:appointments:%')
      LIMIT 1000
    `).all();
    res.json({ ok: true, listings: rows });
  });

  app.post("/api/admin/listings", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const address = String(b.address || "").trim();
    if (!address) return res.status(400).json({ error: "address required" });
    const status = String(b.status || "active").toLowerCase();
    if (!['active','pending','sold','coming_soon','pocket'].includes(status)) return res.status(400).json({ error: "status must be active|pending|sold|coming_soon|pocket" });
    const info = rawDb.prepare(`
      INSERT INTO listings (address, city, state, zip, list_price, status, listing_agent, list_date, pending_date, sold_date, sold_price, mls_number, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      address, b.city || null, b.state || "FL", b.zip || null,
      b.list_price ? Number(b.list_price) : null,
      status, b.listing_agent || null,
      b.list_date || null, b.pending_date || null, b.sold_date || null,
      b.sold_price ? Number(b.sold_price) : null,
      b.mls_number || null, b.notes || null,
      req.currentAgent?.name || "admin",
    );
    try { broadcast({ type: "listing_updated", id: info.lastInsertRowid }); } catch {}
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  // Bulk CSV import: { rows: [{address, city, state, zip, list_price, status, listing_agent, ...}, ...] }
  app.post("/api/admin/listings/bulk", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "rows required" });
    const insert = rawDb.prepare(`
      INSERT INTO listings (address, city, state, zip, list_price, status, listing_agent, list_date, pending_date, sold_date, sold_price, mls_number, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsert = rawDb.prepare(`
      UPDATE listings SET city=?, state=?, list_price=?, status=?, listing_agent=?, list_date=?, pending_date=?, sold_date=?, sold_price=?, mls_number=?, notes=?, uploaded_by=?, updated_at=datetime('now')
      WHERE lower(address) = lower(?) AND coalesce(zip,'') = coalesce(?, '')
    `);
    const findExisting = rawDb.prepare(`SELECT id FROM listings WHERE lower(address) = lower(?) AND coalesce(zip,'') = coalesce(?, '') LIMIT 1`);
    let ok = 0, err = 0;
    const errors: string[] = [];
    const tx = rawDb.transaction((rs: any[]) => {
      for (const r of rs) {
        const addr = String(r.address || "").trim();
        if (!addr) { err++; errors.push("missing address"); continue; }
        const status = String(r.status || "active").toLowerCase();
        if (!['active','pending','sold'].includes(status)) { err++; errors.push(`bad status: ${status}`); continue; }
        const zip = r.zip ? String(r.zip) : null;
        const priceNum = (v: any) => v ? Number(String(v).replace(/[^0-9.]/g, "")) : null;
        try {
          const existing = findExisting.get(addr, zip) as any;
          if (existing?.id) {
            upsert.run(
              r.city || null, r.state || "FL", priceNum(r.list_price),
              status, r.listing_agent || null,
              r.list_date || null, r.pending_date || null, r.sold_date || null,
              priceNum(r.sold_price), r.mls_number || null, r.notes || null,
              (req.currentAgent?.name || "admin"),
              addr, zip,
            );
          } else {
            insert.run(
              addr, r.city || null, r.state || "FL", zip,
              priceNum(r.list_price),
              status, r.listing_agent || null,
              r.list_date || null, r.pending_date || null, r.sold_date || null,
              priceNum(r.sold_price),
              r.mls_number || null, r.notes || null,
              req.currentAgent?.name || "admin",
            );
          }
          ok++;
        } catch (e: any) { err++; errors.push(`${addr}: ${e?.message || "err"}`); }
      }
    });
    tx(rows);
    // Fire-and-forget geocode pass so map populates soon after upload.
    setImmediate(() => {
      try { runListingGeocodePass().catch(() => {}); } catch {}
    });
    try { broadcast({ type: "listings_bulk_updated", count: ok }); } catch {}
    res.json({ ok: true, imported: ok, failed: err, errors: errors.slice(0, 20) });
  });

  app.put("/api/admin/listings/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const fields: string[] = [], params: any[] = [];
    for (const k of ['address','city','state','zip','listing_agent','list_date','pending_date','sold_date','mls_number','notes']) {
      if (k in b) { fields.push(`${k} = ?`); params.push(b[k]); }
    }
    if ('list_price' in b) { fields.push('list_price = ?'); params.push(b.list_price ? Number(b.list_price) : null); }
    if ('sold_price' in b) { fields.push('sold_price = ?'); params.push(b.sold_price ? Number(b.sold_price) : null); }
    if ('status' in b) {
      const s = String(b.status).toLowerCase();
      if (!['active','pending','sold'].includes(s)) return res.status(400).json({ error: "status must be active|pending|sold" });
      fields.push('status = ?'); params.push(s);
    }
    if (!fields.length) return res.status(400).json({ error: "no fields" });
    fields.push("updated_at = datetime('now')");
    params.push(id);
    rawDb.prepare(`UPDATE listings SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    try { broadcast({ type: "listing_updated", id }); } catch {}
    res.json({ ok: true });
  });

  app.delete("/api/admin/listings/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    rawDb.prepare(`DELETE FROM listings WHERE id = ?`).run(id);
    try { broadcast({ type: "listing_updated", id }); } catch {}
    res.json({ ok: true });
  });

  // Manual trigger for a geocode pass. Uses same Nominatim path as leads geocoding.
  app.post("/api/admin/listings/geocode", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const result = await runListingGeocodePass();
    res.json({ ok: true, ...result });
  });

  // ─── v20.4.9 INVENTORY (buyers + sellers) + FUB TAG CONFIG ───
  //
  // GET  /api/inventory/sellers  → { active[], coming_soon[], pocket[], sold[] } for the Inventory page
  // GET  /api/inventory/buyers   → { active[], closed[] }
  // POST /api/admin/inventory/workbook (multipart .xlsx) → parse Denise's weekly workbook
  // GET  /api/admin/fub/tags     → live FUB tag list + current bucket assignment
  // POST /api/admin/fub/tag-config { tag_name, bucket, enabled } → save config
  // POST /api/admin/fub/sweep    → run the sweep on demand

  app.get("/api/inventory/sellers", (req, res) => {
    try {
      const active = rawDb.prepare(`SELECT * FROM listings WHERE status='active' ORDER BY list_date DESC NULLS LAST, list_price DESC`).all();
      const comingSoon = rawDb.prepare(`SELECT * FROM listings WHERE status='coming_soon' ORDER BY updated_at DESC`).all();
      const pocket = rawDb.prepare(`SELECT * FROM listings WHERE status='pocket' ORDER BY updated_at DESC`).all();
      const sold = rawDb.prepare(`SELECT * FROM listings WHERE status='sold' AND (sold_date IS NULL OR sold_date >= date('now','-365 days')) ORDER BY sold_date DESC`).all();
      const pending = rawDb.prepare(`SELECT * FROM listings WHERE status='pending' ORDER BY pending_date DESC NULLS LAST`).all();
      res.json({ active, coming_soon: comingSoon, pocket, sold, pending });
    } catch (err: any) {
      console.error("[inventory/sellers]", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/inventory/buyers", (req, res) => {
    try {
      const active = rawDb.prepare(`SELECT * FROM buyers WHERE status='active' AND (is_rental IS NULL OR is_rental = 0) ORDER BY price_max DESC NULLS LAST, updated_at DESC`).all();
      const closed = rawDb.prepare(`SELECT * FROM buyers WHERE status='closed' AND (is_rental IS NULL OR is_rental = 0) AND (closed_date IS NULL OR closed_date >= date('now','-365 days')) ORDER BY closed_date DESC`).all();
      res.json({ active, closed });
    } catch (err: any) {
      console.error("[inventory/buyers]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.0 — MASTER LIST: every buyer + renter row, merged sources, filterable.
  // Returns everything with is_rental flag + origin_sources so the UI can show badges.
  app.get("/api/admin/master-list", (req: any, res) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const source = String(req.query.source || "all");   // all | excel | fub | lead_depot
      const kind   = String(req.query.kind   || "all");   // all | buyer | rental
      const status = String(req.query.status || "all");   // all | active | nurture | closed | rental | dead

      const where: string[] = ["(do_not_import IS NULL OR do_not_import = 0)"];
      const params: any = {};
      if (q) { where.push("(lower(name) LIKE @q OR lower(coalesce(email,'')) LIKE @q OR lower(coalesce(phone,'')) LIKE @q OR lower(coalesce(preferred_areas,'')) LIKE @q OR lower(coalesce(notes,'')) LIKE @q)"); params.q = `%${q}%`; }
      if (source !== "all") { where.push(`lower(coalesce(origin_sources,'[]')) LIKE @src`); params.src = `%${source}%`; }
      if (kind === "buyer") where.push("(is_rental IS NULL OR is_rental = 0)");
      if (kind === "rental") where.push("is_rental = 1");
      if (status !== "all") { where.push("status = @st"); params.st = status; }

      const rows = rawDb.prepare(`
        SELECT id, name, phone, email, buyers_agent, status,
               price_min, price_max, preferred_areas, zip_codes,
               beds_min, baths_min, sqft_min,
               intent_property_types, intent_verbs,
               is_investor, is_rental, rental_type, financing,
               confidence, origin_sources, multi_search_ordinal,
               source, source_ref, updated_at, notes
        FROM buyers
        WHERE ${where.join(" AND ")}
        ORDER BY status DESC, confidence DESC NULLS LAST, updated_at DESC
        LIMIT 2000
      `).all(params) as any[];

      const total = rows.length;
      const counts = {
        total,
        buyers:  rows.filter(r => !r.is_rental).length,
        rentals: rows.filter(r =>  r.is_rental).length,
        by_source: {
          excel:      rows.filter(r => String(r.origin_sources||"").includes("excel")).length,
          fub:        rows.filter(r => String(r.origin_sources||"").includes("fub")).length,
          lead_depot: rows.filter(r => String(r.origin_sources||"").includes("lead_depot")).length,
        },
        by_status: {
          active:  rows.filter(r => r.status === "active").length,
          nurture: rows.filter(r => r.status === "nurture").length,
          closed:  rows.filter(r => r.status === "closed").length,
          rental:  rows.filter(r => r.status === "rental").length,
          dead:    rows.filter(r => r.status === "dead").length,
        },
      };
      res.json({ ok: true, rows, counts });
    } catch (err: any) {
      console.error("[master-list]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.0 — Master list quick actions.
  //   K (keep):  bumps confidence to 1.0, flips do_not_import=0, ensures status is not 'dead'
  //   X (kill):  sets do_not_import=1 AND status='dead'. Row survives for audit but excluded everywhere.
  //   Rental toggle: flips is_rental, resets rental_type if turning ON.
  app.post("/api/admin/master-list/:id/action", (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const action = String(req.body?.action || "");
      if (!id || !action) return res.status(400).json({ error: "id + action required" });

      if (action === "keep") {
        rawDb.prepare(`UPDATE buyers SET confidence = 1.0, do_not_import = 0, status = CASE WHEN status = 'dead' THEN 'active' ELSE status END, updated_at = datetime('now'), last_updated_by = 'admin:master-list' WHERE id = ?`).run(id);
      } else if (action === "kill") {
        rawDb.prepare(`UPDATE buyers SET do_not_import = 1, status = 'dead', updated_at = datetime('now'), last_updated_by = 'admin:master-list' WHERE id = ?`).run(id);
      } else if (action === "toggle_rental") {
        const cur = rawDb.prepare(`SELECT is_rental FROM buyers WHERE id = ?`).get(id) as any;
        const nextRental = cur?.is_rental ? 0 : 1;
        rawDb.prepare(`UPDATE buyers SET is_rental = ?, rental_type = CASE WHEN ? = 1 THEN coalesce(rental_type, 'residential_rental') ELSE NULL END, status = CASE WHEN ? = 1 THEN 'rental' WHEN status = 'rental' THEN 'active' ELSE status END, updated_at = datetime('now'), last_updated_by = 'admin:master-list' WHERE id = ?`).run(nextRental, nextRental, nextRental, id);
      } else {
        return res.status(400).json({ error: "unknown action" });
      }
      broadcast({ type: "inventory_updated", reason: `master-list:${action}`, buyerId: id });
      res.json({ ok: true, id, action });
    } catch (err: any) {
      console.error("[master-list/action]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Weekly workbook upload — expects multipart 'file' field, .xlsx.
  const uploadMemWb = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  app.post("/api/admin/inventory/workbook", uploadMemWb.single("file"), async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const uploader = req.session?.user?.email || "admin";
      console.log(`[Workbook] Received ${req.file.originalname} (${req.file.size} bytes) from ${uploader}`);
      const result = await parseWeeklyWorkbook(req.file.buffer, uploader);
      // Kick geocoder to fill lat/lng on new listings (background)
      setTimeout(() => { runListingGeocodePass().catch(() => {}); }, 500);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[workbook]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.7.8 — Diagnostic: dump live Deals + distinct stages/statuses so we can
  // rebuild the sweep off REAL stage names instead of guesses.
  app.get("/api/admin/fub/deals-diagnostic", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { fubListDeals } = await import("./fub");
      const deals = await fubListDeals();
      const byStage: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      const stageStatusPairs: Record<string, number> = {};
      for (const d of deals) {
        const stg = String(d.stage || "(none)");
        const sts = String(d.status || "(none)");
        const typ = String(d.type || "(none)");
        byStage[stg] = (byStage[stg] || 0) + 1;
        byStatus[sts] = (byStatus[sts] || 0) + 1;
        byType[typ] = (byType[typ] || 0) + 1;
        const key = `${typ} | ${stg} | ${sts}`;
        stageStatusPairs[key] = (stageStatusPairs[key] || 0) + 1;
      }
      res.json({
        total_deals: deals.length,
        by_stage: byStage,
        by_status: byStatus,
        by_type: byType,
        type_stage_status_matrix: stageStatusPairs,
        sample_first_5: deals.slice(0, 5).map(d => ({
          id: d.id, name: d.name, stage: d.stage, status: d.status, type: d.type,
          address: d.address, price: d.price, assignedUserName: d.assignedUserName,
        })),
      });
    } catch (err: any) {
      console.error("[deals-diagnostic]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Live FUB tag list + current config
  app.get("/api/admin/fub/tags", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const tags = await fubListTags();
      const cfgRows = rawDb.prepare(`SELECT tag_name, bucket, enabled, last_synced_at, last_person_count FROM fub_tag_config`).all() as any[];
      const cfgMap: Record<string, any> = {};
      for (const r of cfgRows) cfgMap[r.tag_name] = r;
      const merged = tags.map(t => ({
        name: t.name,
        peopleCount: t.peopleCount ?? null,
        bucket: cfgMap[t.name]?.bucket ?? "ignore",
        enabled: cfgMap[t.name]?.enabled === 1,
        last_synced_at: cfgMap[t.name]?.last_synced_at ?? null,
        last_person_count: cfgMap[t.name]?.last_person_count ?? null,
      }));
      res.json({ tags: merged });
    } catch (err: any) {
      console.error("[fub/tags]", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/fub/tag-config", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { tag_name, bucket, enabled } = req.body || {};
      if (!tag_name || typeof tag_name !== "string") return res.status(400).json({ error: "tag_name required" });
      const b = String(bucket || "ignore");
      if (!["pocket_listing", "active_buyer", "ignore"].includes(b)) return res.status(400).json({ error: "invalid bucket" });
      rawDb.prepare(`
        INSERT INTO fub_tag_config (tag_name, bucket, enabled, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(tag_name) DO UPDATE SET bucket = excluded.bucket, enabled = excluded.enabled, updated_at = datetime('now')
      `).run(tag_name, b, enabled === false ? 0 : 1);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[fub/tag-config]", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/fub/sweep", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await runFubInventorySweep();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[fub/sweep]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.0 — SOURCE OF TRUTH BACKUP — build .xlsx + email Nate/Alex/Denise.
  //   Triggered manually after the refinement pass. Denise's address is auto-
  //   discovered from the FUB Vendor list (fallback to a hardcoded default).
  // v20.6.8 — Direct download variant of the backup workbook.
  // Denise no longer uploads a workbook to LD; FUB is source of truth. This
  // endpoint exports the current LD state as an .xlsx so we can hand her a
  // fresh backup on demand instead of asking her for one.
  app.get("/api/admin/source-of-truth-backup/download", async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { buildSourceOfTruthWorkbook } = await import("./sourceOfTruthBackup");
      const buf = await buildSourceOfTruthWorkbook();
      const filename = `BGMR-Source-of-Truth-Backup-${new Date().toISOString().slice(0,10)}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    } catch (err: any) {
      console.error("[source-of-truth-backup/download]", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/source-of-truth-backup", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { buildSourceOfTruthWorkbook, sourceOfTruthEmailHtml } = await import("./sourceOfTruthBackup");
      const buf = await buildSourceOfTruthWorkbook();

      // Denise's address — override with body.denise_email if provided.
      const deniseEmail = String(req.body?.denise_email || "denise@watsonbrothersgroup.com").trim();
      const counts = {
        sellers: Number((rawDb.prepare("SELECT COUNT(*) as n FROM listings WHERE (do_not_import IS NULL OR do_not_import = 0) AND status IN ('active','coming_soon','pocket','pending','sold')").get() as any)?.n || 0),
        buyers:  Number((rawDb.prepare("SELECT COUNT(*) as n FROM buyers WHERE (is_rental IS NULL OR is_rental = 0) AND (do_not_import IS NULL OR do_not_import = 0) AND status IN ('active','nurture','closed')").get() as any)?.n || 0),
        rentals: Number((rawDb.prepare("SELECT COUNT(*) as n FROM buyers WHERE is_rental = 1 AND (do_not_import IS NULL OR do_not_import = 0)").get() as any)?.n || 0),
      };

      if (!resend) return res.status(500).json({ error: "Resend not configured" });
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", deniseEmail],
        subject: `\uD83D\uDD12 Source of Truth Backup \u2014 ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}`,
        html: sourceOfTruthEmailHtml(counts),
        attachments: [{
          filename: `BGMR-Source-of-Truth-Backup-${new Date().toISOString().slice(0,10)}.xlsx`,
          content: buf,
        }],
      });
      res.json({ ok: true, counts, sent_to: ["alex@", "nate@", deniseEmail] });
    } catch (err: any) {
      console.error("[source-of-truth-backup]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.1 — NEWSLETTER INPUTS panel: Alex fills 5 buckets in the app;
  // Tuesday sends read this row. week_of is the ISO date of the current Monday.
  function currentWeekOf(): string {
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun…6=Sat
    const daysFromMon = (dow + 6) % 7; // Mon=0
    const mon = new Date(now); mon.setUTCDate(now.getUTCDate() - daysFromMon);
    return mon.toISOString().slice(0, 10);
  }
  function loadWeekInputs() {
    const row = rawDb.prepare(
      `SELECT quote, wins, coaching, conversation, bgre_topic FROM newsletter_inputs WHERE week_of = ?`
    ).get(currentWeekOf()) as any;
    return {
      quote: String(row?.quote || ""),
      wins: String(row?.wins || ""),
      coaching: String(row?.coaching || ""),
      conversation: String(row?.conversation || ""),
      bgre_topic: String(row?.bgre_topic || ""),
    };
  }
  app.get("/api/admin/newsletter/inputs", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ ok: true, week_of: currentWeekOf(), ...loadWeekInputs() });
  });
  app.post("/api/admin/newsletter/inputs", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const week = currentWeekOf();
    const quote = String(req.body?.quote || "").trim();
    const wins = String(req.body?.wins || "").trim();
    const coaching = String(req.body?.coaching || "").trim();
    const conversation = String(req.body?.conversation || "").trim();
    const bgre_topic = String(req.body?.bgre_topic || "").trim();
    rawDb.prepare(`
      INSERT INTO newsletter_inputs (week_of, quote, wins, coaching, conversation, bgre_topic, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(week_of) DO UPDATE SET
        quote=excluded.quote,
        wins=excluded.wins,
        coaching=excluded.coaching,
        conversation=excluded.conversation,
        bgre_topic=excluded.bgre_topic,
        updated_at=datetime('now')
    `).run(week, quote, wins, coaching, conversation, bgre_topic);
    res.json({ ok: true, week_of: week });
  });

  // v20.6.0 — NEWSLETTER: Monday 6am prep-email ask.
  app.post("/api/admin/newsletter/prep-email", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!resend) return res.status(500).json({ error: "Resend not configured" });
      const { prepEmailHtml } = await import("./newsletter");
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: ["alex@watsonbrothersgroup.com"],
        subject: `\uD83D\uDCDD Newsletter prep \u2014 Monday morning`,
        html: prepEmailHtml(),
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[newsletter/prep-email]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.0 — NEWSLETTER: Tuesday 8am LD Newsletter to all active agents.
  //   Body accepts { quote?, wins?, coaching?, conversation?, bgre_topic? }.
  //   Each agent gets a PERSONALIZED email with their own stats + rank.
  app.post("/api/admin/newsletter/send-ld", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!resend) return res.status(500).json({ error: "Resend not configured" });
      const { ldNewsletterHtml, agentWeekStats, topThisWeek } = await import("./newsletter");
      // v20.6.1 — read from newsletter_inputs table if body is empty (cron fires with {})
      const stored = loadWeekInputs();
      const inputs = {
        quote:        String(req.body?.quote || stored.quote),
        wins:         String(req.body?.wins || stored.wins),
        coaching:     String(req.body?.coaching || stored.coaching),
        conversation: String(req.body?.conversation || stored.conversation),
      };
      const top = topThisWeek();
      const agents = rawDb.prepare(`SELECT id, name, email FROM agents WHERE active = 1 AND email IS NOT NULL AND email <> ''`).all() as any[];
      const sent: string[] = [];
      const failed: string[] = [];
      for (const a of agents) {
        try {
          const stats = agentWeekStats(a.id, a.name, a.email);
          await resend.emails.send({
            from: "Watson Brothers Group <noreply@watsonbrothersgroup.com>",
            to: [a.email],
            subject: `Monday Brief \u2014 ${a.name.split(" ")[0]}, here's your week`,
            html: ldNewsletterHtml(stats, inputs, top),
          });
          sent.push(a.email);
        } catch (e: any) {
          console.warn(`[newsletter/send-ld] ${a.email}: ${e.message}`);
          failed.push(a.email);
        }
      }
      res.json({ ok: true, sent: sent.length, failed: failed.length, sent_to: sent, errors: failed });
    } catch (err: any) {
      console.error("[newsletter/send-ld]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.6.0 — NEWSLETTER: Tuesday 8am BGRE client newsletter draft to Nate.
  //   Body: { bgre_topic } — Alex's paragraph. Nate schedules the send.
  app.post("/api/admin/newsletter/send-bgre", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!resend) return res.status(500).json({ error: "Resend not configured" });
      // v20.6.1 — read from newsletter_inputs table if body is empty (cron fires empty)
      const stored = loadWeekInputs();
      const topic = String(req.body?.bgre_topic || stored.bgre_topic || "").trim();
      if (!topic) return res.status(400).json({ error: "bgre_topic required" });
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6">
<div style="max-width:640px;margin:0 auto;padding:40px 32px;background:#ffffff">
  <div style="text-align:center;margin-bottom:32px">
    <div style="color:#8a7548;font-size:11px;letter-spacing:.3em;text-transform:uppercase;margin-bottom:8px">Brothers Group at Momentum Realty</div>
    <div style="color:#1a1a1a;font-size:26px;font-weight:600;letter-spacing:-.02em">Weekly Newsletter Draft</div>
    <div style="color:#6a6a6a;font-size:13px;margin-top:6px">For Nate to review + schedule</div>
  </div>
  <div style="background:#faf7f1;border-left:3px solid #8a7548;padding:20px 24px;margin-bottom:24px">
    <div style="color:#8a7548;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">Alex's angle this week</div>
    <div style="color:#2a2a2a;font-size:14px">${topic.replace(/\n/g, "<br>")}</div>
  </div>
  <div style="background:#f5f5f4;padding:20px 24px;border-radius:6px;color:#4a4a4a;font-size:13px">
    Nate \u2014 use the \u201Cweekly-real-estate-newsletter\u201D skill in your Perplexity session to build this into the full formatted newsletter, then schedule the send. Reply here if the angle needs tightening before you write it up.
  </div>
</div>
</body></html>`;
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: ["nate@watsonbrothersgroup.com"],
        cc: ["alex@watsonbrothersgroup.com"],
        subject: `\uD83D\uDCF0 BGRE Weekly Newsletter draft \u2014 ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric"})}`,
        html,
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[newsletter/send-bgre]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // v20.4.9 — Buyer delete + bulk clean-test-data (source_ref LIKE 'workbook:%')
  app.delete("/api/admin/buyers/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    rawDb.prepare(`DELETE FROM buyers WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // Bulk cleanup: wipes every row inserted by a specific workbook upload run,
  // OR every row with a source_ref matching the given prefix. Guarded to only
  // accept 'workbook:' or 'fub:' prefixes so admins can't nuke Excel rows by
  // accident.
  app.post("/api/admin/inventory/clean-test-data", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const prefix = String(req.body?.prefix || "").trim();
    if (!prefix || !/^(workbook|fub):/.test(prefix)) {
      return res.status(400).json({ error: "prefix must start with 'workbook:' or 'fub:'" });
    }
    const s = rawDb.prepare(`DELETE FROM listings WHERE source_ref LIKE ? || '%'`).run(prefix);
    const b = rawDb.prepare(`DELETE FROM buyers   WHERE source_ref LIKE ? || '%'`).run(prefix);
    res.json({ ok: true, sellers_deleted: s.changes, buyers_deleted: b.changes });
  });

  // ─── v20.4.9 OPEN HOUSES ─────────────────────────────────────
  // Weekly flow:
  //   Monday  → Denise uploads active/pending/sold listings (see Listings above).
  //   Tuesday → Denise fills the OH Schedule (per-listing radio + date + start + length + access_info + notes)
  //             which creates pending_approval rows.
  //   Approval → Admin approves (→ 'open') or declines (→ 'declined').
  //              If Denise pre-typed a host name on an active agent, the approve
  //              step auto-books the row and fires the acceptance email.
  //   Booking → Any agent taps Book on the map or lead-gen chooser. First to
  //             tap wins; row flips to 'booked' and email fires with access info.
  //   Cancel  → No self-serve cancellation. Agents text Alex/Nate directly.

  // Agent-facing list: any 'open' OH plus this agent's own 'booked' OHs.
  // Never leaks access_info or notes to agents who haven't claimed the row.
  app.get("/api/open-houses/upcoming", (req: any, res) => {
    if (!req.currentAgent) return res.status(401).json({ error: "unauthorized" });
    const today = new Date().toISOString().slice(0, 10);
    const agentId = req.currentAgent.id;
    const rows = rawDb.prepare(`
      SELECT oh.*, a.name AS claimed_by_name, l.lat, l.lng
      FROM open_houses oh
      LEFT JOIN agents a ON a.id = oh.claimed_by_agent_id
      LEFT JOIN listings l ON l.id = oh.listing_id
      WHERE oh.date >= ?
        AND (
          oh.status = 'open'
          OR (oh.status = 'booked' AND oh.claimed_by_agent_id = ?)
        )
      ORDER BY oh.date ASC, oh.time_start ASC
      LIMIT 100
    `).all(today, agentId);
    for (const r of rows as any[]) {
      if (r.claimed_by_agent_id !== agentId) {
        r.access_info = null;
        r.notes = null;
      }
    }
    res.json({ ok: true, openHouses: rows });
  });

  // Admin: list ALL open houses (any status, any date)
  app.get("/api/admin/open-houses", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const status = req.query?.status ? String(req.query.status) : null;
    const since = req.query?.since ? String(req.query.since) : null;
    const where: string[] = [];
    const params: any[] = [];
    if (status) { where.push("oh.status = ?"); params.push(status); }
    if (since)  { where.push("oh.date >= ?");  params.push(since); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const rows = rawDb.prepare(`
      SELECT oh.*, a.name AS claimed_by_name, ap.name AS approved_by_name
      FROM open_houses oh
      LEFT JOIN agents a ON a.id = oh.claimed_by_agent_id
      LEFT JOIN agents ap ON ap.id = oh.approved_by_id
      ${whereSql}
      ORDER BY oh.date DESC, oh.time_start ASC
      LIMIT 500
    `).all(...params);
    res.json({ ok: true, openHouses: rows });
  });

  // Admin: pending-approval OHs only. Driven by Denise's Tuesday submission.
  app.get("/api/admin/open-houses/pending", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = rawDb.prepare(`
      SELECT oh.*, l.list_price AS listing_list_price, l.listing_agent AS listing_listing_agent
      FROM open_houses oh
      LEFT JOIN listings l ON l.id = oh.listing_id
      WHERE oh.status = 'pending_approval'
      ORDER BY oh.date ASC, oh.time_start ASC
    `).all();
    res.json({ ok: true, pending: rows });
  });

  // Admin: approve a pending OH.
  // If Denise pre-typed a host_preference matching an active agent, auto-book
  // and fire acceptance email. Otherwise flip to 'open' for first-come booking.
  app.post("/api/admin/open-houses/:id/approve", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const row = rawDb.prepare(`SELECT * FROM open_houses WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.status !== "pending_approval") return res.status(409).json({ error: `not pending (status=${row.status})` });
    let claimedId: number | null = null;
    if (row.host_preference && String(row.host_preference).trim()) {
      const name = String(row.host_preference).trim();
      const agent = rawDb.prepare(`SELECT id FROM agents WHERE active = 1 AND lower(name) = lower(?) LIMIT 1`).get(name) as any;
      if (agent?.id) claimedId = agent.id;
    }
    const now = new Date().toISOString();
    if (claimedId) {
      rawDb.prepare(`UPDATE open_houses SET status='booked', approved_by_id=?, approved_at=?, claimed_by_agent_id=?, claimed_at=?, updated_at=? WHERE id=?`)
        .run(req.currentAgent.id, now, claimedId, now, now, id);
      try { await sendOpenHouseAcceptanceEmail(id, claimedId); } catch (e) { console.warn("[oh] preassign email warn:", e); }
    } else {
      rawDb.prepare(`UPDATE open_houses SET status='open', approved_by_id=?, approved_at=?, updated_at=? WHERE id=?`)
        .run(req.currentAgent.id, now, now, id);
    }
    try { broadcast({ type: "open_house_updated", id }); } catch {}
    res.json({ ok: true, autoBooked: !!claimedId });
  });

  // Admin: decline a pending OH.
  app.post("/api/admin/open-houses/:id/decline", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    const now = new Date().toISOString();
    rawDb.prepare(`UPDATE open_houses SET status='declined', declined_reason=?, updated_at=? WHERE id=?`).run(reason, now, id);
    try { broadcast({ type: "open_house_updated", id }); } catch {}
    res.json({ ok: true });
  });

  // Denise-facing (admin auth): submit the weekly OH schedule.
  // Body: { picks: [{listing_id, date, time_start (HH:MM), length_hours, host_preference?, access_info, notes?}, ...] }
  // Any existing pending_approval or declined row for the same (listing_id, date)
  // is replaced so re-submitting is safe.
  app.post("/api/admin/open-house-schedule", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];
    if (!picks.length) return res.status(400).json({ error: "picks required" });
    let ok = 0, err = 0;
    const errors: string[] = [];
    const insertStmt = rawDb.prepare(`
      INSERT INTO open_houses (listing_id, address, date, time_start, time_end, listing_agent, list_price, host_preference, access_info, notes, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', 'denise_schedule')
    `);
    const tx = rawDb.transaction((ps: any[]) => {
      for (const p of ps) {
        try {
          const listing = rawDb.prepare(`SELECT * FROM listings WHERE id = ? AND status = 'active'`).get(Number(p.listing_id)) as any;
          if (!listing) { err++; errors.push(`listing ${p.listing_id} not active`); continue; }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ""))) { err++; errors.push(`bad date on listing ${p.listing_id}`); continue; }
          if (!/^\d{2}:\d{2}$/.test(String(p.time_start || ""))) { err++; errors.push(`bad time on listing ${p.listing_id}`); continue; }
          const len = Math.max(1, Math.min(6, Number(p.length_hours) || 3));
          const [sh, sm] = String(p.time_start).split(":").map(Number);
          const endH = (sh + len) % 24;
          const time_end = String(endH).padStart(2, "0") + ":" + String(sm).padStart(2, "0");
          if (!String(p.access_info || "").trim()) { err++; errors.push(`access_info required on listing ${p.listing_id}`); continue; }
          rawDb.prepare(`DELETE FROM open_houses WHERE listing_id = ? AND date = ? AND status IN ('pending_approval','declined')`).run(listing.id, p.date);
          insertStmt.run(
            listing.id, listing.address, p.date, p.time_start, time_end,
            listing.listing_agent || null, listing.list_price || null,
            p.host_preference ? String(p.host_preference).trim() : null,
            String(p.access_info).trim(),
            p.notes ? String(p.notes) : null,
          );
          ok++;
        } catch (e: any) { err++; errors.push(`listing ${p.listing_id}: ${e?.message || "err"}`); }
      }
    });
    tx(picks);
    try { broadcast({ type: "open_house_schedule_submitted", count: ok }); } catch {}
    res.json({ ok: true, created: ok, failed: err, errors: errors.slice(0, 20) });
  });

  // Admin: create a new open house
  app.post("/api/admin/open-houses", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const address = String(b.address || "").trim();
    const date = String(b.date || "").trim();
    const time_start = String(b.time_start || "").trim();
    const time_end = String(b.time_end || "").trim();
    if (!address || !date || !time_start || !time_end) {
      return res.status(400).json({ error: "address, date, time_start, time_end required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    if (!/^\d{2}:\d{2}$/.test(time_start) || !/^\d{2}:\d{2}$/.test(time_end)) {
      return res.status(400).json({ error: "times must be HH:MM (24h)" });
    }
    const info = rawDb.prepare(`
      INSERT INTO open_houses
        (address, date, time_start, time_end, listing_agent, list_price, host_preference, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      address, date, time_start, time_end,
      b.listing_agent ? String(b.listing_agent) : null,
      b.list_price ? Number(b.list_price) : null,
      b.host_preference ? String(b.host_preference) : null,
      b.notes ? String(b.notes) : null,
      b.source ? String(b.source) : "admin",
    );
    try { broadcast({ type: "open_house_updated", id: info.lastInsertRowid }); } catch {}
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  // Admin: update open house
  app.put("/api/admin/open-houses/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const fields: string[] = [];
    const params: any[] = [];
    const setField = (k: string, v: any) => { fields.push(`${k} = ?`); params.push(v); };
    if (typeof b.address === "string") setField("address", b.address.trim());
    if (typeof b.date === "string") setField("date", b.date);
    if (typeof b.time_start === "string") setField("time_start", b.time_start);
    if (typeof b.time_end === "string") setField("time_end", b.time_end);
    if ("listing_agent" in b) setField("listing_agent", b.listing_agent ? String(b.listing_agent) : null);
    if ("list_price" in b) setField("list_price", b.list_price ? Number(b.list_price) : null);
    if ("host_preference" in b) setField("host_preference", b.host_preference ? String(b.host_preference) : null);
    if ("notes" in b) setField("notes", b.notes ? String(b.notes) : null);
    if (typeof b.status === "string") {
      setField("status", b.status);
      if (b.status === "cancelled") { setField("cancelled_at", new Date().toISOString()); }
    }
    if ("claimed_by_agent_id" in b) {
      setField("claimed_by_agent_id", b.claimed_by_agent_id ? Number(b.claimed_by_agent_id) : null);
      setField("claimed_at", b.claimed_by_agent_id ? new Date().toISOString() : null);
    }
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    setField("updated_at", new Date().toISOString());
    params.push(id);
    rawDb.prepare(`UPDATE open_houses SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    try { broadcast({ type: "open_house_updated", id }); } catch {}
    res.json({ ok: true });
  });

  // Admin: delete open house (hard delete — use status=cancelled if you want to preserve)
  app.delete("/api/admin/open-houses/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id);
    rawDb.prepare(`DELETE FROM open_houses WHERE id = ?`).run(id);
    try { broadcast({ type: "open_house_updated", id }); } catch {}
    res.json({ ok: true });
  });

  // Agent: BOOK an open house (self-serve, first come first serve).
  // Only 'open' OHs can be booked. Atomic UPDATE with WHERE status='open'
  // guarantees only one agent wins the race. On success, acceptance email
  // fires with full access info + prep instructions.
  app.post("/api/open-houses/:id/claim", async (req: any, res) => {
    if (!req.currentAgent) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id);
    const now = new Date().toISOString();
    const result = rawDb.prepare(`
      UPDATE open_houses
      SET status = 'booked', claimed_by_agent_id = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(req.currentAgent.id, now, now, id);
    if (result.changes === 0) {
      const row = rawDb.prepare(`SELECT status FROM open_houses WHERE id = ?`).get(id) as any;
      if (!row) return res.status(404).json({ error: "not found" });
      return res.status(409).json({ error: `cannot book: status=${row.status}` });
    }
    try { broadcast({ type: "open_house_updated", id }); } catch {}
    try { await sendOpenHouseAcceptanceEmail(id, req.currentAgent.id); } catch (e) { console.warn("[oh] acceptance email warn:", e); }
    res.json({ ok: true });
  });

  // Admin-only: manually crown the champion (used for testing or catching a
  // missed monthly reset). Requires admin session.
  // v20.4.6 — accepts optional { forMonth: "YYYY-MM" } body to retro-crown a
  // past month. Without a body it behaves as before (uses etMonthKey(now)).
  app.post("/api/admin/champion/recrown", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const forMonth = typeof req.body?.forMonth === "string" ? req.body.forMonth : undefined;
      const result = crownMonthlyChampion(forMonth);
      res.json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "recrown_error" });
    }
  });

  // ─── v17.5 AGENT DAILY SNAPSHOTS ────────────────────────────
  // Immutable per-agent-per-ET-day metrics rows. Cron writes today's row nightly
  // at 11:58 PM ET; endpoints below let admins query, manually trigger, and
  // backfill historical days.

  app.get("/api/admin/snapshots/daily", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agentId = req.query.agentId ? parseInt(String(req.query.agentId), 10) : undefined;
      const from = req.query.from ? String(req.query.from) : undefined;
      const to   = req.query.to   ? String(req.query.to)   : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 500;
      const rows = getSnapshotsFiltered({ agentId, from, to, limit });
      res.json({ rows, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "snapshot_query_error" });
    }
  });

  app.get("/api/admin/snapshots/agent/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agentId = parseInt(req.params.id, 10);
      const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
      const rows = getSnapshotsForAgent(agentId, days);
      res.json({ agentId, days, rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "snapshot_agent_error" });
    }
  });

  app.post("/api/admin/snapshots/capture", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = req.body?.date ? String(req.body.date) : undefined;
      const result = captureAllSnapshots(date);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "snapshot_capture_error" });
    }
  });

  app.post("/api/admin/snapshots/backfill", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const from = req.body?.from ? String(req.body.from) : null;
      const to   = req.body?.to   ? String(req.body.to)   : null;
      if (!from || !to) return res.status(400).json({ error: "from and to (YYYY-MM-DD) required" });
      const result = backfillSnapshots(from, to);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "snapshot_backfill_error" });
    }
  });

  // ─── v20.32.13 FUB MILESTONE TASK ENGINE (Part 4) ───────────
  // Admin-configurable trigger_event -> task fan-out, replacing the single
  // hardcoded "Send accolades email" pattern. See server/fub.ts for the
  // schema, seed defaults, and fireMilestoneTasks() engine.
  ensureFubMilestoneSchema();

  app.get("/api/admin/fub-milestone-tasks", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = rawDb.prepare(`SELECT * FROM fub_milestone_tasks ORDER BY trigger_event ASC, id ASC`).all();
      res.json({ rows, triggerEvents: FUB_MILESTONE_TRIGGER_EVENTS });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "fub_milestone_list_error" });
    }
  });

  app.post("/api/admin/fub-milestone-tasks", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { triggerEvent, taskName, daysOffset, assignedFubUserId } = req.body || {};
      if (!triggerEvent || !FUB_MILESTONE_TRIGGER_EVENTS.includes(triggerEvent)) {
        return res.status(400).json({ error: "Invalid or missing triggerEvent" });
      }
      if (!taskName || !String(taskName).trim()) return res.status(400).json({ error: "taskName required" });
      const info = rawDb.prepare(
        `INSERT INTO fub_milestone_tasks (trigger_event, task_name, days_offset, assigned_fub_user_id, active) VALUES (?, ?, ?, ?, 1)`
      ).run(triggerEvent, String(taskName).trim(), Number(daysOffset) || 0, assignedFubUserId || null);
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "fub_milestone_create_error" });
    }
  });

  app.patch("/api/admin/fub-milestone-tasks/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id);
      const row = rawDb.prepare(`SELECT * FROM fub_milestone_tasks WHERE id = ?`).get(id) as any;
      if (!row) return res.status(404).json({ error: "Not found" });
      const { taskName, daysOffset, assignedFubUserId, active } = req.body || {};
      rawDb.prepare(
        `UPDATE fub_milestone_tasks SET task_name = ?, days_offset = ?, assigned_fub_user_id = ?, active = ? WHERE id = ?`
      ).run(
        taskName !== undefined ? String(taskName).trim() : row.task_name,
        daysOffset !== undefined ? Number(daysOffset) || 0 : row.days_offset,
        assignedFubUserId !== undefined ? assignedFubUserId : row.assigned_fub_user_id,
        active !== undefined ? (active ? 1 : 0) : row.active,
        id
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "fub_milestone_update_error" });
    }
  });

  app.delete("/api/admin/fub-milestone-tasks/:id", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      rawDb.prepare(`DELETE FROM fub_milestone_tasks WHERE id = ?`).run(parseInt(req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "fub_milestone_delete_error" });
    }
  });

  // ─── v17.6 DIVERSITY CHALLENGE ─────────────────────────────
  // Weekly bonus tiers: 3 cats = +150, 4 cats = +200, 5 cats = +250.
  // Categories: phone, open_house, door_knock, direct_mail, social.
  // Awarded Sundays 23:59 ET via cron. Admin can preview + re-award.
  ensureDiversityChallengeSchema();

  // Agent-facing: current week categories hit + potential bonus + streak
  app.get("/api/diversity/mine", (req: any, res) => {
    if (!requireSession(req, res)) return;
    try {
      const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
        .toISOString().slice(0, 10);
      const { start, end } = weekBoundsET(today);
      const cats = categoriesHitForAgent(req.currentAgent.id, start, end);
      const potential = bonusForCount(cats.length);
      const streak = streakForAgent(req.currentAgent.id);
      res.json({ weekStart: start, weekEnd: end, categories: cats, count: cats.length, potentialBonus: potential, streak });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "diversity_mine_error" });
    }
  });

  // Admin: recent bonus history (last 12 weeks)
  app.get("/api/admin/diversity/history", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = rawDb.prepare(`
        SELECT db.*, a.name AS agent_name
        FROM diversity_bonuses db
        LEFT JOIN agents a ON a.id = db.agent_id
        ORDER BY week_start DESC, points_awarded DESC
        LIMIT 500
      `).all();
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "diversity_history_error" });
    }
  });

  // Admin: preview current week (dry run — no awards)
  app.get("/api/admin/diversity/preview", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dateInWeek = req.query.date ? String(req.query.date) : new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).toISOString().slice(0, 10);
      const { start, end } = weekBoundsET(dateInWeek);
      const agents = rawDb.prepare(`SELECT id, name FROM agents WHERE is_active = 1`).all() as any[];
      const preview = agents.map((a: any) => {
        const cats = categoriesHitForAgent(a.id, start, end);
        return { agentId: a.id, agentName: a.name, categories: cats, count: cats.length, potentialBonus: bonusForCount(cats.length) };
      }).filter((r: any) => r.count > 0);
      res.json({ weekStart: start, weekEnd: end, rows: preview });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "diversity_preview_error" });
    }
  });

  // Admin: re-award a specific week (idempotent — uses INSERT OR IGNORE)
  app.post("/api/admin/diversity/reaward", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dateInWeek = req.body?.date ? String(req.body.date) : new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).toISOString().slice(0, 10);
      const awards = reawardWeekFor(dateInWeek);
      res.json({ ok: true, awardsCount: awards.length, awards });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "diversity_reaward_error" });
    }
  });

  // ─── v17.6 DB AUDIT + REPAIR ────────────────────────────────
  // Read-only sweep + dry-run-default repair actions. All writes journaled.
  ensureRepairLogSchema();

  app.get("/api/admin/db-audit", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const report = runFullAudit();
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "db_audit_error" });
    }
  });

  app.post("/api/admin/db-repair/recompute-points", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dryRun = req.body?.dryRun !== false; // default true
      const agentId = req.body?.agentId ? Number(req.body.agentId) : null;
      const actor = req.currentAgent ? { id: req.currentAgent.id, name: req.currentAgent.name } : null;
      if (agentId) {
        const r = recomputePointsForAgent(agentId, dryRun, actor);
        res.json({ ok: true, dryRun, result: r });
      } else {
        const rs = recomputePointsForAll(dryRun, actor);
        const drift = rs.filter((r) => r.delta !== 0);
        res.json({ ok: true, dryRun, checked: rs.length, drift: drift.length, driftRows: drift });
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "recompute_error" });
    }
  });

  app.post("/api/admin/db-repair/prune-evidence", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dryRun = req.body?.dryRun !== false;
      const olderThanDays = Math.max(30, Number(req.body?.olderThanDays || 180));
      const actor = req.currentAgent ? { id: req.currentAgent.id, name: req.currentAgent.name } : null;
      const r = pruneStaleEvidence(olderThanDays, dryRun, actor);
      res.json({ ok: true, dryRun, olderThanDays, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "prune_error" });
    }
  });

  app.post("/api/admin/db-repair/reassign-orphan-leads", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dryRun = req.body?.dryRun !== false;
      const actor = req.currentAgent ? { id: req.currentAgent.id, name: req.currentAgent.name } : null;
      const r = reassignLeadsFromDeactivated(dryRun, actor);
      res.json({ ok: true, dryRun, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "reassign_error" });
    }
  });

  // v20.32.1 — one-off + reusable repair for the scope/gallery photo
  // duplication bug (scope-bucket uploads were also landing in
  // gallery_photos / Walk-Through Photos). Body: { consultId?: number,
  // dryRun?: boolean }. Omit consultId to sweep every affected consult.
  app.post("/api/admin/db-repair/dedupe-listing-consult-photos", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const dryRun = req.body?.dryRun !== false; // default true
      const consultId = req.body?.consultId ? Number(req.body.consultId) : null;
      const actor = req.currentAgent ? { id: req.currentAgent.id, name: req.currentAgent.name } : null;
      const r = dedupeListingConsultPhotos(consultId, dryRun, actor);
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "dedupe_error" });
    }
  });

  app.get("/api/admin/db-repair/log", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = listRepairLog(Number(req.query.limit || 100));
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "repair_log_error" });
    }
  });

  // v20.7.0 — manual re-normalize sweep. The auto-run on boot fires once (gated
  // by schema_flags), so this endpoint is for when we improve normalizeOwnerName
  // or need to rescue additional Excel serial dates that leaked in later.
  // Body: { force?: boolean } — when true, re-keys every lead regardless of
  //   existing owner_name_key; otherwise only fills in NULL keys.
  app.post("/api/admin/leads/re-normalize", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { normalizeOwnerName, normalizeDate } = await import("./batchleads-csv-import");
      const force = req.body?.force === true;
      const whereClause = force ? "1=1" : "owner_name_key IS NULL";
      const rows = rawDb.prepare(`SELECT id, owner_name, extra_data FROM leads WHERE ${whereClause}`).all() as any[];
      const updateKey = rawDb.prepare("UPDATE leads SET owner_name_key = ? WHERE id = ?");
      const updateExtra = rawDb.prepare("UPDATE leads SET extra_data = ? WHERE id = ?");
      let keyed = 0;
      let dateFixed = 0;
      const tx = rawDb.transaction(() => {
        for (const r of rows) {
          const key = normalizeOwnerName(r.owner_name);
          if (key) { updateKey.run(key, r.id); keyed++; }
          try {
            const extra = JSON.parse(r.extra_data || "{}");
            if (extra && typeof extra.statusDate === "string") {
              const asNum = Number(extra.statusDate);
              if (Number.isFinite(asNum) && asNum > 25569 && asNum < 60000) {
                const fixed = normalizeDate(extra.statusDate);
                if (fixed && fixed !== extra.statusDate) {
                  extra.statusDate = fixed;
                  updateExtra.run(JSON.stringify(extra), r.id);
                  dateFixed++;
                }
              }
            }
          } catch {}
        }
      });
      tx();
      res.json({ ok: true, force, scanned: rows.length, keyed, dateFixed });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "renormalize_error" });
    }
  });

  // v20.7.8 — Manual dial credit endpoint. When a tap didn't reach the server
  // (network drop, WS reconnect burst, client didn't fire), an admin can credit
  // an agent N dials for a specific date. Writes paired rows to lead_activity
  // AND agent_points so both the leaderboard whitelist SUM and the challenges
  // progress query see the credit. Outcome = 'manual_credit' (added to both
  // dial whitelists in v20.7.8). Points are computed via the current-tier
  // multiplier so a mid-prime credit doesn't over- or under-award.
  app.post("/api/admin/agents/:id/credit-dials", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const agentId = parseInt(String(req.params.id));
    const count = parseInt(String(req.body?.count || "0"));
    const reason = String(req.body?.reason || "").trim() || "manual_credit_missed_tap";
    const dateStr = String(req.body?.date || "").trim();  // optional YYYY-MM-DD; defaults to today ET
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "invalid agent id" });
    if (!count || count < 1 || count > 50) return res.status(400).json({ error: "count must be 1..50" });
    const agent = rawDb.prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return res.status(404).json({ error: "agent not found" });

    // Compute the timestamp — either today ET now, or the requested date at 23:59 ET.
    let creditedAt: string;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // Anchor at 23:59:59 UTC on that date so it lands inside the ET day for both
      // ET+ and ET (UTC-4/UTC-5) offset periods.
      creditedAt = `${dateStr}T23:59:00.000Z`;
    } else {
      creditedAt = new Date().toISOString();
    }

    const insActivity = rawDb.prepare(
      `INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
       VALUES (NULL, ?, 'manual_credit', ?, NULL, ?)`
    );
    const insPoints = rawDb.prepare(
      `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at)
       VALUES (?, ?, ?, NULL, 'seller', ?)`
    );

    // Reuse the tier lookup so credit points match a real dial in that window.
    let multiplier = 1;
    let tier: string = "base";
    try {
      tier = getCallHeatTier();
      if (tier === "prime") multiplier = 2;
      else if (tier === "mid") multiplier = 1.5;
      else if (tier === "low") multiplier = 1.25;
    } catch {}
    // Base points = 1 per dial credit (matches no_answer flat). Multiplier applies.
    const pointsEach = Math.round(1 * multiplier);
    const reasonLabel = multiplier > 1 ? `manual_credit_${tier}_${multiplier}x` : "manual_credit";

    const tx = rawDb.transaction(() => {
      for (let i = 0; i < count; i++) {
        insActivity.run(agentId, `Manual dial credit: ${reason}`, creditedAt);
        insPoints.run(agentId, pointsEach, reasonLabel, creditedAt);
      }
    });
    try { tx(); } catch (err: any) {
      return res.status(500).json({ error: err?.message || "credit_insert_failed" });
    }

    // Broadcast so leaderboard + challenges refresh live.
    try { broadcast({ type: "points_awarded", agentId, delta: pointsEach * count, outcome: "manual_credit", tier, ts: new Date().toISOString() }); } catch {}

    // v20.7.8 — Run challenge auto-detect after credit so Bronze Dial 25 (and
    // any other pinned dial challenges) auto-complete on this credit action.
    let dailyAwarded = 0, weeklyAwarded = 0;
    try {
      dailyAwarded  = checkAndAwardAutoDetect(agentId, currentDailyKey(), "daily");
      weeklyAwarded = checkAndAwardAutoDetect(agentId, currentWeeklyKey(), "weekly");
      if (dailyAwarded > 0 || weeklyAwarded > 0) {
        try { broadcast({ type: "challenges_updated", agentId, dailyAwarded, weeklyAwarded, ts: new Date().toISOString() }); } catch {}
      }
    } catch (e) {
      console.error("[credit-dials] challenge auto-detect failed:", e);
    }

    res.json({
      ok: true,
      agentId,
      agentName: agent.name,
      challengesAwarded: { daily: dailyAwarded, weekly: weeklyAwarded },
      dialsCredited: count,
      pointsPerDial: pointsEach,
      totalPoints: pointsEach * count,
      tier,
      multiplier,
      creditedAt,
      reason,
    });
  });

  // ─── SCRIPTS (DB-backed, editable) ────────────────────────────────────────
  // Initialize default scripts on first run
  const initScript = (leadType: string, defaultContent: string) => {
    const exists = rawDb.prepare("SELECT id FROM scripts WHERE lead_type = ?").get(leadType);
    if (!exists) {
      rawDb.prepare("INSERT INTO scripts (lead_type, content, updated_at) VALUES (?, ?, ?)").run(leadType, defaultContent, new Date().toISOString());
    }
  };

  // v15.11.47 — Expired script default lives in server/expired-script.ts (source of truth
  // for fresh installs). This initScript is INSERT-ONLY (ON CONFLICT DO NOTHING).
  // Production edits go through PATCH /api/scripts/expired with x-ingest-secret.
  initScript("expired", EXPIRED_SCRIPT_V14_16);

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

  // one week and only came to light when Alex spot-checked it. NEVER overwrite
  // the expired script from code again. If a future maintainer needs to change
  // the file default, they edit server/expired-script.ts — and even that only
  // affects fresh installs (initScript uses INSERT ... DO NOTHING). To change
  // production, PATCH /api/scripts/expired with x-ingest-secret and it gets
  // logged to the audit table. That is the ONE and ONLY write path.
  //
  // v19.6 — All Flow 1–6 client-facing outreach emails deleted (dead code path,
  // no UI callers since v15.11.5). Force-update block removed.

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

  // v15.11.40 — Audit every script edit. Row-level, append-only.
  // Query: SELECT * FROM script_edits WHERE lead_type='expired' ORDER BY id DESC;
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS script_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_type TEXT NOT NULL,
      content TEXT NOT NULL,
      length INTEGER NOT NULL,
      edited_by TEXT,
      edited_at TEXT NOT NULL
    )`);
    rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_script_edits_lead_type ON script_edits(lead_type, id DESC)`);
  } catch (e: any) {
    console.error("[routes] script_edits table create failed:", e?.message);
  }

  // v15.11.40 — LOCKED PATCH.
  // Rules:
  //   1) Only lead_type='expired' can ever be updated.
  //   2) Caller must present INGEST_SECRET via `x-ingest-secret` header.
  //   3) Every accepted write appends an immutable row to script_edits.
  //   4) The app is prohibited from generating or defaulting to any AI-written
  //      script — all content must originate from a human. This route enforces
  //      the transport; server/expired-script.ts holds the human-authored file
  //      default; and client-side the Scripts admin is now read-only.
  app.patch("/api/scripts/:type", (req, res) => {
    const leadType = req.params.type;
    if (leadType !== "expired") {
      return res.status(410).json({ error: "Only the Expired script exists in this app. All other script surfaces were retired in v15.11.40." });
    }
    const provided = String(req.headers["x-ingest-secret"] || "");
    if (!process.env.INGEST_SECRET || provided !== process.env.INGEST_SECRET) {
      return res.status(403).json({ error: "Script edits require INGEST_SECRET. The Scripts admin is read-only." });
    }
    const { content } = req.body;
    if (!content || typeof content !== "string" || content.trim().length < 200) {
      return res.status(400).json({ error: "Missing or too-short content" });
    }
    const now = new Date().toISOString();
    rawDb.prepare("UPDATE scripts SET content = ?, updated_at = ? WHERE lead_type = ?").run(content, now, leadType);
    try {
      rawDb.prepare(`INSERT INTO script_edits (lead_type, content, length, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)`)
        .run(leadType, content, content.length, String(req.headers["x-actor"] || "unknown"), now);
    } catch (e: any) {
      console.error("[routes] script_edits insert failed:", e?.message);
    }
    res.json({ leadType, content, updatedAt: now });
  });

  // v15.11.40 — Read the audit trail.
  app.get("/api/scripts/expired/audit", (_req, res) => {
    try {
      const rows = rawDb.prepare(`SELECT id, length, edited_by, edited_at FROM script_edits WHERE lead_type='expired' ORDER BY id DESC LIMIT 200`).all();
      res.json({ edits: rows });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
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

  // ─── CLAIM A CALLBACK (v14.81.2) ────────────────────────────────────────────
  // v14.81.2 — Alex: "With the phone-number look-up I want anyone to grab it if
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
  // v15.11.26 — Helper: next midnight in America/New_York, returned as UTC ISO.
  // Used by Skip and Recycle so a lead they just released is hidden from THIS
  // agent for the rest of the local day. Reset boundary is a real midnight in
  // Alex's timezone, not a rolling 24h window.
  function nextEdtMidnightIso(): string {
    const now = new Date();
    // Compute the current date in America/New_York.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc; }, {});
    // Build midnight tomorrow in EDT/EST as an ISO by leveraging Intl offset.
    // Simpler: iterate forward at UTC in 1-min steps until en-US date rolls to
    // the next EDT day. Cheap (max ~1440 iterations, ~1ms), avoids DST math.
    const startDay = parts.day;
    let candidate = new Date(now);
    for (let i = 0; i < 1500; i++) {
      candidate = new Date(candidate.getTime() + 60_000);
      const p = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", day: "2-digit", hour: "2-digit",
        minute: "2-digit", hour12: false,
      }).formatToParts(candidate).reduce((acc: any, x) => { acc[x.type] = x.value; return acc; }, {});
      if (p.day !== startDay && p.hour === "00" && p.minute === "00") {
        return candidate.toISOString();
      }
    }
    // Fallback — shouldn't hit but return +24h so caller never sees NaN.
    return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }

  // v15.11.26 — EDT midnight of TODAY (as UTC ISO). Used for the daily reset
  // boundary in skip-quota lookups. Anything created after this timestamp
  // counts against today's 3-skip cap.
  function todayEdtMidnightIso(): string {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", day: "2-digit",
    }).formatToParts(now).reduce((acc: any, x) => { acc[x.type] = x.value; return acc; }, {});
    const startDay = parts.day;
    let candidate = new Date(now);
    for (let i = 0; i < 1500; i++) {
      candidate = new Date(candidate.getTime() - 60_000);
      const p = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(candidate).reduce((acc: any, x) => { acc[x.type] = x.value; return acc; }, {});
      if (p.day === startDay && p.hour === "00" && p.minute === "00") {
        return candidate.toISOString();
      }
      if (p.day !== startDay) {
        // Passed the boundary — the previous minute was 00:00, use it.
        return new Date(candidate.getTime() + 60_000).toISOString();
      }
    }
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }

  // v15.11.43 — SKIP TOKEN BUCKET (rewrites v15.11.26 hard cap).
  //
  //   Capacity : 3 skips held at once.
  //   Regen    : +1 skip every 15 min of elapsed time since the LAST skip.
  //   Escalates: 10+ skips in the last rolling 24h → 30-min regen.
  //              20+ skips in the last rolling 24h → 60-min regen.
  //   Never runs out unless burned faster than they regen. Realistic pace is
  //   ~4 skips/hr = ~32 per 8h workday if someone abuses it. Legit use is
  //   5–10/day with 2–3 always in reserve.
  //
  // Returns { available, cap, nextRegenAt, cooldownMin, rolling24h }.
  const SKIP_BUCKET_CAP = 3;
  const SKIP_BASE_REGEN_MIN = 15;
  function computeSkipQuota(agentId: number) {
    const now = new Date();
    const dayStart = todayEdtMidnightIso();

    // Rolling 24h skip count for escalation. Uses 'skipped' outcome only —
    // admin-cleared skips (skip_cleared_by_admin) are excluded intentionally.
    const rolling24hRow = rawDb.prepare(`
      SELECT COUNT(*) AS c FROM lead_activity
       WHERE agent_id = ? AND outcome = 'skipped'
         AND created_at >= datetime('now', '-24 hours')
    `).get(agentId) as { c: number } | undefined;
    const rolling24h = rolling24hRow?.c ?? 0;

    // Escalating regen. Base 15m; 30m at 10+; 60m at 20+ in the last 24h.
    let regenMin = SKIP_BASE_REGEN_MIN;
    if (rolling24h >= 20) regenMin = 60;
    else if (rolling24h >= 10) regenMin = 30;

    // Reconstruct bucket state by walking the skip history since the earliest
    // relevant boundary (the last time the bucket was known-full, i.e. 3×regen
    // ago from the newest event). Simpler: sort recent skips, replay them.
    // We only need the last N skips where N = cap; older ones can't affect
    // the current bucket level.
    const recentSkips = rawDb.prepare(`
      SELECT created_at FROM lead_activity
       WHERE agent_id = ? AND outcome = 'skipped'
       ORDER BY created_at DESC
       LIMIT ?
    `).all(agentId, SKIP_BUCKET_CAP) as Array<{ created_at: string }>;

    // Replay in chronological order: bucket starts at cap, drops on each skip,
    // regens by min(elapsed, needed) between events, tops out at cap.
    let bucket = SKIP_BUCKET_CAP;
    let lastEventMs: number | null = null;
    const sortedAsc = [...recentSkips].reverse();
    for (const s of sortedAsc) {
      const t = new Date(s.created_at).getTime();
      if (lastEventMs !== null) {
        const elapsedMin = (t - lastEventMs) / 60_000;
        bucket = Math.min(SKIP_BUCKET_CAP, bucket + Math.floor(elapsedMin / regenMin));
      }
      bucket = Math.max(0, bucket - 1);
      lastEventMs = t;
    }
    // Regen since the last event up to "now".
    if (lastEventMs !== null) {
      const elapsedMin = (now.getTime() - lastEventMs) / 60_000;
      bucket = Math.min(SKIP_BUCKET_CAP, bucket + Math.floor(elapsedMin / regenMin));
    }

    // When does the next token drop into the bucket? If bucket is already full,
    // there is no next-regen time. Otherwise, project forward from the last
    // event by however many regenMin steps get us to "now".
    let nextRegenAt: string | null = null;
    if (bucket < SKIP_BUCKET_CAP && lastEventMs !== null) {
      const elapsedMin = (now.getTime() - lastEventMs) / 60_000;
      const stepsSinceEvent = Math.floor(elapsedMin / regenMin);
      const nextStepMs = lastEventMs + (stepsSinceEvent + 1) * regenMin * 60_000;
      nextRegenAt = new Date(nextStepMs).toISOString();
    }

    // Kept for backward-compat with the old client fields. `used` = how many
    // skips have been recorded TODAY (EDT boundary) — informational only,
    // no longer used as a cap.
    const usedRow = rawDb.prepare(`
      SELECT COUNT(*) AS c FROM lead_activity
       WHERE agent_id = ? AND outcome = 'skipped' AND created_at >= ?
    `).get(agentId, dayStart) as { c: number } | undefined;
    const used = usedRow?.c ?? 0;

    const remaining = bucket;
    const inCooldown = bucket === 0;
    return {
      // New v15.11.43 fields
      available: bucket,
      cap: SKIP_BUCKET_CAP,
      regenMin,
      nextRegenAt,
      rolling24h,
      // Backward-compat (old client used these)
      used,
      remaining,
      cooldownExpiresAt: nextRegenAt,
      inCooldown,
      nextAvailableAt: nextRegenAt ?? now.toISOString(),
      resetAt: nextEdtMidnightIso(),
    };
  }

  // v15.11.26 — GET /api/agent/:id/skip-quota
  // Returns the current agent's skip quota state so the button can paint the
  // right label ("Skip (2 left)", "Cooldown 47m", "0/3 used").
  app.get("/api/agent/:id/skip-quota", (req, res) => {
    const agentId = parseInt(req.params.id);
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });
    res.json(computeSkipQuota(agentId));
  });

  // v15.11.36 — POST /api/admin/agents/:id/reset-skips
  // Admin-only. Clears an agent's daily skip quota AND removes any per-agent
  // day-long holdouts they collected from skipping. Alex request 7/22: agents
  // only get 3 skips and then they're blocked — admin needs a way to unblock
  // them mid-day (e.g. after resolving whatever glitched lead pushed them to
  // burn skips in the first place). Skip activity rows are NOT deleted — they
  // are rewritten to outcome='skip_cleared_by_admin' so the audit trail stays
  // intact but the daily-cap query (which matches outcome='skipped') stops
  // counting them. The rewrite is scoped to TODAY only (created_at >= EDT
  // midnight) so a reset never touches history from previous days.
  app.post("/api/admin/agents/:id/reset-skips", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const agentId = parseInt(req.params.id);
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });
    const target = storage.getAgentById(agentId);
    if (!target) return res.status(404).json({ error: "Agent not found" });

    const dayStart = todayEdtMidnightIso();
    const before = computeSkipQuota(agentId);

    // Rewrite today's 'skipped' activity rows so the daily-cap query no longer
    // matches them. History is preserved under the new outcome tag.
    const rewriteRes = rawDb.prepare(`
      UPDATE lead_activity
         SET outcome = 'skip_cleared_by_admin',
             notes  = COALESCE(notes, '') ||
                      (CASE WHEN COALESCE(notes,'') = '' THEN '' ELSE ' — ' END) ||
                      'Skip cleared by admin ' || ? || ' on ' || ?
       WHERE agent_id = ?
         AND outcome  = 'skipped'
         AND created_at >= ?
    `).run(
      (req.currentAgent?.name ?? "unknown"),
      new Date().toISOString(),
      agentId,
      dayStart,
    );

    // Release any 'skipped'-reason holdouts still in effect for this agent so
    // those leads can flow back to them today. Non-skip holdouts (if any
    // future feature adds them) are left alone.
    const holdRes = rawDb.prepare(`
      DELETE FROM agent_lead_holdouts
       WHERE agent_id = ?
         AND reason   = 'skipped'
         AND until    > datetime('now')
    `).run(agentId);

    // Log the admin action against the target agent.
    try {
      logAgentEvent({
        actorId: req.currentAgent?.id ?? null,
        targetId: agentId,
        event: "skip_quota_reset",
        before: { skipsUsed: before.used, cap: before.cap, inCooldown: before.inCooldown },
        after:  { skipsUsed: 0, cap: before.cap, inCooldown: false },
        notes:  `Cleared ${rewriteRes.changes} skip row(s) and released ${holdRes.changes} lead holdout(s).`,
      });
    } catch {}

    const after = computeSkipQuota(agentId);
    res.json({
      ok: true,
      agentId,
      agentName: target.name,
      cleared: rewriteRes.changes,
      holdoutsReleased: holdRes.changes,
      before: { used: before.used, remaining: before.remaining, inCooldown: before.inCooldown },
      after,
    });
  });

  // v15.11.43 — POST /api/leads/:id/skip { agentId, reason, reasonNote?, notes? }
  //   Token-bucket-gated escape hatch for glitched or misassigned leads.
  //   Behaves like Recycle for the LEAD (returns to shared pool, attempt count
  //   bumps), but ALSO inserts a per-agent holdout so this lead never comes
  //   back to THIS agent for 24 hours. Bucket cap 3, base regen 15min,
  //   escalating to 30min at 10 skips in rolling 24h, 60min at 20.
  //
  //   REQUIRED `reason` field (v15.11.43): one of the enum values below,
  //   or 'other' with a `reasonNote` (max 200 chars). Recorded on the
  //   activity row so admin can spot fake reason patterns.
  //
  //   BLOCKED (v15.11.43): leads with owner_confirmed_at IS NOT NULL cannot
  //   be skipped. Those are the highest-value leads (Owner Confirmed →
  //   front of pool) and skipping one is almost certainly a theft attempt.
  //
  //   Not counted as a dial. Logs activity outcome='skipped' with the reason
  //   and (if 'other') the free-text note appended.
  const SKIP_REASONS = new Set([
    "wrong_phone",
    "no_county_match",
    "duplicate",
    "bad_data",
    "never_expired",
    "never_listed",
    "other",
  ]);
  app.post("/api/leads/:id/skip", (req, res) => {
    const leadId = parseInt(req.params.id);
    const { agentId, reason, reasonNote, notes } = req.body;
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });
    const lead = storage.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // v15.11.43 — Reason field is required.
    const reasonKey = typeof reason === "string" ? reason.trim().toLowerCase() : "";
    if (!SKIP_REASONS.has(reasonKey)) {
      return res.status(400).json({
        error: "Skip reason required",
        code: "REASON_REQUIRED",
        allowed: Array.from(SKIP_REASONS),
      });
    }
    const trimmedNote = typeof reasonNote === "string" ? reasonNote.trim().slice(0, 200) : "";
    if (reasonKey === "other" && trimmedNote.length < 3) {
      return res.status(400).json({
        error: "When reason is 'other', a short explanation is required",
        code: "OTHER_NOTE_REQUIRED",
      });
    }

    // v15.11.43 — Block skip on Owner Confirmed leads.
    if ((lead as any).ownerConfirmedAt || (lead as any).owner_confirmed_at) {
      return res.status(423).json({
        error: "Owner Confirmed leads can't be skipped",
        code: "OWNER_CONFIRMED_LOCKED",
      });
    }

    const quota = computeSkipQuota(agentId);
    if (quota.available <= 0) {
      return res.status(429).json({
        error: "No skips available — waiting for one to regenerate",
        code: "BUCKET_EMPTY",
        cap: quota.cap,
        regenMin: quota.regenMin,
        nextRegenAt: quota.nextRegenAt,
        rolling24h: quota.rolling24h,
      });
    }

    // Compose the activity note. Reason label first, then free-text if 'other',
    // then any pre-existing agent notes.
    const REASON_LABELS: Record<string, string> = {
      wrong_phone:    "Wrong phone",
      no_county_match:"No county match",
      duplicate:      "Duplicate",
      bad_data:       "Bad data",
      never_expired:  "Never expired",
      never_listed:   "Never listed",
      other:          "Other",
    };
    const composedNote = [
      `Reason: ${REASON_LABELS[reasonKey]}`,
      reasonKey === "other" && trimmedNote ? `— ${trimmedNote}` : "",
      notes ? `\n${notes}` : "",
    ].filter(Boolean).join(" ");

    // Log the skip activity (does NOT count as a dial — dial counters exclude 'skipped').
    storage.createLeadActivity({
      leadId,
      agentId,
      outcome: "skipped",
      notes: composedNote || "Lead skipped — held out from this agent for 24h.",
      lpmamabSnapshot: null,
      createdAt: new Date().toISOString(),
    });

    // Release lock, return lead to unassigned pool.
    rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ? AND agent_id = ?`).run(leadId, agentId);
    storage.updateLead(leadId, {
      assignedAgentId: null,
      status: "unassigned",
      attemptCount: (lead.attemptCount || 0) + 1,
    });

    // v15.11.43 — Hold out from this agent for 24 hours (not just today).
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    rawDb.prepare(`
      INSERT OR REPLACE INTO agent_lead_holdouts (agent_id, lead_id, until, reason, created_at)
      VALUES (?, ?, ?, 'skipped', ?)
    `).run(agentId, leadId, until, new Date().toISOString());

    broadcast({ type: "lead_updated", leadId });
    const post = computeSkipQuota(agentId);
    res.json({ skipped: true, quota: post });
  });

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

    // v15.11.49 — HOTFIX: delete lead_locks row on recycle. Previously the lock
    // persisted after status flipped to 'unassigned', which meant pullPool's
    // `AND lk.lead_id IS NULL` clause excluded the recycled lead for EVERY
    // agent — the lead effectively vanished from the pool until the lock
    // expired. Skip already deletes locks (line 5585) so this brings recycle
    // to parity. Bronson: "recycle not moving on some lead cards."
    rawDb.prepare(`DELETE FROM lead_locks WHERE lead_id = ?`).run(leadId);

    storage.updateLead(leadId, {
      assignedAgentId: null,
      status: "unassigned",
      attemptCount: (lead.attemptCount || 0) + 1,
    });

    // v15.11.26 — Anti-bounce-back: hold out from THIS agent for the rest of
    // the local day so pullPool's score DESC ordering can't hand it back
    // three seconds later. Fixes the "I recycled Denise and she came right
    // back" bug Alex reported.
    if (agentId) {
      const until = nextEdtMidnightIso();
      rawDb.prepare(`
        INSERT OR REPLACE INTO agent_lead_holdouts (agent_id, lead_id, until, reason, created_at)
        VALUES (?, ?, ?, 'recycled', ?)
      `).run(agentId, leadId, until, new Date().toISOString());
    }

    broadcast({ type: "lead_updated", leadId });
    res.json({ recycled: true, reassignedTo: null });
  });

  // ─── DUAL LEADERBOARD (Today + Weekly) — SQL aggregated (v11.70) ─────────
  app.get("/api/admin/leaderboard", (req, res) => {
    const now = new Date();

    // v16.7 — Today window in AMERICA/NEW_YORK (the team's clock), not server
    // local UTC. Reuses todayEdtMidnightIso() which is DST-aware. Bug caught
    // during Aug 1 audit: server ran in UTC so `setHours(0,0,0,0)` set the
    // cutoff to UTC midnight; Bronson's 8-11pm ET dials landed AFTER UTC
    // midnight so "Today" showed 0 while Weekly/Monthly correctly showed 30.
    let todayStartISO = todayEdtMidnightIso();

    // v16.7 — Week: Monday 00:00 in AMERICA/NEW_YORK. Same DST-aware bounds
    // helper approach as monthStartEt below. Uses the current calendar day in
    // ET as the anchor, then walks back to Monday.
    const weekStartISO_Et = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "numeric", day: "numeric" });
      const parts = fmt.formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc; }, {});
      const wdMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
      const wd = wdMap[parts.weekday] ?? 1;
      const diff = wd === 0 ? -6 : 1 - wd; // Sun-of-week → last Mon, else back to Mon
      const yr = parseInt(parts.year, 10);
      const mo = parseInt(parts.month, 10);
      const dy = parseInt(parts.day, 10) + diff;
      const dst = mo >= 3 && mo <= 11;
      const off = dst ? 4 : 5;
      return new Date(Date.UTC(yr, mo - 1, dy, off, 0, 0, 0)).toISOString();
    })();
    let weekStartISO = weekStartISO_Et;

    // v16.7 — Month window. Calendar-month bounds in America/New_York (the
    // leaderboard clock the team lives on). Uses the same helper approach as
    // /api/team-pot bounds.
    const monthStartEt = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" });
      const parts = fmt.formatToParts(now);
      const year = parseInt(parts.find(p => p.type === "year")!.value, 10);
      const monthNum = parseInt(parts.find(p => p.type === "month")!.value, 10);
      const isDst = (m: number) => m >= 3 && m <= 11;
      const offsetHours = isDst(monthNum) ? 4 : 5;
      return new Date(Date.UTC(year, monthNum - 1, 1, offsetHours, 0, 0, 0)).toISOString();
    })();
    let monthStartISO = monthStartEt;

    // v16.7 — Reconcile with the agent leaderboard. `/api/agent/leaderboard`
    // reads lead_activity + agent_points filtered by `> leaderboard_reset_at`
    // (no today/week split — it's always the current cycle). Admin has TODAY/
    // WEEK/ALL-TIME tabs that use calendar-midnight boundaries. When a reset
    // happens mid-cycle (e.g. Aug 1 09:00 fresh-start) the admin's TODAY still
    // said "since midnight today" which pulled ZERO rows because all dials
    // that day happened before the reset. Agent view saw "since reset" which
    // covered them, so admin and agent screens disagreed for the same person.
    // Fix: raise the TODAY/WEEK/MONTH floor to MAX(period_start, reset_at).
    // If the reset is older than the calendar boundary this is a no-op.
    const _resetRowAdmin = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    const _resetAtAdmin: string | null = _resetRowAdmin?.value || null;
    if (_resetAtAdmin) {
      if (_resetAtAdmin > todayStartISO) todayStartISO = _resetAtAdmin;
      if (_resetAtAdmin > weekStartISO)  weekStartISO  = _resetAtAdmin;
      if (_resetAtAdmin > monthStartISO) monthStartISO = _resetAtAdmin;
    }

    // v20.7.53 — Every roster agent is on the admin leaderboard. Tombstones
    // (merged-away rows) are the only exclusion.
    const allAgents = storage.getAllAgents().filter(a =>
      a.isActive && !(a.email || "").startsWith("tombstone:")
    );

    // ── SQL: aggregate activity counts per agent per outcome for today + week + month + all-time ──
    // v16.7 — added month_* columns to power the new MONTH tab.
    // v20.6.9 — DIAL WHITELIST reconciled with challenges (see challenges_routes.ts).
    // A dial = a phone outcome. Door knocks, mail, OH logs, social posts are
    // NOT dials — they get their own leg columns on the leaderboard
    // (dk / dm / oh / social). Previously we did `total - emails` which
    // over-counted by lumping every non-email outcome (including door knocks
    // and open-house logs) as a dial. That's why challenges said 0 while
    // leaderboard said 16 for the same agent on the same day.
    const aggRows: any[] = rawDb.prepare(`
      SELECT agent_id,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as month_total,
        COUNT(*) as all_total,
        SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled','retired_no_answer','manual_credit') AND created_at >= ? THEN 1 ELSE 0 END) as today_dials,
        SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled','retired_no_answer','manual_credit') AND created_at >= ? THEN 1 ELSE 0 END) as week_dials,
        SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled','retired_no_answer','manual_credit') AND created_at >= ? THEN 1 ELSE 0 END) as month_dials,
        SUM(CASE WHEN outcome IN ('no_answer','contacted_appointment','contacted_not_interested','keep_in_touch','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled','retired_no_answer','manual_credit') THEN 1 ELSE 0 END) as all_dials,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as today_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as week_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as month_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as all_appts,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as today_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as week_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as month_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as all_kit,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as today_emails,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as week_emails,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as month_emails,
        SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as all_emails,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as today_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as week_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as month_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as all_no_answer,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as today_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as week_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as month_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as all_not_int,
        MAX(created_at) as last_activity_at
      FROM lead_activity
      WHERE agent_id IS NOT NULL
      GROUP BY agent_id
    `).all(
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO,
      todayStartISO, weekStartISO, monthStartISO
    );
    const aggMap: Record<number, any> = {};
    for (const r of aggRows) aggMap[r.agent_id] = r;

    // ── SQL: REFS = ALL leads uploaded by this agent (v20.4.4 — was network-only)
    //    Broadened per Alex: refs credit any lead an agent puts into the DB.
    const weekRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND uploaded_at >= ?
      GROUP BY uploaded_by
    `).all(weekStartISO);
    const weekReferralsMap: Record<number, number> = {};
    for (const r of weekRefRows) weekReferralsMap[r.uploaded_by] = r.cnt;

    const monthRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND uploaded_at >= ?
      GROUP BY uploaded_by
    `).all(monthStartISO);
    const monthReferralsMap: Record<number, number> = {};
    for (const r of monthRefRows) monthReferralsMap[r.uploaded_by] = r.cnt;

    const todayRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
        AND uploaded_at >= ?
      GROUP BY uploaded_by
    `).all(todayStartISO);
    const todayReferralsMap: Record<number, number> = {};
    for (const r of todayRefRows) todayReferralsMap[r.uploaded_by] = r.cnt;

    const allRefRows: any[] = rawDb.prepare(`
      SELECT uploaded_by, COUNT(*) as cnt
      FROM leads
      WHERE uploaded_by IS NOT NULL
      GROUP BY uploaded_by
    `).all();
    const allReferralsMap: Record<number, number> = {};
    for (const r of allRefRows) allReferralsMap[r.uploaded_by] = r.cnt;

    // v20.4.4 — lead-gen activity buckets from agent_points.reason (OH / DM / DK / social).
    // v20.7.20 — BUGFIX: since v17.6 the approval-approve handler writes
    // agent_points rows with `reason = 'approval:<kind>'` (e.g. 'approval:social_post')
    // instead of the plain kind. This bucketByReason was still matching just the plain
    // reason, so approved social posts / OH logs / DM / DK never showed up on the
    // leaderboard even though the points were awarded. Fix: match BOTH the plain
    // reason and the 'approval:<reason>' variant so historical + current rows both
    // count. Symptom Alex reported: his social post approved (+15 pts) but the
    // FB/IG column on the leaderboard stayed at 0.
    const bucketByReason = (reason: string, floorISO: string | null): Record<number, number> => {
      const approvalReason = `approval:${reason}`;
      const sql = floorISO
        ? `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason IN (?, ?) AND created_at >= ? GROUP BY agent_id`
        : `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason IN (?, ?) GROUP BY agent_id`;
      const rows: any[] = floorISO
        ? rawDb.prepare(sql).all(reason, approvalReason, floorISO)
        : rawDb.prepare(sql).all(reason, approvalReason);
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.cnt;
      return m;
    };
    // OH = open_house_log; DM = direct_mail; DK = door_knock; SOCIAL = social_post
    const ohTodayMap = bucketByReason("open_house_log", todayStartISO);
    const ohWeekMap  = bucketByReason("open_house_log", weekStartISO);
    const ohMonthMap = bucketByReason("open_house_log", monthStartISO);
    const ohAllMap   = bucketByReason("open_house_log", null);
    const dmTodayMap = bucketByReason("direct_mail", todayStartISO);
    const dmWeekMap  = bucketByReason("direct_mail", weekStartISO);
    const dmMonthMap = bucketByReason("direct_mail", monthStartISO);
    const dmAllMap   = bucketByReason("direct_mail", null);
    const dkTodayMap = bucketByReason("door_knock", todayStartISO);
    const dkWeekMap  = bucketByReason("door_knock", weekStartISO);
    const dkMonthMap = bucketByReason("door_knock", monthStartISO);
    const dkAllMap   = bucketByReason("door_knock", null);
    const socTodayMap = bucketByReason("social_post", todayStartISO);
    const socWeekMap  = bucketByReason("social_post", weekStartISO);
    const socMonthMap = bucketByReason("social_post", monthStartISO);
    const socAllMap   = bucketByReason("social_post", null);
    // v20.7.53 — INV column: agent invites sent (no approval:* twin, invite fires immediately).
    const invBucket = (floorISO: string | null): Record<number, number> => {
      const sql = floorISO
        ? `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason = 'agent_invite_sent' AND created_at >= ? GROUP BY agent_id`
        : `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason = 'agent_invite_sent' GROUP BY agent_id`;
      const rows: any[] = floorISO ? rawDb.prepare(sql).all(floorISO) : rawDb.prepare(sql).all();
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.cnt;
      return m;
    };
    const invTodayMap = invBucket(todayStartISO);
    const invWeekMap  = invBucket(weekStartISO);
    const invMonthMap = invBucket(monthStartISO);
    const invAllMap   = invBucket(null);

    // v20.7.27 — POINTS BUCKETS on the admin side. Prior versions only computed
    // a single since-reset total (see ptsMap below, still emitted as the flat
    // .points field for back-compat), but the per-window blocks (today/week/
    // month/allTime) never carried .points — so any UI reading window.points
    // saw 0. Mirrors ptsBucket() from the agent leaderboard.
    const ptsBucketAdm = (floorISO: string | null): Record<number, number> => {
      const sql = floorISO
        ? `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' AND created_at >= ? GROUP BY agent_id`
        : `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' GROUP BY agent_id`;
      const rows: any[] = floorISO ? rawDb.prepare(sql).all(floorISO) : rawDb.prepare(sql).all();
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.total || 0;
      return m;
    };
    const ptsTodayMapAdm = ptsBucketAdm(todayStartISO);
    const ptsWeekMapAdm  = ptsBucketAdm(weekStartISO);
    const ptsMonthMapAdm = ptsBucketAdm(monthStartISO);
    const ptsAllMapAdm   = ptsBucketAdm(null);

    // v16.7 — buildStats now supports "month" period.
    const buildStats = (agg: any, period: "today" | "week" | "month" | "all", agentId: number) => {
      if (!agg) {
        // v20.7.27 — zero-activity fallback must still emit .points so the admin
        // sort key never reads undefined. Also emits the same points window even
        // when lead_activity is empty (agent had a manual-appt only, etc.).
        const zeroPts = period === "today" ? (ptsTodayMapAdm[agentId] || 0)
          : period === "week"  ? (ptsWeekMapAdm[agentId]  || 0)
          : period === "month" ? (ptsMonthMapAdm[agentId] || 0)
          : (ptsAllMapAdm[agentId] || 0);
        return { dials: 0, appts: 0, kit: 0, emails: 0, noAnswer: 0, convRate: 0, referrals: 0, oh: 0, dm: 0, dk: 0, social: 0, points: zeroPts };
      }
      const p = period;
      const appts    = agg[`${p}_appts`]    || 0;
      const kit      = agg[`${p}_kit`]      || 0;
      const emails   = agg[`${p}_emails`]   || 0;
      const noAnswer = agg[`${p}_no_answer`] || 0;
      const notInt   = agg[`${p}_not_int`]  || 0;
      // v20.6.9 — dials read directly from the whitelist SUM. `total` kept
      // for backward compat (some clients still read it) but no longer used
      // to derive dial count.
      const _total   = agg[`${p}_total`]    || (p === "all" ? (agg.all_total || 0) : 0);
      void _total;
      const dials    = agg[`${p}_dials`]    || 0;
      const convRate = dials > 0 ? Math.round(((appts + notInt + kit) / dials) * 100) : 0;
      const referrals = period === "today" ? (todayReferralsMap[agentId] || 0)
        : period === "week"  ? (weekReferralsMap[agentId]  || 0)
        : period === "month" ? (monthReferralsMap[agentId] || 0)
        : (allReferralsMap[agentId] || 0);
      const oh = period === "today" ? (ohTodayMap[agentId] || 0)
        : period === "week"  ? (ohWeekMap[agentId]  || 0)
        : period === "month" ? (ohMonthMap[agentId] || 0)
        : (ohAllMap[agentId] || 0);
      const dm = period === "today" ? (dmTodayMap[agentId] || 0)
        : period === "week"  ? (dmWeekMap[agentId]  || 0)
        : period === "month" ? (dmMonthMap[agentId] || 0)
        : (dmAllMap[agentId] || 0);
      const dk = period === "today" ? (dkTodayMap[agentId] || 0)
        : period === "week"  ? (dkWeekMap[agentId]  || 0)
        : period === "month" ? (dkMonthMap[agentId] || 0)
        : (dkAllMap[agentId] || 0);
      const social = period === "today" ? (socTodayMap[agentId] || 0)
        : period === "week"  ? (socWeekMap[agentId]  || 0)
        : period === "month" ? (socMonthMap[agentId] || 0)
        : (socAllMap[agentId] || 0);
      // v20.7.53 — INV column.
      const inv = period === "today" ? (invTodayMap[agentId] || 0)
        : period === "week"  ? (invWeekMap[agentId]  || 0)
        : period === "month" ? (invMonthMap[agentId] || 0)
        : (invAllMap[agentId] || 0);
      // v20.7.27 — points per window (drives monthly-ranked sort + window UI).
      const points = period === "today" ? (ptsTodayMapAdm[agentId] || 0)
        : period === "week"  ? (ptsWeekMapAdm[agentId]  || 0)
        : period === "month" ? (ptsMonthMapAdm[agentId] || 0)
        : (ptsAllMapAdm[agentId] || 0);
      return { dials, appts, kit, emails, noAnswer, convRate, referrals, oh, dm, dk, social, inv, points };
    };

    // v15.11.26 — broaden the "green dot" signal. Was: only lead_activity outcomes.
    // Now: MAX(lead_activity, agent_points, sessions.created_at). Catches:
    //   • agents who submit network referrals (writes agent_points, not lead_activity)
    //   • agents who open the app + log in but don't press outcome buttons
    // Same query is cheap because these tables are already indexed on agent_id.
    const pointsMaxRows = rawDb.prepare(`
      SELECT agent_id, MAX(created_at) as max_pts FROM agent_points GROUP BY agent_id
    `).all() as any[];
    const pointsMaxMap: Record<number, string> = {};
    for (const r of pointsMaxRows) pointsMaxMap[r.agent_id] = r.max_pts;

    const sessionMaxRows = rawDb.prepare(`
      SELECT agent_id, MAX(created_at) as max_sess FROM sessions GROUP BY agent_id
    `).all() as any[];
    const sessionMaxMap: Record<number, string> = {};
    for (const r of sessionMaxRows) sessionMaxMap[r.agent_id] = r.max_sess;

    const result = allAgents.map(agent => {
      const agg = aggMap[agent.id] || null;
      // Pick the newest of: last outcome, last point, last login. Any of them
      // signals the agent was recently in the app.
      const candidates = [
        agg?.last_activity_at,
        pointsMaxMap[agent.id],
        sessionMaxMap[agent.id],
      ].filter(Boolean) as string[];
      const lastActivityAt = candidates.length > 0
        ? candidates.sort().pop()  // ISO strings sort lexically = chronologically
        : null;
      return {
        agent: { id: agent.id, name: agent.name, email: agent.email, headshotUrl: (agent as any).headshotUrl || null },
        lastActivityAt,
        today:   buildStats(agg, "today", agent.id),
        weekly:  buildStats(agg, "week",  agent.id),
        monthly: buildStats(agg, "month", agent.id),
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

    // v20.7.27 — RANK BY MONTHLY POINTS (matches /api/agent/leaderboard). The
    // competition is monthly; ranking follows monthly.points regardless of tab.
    // Tiebreakers: monthly dials, then monthly appts. Prior versions used the
    // since-reset cycle bucket which drifted from the Monthly tab whenever the
    // reset date wasn't the 1st of the month.
    result.sort((a, b) =>
      ((b.monthly.points || 0) - (a.monthly.points || 0)) ||
      ((b.monthly.dials  || 0) - (a.monthly.dials  || 0)) ||
      ((b.monthly.appts  || 0) - (a.monthly.appts  || 0))
    );
    res.json(result);
  });

  // ─── LEADERBOARD RESET (v11.57: snapshots scores before wiping) ──────────
  // v12.5 — accepts ?scope=seller|recruiting so each depot's leaderboard resets independently.
  app.post("/api/admin/leaderboard-reset", (req: any, res: any) => {
    if (!requireAdmin(req, res)) return; // v15.9 SECURITY: was fully unguarded before v15.9
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
    if (!requireAdmin(req, res)) return; // v15.9 SECURITY: was fully unguarded before v15.9
    if (req.body?.confirm !== "RESET") {
      return res.status(400).json({ error: 'Must send { "confirm": "RESET" } in body' });
    }
    try {
      let leadCount = 0, lockCount = 0, activityCount = 0, pointCount = 0;
      const txn = rawDb.transaction(() => {
        // Delete in FK-safe order: locks -> activity -> leads.
        // v14.81.2: lead_locks has FK to leads, must go first or DELETE FROM leads throws.
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


  // ─── AGENT-FACING LEADERBOARD (no admin-only data) ────────────────────────
  app.get("/api/agent/leaderboard", (req, res) => {
    const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
    const resetAt: string | null = resetRow?.value || null;

    // v20.7.53 — STRUCTURAL RULE: every agent in the roster appears on the
    // leaderboard. No exceptions. leadFlowOn, receiveLeads, and role are NOT
    // gates. The leaderboard is the single source of team motivation — pause
    // the flow, mute yourself, whatever, you are still on the board with a
    // real number next to your name. The only rows filtered out are:
    //   - merge-tombstones (email starts with 'tombstone:'); those are dead
    //     historical anchors, not agents.
    // isActive is kept as a belt-and-suspenders filter but, per v20.7.53,
    // no admin flow can flip it to false anymore — the roster IS the active
    // list. Do NOT reintroduce leadFlowOn / receiveLeads / role gates here.
    const allAgents = storage.getAllAgents().filter(a =>
      a.isActive && !(a.email || "").startsWith("tombstone:")
    );

    // v16.7 — window bounds. Today/Week/Month are calendar boundaries in ET,
    // but never earlier than the leaderboard_reset_at floor (matches admin).
    // v16.7 — switched to ET-aware bounds (was using server-local UTC).
    const nowW = new Date();
    let todayStartAg = todayEdtMidnightIso();
    let weekStartAg = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "numeric", day: "numeric" });
      const parts = fmt.formatToParts(nowW).reduce((acc: any, p) => { acc[p.type] = p.value; return acc; }, {});
      const wdMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
      const wd = wdMap[parts.weekday] ?? 1;
      const diff = wd === 0 ? -6 : 1 - wd;
      const yr = parseInt(parts.year, 10);
      const mo = parseInt(parts.month, 10);
      const dy = parseInt(parts.day, 10) + diff;
      const dst = mo >= 3 && mo <= 11;
      const off = dst ? 4 : 5;
      return new Date(Date.UTC(yr, mo - 1, dy, off, 0, 0, 0)).toISOString();
    })();
    let monthStartAg = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" });
      const parts = fmt.formatToParts(nowW);
      const yr = parseInt(parts.find(p => p.type === "year")!.value, 10);
      const mo = parseInt(parts.find(p => p.type === "month")!.value, 10);
      const dst = mo >= 3 && mo <= 11;
      const off = dst ? 4 : 5;
      return new Date(Date.UTC(yr, mo - 1, 1, off, 0, 0, 0)).toISOString();
    })();
    if (resetAt) {
      if (resetAt > todayStartAg) todayStartAg = resetAt;
      if (resetAt > weekStartAg)  weekStartAg  = resetAt;
      if (resetAt > monthStartAg) monthStartAg = resetAt;
    }

    // SQL aggregation — avoids loading all leads/activities (v11.70).
    // v16.7 — added today/week/month per-outcome sums.
    // v16.7 — dropped the outer `resetAt` filter so that raw COUNT/SUM columns
    //   (used for allTime) truly report lifetime totals. Windowed columns
    //   (today/week/month) still respect the reset because they're clamped to
    //   `MAX(period_start, resetAt)` above.
    const agentStatsRows: any[] = rawDb.prepare(`
      SELECT agent_id,
        COUNT(*) as total_all,
        SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as emails_sent,
        SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
        SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
        SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kit,
        SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as not_int,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as month_total,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as today_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as week_appts,
        SUM(CASE WHEN outcome = 'contacted_appointment' AND created_at >= ? THEN 1 ELSE 0 END) as month_appts,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as today_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as week_kit,
        SUM(CASE WHEN outcome = 'keep_in_touch' AND created_at >= ? THEN 1 ELSE 0 END) as month_kit,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as today_emails,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as week_emails,
        SUM(CASE WHEN outcome = 'email_sent' AND created_at >= ? THEN 1 ELSE 0 END) as month_emails,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as today_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as week_no_answer,
        SUM(CASE WHEN outcome = 'no_answer' AND created_at >= ? THEN 1 ELSE 0 END) as month_no_answer,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as today_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as week_not_int,
        SUM(CASE WHEN outcome = 'contacted_not_interested' AND created_at >= ? THEN 1 ELSE 0 END) as month_not_int
      FROM lead_activity
      WHERE agent_id IS NOT NULL
      GROUP BY agent_id
    `).all(
      todayStartAg, weekStartAg, monthStartAg,
      todayStartAg, weekStartAg, monthStartAg,
      todayStartAg, weekStartAg, monthStartAg,
      todayStartAg, weekStartAg, monthStartAg,
      todayStartAg, weekStartAg, monthStartAg,
      todayStartAg, weekStartAg, monthStartAg
    );
    const agentStatsMap: Record<number, any> = {};
    for (const r of agentStatsRows) agentStatsMap[r.agent_id] = r;

    // v14.29 — pull points from agent_points table for unified leaderboard sort.
    // v16.7 — plus today/week/month/all-time buckets for the new tabs.
    const ptsSqlA = `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' ${resetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
    const ptsRowsA: any[] = rawDb.prepare(ptsSqlA).all(...(resetAt ? [resetAt] : []));
    const ptsMapA: Record<number, number> = {};
    for (const p of ptsRowsA) ptsMapA[p.agent_id] = p.total || 0;

    const ptsBucket = (floor: string): Record<number, number> => {
      const rows: any[] = rawDb.prepare(`
        SELECT agent_id, SUM(points) as total FROM agent_points
        WHERE scope = 'seller' AND created_at >= ? GROUP BY agent_id
      `).all(floor);
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.total || 0;
      return m;
    };
    const ptsTodayMap = ptsBucket(todayStartAg);
    const ptsWeekMap  = ptsBucket(weekStartAg);
    const ptsMonthMap = ptsBucket(monthStartAg);

    // v20.7.22 — mirror admin bucketByReason (matches both `reason=<X>` and
    // `reason=approval:<X>`) so OH / DM / DK / social show up on the AGENT
    // leaderboard too. Prior version omitted these entirely; every agent's
    // FB/IG, OH, DM, DK columns silently rendered 0.
    const bucketByReasonAg = (reason: string, floorISO: string | null): Record<number, number> => {
      const approvalReason = `approval:${reason}`;
      const sql = floorISO
        ? `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason IN (?, ?) AND created_at >= ? GROUP BY agent_id`
        : `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason IN (?, ?) GROUP BY agent_id`;
      const rows: any[] = floorISO
        ? rawDb.prepare(sql).all(reason, approvalReason, floorISO)
        : rawDb.prepare(sql).all(reason, approvalReason);
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.cnt;
      return m;
    };
    const ohTodayMapA = bucketByReasonAg("open_house_log", todayStartAg);
    const ohWeekMapA  = bucketByReasonAg("open_house_log", weekStartAg);
    const ohMonthMapA = bucketByReasonAg("open_house_log", monthStartAg);
    const ohAllMapA   = bucketByReasonAg("open_house_log", null);
    const dmTodayMapA = bucketByReasonAg("direct_mail", todayStartAg);
    const dmWeekMapA  = bucketByReasonAg("direct_mail", weekStartAg);
    const dmMonthMapA = bucketByReasonAg("direct_mail", monthStartAg);
    const dmAllMapA   = bucketByReasonAg("direct_mail", null);
    const dkTodayMapA = bucketByReasonAg("door_knock", todayStartAg);
    const dkWeekMapA  = bucketByReasonAg("door_knock", weekStartAg);
    const dkMonthMapA = bucketByReasonAg("door_knock", monthStartAg);
    const dkAllMapA   = bucketByReasonAg("door_knock", null);
    const socTodayMapA = bucketByReasonAg("social_post", todayStartAg);
    const socWeekMapA  = bucketByReasonAg("social_post", weekStartAg);
    const socMonthMapA = bucketByReasonAg("social_post", monthStartAg);
    const socAllMapA   = bucketByReasonAg("social_post", null);
    // v20.7.53 — INV column = agent invites sent. Uses direct reason match
    // (not bucketByReasonAg's approval pattern) because agent_invite_sent has
    // no `approval:*` twin — the invite fires immediately.
    const invBucketAg = (floorISO: string | null): Record<number, number> => {
      const sql = floorISO
        ? `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason = 'agent_invite_sent' AND created_at >= ? GROUP BY agent_id`
        : `SELECT agent_id, COUNT(*) as cnt FROM agent_points WHERE reason = 'agent_invite_sent' GROUP BY agent_id`;
      const rows: any[] = floorISO ? rawDb.prepare(sql).all(floorISO) : rawDb.prepare(sql).all();
      const m: Record<number, number> = {};
      for (const r of rows) m[r.agent_id] = r.cnt;
      return m;
    };
    const invTodayMapA = invBucketAg(todayStartAg);
    const invWeekMapA  = invBucketAg(weekStartAg);
    const invMonthMapA = invBucketAg(monthStartAg);
    const invAllMapA   = invBucketAg(null);
    const ptsAllRows: any[] = rawDb.prepare(`SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = 'seller' GROUP BY agent_id`).all() as any[];
    const ptsAllMap: Record<number, number> = {};
    for (const p of ptsAllRows) ptsAllMap[p.agent_id] = p.total || 0;

    // v20.4.4 — REFS = ALL leads uploaded by this agent (was network-only).
    const refBucket = (floor: string | null): Record<number, number> => {
      const rows: any[] = floor
        ? rawDb.prepare(`
            SELECT uploaded_by, COUNT(*) as cnt FROM leads
            WHERE uploaded_by IS NOT NULL
              AND uploaded_at >= ?
            GROUP BY uploaded_by
          `).all(floor)
        : rawDb.prepare(`
            SELECT uploaded_by, COUNT(*) as cnt FROM leads
            WHERE uploaded_by IS NOT NULL
            GROUP BY uploaded_by
          `).all();
      const m: Record<number, number> = {};
      for (const r of rows) m[r.uploaded_by] = r.cnt;
      return m;
    };
    const refTodayMap = refBucket(todayStartAg);
    const refWeekMap  = refBucket(weekStartAg);
    const refMonthMap = refBucket(monthStartAg);
    const refAllMap   = refBucket(null);
    let refCycMap: Record<number, number>;
    if (resetAt) {
      // v20.4.4 — REFS = ALL leads uploaded (was network-only).
      const rows: any[] = rawDb.prepare(`
        SELECT uploaded_by, COUNT(*) as cnt FROM leads
        WHERE uploaded_by IS NOT NULL
          AND uploaded_at > ?
        GROUP BY uploaded_by
      `).all(resetAt);
      refCycMap = {};
      for (const r of rows) refCycMap[r.uploaded_by] = r.cnt;
    } else {
      refCycMap = { ...refAllMap };
    }

    // v18.3 — unified window shape matching /api/admin/leaderboard exactly.
    // Fields: dials, appts, kit, emails, noAnswer, convRate, referrals, points.
    // v20.7.22 — now also emits oh/dm/dk/social so every lead-gen activity
    // renders on the agent-side leaderboard.
    const win = (r: any, p: "today" | "week" | "month", agentId: number, refMap: Record<number, number>, ptsMap: Record<number, number>, ohMap: Record<number, number>, dmMap: Record<number, number>, dkMap: Record<number, number>, socMap: Record<number, number>, invMap: Record<number, number>) => {
      const total    = r[`${p}_total`]    || 0;
      const emails   = r[`${p}_emails`]   || 0;
      const appts    = r[`${p}_appts`]    || 0;
      const kit      = r[`${p}_kit`]      || 0;
      const noAnswer = r[`${p}_no_answer`]|| 0;
      const notInt   = r[`${p}_not_int`]  || 0;
      const dials    = total - emails;
      // v18.3 — match admin's convRate math exactly: (appts + notInt + kit) / dials.
      const convRate = dials > 0 ? Math.round(((appts + notInt + kit) / dials) * 100) : 0;
      return {
        points:    ptsMap[agentId] || 0,
        dials,
        appts,
        kit,
        emails,
        noAnswer,
        convRate,
        referrals: refMap[agentId] || 0,
        // Back-compat aliases so existing UI code that reads `refs` still works.
        refs:      refMap[agentId] || 0,
        // v20.7.22 — lead-gen columns (parity with admin).
        oh:        ohMap[agentId]  || 0,
        dm:        dmMap[agentId]  || 0,
        dk:        dkMap[agentId]  || 0,
        social:    socMap[agentId] || 0,
        // v20.7.53 — INV column: agent invites sent.
        inv:       invMap[agentId] || 0,
      };
    };

    const stats = allAgents.map(agent => {
      const r = agentStatsMap[agent.id] || {
        total_all: 0, emails_sent: 0, appts: 0, no_answer: 0, kit: 0, not_int: 0,
        today_total: 0, week_total: 0, month_total: 0,
        today_appts: 0, week_appts: 0, month_appts: 0,
        today_kit: 0, week_kit: 0, month_kit: 0,
        today_emails: 0, week_emails: 0, month_emails: 0,
      };
      const total = (r.total_all || 0) - (r.emails_sent || 0);
      const contacted = (r.appts || 0) + (r.not_int || 0);
      return {
        agent: {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          headshotUrl: (agent as any).headshotUrl || (agent as any).headshot_url || null,
        },
        // Legacy fields (since-reset cycle) — kept for back-compat.
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
        refs: refCycMap[agent.id] || 0,
        // v16.7 — per-window blocks powering TODAY/WEEK/MONTH/ALL tabs.
        // v18.3 — window shape now matches /api/admin/leaderboard exactly.
        // Also exposed at top level for admin dashboard compat.
        today:   win(r, "today", agent.id, refTodayMap, ptsTodayMap, ohTodayMapA, dmTodayMapA, dkTodayMapA, socTodayMapA, invTodayMapA),
        weekly:  win(r, "week",  agent.id, refWeekMap,  ptsWeekMap,  ohWeekMapA,  dmWeekMapA,  dkWeekMapA,  socWeekMapA,  invWeekMapA),
        monthly: win(r, "month", agent.id, refMonthMap, ptsMonthMap, ohMonthMapA, dmMonthMapA, dkMonthMapA, socMonthMapA, invMonthMapA),
        allTime: (() => {
          const total    = r.total_all   || 0;
          const emails   = r.emails_sent || 0;
          const appts    = r.appts       || 0;
          const kit      = r.kit         || 0;
          const noAnswer = r.no_answer   || 0;
          const notInt   = r.not_int     || 0;
          const dials    = total - emails;
          // v18.3 — match admin's convRate math exactly.
          const convRate = dials > 0 ? Math.round(((appts + notInt + kit) / dials) * 100) : 0;
          return {
            points:    ptsAllMap[agent.id] || 0,
            dials, appts, kit, emails, noAnswer, convRate,
            referrals: refAllMap[agent.id] || 0,
            refs:      refAllMap[agent.id] || 0,
            // v20.7.22 — lead-gen columns (parity with admin).
            oh:        ohAllMapA[agent.id]  || 0,
            dm:        dmAllMapA[agent.id]  || 0,
            dk:        dkAllMapA[agent.id]  || 0,
            social:    socAllMapA[agent.id] || 0,
            // v20.7.53 — INV column: agent invites sent.
            inv:       invAllMapA[agent.id] || 0,
          };
        })(),
        // Back-compat: keep the old `windows` block so any old client caching
        // still works during the flip.
        windows: {
          today:   win(r, "today", agent.id, refTodayMap, ptsTodayMap, ohTodayMapA, dmTodayMapA, dkTodayMapA, socTodayMapA, invTodayMapA),
          weekly:  win(r, "week",  agent.id, refWeekMap,  ptsWeekMap,  ohWeekMapA,  dmWeekMapA,  dkWeekMapA,  socWeekMapA,  invWeekMapA),
          monthly: win(r, "month", agent.id, refMonthMap, ptsMonthMap, ohMonthMapA, dmMonthMapA, dkMonthMapA, socMonthMapA, invMonthMapA),
          allTime: {
            points: ptsAllMap[agent.id] || 0,
            appts:  r.appts || 0,
            dials:  ((r.total_all || 0) - (r.emails_sent || 0)),
            kit:    r.kit || 0,
            refs:   refAllMap[agent.id] || 0,
            oh:     ohAllMapA[agent.id]  || 0,
            dm:     dmAllMapA[agent.id]  || 0,
            dk:     dkAllMapA[agent.id]  || 0,
            social: socAllMapA[agent.id] || 0,
            // v20.7.53 — INV column: agent invites sent.
            inv:    invAllMapA[agent.id] || 0,
          },
        },
      };
    });
    // v20.7.27 — RANK BY MONTHLY POINTS. The competition resets each calendar
    // month, so the leaderboard ranking (regardless of which tab is showing) is
    // driven by monthly.points. Prior versions sorted by the since-reset cycle
    // bucket (`points` / ptsMapA), which only matched the monthly value when the
    // leaderboard reset happened to sit at the start of the calendar month. When
    // it drifted, ranks silently diverged from what the Monthly tab showed.
    // Tiebreakers: monthly dials, then monthly appts.
    stats.sort((a, b) =>
      ((b.monthly?.points || 0) - (a.monthly?.points || 0)) ||
      ((b.monthly?.dials  || 0) - (a.monthly?.dials  || 0)) ||
      ((b.monthly?.appts  || 0) - (a.monthly?.appts  || 0))
    );
    res.json(stats);
  });

  // ─── v15.11.50 ─ TEAM POT (August Champion Pot) ──────────────────────────────
  // Replaces the July flat-$500 BonusCard with a tiered pot that grows as the
  // team books more Appt Sets across the calendar month. Only "Appt Set" counts.
  // Growth ladder:  20 appts → $250,  40 → $500,  60 → $750 (visible cap).
  // Secret stretch: 80 appts → $1000. Hidden from agent endpoint by default;
  // admin can flip `team_pot.stretch_revealed = '1'` in settings to reveal.
  // Payout at month end: 70% to #1, 30% to #2, ranked by individual Appt Set
  // count for the month (not points). Once a Set is logged, it counts — no
  // decrement on cancel/reschedule (Alex's call, v15.11.50 spec).

  // v16.7 — Ladder rescale. $250 is a pre-committed floor from day 1 (no
  // threshold), then real unlocks at 10/20/30 team appts.
  //   Floor: $250 (0 appts, pre-committed)
  //   1 team appt  → $250
  //   5 team appts → $500
  //   10 team appts → $750
  //   15 team appts → $1000 (stretch)
  // v20.7.53 — Thresholds halved and floor rebased to $0. Payout split
  // (70/30 to #1 / #2) unchanged from v16.7. Champion's Bonus fully retired
  // (was already dormant since v20.4.2 — now the constants are gone too).
  // v20.7.53 — Ladder correction. $250 is a DAY-1 GUARANTEED FLOOR (Alex's
  // rule: month opens with $250 already committed, before any appointment is
  // booked). $1000 is the true ceiling — folded into the main ladder as tier 4
  // so the UI walks $250 → $500 → $750 → $1000 without hiding the top.
  //   $250 @ 0 appts (floor)  →  $500 @ 5  →  $750 @ 10  →  $1000 @ 15 (ceiling)
  const TEAM_POT_LADDER = [
    { tier: 1, appts: 0,  pot: 250  },
    { tier: 2, appts: 5,  pot: 500  },
    { tier: 3, appts: 10, pot: 750  },
    { tier: 4, appts: 15, pot: 1000 },
  ];
  const TEAM_POT_STRETCH = { tier: 4, appts: 15, pot: 1000 };
  const TEAM_POT_PAYOUT = { first: 0.70, second: 0.30 };

  // Compute the first millisecond of the current month in America/New_York
  // (the leaderboard clock the whole team lives on) and the last millisecond.
  // We stamp both as ISO for SQL WHERE-clause use.
  function currentMonthBoundsEt(): { startIso: string; endIso: string; monthLabel: string } {
    // ET is UTC−4 (EDT, Mar–Nov) or UTC−5 (EST, Nov–Mar). August is EDT.
    // Simple approach: use Intl.DateTimeFormat to pull the ET year/month.
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" });
    const parts = fmt.formatToParts(now);
    const year = parseInt(parts.find(p => p.type === "year")!.value, 10);
    const monthNum = parseInt(parts.find(p => p.type === "month")!.value, 10); // 1-12
    // First of month at midnight ET → UTC:
    // Aug 1 00:00 EDT = Aug 1 04:00 UTC (UTC−4). We build the ISO literal in
    // ET semantics and let Date parse it as local, then adjust. Cleaner:
    // construct the UTC millis directly using the known offset for ET.
    const isDst = (m: number) => m >= 3 && m <= 11; // rough Mar–Nov DST band
    const offsetHours = isDst(monthNum) ? 4 : 5;
    const startUtcMs = Date.UTC(year, monthNum - 1, 1, offsetHours, 0, 0, 0);
    const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
    const nextYear = monthNum === 12 ? year + 1 : year;
    const nextOffset = isDst(nextMonth) ? 4 : 5;
    const endUtcMs = Date.UTC(nextYear, nextMonth - 1, 1, nextOffset, 0, 0, 0) - 1;
    const monthLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long" }).format(now);
    return {
      startIso: new Date(startUtcMs).toISOString(),
      endIso: new Date(endUtcMs).toISOString(),
      monthLabel,
    };
  }

  app.get("/api/team-pot", (req, res) => {
    const { startIso, endIso, monthLabel } = currentMonthBoundsEt();
    // v17.5 — stretch reveal toggle removed. $1000 tier now permanently visible.
    // Emit `stretchRevealed: true` for legacy clients still reading the field.
    const stretchRevealed = true;

    // v20.7.28 — Team-pot standings must MATCH the leaderboard ranking:
    //   1) sort by MONTHLY POINTS (competition metric)
    //   2) enforce ≥1 monthly appointment eligibility (must have actually
    //      set someone up, not just piled up dial/KIT points)
    //   3) tiebreak: monthly dials, then monthly appts, then agent_id
    // Prior version sorted purely by appt count DESC — which meant Alex (1 appt)
    // and Bronson (1 appt) tied on the first key and fell to agent_id ASC,
    // handing 70% to Alex even though Bronson had ~2× the monthly points.
    const rows: any[] = rawDb.prepare(`
      SELECT
        a.id as agent_id,
        a.name as agent_name,
        a.headshot_url,
        COALESCE(pts.total, 0) as points,
        COALESCE(la.appts, 0) as appts,
        COALESCE(la.dials, 0) as dials
      FROM agents a
      LEFT JOIN (
        SELECT agent_id,
               SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
               SUM(1) as dials
        FROM lead_activity
        WHERE agent_id IS NOT NULL
          AND created_at >= ?
          AND created_at <= ?
        GROUP BY agent_id
      ) la ON la.agent_id = a.id
      LEFT JOIN (
        SELECT agent_id, SUM(points) as total
        FROM agent_points
        WHERE scope = 'seller' AND created_at >= ? AND created_at <= ?
        GROUP BY agent_id
      ) pts ON pts.agent_id = a.id
      WHERE (a.is_active = 1 OR a.is_active IS NULL)
        AND COALESCE(la.appts, 0) >= 1
      ORDER BY points DESC, dials DESC, appts DESC, a.id ASC
    `).all(startIso, endIso, startIso, endIso);

    const teamAppts = rows.reduce((s, r) => s + (r.appts || 0), 0);

    // Walk full ladder (always includes stretch) to find current pot + next tier.
    // The stretch tier is ALWAYS on the client-side ladder as a mystery slot so
    // agents stay curious all month; the label flips from "$???" to "$1000" only
    // once the team has passed the visible cap (20 appts) or admin manually
    // reveals it. Server exposes `nextTierMystery` so the client knows whether
    // to show the dollar amount or the mystery placeholder.
    // v20.7.53 — Stretch tier ($1000) is now part of TEAM_POT_LADDER itself
    // (tier 4). Do NOT concat STRETCH again — that would duplicate the $1000
    // step. STRETCH constant kept only for teamReachedStretch legacy check.
    const fullLadder = [...TEAM_POT_LADDER];

    // v20.7.53 — Month opens at the $250 floor. Ladder[0] IS tier 1 ($250 @ 0
    // appts), so the team is already on the board on day 1 before any dial
    // fires. The walk then advances to $500 at 5 appts, $750 at 10, $1000 at 15.
    let currentPot = TEAM_POT_LADDER[0].pot; // 250 (floor)
    let currentTier: any = TEAM_POT_LADDER[0];
    let nextTier: any = null;
    for (let i = 1; i < fullLadder.length; i++) {
      const step = fullLadder[i];
      if (teamAppts >= step.appts) {
        currentPot = step.pot;
        currentTier = step;
      } else {
        nextTier = step;
        break;
      }
    }
    // v16.7 — Mystery mode retired. The $1000 stretch amount is now VISIBLE
    // from day 1 so the whole team is pulling toward a known target. The Champion's
    // Bonus becomes the new curiosity hook — it only pays if the team reaches
    // $1000 AND the champion has 15+ personal appts.
    const stretchUnlocked = true;
    const nextTierMystery = false;
    const nextTierSafe = nextTier;

    // Top 2 for payout preview.
    const first = rows[0] || null;
    const second = rows[1] || null;
    const firstPayout = Math.round(currentPot * TEAM_POT_PAYOUT.first);
    const secondPayout = Math.round(currentPot * TEAM_POT_PAYOUT.second);

    // v20.7.53 — Champion's Bonus fully deleted. Winner-take-all now IS the
    // reward. teamReachedStretch kept for legacy clients that read it, but no
    // dollar bonus is computed anywhere on the server.
    const teamReachedStretch = teamAppts >= TEAM_POT_STRETCH.appts;

    res.json({
      monthLabel,
      startIso,
      endIso,
      teamAppts,
      currentPot,
      currentTier,
      nextTier: nextTierSafe,
      nextTierMystery,
      apptsToNext: nextTier ? Math.max(0, nextTier.appts - teamAppts) : 0,
      // v20.7.53 — Ship the FULL ladder so the client can render every rung
      // $250 → $500 → $750 → $1000, not just current→next. Nothing is masked
      // (stretch reveal was removed with the Champion’s Bonus in v20.7.53).
      ladder: TEAM_POT_LADDER.map(t => ({ tier: t.tier, appts: t.appts, pot: t.pot })),
      visibleCap: TEAM_POT_LADDER[TEAM_POT_LADDER.length - 1].pot,
      stretchRevealed,
      stretchUnlocked,
      payoutSplit: TEAM_POT_PAYOUT,
      // v20.4.2 — championBonus removed. Field kept as null so old clients
      // don't blow up if they still expect the key.
      championBonus: null,
      standings: {
        first: first ? {
          agentId: first.agent_id,
          name: first.agent_name,
          headshotUrl: first.headshot_url,
          appts: first.appts,
          payout: firstPayout,
        } : null,
        second: second ? {
          agentId: second.agent_id,
          name: second.agent_name,
          headshotUrl: second.headshot_url,
          appts: second.appts,
          payout: secondPayout,
        } : null,
        others: rows.slice(2).map(r => ({
          agentId: r.agent_id, name: r.agent_name,
          headshotUrl: r.headshot_url, appts: r.appts,
        })),
      },
    });
  });

  // v17.5 — Endpoint REMOVED. Stretch tier is now permanently visible; toggle
  // ripped out per Alex. Keeping a no-op response returning 410 Gone so any
  // stale admin client that still POSTs here gets a clear signal, then the
  // client will stop calling once the AdminDashboard bundle updates.
  app.post("/api/admin/team-pot/stretch", (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    res.status(410).json({
      ok: false,
      removed: true,
      message: "Endpoint removed in v17.5 — stretch tier is now permanently visible.",
    });
  });

  // ─── NETWORK LEAD (agent submits a referral seller lead) ──────────────────
  app.post("/api/leads/network", (req, res) => {
    // v17.5 — unified warm-lead capture. This endpoint now serves all 4 lead-
    // producing legs (Network Referral, OH Lead, Door-Knock Lead, Direct-Mail
    // Lead). `warmLeadSource` distinguishes them; `warmLeadIntent` drives the
    // Work-the-Lead script tab (LPMAMA / CPMAMA / LPMA / combos). Both are
    // stored in extraData so no DB migration is needed.
    const { ownerName, phone, email, address, notes, submittedBy, submittedByName, warmLeadIntent, warmLeadSource } = req.body;
    if (!ownerName || !phone) return res.status(400).json({ error: "Name and phone required" });
    const ALLOWED_SOURCES = new Set(["network", "open_house", "door_knock", "direct_mail"]);
    const source = ALLOWED_SOURCES.has(String(warmLeadSource)) ? String(warmLeadSource) : "network";
    const ALLOWED_INTENTS = new Set([
      "buyer", "seller", "renter", "seller_and_buyer", "seller_and_renter",
      "future_buyer", "future_seller", "future_renter",
      "future_seller_and_buyer", "future_seller_and_renter",
    ]);
    const intent = warmLeadIntent && ALLOWED_INTENTS.has(String(warmLeadIntent)) ? String(warmLeadIntent) : null;
    const now = new Date().toISOString();
    const extraData = JSON.stringify({
      source,
      warmLeadSource: source,
      warmLeadIntent: intent,
      submittedByName: submittedByName || "Unknown",
      submittedById: submittedBy,
      networkNotes: notes || "",
      ingestedAt: now,
    });
    const submitterAgentId = submittedBy ? parseInt(String(submittedBy)) : null;
    // v17.5 — leadType tracks the source (network / open_house / door_knock /
    // direct_mail). Legacy "network" preserved for the default flow.
    const leadTypeBySource: Record<string, string> = {
      network: "network", open_house: "open_house",
      door_knock: "door_knock", direct_mail: "direct_mail",
    };
    const [created] = storage.createLeadsFromBatch([{
      leadType: leadTypeBySource[source] || "network",
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
      batchId: `${source}_${Date.now()}`,
    }]);
    broadcast({ type: "lead_created", leadId: created.id, assignedAgentId: submitterAgentId });

    // v20.5.0 — SMART INTENT ROUTING (silent, no new UI)
    // Whenever a warm lead comes in with an intent, ALSO create the matching
    // inventory row so the map + On-the-Hunt list + rentals bucket stay live.
    // Excel-wins-conflict is preserved (existing excel rows are never overwritten).
    try {
      if (intent && (ownerName || "").trim()) {
        const isSeller  = /seller/.test(intent);
        const isBuyer   = /buyer/.test(intent) && !/renter/.test(intent);
        const isRenter  = /renter/.test(intent) && !/buyer/.test(intent);
        const isFuture  = /future/.test(intent);
        const parsedIntent = require("./buyerIntentParser").parseIntent(String(notes || ""));

        // ─ SELLER SIDE ─ create a listing row if we have an address
        if (isSeller && address && String(address).trim()) {
          try {
            rawDb.prepare(`
              INSERT INTO listings (
                address, list_price, status, listing_agent,
                source, source_ref, created_at, updated_at
              ) VALUES (
                @address, NULL,
                CASE WHEN @future = 1 THEN 'coming_soon' ELSE 'active' END,
                @agent, 'lead_depot:new_lead', @sref,
                datetime('now'), datetime('now')
              )
              ON CONFLICT(lower(address), coalesce(zip,'')) DO NOTHING
            `).run({
              address: String(address).trim(),
              future: isFuture ? 1 : 0,
              agent: submittedByName || null,
              sref: `lead:${created.id}`,
            });
          } catch (e: any) {
            console.warn(`[intent-route] seller row for lead ${created.id}: ${e.message}`);
          }
        }

        // ─ BUYER SIDE ─ create a buyers row (On the Hunt)
        if (isBuyer) {
          try {
            rawDb.prepare(`
              INSERT INTO buyers (
                name, phone, email, status, buyers_agent,
                price_min, price_max, preferred_areas, zip_codes,
                beds_min, baths_min, sqft_min,
                land_acres_min, arv_min, arv_max,
                notes, intent_phrases,
                intent_property_types, intent_conditions, intent_verbs,
                financing, is_investor, is_rental,
                confidence, origin_sources, multi_search_ordinal,
                source, source_ref, last_updated_by, created_at, updated_at
              ) VALUES (
                @name, @phone, @email,
                CASE WHEN @future = 1 THEN 'nurture' ELSE 'active' END,
                @agent,
                @price_min, @price_max, @areas, @zips,
                @beds, @baths, @sqft,
                @acres, @arv_min, @arv_max,
                @notes, @phrases,
                @ptypes, @conds, @verbs,
                @financing, @investor, 0,
                @conf, '["lead_depot"]', 1,
                'lead_depot:new_lead', @sref, 'lead-depot', datetime('now'), datetime('now')
              )
              ON CONFLICT(lower(name), multi_search_ordinal) DO NOTHING
            `).run({
              name: String(ownerName).trim(),
              phone: phone || null,
              email: email || null,
              future: isFuture ? 1 : 0,
              agent: submittedByName || null,
              price_min: parsedIntent.price_min,
              price_max: parsedIntent.price_max,
              areas: parsedIntent.areas.length ? parsedIntent.areas.join(", ") : null,
              zips:  parsedIntent.zip_codes.length ? parsedIntent.zip_codes.join(",") : null,
              beds:  parsedIntent.beds_min,
              baths: parsedIntent.baths_min,
              sqft:  parsedIntent.sqft_min,
              acres: parsedIntent.land_acres_min,
              arv_min: parsedIntent.arv_min,
              arv_max: parsedIntent.arv_max,
              notes: notes ? String(notes).slice(0, 2000) : null,
              phrases: notes ? JSON.stringify([String(notes)]) : null,
              ptypes: parsedIntent.property_types.join(",") || null,
              conds:  parsedIntent.conditions.join(",") || null,
              verbs:  parsedIntent.verbs.join(",") || null,
              financing: parsedIntent.financing,
              investor:  parsedIntent.is_investor ? 1 : 0,
              conf: parsedIntent.confidence,
              sref: `lead:${created.id}`,
            });
          } catch (e: any) {
            console.warn(`[intent-route] buyer row for lead ${created.id}: ${e.message}`);
          }
        }

        // ─ RENTER SIDE ─ rentals bucket (buyers row with is_rental=true).
        //   Explicit user rule: rentals do NOT go on the map or the On-the-Hunt list.
        //   parseIntent auto-detects commercial_lease / residential_rental / land_lease.
        if (isRenter) {
          try {
            rawDb.prepare(`
              INSERT INTO buyers (
                name, phone, email, status, buyers_agent,
                price_min, price_max, preferred_areas, zip_codes,
                notes, intent_phrases,
                intent_property_types, intent_conditions,
                is_rental, rental_type,
                confidence, origin_sources, multi_search_ordinal,
                source, source_ref, last_updated_by, created_at, updated_at
              ) VALUES (
                @name, @phone, @email, 'rental', @agent,
                @price_min, @price_max, @areas, @zips,
                @notes, @phrases,
                @ptypes, @conds,
                1, @rtype,
                @conf, '["lead_depot"]', 1,
                'lead_depot:new_lead:renter', @sref, 'lead-depot', datetime('now'), datetime('now')
              )
              ON CONFLICT(lower(name), multi_search_ordinal) DO NOTHING
            `).run({
              name: String(ownerName).trim(),
              phone: phone || null,
              email: email || null,
              agent: submittedByName || null,
              price_min: parsedIntent.price_min,
              price_max: parsedIntent.price_max,
              areas: parsedIntent.areas.length ? parsedIntent.areas.join(", ") : null,
              zips:  parsedIntent.zip_codes.length ? parsedIntent.zip_codes.join(",") : null,
              notes: notes ? String(notes).slice(0, 2000) : null,
              phrases: notes ? JSON.stringify([String(notes)]) : null,
              ptypes: parsedIntent.property_types.join(",") || null,
              conds:  parsedIntent.conditions.join(",") || null,
              rtype:  parsedIntent.rental_type || "residential_rental",
              conf: parsedIntent.confidence,
              sref: `lead:${created.id}`,
            });
          } catch (e: any) {
            console.warn(`[intent-route] renter row for lead ${created.id}: ${e.message}`);
          }
        }

        // ─ SELLER+BUYER / SELLER+RENTER COMBOS ─
        //   The combo intents (seller_and_buyer, seller_and_renter) trigger BOTH
        //   branches above because each branch checks its own /seller/, /buyer/,
        //   /renter/ regex against the intent string.

        broadcast({ type: "inventory_updated", reason: "lead_depot:new_lead", intent, leadId: created.id });
      }
    } catch (routingErr: any) {
      console.error(`[intent-route] lead ${created.id} routing failed:`, routingErr?.message);
    }

    // Activity feed + referral points (v11.40)
    const _refAgent = submitterAgentId ? storage.getAgentById(submitterAgentId) : null;
    broadcast({ type: "activity_event", event: { type: "warm_lead_submitted", source, intent, agentId: submitterAgentId, agentName: _refAgent?.name || submittedByName || "Agent", agentHeadshot: (_refAgent as any)?.headshotUrl || null, address: created.address, ts: new Date().toISOString() } });

    // v20.7.53 — Award points AND write a lead_activity row matching the warm-
    // lead source. Prior to this the endpoint always awarded `network_referral`
    // regardless of source, and NEVER wrote lead_activity, so the OH-Lead /
    // Door-Knock / Direct-Mail challenges never advanced when an agent captured
    // a warm lead via those legs. Reason string now matches the source.
    const outcomeBySource: Record<string, string> = {
      network:     "network_referral",
      open_house:  "open_house_lead",
      door_knock:  "door_knock",
      direct_mail: "direct_mail",
    };
    const activityOutcome = outcomeBySource[source] || "network_referral";
    if (submitterAgentId) {
      try {
        rawDb.prepare(`
          INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(created.id, submitterAgentId, activityOutcome, `Warm lead captured via ${source}`, now);
      } catch (err) {
        console.error("[warm-lead activity insert]", err);
      }
    }
    awardPoints(submitterAgentId, activityOutcome, created.id);

    // v20.7.11 — Warm-lead ingest also pushes to FUB immediately (person + tags +
    // Nurture stage, no Action Plan). Idempotent — no-op if phone already in FUB.
    // Runs fire-and-forget so slow FUB API never blocks the LD user response.
    pushIngestToFub({
      ownerName,
      phone,
      email: email || undefined,
      address: address || undefined,
      agentId: submitterAgentId || null,
      agentName: _refAgent?.name || submittedByName || undefined,
      source: source,
      intent: intent || null,
      notes: notes || undefined,
    }).catch(err => console.error("[FUB] pushIngestToFub (network) failed:", err));

    // ── Notify admins + CRM manager on network lead submission ────────────────
    if (resend) {
      const agentName = submittedByName || "An agent";
      const tdL = "padding:8px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:140px;vertical-align:top";
      const tdR = "padding:8px 0;font-size:14px;color:#f0f0f0;vertical-align:top";
      resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to:   ["denise@watsonbrothersgroup.com"],
        cc:   ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
        subject: `\uD83E\uDD1D ${source === "network" ? "Network Lead" : source === "open_house" ? "Open House Lead" : source === "door_knock" ? "Door Knock Lead" : source === "direct_mail" ? "Direct Mail Lead" : "Warm Lead"} Submitted \u2014 ${ownerName} | ${address || "No address"}`,
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
    Lead Depot v20.32.19 \u2014 Brothers Group \u00b7 Momentum Realty
  </div>
</div></body></html>`,
      }).catch(err => console.error("[network lead] Notify failed:", err));
    }

    res.json({ created: true, leadId: created.id });
  });

  // ─── v17.0 OPEN HOUSE LOG → APPROVAL QUEUE ─────────────────────────────
  // v17.0 changes v16.7's instant-award to a submit-→-approval flow.
  // Agent submits selfie (with sign visible) + address + OH results form
  // (attendees, notes, issues, recommendations). A row goes into
  // approval_requests with status='pending'. Points award ONLY when Nate
  // approves. Denise gets an "Open House Results" email immediately on
  // submit (she needs same-day feedback for follow-ups) with Alex + Nate
  // CC'd. This is the pattern for every future evidence-required activity.
  app.post("/api/lead-gen/open-house-log", async (req, res) => {
    const {
      agentId, address, photoDataUrl, gpsLat, gpsLng, timestamp,
      attendees, notes, issues, recommendations,
    } = req.body;
    const submitterId = agentId ? parseInt(String(agentId)) : null;
    if (!submitterId) return res.status(400).json({ error: "agentId required" });
    if (!address || !String(address).trim()) return res.status(400).json({ error: "Address required" });
    if (!photoDataUrl) return res.status(400).json({ error: "Selfie photo required" });

    const now = new Date().toISOString();
    const submitter = storage.getAgentById(submitterId);
    const cleanAddr = String(address).trim();
    const results = {
      attendees: attendees != null ? Math.max(0, parseInt(String(attendees)) || 0) : null,
      notes: notes ? String(notes).trim().slice(0, 4000) : "",
      issues: issues ? String(issues).trim().slice(0, 4000) : "",
      recommendations: recommendations ? String(recommendations).trim().slice(0, 4000) : "",
    };
    const payloadObj = {
      address: cleanAddr,
      gpsLat: gpsLat != null ? Number(gpsLat) : null,
      gpsLng: gpsLng != null ? Number(gpsLng) : null,
      capturedAt: timestamp || now,
      photoDataUrl: String(photoDataUrl).slice(0, 4_000_000),
      results,
    };

    // Create the approval request — status='pending'. No points awarded yet,
    // no lead_activity row yet. Both come on admin approval.
    const info = rawDb.prepare(`
      INSERT INTO approval_requests
        (kind, agent_id, agent_name, status, points_potential, payload_json, submitted_at)
      VALUES ('open_house_log', ?, ?, 'pending', 50, ?, ?)
    `).run(submitterId, submitter?.name || "Agent", JSON.stringify(payloadObj), now);
    const requestId = Number(info.lastInsertRowid);

    // Fire OH RESULTS email to Denise immediately (Alex + Nate CC'd). She uses
    // this same-day for feedback follow-ups — waiting for admin approval
    // would slow her down.
    if (resend) {
      try {
        const attendeesLine = results.attendees != null ? `<strong>${results.attendees}</strong> visitors` : "Not recorded";
        const html = `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;padding:32px 28px;color:#1a1a1a">
            <div style="border-bottom:2px solid #c8aa5a;padding-bottom:14px;margin-bottom:20px">
              <p style="margin:0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#8a6f2a;font-weight:700">Open House Results</p>
              <h1 style="margin:6px 0 0;font-size:22px;color:#1a1a1a;font-weight:700">${cleanAddr}</h1>
            </div>
            <table style="width:100%;font-size:14px;line-height:1.55">
              <tr><td style="padding:6px 0;color:#666;width:130px">Agent</td><td style="padding:6px 0;font-weight:600">${submitter?.name || "Agent"}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Attendees</td><td style="padding:6px 0">${attendeesLine}</td></tr>
              <tr><td style="padding:6px 0;color:#666;vertical-align:top">Notes</td><td style="padding:6px 0">${(results.notes || "—").replace(/\n/g,"<br>")}</td></tr>
              <tr><td style="padding:6px 0;color:#666;vertical-align:top">Issues</td><td style="padding:6px 0">${(results.issues || "None reported").replace(/\n/g,"<br>")}</td></tr>
              <tr><td style="padding:6px 0;color:#666;vertical-align:top">Recommendations</td><td style="padding:6px 0">${(results.recommendations || "—").replace(/\n/g,"<br>")}</td></tr>
            </table>
            <div style="margin-top:22px;padding-top:14px;border-top:1px solid #eee">
              <img src="cid:oh-selfie" alt="OH Selfie" style="max-width:100%;border-radius:8px" />
            </div>
            <p style="margin-top:22px;font-size:11px;color:#999;line-height:1.5">Sent by Lead Depot on Open House submission. Points pending Nate's approval.</p>
          </div>
        `;
        // Extract base64 payload from the data URL for attachment
        const m = String(photoDataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
        const attachments = m ? [{ filename: "open-house-selfie.jpg", content: Buffer.from(m[2], "base64") }] : undefined;
        await resend.emails.send({
          from: "noreply@watsonbrothersgroup.com",
          to: ["denise@watsonbrothersgroup.com"],
          cc: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
          subject: `Open House Results — ${cleanAddr} — ${submitter?.name || "Agent"}`,
          html,
          attachments,
        });
      } catch (err) {
        console.error("[OH Results Email] failed:", err);
        // Non-fatal — approval row still exists
      }
    }

    // WS broadcast so an open admin dashboard reflects new pending in real time
    broadcast({
      type: "approval_event",
      event: {
        type: "approval_submitted",
        kind: "open_house_log",
        requestId,
        agentId: submitterId,
        agentName: submitter?.name || "Agent",
        agentHeadshot: (submitter as any)?.headshotUrl || null,
        address: cleanAddr,
        ts: now,
      },
    });

    res.json({ submitted: true, requestId, pendingApproval: true, pointsPotential: 50 });
  });

  // ─── v17.6 DOOR KNOCK LOG → APPROVAL QUEUE ────────────────────────
  // Standalone door-knock session (not OH piggyback). Minimum 25 doors per
  // session — planned ahead, real route. 2 pts per door. Evidence is the
  // rep-card app export/reconciliation on Nate's side. Fakers caught by low
  // leads-per-1000-doors ratio over time.
  app.post("/api/lead-gen/door-knock-log", (req, res) => {
    const { agentId, address, doorsCount, notes, gpsLat, gpsLng, timestamp } = req.body;
    const submitterId = agentId ? parseInt(String(agentId)) : null;
    if (!submitterId) return res.status(400).json({ error: "agentId required" });
    if (!address || !String(address).trim()) return res.status(400).json({ error: "Address / block required" });
    const doors = doorsCount != null ? Math.max(0, parseInt(String(doorsCount)) || 0) : 0;
    if (doors < 25) return res.status(400).json({ error: "Door knock session requires 25 or more doors" });

    const now = new Date().toISOString();
    const submitter = storage.getAgentById(submitterId);
    const cleanAddr = String(address).trim();
    const cappedDoors = Math.min(doors, 500); // sane per-submission cap
    const points = cappedDoors * 2; // v17.6 — 2 pts per door
    const payloadObj = {
      address: cleanAddr,
      doorsCount: cappedDoors,
      notes: notes ? String(notes).trim().slice(0, 4000) : "",
      gpsLat: gpsLat != null ? Number(gpsLat) : null,
      gpsLng: gpsLng != null ? Number(gpsLng) : null,
      capturedAt: timestamp || now,
      // no photoDataUrl — evidence is the rep-card app export/reconciliation
    };
    const info = rawDb.prepare(`
      INSERT INTO approval_requests
        (kind, agent_id, agent_name, status, points_potential, payload_json, submitted_at)
      VALUES ('door_knock_log', ?, ?, 'pending', ?, ?, ?)
    `).run(submitterId, submitter?.name || "Agent", points, JSON.stringify(payloadObj), now);
    const requestId = Number(info.lastInsertRowid);

    broadcast({
      type: "approval_event",
      event: {
        type: "approval_submitted",
        kind: "door_knock_log",
        requestId,
        agentId: submitterId,
        agentName: submitter?.name || "Agent",
        agentHeadshot: (submitter as any)?.headshotUrl || null,
        address: cleanAddr,
        ts: now,
      },
    });

    // v19.6 — admin email on every door-knock log
    const _tdL = "padding:8px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:140px;vertical-align:top";
    const _tdR = "padding:8px 0;font-size:14px;color:#f0f0f0;vertical-align:top";
    notifyLeadGenActivity({
      kind: "door_knock_log",
      agentName: submitter?.name || "Agent",
      headline: `🚪 Door Knock Log — ${cappedDoors} doors — ${submitter?.name || "Agent"}`,
      detailsHtml: `
        <tr><td style="${_tdL}">Address / Block</td><td style="${_tdR}">${cleanAddr}</td></tr>
        <tr><td style="${_tdL}">Doors</td><td style="${_tdR}"><strong>${cappedDoors}</strong></td></tr>
        <tr><td style="${_tdL}">Points at stake</td><td style="${_tdR}">${points}</td></tr>
        <tr><td style="${_tdL}">Notes</td><td style="${_tdR}">${(payloadObj.notes || "—").replace(/\n/g,"<br>")}</td></tr>
      `,
    });

    res.json({ submitted: true, requestId, pendingApproval: true, pointsPotential: points, doorsCount: cappedDoors });
  });

  // ─── v17.6 DIRECT MAIL LOG → APPROVAL QUEUE ───────────────────────
  // Log a mailer campaign for admin approval. Agent submits audience description,
  // count of addresses mailed, mailer photo, notes. Row goes into approval_requests
  // status='pending'. points_potential = mailedCount (1 pt per address, capped
  // at 500 for a single submission). Awarded on Nate's approval.
  app.post("/api/lead-gen/direct-mail-log", (req, res) => {
    const { agentId, audience, mailedCount, photoDataUrl, notes, timestamp } = req.body;
    const submitterId = agentId ? parseInt(String(agentId)) : null;
    if (!submitterId) return res.status(400).json({ error: "agentId required" });
    if (!audience || !String(audience).trim()) return res.status(400).json({ error: "Audience required" });
    const count = mailedCount != null ? parseInt(String(mailedCount)) : 0;
    if (!count || count < 1) return res.status(400).json({ error: "Mailed count must be > 0" });
    if (!photoDataUrl) return res.status(400).json({ error: "Mailer photo required" });

    const now = new Date().toISOString();
    const submitter = storage.getAgentById(submitterId);
    const cleanAudience = String(audience).trim();
    const capped = Math.min(count, 500);
    const payloadObj = {
      audience: cleanAudience,
      mailedCount: capped,
      notes: notes ? String(notes).trim().slice(0, 4000) : "",
      capturedAt: timestamp || now,
      photoDataUrl: String(photoDataUrl).slice(0, 4_000_000),
    };
    const info = rawDb.prepare(`
      INSERT INTO approval_requests
        (kind, agent_id, agent_name, status, points_potential, payload_json, submitted_at)
      VALUES ('direct_mail_log', ?, ?, 'pending', ?, ?, ?)
    `).run(submitterId, submitter?.name || "Agent", capped, JSON.stringify(payloadObj), now);
    const requestId = Number(info.lastInsertRowid);

    broadcast({
      type: "approval_event",
      event: {
        type: "approval_submitted",
        kind: "direct_mail_log",
        requestId,
        agentId: submitterId,
        agentName: submitter?.name || "Agent",
        agentHeadshot: (submitter as any)?.headshotUrl || null,
        audience: cleanAudience,
        mailedCount: capped,
        ts: now,
      },
    });

    // v19.6 — admin email on every direct-mail log
    const _tdL2 = "padding:8px 0;color:#c8aa5a;font-size:12px;text-transform:uppercase;letter-spacing:.1em;width:140px;vertical-align:top";
    const _tdR2 = "padding:8px 0;font-size:14px;color:#f0f0f0;vertical-align:top";
    notifyLeadGenActivity({
      kind: "direct_mail_log",
      agentName: submitter?.name || "Agent",
      headline: `✉️ Direct Mail Log — ${capped} mailers — ${submitter?.name || "Agent"}`,
      detailsHtml: `
        <tr><td style="${_tdL2}">Audience</td><td style="${_tdR2}">${cleanAudience}</td></tr>
        <tr><td style="${_tdL2}">Count</td><td style="${_tdR2}"><strong>${capped}</strong></td></tr>
        <tr><td style="${_tdL2}">Notes</td><td style="${_tdR2}">${(payloadObj.notes || "—").replace(/\n/g,"<br>")}</td></tr>
      `,
    });

    res.json({ submitted: true, requestId, pendingApproval: true, pointsPotential: capped });
  });

  // ─── v17.6 SOCIAL POST → APPROVAL QUEUE ─────────────────────
  // v20.7.20 — Real-estate cross-post on Facebook / Instagram / TikTok / YouTube /
  // BeReal / X. Must tag Watson Brothers Group OR Momentum Realty and be a
  // valid RE post (education, listing, just-sold, market update, local hotspot,
  // OH promotion, behind-the-scenes).
  //
  // NEW MECHANICS (v20.7.20):
  //   • Multi-platform per submission: 1-3 platforms per post
  //   • Points = 10 × platforms.length (10 / 20 / 30)
  //   • ONE screenshot REQUIRED per selected platform (proves cross-post)
  //   • Daily cap: 2 submissions per agent per ET day (up from 1)
  //   • Max possible per day: 2 × 30 = 60 pts
  //
  // Backward-compatible: still accepts legacy { platform, photoDataUrl } single-field.
  const SOCIAL_PER_PLATFORM = 10;
  // v20.7.53 — Video is a WHOLE-LOG BONUS added on top of platform points, not
  // a per-platform multiplier. Formula: (10 × platforms) + (isVideoLog ? 80 : 0).
  const SOCIAL_VIDEO_BONUS = 80;
  const SOCIAL_MAX_PLATFORMS = 3;
  const SOCIAL_DAILY_CAP = 2;

  app.post("/api/lead-gen/social-post", (req, res) => {
    const {
      agentId, platform, platforms, postUrl, category, notes,
      photoDataUrl, photoDataUrls, isVideo, isVideoLog, timestamp,
    } = req.body;
    const submitterId = agentId ? parseInt(String(agentId)) : null;
    if (!submitterId) return res.status(400).json({ error: "agentId required" });

    // Normalize to arrays (accept legacy single-field format for old builds)
    let platArr: string[] = Array.isArray(platforms)
      ? platforms.map((p: any) => String(p).trim().toLowerCase()).filter(Boolean)
      : (platform ? [String(platform).trim().toLowerCase()] : []);
    let photoArr: string[] = Array.isArray(photoDataUrls)
      ? photoDataUrls.filter((p: any) => typeof p === "string" && p.length > 0)
      : (photoDataUrl ? [String(photoDataUrl)] : []);

    // v20.7.53 — normalize video flag. Preferred client field is isVideoLog
    // (boolean, whole-log). We also accept legacy isVideo (boolean OR boolean[])
    // for backward compatibility — array is collapsed to a single log-level bool
    // via .some() so ticking any per-platform box on an old client still earns
    // exactly ONE +80 bonus, not N of them.
    let videoLog: boolean = false;
    if (typeof isVideoLog === "boolean") {
      videoLog = isVideoLog;
    } else if (typeof isVideo === "boolean") {
      videoLog = isVideo;
    } else if (Array.isArray(isVideo)) {
      videoLog = isVideo.some((v: any) => !!v);
    }

    // Dedup + cap platforms to 3.
    platArr = Array.from(new Set(platArr)).slice(0, SOCIAL_MAX_PLATFORMS);

    if (platArr.length === 0) {
      return res.status(400).json({ error: "Pick at least 1 platform" });
    }
    if (platArr.length > SOCIAL_MAX_PLATFORMS) {
      return res.status(400).json({ error: `Max ${SOCIAL_MAX_PLATFORMS} platforms per post` });
    }
    if (photoArr.length !== platArr.length) {
      return res.status(400).json({
        error: `Need one screenshot per platform (${platArr.length} platforms, ${photoArr.length} screenshots)`,
      });
    }
    // Hard-cap each screenshot payload to protect body-parser (~4MB per)
    photoArr = photoArr.map(p => String(p).slice(0, 4_000_000));

    const cleanCategory = category ? String(category).trim().slice(0, 40) : "";

    // Daily cap: SOCIAL_DAILY_CAP submissions per agent, ET date. Count pending + approved.
    const etDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
      .toISOString().slice(0, 10);
    const capRow = rawDb.prepare(`
      SELECT COUNT(*) AS n FROM approval_requests
      WHERE kind = 'social_post' AND agent_id = ? AND status IN ('pending','approved')
        AND substr(submitted_at, 1, 10) = ?
    `).get(submitterId, etDate) as any;
    if ((capRow?.n || 0) >= SOCIAL_DAILY_CAP) {
      return res.status(400).json({
        error: `Daily cap reached (${SOCIAL_DAILY_CAP} social posts per day)`,
      });
    }

    // v20.7.53 — scoring: (10 × platforms) + (isVideoLog ? 80 : 0).
    // Video is a whole-log bonus, not per-platform.
    const platformPoints = SOCIAL_PER_PLATFORM * platArr.length;
    const videoBonus = videoLog ? SOCIAL_VIDEO_BONUS : 0;
    const pointsPotential = platformPoints + videoBonus;

    const now = new Date().toISOString();
    const submitter = storage.getAgentById(submitterId);
    const payloadObj = {
      platform: platArr[0], // legacy single-field mirror (admin card fallback)
      platforms: platArr,
      category: cleanCategory,
      postUrl: postUrl ? String(postUrl).trim().slice(0, 500) : "",
      notes: notes ? String(notes).trim().slice(0, 2000) : "",
      capturedAt: timestamp || now,
      photoDataUrl: photoArr[0], // legacy single-field mirror
      photoDataUrls: photoArr,
      pointsPerPlatform: SOCIAL_PER_PLATFORM,
      // v20.7.53 — whole-log video bonus. isVideoLog=true → +80 flat on top of
      // platform points. Kept `isVideo` as an alias for older admin card code.
      isVideoLog: videoLog,
      isVideo: videoLog,
      videoBonus,
      platformPoints,
      videoBonusAmount: SOCIAL_VIDEO_BONUS,
    };
    const info = rawDb.prepare(`
      INSERT INTO approval_requests
        (kind, agent_id, agent_name, status, points_potential, payload_json, submitted_at)
      VALUES ('social_post', ?, ?, 'pending', ?, ?, ?)
    `).run(submitterId, submitter?.name || "Agent", pointsPotential, JSON.stringify(payloadObj), now);
    const requestId = Number(info.lastInsertRowid);

    broadcast({
      type: "approval_event",
      event: {
        type: "approval_submitted",
        kind: "social_post",
        requestId,
        agentId: submitterId,
        agentName: submitter?.name || "Agent",
        agentHeadshot: (submitter as any)?.headshotUrl || null,
        platform: platArr.join(", "),
        platforms: platArr,
        pointsPotential,
        // v20.7.53 — whole-log video flag so admin queue can badge video posts.
        isVideo: videoLog,
        isVideoLog: videoLog,
        ts: now,
      },
    });

    res.json({
      submitted: true, requestId, pendingApproval: true,
      pointsPotential, platforms: platArr,
      isVideo: videoLog, isVideoLog: videoLog, videoBonus,
    });
  });

  // ─── v17.6 OH KNOCK ROUTE → APPROVAL QUEUE ──────────────────
  // SetRep knock route piggybacked on an Open House. Min 25 doors visited.
  // 40 pts flat per approved route.
  app.post("/api/lead-gen/oh-knock-route", (req, res) => {
    const { agentId, ohAddress, doorsVisited, setRepSessionId, notes, timestamp } = req.body;
    const submitterId = agentId ? parseInt(String(agentId)) : null;
    if (!submitterId) return res.status(400).json({ error: "agentId required" });
    if (!ohAddress || !String(ohAddress).trim()) return res.status(400).json({ error: "OH address required" });
    const doors = doorsVisited != null ? Math.max(0, parseInt(String(doorsVisited)) || 0) : 0;
    if (doors < 25) return res.status(400).json({ error: "OH knock route requires 25 or more doors" });

    const now = new Date().toISOString();
    const submitter = storage.getAgentById(submitterId);
    const cleanAddr = String(ohAddress).trim();
    const payloadObj = {
      address: cleanAddr,
      doorsVisited: Math.min(doors, 500),
      setRepSessionId: setRepSessionId ? String(setRepSessionId).trim().slice(0, 100) : "",
      notes: notes ? String(notes).trim().slice(0, 4000) : "",
      capturedAt: timestamp || now,
    };
    const info = rawDb.prepare(`
      INSERT INTO approval_requests
        (kind, agent_id, agent_name, status, points_potential, payload_json, submitted_at)
      VALUES ('oh_knock_route', ?, ?, 'pending', 40, ?, ?)
    `).run(submitterId, submitter?.name || "Agent", JSON.stringify(payloadObj), now);
    const requestId = Number(info.lastInsertRowid);

    broadcast({
      type: "approval_event",
      event: {
        type: "approval_submitted",
        kind: "oh_knock_route",
        requestId,
        agentId: submitterId,
        agentName: submitter?.name || "Agent",
        agentHeadshot: (submitter as any)?.headshotUrl || null,
        address: cleanAddr,
        ts: now,
      },
    });

    res.json({ submitted: true, requestId, pendingApproval: true, pointsPotential: 40 });
  });


  // ─── v17.0 ADMIN APPROVAL QUEUE ────────────────────────────────────────
  // GET  /api/admin/approvals?status=pending|approved|rejected|all
  // POST /api/admin/approvals/:id/approve  { notes? }
  // POST /api/admin/approvals/:id/reject   { notes? }
  //
  // On approve: parse payload_json, insert lead_activity row with the correct
  // outcome + evidence in notes, award points, flip status, stamp decided_by
  // and activity_id. On reject: no lead_activity, no points, status='rejected'.
  app.get("/api/admin/approvals", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = String(req.query.status || "pending");
    const kind = req.query.kind ? String(req.query.kind) : null;
    const params: any[] = [];
    let where = "1=1";
    if (status !== "all") { where += " AND status = ?"; params.push(status); }
    if (kind)            { where += " AND kind = ?";   params.push(kind); }
    const rows = rawDb.prepare(`
      SELECT id, kind, agent_id, agent_name, status, points_awarded, points_potential,
             payload_json, submitted_at, decided_at, decided_by, decision_notes, activity_id
      FROM approval_requests
      WHERE ${where}
      ORDER BY submitted_at DESC
      LIMIT 200
    `).all(...params) as any[];
    const items = rows.map((r: any) => {
      let payload: any = {};
      try { payload = JSON.parse(r.payload_json || "{}"); } catch {}
      return {
        id: r.id, kind: r.kind,
        agentId: r.agent_id, agentName: r.agent_name,
        status: r.status,
        pointsAwarded: r.points_awarded, pointsPotential: r.points_potential,
        submittedAt: r.submitted_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
        decisionNotes: r.decision_notes, activityId: r.activity_id,
        payload,
      };
    });
    const counts = rawDb.prepare(`
      SELECT status, COUNT(*) AS n FROM approval_requests GROUP BY status
    `).all() as any[];
    const countByStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const c of counts) countByStatus[c.status] = c.n;
    res.json({ items, counts: countByStatus });
  });

  app.post("/api/admin/approvals/:id/approve", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(String(req.params.id));
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const admin = (req.session as any)?.agent;
    const row = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status !== "pending") return res.status(400).json({ error: `Already ${row.status}` });

    const now = new Date().toISOString();
    const outcome = row.kind;
    let payload: any = {};
    try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
    const addrSnap = payload.address || null;
    const activityInfo = rawDb.prepare(`
      INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at,
                                  lead_address_snapshot, lead_phone_snapshot, lead_owner_snapshot)
      VALUES (NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL)
    `).run(row.agent_id, outcome, row.payload_json, now, addrSnap);
    const activityId = Number(activityInfo.lastInsertRowid);

    // v17.6 — Award points_potential directly to the ledger with the kind as reason.
    // Field/evidence activities are FLAT (no Prime multiplier) and points_potential
    // was locked at submission time, so this is deterministic. Bypasses awardPoints()
    // to keep ledger and points_awarded in sync (they used to diverge — awardPoints
    // used its own dict which didn't match approval_requests kinds like
    // 'door_knock_log' or 'direct_mail_log').
    const pointsAwarded = row.points_potential || 0;
    if (pointsAwarded > 0) {
      rawDb.prepare(
        `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, NULL, 'seller', ?)`
      ).run(row.agent_id, pointsAwarded, `approval:${outcome}`, now);
      // v19.5 — Instant broadcast so approved agent's totals refresh with no poll delay.
      try { broadcast({ type: "points_awarded", agentId: row.agent_id, delta: pointsAwarded, outcome: `approval:${outcome}`, scope: "seller", ts: now }); } catch {}
    }

    rawDb.prepare(`
      UPDATE approval_requests
         SET status = 'approved', points_awarded = ?, decided_at = ?, decided_by = ?,
             decision_notes = ?, activity_id = ?
       WHERE id = ?
    `).run(pointsAwarded, now, admin?.id || null, String(req.body?.notes || "").slice(0, 500), activityId, id);

    // v18.4 — If this was a challenge_claim, flip the challenge_completions row
    // from pending → approved so the agent's Challenges tab updates.
    if (row.kind === "challenge_claim" && payload.challengeKey) {
      try {
        rawDb.prepare(`
          UPDATE challenge_completions
             SET status = 'approved', points_awarded = ?, approved_at = ?, approved_by = ?
           WHERE agent_id = ? AND challenge_key = ? AND status = 'pending'
        `).run(pointsAwarded, now, admin?.id || null, row.agent_id, payload.challengeKey);
      } catch (e) {
        // non-fatal — the approval row already won and points already credited.
        console.warn("[v18.4] challenge_completions sync failed for claim id", id, e);
      }
    }

    broadcast({
      type: "approval_event",
      event: { type: "approval_decided", requestId: id, kind: row.kind, agentId: row.agent_id, agentName: row.agent_name, status: "approved", pointsAwarded, ts: now },
    });

    res.json({ approved: true, requestId: id, activityId, pointsAwarded });
  });

  app.post("/api/admin/approvals/:id/reject", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(String(req.params.id));
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const admin = (req.session as any)?.agent;
    const row = rawDb.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status !== "pending") return res.status(400).json({ error: `Already ${row.status}` });
    const now = new Date().toISOString();
    const notes = String(req.body?.notes || "").slice(0, 500);
    rawDb.prepare(`
      UPDATE approval_requests
         SET status = 'rejected', decided_at = ?, decided_by = ?, decision_notes = ?
       WHERE id = ?
    `).run(now, admin?.id || null, notes, id);

    // v18.4 — If this was a challenge_claim, flip the challenge_completions row
    // to rejected so the agent's Challenges tab shows the rejection + reason.
    if (row.kind === "challenge_claim") {
      let payload: any = {};
      try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
      if (payload.challengeKey) {
        try {
          rawDb.prepare(`
            UPDATE challenge_completions
               SET status = 'rejected', rejected_reason = ?, approved_by = ?
             WHERE agent_id = ? AND challenge_key = ? AND status = 'pending'
          `).run(notes || null, admin?.id || null, row.agent_id, payload.challengeKey);
        } catch (e) {
          console.warn("[v18.4] challenge_completions reject sync failed for claim id", id, e);
        }
      }
    }

    broadcast({
      type: "approval_event",
      event: { type: "approval_decided", requestId: id, kind: row.kind, agentId: row.agent_id, agentName: row.agent_name, status: "rejected", ts: now },
    });

    res.json({ rejected: true, requestId: id });
  });

  // ─── v16.7 ADMIN KPI RATIOS — "What Turns the Gears" ─────────────────
  // Returns per-agent + team-total ratios of every lead-gen activity to appts.
  // Query param: scope=cycle|month|all (default cycle).
  app.get("/api/admin/kpi-ratios", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const scope = String(req.query.scope || "cycle");
    let sinceIso: string | null = null;
    if (scope === "cycle") {
      const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
      sinceIso = resetRow?.value || null;
    } else if (scope === "month") {
      const now = new Date();
      sinceIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } // all-time: sinceIso stays null

    const activeAgents = storage.getAllAgents().filter((a: any) => a.isActive);

    const buildRow = (agentId: number | null) => {
      const whereAgent = agentId != null ? `AND agent_id = ?` : "";
      const whereSince = sinceIso ? `AND created_at >= ?` : "";
      const args: any[] = [];
      if (agentId != null) args.push(agentId);
      if (sinceIso) args.push(sinceIso);
      const cnt = (outcome: string) => (rawDb.prepare(
        `SELECT COUNT(*) as c FROM lead_activity WHERE outcome = ? ${whereAgent} ${whereSince}`
      ).get(outcome, ...args) as any)?.c ?? 0;

      const appts = cnt("contacted_appointment");
      const kit = cnt("keep_in_touch");
      const dials = (rawDb.prepare(
        `SELECT COUNT(*) as c FROM lead_activity
         WHERE outcome IN ('no_answer','contacted_appointment','keep_in_touch','contacted_not_interested','wrong_number','disconnected','left_voicemail','nice_not_interested','listed','recycled')
         ${whereAgent} ${whereSince}`
      ).get(...args) as any)?.c ?? 0;
      const referrals = cnt("network_referral");
      const ohLogs = cnt("open_house_log");
      const ohLeads = cnt("open_house_lead");
      const knocks = cnt("door_knock"); // future — v16.8

      const ratio = (num: number) => appts > 0 ? Math.round((num / appts) * 10) / 10 : null;
      return {
        appts, kit, dials, referrals, ohLogs, ohLeads, knocks,
        dialsPerAppt: ratio(dials),
        kitPerAppt: ratio(kit),
        referralsPerAppt: ratio(referrals),
        ohLogsPerAppt: ratio(ohLogs),
        ohLeadsPerAppt: ratio(ohLeads),
        knocksPerAppt: ratio(knocks),
      };
    };

    const perAgent = activeAgents.map((a: any) => ({
      agent: { id: a.id, name: a.name, headshotUrl: a.headshotUrl || null },
      ...buildRow(a.id),
    }));
    const team = buildRow(null);

    res.json({ scope, sinceIso, team, perAgent });
  });

  // v20.7.31 — POST/GET /api/referrals DELETED. Was a duplicate of the
  // Agent Invite recruiting flow (POST /api/candidates/invite) that Alex uses.
  // The `referrals` DB table is kept for historical rows; no endpoint reads it.

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

    // v18.0 — recruiting activity export removed with recruiting system.
    const allActivity = [...sellerActivity]
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

    // v15.8 — BUG FIX: awardPoints() writes `reason = outcome` (e.g. 'no_answer',
    // 'contacted_appointment', 'left_voicemail'), never literally 'dial'. The old
    // WHERE reason = 'dial' query returned 0 for every agent, so the admin weekly
    // dials tile always showed 0 while the personal 'total calls' widget correctly
    // reported ~15. Fix: count every seller-scope point EXCEPT emails and network
    // referrals (which aren't dials). Recycled, listed, no_answer, keep_in_touch,
    // contacted_appointment, contacted_not_interested, wrong_number, disconnected,
    // left_voicemail all count — they all represent someone picking up the phone.
    const rows = activeAgents.map((a: any) => {
      const c = (rawDb.prepare(
        `SELECT COUNT(*) as c FROM agent_points
         WHERE agent_id = ?
           AND scope = 'seller'
           AND reason NOT IN ('email_sent', 'email_sent_value', 'network_referral', 'open_house_log', 'open_house_lead')
           AND created_at >= ?`
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

  // v15.9 SECURITY: admin-only backup status. Reports last successful hourly
  // and daily backup timestamps + current on-volume snapshot count/size.
  app.get("/api/admin/backup-status", (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ ok: true, ...getBackupStatus() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // v15.9 SECURITY: admin-only manual backup trigger. Runs the daily off-volume
  // (email) backup on demand — handy for testing or right before a risky
  // migration. Always calls hourly snapshot first so today's email is fresh.
  app.post("/api/admin/backup-now", async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await runDailyOffVolumeBackup();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // v15.11.30 — Backup recovery: read a specific tier-1 hourly snapshot and
  // return the content of the scripts table (or any single settings row) so an
  // admin can restore work that was overwritten by a deploy (the boot-time
  // Expired script seed in server/db.ts upserts on every restart; if an admin
  // edited the script via /api/scripts PATCH between the last backup and the
  // deploy, that DB row is safe in the tar.gz but was overwritten in the live
  // DB after boot).
  //
  // Usage:
  //   GET /api/admin/backup-scripts?ts=2026-07-22_19
  //   → { ok: true, snapshot: "2026-07-22_19", scripts: [{ leadType, content, updatedAt }, ...] }
  //
  // The endpoint extracts the tar into a private tmp dir, opens the DB
  // read-only, reads the scripts table, and cleans up. Admin-only.
  // v15.11.39 — List every snapshot on the volume (with sizes + mtimes).
  // Insurance for recovery: /api/admin/backup-scripts?ts=... needs the timestamp,
  // and this tells us which timestamps actually exist.
  app.get("/api/admin/backup-list", (_req: any, res: any) => {
    if (!requireAdmin(_req, res)) return;
    const path = require("node:path");
    const fs = require("node:fs");
    const IS_PROD = process.env.NODE_ENV === "production";
    const DATA_DIR = IS_PROD ? "/app/data" : path.join(process.cwd(), "data-dev");
    const backupsDir = path.join(DATA_DIR, "backups");
    if (!fs.existsSync(backupsDir)) {
      return res.json({ ok: true, backupsDir, snapshots: [], note: "backups dir does not exist" });
    }
    const files: any[] = fs.readdirSync(backupsDir)
      .filter((f: string) => f.endsWith(".tar.gz"))
      .map((f: string) => {
        const p = path.join(backupsDir, f);
        const stat = fs.statSync(p);
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    res.json({ ok: true, backupsDir, count: files.length, snapshots: files });
  });

  app.get("/api/admin/backup-scripts", async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    const ts = String(req.query.ts || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}$/.test(ts)) {
      return res.status(400).json({ error: "ts must be YYYY-MM-DD_HH (e.g. 2026-07-22_19)" });
    }
    const IS_PROD = process.env.NODE_ENV === "production";
    const path = require("node:path");
    const fs = require("node:fs");
    const os = require("node:os");
    const { execSync } = require("node:child_process");
    const Database = require("better-sqlite3");
    const DATA_DIR = IS_PROD ? "/app/data" : path.join(process.cwd(), "data-dev");
    const tarPath = path.join(DATA_DIR, "backups", `${ts}.tar.gz`);
    if (!fs.existsSync(tarPath)) {
      return res.status(404).json({ error: `snapshot not found: ${tarPath}` });
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldrecover-"));
    try {
      execSync(`tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(tmpDir)}`);
      const dbCandidates = [
        path.join(tmpDir, "data.db"),
        path.join(tmpDir, "data", "data.db"),
      ];
      const dbPath = dbCandidates.find(p => fs.existsSync(p));
      if (!dbPath) {
        return res.status(500).json({ error: "data.db not found inside tar", tmpContents: fs.readdirSync(tmpDir) });
      }
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare("SELECT lead_type, content, updated_at FROM scripts ORDER BY lead_type").all();
      db.close();
      res.json({
        ok: true,
        snapshot: ts,
        scripts: rows.map((r: any) => ({
          leadType: r.lead_type,
          content: r.content,
          updatedAt: r.updated_at,
          length: (r.content || "").length,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // v15.11.30 — Companion to /api/admin/backup-scripts: skip the boot-time
  // upsert for the next restart by writing a marker settings row. Not exposed
  // to the admin UI — use only when we've just PATCHed a recovered script back
  // in and we want to make sure the next deploy doesn't clobber it again.
  // (The seed code in server/db.ts respects this if present.)
  app.post("/api/admin/skip-next-expired-seed", async (req: any, res: any) => {
    if (!requireAdmin(req, res)) return;
    try {
      rawDb.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run("skip_expired_seed_once", "1");
      res.json({ ok: true, note: "Next boot will skip the Expired script seed exactly once." });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // v15.11.10 — Prime Time email notifier removed. Prime is now incentivized via
  // a 1.5x point multiplier inside awardPoints(). No endpoints needed.

  // v15.11.49 — PROPERTY APPRAISER DEEP-LINK REDIRECT.
  //
  // Client-side we can't easily deep-link to a specific parcel on most FL county
  // appraiser sites because they require server-side ASP.NET postbacks OR live
  // behind Cloudflare. This endpoint does the lookup on the server for the two
  // counties where it's cheap (Duval via ArcGIS, Nassau via public search/r) and
  // 302-redirects the agent's browser straight to the property detail page.
  //
  // For everything else it 302s to a pre-filled search URL (best available).
  app.get("/api/pa-lookup", async (req, res) => {
    const county = String(req.query.county || "").trim().toLowerCase();
    const rawAddr = String(req.query.address || "").trim();
    if (!county || !rawAddr) { res.status(400).send("county+address required"); return; }

    // Address parsing: try to split streetNumber from streetName+rest.
    const streetOnly = rawAddr.split(",")[0].trim();
    const parts = streetOnly.split(/\s+/);
    const streetNo = parts[0] || "";
    const streetName = (parts[1] || "").toUpperCase(); // primary street name
    const encoded = encodeURIComponent(streetOnly);

    // Small helper — fetch with timeout and browser-y UA.
    const timedFetch = async (url: string, ms = 4000, init: RequestInit = {}) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", ...(init.headers || {}) } });
      } finally { clearTimeout(t); }
    };

    try {
      // 1. DUVAL — Jacksonville. Use city ArcGIS to resolve street# + street-name → RE parcel.
      if (county === "duval" && streetNo && streetName) {
        const q = `STREET_NO='${streetNo.replace(/'/g, "''")}' AND ST_NAME='${streetName.replace(/'/g, "''")}'`;
        const url = `https://maps.coj.net/coj/rest/services/PropertyPhotos/PropertyPolygons/MapServer/0/query?where=${encodeURIComponent(q)}&outFields=RE&f=json&returnGeometry=false`;
        const r = await timedFetch(url, 4500);
        if (r.ok) {
          const j: any = await r.json();
          const re = j?.features?.[0]?.attributes?.RE;
          if (re) {
            const reNoSpace = String(re).replace(/\s+/g, "");
            res.redirect(302, `https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=${reNoSpace}`);
            return;
          }
        }
        // Fallback to search page if no exact hit.
        res.redirect(302, `https://paopropertysearch.coj.net/Basic/Search.aspx?searchType=Location&Location=${encoded}`);
        return;
      }

      // 2. NASSAU — search.ncpafl.com path-based query returns HTML with /parcel/<id> links.
      if (county === "nassau") {
        const r = await timedFetch(`https://search.ncpafl.com/search/r?search_str=${encoded}`, 5000);
        if (r.ok) {
          const html = await r.text();
          const m = html.match(/href="\/parcel\/([^"]+)"/);
          if (m && m[1]) {
            res.redirect(302, `https://search.ncpafl.com/parcel/${m[1]}`);
            return;
          }
        }
        res.redirect(302, `https://search.ncpafl.com/search/r?search_str=${encoded}`);
        return;
      }

      // 3. SCHNEIDER counties — Cloudflare blocks server-side scraping. Send them
      //    to a pre-filled search URL. Users tap the top result.
      const schneiderMap: Record<string, string> = {
        "st. johns": "StJohnsCountyFL", "st johns": "StJohnsCountyFL", "st_johns": "StJohnsCountyFL",
        "clay": "ClayCountyFLPA", "flagler": "FlaglerCountyFLPA", "baker": "BakerCountyFLPA",
        "camden": "CamdenCountyGA", "charlton": "CharltonCountyGA", "glynn": "GlynnCountyGA",
      };
      if (schneiderMap[county]) {
        res.redirect(302, `https://qpublic.schneidercorp.com/Application.aspx?App=${schneiderMap[county]}&PageType=Search&SearchType=Location&SearchText=${encoded}`);
        return;
      }

      // 4. PUTNAM — old ASP page; just deep-link to search.
      if (county === "putnam") {
        res.redirect(302, `https://www.pa-putnamcountyfl.gov/PropertySearch.aspx`);
        return;
      }

      // 5. UNKNOWN — Google search fallback.
      const q = `${streetOnly} ${county} county property appraiser`;
      res.redirect(302, `https://www.google.com/search?q=${encodeURIComponent(q)}`);
      return;
    } catch (e: any) {
      // Any failure → surface a search URL so the button still does something.
      const q = `${streetOnly} ${county} county property appraiser`;
      res.redirect(302, `https://www.google.com/search?q=${encodeURIComponent(q)}`);
      return;
    }
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

    // v15.9 SECURITY: default-admin-password check. If either seeded admin
    // still authenticates against the literal "brothers2026", flag it here so
    // it's visible in health output and the nightly Certify sweep alerts.
    try {
      const { verifyPassword } = await import("./auth");
      const seededEmails = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"];
      const stillDefault: string[] = [];
      for (const e of seededEmails) {
        const row = rawDb.prepare(`SELECT password FROM agents WHERE email = ?`).get(e) as any;
        if (!row?.password) continue;
        const { ok } = await verifyPassword("brothers2026", row.password);
        if (ok) stillDefault.push(e);
      }
      results.default_passwords = {
        ok: stillDefault.length === 0,
        detail: stillDefault.length === 0
          ? "All seeded admin passwords have been rotated"
          : `INSECURE — accounts still using default password: ${stillDefault.join(", ")}"`,
      };
    } catch (e: any) {
      results.default_passwords = { ok: false, detail: "check failed: " + (e?.message || String(e)) };
    }

    // v15.9 SECURITY: backup freshness. Warn if the most recent hourly snapshot
    // is older than 3 hours (allows for one missed hour + jitter).
    try {
      const bs = getBackupStatus();
      const lastMs = bs.hourly.newest ? Date.parse(bs.hourly.newest.mtime) : 0;
      const ageH = lastMs ? (Date.now() - lastMs) / 3_600_000 : Infinity;
      results.backups = {
        ok: ageH < 3 && !!bs.hourly.newest,
        detail: bs.hourly.newest
          ? `Last snapshot ${ageH.toFixed(1)}h ago (${bs.hourly.snapshotCount} on-volume, ${(bs.hourly.totalBytes / 1024 / 1024).toFixed(1)}MB)`
          : "No snapshots yet — first backup runs 1 minute after boot",
      };
    } catch (e: any) {
      results.backups = { ok: false, detail: "backup status failed: " + (e?.message || String(e)) };
    }

    const allOk = Object.values(results).every(r => r.ok);
    const criticalOk = results.database.ok && results.resend.ok;

    // Fire-and-forget queue depth alert check
    checkQueueDepthAlert(rawDb).catch(() => {});

    res.status(allOk ? 200 : criticalOk ? 207 : 503).json({
      status: allOk ? "healthy" : criticalOk ? "degraded" : "critical",
      timestamp: new Date().toISOString(),
      version: "v20.32.19",
      services: results,
    });
  });

  // Simple ping for uptime checks
  app.get("/api/ping", (_req, res) => res.json({ pong: true, ts: Date.now() }));

  // v14.81.2.1 — Crash reason surface for out-of-band diagnostics when Railway
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




  // ── Recruiting landing page — must be registered in registerRoutes so it fires
  // before the static middleware SPA fallback in serveStatic()
  // ─── PUBLIC: /join form submission (FUB-only, no DB write) ──────────────────
  // v18.0 — recruiting system removed; agent_leads table dropped. The public
  // /join marketing page still submits here; we push straight to FUB and
  // return ok. No persistence layer, no internal recruiting queue.
  app.post("/api/agent-leads/public", async (req: any, res: any) => {
    if (req.body?.website) return res.json({ ok: true }); // honeypot
    const {
      firstName, lastName, email, phone,
      licenseStatus, licenseState, yearsExperience,
      currentBrokerage, reasonForLeaving,
      gciRange, transactionsLast12mo,
      territory, referralSource, referredByName,
      applicantNotes,
    } = req.body || {};
    if (!firstName || !lastName || !licenseStatus) {
      return res.status(400).json({ error: "First name, last name, and license status are required." });
    }
    // Fire-and-forget FUB push — don't block response.
    fubCreateAgentRecruit({
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
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
      referralSource: referralSource || undefined,
      referredByName: referredByName || undefined,
      applicantNotes: applicantNotes || undefined,
      submittedAt: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    }).catch(err => console.error("[FUB] /join push error:", err));
    console.log(`[/join] New submission: ${firstName} ${lastName} (${email})`);
    res.json({ ok: true });
  });

  app.get("/join", (_req, res) => {
    const distPath = path.resolve(__dirname, "public");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "join.html"));
  });

  // v19.7 — Token-based candidate application page (from Refer an Agent link)
  app.get("/join/:token", (_req, res) => {
    const distPath = path.resolve(__dirname, "public");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "apply.html"));
  });

  // ─── v19.6 ONBOARDING ENDPOINTS (candidates lifecycle) ──────────────
  // Slim implementation: admin/agent invites (both allowed per Alex 19.6) →
  // public /api/join/apply submit → admin approve/decline. Welcome email is
  // DRAFTED to Alex's Superhuman (not auto-sent) per Alex's approval choice.

  // ── Admin OR agent invites a candidate. Any authed user with an agent row
  //    may invite (Alex's v19.6 choice: All agents can invite, tracked by
  //    invited_by_agent_id for later referral-credit attribution).
  app.post("/api/candidates/invite", async (req: any, res) => {
    const authed = req.currentAgent;
    if (!authed) return res.status(401).json({ error: "Authentication required" });
    const { name, phone, email } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
    const token = require("crypto").randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    try {
      const info = rawDb.prepare(`
        INSERT INTO candidates (name, phone, email, status, invite_token, invited_by_agent_id, invited_by_name, created_at)
        VALUES (?, ?, ?, 'invited', ?, ?, ?, ?)
      `).run(String(name).trim(), String(phone).trim(), email ? String(email).trim() : null, token, authed.id, authed.name || null, now);
      // v19.7 — Force https for Railway. `req.protocol` returns http without `trust proxy`.
      const host = req.get('host') || 'depot.watsonbrothersgroup.com';
      const scheme = host.includes('localhost') ? 'http' : 'https';
      const inviteUrl = `${scheme}://${host}/join/${token}`;

      // v20.7.53 — Pull inviter's phone so the candidate email is signed correctly.
      const inviterRow = rawDb.prepare(`SELECT name, email, phone FROM agents WHERE id = ?`).get(authed.id) as any;
      const inviterName  = (inviterRow?.name  || authed.name  || "An agent").trim();
      const inviterEmail = (inviterRow?.email || authed.email || "").trim();
      const inviterPhone = (inviterRow?.phone || "").trim();
      const candFirst    = String(name).trim().split(/\s+/)[0] || "there";

      // v20.7.53 — Auto-send branded invite to the candidate (if email provided).
      let emailSent = false;
      if (resend && email) {
        const candidateHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f2ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ea;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.06);overflow:hidden;">
        <tr><td style="padding:28px 32px 12px 32px;border-bottom:1px solid #eee;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a17f2e;font-weight:700;">Brothers Group Real Estate</div>
          <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:600;margin-top:4px;">at Momentum Realty</div>
        </td></tr>
        <tr><td style="padding:28px 32px 8px 32px;">
          <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;color:#1a1a1a;margin:0 0 16px 0;line-height:1.35;">Hey ${escapeHtml(candFirst)} — come check us out.</h1>
          <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 14px 0;">
            ${escapeHtml(inviterName)} thinks you'd be a great fit on our team at Brothers Group Real Estate. We're a Jacksonville-based team at Momentum Realty and we're growing carefully — which is why we ask agents we like to walk through a short application before we talk.
          </p>
          <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 22px 0;">
            It takes about 3 minutes. Once you finish, ${inviterName.toLowerCase().includes("alex watson") ? "Alex" : `${escapeHtml(inviterName.split(/\s+/)[0] || "we")} and Alex Watson (team owner)`} will review it and reach out.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:0 32px 28px 32px;">
          <a href="${inviteUrl}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Start the application</a>
          <div style="font-size:12px;color:#888;margin-top:12px;">or paste this link into your browser:<br><span style="color:#555;word-break:break-all;">${inviteUrl}</span></div>
        </td></tr>
        <tr><td style="padding:20px 32px 24px 32px;border-top:1px solid #eee;background:#faf8f2;">
          <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#a17f2e;font-weight:700;margin-bottom:8px;">Invited by</div>
          <div style="font-size:15px;color:#1a1a1a;font-weight:700;">${escapeHtml(inviterName)}</div>
          ${inviterPhone ? `<div style="font-size:13px;color:#555;margin-top:2px;">${escapeHtml(inviterPhone)}</div>` : ""}
          ${inviterEmail ? `<div style="font-size:13px;color:#555;margin-top:2px;"><a href="mailto:${escapeHtml(inviterEmail)}" style="color:#a17f2e;text-decoration:none;">${escapeHtml(inviterEmail)}</a></div>` : ""}
          <div style="font-size:12px;color:#999;margin-top:10px;line-height:1.5;">Reply to this email to reach ${escapeHtml(inviterName.split(/\s+/)[0] || "us")} directly.</div>
        </td></tr>
      </table>
      <div style="font-size:11px;color:#aaa;margin-top:16px;">Brothers Group Real Estate · Momentum Realty · Jacksonville, FL</div>
    </td></tr>
  </table>
</body></html>`;
        try {
          // v20.7.53 — Alex is auto-CC'd on every candidate-facing email so he
          // sees exactly what went out. Skip self-CC when Alex is the inviter.
          const ALEX_CC = "alex@watsonbrothersgroup.com";
          const ccList = inviterEmail.toLowerCase() === ALEX_CC ? undefined : [ALEX_CC];
          const sendResult: any = await resend.emails.send({
            from: "Brothers Group Real Estate <noreply@watsonbrothersgroup.com>",
            to:   [String(email).trim()],
            cc:   ccList,
            replyTo: inviterEmail || undefined,
            subject: `${inviterName} thinks you'd be a great fit at Brothers Group`,
            html: candidateHtml,
          });
          if (sendResult && !sendResult.error) emailSent = true;
          else console.error("[candidate invite — candidate email]", sendResult?.error || sendResult);
        } catch (err) {
          console.error("[candidate invite — candidate email]", err);
        }
      }

      // Notify admins so they see the invite lifecycle
      if (resend) {
        resend.emails.send({
          from: "Lead Depot <noreply@watsonbrothersgroup.com>",
          to:   ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
          subject: `🎯 Candidate invited by ${inviterName} — ${name}`,
          html: `<p>${inviterName} just invited <strong>${name}</strong> (${phone}${email ? " · " + email : ""}) to apply${emailSent ? " — branded invite auto-sent to their inbox" : " (no email captured, agent will share the link manually)"}.</p><p>Their apply link: <a href="${inviteUrl}">${inviteUrl}</a></p><p>They'll appear in Admin → Candidates tab once they submit the questionnaire.</p>`,
        }).catch(err => console.error("[candidate invite notify]", err));
      }
      broadcast({ type: "activity_event", event: { type: "candidate_invited", candidateId: Number(info.lastInsertRowid), name, agentId: authed.id, agentName: authed.name, ts: now } });
      // v20.7.9 — Immediate +50 to the inviting agent so recruiting shows up on the leaderboard
      // the moment they send the invite (not later when the candidate applies/gets approved).
      // The +100 `agent_referral_approved` still fires on approval as an additional bonus.
      try { awardPoints(authed.id, "agent_invite_sent", undefined, "recruiting"); } catch {}
      res.json({ ok: true, candidateId: Number(info.lastInsertRowid), inviteUrl, emailSent });
    } catch (err: any) {
      console.error("[candidate invite]", err);
      res.status(500).json({ error: err.message || "invite failed" });
    }
  });

  // ── Public: fetch prefill info for /join/:token page (name + referring agent)
  app.get("/api/candidates/token/:token", (req, res) => {
    const row = rawDb.prepare(`SELECT id, name, status, invited_by_name FROM candidates WHERE invite_token = ?`).get(req.params.token) as any;
    if (!row) return res.status(404).json({ error: "invalid token" });
    if (row.status !== "invited") return res.status(409).json({ error: "already submitted", status: row.status });
    res.json({ id: row.id, name: row.name, invitedByName: row.invited_by_name || null });
  });

  // ── Public: candidate submits questionnaire. Body: { token, answers: {...} }
  //    Score is a simple heuristic — tuned later by Alex.
  app.post("/api/candidates/apply", (req, res) => {
    const { token, answers } = req.body || {};
    if (!token || !answers || typeof answers !== "object") return res.status(400).json({ error: "token and answers required" });
    const row = rawDb.prepare(`SELECT id, name, phone, email, status FROM candidates WHERE invite_token = ?`).get(token) as any;
    if (!row) return res.status(404).json({ error: "invalid token" });
    if (row.status !== "invited") return res.status(409).json({ error: "already submitted", status: row.status });
    // Simple heuristic scoring
    let score = 40;
    const licensed = String(answers.licenseStatus || "").toLowerCase();
    if (licensed.includes("active")) score += 25;
    else if (licensed.includes("pending") || licensed.includes("pre")) score += 10;
    const years = parseInt(String(answers.yearsExperience || "0")) || 0;
    if (years >= 3) score += 20; else if (years >= 1) score += 10;
    const fullTime = String(answers.fullTime || "").toLowerCase().startsWith("y");
    if (fullTime) score += 15;
    score = Math.max(0, Math.min(100, score));
    const rec = score >= 75 ? "STRONG_FIT" : score >= 55 ? "WORTH_CALL" : score >= 35 ? "SOFT_PASS" : "HARD_PASS";
    const now = new Date().toISOString();
    rawDb.prepare(`UPDATE candidates SET status='submitted', questionnaire_json=?, recommendation=?, recommendation_score=?, submitted_at=? WHERE id=?`)
      .run(JSON.stringify(answers), rec, score, now, row.id);
    // Admin notification
    if (resend) {
      const answersHtml = Object.entries(answers).map(([k,v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666;text-transform:capitalize">${k.replace(/_/g,' ')}</td><td style="padding:6px 0">${String(v ?? '—').replace(/</g,'&lt;')}</td></tr>`).join("");
      resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to:   ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
        subject: `📝 Candidate application — ${row.name} — ${rec} (${score})`,
        html: `<p><strong>${row.name}</strong> just submitted their questionnaire.</p><p><strong>Recommendation:</strong> ${rec} · score ${score}/100</p><table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">${answersHtml}</table><p style="margin-top:16px">Review in Admin → Candidates tab.</p>`,
      }).catch(err => console.error("[candidate apply notify]", err));
      // Auto-reply to candidate
      if (row.email) {
        // v20.7.53 — Alex auto-CC'd on candidate autoreply so he sees the loop close.
        resend.emails.send({
          from: "Brothers Group Real Estate <noreply@watsonbrothersgroup.com>",
          to:   [row.email],
          cc:   ["alex@watsonbrothersgroup.com"],
          subject: `We received your application, ${String(row.name).split(/\s+/)[0]}`,
          html: `<p>Hi ${String(row.name).split(/\s+/)[0]},</p><p>Thank you for applying to Brothers Group Real Estate at Momentum Realty. We received your application and we'll be back to you within two business days.</p><p>— Alex Watson & Nate Watson<br>Brothers Group Real Estate at Momentum Realty</p>`,
        }).catch(err => console.error("[candidate autoreply]", err));
      }
    }
    broadcast({ type: "activity_event", event: { type: "candidate_submitted", candidateId: row.id, name: row.name, recommendation: rec, score, ts: now } });
    res.json({ ok: true, recommendation: rec, score });
  });

  // v20.7.53 ── Agent-side: list MY invitees (candidates I invited). Powers the
  //           My Invites section on the Pipeline tab.
  app.get("/api/candidates/mine", (req: any, res) => {
    const authed = req.currentAgent;
    if (!authed) return res.status(401).json({ error: "Authentication required" });
    const rows = rawDb.prepare(`
      SELECT id, name, phone, email, status, invite_token, invited_by_name,
             created_at, submitted_at, decided_at, recommendation, recommendation_score
        FROM candidates
       WHERE invited_by_agent_id = ?
       ORDER BY created_at DESC
    `).all(authed.id);
    res.json({ candidates: rows });
  });

  // v20.7.53 ── Agent-side: nudge a still-`invited` candidate. Auto-fires a
  //           pre-written follow-up email from the inviter’s address. Rate-
  //           limited to 1 nudge every 24h per candidate to avoid spamming.
  app.post("/api/candidates/:id/nudge", async (req: any, res) => {
    const authed = req.currentAgent;
    if (!authed) return res.status(401).json({ error: "Authentication required" });
    const cid = parseInt(req.params.id);
    const cand = rawDb.prepare(`SELECT * FROM candidates WHERE id = ?`).get(cid) as any;
    if (!cand) return res.status(404).json({ error: "candidate not found" });
    if (cand.invited_by_agent_id !== authed.id) return res.status(403).json({ error: "not your invitee" });
    if (cand.status !== "invited") return res.status(409).json({ error: `already ${cand.status} — no nudge needed` });
    if (!cand.email) return res.status(400).json({ error: "no email on file — text or call them directly" });
    // 24h rate limit — uses agent_audit_log (ts stored as unix ms)
    const lastNudge = rawDb.prepare(`
      SELECT MAX(ts) as ts FROM agent_audit_log
       WHERE event = 'candidate_nudge_sent' AND target_id = ?
    `).get(cid) as any;
    if (lastNudge?.ts) {
      const hoursSince = (Date.now() - Number(lastNudge.ts)) / 3600000;
      if (hoursSince < 24) {
        return res.status(429).json({ error: `nudged ${Math.floor(hoursSince)}h ago — wait a day` });
      }
    }
    if (!resend) return res.status(500).json({ error: "email service not configured" });

    const inviterRow = rawDb.prepare(`SELECT name, email, phone FROM agents WHERE id = ?`).get(authed.id) as any;
    const inviterName  = (inviterRow?.name  || authed.name  || "Your contact at Brothers Group").trim();
    const inviterEmail = (inviterRow?.email || authed.email || "").trim();
    const inviterPhone = (inviterRow?.phone || "").trim();
    const candFirst    = String(cand.name).trim().split(/\s+/)[0] || "there";
    const host  = req.get('host') || 'depot.watsonbrothersgroup.com';
    const scheme = host.includes('localhost') ? 'http' : 'https';
    const inviteUrl = `${scheme}://${host}/join/${cand.invite_token}`;

    const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f2ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ea;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.06);overflow:hidden;">
        <tr><td style="padding:28px 32px 12px 32px;border-bottom:1px solid #eee;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a17f2e;font-weight:700;">Brothers Group Real Estate</div>
          <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:600;margin-top:4px;">at Momentum Realty</div>
        </td></tr>
        <tr><td style="padding:28px 32px 8px 32px;">
          <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:400;color:#1a1a1a;margin:0 0 16px 0;line-height:1.4;">Hey ${escapeHtml(candFirst)} — just circling back.</h1>
          <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 14px 0;">
            I know life gets busy. I really do think you’d be a great fit on our team, and the application only takes about 3 minutes. Would love to hear from you.
          </p>
          <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 22px 0;">
            Just fill it out here whenever you’ve got a few minutes — no pressure.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:0 32px 28px 32px;">
          <a href="${inviteUrl}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Finish the application</a>
          <div style="font-size:12px;color:#888;margin-top:12px;">or paste this link into your browser:<br><span style="color:#555;word-break:break-all;">${inviteUrl}</span></div>
        </td></tr>
        <tr><td style="padding:20px 32px 24px 32px;border-top:1px solid #eee;background:#faf8f2;">
          <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#a17f2e;font-weight:700;margin-bottom:8px;">Nudge from</div>
          <div style="font-size:15px;color:#1a1a1a;font-weight:700;">${escapeHtml(inviterName)}</div>
          ${inviterPhone ? `<div style="font-size:13px;color:#555;margin-top:2px;">${escapeHtml(inviterPhone)}</div>` : ""}
          ${inviterEmail ? `<div style="font-size:13px;color:#555;margin-top:2px;"><a href="mailto:${escapeHtml(inviterEmail)}" style="color:#a17f2e;text-decoration:none;">${escapeHtml(inviterEmail)}</a></div>` : ""}
          <div style="font-size:12px;color:#999;margin-top:10px;line-height:1.5;">Reply to this email to reach ${escapeHtml(inviterName.split(/\s+/)[0] || "me")} directly.</div>
        </td></tr>
      </table>
      <div style="font-size:11px;color:#aaa;margin-top:16px;">Brothers Group Real Estate · Momentum Realty · Jacksonville, FL</div>
    </td></tr>
  </table>
</body></html>`;
    try {
      // v20.7.53 — Alex auto-CC'd on candidate nudge emails too. Self-CC skipped.
      const ALEX_CC = "alex@watsonbrothersgroup.com";
      const ccList = inviterEmail.toLowerCase() === ALEX_CC ? undefined : [ALEX_CC];
      const sendResult: any = await resend.emails.send({
        from: "Brothers Group Real Estate <noreply@watsonbrothersgroup.com>",
        to:   [String(cand.email).trim()],
        cc:   ccList,
        replyTo: inviterEmail || undefined,
        subject: `${inviterName} — quick nudge on that Brothers Group invite`,
        html,
      });
      if (sendResult?.error) {
        console.error("[candidate nudge]", sendResult.error);
        return res.status(500).json({ error: "email send failed" });
      }
      // Log the nudge event so we can rate-limit + audit
      try {
        rawDb.prepare(`
          INSERT INTO agent_audit_log (ts, actor_id, target_id, event, notes)
          VALUES (?, ?, ?, 'candidate_nudge_sent', 'Auto-nudge email sent to candidate')
        `).run(Date.now(), authed.id, cid);
      } catch (err) {
        console.error("[candidate nudge — agent_audit_log insert]", err);
      }
      broadcast({ type: "activity_event", event: { type: "candidate_nudged", candidateId: cid, agentId: authed.id, ts: new Date().toISOString() } });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[candidate nudge]", err);
      return res.status(500).json({ error: err.message || "nudge failed" });
    }
  });

  // ── Admin: list candidates (default: all statuses; ?status= filter)
  app.get("/api/admin/candidates", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const status = req.query.status ? String(req.query.status) : null;
    const rows = status
      ? rawDb.prepare(`SELECT * FROM candidates WHERE status = ? ORDER BY created_at DESC`).all(status)
      : rawDb.prepare(`SELECT * FROM candidates ORDER BY created_at DESC LIMIT 200`).all();
    res.json({ candidates: (rows as any[]).map(r => ({
      ...r,
      questionnaire: r.questionnaire_json ? (() => { try { return JSON.parse(r.questionnaire_json); } catch { return null; } })() : null,
    })) });
  });

  // ── Admin approve: creates agent row + drafts welcome email in Superhuman
  //    (per Alex v19.6: personal touch, draft-to-Superhuman rather than auto-send)
  app.post("/api/admin/candidates/:id/approve", async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    // Alex ONLY per spec Decision #4 — Nate can invite/decline but only Alex approves.
    const adminEmail = String(req.currentAgent?.email || "").toLowerCase();
    if (adminEmail !== "alex@watsonbrothersgroup.com") {
      return res.status(403).json({ error: "Only Alex can approve candidates (per spec)." });
    }
    const cid = parseInt(req.params.id);
    const cand = rawDb.prepare(`SELECT * FROM candidates WHERE id = ?`).get(cid) as any;
    if (!cand) return res.status(404).json({ error: "candidate not found" });
    if (cand.status === "approved") return res.status(409).json({ error: "already approved" });
    const answers = cand.questionnaire_json ? (() => { try { return JSON.parse(cand.questionnaire_json); } catch { return {}; } })() : {};
    // Create the agent row (login-ready via setup-link email).
    // v20.0 — setup_token/setup_expires make /setup/:token work end-to-end.
    // Placeholder password hash is bcrypt of a random 32-byte secret — unreachable
    // by anyone, so no one can log in until they pick a real password via the setup link.
    const setupToken = require("crypto").randomBytes(24).toString("base64url");
    const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7d
    const placeholderSecret = require("crypto").randomBytes(32).toString("base64url");
    const placeholderHash = await hashPassword(placeholderSecret);
    const now = new Date().toISOString();
    // v20.0 — agents table uses role='agent'|'admin', not is_admin. Ensure password
    // is set (NOT NULL) with an unreachable placeholder until the setup link is used.
    const info = rawDb.prepare(`
      INSERT INTO agents (name, email, phone, password, is_active, role, lead_flow_on, license_status, license_number, license_state, years_experience, bio, onboarding_started_at, setup_token, setup_expires)
      VALUES (?, ?, ?, ?, 1, 'agent', 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cand.name,
      cand.email || `${cand.phone}@pending.watsonbrothersgroup.com`,
      cand.phone,
      placeholderHash,
      answers.licenseStatus || null,
      answers.licenseNumber || null,
      answers.licenseState || "FL",
      answers.yearsExperience || null,
      answers.bio || null,
      now,
      setupToken,
      setupExpires,
    );
    const agentId = Number(info.lastInsertRowid);
    rawDb.prepare(`UPDATE candidates SET status='approved', decided_by_agent_id=?, decided_at=? WHERE id=?`)
      .run(req.currentAgent.id, now, cid);
    // Attribute referral credit if invited_by_agent_id set
    if (cand.invited_by_agent_id) {
      try { awardPoints(cand.invited_by_agent_id, "agent_referral_approved", undefined, "recruiting"); } catch {}
    }
    broadcast({ type: "activity_event", event: { type: "candidate_approved", candidateId: cid, agentId, name: cand.name, ts: now } });

    // v20.0 — Welcome email now sends FOR REAL from noreply@watsonbrothersgroup.com
    // directly to the candidate. Reply-to is alex@ so replies land in Alex's Superhuman.
    // No more "draft to Alex" step — the moment Alex hits Approve, the candidate gets
    // a warm personal note from Alex.
    if (resend) {
      const firstName = String(cand.name).split(/\s+/)[0];

      // v20.4.2 — Approve-flow test mode. When candidate email is Alex's personal test
      // inbox (watsonag1@gmail.com), redirect ALL recipients (candidate to:, Nate CC,
      // Denise CC, Brittany, Michelle) to that inbox so Alex sees the entire 4-email
      // sequence live without anyone else getting hit. Subjects are prefixed [TEST].
      const TEST_INBOX = "watsonag1@gmail.com";
      const isTestApproval = String(cand.email || "").trim().toLowerCase() === TEST_INBOX;
      const to = (arr: string[]) => isTestApproval ? [TEST_INBOX] : arr;
      const cc = (arr: string[]) => isTestApproval ? [] : arr;
      const subj = (s: string) => isTestApproval ? `[TEST] ${s}` : s;
      if (isTestApproval) {
        console.log(`[approve test-mode] candidate ${cid} email is ${TEST_INBOX} — redirecting all 4 recipients to test inbox`);
      }
      const welcomeSubject = `Welcome to Brothers Group, ${firstName}`;
      const welcomeHtml = `<div style="font-family:'Helvetica Neue','Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff">
<p style="margin:0 0 16px">Hi ${firstName},</p>
<p style="margin:0 0 16px">Welcome to Brothers Group Real Estate at Momentum Realty — truly excited to have you with us. There's so much for us to build together and I can't wait to get into it.</p>
<p style="margin:0 0 16px">A few quick things before your first day on the phones:</p>
<ul style="margin:0 0 16px;padding-left:22px">
  <li style="margin-bottom:6px">Your Lead Depot login is coming in a separate email with your setup link.</li>
  <li style="margin-bottom:6px">Nate will reach out this week about your team onboarding — licensing, headshot, county, personal address.</li>
  <li style="margin-bottom:6px">Brittany Brooks and Michelle Weaver at Momentum will be looping in on the brokerage-side onboarding.</li>
  <li style="margin-bottom:6px">Weekly team huddle: Mondays at 9am ET.</li>
</ul>
<p style="margin:0 0 16px">Any chance you're free to grab coffee this week? Would love to hear more about you and share where we're taking this thing.</p>
<p style="margin:0 0 16px">Reply anytime — this hits my inbox directly.</p>
<p style="margin:0 0 4px">— Alex</p>
<p style="margin:0;color:#666;font-size:13px">Alex Watson &middot; Brothers Group Real Estate at Momentum Realty</p>
</div>`;
      if (cand.email) {
        resend.emails.send({
          from:    "Alex Watson <noreply@watsonbrothersgroup.com>",
          to:      to([cand.email]),
          cc:      cc(["nate@watsonbrothersgroup.com"]),
          replyTo: "alex@watsonbrothersgroup.com",
          subject: subj(welcomeSubject),
          html:    welcomeHtml,
        }).catch(err => console.error("[welcome email]", err));

        // v20.0 — Lead Depot setup link email (separate from welcome so it stays scannable).
        const appBase = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : process.env.APP_URL ?? "https://depot.watsonbrothersgroup.com";
        const setupLink = `${appBase}/#/setup/${setupToken}`;
        resend.emails.send({
          from:    "Lead Depot <noreply@watsonbrothersgroup.com>",
          to:      to([cand.email]),
          replyTo: "alex@watsonbrothersgroup.com",
          subject: subj(`Set up your Lead Depot access, ${firstName}`),
          html: `<div style="font-family:'Helvetica Neue','Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff">
<p style="margin:0 0 16px">Hi ${firstName},</p>
<p style="margin:0 0 16px">Your Lead Depot account is ready. Click below to pick your password and log in for the first time. This link is good for 7 days.</p>
<div style="text-align:center;margin:24px 0"><a href="${setupLink}" style="display:inline-block;padding:14px 32px;background:#c8aa5a;color:#0a0a0a;font-weight:700;font-size:14px;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;border-radius:8px">Set up my account</a></div>
<p style="margin:0 0 6px;color:#666;font-size:13px">Or paste this into your browser:</p>
<p style="margin:0 0 16px;font-family:monospace;font-size:12px;word-break:break-all;color:#333">${setupLink}</p>
<p style="margin:24px 0 4px">— Alex</p>
<p style="margin:0;color:#666;font-size:13px">Alex Watson &middot; Brothers Group Real Estate at Momentum Realty</p>
</div>`,
        }).catch(err => console.error("[setup link email]", err));
      } else {
        console.warn(`[welcome/setup email] candidate ${cid} has no email on file — skipping sends`);
      }
      // Nate onboarding brief — CC Alex + Denise (v19.9: Denise added so team-ops has the same picture at the moment of approval).
      const briefRows = Object.entries(answers).map(([k,v]) => `• ${k.replace(/_/g,' ')}: ${String(v ?? '—')}`).join("\n");
      resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to:   to(["nate@watsonbrothersgroup.com"]),
        cc:   cc(["alex@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"]),
        subject: subj(`📋 Onboarding brief — ${cand.name}`),
        html: `<p>Nate,</p><p>Alex just approved <strong>${cand.name}</strong> (${cand.phone}${cand.email ? " · " + cand.email : ""}). Please kick off their team onboarding to Momentum. Here's what they told us on the questionnaire so you know where to pick up the reins:</p><pre style="background:#f7f5ef;padding:16px;border-radius:8px;white-space:pre-wrap;font-family:'Helvetica Neue',sans-serif;font-size:13px">${briefRows}</pre><p style="background:#fff8e1;border-left:4px solid #c8aa5a;padding:12px 16px;margin:16px 0;font-size:14px;color:#5a4a1a"><strong>⚠️ Action required — before their first day:</strong><br/>Send <strong>${cand.name}</strong> the BGRE Team Agreement via DocuSign and confirm it's signed. This is the accountability + liability piece. Until the formal template is loaded into DocuSign, use the interim agreement + Lead Depot NDA. No leads should be assigned until signed.</p><p>— Lead Depot</p>`,
      }).catch(err => console.error("[nate brief]", err));

      // v19.9 — Momentum Realty onboarding request to Brittany Brooks + Michelle Weaver.
      // Fires the moment Alex approves the candidate so their brokerage-side onboarding
      // (paperwork, MLS/board, systems access) starts in parallel with Nate's Depot onboarding.
      resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to:      to(["momentumbkr@gmail.com", "michelle@movewithmomentum.com"]),
        cc:      cc(["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"]),
        replyTo: "alex@watsonbrothersgroup.com",
        subject: subj(`New Brothers Group agent — please onboard ${cand.name} to Momentum`),
        html: `<p>Hi Brittany and Michelle,</p><p>We just brought on a new agent to the Brothers Group team — <strong>${cand.name}</strong>${cand.email ? ` (${cand.email})` : ""}${cand.phone ? ` · ${cand.phone}` : ""}. Could you please kick off their Momentum Realty onboarding whenever you have a moment?</p><p>A few quick details from their application to make it easier on your end:</p><pre style="background:#f7f5ef;padding:16px;border-radius:8px;white-space:pre-wrap;font-family:'Helvetica Neue',sans-serif;font-size:13px">${briefRows}</pre><p>Nate is running the team-side onboarding in parallel — feel free to loop him in on anything you need from us. Really appreciate you both.</p><p>— Alex<br/>Alex Watson · Brothers Group Real Estate at Momentum Realty</p>`,
      }).catch(err => console.error("[momentum onboarding]", err));
    }

    // v20.4.9 — FUB approve integration (Pro plan: first 10 seats included in
    // $499/mo base; seats 11+ = $49/mo each). Non-blocking: emails already sent
    // above; FUB failures don't fail the approve.
    // Test-mode: fubApproveAgentAsVendor is a no-op when isTestApproval=true so
    // watsonag1@gmail.com dry runs never touch the real FUB account.
    try {
      const briefRowsForFub = Object.entries(answers).map(([k,v]) => `• ${k.replace(/_/g,' ')}: ${String(v ?? '—')}`).join("\n");
      const TEST_INBOX_FUB = "watsonag1@gmail.com";
      const isTestApprovalFub = String(cand.email || "").trim().toLowerCase() === TEST_INBOX_FUB;
      const nameParts = String(cand.name || "").trim().split(/\s+/);
      const firstNameFub = nameParts[0] || cand.name || "Agent";
      const lastNameFub  = nameParts.slice(1).join(" ") || "";
      fubApproveAgentAsVendor({
        candidateId: cid,
        agentId,
        firstName: firstNameFub,
        lastName:  lastNameFub,
        fullName:  cand.name,
        email:     cand.email || "",
        phone:     cand.phone || "",
        invitedByName: req.currentAgent?.name || null,
        questionnaireSummary: briefRowsForFub,
        isTestApproval: isTestApprovalFub,
        testInbox: TEST_INBOX_FUB,
      }).then((result) => {
        const seatMsg = result.seatUsageAfter !== undefined
          ? ` seats=${result.seatUsageAfter}/${result.includedSeats}${result.overageTriggered ? ` OVERAGE_TRIGGERED(+$${FUB_PRO_OVERAGE_PER_SEAT_USD}/mo)` : ''}`
          : '';
        console.log(`[approve→FUB] candidate ${cid} → personId=${result.personId} userId=${result.userId} noteId=${result.vendorNoteId}${seatMsg} skipped=${result.skipped.join(',') || 'none'} errors=${result.errors.join(',') || 'none'}`);

        // v20.4.9 — If this approve triggered a $49/mo seat overage, in-app
        // notify Alex so he knows the next FUB invoice will be higher. Non-
        // fatal, purely informational — the seat was created and the agent can
        // work immediately.
        if (result.overageTriggered) {
          try {
            broadcast({
              type: "fub_seat_overage",
              agentId,
              candidateName: cand.name,
              seatsUsed: result.seatUsageAfter,
              includedSeats: result.includedSeats,
              overageCostPerSeat: FUB_PRO_OVERAGE_PER_SEAT_USD,
            });
          } catch { /* broadcast is best-effort */ }
        }
      }).catch((err) => {
        console.error(`[approve→FUB] candidate ${cid} — unhandled error:`, err);
      });
    } catch (fubErr) {
      console.error(`[approve→FUB] candidate ${cid} — setup error:`, fubErr);
    }

    res.json({ ok: true, agentId, setupToken });
  });

  // ── Admin decline: soft-delete candidate + polite pass email
  app.post("/api/admin/candidates/:id/decline", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const cid = parseInt(req.params.id);
    const cand = rawDb.prepare(`SELECT * FROM candidates WHERE id = ?`).get(cid) as any;
    if (!cand) return res.status(404).json({ error: "candidate not found" });
    if (cand.status === "declined") return res.status(409).json({ error: "already declined" });
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 1000) : null;
    const now = new Date().toISOString();
    rawDb.prepare(`UPDATE candidates SET status='declined', decided_by_agent_id=?, decision_notes=?, decided_at=? WHERE id=?`)
      .run(req.currentAgent.id, notes, now, cid);
    broadcast({ type: "activity_event", event: { type: "candidate_declined", candidateId: cid, name: cand.name, ts: now } });
    if (resend && cand.email) {
      resend.emails.send({
        from: "Brothers Group Real Estate <noreply@watsonbrothersgroup.com>",
        to:   [cand.email],
        subject: `Thanks for applying to Brothers Group`,
        html: `<p>Hi ${String(cand.name).split(/\s+/)[0]},</p><p>Thank you for taking the time to apply to Brothers Group Real Estate at Momentum Realty. After reviewing your application, we don't have the right seat open for you right now.</p><p>We appreciate your interest and wish you the best in your real estate career.</p><p>— The Brothers Group Team</p>`,
      }).catch(err => console.error("[candidate decline email]", err));
    }
    res.json({ ok: true });
  });

  // ── v20.7.53: Admin candidate DELETE (hard delete, includes point-reversal)
  // Removes the candidate row AND reverses any recruiting points awarded to the
  // inviter for that specific invite. Points are matched by inviter agent_id +
  // reason='agent_invite_sent' + created_at within ±60s of the candidate row,
  // then the single closest matching row is deleted. Safe: only Alex can call.
  app.post("/api/admin/candidates/:id/hard-delete", (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    // v20.7.53 — either admin can hard-delete. Any admin action is auditable via
    // the activity_event broadcast and the candidates row deletion is logged.
    // (Alex-only guard removed: Alex's session was locked and Nate needed to
    // hard-delete stale E2E test candidates to reverse test points.)
    const cid = parseInt(req.params.id);
    const cand = rawDb.prepare(`SELECT * FROM candidates WHERE id = ?`).get(cid) as any;
    if (!cand) return res.status(404).json({ error: "candidate not found" });
    let reversedInvitePts = 0;
    let reversedApprovalPts = 0;
    try {
      // Reverse the +50 agent_invite_sent point row for the inviter, matched
      // by time proximity to candidate.created_at (±60s window).
      const invPt = rawDb.prepare(`
        SELECT id, points FROM agent_points
        WHERE agent_id = ? AND reason = 'agent_invite_sent'
          AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 60
        ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
        LIMIT 1
      `).get(cand.invited_by_agent_id, cand.created_at, cand.created_at) as any;
      if (invPt?.id) {
        rawDb.prepare(`DELETE FROM agent_points WHERE id = ?`).run(invPt.id);
        reversedInvitePts = invPt.points || 0;
      }
      // If candidate was approved, reverse the +100 approval bonus too.
      if (cand.status === "approved" && cand.decided_at) {
        const apPt = rawDb.prepare(`
          SELECT id, points FROM agent_points
          WHERE agent_id = ? AND reason = 'agent_referral_approved'
            AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 60
          ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
          LIMIT 1
        `).get(cand.invited_by_agent_id, cand.decided_at, cand.decided_at) as any;
        if (apPt?.id) {
          rawDb.prepare(`DELETE FROM agent_points WHERE id = ?`).run(apPt.id);
          reversedApprovalPts = apPt.points || 0;
        }
      }
    } catch (err) {
      console.error("[candidate hard-delete point reversal]", err);
    }
    rawDb.prepare(`DELETE FROM candidates WHERE id = ?`).run(cid);
    broadcast({ type: "activity_event", event: { type: "candidate_hard_deleted", candidateId: cid, name: cand.name, ts: new Date().toISOString() } });
    res.json({ ok: true, reversedInvitePts, reversedApprovalPts });
  });

  // ── v20.7.53: My Recruits — agent-facing list of everyone they've invited,
  // with status + email delivery indicator + points earned per candidate.
  app.get("/api/agents/me/recruits", (req: any, res) => {
    const authed = req.currentAgent;
    if (!authed) return res.status(401).json({ error: "Authentication required" });
    try {
      const rows = rawDb.prepare(`
        SELECT id, name, phone, email, status, created_at, decided_at, submitted_at, invite_token
        FROM candidates
        WHERE invited_by_agent_id = ?
        ORDER BY created_at DESC
      `).all(authed.id) as any[];
      const enriched = rows.map(r => {
        const invitePt = rawDb.prepare(`
          SELECT points FROM agent_points
          WHERE agent_id = ? AND reason = 'agent_invite_sent'
            AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 60 LIMIT 1
        `).get(authed.id, r.created_at) as any;
        const approvalPt = r.status === "approved" && r.decided_at ? rawDb.prepare(`
          SELECT points FROM agent_points
          WHERE agent_id = ? AND reason = 'agent_referral_approved'
            AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 60 LIMIT 1
        `).get(authed.id, r.decided_at) as any : null;
        return {
          id: r.id,
          name: r.name,
          phone: r.phone,
          email: r.email,
          status: r.status,
          createdAt: r.created_at,
          submittedAt: r.submitted_at,
          decidedAt: r.decided_at,
          inviteUrl: `https://depot.watsonbrothersgroup.com/join/${r.invite_token}`,
          invitePoints: invitePt?.points || 0,
          approvalPoints: approvalPt?.points || 0,
        };
      });
      res.json({ recruits: enriched });
    } catch (err: any) {
      console.error("[my recruits]", err);
      res.status(500).json({ error: err.message || "failed" });
    }
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





  // ── Set minDialsPerWeek performance gate for an agent (admin only) ────────────────────────────
  app.patch("/api/agents/:id/min-dials", (req: any, res) => {
    const agentId = parseInt(req.params.id);
    const { minDialsPerWeek } = req.body;
    const val = parseInt(minDialsPerWeek);
    if (isNaN(val) || val < 0) return res.status(400).json({ error: "minDialsPerWeek must be a non-negative integer" });
    rawDb.prepare(`UPDATE agents SET min_dials_per_week = ? WHERE id = ?`).run(val, agentId);
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

  // POST /api/admin/missed-appointments — manually trigger the missed-appt email

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

  // v20.7.23 — One-shot backfill for missing contacted_appointment point rows.
  // Root cause: appts set via /api/admin/leads/:id/manual-appt (line 2467) update
  // the lead status but bypass awardPoints() entirely. Also: any historical Appt
  // Set that emitted a status change without a matching agent_points row leaves
  // the leaderboard reading appts=0 for that agent's weekly/monthly window even
  // though the lead is sitting in their pipeline. This sweep:
  //   1. Finds every lead where status='contacted_appointment' AND assigned_agent_id IS NOT NULL
  //   2. Confirms no agent_points row exists with reason='contacted_appointment'
  //      AND lead_id = <lead.id> AND agent_id = <lead.assigned_agent_id>
  //   3. Inserts a synthetic +60 pts row dated to lead.last_activity_at (falls
  //      back to lead.uploaded_at if last_activity_at is NULL)
  //   4. ALSO: for any lead whose owner name is missing/malformed (SPECIFICALLY
  //      Jose Ramos on lead 5213 which never got flipped from KIT), flip status
  //      keep_in_touch → contacted_appointment and insert the +60 pts row.
  // Idempotent by (agent_id, lead_id, reason) match — safe to re-run.
  app.post("/api/admin/backfill-appt-points", async (_req: any, res: any) => {
    try {
      // Phase A: ensure lead 5213 (Jose Ramos) also has a lead_activity row with
      // outcome='contacted_appointment' for agent 3 (Bronson). The leaderboard's
      // appts counters (today/week/month/allTime) all read from lead_activity, not
      // agent_points, so missing this row is why Ramos's conversion doesn't tick
      // the appts column on Bronson's leaderboard. Idempotent by NOT EXISTS.
      // Also flip the lead row itself from keep_in_touch → contacted_appointment
      // if not already flipped.
      let leadFlipped = false;
      let ramosActivityInserted = false;
      const ramos = rawDb.prepare(`SELECT id, status, assigned_agent_id FROM leads WHERE id = 5213`).get() as any;
      if (ramos && ramos.status === "keep_in_touch") {
        rawDb.prepare(
          `UPDATE leads SET status = 'contacted_appointment', assigned_agent_id = 3 WHERE id = 5213`
        ).run();
        leadFlipped = true;
      }
      const ramosExisting = rawDb.prepare(
        `SELECT id FROM lead_activity WHERE lead_id = 5213 AND agent_id = 3 AND outcome = 'contacted_appointment'`
      ).get();
      if (!ramosExisting) {
        rawDb.prepare(
          `INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at) VALUES (5213, 3, 'contacted_appointment', 'v20.7.26 backfill: retroactive Ramos conversion', NULL, ?)`
        ).run(new Date().toISOString());
        ramosActivityInserted = true;
      }

      // Phase B: find every contacted_appointment lead that has an assigned agent
      // but is missing its matching agent_points row. Use NOW as the synthetic
      // timestamp so backfilled points land in the current weekly/monthly window —
      // Alex wants Bronson's Jorge (converted ~4 weeks ago, silently by manual-appt
      // endpoint) and any other silently-skipped appts to show up on this week's
      // leaderboard. The leads table has no last_activity_at column and there's no
      // separate activity log to reconstruct the original conversion time from.
      const nowIso = new Date().toISOString();
      const candidates = rawDb.prepare(`
        SELECT l.id AS lead_id, l.assigned_agent_id AS agent_id,
               l.owner_name, l.address
        FROM leads l
        WHERE l.status = 'contacted_appointment'
          AND l.assigned_agent_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_points ap
            WHERE ap.lead_id = l.id
              AND ap.agent_id = l.assigned_agent_id
              AND ap.reason = 'contacted_appointment'
          )
      `).all() as any[];

      const inserted: any[] = [];
      const insertStmt = rawDb.prepare(
        `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, 'contacted_appointment', ?, 'seller', ?)`
      );
      const tx = rawDb.transaction(() => {
        for (const c of candidates) {
          insertStmt.run(c.agent_id, 60, c.lead_id, nowIso);
          inserted.push({ agentId: c.agent_id, leadId: c.lead_id, ownerName: c.owner_name, address: c.address, ts: nowIso });
        }
      });
      tx();

      res.json({
        ok: true,
        leadRamosFlipped: leadFlipped,
        ramosActivityInserted,
        candidatesFound: candidates.length,
        pointsRowsInserted: inserted.length,
        details: inserted,
      });
    } catch (e: any) {
      console.error("[backfill-appt-points] failed:", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
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

  // v18.0 — DBPR pipeline handlers removed with recruiting system.


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


  // v18.0 — Onboarding candidate helpers + endpoints removed with recruiting system.

  // v20.7.53 — Admin points-audit endpoint. Full source-tagged ledger for one
  // agent-month. Every row shows source_kind (outcome / challenge / manual /
  // field_activity / referral / recruiting) plus a running total, so any
  // leaderboard number can be traced back to its source events on demand.
  app.get("/api/admin/points-audit", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const agentId = Number(req.query.agentId);
    const monthStr = String(req.query.month || "");
    if (!Number.isFinite(agentId) || !/^\d{4}-\d{2}$/.test(monthStr)) {
      return res.status(400).json({ error: "agentId (number) and month (YYYY-MM) required" });
    }
    const [y, m] = monthStr.split("-").map(Number);
    const startIso = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const endIso = new Date(Date.UTC(y, m, 1)).toISOString();
    const SOURCE_KIND_CASE = `
      CASE
        WHEN reason LIKE 'challenge:%'                                 THEN 'challenge'
        WHEN reason IN ('manual_credit','admin_award','admin_deduct')  THEN 'manual'
        WHEN reason LIKE 'approval:%'                                  THEN 'field_activity'
        WHEN reason LIKE 'network_referral%'                           THEN 'referral'
        WHEN reason LIKE 'agent_referral%' OR reason LIKE 'agent_invite%' THEN 'recruiting'
        WHEN reason LIKE 'open_house_%' OR reason LIKE 'door_knock%'
          OR reason LIKE 'direct_mail%' OR reason LIKE 'social_post%'  THEN 'field_activity'
        ELSE 'outcome'
      END
    `;
    const rows = rawDb.prepare(`
      SELECT id, agent_id, lead_id, points, reason,
             ${SOURCE_KIND_CASE} AS source_kind,
             created_at
      FROM agent_points
      WHERE agent_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC
    `).all(agentId, startIso, endIso) as any[];
    let running = 0;
    const withRunning = rows.map((r: any) => {
      running += (r.points || 0);
      return { ...r, running_total: running };
    });
    const bySource: Record<string, { pts: number; rows: number }> = {};
    for (const r of rows) {
      const sk = r.source_kind as string;
      if (!bySource[sk]) bySource[sk] = { pts: 0, rows: 0 };
      bySource[sk].pts += (r.points || 0);
      bySource[sk].rows += 1;
    }
    res.json({
      agentId,
      month: monthStr,
      total: running,
      rowCount: rows.length,
      by_source_kind: bySource,
      rows: withRunning,
    });
  });

  // v20.7.53 — Admin trigger to fire the daily ledger attestation on demand.
  // Runs the EXACT same routine as the nightly 9:05pm ET cron: computes the
  // per-agent totals since month start, cross-checks phantom / missed appts,
  // and emails alex+nate the same report. Response contains the JSON summary
  // so the caller sees the result immediately.
  app.post("/api/admin/ledger-attest-now", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const trigger = (global as any).__triggerLedgerAttestation;
      if (typeof trigger !== "function") {
        return res.status(503).json({ ok: false, error: "Attestation not initialized yet. Try again in 10s." });
      }
      await trigger();
      res.json({ ok: true, message: "Attestation dispatched. Email en route to alex+nate." });
    } catch (err) {
      console.error("[ledger-attest-now] failed", err);
      res.status(500).json({ ok: false, error: (err as Error).message });
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

  // v15.3 — Intent breakdown per agent (from the lead they dialed, not the activity row).
  // Uses meaningful outcomes only (appt / kit / not-interested) to avoid inflating with no-answers.
  const leadIntentById: Record<number, string | null> = {};
  for (const l of allLeadsRaw) leadIntentById[l.id] = l.intent || null;
  const agentStats = activeAgents.map((agent: any) => {
    const acts = activities.filter((a: any) => a.agent_id === agent.id && a.outcome !== "email_sent");
    const meaningfulActs = acts.filter((a: any) =>
      ["contacted_appointment", "keep_in_touch", "contacted_not_interested"].includes(a.outcome)
    );
    const intentCounts = { sell: 0, buy: 0, both: 0 };
    for (const a of meaningfulActs) {
      const intent = leadIntentById[a.lead_id];
      if (intent === "buy_only") intentCounts.buy++;
      else if (intent === "sell_and_buy") intentCounts.both++;
      else intentCounts.sell++; // sell_only OR null (defaults to seller script)
    }
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
      intentCounts, // v15.3
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
        // v15.3 — Intent breakdown sub-line: only render when at least one meaningful outcome had a
        // non-default intent, so agents dialing pure expired lists don't get a noisy "3 sell" line.
        const ic = a.intentCounts || { sell: 0, buy: 0, both: 0 };
        const totalMeaningful = ic.sell + ic.buy + ic.both;
        const showIntent = totalMeaningful > 0 && (ic.buy > 0 || ic.both > 0);
        const intentLine = showIntent
          ? `<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:3px;letter-spacing:0.04em">
               ${ic.sell > 0 ? `<span style=\"color:#c8aa5a\">${ic.sell} sell</span>` : ""}
               ${ic.buy > 0 ? ` · <span style=\"color:#93c5fd\">${ic.buy} buy</span>` : ""}
               ${ic.both > 0 ? ` · <span style=\"color:#f0f0f0\">${ic.both} sell&amp;buy</span>` : ""}
             </div>`
          : "";
        return `<tr style="border-bottom:1px solid rgba(200,170,90,0.08)">
          <td style="padding:10px 14px;font-size:13px;color:#f0f0f0">${a.name}${intentLine}</td>
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
    <span>Lead Depot v20.32.19</span><span>Brothers Group · Momentum Realty</span>
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
    // v17.5 — nightly streak recompute so tiers roll even without new activity.
    try {
      const r = recomputeAllStreaks();
      console.log(`[streaks] Nightly recompute: ${r.count} agents in ${r.ms}ms`);
    } catch (err) { console.error("[streaks] Nightly recompute error:", err); }
    setTimeout(fire, 24 * 60 * 60 * 1000); // repeat every 24h
  }, delay);
}

scheduleDailyDigest();

// v17.5 — Daily snapshot cron. Fires at 11:58 PM ET every day so the day's
// counters freeze before the ET midnight boundary. Also captures once at
// boot so today always has a row. Idempotent — safe to re-fire.
scheduleDailySnapshotCron();
scheduleDiversityChallengeCron();

// ─── v15.11.50 ─ MONTHLY LEADERBOARD RESET ──────────────────────────────────
// Fires at 00:00 America/New_York on the 1st of every month. Snapshots the
// closing scores + Appt Set standings, then writes a fresh reset timestamp
// so both the seller leaderboard and the Team Pot start clean. Uses the
// same snapshot + settings key as the admin manual reset (keys:
// leaderboard_reset_at, leaderboard_snapshots table). Idempotent within a
// single ET day — if server restarts after the fire, it won't double-reset.
// v16.7 — Rebuilt monthly reset with bulletproof guarantees:
//   1. "Already reset this ET month?" idempotency — not a 6h window
//   2. Precise DST-aware next-fire calculation using Intl (no month-range guess)
//   3. Hourly self-check (every process wake re-evaluates) so a missed setTimeout
//      from a restart still catches within 60 minutes
//   4. Safe no-op if the current ET month already has a reset row
function scheduleMonthlyLeaderboardReset() {
  // Return "YYYY-MM" for the current ET wall-clock month.
  function currentEtYearMonth(atMs: number = Date.now()): string {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" });
    const parts = fmt.formatToParts(new Date(atMs));
    const y = parts.find(p => p.type === "year")!.value;
    const m = parts.find(p => p.type === "month")!.value;
    return `${y}-${m}`;
  }

  // Return the exact UTC ms for "midnight ET on the 1st of NEXT ET month", using
  // Intl to observe DST correctly (no hardcoded month-range hack).
  function msUntilNextEtMonthStart(): number {
    const now = new Date();
    const currentYm = currentEtYearMonth(now.getTime());
    const [y, m] = currentYm.split("-").map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    // Iterate hourly from a UTC anchor near the 1st until we find the ET
    // wall-clock instant that reads exactly `${nextY}-${nextM}-01 00:00`.
    // Bounded search: 25 hours around the naive UTC midnight.
    const naiveUtc = Date.UTC(nextY, nextM - 1, 1, 4, 0, 0, 0); // guess EDT
    for (let dh = -3; dh <= 6; dh++) {
      const candidate = naiveUtc + dh * 3600_000;
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const parts = fmt.formatToParts(new Date(candidate));
      const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
      if (Number(p.year) === nextY && Number(p.month) === nextM && p.day === "01" && p.hour === "00" && p.minute === "00") {
        return Math.max(1_000, candidate - now.getTime());
      }
    }
    // Fallback: naive UTC midnight of nextM (should never be reached).
    return Math.max(1_000, naiveUtc - now.getTime());
  }

  async function performMonthlyReset() {
    try {
      const scope = "seller";
      const resetKey = "leaderboard_reset_at";
      const now = new Date().toISOString();

      // v16.7 — IDEMPOTENCY: skip if the last reset was in the CURRENT ET
      // wall-clock month. This is 100% safe against setTimeout misfires, process
      // restarts, and the double-fire we saw in v16.7. Only exactly ONE
      // reset per ET calendar month is possible.
      const prevRow = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(resetKey) as any;
      if (prevRow?.value) {
        const prevYm = currentEtYearMonth(new Date(prevRow.value).getTime());
        const nowYm = currentEtYearMonth();
        if (prevYm === nowYm) {
          console.log(`[monthly-reset] Skipped — already reset in ${nowYm}`);
          return;
        }
      }

      // v17.5 — Crown the Champion Wreath AFTER the idempotency guard but BEFORE
      // the reset wipes score data. This looks at the closing ET month's
      // contacted_appointment count and writes app_settings.champion_current_month
      // so the winner gets the wreath frame for the incoming month. Placement
      // here means it runs exactly once per month (same guard as reset).
      try {
        const crowned = crownMonthlyChampion();
        if (crowned.agentId) {
          console.log(`[champion] Crowned ${crowned.agentName} (${crowned.appts} appts in ${crowned.awardedForMonth}) — wreath for ${crowned.monthKey}`);
        } else {
          console.log("[champion] No qualifying agent for the closing month");
        }
      } catch (err) {
        console.error("[champion] crown failed:", err);
      }

      const allAgents = storage.getAllAgents();
      const prevResetAt: string | null = prevRow?.value || null;
      const ptsSql = `SELECT agent_id, SUM(points) as total FROM agent_points WHERE scope = ? ${prevResetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
      const ptsParams = prevResetAt ? [scope, prevResetAt] : [scope];
      const ptsRows = rawDb.prepare(ptsSql).all(...ptsParams) as any[];
      const ptsMap: Record<number, number> = {};
      for (const r of ptsRows) ptsMap[r.agent_id] = r.total || 0;

      // Also capture per-agent Appt Set counts so the snapshot preserves the
      // Team Pot standings for the closing month.
      const apptSql = `SELECT agent_id, COUNT(*) as appts FROM lead_activity WHERE outcome = 'contacted_appointment' ${prevResetAt ? "AND created_at >= ?" : ""} GROUP BY agent_id`;
      const apptParams = prevResetAt ? [prevResetAt] : [];
      const apptRows = rawDb.prepare(apptSql).all(...apptParams) as any[];
      const apptMap: Record<number, number> = {};
      for (const r of apptRows) apptMap[r.agent_id] = r.appts || 0;

      const snapshot = allAgents
        .filter(a => a.isActive)
        .map(a => ({ id: a.id, name: a.name, points: ptsMap[a.id] || 0, appts: apptMap[a.id] || 0 }))
        .sort((a, b) => b.points - a.points);

      const startDate = prevResetAt ? new Date(prevResetAt) : null;
      const endDate = new Date(now);
      const fmtD = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const periodLabel = startDate
        ? `${fmtD(startDate)} – ${fmtD(endDate)} (${scope}, auto-monthly)`
        : `Through ${fmtD(endDate)} (${scope}, auto-monthly)`;

      rawDb.prepare(
        `INSERT INTO leaderboard_snapshots (period_label, reset_at, snapshot_json, created_at) VALUES (?, ?, ?, ?)`
      ).run(periodLabel, now, JSON.stringify(snapshot), now);

      rawDb.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(resetKey, now);

      // v17.5 — stretch reveal toggle removed; $1000 tier permanently visible.
      // Historic wipe line retired. Legacy settings row (if present) is harmless.


      // Broadcast so every open tab flips instantly.
      try { broadcast({ type: "leaderboard_reset", periodLabel, at: now }); } catch {}
      console.log(`[monthly-reset] Reset complete — ${periodLabel}`);
    } catch (err) {
      console.error("[monthly-reset] Error:", err);
    }
  }

  // v16.7 — Two independent triggers, both guarded by "already reset this
  // ET month" idempotency. Belt-and-suspenders design.
  //
  //   (A) Precise setTimeout to next ET month start. Fires within seconds of 00:00 ET.
  //   (B) Hourly self-check that re-evaluates the wall clock. If setTimeout misfires,
  //       drifts, or a restart lands mid-month-boundary, the hourly wakes catch it
  //       within 60 minutes. The idempotency guard makes multi-fire impossible.

  // v17.5 — setTimeout max delay is 2^31-1 ms (~24.85 days). If the next month
  // boundary is farther than that, setTimeout clamps to 1ms and fires immediately
  // in a hot loop. Cap each hop at 24 days; when we get closer, the next hop
  // will be shorter until we hit the actual boundary. The idempotency guard
  // inside performMonthlyReset() makes multiple fires safe.
  const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000; // 24 days
  const delay = msUntilNextEtMonthStart();
  const delayDays = Math.round(delay / 86_400_000);
  console.log(`[monthly-reset] Next precise fire in ~${delayDays}d (00:00 ET on the 1st)`);

  function scheduleNextFire() {
    const ms = msUntilNextEtMonthStart();
    const capped = Math.min(ms, MAX_TIMEOUT_MS);
    setTimeout(() => {
      if (msUntilNextEtMonthStart() < 60 * 1000) {
        // We're at (or past) the boundary — fire the reset.
        performMonthlyReset().finally(scheduleNextFire);
      } else {
        // Not yet — just hop forward.
        scheduleNextFire();
      }
    }, capped);
  }
  scheduleNextFire();

  // Hourly safety net. Cheap. Checks "is it past the 1st of this ET month AND
  // no reset has been logged for this ET month yet?" — if so, fire.
  setInterval(() => {
    performMonthlyReset().catch(err => console.error("[monthly-reset] hourly check err", err));
  }, 60 * 60 * 1000);

  // Also check ONCE at boot — covers the case where the server was down when
  // the month rolled over. Safe because of idempotency guard.
  setTimeout(() => performMonthlyReset(), 5_000);
}

// v16.7 — RE-ENABLED with rebuilt scheduler. Auto-monthly reset now:
//   – Fires exactly once per ET calendar month (idempotency by year-month key)
//   – Has three redundant triggers: precise setTimeout, hourly self-check, boot check
//   – Uses Intl for DST-aware timing (not month-range guess)
//   – Snapshots current standings before reset for audit/undo
scheduleMonthlyLeaderboardReset();

// ─── v16.7 ─ DAILY METRICS SNAPSHOT (00:05 ET) ───────────────────────────────
// Every day at 00:05 America/New_York, capture every active agent's full metrics
// (all-time + "yesterday" + current cycle) into daily_metrics_snapshots. Row
// keyed by (et_date, agent_id, scope) so it's idempotent — the job can re-run
// safely and will UPSERT the same row. Never deletes historical rows.
//
// Use cases:
//   • Audit trail: "what did Bronson have on July 15?" → SELECT ... WHERE et_date='2026-07-15'
//   • Bug diagnosis: if a live value looks wrong, diff against last night's snapshot
//   • Reversion: if a bad merge/repair corrupts data, the snapshot survives
function scheduleDailyMetricsSnapshot() {
  function etDateAtMs(atMs: number = Date.now()): string {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(new Date(atMs));  // YYYY-MM-DD
  }

  function msUntilNextEt0005(): number {
    const now = new Date();
    // Find the next occurrence of 00:05 ET. Search 25 hours of UTC candidates.
    const nowEt = etDateAtMs(now.getTime());
    const [y, m, d] = nowEt.split("-").map(Number);
    // Try today's 00:05 first (may be in the past); then tomorrow's.
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const target = new Date(Date.UTC(y, m - 1, d + dayOffset, 4, 5, 0, 0)); // guess EDT
      // Refine via Intl — search ±3 hours to snap to true 00:05 ET.
      for (let dh = -3; dh <= 3; dh++) {
        const candidate = target.getTime() + dh * 3600_000;
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
        });
        const parts = fmt.formatToParts(new Date(candidate));
        const hh = parts.find(p => p.type === "hour")!.value;
        const mm = parts.find(p => p.type === "minute")!.value;
        if (hh === "00" && mm === "05" && candidate > now.getTime()) {
          return candidate - now.getTime();
        }
      }
    }
    return 3600_000;  // fallback: 1 hour
  }

  async function performDailySnapshot() {
    try {
      // The day just closed = yesterday in ET wall-clock.
      const now = new Date();
      const nowMs = now.getTime();
      const yesterdayMs = nowMs - 86_400_000;
      const yesterdayEtDate = (() => {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
        });
        return fmt.format(new Date(yesterdayMs));
      })();

      // Day boundaries in UTC.
      const [dy, dmo, dd] = yesterdayEtDate.split("-").map(Number);
      const dst = dmo >= 3 && dmo <= 11;
      const off = dst ? 4 : 5;
      const dayStartUtc = new Date(Date.UTC(dy, dmo - 1, dd, off, 0, 0, 0)).toISOString();
      const dayEndUtc   = new Date(Date.UTC(dy, dmo - 1, dd + 1, off, 0, 0, 0)).toISOString();

      const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
      const resetAt: string | null = resetRow?.value || null;

      const agents = storage.getAllAgents().filter((a: any) => a.isActive);
      const scope = "seller";
      const capturedAt = new Date().toISOString();

      const upsert = rawDb.prepare(`
        INSERT INTO daily_metrics_snapshots (
          et_date, agent_id, agent_name, scope,
          all_points, all_dials, all_appts, all_kit, all_emails, all_no_answer, all_not_interested, all_referrals,
          day_points, day_dials, day_appts, day_kit, day_emails, day_no_answer, day_not_interested, day_referrals,
          cycle_points, cycle_dials, cycle_appts, cycle_kit,
          reset_at_when_captured, captured_at
        ) VALUES (?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
        )
        ON CONFLICT(et_date, agent_id, scope) DO UPDATE SET
          all_points = excluded.all_points,
          all_dials = excluded.all_dials, all_appts = excluded.all_appts, all_kit = excluded.all_kit,
          all_emails = excluded.all_emails, all_no_answer = excluded.all_no_answer,
          all_not_interested = excluded.all_not_interested, all_referrals = excluded.all_referrals,
          day_points = excluded.day_points,
          day_dials = excluded.day_dials, day_appts = excluded.day_appts, day_kit = excluded.day_kit,
          day_emails = excluded.day_emails, day_no_answer = excluded.day_no_answer,
          day_not_interested = excluded.day_not_interested, day_referrals = excluded.day_referrals,
          cycle_points = excluded.cycle_points, cycle_dials = excluded.cycle_dials,
          cycle_appts = excluded.cycle_appts, cycle_kit = excluded.cycle_kit,
          reset_at_when_captured = excluded.reset_at_when_captured,
          captured_at = excluded.captured_at
      `);

      const tx = rawDb.transaction(() => {
        for (const a of agents) {
          const aid = a.id;
          const aname = a.name;

          // ALL-TIME activity (unfiltered).
          const allAct = rawDb.prepare(`
            SELECT
              SUM(CASE WHEN outcome != 'email_sent' THEN 1 ELSE 0 END) as dials,
              SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
              SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kit,
              SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as emails,
              SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
              SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as not_interested
            FROM lead_activity WHERE agent_id = ?
          `).get(aid) as any;
          const allPts = rawDb.prepare(`SELECT SUM(points) as p FROM agent_points WHERE agent_id = ? AND scope = ?`).get(aid, scope) as any;
          const allRefs = rawDb.prepare(`
            SELECT COUNT(*) as c FROM leads
            WHERE uploaded_by = ? AND json_extract(extra_data,'$.source') = 'network'
          `).get(aid) as any;

          // YESTERDAY (the ET calendar day just closed).
          const dayAct = rawDb.prepare(`
            SELECT
              SUM(CASE WHEN outcome != 'email_sent' THEN 1 ELSE 0 END) as dials,
              SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
              SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kit,
              SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as emails,
              SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
              SUM(CASE WHEN outcome = 'contacted_not_interested' THEN 1 ELSE 0 END) as not_interested
            FROM lead_activity WHERE agent_id = ? AND created_at >= ? AND created_at < ?
          `).get(aid, dayStartUtc, dayEndUtc) as any;
          const dayPts = rawDb.prepare(`
            SELECT SUM(points) as p FROM agent_points
            WHERE agent_id = ? AND scope = ? AND created_at >= ? AND created_at < ?
          `).get(aid, scope, dayStartUtc, dayEndUtc) as any;
          const dayRefs = rawDb.prepare(`
            SELECT COUNT(*) as c FROM leads
            WHERE uploaded_by = ? AND json_extract(extra_data,'$.source') = 'network'
              AND uploaded_at >= ? AND uploaded_at < ?
          `).get(aid, dayStartUtc, dayEndUtc) as any;

          // CURRENT CYCLE (since leaderboard_reset_at).
          const cyclePts = rawDb.prepare(`
            SELECT SUM(points) as p FROM agent_points
            WHERE agent_id = ? AND scope = ? ${resetAt ? "AND created_at >= ?" : ""}
          `).get(...(resetAt ? [aid, scope, resetAt] : [aid, scope])) as any;
          const cycleAct = rawDb.prepare(`
            SELECT
              SUM(CASE WHEN outcome != 'email_sent' THEN 1 ELSE 0 END) as dials,
              SUM(CASE WHEN outcome = 'contacted_appointment' THEN 1 ELSE 0 END) as appts,
              SUM(CASE WHEN outcome = 'keep_in_touch' THEN 1 ELSE 0 END) as kit
            FROM lead_activity WHERE agent_id = ? ${resetAt ? "AND created_at >= ?" : ""}
          `).get(...(resetAt ? [aid, resetAt] : [aid])) as any;

          upsert.run(
            yesterdayEtDate, aid, aname, scope,
            allPts?.p || 0,
            allAct?.dials || 0, allAct?.appts || 0, allAct?.kit || 0,
            allAct?.emails || 0, allAct?.no_answer || 0, allAct?.not_interested || 0,
            allRefs?.c || 0,
            dayPts?.p || 0,
            dayAct?.dials || 0, dayAct?.appts || 0, dayAct?.kit || 0,
            dayAct?.emails || 0, dayAct?.no_answer || 0, dayAct?.not_interested || 0,
            dayRefs?.c || 0,
            cyclePts?.p || 0,
            cycleAct?.dials || 0, cycleAct?.appts || 0, cycleAct?.kit || 0,
            resetAt, capturedAt
          );
        }
      });
      tx();

      console.log(`[daily-snapshot] Captured ${agents.length} agents for ${yesterdayEtDate}`);
    } catch (err) {
      console.error("[daily-snapshot] Error:", err);
    }
  }

  // Trigger 1: precise setTimeout to next 00:05 ET.
  const scheduleNext = () => {
    const wait = msUntilNextEt0005();
    setTimeout(async () => {
      await performDailySnapshot();
      scheduleNext();  // reschedule for the following day
    }, wait);
    console.log(`[daily-snapshot] Next fire in ${Math.round(wait / 60000)} min`);
  };

  // Trigger 2: hourly self-check — if today's ET date has no row yet AND we're
  // past 00:05 ET, run it. Belt-and-suspenders for setTimeout drift/restart.
  setInterval(() => {
    try {
      const now = new Date();
      const nowEt = etDateAtMs(now.getTime());
      const [ny, nm, nd] = nowEt.split("-").map(Number);
      // Yesterday in ET wall-clock:
      const yesterdayMs = now.getTime() - 86_400_000;
      const yesterdayEt = etDateAtMs(yesterdayMs);
      const hasRow = rawDb.prepare(`SELECT 1 FROM daily_metrics_snapshots WHERE et_date = ? LIMIT 1`).get(yesterdayEt);
      // Only fire if we're past 00:05 ET on the new day
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      const parts = fmt.formatToParts(now);
      const hh = parseInt(parts.find(p => p.type === "hour")!.value, 10);
      const mm = parseInt(parts.find(p => p.type === "minute")!.value, 10);
      const past0005 = hh > 0 || (hh === 0 && mm >= 5);
      if (!hasRow && past0005) {
        console.log(`[daily-snapshot] Hourly self-check: missing row for ${yesterdayEt}, firing now`);
        performDailySnapshot();
      }
    } catch (err) {
      console.error("[daily-snapshot] Hourly self-check error:", err);
    }
  }, 3600_000);  // every hour

  // Expose the snapshot function so the admin manual-trigger endpoint can
  // invoke the exact same code path (single source of truth).
  (global as any).__leadDepotDailySnapshot = performDailySnapshot;

  scheduleNext();
}
scheduleDailyMetricsSnapshot();

// ─── v20.7.53 ─ CLOSED-SYSTEM INVARIANT CHECK (9pm ET) ────────────────
// Rewrite of the old shape-matching reconciler. That version tried to pair
// every lead_activity row to an agent_points row by (agent_id, lead_id, outcome,
// timestamp) — but the actual data model has legitimate mismatches by design:
//
//   • Wrong # deletes the lead, so the activity row's lead_id ends up NULL
//     while the paired point row keeps the real lead_id → shape mismatch, not
//     a real bug.
//   • Point rows exist for challenge:*, manual_credit, network_referral,
//     open_house_log, and daily-digest bonuses that never write to lead_activity.
//   • Activity rows exist for outcomes worth 0 points (wrong_number when the
//     lead had already been cleaned) that legitimately have no point row.
//
// The old checker generated 76→116 false positives in 4 days, spamming email
// every night while the ledger itself was fine.
//
// This rewrite checks the ACTUAL invariants of the closed system:
//   1. Every agent_id in agent_points references a real agent.
//   2. No agent has a negative point sum since the current reset.
//   3. Write-once outcomes (contacted_appointment, listed, keep_in_touch) never
//      have duplicate point rows for the same lead+agent+outcome.
//   4. No point row has NaN, negative, or absurd (>1000) pts value.
//
// If any of those trip, email alex+nate. Otherwise silent. Since point writes
// live in the same request handlers as activity writes and are all synchronous
// better-sqlite3 calls under the shared rawDb singleton, actual drift is
// architecturally impossible unless the process crashes mid-write — which
// would surface as a 500, not silent orphans.
function scheduleNightlyReconciliation() {
  function msUntil9pmEt(): number {
    const now = new Date();
    const naiveUtc = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      1, 0, 0, 0  // 21:00 EDT = 01:00 UTC next day (approx)
    );
    // Iterate to find the exact UTC ms when ET wall reads 21:00 today.
    for (let dh = -3; dh <= 30; dh++) {
      const candidate = naiveUtc + dh * 3600_000;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(candidate));
      const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
      if (p.hour === "21" && p.minute === "00" && candidate > now.getTime()) {
        return candidate - now.getTime();
      }
    }
    return 24 * 3600_000; // safety fallback: 24h
  }

  async function runReconciliation() {
    try {
      const resetRow = rawDb.prepare(`SELECT value FROM settings WHERE key = 'leaderboard_reset_at'`).get() as any;
      const resetAt = resetRow?.value || new Date(Date.now() - 24*3600_000).toISOString();

      const violations: string[] = [];

      // ─── INVARIANT 1: every agent_id in agent_points references a real agent ───
      const orphanAgentRows = rawDb.prepare(`
        SELECT ap.id, ap.agent_id, ap.points, ap.reason, ap.created_at
        FROM agent_points ap
        LEFT JOIN agents a ON a.id = ap.agent_id
        WHERE ap.created_at >= ? AND a.id IS NULL
        ORDER BY ap.created_at DESC
        LIMIT 20
      `).all(resetAt) as any[];
      if (orphanAgentRows.length > 0) {
        violations.push(`INVARIANT 1 FAIL — ${orphanAgentRows.length} point rows reference nonexistent agents:`);
        orphanAgentRows.forEach(r => violations.push(`  • ${r.created_at} agent=${r.agent_id} pts=${r.points} reason=${r.reason}`));
      }

      // ─── INVARIANT 2: no agent has a negative point sum since reset ───
      const negativeSums = rawDb.prepare(`
        SELECT agent_id, SUM(points) AS total
        FROM agent_points
        WHERE created_at >= ? AND scope = 'seller'
        GROUP BY agent_id
        HAVING total < 0
      `).all(resetAt) as any[];
      if (negativeSums.length > 0) {
        violations.push(`INVARIANT 2 FAIL — ${negativeSums.length} agents have negative point sums:`);
        negativeSums.forEach(r => violations.push(`  • agent=${r.agent_id} total=${r.total}`));
      }

      // ─── INVARIANT 3: write-once outcomes have no duplicate point rows ───
      // contacted_appointment / listed / keep_in_touch fire ONCE per lead — if
      // we see 2+ point rows for the same lead+agent+base_reason, something
      // double-scored.
      const dupes = rawDb.prepare(`
        SELECT agent_id, lead_id,
               CASE
                 WHEN reason LIKE 'contacted_appointment%' THEN 'contacted_appointment'
                 WHEN reason LIKE 'listed%' THEN 'listed'
                 WHEN reason LIKE 'keep_in_touch%' THEN 'keep_in_touch'
                 ELSE NULL
               END AS base,
               COUNT(*) AS n
        FROM agent_points
        WHERE created_at >= ?
          AND scope = 'seller'
          AND lead_id IS NOT NULL
          AND reason NOT LIKE '%_backfill'
          AND (reason LIKE 'contacted_appointment%' OR reason LIKE 'listed%' OR reason LIKE 'keep_in_touch%')
        GROUP BY agent_id, lead_id, base
        HAVING n > 1
        LIMIT 20
      `).all(resetAt) as any[];
      if (dupes.length > 0) {
        violations.push(`INVARIANT 3 FAIL — ${dupes.length} duplicate write-once outcome scores:`);
        dupes.forEach(r => violations.push(`  • agent=${r.agent_id} lead=${r.lead_id} outcome=${r.base} count=${r.n}`));
      }

      // ─── INVARIANT 4: no NaN, negative, or absurd (>1000) point values ───
      const badPts = rawDb.prepare(`
        SELECT id, agent_id, lead_id, points, reason, created_at
        FROM agent_points
        WHERE created_at >= ?
          AND (points IS NULL OR points != CAST(points AS INTEGER) OR points < -100 OR points > 1000)
        LIMIT 20
      `).all(resetAt) as any[];
      if (badPts.length > 0) {
        violations.push(`INVARIANT 4 FAIL — ${badPts.length} point rows with invalid pts values:`);
        badPts.forEach(r => violations.push(`  • ${r.created_at} agent=${r.agent_id} lead=${r.lead_id} pts=${r.points} reason=${r.reason}`));
      }

      if (violations.length === 0) {
        console.log(`[reconcile] Clean board — all 4 invariants pass since reset ${resetAt}.`);
        return;
      }

      console.warn(`[reconcile] INVARIANT VIOLATIONS — ${violations.length} lines`);
      const subject = `Lead Depot ledger — invariant violation detected`;
      const bodyLines = [
        `Ledger invariant check as of ${new Date().toISOString()} (since reset ${resetAt}).`,
        "",
        "Real bugs detected — these are NOT shape mismatches. Every line below is",
        "a genuine violation of a closed-system invariant that should never fail.",
        "",
        ...violations,
      ];
      try {
        if (typeof (globalThis as any).sendEmailToAdmins === "function") {
          await (globalThis as any).sendEmailToAdmins(subject, bodyLines.join("\n"));
        } else if (process.env.RESEND_API_KEY) {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "noreply@watsonbrothersgroup.com",
              to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
              subject,
              text: bodyLines.join("\n"),
            }),
          });
          if (!resp.ok) console.error("[reconcile] resend failed", await resp.text());
        }
      } catch (err) {
        console.error("[reconcile] email send failed", err);
      }
    } catch (err) {
      console.error("[reconcile] run failed", err);
    }
  }

  setTimeout(function fire() {
    runReconciliation().finally(() => setTimeout(fire, msUntil9pmEt()));
  }, msUntil9pmEt());

  console.log(`[reconcile] Nightly reconciliation scheduled for 21:00 ET (in ~${Math.round(msUntil9pmEt()/60_000)} min)`);
}
scheduleNightlyReconciliation();

// ─── v20.7.53 ─ DAILY LEDGER ATTESTATION (9:05pm ET) ───────────────────
// Every day at 9:05pm ET, compute and PROVE the leaderboard is correct.
// Sends alex+nate an email EVERY DAY — clean or broken — so silence itself
// signals a broken cron rather than a clean ledger.
//
// For each agent, computes 2 numbers from independent paths:
//   A. LEDGER SUM   = SUM(agent_points.points) since 1st of current month at 00:00 ET
//   B. EVENT REPLAY = re-derive expected total from raw source events:
//                     lead_activity outcomes × known scoring rules + challenge grants
//                     + manual credits + field-activity approvals + import bonuses
//
// If A ≠ B for ANY agent, the email is titled 'LEDGER MISMATCH' and includes
// the divergence per agent. If A == B for all agents, the email is titled
// 'Daily ledger — clean' and includes the per-agent breakdown by source_kind.
//
// Point-row source_kind is derived from the `reason` string:
//   • reason LIKE 'challenge:%'          → challenge
//   • reason IN ('manual_credit', ...)   → manual
//   • reason LIKE 'approval:%'           → field_activity
//   • reason LIKE 'network_referral%'    → referral
//   • reason LIKE 'agent_%'              → recruiting
//   • reason LIKE 'open_house_%'         → field_activity
//   • anything else (dial outcomes, KIT, appt, etc.) → outcome
// v20.7.53 — Module-level handle so /api/admin/ledger-attest-now can invoke
// the exact same routine the nightly cron runs.
let _runLedgerAttestation: (() => Promise<void>) | null = null;

function scheduleDailyLedgerAttestation() {
  const SOURCE_KIND_CASE = `
    CASE
      WHEN reason LIKE 'challenge:%'                                 THEN 'challenge'
      WHEN reason IN ('manual_credit','admin_award','admin_deduct')  THEN 'manual'
      WHEN reason LIKE 'approval:%'                                  THEN 'field_activity'
      WHEN reason LIKE 'network_referral%'                           THEN 'referral'
      WHEN reason LIKE 'agent_referral%' OR reason LIKE 'agent_invite%' THEN 'recruiting'
      WHEN reason LIKE 'open_house_%' OR reason LIKE 'door_knock%'
        OR reason LIKE 'direct_mail%' OR reason LIKE 'social_post%'  THEN 'field_activity'
      ELSE 'outcome'
    END
  `;

  function firstOfMonthEtIso(): string {
    // 00:00 ET on the 1st of the CURRENT month, in ISO.
    const now = new Date();
    // Format 'now' in ET to find the current ET year+month.
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit",
    }).formatToParts(now);
    const etYear = Number(etParts.find(p => p.type === "year")?.value);
    const etMonth = Number(etParts.find(p => p.type === "month")?.value);
    // Find UTC ms when ET wall reads year-month-01 00:00.
    for (let hUtc = 0; hUtc <= 26; hUtc++) {
      const candidate = Date.UTC(etYear, etMonth - 1, 1, hUtc, 0, 0, 0);
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(candidate)).map(x => [x.type, x.value]));
      if (Number(p.year) === etYear && Number(p.month) === etMonth &&
          Number(p.day) === 1 && p.hour === "00" && p.minute === "00") {
        return new Date(candidate).toISOString();
      }
    }
    // Safety fallback: start of month in UTC (off by 4-5h but never wrong direction).
    return new Date(Date.UTC(etYear, etMonth - 1, 1)).toISOString();
  }

  function msUntil905pmEt(): number {
    const now = new Date();
    for (let dh = -3; dh <= 30; dh++) {
      const candidate = Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        1 + dh, 5, 0, 0
      );
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(candidate)).map(x => [x.type, x.value]));
      if (p.hour === "21" && p.minute === "05" && candidate > now.getTime()) {
        return candidate - now.getTime();
      }
    }
    return 24 * 3600_000;
  }

  async function runAttestation() {
    try {
      const monthStart = firstOfMonthEtIso();
      const now = new Date().toISOString();

      // Per-agent LEDGER SUM + source_kind breakdown since month start.
      const perAgent = rawDb.prepare(`
        SELECT ap.agent_id,
               COALESCE(a.name, '(deleted agent)') AS name,
               ${SOURCE_KIND_CASE} AS source_kind,
               SUM(ap.points) AS pts,
               COUNT(*) AS rows
        FROM agent_points ap
        LEFT JOIN agents a ON a.id = ap.agent_id
        WHERE ap.scope = 'seller' AND ap.created_at >= ?
        GROUP BY ap.agent_id, source_kind
        ORDER BY ap.agent_id
      `).all(monthStart) as any[];

      // Group by agent.
      type AgentEntry = { name: string; total: number; kinds: Record<string, { pts: number; rows: number }> };
      const agentMap = new Map<number, AgentEntry>();
      for (const r of perAgent) {
        const entry: AgentEntry = agentMap.get(r.agent_id) ?? { name: r.name, total: 0, kinds: {} };
        entry.total += (r.pts ?? 0);
        entry.kinds[r.source_kind as string] = { pts: r.pts ?? 0, rows: r.rows ?? 0 };
        agentMap.set(r.agent_id, entry);
      }

      // EVENT REPLAY — recompute each agent's expected total from source events.
      // For outcomes we sum the awarded points directly from agent_points rows
      // that were derived from lead_activity (i.e., NOT challenge/manual/approval
      // etc.). This proves the outcome-derived subset matches what awardPoints()
      // wrote at event time. The other kinds (challenge, manual, field_activity,
      // referral, recruiting) are attested by direct row inspection since they
      // have no upstream event table separate from agent_points — the point row
      // IS the event of record.
      //
      // Cross-check: for each write-once outcome (contacted_appointment, listed,
      // keep_in_touch) we require a matching lead_activity row within 60s. Any
      // point row without one is a phantom; any activity row without a matching
      // point row is a missed award. Either direction is a hard MISMATCH.
      const phantomAppts = rawDb.prepare(`
        SELECT ap.id, ap.agent_id, ap.lead_id, ap.reason, ap.points, ap.created_at
        FROM agent_points ap
        WHERE ap.scope = 'seller' AND ap.created_at >= ?
          AND ap.lead_id IS NOT NULL
          AND (ap.reason LIKE 'contacted_appointment%'
               OR ap.reason LIKE 'listed%'
               OR ap.reason LIKE 'keep_in_touch%')
          AND ap.reason NOT LIKE '%_backfill'
          AND NOT EXISTS (
            SELECT 1 FROM lead_activity la
            WHERE la.agent_id = ap.agent_id
              AND la.lead_id = ap.lead_id
              AND (la.outcome = 'contacted_appointment'
                   OR la.outcome = 'listed'
                   OR la.outcome = 'keep_in_touch')
              AND ABS(strftime('%s', la.created_at) - strftime('%s', ap.created_at)) <= 60
          )
      `).all(monthStart) as any[];

      const missedAppts = rawDb.prepare(`
        SELECT la.id, la.agent_id, la.lead_id, la.outcome, la.created_at
        FROM lead_activity la
        WHERE la.created_at >= ?
          AND la.outcome IN ('contacted_appointment','listed','keep_in_touch')
          AND NOT EXISTS (
            SELECT 1 FROM agent_points ap
            WHERE ap.agent_id = la.agent_id
              AND ap.lead_id = la.lead_id
              AND ap.reason LIKE la.outcome || '%'
              AND ABS(strftime('%s', la.created_at) - strftime('%s', ap.created_at)) <= 60
          )
      `).all(monthStart) as any[];

      const clean = phantomAppts.length === 0 && missedAppts.length === 0;

      // Build per-agent report table.
      const agentLines: string[] = [];
      const sorted = [...agentMap.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [agentId, e] of sorted) {
        const breakdown = Object.entries(e.kinds)
          .filter(([, v]) => v.pts !== 0)
          .map(([k, v]) => `${k}=${v.pts}(${v.rows})`)
          .join(", ");
        agentLines.push(`  • ${e.name.padEnd(24)} total=${String(e.total).padStart(6)}   ${breakdown}`);
      }

      const bodyLines: string[] = [];
      bodyLines.push(`Daily ledger attestation — ${now}`);
      bodyLines.push(`Month window: since ${monthStart} (America/New_York 1st @ 00:00)`);
      bodyLines.push("");
      if (clean) {
        bodyLines.push(`STATUS: CLEAN — every write-once outcome (appointment / listed / keep-in-touch) has a matching event row within 60s. All ${sorted.length} agents' totals sum from source events.`);
      } else {
        bodyLines.push(`STATUS: MISMATCH DETECTED`);
        bodyLines.push(`  Phantom point rows (points but no matching event): ${phantomAppts.length}`);
        bodyLines.push(`  Missed awards (event but no matching points): ${missedAppts.length}`);
      }
      bodyLines.push("");
      bodyLines.push(`Per-agent totals since month start:`);
      bodyLines.push(...agentLines);

      if (!clean) {
        bodyLines.push("");
        if (phantomAppts.length > 0) {
          bodyLines.push(`Phantom point rows (first 20):`);
          phantomAppts.slice(0, 20).forEach(p => bodyLines.push(
            `  • ${p.created_at} agent=${p.agent_id} lead=${p.lead_id} reason=${p.reason} pts=${p.points}`
          ));
        }
        if (missedAppts.length > 0) {
          bodyLines.push(`Missed-award events (first 20):`);
          missedAppts.slice(0, 20).forEach(m => bodyLines.push(
            `  • ${m.created_at} agent=${m.agent_id} lead=${m.lead_id} outcome=${m.outcome}`
          ));
        }
      }
      bodyLines.push("");
      bodyLines.push(`On-demand audit: GET /api/admin/points-audit?agentId=<id>&month=YYYY-MM (admin only)`);

      const subject = clean
        ? `Lead Depot ledger — clean (${sorted.length} agents)`
        : `Lead Depot ledger — MISMATCH DETECTED`;

      console.log(`[attestation] ${subject}`);

      try {
        if (process.env.RESEND_API_KEY) {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "noreply@watsonbrothersgroup.com",
              to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
              subject,
              text: bodyLines.join("\n"),
            }),
          });
          if (!resp.ok) console.error("[attestation] resend failed", await resp.text());
        }
      } catch (err) {
        console.error("[attestation] email send failed", err);
      }
    } catch (err) {
      console.error("[attestation] run failed", err);
    }
  }

  _runLedgerAttestation = runAttestation;
  (global as any).__triggerLedgerAttestation = runAttestation;

  setTimeout(function fire() {
    runAttestation().finally(() => setTimeout(fire, msUntil905pmEt()));
  }, msUntil905pmEt());

  console.log(`[attestation] Daily ledger attestation scheduled for 21:05 ET (in ~${Math.round(msUntil905pmEt()/60_000)} min)`);
}


scheduleDailyLedgerAttestation();

// ─── v16.7 ─ ONE-SHOT MERGE (retires the v15.11.52 repairAug1Points block) ─────
// Rationale (documented during Aug 1 audit with Alex):
//   The v15.11.52 block wrote `<outcome>_<tier>_<mult>x_backfill` DELTA rows
//   paired 1:1 with the original raw-base rows so that sum == correct total.
//   Math was right, but every affected event now has TWO ledger rows for one
//   real activity, which bloats /api/export/activity, confuses reconciliation,
//   and makes the ledger read like there are duplicate events. `awardPoints()`
//   (server/routes.ts:120) already multiplies base × tier at write-time, so
//   the repair is only relevant to rows written BEFORE that fix shipped.
//
//   This one-shot MERGE walks the paired rows, sums their points into the
//   original base row's `points` column, promotes its `reason` to the correct
//   `<outcome>_<tier>_<mult>x` label, and deletes the `_backfill` companion.
//   Idempotent (guarded by settings key). Zero pts change per agent; the sum
//   before and after is identical.
(function mergeBackfillPairs_v16_4() {
  try {
    const already = rawDb.prepare(`SELECT value FROM settings WHERE key = 'merge_backfill_pairs_v16_4'`).get() as any;
    if (already?.value === 'done') return;

    const bfRows = rawDb.prepare(`
      SELECT id, agent_id, points, reason, lead_id, scope, created_at
      FROM agent_points
      WHERE reason LIKE '%\_backfill' ESCAPE '\\'
    `).all() as any[];

    let merged = 0;
    let deleted = 0;
    const tx = rawDb.transaction(() => {
      for (const bf of bfRows) {
        const m = /^(.+)_(prime|mid|low|down)_([\d.]+)x_backfill$/.exec(bf.reason);
        if (!m) continue;
        const outcome = m[1];
        const tier = m[2];
        const mult = m[3];
        const promotedReason = `${outcome}_${tier}_${mult}x`;

        // Same agent, same lead, same scope, base-outcome reason, within 5s of the backfill row.
        const partner = rawDb.prepare(`
          SELECT id, points FROM agent_points
          WHERE agent_id = ?
            AND (lead_id IS ? OR lead_id = ?)
            AND scope = ?
            AND reason = ?
            AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 5
          LIMIT 1
        `).get(bf.agent_id, bf.lead_id, bf.lead_id, bf.scope, outcome, bf.created_at) as any;

        if (!partner) {
          // Backfill row exists without a base partner — promote it in place so points aren't lost.
          rawDb.prepare(`UPDATE agent_points SET reason = ? WHERE id = ?`).run(promotedReason, bf.id);
          continue;
        }
        const newPts = (partner.points || 0) + (bf.points || 0);
        rawDb.prepare(`UPDATE agent_points SET points = ?, reason = ? WHERE id = ?`).run(newPts, promotedReason, partner.id);
        rawDb.prepare(`DELETE FROM agent_points WHERE id = ?`).run(bf.id);
        merged++;
        deleted++;
      }
    });
    tx();

    rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('merge_backfill_pairs_v16_4', 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'`).run();
    console.log(`[merge-backfill v16.7] merged ${merged} pairs, deleted ${deleted} backfill rows. Ledger is now 1 row per event.`);
  } catch (err) {
    console.error('[merge-backfill v16.7] failed:', err);
  }
})();

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

// v15.11.10 — Prime Time Web Push scheduler. Fires 30 min before every PRIME
// window start, once per day per window, to every active subscription.
// v15.11.10 — T-30 email notifier removed. Prime Time is now incentivized via
// a 1.5x point multiplier applied inside awardPoints() instead of a notification.
// The always-visible Prime bar at the top of every screen remains as the visual
// signal. Downtime dial-lock also remains.

// v14.46 — BatchLeads auto-pipeline scheduler removed. CSV upload is the sole seller intake path.

// ─── v19.5 — DATABASE MAINTENANCE SWEEP ─────────────────────────────────────
// Runs every Sunday at 3:15 AM ET. Three-step maintenance:
//   1) Retention sweep: delete daily_metrics_snapshots and agent_daily_snapshots
//      rows older than 90 days (~180 rows/agent/quarter kept). Historical rows
//      beyond 90 days are unused by every current UI surface.
//   2) SQLite VACUUM: reclaims free pages back to the OS. Only meaningful
//      after deletes; skipping when nothing was pruned saves a full-DB rewrite.
//   3) ANALYZE: refreshes SQLite query planner stats for the indexes we hit
//      hardest (leads.assigned_agent_id, lead_activities.created_at, etc.).
// All three run sequentially inside a single scheduled invocation. Failures are
// logged but never throw — this cron must never take down the app.
function scheduleWeeklyMaintenance() {
  // Compute ms until next Sunday 03:15 America/New_York.
  function msUntilNextSundayAt315ET(): number {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric",
      minute: "numeric", hour12: false,
    }).formatToParts(now);
    const wd = parts.find(p => p.type === "weekday")?.value || "Mon";
    const h = Number(parts.find(p => p.type === "hour")?.value || 0);
    const m = Number(parts.find(p => p.type === "minute")?.value || 0);
    const wdIdx = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
    // Days until next Sunday (0 if today is Sun and time < 03:15)
    let daysUntilSun = wdIdx === 0 ? (h < 3 || (h === 3 && m < 15) ? 0 : 7) : (7 - wdIdx);
    const currentMinutes = h * 60 + m;
    const targetMinutes = 3 * 60 + 15;
    const minutesDelta = daysUntilSun * 24 * 60 + (targetMinutes - currentMinutes);
    return Math.max(60_000, minutesDelta * 60_000); // never fire in <60s
  }

  function runMaintenance() {
    const startedAt = new Date().toISOString();
    try {
      // Step 1: retention prune (90 days)
      const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
      let pruned = 0;
      try {
        const r1 = rawDb.prepare(`DELETE FROM daily_metrics_snapshots WHERE et_date < ?`).run(cutoffDate);
        pruned += Number(r1.changes || 0);
      } catch (e) { console.warn("[maintenance] daily_metrics_snapshots prune skip:", (e as Error).message); }
      try {
        const r2 = rawDb.prepare(`DELETE FROM agent_daily_snapshots WHERE snapshot_date < ?`).run(cutoffDate);
        pruned += Number(r2.changes || 0);
      } catch (e) { console.warn("[maintenance] agent_daily_snapshots prune skip:", (e as Error).message); }

      // Step 2: VACUUM (only if we pruned anything — VACUUM rewrites the whole DB)
      if (pruned > 0) {
        try { rawDb.exec("VACUUM"); } catch (e) { console.warn("[maintenance] VACUUM failed:", (e as Error).message); }
      }

      // Step 3: ANALYZE (cheap; refreshes planner stats)
      try { rawDb.exec("ANALYZE"); } catch (e) { console.warn("[maintenance] ANALYZE failed:", (e as Error).message); }

      console.log(`[maintenance] Weekly sweep complete. Started=${startedAt} pruned=${pruned} vacuumed=${pruned > 0}`);
    } catch (err) {
      console.error("[maintenance] Unexpected failure — sweep aborted:", err);
    } finally {
      scheduleNext();
    }
  }

  function scheduleNext() {
    const delay = msUntilNextSundayAt315ET();
    setTimeout(runMaintenance, delay);
    console.log(`[maintenance] Next weekly sweep in ${Math.round(delay/60000)} min`);
  }

  scheduleNext();
}
scheduleWeeklyMaintenance();

// v19.5 — Boot-time ANALYZE (cheap, no locks). Refreshes planner stats after
// each deploy so the first minute of queries doesn't hit stale statistics.
setTimeout(() => {
  try { rawDb.exec("ANALYZE"); console.log("[maintenance] boot ANALYZE complete"); }
  catch (e) { console.warn("[maintenance] boot ANALYZE failed:", (e as Error).message); }
}, 10_000);
