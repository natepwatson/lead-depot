import { createRequire } from "node:module";
import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { rawDb } from "./db";
import { Resend } from "resend";
import { broadcast } from "./ws";
import { randomBytes } from "node:crypto";
import { pushOutcomeToFub, fubCreateAgentRecruit } from "./fub";
import { runBatchLeadsPipeline } from "./batchleads";
import { runDbprPipeline } from "./dbpr-pipeline";
import { getTerritoryForZip, TERRITORIES as TERRITORY_META } from "./territories";
import fs from "node:fs";
import path from "node:path";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── POINTS HELPER (v11.40) ───────────────────────────────────────────────────
// Scoring: Appointment=10, KIT=3, WrongNumber=+2 (list cleanup reward), Referral=5, any other dial=1
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
    contacted_appointment: 10,
    keep_in_touch: 3,
    wrong_number: 2,
    network_referral: 5,
    // all other outcomes = 1 dial point
  };
  const points = pts[outcome] ?? 1;
  const reason = outcome;
  rawDb.prepare(
    `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, points, reason, leadId ?? null, scope, new Date().toISOString());
}


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
    <span>Lead Depot v13.8.3 — Brothers Group · Momentum Realty</span>
  </div>
</div>
</body>
</html>`;

  await resend.emails.send({
    from:    "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:      ["Denise@watsonbrothersgroup.com"],
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
  <div style="padding:12px 28px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v13.8.3 — Brothers Group · Momentum Realty</div>
</div></body></html>`;

  await resend.emails.send({
    from: "Lead Depot <noreply@watsonbrothersgroup.com>",
    to:   ["alex@watsonbrothersgroup.com"],
    cc:   ["nate@watsonbrothersgroup.com"],
    subject,
    html,
  });
}

// ─── QUEUE DEPTH ALERT ──────────────────────────────────────────────────────────────────────
// Fires when active seller lead queue drops to or below LOW_QUEUE_THRESHOLD per active agent
const LOW_QUEUE_THRESHOLD = 5; // leads per active agent
async function checkQueueDepthAlert(rawDb: any) {
  if (!resend) return;
  try {
    const activeLeads = (rawDb.prepare(`SELECT COUNT(*) as n FROM leads WHERE status NOT IN ('retired','contacted_not_interested','contacted_appointment','keep_in_touch','wrong_number')`).get() as any)?.n ?? 0;
    const activeAgents = (rawDb.prepare(`SELECT COUNT(*) as n FROM agents WHERE is_active = 1 AND receive_leads = 1 AND lead_flow_on = 1`).get() as any)?.n ?? 1;
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
    <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:0 0 20px">BatchLeads runs daily at 6am. If the queue stays low, check your BatchLeads lists or trigger a manual run from the Admin panel.</p>
    <a href="https://depot.watsonbrothersgroup.com" style="display:inline-block;background:#c8aa5a;color:#080808;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:12px 20px;border-radius:8px;text-decoration:none">Open Lead Depot</a>
  </div>
  <div style="padding:12px 26px;background:#0a0908;border-top:1px solid #1e1c19;font-size:11px;color:#444">Lead Depot v13.8.3 — Brothers Group · Momentum Realty</div>
</div></body></html>`,
    });
    console.log(`[QueueAlert] Sent low-queue alert: ${activeLeads} leads / ${activeAgents} agents`);
  } catch (err: any) {
    console.error("[QueueAlert] Error:", err.message);
  }
}

// Works in both ESM (tsx dev) and CJS (esbuild production bundle)
const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

export function registerRoutes(httpServer: ReturnType<typeof createServer>, app: Express) {

  // ─── AUTH ──────────────────────────────────────────────────────────────────
  // ─── SAFEGUARDS: MIDDLEWARE (v11.70) ──────────────────────────────────────

  // ─ Admin-only route guard ──────────────────────────────────────────────────
  // All /api/admin/* routes require the requester to be an active admin.
  // X-Agent-Id header is sent by the React client on every request.
  // Cron trigger routes are exempt (they run server-side with no session).
  const CRON_EXEMPT_PATHS = [
    "/api/admin/stale-lead-audit",
    "/api/admin/batchleads-run",
    "/api/admin/dbpr-run",
    "/api/admin/missed-appointments",
  ];
  app.use("/api/admin", (req: any, res: any, next: any) => {
    const fullPath = req.baseUrl + req.path;
    if (CRON_EXEMPT_PATHS.some(p => fullPath.startsWith(p))) return next();
    const agentId = parseInt(String(req.headers["x-agent-id"] || ""));
    if (!agentId || isNaN(agentId)) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const agent = storage.getAgentById(agentId);
    if (!agent || !agent.isActive || agent.role !== "admin") {
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

  app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
    const agent = storage.getAgentByEmail(email.toLowerCase().trim());
    if (!agent || agent.password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (!agent.isActive) {
      return res.status(403).json({ error: "Your account has been deactivated. Contact an admin." });
    }
    res.json({ agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role, headshotUrl: (agent as any).headshotUrl || (agent as any).headshot_url || null } });
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

  // POST /api/reset-password/:token — set new password
  app.post("/api/reset-password/:token", (req, res) => {
    const { token } = req.params;
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const agent = rawDb.prepare("SELECT id, setup_expires FROM agents WHERE setup_token = ?").get(token);
    if (!agent) return res.status(404).json({ error: "Invalid or expired reset link" });
    if (new Date(agent.setup_expires) < new Date()) return res.status(410).json({ error: "Link expired" });
    rawDb.prepare("UPDATE agents SET password = ?, setup_token = NULL, setup_expires = NULL WHERE id = ?")
      .run(password, agent.id);
    res.json({ success: true });
  });

  // Session validation — called on app load to verify stored user is still active
  app.get("/api/me/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Not found" });
    if (!agent.isActive) return res.status(403).json({ error: "Account deactivated" });
    res.json({ agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      phone: (agent as any).phone ?? "",
      brokerage: (agent as any).brokerage ?? "",
      homeAddress: (agent as any).home_address ?? "",
      headshotUrl: (agent as any).headshot_url ?? "",
    }});
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
    const updated = storage.updateAgent(id, patch);
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // ─── AGENT INVITATION ─────────────────────────────────────────────────────
  // POST /api/agents/invite — admin sends invite with just name + email
  app.post("/api/agents/invite", async (req, res) => {
    const { name, email, role: reqRole } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Name and email required" });
    const cleanEmail = email.toLowerCase().trim();
    // v12.5 — recruiter role is gone; only admin/agent supported.
    const assignedRole = ["admin", "agent"].includes(reqRole) ? reqRole : "agent";

    // Check duplicate
    const existing = rawDb.prepare("SELECT id FROM agents WHERE email = ?").get(cleanEmail);
    if (existing) return res.status(409).json({ error: "An agent with this email already exists" });

    // Create account with random temp password (they'll set their own)
    const tempPass = randomBytes(12).toString("hex");
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72h

    let agent: any;
    try {
      agent = storage.createAgent({
        name,
        email: cleanEmail,
        password: tempPass,
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
    `).run(password, phone ?? "", brokerage ?? "", homeAddress ?? "", headshotUrl ?? "", agent.id);

    res.json({ success: true, name: agent.name, email: agent.email });
  });


  // ─── HELPER: count agents currently able to receive leads ──────────────────
  function countLeadReceivers(excludeId?: number): number {
    const allAgents = storage.getAllAgents ? storage.getAllAgents() : [];
    return allAgents.filter((a: any) => {
      if (a.id === excludeId) return false;
      if (!a.isActive) return false;
      // Non-admin agent: must have leadFlowOn
      if (a.role === "agent") return a.leadFlowOn !== false;
      // Admin: must have receiveLeads=true AND leadFlowOn
      if (a.role === "admin") return a.receiveLeads && a.leadFlowOn !== false;
      return false;
    }).length;
  }

  // Soft-delete: mark agent as inactive, redistribute leads with correct rules per status
  app.delete("/api/agents/:id", (req, res) => {
    const id = parseInt(req.params.id);
    // Guard: must always have at least one lead receiver after deactivation
    const receiversAfter = countLeadReceivers(id);
    if (receiversAfter === 0) {
      return res.status(409).json({
        error: "Cannot deactivate — at least one agent must be able to receive leads at all times. Activate another agent first, or enable lead flow on an admin.",
      });
    }
    const updated = storage.updateAgent(id, { isActive: false, leadFlowOn: false });
    if (!updated) return res.status(404).json({ error: "Agent not found" });

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
        // Per user rule: callbacks immediately recycle on agent deactivation (no date/time hold)
        const nextCbAgent = storage.getNextAgentInRotation(lead.leadType);
        storage.createLeadActivity({
          leadId: lead.id,
          agentId: null,
          outcome: "recycled",
          notes: `Agent deactivated. Callback lead immediately recycled and reassigned from ${updated.name}.`,
          lpmamabSnapshot: null,
          createdAt: new Date().toISOString(),
        });
        if (nextCbAgent) {
          storage.updateLead(lead.id, { assignedAgentId: nextCbAgent.id, status: "assigned" });
          storage.updateRoundRobinState(nextCbAgent.id);
          reassigned++;
        } else {
          storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
        }
        callbackHeld++;
        continue;
      }

      // assigned / no_answer — redistribute immediately via round-robin
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
        storage.updateRoundRobinState(nextAgent.id);
        reassigned++;
      } else {
        storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
      }
    }

    broadcast({ type: "leads_updated" });
    broadcast({ type: "activity_event", event: { type: "agent_deactivated", agentId: id, agentName: updated.name, ts: new Date().toISOString() } });
    res.json({ ...updated, password: undefined, reassigned, callbackHeld, preserved });
  });

  // Reactivate a trashed agent
  app.patch("/api/agents/:id/reactivate", (req, res) => {
    const id = parseInt(req.params.id);
    // Only turn flow ON if agent has a headshot — no headshot = incomplete onboarding
    const existing = storage.getAgentById(id);
    const hasHeadshot = !!(existing as any)?.headshotUrl;
    const updated = storage.updateAgent(id, { isActive: true, leadFlowOn: hasHeadshot });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ...updated, password: undefined });
  });

  // ─── AGENT PROFILE SELF-SERVICE ──────────────────────────────────────────────

  // Update own profile (name, email, phone, brokerage, homeAddress, headshotUrl)
  app.patch("/api/agents/:id/profile", (req, res) => {
    const id = parseInt(req.params.id);
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

  // Change own password
  app.patch("/api/agents/:id/password", (req, res) => {
    const id = parseInt(req.params.id);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.password !== currentPassword) return res.status(401).json({ error: "Current password is incorrect" });
    const updated = storage.updateAgent(id, { password: newPassword });
    res.json({ ok: true });
  });

  // Upload headshot — accepts any image, server-side face-detect + smart crop to 400×400 JPEG
  app.post("/api/agents/:id/headshot", async (req: any, res: any) => {
    const id = parseInt(req.params.id);
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
  app.delete("/api/agents/:id/self", (req, res) => {
    const id = parseInt(req.params.id);
    const { password } = req.body;
    const agent = storage.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.password !== password) return res.status(401).json({ error: "Password incorrect" });
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
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
        storage.updateRoundRobinState(nextAgent.id);
      } else {
        storage.updateLead(lead.id, { assignedAgentId: null, status: "unassigned" });
      }
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
      const SKIP = ["contacted_not_interested", "contacted_appointment", "keep_in_touch", "callback_requested", "wrong_number"];
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
          const nextAgent = storage.getNextAgentInRotation(lead.leadType);
          if (nextAgent) {
            storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
            storage.updateRoundRobinState(nextAgent.id);
            reassigned++;
          } else {
            skipped++;
          }
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
  // Rule: at least one receiver must remain at all times.
  // Admins are the final fallback — they can only turn off lead flow if a non-admin agent is active with flow on.
  app.patch("/api/agents/:id/lead-flow", (req, res) => {
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
    const agentCount = allA.filter((a: any) => a.isActive && a.leadFlowOn !== false && (a.role === "agent" || (a.role === "admin" && a.receiveLeads))).length;

    // Always start unassigned — assignment happens after creation to avoid assigned+null state
    const [created] = storage.createLeadsFromBatch([{
      leadType: "website_lead",
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

    if (agentCount > 0) {
      const nextAgent = storage.getNextAgentInRotation("website_lead");
      if (nextAgent) {
        storage.updateLead(created.id, { assignedAgentId: nextAgent.id, status: "assigned" });
        storage.updateRoundRobinState(nextAgent.id);
      }
      // If no website_lead-eligible agent found, lead stays unassigned (correct)
    }

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

  app.get("/api/leads/map", async (req, res) => {
    // SQL: only fetch location columns needed for map — avoids full lead deserialization (v11.70)
    const all: any[] = rawDb.prepare(
      `SELECT id, address, owner_name as ownerName, status, lead_type as leadType,
              city, state, zip, extra_data as extraData
       FROM leads ORDER BY uploaded_at DESC`
    ).all();

    // Parse address components from each lead
    const mapLeads = all.map((l: any) => {
      // Use dedicated columns first (BatchLeads leads), fall back to extraData, then address parsing
      let city = (l as any).city || ""; let state = (l as any).state || "FL"; let zip = (l as any).zip || "";
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
    });

    // Check cache for each lead, collect uncached ones
    const uncached: { id: number; addr: string; street: string; city: string; state: string; zip: string }[] = [];
    const coordMap = new Map<number, { lat: number; lng: number }>();
    for (const l of mapLeads) {
      const key = geoKey(l.fullAddr);
      const cached = getCached(key);
      if (cached) { coordMap.set(l.id, cached); }
      else if (l.address) {
        // street = first part of address before any comma
        const street = l.address.split(",")[0].trim();
        uncached.push({ id: l.id, addr: l.fullAddr, street, city: l.city, state: l.state, zip: l.zip });
      }
    }

    // Geocode uncached addresses in batches of 1000 (Census limit)
    if (uncached.length > 0) {
      const BATCH = 1000;
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH);
        const batchResults = await censusGeocodeAddresses(batch);
        for (const [id, coords] of batchResults) {
          coordMap.set(id, coords);
          const lead = mapLeads.find(l => l.id === id);
          if (lead) putCache(geoKey(lead.fullAddr), coords.lat, coords.lng);
        }
      }
    }

    // Build final response — only include leads with coords
    const result = mapLeads
      .map(l => ({ ...l, ...(coordMap.get(l.id) ?? {}) }))
      .filter((l: any) => l.lat !== undefined);

    res.json(result);
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

  // ─── v13.8 POOL-SERVING ENDPOINTS ─────────────────────────────────────────
  // GET /api/leads/next?type=expired|fsbo|land|absentee&agentId=<id>
  //   Serves the next unclaimed lead FIFO for a given type. Creates a 60-minute
  //   lock in lead_locks so no other agent gets the same lead. Ignores leads that
  //   are already locked and not yet expired.
  //
  // POST /api/leads/:id/release  { agentId }
  //   Releases the lock (agent bailed out without an outcome). Anyone can pick it
  //   up again immediately.
  //
  // Callback/round-robin/territory logic is intentionally NOT invoked here —
  // v13.8 has no assignment. Leads only leave the pool via a terminal outcome.

  app.get("/api/leads/next", (req, res) => {
    const type = String(req.query.type || "").toLowerCase();
    const agentId = parseInt(String(req.query.agentId || ""));
    if (!agentId || isNaN(agentId)) {
      return res.status(400).json({ error: "Missing agentId" });
    }
    if (!type || !["expired", "fsbo", "land", "absentee"].includes(type)) {
      return res.status(400).json({ error: "type must be expired|fsbo|land|absentee" });
    }

    // Housekeeping: sweep expired locks before serving so stale leads come back.
    rawDb.prepare(`DELETE FROM lead_locks WHERE expires_at < datetime('now')`).run();

    // Optional: return the lead this agent already has locked (idempotent Load).
    const existing: any = rawDb.prepare(`
      SELECT l.* FROM leads l
      JOIN lead_locks lk ON lk.lead_id = l.id
      WHERE lk.agent_id = ? AND l.lead_type = ?
      LIMIT 1
    `).get(agentId, type);
    if (existing) {
      return res.json({ lead: existing, alreadyLocked: true });
    }

    // FIFO by uploaded_at ascending, priority-score tiebreak (higher first).
    // Filter out leads currently locked by another agent.
    const next: any = rawDb.prepare(`
      SELECT l.* FROM leads l
      LEFT JOIN lead_locks lk ON lk.lead_id = l.id
      WHERE l.lead_type = ?
        AND l.status = 'unassigned'
        AND lk.lead_id IS NULL
      ORDER BY l.score DESC, l.uploaded_at ASC, l.id ASC
      LIMIT 1
    `).get(type);

    if (!next) return res.status(204).end();

    // Create a 60-minute lock. Use INSERT OR REPLACE in case a stale row survives.
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000);
    rawDb.prepare(`
      INSERT OR REPLACE INTO lead_locks (lead_id, agent_id, locked_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(next.id, agentId, now.toISOString(), expires.toISOString());

    res.json({ lead: next, alreadyLocked: false, lockExpiresAt: expires.toISOString() });
  });

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

  // Admin view of active locks (used by MapView + AdminDashboard tomorrow).
  app.get("/api/leads/locks", (_req, res) => {
    const rows = rawDb.prepare(`
      SELECT lk.lead_id, lk.agent_id, lk.locked_at, lk.expires_at,
             a.name as agent_name, l.owner_name, l.lead_type
      FROM lead_locks lk
      JOIN agents a ON a.id = lk.agent_id
      JOIN leads l  ON l.id = lk.lead_id
      WHERE lk.expires_at > datetime('now')
      ORDER BY lk.locked_at DESC
    `).all();
    res.json(rows);
  });

  // Pool counts for the Work Leads landing page (3 buttons need per-type counts).
  app.get("/api/leads/pool-counts", (_req, res) => {
    const rows: any[] = rawDb.prepare(`
      SELECT lead_type, COUNT(*) as n FROM leads
      WHERE status = 'unassigned' AND id NOT IN (
        SELECT lead_id FROM lead_locks WHERE expires_at > datetime('now')
      )
      GROUP BY lead_type
    `).all();
    const counts: Record<string, number> = { expired: 0, fsbo: 0, land: 0 };
    for (const r of rows) {
      if (r.lead_type in counts) counts[r.lead_type] = r.n;
    }
    res.json(counts);
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
    const VALID_LEAD_TYPES = ["expired", "fsbo", "pre_foreclosure", "distressed", "vacant", "land", "website_lead", "network", "other"];
    if (!VALID_LEAD_TYPES.includes(leadType)) {
      return res.status(400).json({ error: `Unknown lead type: ${leadType}` });
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
          status: agentCount > 0 ? "assigned" : "unassigned",
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

    // Auto assign via territory-aware round robin if agents exist
    if (agentCount > 0) {
      for (const lead of created) {
        const nextAgent = storage.getNextAgentInRotation(leadType, (lead as any).territory || null);
        if (nextAgent) {
          storage.updateLead(lead.id, { assignedAgentId: nextAgent.id, status: "assigned" });
          storage.updateRoundRobinState(nextAgent.id);
        }
      }
    }

    broadcast({ type: "activity_event", event: { type: "csv_uploaded", agentId: uploadedBy || null, agentName: "Admin", count: created.length, leadType, ts: new Date().toISOString() } });
    res.json({ created: created.length, disqualified, batchId });
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
            apptEmail, confirmedAddress, apptDate, apptTime, stage, intention } = req.body;

    // Whitelist valid outcomes — prevents garbage data from getting into the activity log
    const VALID_OUTCOMES = [
      "no_answer", "contacted_appointment", "keep_in_touch", "callback_requested",
      "contacted_not_interested", "wrong_number", "email_sent", "network_referral",
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
      newStatus = outcome;

    } else if (outcome === "no_answer") {
      // Mark the current phone as sleeping for today
      const currentPhone = req.body.dialedPhone || lead.phone || "";
      if (currentPhone && newPhoneStates[currentPhone] !== undefined) {
        newPhoneStates[currentPhone] = "no_answer_today";
      }
      // Check if there's another untried number to try today
      const nextPhone = getNextViablePhone(newPhoneStates, newPhones);
      if (nextPhone) {
        // Still has untried numbers — stay with same agent, update active phone
        newStatus = "no_answer";
        // Shift nextPhone to front so agent sees it next
        newPhones = [nextPhone, ...newPhones.filter(p => p !== nextPhone)];
        rawDb.prepare("UPDATE leads SET phone = ? WHERE id = ?").run(nextPhone, leadId);
      } else {
        // All numbers tried today — recycle to pool for tomorrow
        newStatus = "no_answer";
        const nextAgent = storage.getNextAgentInRotation(lead.leadType);
        if (nextAgent) {
          newAssignedId = nextAgent.id;
          storage.updateRoundRobinState(nextAgent.id);
        }
      }

    } else if (outcome === "keep_in_touch") {
      // KIT = connected, not ready now. FUB owns the long-term follow-up from here.
      // Lead exits the active Lead Depot queue — same as Appointment.
      newStatus = "keep_in_touch";
      newAssignedId = null; // unassign from agent — FUB takes over follow-up

    } else if (outcome === "callback_requested") {
      // Schedule callback — keep with same agent, store the requested date/time.
      // The nightly redistribution (8am EDT) fires due callbacks to the next
      // available agent if this agent is inactive, or leaves it with them if active.
      newStatus = "callback_requested";
      // Use the date provided by the UI; fall back to keeping the existing date if none
      newCallbackDate = callbackDate || lead.callbackDate || null;
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

    // Wrong number: strike this number; delete lead only if it was the last one
    if (outcome === "wrong_number") {
      const dialedPhone = req.body.dialedPhone || lead.phone || "";
      const phones: string[] = lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []);
      const phoneStates: Record<string, string> = lead.phoneStates ? JSON.parse(lead.phoneStates) : {};

      // Permanently strike this number
      if (dialedPhone) phoneStates[dialedPhone] = "struck";

      // Find remaining viable numbers (not struck)
      const remaining = phones.filter(p => phoneStates[p] !== "struck");

      // Log the activity
      rawDb.prepare(`
        INSERT INTO lead_activity (lead_id, agent_id, outcome, notes, lpmamab_snapshot, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(leadId, agentId || null, outcome,
        notes || (dialedPhone ? `Wrong number: ${dialedPhone} struck from list. ${remaining.length} number(s) remaining.` : null),
        new Date().toISOString());

      if (remaining.length === 0) {
        // All numbers confirmed bad — award points first, then delete lead + its history
        awardPoints(agentId, "wrong_number", leadId);
        rawDb.prepare(`DELETE FROM lead_activity WHERE lead_id = ?`).run(leadId);
        storage.deleteLead(leadId);
        broadcast({ type: "lead_deleted", leadId });
        return res.json({ deleted: true, leadId, reason: "all_numbers_struck" });
      }

      // Still has viable numbers — advance to next untried, recycle in pool
      const nextViable = remaining.find(p => phoneStates[p] === "untried") ?? remaining[0];
      const reorderedPhones = [nextViable, ...phones.filter(p => p !== nextViable)];
      // Update phone fields only — agent assignment handled exclusively by round-robin below
      rawDb.prepare(`UPDATE leads SET phone = ?, phones = ?, phone_states = ?, status = 'no_answer' WHERE id = ?`).run(
        nextViable,
        JSON.stringify(reorderedPhones),
        JSON.stringify(phoneStates),
        leadId
      );
      // Round-robin assign to next eligible agent
      const nextAgent = storage.getNextAgentInRotation(lead.leadType);
      if (nextAgent) {
        storage.updateLead(leadId, { assignedAgentId: nextAgent.id });
        storage.updateRoundRobinState(nextAgent.id);
      } else {
        storage.updateLead(leadId, { assignedAgentId: null, status: "unassigned" });
      }
      awardPoints(agentId, "wrong_number", leadId);
      broadcast({ type: "activity_event", event: { type: "wrong_number", agentId, leadId, agentName: storage.getAgentById(agentId)?.name || "Agent", address: lead.address } });
      broadcast({ type: "lead_updated", leadId });
      return res.json({ updated: true, leadId, nextPhone: nextViable, remaining: remaining.length });
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
    const row: any = rawDb.prepare(
      `SELECT COUNT(*) as n FROM leads WHERE assigned_agent_id = ? AND status IN ('assigned','no_answer','callback_requested')`
    ).get(agentId);
    res.json({ count: row?.n ?? 0 });
  });

  // ─── MY PIPELINE (callbacks + KIT, 60-day window) ────────────────────────
  app.get("/api/leads/my-pipeline/:agentId", (req, res) => {
    const agentId = parseInt(req.params.agentId);
    if (!agentId || isNaN(agentId)) return res.status(400).json({ error: "Missing agentId" });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString();

    // Fetch only the matching leads via SQL (avoids loading all leads into memory)
    const myLeadRows: any[] = rawDb.prepare(
      `SELECT * FROM leads WHERE assigned_agent_id = ? AND status IN ('callback_requested','keep_in_touch','contacted_appointment') AND uploaded_at >= ?`
    ).all(agentId, cutoffStr);

    // Enrich with last activity notes using aggregation query
    const leadIds = myLeadRows.map((r: any) => r.id);
    const actRows: any[] = leadIds.length > 0
      ? rawDb.prepare(
          `SELECT lead_id,
            MAX(CASE WHEN outcome != 'email_sent' THEN notes ELSE NULL END) as last_note,
            SUM(CASE WHEN outcome != 'email_sent' THEN 1 ELSE 0 END) as activity_count,
            SUM(CASE WHEN outcome = 'email_sent' THEN 1 ELSE 0 END) as email_count
           FROM lead_activity WHERE lead_id IN (${leadIds.map(() => "?").join(",")})
           GROUP BY lead_id`
        ).all(...leadIds)
      : [];
    const actMap: Record<number, any> = {};
    for (const r of actRows) actMap[r.lead_id] = r;

    const enriched = myLeadRows.map((r: any) => ({
      id: r.id, ownerName: r.owner_name, address: r.address, phone: r.phone,
      leadType: r.lead_type, status: r.status, attemptCount: r.attempt_count,
      callbackDate: r.callback_date, score: r.score ?? 0,
      territory: r.territory ?? null, uploadedAt: r.uploaded_at,
      assignedAgentId: r.assigned_agent_id,
      lastNote: actMap[r.id]?.last_note || null,
      activityCount: actMap[r.id]?.activity_count ?? 0,
      emailCount: actMap[r.id]?.email_count ?? 0,
    }));

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
    const txn = rawDb.transaction(() => {
      // Delete seller data ONLY.
      rawDb.prepare(`DELETE FROM lead_activity`).run();
      rawDb.prepare(`DELETE FROM leads`).run();
      rawDb.prepare(`DELETE FROM agent_points WHERE scope = 'seller'`).run();
      // Close all territories, clear all agents' territory slots, and flag them.
      rawDb.prepare(`UPDATE territories SET is_open = 0`).run();
      rawDb.prepare(`UPDATE agents SET territory1 = NULL, territory2 = NULL, territory_closed_notice = 1`).run();
      // Reset the seller leaderboard period marker.
      rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(new Date().toISOString());
    });
    txn();
    res.json({ ok: true, side: "seller" });
  });

  app.post("/api/admin/recruiting-hard-reset", (req: any, res) => {
    if (req.body?.confirm !== "RESET") {
      return res.status(400).json({ error: 'Must send { "confirm": "RESET" } in body' });
    }
    const txn = rawDb.transaction(() => {
      // Delete recruiting data ONLY.
      rawDb.prepare(`DELETE FROM agent_lead_activity`).run();
      rawDb.prepare(`DELETE FROM agent_leads`).run();
      rawDb.prepare(`DELETE FROM agent_points WHERE scope = 'recruiting'`).run();
      // Reset the recruiting leaderboard period marker.
      rawDb.prepare(`INSERT INTO settings (key, value) VALUES ('leaderboard_reset_at_recruiting', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(new Date().toISOString());
    });
    txn();
    res.json({ ok: true, side: "recruiting" });
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

    const stats = allAgents.map(agent => {
      const r = agentStatsMap[agent.id] || { total_all: 0, emails_sent: 0, appts: 0, no_answer: 0, kit: 0, not_int: 0 };
      const total = (r.total_all || 0) - (r.emails_sent || 0);
      const contacted = (r.appts || 0) + (r.not_int || 0);
      return {
        agent: { id: agent.id, name: agent.name, email: agent.email },
        appointmentsSet: r.appts || 0,
        totalAttempts: total,
        emailsSent: r.emails_sent || 0,
        contactRate: total > 0 ? Math.round((contacted / total) * 100) : 0,
        outcomes: {
          contacted_appointment: r.appts || 0,
          no_answer: r.no_answer || 0,
          keep_in_touch: r.kit || 0,
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
        to:   ["Denise@watsonbrothersgroup.com"],
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
    Lead Depot v11.77 \u2014 Brothers Group \u00b7 Momentum Realty
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

  // ─── AGENT INACTIVITY SAFETY NET (v12.0) ───────────────────────────────────
  app.get("/api/admin/agent-inactivity", (req: any, res) => {
    const weeksThreshold = parseInt(String(req.query.weeks || "2"));
    const activeAgents = rawDb.prepare(`SELECT * FROM agents WHERE is_active = 1`).all() as any[];
    const flagged: any[] = [];

    for (const agent of activeAgents) {
      const minDials = (agent as any).min_dials_per_week ?? 0;
      if (minDials === 0) continue;

      let consecutiveMissed = 0;
      for (let w = 1; w <= weeksThreshold; w++) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay() - (w - 1) * 7);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
        // v12.5 — gate on seller-side dials only; recruiting activity is a separate program
        const cnt = (rawDb.prepare(
          `SELECT COUNT(*) as c FROM agent_points WHERE agent_id = ? AND reason = 'dial' AND scope = 'seller' AND created_at >= ? AND created_at < ?`
        ).get(agent.id, weekStart.toISOString(), weekEnd.toISOString()) as any)?.c ?? 0;
        if (cnt < minDials) consecutiveMissed++; else break;
      }

      if (consecutiveMissed >= weeksThreshold) {
        const thisWeekStart = new Date();
        thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
        thisWeekStart.setHours(0, 0, 0, 0);
        const thisWeekDials = (rawDb.prepare(
          `SELECT COUNT(*) as c FROM agent_points WHERE agent_id = ? AND reason = 'dial' AND scope = 'seller' AND created_at >= ?`
        ).get(agent.id, thisWeekStart.toISOString()) as any)?.c ?? 0;
        flagged.push({
          id: agent.id,
          name: agent.name,
          email: agent.email,
          minDialsPerWeek: minDials,
          consecutiveWeeksMissed: consecutiveMissed,
          thisWeekDials,
          headshotUrl: (agent as any).headshot_url || null,
        });
      }
    }

    res.json({ flagged, count: flagged.length });
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

    // 5. BatchLeads API
    const blKey = process.env.BATCHLEADS_API_KEY;
    if (blKey) {
      try {
        const start = Date.now();
        const blRes = await fetch("https://app.batchleads.io/api/v1/lists?page=1&per_page=1", {
          headers: { "api-key": blKey },
          signal: AbortSignal.timeout(6000),
        });
        results.batchleads = {
          ok: blRes.ok,
          latencyMs: Date.now() - start,
          detail: blRes.ok ? "Connected" : `HTTP ${blRes.status}`,
        };
      } catch (e: any) {
        results.batchleads = { ok: false, detail: e.message };
      }
    } else {
      results.batchleads = { ok: false, detail: "BATCHLEADS_API_KEY not set in Railway env" };
    }

    // 6. WebSocket server
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
      version: "v13.8.3",
      services: results,
    });
  });

  // Simple ping for uptime checks
  app.get("/api/ping", (_req, res) => res.json({ pong: true, ts: Date.now() }));



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
      "clay county": "Clay County",
      "clay": "Clay County",
      "orange park": "Clay County",
      "fleming island": "Clay County",
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

    // ─── BATCHLEADS PIPELINE TRIGGER ──────────────────────────────────────────────
  // Called by daily 6am cron. Also callable manually by admins.
  // Pulls leads saved to BatchLeads lists, scrubs, scores, and distributes.
  app.post("/api/admin/batchleads-run",
    (req: any, res: any, next: any) => pipelineGuard("batchleads", req, res, next),
    async (req: any, res) => {
    try {
      console.log("[BatchLeads] Manual/cron trigger received");
      const stats = await runBatchLeadsPipeline(rawDb);

      // After insert, trigger round-robin distribution for new unassigned leads.
      // NOTE: leads table has uploaded_at (not created_at) — historical column name.
      const newLeads = rawDb.prepare(
        `SELECT * FROM leads WHERE status = 'unassigned' AND source = 'batchleads' AND uploaded_at > datetime('now', '-1 hour')`
      ).all() as any[];

      let assigned = 0;
      for (const lead of newLeads) {
        try {
          const nextAgent = storage.getNextAgentInRotation(lead.lead_type, lead.territory || null);
          if (nextAgent) {
            storage.updateLead(lead.id, { status: "assigned", assignedAgentId: nextAgent.id });
            storage.updateRoundRobinState(nextAgent.id);
            assigned++;
          }
        } catch (e) {
          // skip — will be redistributed by stale lead cron
        }
      }

      res.json({
        ok: true,
        ...stats,
        assigned,
        message: `BatchLeads pipeline complete. ${stats.priority + stats.standard} leads inserted, ${assigned} assigned via round-robin.`,
      });
    } catch (err: any) {
      console.error("[BatchLeads] Pipeline error:", err);
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

      // 3) Round-robin assign — use the same rotation logic as new-lead ingestion.
      //    Fetches next agent per lead based on leadType + territory, honors
      //    territory1/territory2, dial-gates, and admin receiveLeads flag.
      let assigned = 0;
      for (const r of retired) {
        const nextAgent = storage.getNextAgentInRotation(r.leadType, r.territory);
        if (nextAgent) {
          storage.updateLead(r.id, { assignedAgentId: nextAgent.id, status: "assigned" });
          storage.updateRoundRobinState(nextAgent.id);
          assigned++;
        }
      }

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
  const redistributedActs = activities.filter((a: any) => a.outcome === "recycled" && a.agent_id === null);
  const redistributedSection = redistributedActs.length > 0 ? `
    <div style="padding:20px 24px 0">
      <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);font-weight:700;margin-bottom:10px">Redistributed Leads (${redistributedActs.length})</div>
      <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border-radius:8px;overflow:hidden">
        <tbody>${redistributedActs.map((act: any) => {
          const lead = allLeadsRaw.find((l: any) => l.id === act.lead_id);
          const newAgent = lead?.assigned_agent_id ? agentNameMap[lead.assigned_agent_id] : "Unassigned";
          const name = lead ? (lead.owner_name || `${lead.first_name || ""} ${lead.last_name || ""}`.trim()) : "Unknown";
          return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:10px 14px;vertical-align:top">
              <div style="font-size:13px;font-weight:600;color:#f0f0f0">${name}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px">${lead?.phone || "—"} · ${lead?.address || "—"}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;font-style:italic">${act.notes || ""}</div>
            </td>
            <td style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.5);white-space:nowrap;vertical-align:top">Now: ${newAgent}</td>
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

  <!-- Redistributed -->
  ${redistributedSection}

  <!-- Unassigned warning -->
  ${unassignedSection}

  <!-- Footer -->
  <div style="padding:16px 24px;margin-top:24px;background:#080808;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:rgba(255,255,255,0.18);display:flex;justify-content:space-between">
    <span>Lead Depot v11.77</span><span>Brothers Group · Momentum Realty</span>
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
// ─── CALLBACK REDISTRIBUTION ─────────────────────────────────────────────────
// Runs daily: finds callbacks due today whose agent is inactive, reassigns to an
// active agent with a clear handoff note so they have full context immediately.
async function redistributeDueCallbacks() {
  const todayStr = new Date().toISOString().slice(0, 10);

  // SQL: only fetch callback leads due today — avoids loading all leads (v11.70)
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

    if (assignedAgent && assignedAgent.isActive && assignedAgent.leadFlowOn !== false) {
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
    const nextAgent = storage.getNextAgentInRotation(lead.leadType);
    if (!nextAgent) continue;

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

// Run immediately on startup to clear any leads that accumulated overnight / on redeploy
redistributeUnassignedLeads().catch((err) =>
  console.error("[redistribution] Startup error:", err)
);

// Schedule daily 8am EDT run
scheduleRedistribution();

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
