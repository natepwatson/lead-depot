// v20.5.0 — Source of Truth Backup export.
// Builds a .xlsx workbook (Sellers / Buyers / Rentals tabs) from the current
// Lead Depot state, then emails Nate + Alex + Denise a copy with the
// FUB-is-source-of-truth explainer. Triggered manually via
// POST /api/admin/source-of-truth-backup after the refinement pass.

import ExcelJS from "exceljs";
import { rawDb } from "./db";

export async function buildSourceOfTruthWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lead Depot";
  wb.created = new Date();

  // ─── SELLERS ────────────────────────────────────────────────────────────
  const sellers = wb.addWorksheet("Sellers");
  sellers.columns = [
    { header: "Address",       key: "address",       width: 42 },
    { header: "City",          key: "city",          width: 18 },
    { header: "State",         key: "state",         width: 8  },
    { header: "Zip",           key: "zip",           width: 10 },
    { header: "List Price",    key: "list_price",    width: 14 },
    { header: "Status",        key: "status",        width: 14 },
    { header: "Listing Agent", key: "listing_agent", width: 22 },
    { header: "MLS #",         key: "mls_number",    width: 14 },
    { header: "Source",        key: "source",        width: 22 },
    { header: "Updated",       key: "updated_at",    width: 20 },
    { header: "Notes",         key: "notes",         width: 60 },
  ];
  sellers.getRow(1).font = { bold: true };

  const sellerRows = rawDb.prepare(`
    SELECT address, city, state, zip, list_price, status, listing_agent,
           mls_number, source, updated_at, notes
    FROM listings
    WHERE (do_not_import IS NULL OR do_not_import = 0)
      AND status IN ('active','coming_soon','pocket','pending','sold')
    ORDER BY status, address
  `).all() as any[];
  sellerRows.forEach(r => sellers.addRow(r));

  // ─── BUYERS ─────────────────────────────────────────────────────────────
  const buyers = wb.addWorksheet("Buyers");
  buyers.columns = [
    { header: "Name",           key: "name",            width: 28 },
    { header: "Phone",          key: "phone",           width: 16 },
    { header: "Email",          key: "email",           width: 28 },
    { header: "Buyer's Agent",  key: "buyers_agent",    width: 20 },
    { header: "Status",         key: "status",          width: 12 },
    { header: "Price Min",      key: "price_min",       width: 12 },
    { header: "Price Max",      key: "price_max",       width: 12 },
    { header: "Beds",           key: "beds_min",        width: 8  },
    { header: "Baths",          key: "baths_min",       width: 8  },
    { header: "SqFt Min",       key: "sqft_min",        width: 10 },
    { header: "Preferred Areas",key: "preferred_areas", width: 30 },
    { header: "ZIP Codes",      key: "zip_codes",       width: 18 },
    { header: "Investor",       key: "is_investor",     width: 10 },
    { header: "Financing",      key: "financing",       width: 14 },
    { header: "Origin Sources", key: "origin_sources",  width: 22 },
    { header: "Confidence",     key: "confidence",      width: 10 },
    { header: "Search #",       key: "multi_search_ordinal", width: 8 },
    { header: "Updated",        key: "updated_at",      width: 20 },
    { header: "Notes / Intent", key: "notes",           width: 60 },
  ];
  buyers.getRow(1).font = { bold: true };

  const buyerRows = rawDb.prepare(`
    SELECT name, phone, email, buyers_agent, status,
           price_min, price_max, beds_min, baths_min, sqft_min,
           preferred_areas, zip_codes, is_investor, financing,
           origin_sources, confidence, multi_search_ordinal, updated_at, notes
    FROM buyers
    WHERE (is_rental IS NULL OR is_rental = 0)
      AND (do_not_import IS NULL OR do_not_import = 0)
      AND status IN ('active','nurture','closed')
    ORDER BY status, lower(name), multi_search_ordinal
  `).all() as any[];
  buyerRows.forEach(r => buyers.addRow({
    ...r,
    is_investor: r.is_investor ? "Yes" : "",
  }));

  // ─── RENTALS ────────────────────────────────────────────────────────────
  const rentals = wb.addWorksheet("Rentals");
  rentals.columns = [
    { header: "Name",           key: "name",            width: 28 },
    { header: "Phone",          key: "phone",           width: 16 },
    { header: "Email",          key: "email",           width: 28 },
    { header: "Rental Type",    key: "rental_type",     width: 22 },
    { header: "Buyer's Agent",  key: "buyers_agent",    width: 20 },
    { header: "Budget Min",     key: "price_min",       width: 12 },
    { header: "Budget Max",     key: "price_max",       width: 12 },
    { header: "Preferred Areas",key: "preferred_areas", width: 30 },
    { header: "ZIP Codes",      key: "zip_codes",       width: 18 },
    { header: "Origin Sources", key: "origin_sources",  width: 22 },
    { header: "Updated",        key: "updated_at",      width: 20 },
    { header: "Notes / Intent", key: "notes",           width: 60 },
  ];
  rentals.getRow(1).font = { bold: true };

  const rentalRows = rawDb.prepare(`
    SELECT name, phone, email, rental_type, buyers_agent,
           price_min, price_max, preferred_areas, zip_codes,
           origin_sources, updated_at, notes
    FROM buyers
    WHERE is_rental = 1
      AND (do_not_import IS NULL OR do_not_import = 0)
    ORDER BY rental_type, lower(name)
  `).all() as any[];
  rentalRows.forEach(r => rentals.addRow(r));

  // ─── STATS TAB (explainer) ──────────────────────────────────────────────
  const stats = wb.addWorksheet("READ_ME_FIRST");
  stats.columns = [
    { header: "Field", key: "k", width: 30 },
    { header: "Value", key: "v", width: 80 },
  ];
  stats.getRow(1).font = { bold: true };
  stats.addRow({ k: "Generated", v: new Date().toISOString() });
  stats.addRow({ k: "Sellers rows", v: sellerRows.length });
  stats.addRow({ k: "Buyers on the Hunt rows", v: buyerRows.length });
  stats.addRow({ k: "Rentals rows", v: rentalRows.length });
  stats.addRow({ k: "", v: "" });
  stats.addRow({ k: "SOURCE OF TRUTH", v: "Follow Up Boss is now the source of truth for this team." });
  stats.addRow({ k: "", v: "Deals, stages, sources, contact info, background, Action Plans, and tasks must be updated in FUB daily." });
  stats.addRow({ k: "", v: "This spreadsheet is a courtesy redundancy check, not the master record." });
  stats.addRow({ k: "", v: "" });
  stats.addRow({ k: "WORKFLOW",   v: "Denise's weekly Excel uploads still land in Lead Depot for map + Open House scheduling." });
  stats.addRow({ k: "", v: "FUB nightly sweep pulls tag / stage / deal state into Lead Depot without overwriting Excel data." });
  stats.addRow({ k: "", v: "If Excel and FUB disagree, Denise's Excel row wins for the current week." });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function sourceOfTruthEmailHtml(counts: {
  sellers: number; buyers: number; rentals: number;
}): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0f0f0">
<div style="max-width:640px;margin:0 auto;padding:40px 32px 32px">
  <div style="text-align:center;margin-bottom:32px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.3em;text-transform:uppercase;margin-bottom:8px">Watson Brothers Group</div>
    <div style="color:#f0f0f0;font-size:22px;font-weight:600;letter-spacing:-.01em">Source of Truth Backup</div>
    <div style="color:#7a7a7a;font-size:13px;margin-top:6px">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
  </div>

  <div style="background:#1a1a1a;border-left:3px solid #c8aa5a;padding:20px 24px;margin-bottom:28px">
    <div style="color:#c8aa5a;font-size:12px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-bottom:12px">Follow Up Boss is now the source of truth</div>
    <div style="color:#e8e8e8;font-size:14px;line-height:1.6">
      Effective this backup, <strong>FUB is the master record</strong> for everyone on this team. That means:
    </div>
    <ul style="color:#e8e8e8;font-size:14px;line-height:1.7;padding-left:20px;margin:14px 0 0">
      <li>Deals, stages, and sources must be updated in FUB daily</li>
      <li>Contact info, background, and notes live in FUB — not spreadsheets</li>
      <li>Action Plans and tasks are assigned and tracked in FUB</li>
      <li>Anything you don't keep current in FUB will not show up correctly in Lead Depot</li>
    </ul>
  </div>

  <div style="background:#1a1a1a;padding:20px 24px;margin-bottom:28px">
    <div style="color:#c8aa5a;font-size:12px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-bottom:12px">This backup</div>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;color:#7a7a7a;font-size:13px">Sellers</td>
        <td style="padding:6px 0;color:#f0f0f0;font-size:14px;text-align:right;font-weight:600">${counts.sellers}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#7a7a7a;font-size:13px">Buyers on the Hunt</td>
        <td style="padding:6px 0;color:#f0f0f0;font-size:14px;text-align:right;font-weight:600">${counts.buyers}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#7a7a7a;font-size:13px">Rentals</td>
        <td style="padding:6px 0;color:#f0f0f0;font-size:14px;text-align:right;font-weight:600">${counts.rentals}</td>
      </tr>
    </table>
  </div>

  <div style="color:#7a7a7a;font-size:13px;line-height:1.7;margin-bottom:28px">
    Denise's Monday workbook upload still runs the map and Open House schedule. The FUB nightly sweep fills in any gaps.
    If Excel and FUB disagree on a row, Excel wins for that week &mdash; but the intent is to close that gap by keeping FUB current daily.
  </div>

  <div style="border-top:1px solid #2a2a2a;padding-top:20px;text-align:center">
    <div style="color:#7a7a7a;font-size:12px">Attached: BGMR-Source-of-Truth-Backup.xlsx</div>
    <div style="color:#5a5a5a;font-size:11px;margin-top:6px">Lead Depot &middot; watsonbrothersgroup.com</div>
  </div>
</div>
</body></html>`;
}
