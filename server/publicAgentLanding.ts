// ─── PUBLIC PER-AGENT "GET IN TOUCH" LANDING PAGE ──────────────────────────
// v20.35.0 — New feature: each active agent gets their own public, no-login
// lead-capture page at /get-in-touch/:agentId (agentId = numeric agents.id,
// so it's stable even if an agent's name/slug changes and needs no mapping
// table). This is the digital destination for that agent's QR code on yard
// signs / open house signs / business cards.
//
// On submit we create a real Lead Depot lead (leadType "network" so it shows
// up in the agent's existing Network tab with no new UI needed), assigned
// directly to the agent whose page/QR code the lead came through — matching
// the exact same pattern as the agent-submitted Network Referral flow in
// routes.ts (/api/leads/network), pushed to FUB, and both the agent + admins
// (Alex/Nate) get notified immediately. If the QR'd agent has since gone
// inactive we still capture the lead (unassigned, admins notified) instead
// of losing it or erroring out on the visitor.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { Resend } from "resend";
import { broadcast } from "./ws";
import { pushIngestToFub } from "./fub";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = "The Brothers Group Real Estate Team <noreply@watsonbrothersgroup.com>";
const ADMIN_NOTIFY = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"];

const ALLOWED_INTERESTS = new Set(["selling", "buying", "both", "not_sure"]);
const INTEREST_LABEL: Record<string, string> = {
  selling: "Thinking About Selling",
  buying: "Thinking About Buying",
  both: "Buying & Selling",
  not_sure: "Not Sure Yet",
};

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

export function registerPublicAgentLandingRoutes(app: Express) {
  // ── GET /api/public/agents/:id — public, no auth. Safe fields only. ──
  app.get("/api/public/agents/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (!id) return res.status(404).json({ ok: false, error: "not_found" });
    const agent = storage.getAgentById(id);
    if (!agent || !agent.isActive) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    const nameParts = String(agent.name || "").trim().split(/\s+/);
    res.json({
      ok: true,
      agent: {
        id: agent.id,
        name: agent.name,
        firstName: nameParts[0] || agent.name,
        phone: agent.publishedPhone || agent.phone || "",
        headshotUrl: agent.headshotUrl || "",
      },
    });
  });

  // ── POST /api/public/get-in-touch — public, no auth ──
  app.post("/api/public/get-in-touch", async (req: Request, res: Response) => {
    try {
      // Honeypot — silently accept bots without processing.
      if (req.body?.website) return res.json({ ok: true });

      const agentId = req.body?.agentId ? parseInt(String(req.body.agentId), 10) : null;
      const name = String(req.body?.name || "").trim();
      const phone = String(req.body?.phone || "").trim();
      const email = String(req.body?.email || "").trim();
      const rawInterest = String(req.body?.interest || "").trim();
      const interest = ALLOWED_INTERESTS.has(rawInterest) ? rawInterest : "not_sure";
      const message = String(req.body?.message || "").trim();

      if (!name || phone.replace(/\D/g, "").length < 10) {
        return res.status(400).json({
          ok: false,
          error: "Please enter your name and a valid phone number.",
        });
      }

      const agent = agentId ? storage.getAgentById(agentId) : null;
      const assignedAgent = agent && agent.isActive ? agent : null;
      const assignedAgentId = assignedAgent ? assignedAgent.id : null;
      const agentName = assignedAgent?.name || null;

      const now = new Date().toISOString();
      const extraData = JSON.stringify({
        source: "website",
        warmLeadSource: "website",
        intakeChannel: "get_in_touch_landing_page",
        interest,
        landingAgentId: agentId || null,
        landingAgentName: agentName,
        landingAgentRequestedButInactive: !!(agentId && !assignedAgent),
        networkNotes: message || "",
        ingestedAt: now,
      });

      const [created] = storage.createLeadsFromBatch([{
        leadType: "network",
        address: "",
        ownerName: name,
        phone,
        email: email || "",
        motivation: message || "",
        extraData,
        source: "website",
        status: assignedAgentId ? "assigned" : "unassigned",
        assignedAgentId,
        attemptCount: 0,
        uploadedAt: now,
        uploadedBy: assignedAgentId,
        batchId: `website_${Date.now()}`,
      } as any]);

      broadcast({ type: "lead_created", leadId: created.id, assignedAgentId });
      broadcast({
        type: "activity_event",
        event: {
          type: "warm_lead_submitted",
          source: "website",
          intent: interest,
          agentId: assignedAgentId,
          agentName: agentName || "Unassigned",
          agentHeadshot: (assignedAgent as any)?.headshotUrl || null,
          address: "",
          ts: now,
        },
      });

      pushIngestToFub({
        ownerName: name,
        phone,
        email: email || undefined,
        agentId: assignedAgentId,
        agentName: agentName || undefined,
        source: "website",
        intent: interest === "selling" ? "seller" : interest === "buying" ? "buyer" : interest === "both" ? "seller_and_buyer" : null,
        notes: message || undefined,
      }).catch((err) => console.error("[FUB] pushIngestToFub (get-in-touch) failed:", err));

      // ── Notify the assigned agent + admins immediately ──
      if (resend) {
        const toList = assignedAgent?.email
          ? Array.from(new Set([assignedAgent.email, ...ADMIN_NOTIFY]))
          : ADMIN_NOTIFY;
        const interestLabel = INTEREST_LABEL[interest] || "Get In Touch";
        resend.emails.send({
          from: FROM,
          to: toList,
          replyTo: email || undefined,
          subject: `New Lead — ${name}${agentName ? ` (via ${agentName}'s page)` : " (unassigned)"}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
              <h2 style="color:#080808;">New "Get In Touch" Lead${agentName ? ` — ${escapeHtml(agentName)}'s Page` : ""}</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px 0;color:#666;width:140px;">Name</td><td style="padding:6px 0;"><strong>${escapeHtml(name)}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;">${escapeHtml(phone)}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;">${email ? escapeHtml(email) : "—"}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Interested In</td><td style="padding:6px 0;">${escapeHtml(interestLabel)}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Message</td><td style="padding:6px 0;">${message ? escapeHtml(message) : "—"}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Assigned To</td><td style="padding:6px 0;">${agentName ? escapeHtml(agentName) : "Unassigned — landing page agent was inactive"}</td></tr>
              </table>
              <p style="margin-top:16px;font-size:12px;color:#999;">Lead #${created.id} — submitted via depot.watsonbrothersgroup.com/get-in-touch${agentId ? `/${agentId}` : ""}</p>
            </div>
          `,
        }).catch((err) => console.error("[get-in-touch] notify email error:", err));

        if (email) {
          const displayAgentName = agentName || "Our team";
          const displayPhone = assignedAgent?.publishedPhone || assignedAgent?.phone || "(904) 867-3984";
          resend.emails.send({
            from: FROM,
            to: email,
            subject: `Thanks, ${name.split(" ")[0]} — we've got your info`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
                <h2 style="color:#080808;">Thanks, ${escapeHtml(name.split(" ")[0])} — we've got it.</h2>
                <p style="color:#333;line-height:1.6;">${escapeHtml(displayAgentName)} will reach out to you at ${escapeHtml(phone)} shortly to talk through what you're looking to do.</p>
                <p style="color:#333;line-height:1.6;">Need us sooner? Call <a href="tel:${displayPhone.replace(/\D/g, "")}" style="color:#a8893a;">${escapeHtml(displayPhone)}</a>.</p>
                <p style="margin-top:24px;color:#999;font-size:12px;">Brothers Group at Momentum Realty</p>
              </div>
            `,
          }).catch((err) => console.error("[get-in-touch] confirmation email error:", err));
        }
      }

      console.log(`[get-in-touch] New lead #${created.id}: ${name} — agent ${agentName || "unassigned"}`);
      res.json({
        ok: true,
        leadId: created.id,
        agentName,
        agentPhone: assignedAgent?.publishedPhone || assignedAgent?.phone || "",
      });
    } catch (err) {
      console.error("[get-in-touch] error:", err);
      res.status(500).json({ ok: false, error: "Something went wrong. Please call us instead." });
    }
  });
}
