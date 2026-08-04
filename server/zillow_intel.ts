// v19.0 — Zillow public-page scraper. No API key required.
// Approach: hit https://www.zillow.com/homes/{address-slug}_rb/ with a realistic
// user-agent, parse the __NEXT_DATA__ JSON blob if present, else regex-scrape
// the visible page for price / beds / baths / sqft. Cache successful lookups
// for 24 hours in zillow_intel table. Return { hit: false } on any failure so
// the UI degrades gracefully.

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";

export function ensureZillowSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS zillow_intel (
      address_key TEXT PRIMARY KEY,      -- lowercased "street|city|state|zip"
      zpid TEXT,
      price TEXT,
      beds TEXT,
      baths TEXT,
      sqft TEXT,
      photo_url TEXT,
      zillow_url TEXT,
      raw_json TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_zillow_fetched ON zillow_intel(fetched_at);
  `);
}

function slugAddr(street: string, city: string, state: string, zip: string): string {
  const s = [street, city, state, zip].filter(Boolean).join(" ")
    .replace(/[,#]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9\-]/g, "");
  return s.toLowerCase();
}

function addrKey(street: string, city: string, state: string, zip: string): string {
  return [street || "", city || "", state || "", zip || ""].join("|").toLowerCase().trim();
}

interface ZillowIntel {
  hit: boolean;
  zpid?: string | null;
  price?: string | null;
  beds?: string | null;
  baths?: string | null;
  sqft?: string | null;
  photoUrl?: string | null;
  zillowUrl?: string | null;
  cached?: boolean;
  fetchedAt?: string | null;
  error?: string;
}

async function scrapeZillow(street: string, city: string, state: string, zip: string): Promise<ZillowIntel> {
  const slug = slugAddr(street, city, state, zip);
  if (!slug || slug.length < 5) return { hit: false, error: "invalid_address" };

  const url = `https://www.zillow.com/homes/${slug}_rb/`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
    });
    clearTimeout(timeoutId);

    if (!resp.ok) return { hit: false, error: `http_${resp.status}` };
    const html = await resp.text();

    // Zillow blocks with a captcha page ("Please verify you're a human").
    if (html.includes("Please verify you're a human") || html.includes("px-captcha")) {
      return { hit: false, error: "captcha_blocked" };
    }

    // Strategy 1: __NEXT_DATA__ JSON blob.
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    let intel: ZillowIntel = { hit: false, zillowUrl: url };

    if (nextMatch) {
      try {
        const j = JSON.parse(nextMatch[1]);
        // Walk pageProps.componentProps.gdpClientCache -> string keyed by zpid
        const cache = j?.props?.pageProps?.componentProps?.gdpClientCache;
        if (cache && typeof cache === "string") {
          const inner = JSON.parse(cache);
          const firstKey = Object.keys(inner)[0];
          const prop = firstKey ? inner[firstKey]?.property : null;
          if (prop) {
            intel = {
              hit: true,
              zpid: prop.zpid ? String(prop.zpid) : null,
              price: prop.price != null ? `$${Number(prop.price).toLocaleString()}` : (prop.priceHistory?.[0]?.price ? `$${Number(prop.priceHistory[0].price).toLocaleString()}` : null),
              beds: prop.bedrooms != null ? String(prop.bedrooms) : null,
              baths: prop.bathrooms != null ? String(prop.bathrooms) : null,
              sqft: prop.livingArea != null ? String(prop.livingArea) : null,
              photoUrl: prop.hiResImageLink || prop.desktopWebHdpImageLink || (Array.isArray(prop.responsivePhotos) && prop.responsivePhotos[0]?.mixedSources?.jpeg?.[0]?.url) || null,
              zillowUrl: prop.hdpUrl ? `https://www.zillow.com${prop.hdpUrl}` : url,
            };
          }
        }
      } catch { /* fall through to regex */ }
    }

    // Strategy 2: regex fallback on visible page for price and beds/baths/sqft.
    if (!intel.hit) {
      const priceMatch = html.match(/"price":\s*(\d+)[\s,}]/) || html.match(/\$([\d,]+)<\/span>/);
      const bedsMatch = html.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed|beds?)</i);
      const bathsMatch = html.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|baths?)</i);
      const sqftMatch = html.match(/([\d,]+)\s*(?:sqft|Sq\.?\s?Ft\.?)/i);
      const zpidMatch = html.match(/"zpid":\s*"?(\d+)"?/);

      if (priceMatch || bedsMatch || bathsMatch || sqftMatch) {
        intel = {
          hit: true,
          zpid: zpidMatch?.[1] || null,
          price: priceMatch ? (priceMatch[0].startsWith("$") ? `$${priceMatch[1]}` : `$${Number(priceMatch[1]).toLocaleString()}`) : null,
          beds: bedsMatch?.[1] || null,
          baths: bathsMatch?.[1] || null,
          sqft: sqftMatch?.[1] || null,
          photoUrl: null,
          zillowUrl: url,
        };
      }
    }

    if (!intel.hit) return { hit: false, error: "no_match" };
    return intel;
  } catch (err: any) {
    return { hit: false, error: `fetch_error:${err?.message || "unknown"}` };
  }
}

const CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function registerZillowRoutes(app: Express) {
  ensureZillowSchema();

  app.get("/api/zillow/intel", async (req: Request, res: Response) => {
    const street = String(req.query.address || req.query.street || "").trim();
    const city = String(req.query.city || "").trim();
    const state = String(req.query.state || "").trim();
    const zip = String(req.query.zip || "").trim();
    if (!street) return res.status(400).json({ error: "address required" });

    const key = addrKey(street, city, state, zip);
    const cached = rawDb.prepare(`SELECT * FROM zillow_intel WHERE address_key = ?`).get(key) as any;
    if (cached && cached.fetched_at && (Date.now() - Date.parse(cached.fetched_at) < CACHE_MS)) {
      return res.json({
        hit: true, cached: true, fetchedAt: cached.fetched_at,
        zpid: cached.zpid, price: cached.price, beds: cached.beds, baths: cached.baths,
        sqft: cached.sqft, photoUrl: cached.photo_url, zillowUrl: cached.zillow_url,
      });
    }

    const intel = await scrapeZillow(street, city, state, zip);
    if (intel.hit) {
      const now = new Date().toISOString();
      try {
        rawDb.prepare(`
          INSERT INTO zillow_intel (address_key, zpid, price, beds, baths, sqft, photo_url, zillow_url, raw_json, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(address_key) DO UPDATE SET
            zpid = excluded.zpid, price = excluded.price, beds = excluded.beds,
            baths = excluded.baths, sqft = excluded.sqft, photo_url = excluded.photo_url,
            zillow_url = excluded.zillow_url, fetched_at = excluded.fetched_at
        `).run(key, intel.zpid || null, intel.price || null, intel.beds || null, intel.baths || null,
          intel.sqft || null, intel.photoUrl || null, intel.zillowUrl || null, null, now);
      } catch (e) {
        console.warn("[zillow_intel] cache write failed", e);
      }
      return res.json({ ...intel, cached: false, fetchedAt: now });
    }
    // Cache negative for 6 hours to avoid hammering
    const now = new Date().toISOString();
    try {
      rawDb.prepare(`
        INSERT INTO zillow_intel (address_key, zillow_url, fetched_at)
        VALUES (?, ?, ?)
        ON CONFLICT(address_key) DO UPDATE SET fetched_at = excluded.fetched_at
      `).run(key, `https://www.zillow.com/homes/${slugAddr(street, city, state, zip)}_rb/`, now);
    } catch {}
    res.json({ hit: false, cached: false, error: intel.error || "not_found", fetchedAt: now });
  });
}
