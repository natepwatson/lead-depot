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
  fubPersonIntentBlob,
} from "./fub";
import { parseIntent } from "./buyerIntentParser";

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

  // v20.5.0 — UPSERT keyed on (lower(name), multi_search_ordinal) so FUB-only
  //           people always land at ordinal=1. do_not_import wins over incoming
  //           status. origin_sources gets 'fub' appended (never overwritten).
  const upsertBuyer = rawDb.prepare(`
    INSERT INTO buyers (
      name, phone, email, buyers_agent, status,
      price_min, price_max, preferred_areas, zip_codes,
      beds_min, baths_min, sqft_min,
      land_acres_min, lot_width_min, arv_min, arv_max,
      must_haves, no_gos, pre_approved, lender, timeline,
      notes, intent_phrases,
      intent_property_types, intent_conditions, intent_verbs,
      financing, is_investor, is_rental, rental_type,
      confidence, origin_sources, multi_search_ordinal,
      source, source_ref, fub_person_id, last_updated_by, created_at, updated_at
    ) VALUES (
      @name, @phone, @email, @buyers_agent,
      CASE WHEN @is_rental = 1 THEN 'rental' ELSE 'active' END,
      @price_min, @price_max, @preferred_areas, @zip_codes,
      @beds_min, @baths_min, @sqft_min,
      @land_acres_min, @lot_width_min, @arv_min, @arv_max,
      @must_haves, @no_gos, @pre_approved, @lender, @timeline,
      @notes, @intent_phrases,
      @intent_property_types, @intent_conditions, @intent_verbs,
      @financing, @is_investor, @is_rental, @rental_type,
      @confidence, @origin_sources, 1,
      @source, @source_ref, @fub_person_id, 'fub-sweep', datetime('now'), datetime('now')
    )
    ON CONFLICT(lower(name), multi_search_ordinal) DO UPDATE SET
      status          = CASE
                          WHEN buyers.do_not_import = 1 THEN buyers.status
                          WHEN buyers.source = 'excel' THEN buyers.status
                          WHEN excluded.is_rental = 1 THEN 'rental'
                          ELSE 'active'
                        END,
      phone           = COALESCE(buyers.phone, excluded.phone),
      email           = COALESCE(buyers.email, excluded.email),
      buyers_agent    = COALESCE(buyers.buyers_agent, excluded.buyers_agent),
      price_min       = COALESCE(buyers.price_min, excluded.price_min),
      price_max       = COALESCE(buyers.price_max, excluded.price_max),
      preferred_areas = COALESCE(buyers.preferred_areas, excluded.preferred_areas),
      zip_codes       = COALESCE(buyers.zip_codes, excluded.zip_codes),
      beds_min        = COALESCE(buyers.beds_min, excluded.beds_min),
      baths_min       = COALESCE(buyers.baths_min, excluded.baths_min),
      sqft_min        = COALESCE(buyers.sqft_min, excluded.sqft_min),
      land_acres_min  = COALESCE(buyers.land_acres_min, excluded.land_acres_min),
      lot_width_min   = COALESCE(buyers.lot_width_min, excluded.lot_width_min),
      arv_min         = COALESCE(buyers.arv_min, excluded.arv_min),
      arv_max         = COALESCE(buyers.arv_max, excluded.arv_max),
      must_haves      = COALESCE(buyers.must_haves, excluded.must_haves),
      no_gos          = COALESCE(buyers.no_gos, excluded.no_gos),
      pre_approved    = COALESCE(NULLIF(buyers.pre_approved,0), excluded.pre_approved, 0),
      lender          = COALESCE(buyers.lender, excluded.lender),
      timeline        = COALESCE(buyers.timeline, excluded.timeline),
      notes           = COALESCE(NULLIF(buyers.notes,''), excluded.notes),
      intent_phrases  = COALESCE(buyers.intent_phrases, excluded.intent_phrases),
      intent_property_types = COALESCE(buyers.intent_property_types, excluded.intent_property_types),
      intent_conditions = COALESCE(buyers.intent_conditions, excluded.intent_conditions),
      intent_verbs    = COALESCE(buyers.intent_verbs, excluded.intent_verbs),
      financing       = COALESCE(buyers.financing, excluded.financing),
      is_investor     = COALESCE(NULLIF(buyers.is_investor,0), excluded.is_investor, 0),
      is_rental       = COALESCE(NULLIF(buyers.is_rental,0), excluded.is_rental, 0),
      rental_type     = COALESCE(buyers.rental_type, excluded.rental_type),
      confidence      = MAX(excluded.confidence, COALESCE(buyers.confidence, 0)),
      origin_sources  = excluded.origin_sources,
      fub_person_id   = COALESCE(buyers.fub_person_id, excluded.fub_person_id),
      source          = CASE WHEN buyers.source = 'excel' THEN buyers.source ELSE excluded.source END,
      updated_at      = datetime('now')
  `);

  const readOriginStmt = rawDb.prepare(
    `SELECT origin_sources FROM buyers WHERE lower(name) = ? AND multi_search_ordinal = 1`
  );

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
          (await upsertBuyerFromPerson(p, `fub:${cfg.tag_name}`, upsertBuyer, readOriginStmt, errors)) ? buyers++ : skipped++;
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
        (await upsertBuyerFromPerson(p, `fub:stage:${stage}`, upsertBuyer, readOriginStmt, errors)) ? buyers++ : skipped++;
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

// v20.5.0 — Async buyer upsert. Concats background + customFields + last 25 notes,
//            runs intent parser (rental detection, price/beds/areas), merges origin_sources.
async function upsertBuyerFromPerson(
  p: any,
  source: string,
  upsertBuyer: any,
  readOriginStmt: any,
  errors: string[]
): Promise<boolean> {
  const name = (p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim()).trim();
  if (!name) return false;
  const prefs = fubPersonBuyerPrefs(p);
  const phone = (p.phones && p.phones[0] && p.phones[0].value) || null;
  const email = (p.emails && p.emails[0] && p.emails[0].value) || null;

  // v20.5.0 — Build intent blob (background + customFields + all notes) and parse.
  let intentBlob = "";
  let intent = parseIntent("");
  try {
    intentBlob = await fubPersonIntentBlob(p, true);
    if (intentBlob) intent = parseIntent(intentBlob);
  } catch (e: any) {
    errors.push(`intent-blob ${name}: ${e.message}`);
  }

  // Merge origin_sources: existing UNION ['fub']
  let originSources: string[] = ["fub"];
  try {
    const existing = readOriginStmt.get(name.toLowerCase()) as { origin_sources: string } | undefined;
    if (existing?.origin_sources) {
      const arr = JSON.parse(existing.origin_sources);
      if (Array.isArray(arr)) originSources = Array.from(new Set([...arr, "fub"]));
    }
  } catch { /* first sighting, keep ['fub'] */ }

  try {
    upsertBuyer.run({
      name,
      phone,
      email,
      buyers_agent:    p.assignedUserName || null,
      // Excel-style prefs take precedence when FUB has them; parser fills gaps.
      price_min:       prefs.price_min ?? intent.price_min,
      price_max:       prefs.price_max ?? intent.price_max,
      preferred_areas: prefs.preferred_areas ?? (intent.areas.length ? intent.areas.join(", ") : null),
      zip_codes:       intent.zip_codes.length ? intent.zip_codes.join(",") : null,
      beds_min:        prefs.beds_min ?? intent.beds_min,
      baths_min:       prefs.baths_min ?? intent.baths_min,
      sqft_min:        prefs.sqft_min ?? intent.sqft_min,
      land_acres_min:  intent.land_acres_min,
      lot_width_min:   intent.lot_width_min,
      arv_min:         intent.arv_min,
      arv_max:         intent.arv_max,
      must_haves:      prefs.must_haves,
      no_gos:          prefs.no_gos,
      pre_approved:    prefs.pre_approved,
      lender:          prefs.lender,
      timeline:        prefs.timeline,
      notes:                 intentBlob ? intentBlob.slice(0, 2000) : null,
      intent_phrases:        intentBlob ? JSON.stringify([intentBlob.slice(0, 500)]) : null,
      intent_property_types: intent.property_types.length ? intent.property_types.join(",") : null,
      intent_conditions:     intent.conditions.length ? intent.conditions.join(",") : null,
      intent_verbs:          intent.verbs.length ? intent.verbs.join(",") : null,
      financing:       intent.financing,
      is_investor:     intent.is_investor ? 1 : 0,
      is_rental:       intent.is_rental ? 1 : 0,
      rental_type:     intent.rental_type,
      confidence:      intent.confidence,
      origin_sources:  JSON.stringify(originSources),
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
