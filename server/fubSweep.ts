// v20.4.9 — Nightly FUB sweep for Inventory bucket tags.
// v20.4.9 — Extended: also sweep FUB Stage ("Active Client") + FUB Deals for
//           real-time inventory + real-money opportunity intel.
//
// Reads fub_tag_config, pulls people for each enabled tag, and upserts into
// listings (bucket=pocket_listing) or buyers (bucket=active_buyer).
// Then additionally pulls Active Client stage → buyers, and open Deals → both
// listings (listing-side deals) and buyers (buyer-side deals) with a
// dedicated 'deal' source tag so we can filter later.
//
// Excel-wins-conflicts semantics preserved: any row Denise uploaded via the
// Weekly Workbook keeps its status/notes untouched, we only fill missing
// fields from FUB.

import { rawDb } from "./db";
import {
  fubListPeopleByTag,
  fubListPeopleByStage,
  fubListDeals,
  fubPersonAddress,
  fubPersonBuyerPrefs,
} from "./fub";

// v20.4.9 — locked to Active Client only per Alex 8/4/26.
const ACTIVE_BUYER_STAGES = ["Active Client"];

type TagConfig = {
  tag_name: string;
  bucket: "pocket_listing" | "active_buyer" | "ignore";
  enabled: number;
};

type SweepResult = {
  processed: number;
  pockets: number;
  buyers: number;
  deals_processed: number;
  deals_listing: number;
  deals_buyer: number;
  skipped: number;
  errors: string[];
};

export async function runFubInventorySweep(): Promise<SweepResult> {
  const errors: string[] = [];
  let processed = 0, pockets = 0, buyers = 0, skipped = 0;
  let deals_processed = 0, deals_listing = 0, deals_buyer = 0;

  const upsertListing = rawDb.prepare(`
    INSERT INTO listings (
      address, city, state, zip, list_price, status, listing_agent, source, source_ref, created_at, updated_at
    ) VALUES (
      @address, @city, @state, @zip, @list_price, @status, @listing_agent, @source, @source_ref, datetime('now'), datetime('now')
    )
    ON CONFLICT(lower(address), coalesce(zip,'')) DO UPDATE SET
      -- Excel wins for status; otherwise take incoming
      status = CASE
        WHEN listings.source = 'excel' THEN listings.status
        ELSE excluded.status
      END,
      list_price = COALESCE(listings.list_price, excluded.list_price),
      listing_agent = COALESCE(listings.listing_agent, excluded.listing_agent),
      source     = CASE WHEN listings.source = 'excel' THEN listings.source ELSE excluded.source END,
      source_ref = CASE WHEN listings.source = 'excel' THEN listings.source_ref ELSE excluded.source_ref END,
      updated_at = datetime('now')
  `);

  const upsertBuyer = rawDb.prepare(`
    INSERT INTO buyers (
      name, phone, email, buyers_agent, status,
      price_min, price_max, preferred_areas,
      beds_min, baths_min, sqft_min, must_haves, no_gos,
      pre_approved, lender, timeline,
      source, source_ref, fub_person_id, last_updated_by, created_at, updated_at
    ) VALUES (
      @name, @phone, @email, @buyers_agent, 'active',
      @price_min, @price_max, @preferred_areas,
      @beds_min, @baths_min, @sqft_min, @must_haves, @no_gos,
      @pre_approved, @lender, @timeline,
      @source, @source_ref, @fub_person_id, 'fub-sweep', datetime('now'), datetime('now')
    )
    ON CONFLICT(coalesce(lower(phone),lower(email),lower(name))) DO UPDATE SET
      status          = CASE WHEN buyers.source = 'excel' THEN buyers.status ELSE 'active' END,
      price_min       = COALESCE(buyers.price_min, excluded.price_min),
      price_max       = COALESCE(buyers.price_max, excluded.price_max),
      preferred_areas = COALESCE(buyers.preferred_areas, excluded.preferred_areas),
      beds_min        = COALESCE(buyers.beds_min, excluded.beds_min),
      baths_min       = COALESCE(buyers.baths_min, excluded.baths_min),
      sqft_min        = COALESCE(buyers.sqft_min, excluded.sqft_min),
      must_haves      = COALESCE(buyers.must_haves, excluded.must_haves),
      no_gos          = COALESCE(buyers.no_gos, excluded.no_gos),
      pre_approved    = COALESCE(NULLIF(buyers.pre_approved,0), excluded.pre_approved, 0),
      lender          = COALESCE(buyers.lender, excluded.lender),
      timeline        = COALESCE(buyers.timeline, excluded.timeline),
      fub_person_id   = COALESCE(buyers.fub_person_id, excluded.fub_person_id),
      source          = CASE WHEN buyers.source = 'excel' THEN buyers.source ELSE excluded.source END,
      updated_at      = datetime('now')
  `);

  const markSync = rawDb.prepare(`UPDATE fub_tag_config SET last_synced_at = datetime('now'), last_person_count = ?, updated_at = datetime('now') WHERE tag_name = ?`);

  // ─── PHASE 1: TAG-BASED SWEEP (existing v20.4.9 behavior) ────────────────
  const tags = rawDb.prepare(`SELECT tag_name, bucket, enabled FROM fub_tag_config WHERE enabled = 1 AND bucket IN ('pocket_listing','active_buyer')`).all() as TagConfig[];

  for (const cfg of tags) {
    try {
      const people = await fubListPeopleByTag(cfg.tag_name);
      markSync.run(people.length, cfg.tag_name);

      for (const p of people) {
        processed++;
        if (cfg.bucket === "pocket_listing") {
          const a = fubPersonAddress(p);
          if (!a.address) { skipped++; continue; }
          try {
            upsertListing.run({
              address:       a.address,
              city:          a.city,
              state:         a.state,
              zip:           a.zip,
              list_price:    null,
              status:        "pocket",
              listing_agent: p.assignedUserName || null,
              source:        `fub:${cfg.tag_name}`,
              source_ref:    `fub:person:${p.id}`,
            });
            pockets++;
          } catch (e: any) {
            errors.push(`pocket ${a.address}: ${e.message}`);
          }
        } else if (cfg.bucket === "active_buyer") {
          upsertBuyerFromPerson(p, `fub:${cfg.tag_name}`, upsertBuyer, errors) ? buyers++ : skipped++;
        }
      }
    } catch (err: any) {
      errors.push(`tag ${cfg.tag_name}: ${err.message}`);
    }
  }

  // ─── PHASE 2: STAGE-BASED SWEEP (v20.4.9) ────────────────────────────────
  // Only "Active Client" stage — locked per Alex 8/4/26.
  for (const stage of ACTIVE_BUYER_STAGES) {
    try {
      const people = await fubListPeopleByStage(stage);
      for (const p of people) {
        processed++;
        upsertBuyerFromPerson(p, `fub:stage:${stage}`, upsertBuyer, errors) ? buyers++ : skipped++;
      }
    } catch (err: any) {
      errors.push(`stage ${stage}: ${err.message}`);
    }
  }

  // ─── PHASE 3: DEALS SWEEP (v20.4.9) ──────────────────────────────────────
  // Every open deal in FUB is a real-money opportunity. Buyer-side deals
  // become pending buyers with the property they're chasing. Listing-side
  // deals become pending listings (already-under-contract properties we
  // should still show on the map).
  try {
    const deals = await fubListDeals();
    for (const d of deals) {
      deals_processed++;
      // Skip closed/lost deals — only pull in-progress opportunities.
      const st = String(d.status || d.stage || "").toLowerCase();
      if (/closed|won|lost|cancelled|canceled|dead/.test(st)) continue;

      const dealType = String(d.type || "").toLowerCase();

      // LISTING-SIDE DEAL → listings table
      if (dealType.includes("listing") && d.address) {
        try {
          upsertListing.run({
            address:       d.address,
            city:          d.city || null,
            state:         d.state || null,
            zip:           d.zip || null,
            list_price:    d.price || null,
            status:        "pending",  // under-contract on the seller side
            listing_agent: d.assignedUserName || null,
            source:        "fub:deal:listing",
            source_ref:    `fub:deal:${d.id}`,
          });
          deals_listing++;
        } catch (e: any) {
          errors.push(`deal-listing ${d.id}: ${e.message}`);
        }
      }

      // BUYER-SIDE DEAL → buyers table (with target address in notes)
      // v20.4.9 — Also matches "Interested Buyer" FUB deal type. Both flow
      // into the "Buyers on the Hunt" list (buyers.status='active').
      else if (dealType.includes("buyer") || dealType.includes("interested") || (!dealType && d.peopleIds?.length)) {
        // Need at least one person to attach the buyer record to
        const personId = d.peopleIds?.[0];
        if (!personId) { continue; }
        try {
          const name = d.name || `FUB Deal ${d.id}`;
          rawDb.prepare(`
            INSERT INTO buyers (
              name, phone, email, buyers_agent, status,
              price_min, price_max, preferred_areas,
              source, source_ref, fub_person_id, last_updated_by, notes,
              created_at, updated_at
            ) VALUES (
              @name, NULL, NULL, @agent, 'active',
              NULL, @price, @area,
              'fub:deal:buyer', @sref, @fub_pid, 'fub-sweep', @notes,
              datetime('now'), datetime('now')
            )
            ON CONFLICT(coalesce(lower(phone),lower(email),lower(name))) DO UPDATE SET
              status     = CASE WHEN buyers.source = 'excel' THEN buyers.status ELSE 'active' END,
              price_max  = COALESCE(buyers.price_max, excluded.price_max),
              preferred_areas = COALESCE(buyers.preferred_areas, excluded.preferred_areas),
              notes      = COALESCE(NULLIF(buyers.notes,''), excluded.notes),
              source     = CASE WHEN buyers.source = 'excel' THEN buyers.source ELSE excluded.source END,
              updated_at = datetime('now')
          `).run({
            name,
            agent:  d.assignedUserName || null,
            price:  d.price || null,
            area:   d.city || null,
            sref:   `fub:deal:${d.id}`,
            fub_pid: String(personId),
            notes:  d.address ? `Target: ${d.address}` : null,
          });
          deals_buyer++;
        } catch (e: any) {
          errors.push(`deal-buyer ${d.id}: ${e.message}`);
        }
      }
    }
  } catch (err: any) {
    errors.push(`deals sweep: ${err.message}`);
  }

  return { processed, pockets, buyers, deals_processed, deals_listing, deals_buyer, skipped, errors };
}

// Helper: build a buyer upsert from a FUB person record. Returns true if
// upsert executed, false if skipped (no name).
function upsertBuyerFromPerson(p: any, source: string, upsertBuyer: any, errors: string[]): boolean {
  const name = (p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim()).trim();
  if (!name) return false;
  const prefs = fubPersonBuyerPrefs(p);
  const phone = (p.phones && p.phones[0] && p.phones[0].value) || null;
  const email = (p.emails && p.emails[0] && p.emails[0].value) || null;
  try {
    upsertBuyer.run({
      name,
      phone,
      email,
      buyers_agent:    p.assignedUserName || null,
      price_min:       prefs.price_min,
      price_max:       prefs.price_max,
      preferred_areas: prefs.preferred_areas,
      beds_min:        prefs.beds_min,
      baths_min:       prefs.baths_min,
      sqft_min:        prefs.sqft_min,
      must_haves:      prefs.must_haves,
      no_gos:          prefs.no_gos,
      pre_approved:    prefs.pre_approved,
      lender:          prefs.lender,
      timeline:        prefs.timeline,
      source,
      source_ref:      `fub:person:${p.id}`,
      fub_person_id:   String(p.id),
    });
    return true;
  } catch (e: any) {
    errors.push(`buyer ${name}: ${e.message}`);
    return false;
  }
}
