// ─── BGHS PUBLIC WEB APP ────────────────────────────────────────────────────
// v20.34.0 — Item 25: public-facing quote-request app for Brothers Group
// Home Solutions, LLC. Distinct from the internal agent-facing Repair
// Consult / Inspections+ tools (repairConsult.ts, inspections.ts) which
// price out work during an active listing/inspection. This is the front
// door for a homeowner who is NOT already a Lead Depot lead — they land on
// /home-solutions (no login), pick a category, describe the job, and submit.
// We store the request, email Alex + Nate immediately, and confirm to the
// homeowner. No pricing is ever shown publicly — that stays admin/agent-side
// in the repair_items catalog (repairConsult.ts) so we never expose internal
// cost structure to the public.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { Resend } from "resend";
import { requireAdmin } from "./auth";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = "Brothers Group Home Solutions <noreply@watsonbrothersgroup.com>";
const NOTIFY_TO = ["nate@watsonbrothersgroup.com", "alex@watsonbrothersgroup.com"];

rawDb.prepare(`
  CREATE TABLE IF NOT EXISTS bghs_quote_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    service_address TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    source TEXT NOT NULL DEFAULT 'home-solutions-web',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

// Curated, homeowner-friendly categories. Each maps to the closest internal
// repair_items trade(s) purely for our own routing context in the
// notification email — the public never sees trade keys or pricing.
const PUBLIC_CATEGORIES: { value: string; label: string }[] = [
  { value: "bathroom", label: "Bathroom Repair / Update" },
  { value: "kitchen", label: "Kitchen Repair / Update" },
  { value: "laundry", label: "Laundry Room Repair" },
  { value: "appliance", label: "Appliance Purchase, Delivery & Install" },
  { value: "handyman", label: "General Handyman / Small Repairs" },
  { value: "painting", label: "Painting (Interior or Exterior)" },
  { value: "flooring", label: "Flooring (LVP, Carpet, Tile)" },
  { value: "electrical", label: "Electrical" },
  { value: "plumbing", label: "Plumbing" },
  { value: "hvac", label: "HVAC" },
  { value: "water_heater", label: "Water Heater" },
  { value: "pressure_washing", label: "Pressure Washing" },
  { value: "landscaping", label: "Landscaping / Lawn" },
  { value: "cleaning", label: "House Cleaning" },
  { value: "junk_removal", label: "Junk Removal" },
  { value: "windows_doors", label: "Windows, Doors & Garage Doors" },
  { value: "roofing", label: "Roofing" },
  { value: "other", label: "Something Else / Not Sure" },
];

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

export function registerBghsPublicRoutes(app: Express) {
  // ── GET /api/bghs/categories — public, no auth ──
  app.get("/api/bghs/categories", (_req: Request, res: Response) => {
    res.json({ categories: PUBLIC_CATEGORIES });
  });

  // ── POST /api/bghs/quote-request — public, no auth ──
  app.post("/api/bghs/quote-request", async (req: Request, res: Response) => {
    try {
      // Honeypot — silently accept bots without processing.
      if (req.body?.website) return res.json({ ok: true });

      const name = String(req.body?.name || "").trim();
      const phone = String(req.body?.phone || "").trim();
      const email = String(req.body?.email || "").trim();
      const serviceAddress = String(req.body?.serviceAddress || "").trim();
      const category = String(req.body?.category || "").trim();
      const description = String(req.body?.description || "").trim();

      if (!name || !phone || !serviceAddress || !category || !description) {
        return res.status(400).json({
          ok: false,
          error: "Name, phone, service address, category, and a short description are required.",
        });
      }

      const categoryLabel = PUBLIC_CATEGORIES.find((c) => c.value === category)?.label || category;

      const insert = rawDb.prepare(`
        INSERT INTO bghs_quote_requests (name, phone, email, service_address, category, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = insert.run(name, phone, email || null, serviceAddress, category, description);
      const requestId = result.lastInsertRowid;

      // Notify Nate + Alex immediately. Fire-and-forget — do not block the
      // homeowner's response on email delivery.
      if (resend) {
        resend.emails.send({
          from: FROM,
          to: NOTIFY_TO,
          replyTo: email || undefined,
          subject: `New Home Solutions Quote Request — ${name} (${categoryLabel})`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
              <h2 style="color:#080808;">New Quote Request — Brothers Group Home Solutions</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px 0;color:#666;width:140px;">Name</td><td style="padding:6px 0;"><strong>${escapeHtml(name)}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;">${escapeHtml(phone)}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;">${email ? escapeHtml(email) : "—"}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Service Address</td><td style="padding:6px 0;">${escapeHtml(serviceAddress)}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Category</td><td style="padding:6px 0;">${escapeHtml(categoryLabel)}</td></tr>
              </table>
              <p style="margin-top:16px;color:#333;"><strong>Description:</strong><br/>${escapeHtml(description).replace(/\n/g, "<br/>")}</p>
              <p style="margin-top:20px;font-size:12px;color:#999;">Request #${requestId} — submitted via depot.watsonbrothersgroup.com/home-solutions</p>
            </div>
          `,
        }).catch((err) => console.error("[BGHS] notify email error:", err));

        if (email) {
          resend.emails.send({
            from: FROM,
            to: email,
            subject: "We got your request — Brothers Group Home Solutions",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
                <h2 style="color:#080808;">Thanks, ${escapeHtml(name)} — we've got your request.</h2>
                <p style="color:#333;line-height:1.6;">We received your ${escapeHtml(categoryLabel).toLowerCase()} request for <strong>${escapeHtml(serviceAddress)}</strong>. Nate or Alex will call you at ${escapeHtml(phone)} within one business day to talk through the job and get you a quote.</p>
                <p style="color:#333;line-height:1.6;">Need us sooner? Call <a href="tel:19048673984" style="color:#a8893a;">(904) 867-3984</a>.</p>
                <p style="margin-top:24px;color:#999;font-size:12px;">Brothers Group Home Solutions, LLC</p>
              </div>
            `,
          }).catch((err) => console.error("[BGHS] confirmation email error:", err));
        }
      }

      console.log(`[BGHS] New quote request #${requestId}: ${name} — ${categoryLabel}`);
      res.json({ ok: true, requestId });
    } catch (err) {
      console.error("[BGHS] quote-request error:", err);
      res.status(500).json({ ok: false, error: "Something went wrong. Please call us instead." });
    }
  });

  // ── GET /api/admin/bghs/quote-requests — admin-only, list for review ──
  app.get("/api/admin/bghs/quote-requests", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const rows = rawDb.prepare(`SELECT * FROM bghs_quote_requests ORDER BY id DESC LIMIT 200`).all();
    res.json({ requests: rows });
  });
}
