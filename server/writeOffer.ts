// ─── WRITE AN OFFER ─────────────────────────────────────────────────────────
// v20.8.0 — "Place an Offer" tool. Replaces the standalone Repair Quote nav
// tab. Lets an agent fill out Alex's exact "AAA WRITE AN OFFER" text template
// on the spot once a buyer says they want to write, then fires one email to
// the transaction coordinator — TEMPORARILY Nate Watson while this flow is
// still being built (see TEMPORARY note below), with Alex CC'd. Will revert
// to the real TC (Whittney Rocha / Next Level) once Alex confirms — same
// text Alex would have typed out by hand, just faster and with zero missed
// fields.
//
// No DB table — this is a one-shot compose-and-send, not a saved consult.
// ────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = "The Brothers Group Real Estate Team <noreply@watsonbrothersgroup.com>";
const APP_URL = "https://depot.watsonbrothersgroup.com";
const BRAND = {
  black: "#0a0a0a",
  gray: "#808080",
  lightGray: "#f2f2f2",
  border: "#999999",
  green: "#008000",
  contactLine: "Alex & Nate Watson — (904) 867-3984 — www.brothersgroup.realestate",
};

// TEMPORARY (as of v20.14.7) — Nate is standing in as TC while this offer
// flow is still being built and tested. Whittney Rocha is the real outside
// TC (Next Level FL) and will take this role back once Alex confirms the
// app is ready — don't bog down her actual business with test/in-progress
// offers in the meantime. Keeping her info here (commented) so switching
// back is a one-line change, not a re-discovery:
//   Real TC: Whittney Rocha — whittney@nextlevelfl.com — (904) 703-8023
const TC_EMAIL = "nate@watsonbrothersgroup.com";
const TC_NAME = "Nate Watson";
const TC_PHONE = "(904) 867-3984";
const CC_EMAILS = ["alex@watsonbrothersgroup.com"];

// Preset lender list — Alex's main lenders. "Other" lets the agent type in
// anyone else on the spot.
export const LENDER_PRESETS = ["Tyler Payne", "Matt Sapienza", "John O'Leary"];

function brandedHeader(title: string, subtitle: string): string {
  return `
  <div style="background:${BRAND.black};padding:28px 32px;text-align:center">
    <img src="${APP_URL}/brand-logo.jpg" alt="Brothers Group" style="width:220px;max-width:70%;height:auto;display:inline-block" />
  </div>
  <div style="padding:22px 32px 4px;text-align:center;border-bottom:3px solid ${BRAND.black}">
    <h1 style="margin:0;font-size:19px;color:${BRAND.black};font-family:Helvetica,Arial,sans-serif;font-weight:700">${title}</h1>
    ${subtitle ? `<p style="margin:6px 0 16px;font-size:12.5px;color:${BRAND.gray}">${subtitle}</p>` : ""}
  </div>`;
}

function brandedFooter(): string {
  return `
  <div style="padding:16px 32px;background:${BRAND.gray};color:#fff;font-size:11px;text-align:center">
    ${BRAND.contactLine}
  </div>`;
}

function esc(v: any): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function row(label: string, value: string, opts: { bold?: boolean } = {}): string {
  return `<tr>
    <td style="padding:5px 10px 5px 0;color:${BRAND.gray};font-size:12px;width:230px;vertical-align:top">${esc(label)}</td>
    <td style="padding:5px 0;font-size:12.5px;color:#1a1a1a;font-weight:${opts.bold ? 700 : 400};vertical-align:top">${value}</td>
  </tr>`;
}

function section(title: string): string {
  return `<tr><td colspan="2" style="padding:16px 0 4px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.black};border-bottom:1px solid ${BRAND.border}">${esc(title)}</td></tr>`;
}

interface WriteOfferPayload {
  agentName?: string;
  propertyAddress: string;

  buyer1LegalName?: string; buyer1Phone?: string; buyer1Email?: string;
  buyer2LegalName?: string; buyer2Phone?: string; buyer2Email?: string;
  buyersAgentName?: string;

  financingType: string;   // "Cash" | "Conventional" | "FHA" | "VA" | "USDA" | "Other"
  financingTypeOther?: string;
  loanApprovalPeriod?: string;

  purchasePrice: number;
  binderDepositPct?: number;
  downPaymentPct?: number;

  titleAttorney?: string;
  inspectionPeriodDays?: number;
  daysToClosing?: number;
  possession?: string;

  sellersAgentCompensationPct?: number;
  appliancesIncluded?: string;

  // v20.14.7 — kept optional so old clients don't break the type, but the
  // server now IGNORES these two fields entirely (see buildOfferHtml) and
  // always uses the hardcoded 2-day / 6:00 PM ET rule. Never re-read these
  // from the payload for the actual expiry calculation.
  offerExpireDays?: number;
  offerExpireTime?: string; // "18:00"

  assignmentAllowed?: "yes" | "no";
  contingentOnHomeSale?: "yes" | "no";
  // v20.14.7 — resolved address when contingentOnHomeSale === "yes", either
  // pulled from a FUB contact's on-file address or typed manually by the
  // agent for a property that isn't in FUB.
  contingentHomeSaleAddress?: string;

  additionalTerms?: string;

  lender?: string;
  lenderOther?: string;
}

function computeExpiry(days: number, time: string): { label: string; iso: string } {
  const now = new Date();
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + (days || 0));
  const [hh, mm] = (time || "18:00").split(":").map(n => parseInt(n, 10));
  expiry.setHours(isNaN(hh) ? 18 : hh, isNaN(mm) ? 0 : mm, 0, 0);
  const label = expiry.toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
  return { label: `${label} ET`, iso: expiry.toISOString() };
}

function buildOfferHtml(p: WriteOfferPayload): string {
  const purchasePrice = Number(p.purchasePrice) || 0;
  const binderPct = p.binderDepositPct ?? 1;
  const downPct = p.downPaymentPct ?? 0;
  const sellerCompPct = p.sellersAgentCompensationPct ?? 3;
  const binderAmt = purchasePrice * (binderPct / 100);
  const downAmt = purchasePrice * (downPct / 100);
  const sellerCompAmt = purchasePrice * (sellerCompPct / 100);
  const financingLabel = p.financingType === "Other" ? (p.financingTypeOther || "Other") : p.financingType;
  const isCash = p.financingType === "Cash";
  const lenderLabel = p.lender === "Other" ? (p.lenderOther || "—") : (p.lender || "—");
  // v20.14.7 — MANDATORY house rule, not agent-adjustable: every offer
  // expires exactly 2 days after send, at 6:00 PM ET. Hardcoded here so it
  // can never be overridden via a direct API call, even if a client sends
  // offerExpireDays/offerExpireTime in the payload.
  const expireDays = 2;
  const expireTime = "18:00";
  const { label: expiryLabel } = computeExpiry(expireDays, expireTime);
  const proofDocLabel = isCash ? "Proof of Funds" : "Pre-Approval Letter";

  const buyerBlock = (label: string, name?: string, phone?: string, email?: string) => {
    if (!name && !phone && !email) return "";
    const contact = [phone, email].filter(Boolean).join(" · ");
    return row(label, `${esc(name)}${contact ? `<br/><span style="color:${BRAND.gray};font-size:11.5px">${esc(contact)}</span>` : ""}`);
  };

  return `
  <!DOCTYPE html><html><body style="margin:0;padding:0;background:#e9e9e9;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff">
    ${brandedHeader("Write an Offer", p.propertyAddress)}
    <div style="padding:22px 32px">
      <table style="width:100%;border-collapse:collapse">
        ${section("Contract")}
        ${row("Contract Type", "Residential Purchase &amp; Sale — Far-Bar As-Is", { bold: true })}
        ${row("Property Address", esc(p.propertyAddress), { bold: true })}

        ${section("Buyer(s)")}
        ${buyerBlock("Buyer 1 — Full Legal Name", p.buyer1LegalName, p.buyer1Phone, p.buyer1Email) || row("Buyer 1 — Full Legal Name", esc(p.buyer1LegalName))}
        ${p.buyer2LegalName || p.buyer2Phone || p.buyer2Email ? (buyerBlock("Buyer 2 — Full Legal Name", p.buyer2LegalName, p.buyer2Phone, p.buyer2Email) || "") : ""}
        ${row("Buyer's Agent", esc(p.buyersAgentName))}

        ${section("Financing")}
        ${row("Financing Type", esc(financingLabel), { bold: true })}
        ${!isCash ? row("Loan Approval Period", esc(p.loanApprovalPeriod)) : ""}
        ${!isCash ? row("Lender", esc(lenderLabel)) : ""}

        ${section("Price &amp; Terms")}
        ${row("Purchase Price", money(purchasePrice), { bold: true })}
        ${row("Binder Deposit", `${binderPct}% — ${money(binderAmt)}`)}
        ${row("Down Payment", `${downPct}% — ${money(downAmt)}`)}
        ${row("Title Attorney", "Seller selected")}
        ${row("Inspection Period", `${p.inspectionPeriodDays ?? 10} days`)}
        ${row("Days to Closing", `${p.daysToClosing ?? 30} days`)}
        ${row("Possession", esc(p.possession || "At closing"))}
        ${row("Buyer to Pay", "$800 Broker Fee")}
        ${row("Seller to Pay", "Customaries")}
        ${row("Seller to Pay — Buyer's Agent Compensation", `${sellerCompPct}% — ${money(sellerCompAmt)}`)}
        ${row("Appliances Included", esc(p.appliancesIncluded || "All in the home at the time of the sale"))}
        ${row("Offer Expires", `${expiryLabel} (${expireDays} days from send, ${expireTime})`, { bold: true })}
        ${row("Assignment", p.assignmentAllowed === "yes" ? "Buyer May assign" : "Buyer May NOT assign")}
        ${row("Contingent on Home Sale?", p.contingentOnHomeSale === "yes"
          ? `Yes — ${esc(p.contingentHomeSaleAddress || "address not provided")}`
          : "No")}

        ${p.additionalTerms ? section("Additional Terms") : ""}
        ${p.additionalTerms ? `<tr><td colspan="2" style="padding:8px 0;font-size:12.5px;color:#1a1a1a;line-height:1.55">${esc(p.additionalTerms)}</td></tr>` : ""}
      </table>

      <div style="margin-top:18px;padding:14px 16px;background:${BRAND.lightGray};border-radius:8px">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${BRAND.black}">Docs to Include</p>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#333;line-height:1.6">
          <li>Exclusive Buyer's Brokerage Agreement — 3%, $800, 12 mo</li>
          <li>Seller to Buyer's Broker Compensation Agreement — 3%</li>
          <li>Disclosure to Buyer — $800 fee</li>
          <li>${proofDocLabel}</li>
        </ul>
      </div>

      <div style="margin-top:14px;padding:14px 16px;background:#fff5e0;border:1px solid #e8d5a0;border-radius:8px">
        <p style="margin:0;font-size:12.5px;color:#1a1a1a;line-height:1.55"><strong>Once accepted, please order:</strong> HI, WDO, WM, 4pt inspections.</p>
      </div>

      <p style="margin-top:20px;font-size:12px;color:${BRAND.gray}">
        Submitted by ${esc(p.agentName)} via Lead Depot.
      </p>
    </div>
    ${brandedFooter()}
  </div>
  </body></html>`;
}

export function registerWriteOfferRoutes(app: Express) {
  app.post("/api/write-offer", async (req: Request, res: Response) => {
    try {
      const payload = req.body as WriteOfferPayload;
      if (!payload?.propertyAddress?.trim()) return res.status(400).json({ error: "Property address is required." });
      if (!payload?.purchasePrice) return res.status(400).json({ error: "Purchase price is required." });
      if (!payload?.financingType) return res.status(400).json({ error: "Financing type is required." });

      const html = buildOfferHtml(payload);
      const subject = `Write an Offer — ${payload.propertyAddress} — ${money(Number(payload.purchasePrice) || 0)}`;

      if (resend) {
        await resend.emails.send({
          from: FROM,
          to: [TC_EMAIL],
          cc: CC_EMAILS,
          subject,
          html,
        });
      }

      res.json({ sent: true, to: TC_EMAIL, cc: CC_EMAILS });
    } catch (e: any) {
      console.error("write-offer send failed:", e);
      res.status(500).json({ error: e?.message || "Failed to send offer." });
    }
  });

  app.get("/api/write-offer/lenders", (_req: Request, res: Response) => {
    res.json({ lenders: LENDER_PRESETS, tc: { name: TC_NAME, email: TC_EMAIL, phone: TC_PHONE } });
  });
}
