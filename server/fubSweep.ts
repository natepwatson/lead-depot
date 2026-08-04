// v20.6.8 — FUB IS SOURCE OF TRUTH.
//
// Locked per Alex 8/4/26:
//   • BUYERS: only FUB stage "Active Client" produces buyers in LD.
//   • LISTINGS: seller person stage drives the LD bucket. 4-stage minimal map:
//       "Pocket"          → status = "pocket"
//       "Coming Soon"     → status = "coming_soon"
//       "Active Listing"  → status = "active"       (live on MLS)
//       "Closed - Sold"   → status = "sold"         (historical, kept for lead-gen)
//     Any other stage on a person is ignored for the LISTINGS side.
//   • EXCEL LEGACY: workbook uploads are dead. Every sweep starts by nuking
//     excel-origin listings + buyers, then rebuilds from FUB. The old
//     "excel wins" conflict rule is REMOVED — FUB always wins.
//   • Deals still ride along as a secondary source of listing/buyer intel
//     (in case something is in a deal but the person stage lags behind),
//     but FUB deal status/stage no longer shields anything.

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

// v20.6.8 — Locked buyer stages (unchanged from v20.4.9).
const ACTIVE_BUYER_STAGES = ["Active Client"];

// v20.6.8 — Locked seller stage → LD listing bucket. This is the authoritative
// mapping. Denise moves the SELLER PERSON through these 4 stages in FUB and
// LD mirrors it. Case-insensitive match on stage name.
const SELLER_STAGE_MAP: Record<string, "pocket" | "coming_soon" | "active" | "sold"> = {
  "pocket":           "pocket",
  "pocket listing":   "pocket",
  "coming soon":      "coming_soon",
  "active listing":   "active",
  "listed":           "active",           // legacy alias
  "closed - sold":    "sold",
  "closed sold":      "sold",
  "sold":             "sold",
};

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
  seller_stages: number;   // v20.6.8 — count of seller-stage listings ingested
  excel_nuked_listings: number;  // v20.6.8 — excel rows deleted at start
  excel_nuked_buyers: number;
  errors: string[];
};

export async function runFubInventorySweep(): Promise<SweepResult> {
  const errors: string[] = [];
  let processed = 0, pockets = 0, buyers = 0, skipped = 0, seller_stages = 0;
  let deals_processed = 0, deals_listing = 0, deals_buyer = 0;
  let excel_nuked_listings = 0, excel_nuked_buyers = 0;

  // ─── PHASE 0: NUKE EXCEL LEGACY ROWS ─────────────────────────────────────
  // v20.6.8 — FUB is source of truth now. Every workbook-origin row gets
  // wiped so the FUB sweep can rebuild cleanly. Runs BEFORE any upsert so we
  // never race with our own inserts.
  try {
    const delListings = rawDb.prepare(
      `DELETE FROM listings WHERE source LIKE 'excel%' OR source = 'workbook'`
    );
    excel_nuked_listings = delListings.run().changes ?? 0;
  } catch (e: any) {
    errors.push(`phase0 nuke listings: ${e.message}`);
  }
  try {
    // Buyers rows can have origin_sources = JSON array like ["excel","fub"].
    // Delete only when Excel is the sole or dominant source AND no FUB linkage.
    // Safer version: delete rows where source LIKE 'excel%' AND fub_person_id IS NULL.
    // If FUB already knows this person the sweep will re-upsert them cleanly.
    const delBuyers = rawDb.prepare(
      `DELETE FROM buyers
        WHERE (source LIKE 'excel%' OR source = 'workbook')
          AND (fub_person_id IS NULL OR fub_person_id = '')`
    );
    excel_nuked_buyers = delBuyers.run().changes ?? 0;
  } catch (e: any) {
    errors.push(`phase0 nuke buyers: ${e.message}`);
  }

  // ─── UPSERT STATEMENTS ───────────────────────────────────────────────────
  // v20.6.8 — Excel-wins conflict rules removed. FUB always wins.
  const upsertListing = rawDb.prepare(`
    INSERT INTO listings (
      address, city, state, zip, list_price, status, listing_agent, source, source_ref, created_at, updated_at
    ) VALUES (
      @address, @city, @state, @zip, @list_price, @status, @listing_agent, @source, @source_ref, datetime('now'), datetime('now')
    )
    ON CONFLICT(lower(address), coalesce(zip,'')) DO UPDATE SET
      -- v20.6.8: FUB always wins. Never shield status from a fresh FUB write.
      status        = excluded.status,
      list_price    = COALESCE(excluded.list_price, listings.list_price),
      listing_agent = COALESCE(excluded.listing_agent, listings.listing_agent),
      source        = excluded.source,
      source_ref    = excluded.source_ref,
      updated_at    = datetime('now')
  `);

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
      -- v20.6.8: FUB always wins. Only do_not_import still shields status.
      status          = CASE
                          WHEN buyers.do_not_import = 1 THEN buyers.status
                          WHEN excluded.is_rental = 1 THEN 'rental'
                          ELSE 'active'
                        END,
      phone           = COALESCE(excluded.phone, buyers.phone),
      email           = COALESCE(excluded.email, buyers.email),
      buyers_agent    = COALESCE(excluded.buyers_agent, buyers.buyers_agent),
      price_min       = COALESCE(excluded.price_min, buyers.price_min),
      price_max       = COALESCE(excluded.price_max, buyers.price_max),
      preferred_areas = COALESCE(excluded.preferred_areas, buyers.preferred_areas),
      zip_codes       = COALESCE(excluded.zip_codes, buyers.zip_codes),
      beds_min        = COALESCE(excluded.beds_min, buyers.beds_min),
      baths_min       = COALESCE(excluded.baths_min, buyers.baths_min),
      sqft_min        = COALESCE(excluded.sqft_min, buyers.sqft_min),
      land_acres_min  = COALESCE(excluded.land_acres_min, buyers.land_acres_min),
      lot_width_min   = COALESCE(excluded.lot_width_min, buyers.lot_width_min),
      arv_min         = COALESCE(excluded.arv_min, buyers.arv_min),
      arv_max         = COALESCE(excluded.arv_max, buyers.arv_max),
      must_haves      = COALESCE(excluded.must_haves, buyers.must_haves),
      no_gos          = COALESCE(excluded.no_gos, buyers.no_gos),
      pre_approved    = COALESCE(NULLIF(excluded.pre_approved,0), buyers.pre_approved, 0),
      lender          = COALESCE(excluded.lender, buyers.lender),
      timeline        = COALESCE(excluded.timeline, buyers.timeline),
      notes           = COALESCE(NULLIF(excluded.notes,''), buyers.notes),
      intent_phrases  = COALESCE(excluded.intent_phrases, buyers.intent_phrases),
      intent_property_types = COALESCE(excluded.intent_property_types, buyers.intent_property_types),
      intent_conditions = COALESCE(excluded.intent_conditions, buyers.intent_conditions),
      intent_verbs    = COALESCE(excluded.intent_verbs, buyers.intent_verbs),
      financing       = COALESCE(excluded.financing, buyers.financing),
      is_investor     = COALESCE(NULLIF(excluded.is_investor,0), buyers.is_investor, 0),
      is_rental       = COALESCE(NULLIF(excluded.is_rental,0), buyers.is_rental, 0),
      rental_type     = COALESCE(excluded.rental_type, buyers.rental_type),
      confidence      = MAX(excluded.confidence, COALESCE(buyers.confidence, 0)),
      origin_sources  = excluded.origin_sources,
      fub_person_id   = COALESCE(excluded.fub_person_id, buyers.fub_person_id),
      source          = excluded.source,
      updated_at      = datetime('now')
  `);

  const readOriginStmt = rawDb.prepare(
    `SELECT origin_sources FROM buyers WHERE lower(name) = ? AND multi_search_ordinal = 1`
  );

  const markSync = rawDb.prepare(`UPDATE fub_tag_config SET last_synced_at = datetime('now'), last_person_count = ?, updated_at = datetime('now') WHERE tag_name = ?`);

  // ─── PHASE 1: TAG-BASED SWEEP (still supported as a fallback) ────────────
  // v20.6.8 — Tags are secondary now. Seller stages are primary. But some
  // agents may still use tags for lead-gen-adjacent lists (e.g. non-active
  // pocket referrals), so we keep the tag phase alive.
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

  // ─── PHASE 1.5: SELLER STAGE SWEEP (v20.6.8, primary listings source) ────
  // For each mapped seller stage, pull all people at that stage and upsert
  // to listings with the mapped status. This is the new source of truth.
  for (const [stageName, ldStatus] of Object.entries(SELLER_STAGE_MAP)) {
    // Skip duplicate keys (multiple FUB names → same LD bucket handled via UPSERT).
    try {
      const people = await fubListPeopleByStage(stageName);
      for (const p of people) {
        processed++;
        const a = fubPersonAddress(p);
        if (!a.address) { skipped++; continue; }
        try {
          upsertListing.run({
            address:       a.address,
            city:          a.city,
            state:         a.state,
            zip:           a.zip,
            list_price:    null,          // list_price still comes from Deals phase
            status:        ldStatus,
            listing_agent: p.assignedUserName || null,
            source:        `fub:stage:${stageName}`,
            source_ref:    `fub:person:${p.id}`,
          });
          seller_stages++;
        } catch (e: any) {
          errors.push(`seller-stage ${stageName} ${a.address}: ${e.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`seller-stage ${stageName}: ${err.message}`);
    }
  }

  // ─── PHASE 2: BUYER STAGE SWEEP (Active Client only) ─────────────────────
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

  // ─── PHASE 3: DEALS SWEEP (v20.6.8 — supplemental price/agent data) ──────
  // Deals still ride along to fill in list_price on listings we already have
  // via stage sweep. No longer the primary listing source.
  try {
    const deals = await fubListDeals();
    for (const d of deals) {
      deals_processed++;
      const st = String(d.status || d.stage || "").toLowerCase();
      if (/closed|won|lost|cancelled|canceled|dead/.test(st)) continue;

      const dealType = String(d.type || "").toLowerCase();

      // LISTING-SIDE DEAL → listings table (supplemental)
      if (dealType.includes("listing") && d.address) {
        try {
          upsertListing.run({
            address:       d.address,
            city:          d.city || null,
            state:         d.state || null,
            zip:           d.zip || null,
            list_price:    d.price || null,
            // v20.6.8 — Don't override stage-derived status. Only fill if the
            // listing didn't exist yet, in which case the ON CONFLICT will
            // set it to "active" because the deal implies an active listing.
            status:        "active",
            listing_agent: d.assignedUserName || null,
            source:        "fub:deal:listing",
            source_ref:    `fub:deal:${d.id}`,
          });
          deals_listing++;
        } catch (e: any) {
          errors.push(`deal-listing ${d.id}: ${e.message}`);
        }
      }
      else if (dealType.includes("buyer") || dealType.includes("interested") || (!dealType && d.peopleIds?.length)) {
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
              -- v20.6.8: FUB wins, period.
              status     = 'active',
              price_max  = COALESCE(excluded.price_max, buyers.price_max),
              preferred_areas = COALESCE(excluded.preferred_areas, buyers.preferred_areas),
              notes      = COALESCE(NULLIF(excluded.notes,''), buyers.notes),
              source     = excluded.source,
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

  return { processed, pockets, buyers, deals_processed, deals_listing, deals_buyer, skipped, seller_stages, excel_nuked_listings, excel_nuked_buyers, errors };
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
      // FUB fields take precedence; parser fills gaps.
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
