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

// v20.6.9 — Reality-check: Denise doesn't use FUB "stages" for listings. She
// uses TAGS. So the seller-side authoritative signal is TAG membership, not
// stage. Alex's rule 8/4/26: "Stage: then deals. It has to be either buyer
// or seller." Interpretation: use tags/stages to CLASSIFY the person as
// buyer or seller, then use deals to fill in property address/price.
//
// Seller-classifying tags → LD listing status bucket.
// v20.6.9 — FUB tag lookup via the /people?tags= endpoint is case-sensitive on
// the URL param. Keys here are the EXACT casing Denise uses in FUB (audited
// via /api/admin/fub/tags on 8/4/26). If a variant appears with different
// casing, add a new key rather than lowercasing — FUB won't return people if
// the case doesn't match.
const SELLER_TAG_MAP: Record<string, "pocket" | "coming_soon" | "active" | "sold"> = {
  // POCKET listings — Denise's two live tags for these
  "Pocket Listing":     "pocket",
  "pocket-listing":     "pocket",
  "Off Market Listing": "pocket",
  // COMING SOON — no live tag today, leave the mapping in case Denise adds
  "Coming Soon":        "coming_soon",
  "coming-soon":        "coming_soon",
  // ACTIVE listing — no live tag today; comes from the Deals phase
  "Active Listing":     "active",
  "active-listing":     "active",
  "Listed":             "active",
  // SOLD — no live tag today; comes from closed deals
  "Closed - Sold":      "sold",
  "closed-sold":        "sold",
  "Sold":               "sold",
  // Generic seller — Denise's "seller" tag classifies the person; deals will
  // upgrade the bucket to "active" if a listing deal exists. Default to
  // "pocket" (safest — doesn't imply MLS live).
  "seller":             "pocket",
};

// v20.6.9 — Kept for backward compat but no longer primary; some seller
// people may have moved to a stage rather than a tag.
const SELLER_STAGE_MAP: Record<string, "pocket" | "coming_soon" | "active" | "sold"> = {
  "pocket":           "pocket",
  "pocket listing":   "pocket",
  "coming soon":      "coming_soon",
  "active listing":   "active",
  "listed":           "active",
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

  // ─── PHASE 1.5: SELLER CLASSIFICATION SWEEP (v20.6.9) ────────────────────
  // Primary listings source. Pulls people classified as sellers via TAGS
  // (real Denise workflow) OR STAGES (fallback for anyone Denise moved
  // through a stage). Upserts to listings with the mapped LD status. The
  // deals phase then enriches list_price on the same address.
  //
  // TAG phase
  for (const [tagName, ldStatus] of Object.entries(SELLER_TAG_MAP)) {
    try {
      const people = await fubListPeopleByTag(tagName);
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
            source:        `fub:seller-tag:${tagName}`,
            source_ref:    `fub:person:${p.id}`,
          });
          seller_stages++;
        } catch (e: any) {
          errors.push(`seller-tag ${tagName} ${a.address}: ${e.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`seller-tag ${tagName}: ${err.message}`);
    }
  }

  // STAGE phase (kept as safety net for people Denise moved to a stage)
  for (const [stageName, ldStatus] of Object.entries(SELLER_STAGE_MAP)) {
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
            list_price:    null,
            status:        ldStatus,
            listing_agent: p.assignedUserName || null,
            source:        `fub:seller-stage:${stageName}`,
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

  // ─── PHASE 3: DEALS SWEEP (v20.7.4 — DEALS ARE NOW AUTHORITATIVE) ────────
  //
  // Ground truth from /api/admin/fub/deals-diagnostic on 8/4/26:
  //   • 6 real deal stages: Listed(14), Pending(6), Closed(67),
  //     Interested(29), Offering(2), Nurture(51).
  //   • deal.type is EMPTY on all 169 deals → can't tell seller vs buyer from
  //     the deal record alone.
  //   • deal.address is NULL on the samples → address lives on the linked
  //     Person, not the deal.
  //
  // Strategy per Alex 8/4/26:
  //   • Build a seller-people index from the Phase 1 seller tags (Pocket
  //     Listing / seller / etc). Any deal whose peopleIds intersects with a
  //     seller-tagged person is a SELLER-SIDE deal → goes to listings table.
  //     Everything else is buyer-side → goes to buyers table.
  //   • Stage → LD status mapping (deals override person-tag/stage bucketing):
  //       Listed    → status="active"    (seller, on-MLS)
  //       Pending   → status="pending"   (seller) OR active buyer
  //       Closed    → status="sold"      (seller) OR closed buyer
  //       Offering  → active buyer (someone we're writing offers for)
  //       Interested→ active buyer
  //       Nurture   → SKIP (long-tail, not inventory)
  //
  // The join uses fubListPeopleByTag results already fetched in Phase 1 — no
  // extra FUB API roundtrips per deal.

  // Build seller-person-id index from Phase 1 tag results. Re-fetching by tag
  // is cheap because fub.ts caches within a single sweep and the SELLER_TAG_MAP
  // is small.
  const sellerPersonIndex = new Map<string, any>(); // fubPersonId → person
  try {
    for (const tagName of Object.keys(SELLER_TAG_MAP)) {
      const people = await fubListPeopleByTag(tagName);
      for (const p of people) sellerPersonIndex.set(String(p.id), p);
    }
    // Also add anyone matched to a seller STAGE (Phase 1.5 secondary).
    for (const stageName of Object.keys(SELLER_STAGE_MAP)) {
      const people = await fubListPeopleByStage(stageName);
      for (const p of people) sellerPersonIndex.set(String(p.id), p);
    }
  } catch (err: any) {
    errors.push(`seller-person index build: ${err.message}`);
  }

  // Deal stage → LD listing status (seller side). Missing = skip for listings.
  const DEAL_STAGE_SELLER_STATUS: Record<string, "active" | "pending" | "sold"> = {
    "Listed":  "active",
    "Pending": "pending",
    "Closed":  "sold",
  };

  try {
    const deals = await fubListDeals();
    for (const d of deals) {
      deals_processed++;
      const stage = String(d.stage || "").trim();

      // Nurture is long-tail; not inventory. Skip.
      if (stage.toLowerCase() === "nurture") continue;

      // Route: does this deal touch a seller-tagged person?
      const personIds = (d.peopleIds || []).map(String);
      const sellerPerson = personIds.map(id => sellerPersonIndex.get(id)).find(Boolean);

      // ─── SELLER-SIDE DEAL → listings table ────────────────────────────────
      if (sellerPerson && DEAL_STAGE_SELLER_STATUS[stage]) {
        const ldStatus = DEAL_STAGE_SELLER_STATUS[stage];
        // Address always comes from the linked seller PERSON (deals don't
        // carry one). Fall back to the deal-embedded address if the person
        // has no address (unusual but possible).
        const personAddr = fubPersonAddress(sellerPerson);
        const address = personAddr.address || d.address || null;
        if (!address) { skipped++; continue; }
        try {
          upsertListing.run({
            address:       address,
            city:          personAddr.city  || d.city  || null,
            state:         personAddr.state || d.state || null,
            zip:           personAddr.zip   || d.zip   || null,
            list_price:    d.price || null,
            status:        ldStatus,
            listing_agent: d.assignedUserName || sellerPerson.assignedUserName || null,
            source:        `fub:deal:${stage.toLowerCase()}`,
            source_ref:    `fub:deal:${d.id}`,
          });
          deals_listing++;
        } catch (e: any) {
          errors.push(`deal-listing ${d.id} (${stage}): ${e.message}`);
        }
        continue;
      }

      // ─── BUYER-SIDE DEAL → buyers table ───────────────────────────────────
      // Any active-flow stage (Interested, Offering, Pending w/o seller person)
      // becomes an active buyer. Closed → closed buyer. Nurture already
      // skipped above.
      const isBuyerActive = /^(Interested|Offering|Pending)$/i.test(stage);
      const isBuyerClosed = /^Closed$/i.test(stage);
      if (!isBuyerActive && !isBuyerClosed) continue;

      const personId = personIds[0];
      if (!personId) { skipped++; continue; }

      try {
        const name = d.name || `FUB Deal ${d.id}`;
        const buyerStatus = isBuyerClosed ? "closed" : "active";
        rawDb.prepare(`
          INSERT INTO buyers (
            name, phone, email, buyers_agent, status,
            price_min, price_max, preferred_areas,
            multi_search_ordinal,
            source, source_ref, fub_person_id, last_updated_by, notes,
            created_at, updated_at
          ) VALUES (
            @name, NULL, NULL, @agent, @status,
            NULL, @price, @area,
            1,
            'fub:deal:buyer', @sref, @fub_pid, 'fub-sweep', @notes,
            datetime('now'), datetime('now')
          )
          ON CONFLICT(lower(name), multi_search_ordinal) DO UPDATE SET
            status     = excluded.status,
            price_max  = COALESCE(excluded.price_max, buyers.price_max),
            preferred_areas = COALESCE(excluded.preferred_areas, buyers.preferred_areas),
            notes      = COALESCE(NULLIF(excluded.notes,''), buyers.notes),
            source     = excluded.source,
            updated_at = datetime('now')
        `).run({
          name,
          agent:  d.assignedUserName || null,
          status: buyerStatus,
          price:  d.price || null,
          area:   d.city || null,
          sref:   `fub:deal:${d.id}`,
          fub_pid: String(personId),
          notes:  d.address ? `Target: ${d.address}` : null,
        });
        deals_buyer++;
      } catch (e: any) {
        errors.push(`deal-buyer ${d.id} (${stage}): ${e.message}`);
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
