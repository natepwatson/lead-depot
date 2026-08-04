// v20.4.8 — Nightly FUB sweep for Inventory bucket tags.
// Reads fub_tag_config, pulls people for each enabled tag, and upserts into
// listings (bucket=pocket_listing) or buyers (bucket=active_buyer).

import { rawDb } from "./db";
import { fubListPeopleByTag, fubPersonAddress, fubPersonBuyerPrefs } from "./fub";

type TagConfig = {
  tag_name: string;
  bucket: "pocket_listing" | "active_buyer" | "ignore";
  enabled: number;
};

export async function runFubInventorySweep(): Promise<{ processed: number; pockets: number; buyers: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0, pockets = 0, buyers = 0, skipped = 0;

  const tags = rawDb.prepare(`SELECT tag_name, bucket, enabled FROM fub_tag_config WHERE enabled = 1 AND bucket IN ('pocket_listing','active_buyer')`).all() as TagConfig[];
  if (!tags.length) {
    return { processed, pockets, buyers, skipped, errors };
  }

  const upsertListing = rawDb.prepare(`
    INSERT INTO listings (
      address, city, state, zip, list_price, status, listing_agent, source, source_ref, created_at, updated_at
    ) VALUES (
      @address, @city, @state, @zip, @list_price, 'pocket', @listing_agent, @source, @source_ref, datetime('now'), datetime('now')
    )
    ON CONFLICT(lower(address), coalesce(zip,'')) DO UPDATE SET
      status = CASE
        WHEN listings.source = 'excel' THEN listings.status  -- Excel wins
        ELSE 'pocket'
      END,
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
      -- Excel wins for existing buyers; only fill nulls from FUB
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
              listing_agent: p.assignedUserName || null,
              source:        `fub:${cfg.tag_name}`,
              source_ref:    `fub:person:${p.id}`,
            });
            pockets++;
          } catch (e: any) {
            errors.push(`pocket ${a.address}: ${e.message}`);
          }
        } else if (cfg.bucket === "active_buyer") {
          const name = (p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim()).trim();
          if (!name) { skipped++; continue; }
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
              source:          `fub:${cfg.tag_name}`,
              source_ref:      `fub:person:${p.id}`,
              fub_person_id:   String(p.id),
            });
            buyers++;
          } catch (e: any) {
            errors.push(`buyer ${name}: ${e.message}`);
          }
        }
      }
    } catch (err: any) {
      errors.push(`tag ${cfg.tag_name}: ${err.message}`);
    }
  }

  return { processed, pockets, buyers, skipped, errors };
}
