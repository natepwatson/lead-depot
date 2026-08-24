// v20.15.0 — Live Follow Up Boss contact picker, backing the Listing Consult
// Prep step's "Find in FUB" search box. FUB's people API has no documented
// name-search parameter (only exact ?email= and a checkDuplicate lookup), so
// we cache the account's people list in memory and search it locally. Cache
// refreshes lazily on first stale search — no cron, no DB table.
import type { Express, Request, Response } from "express";

type FubAddress = { street: string; city: string | null; state: string | null; zip: string | null; label: string | null };

type FubContact = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  // v20.14.7 — on-file address, used by the "Contingent on Home Sale" FUB
  // lookup in Place an Offer to pull a buyer's current home address when
  // it's already logged in FUB, instead of retyping it.
  // v20.32.14 — kept for backward compat (first/primary address as a flat
  // string); ALSO see `addresses` below, which carries every address FUB
  // has on file for this person. A client can own multiple properties
  // (e.g. an out-of-state primary residence plus a local vacant lot) —
  // callers must let the agent pick which one a given consult is about
  // instead of silently assuming the primary/first address is correct.
  address: string | null;
  addresses: FubAddress[];
};

let cache: FubContact[] = [];
let lastFetchedAt = 0;
let fetchingPromise: Promise<void> | null = null;

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — long enough to avoid hammering FUB, short enough that new contacts show up same-day
const PAGE_LIMIT = 100;
const MAX_PAGES = 40; // hard cap ~4,000 contacts so a huge account can't hang a request forever
const FETCH_BUDGET_MS = 20000;

function fubAuthHeader(): string {
  const key = process.env.FUB_API_KEY || "";
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

async function fetchAllContacts(): Promise<FubContact[]> {
  const key = process.env.FUB_API_KEY;
  if (!key) return [];
  const out: FubContact[] = [];
  let offset = 0;
  const start = Date.now();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - start > FETCH_BUDGET_MS) break;
    const url = `https://api.followupboss.com/v1/people?limit=${PAGE_LIMIT}&offset=${offset}&fields=id,name,firstName,lastName,emails,phones,addresses`;
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: fubAuthHeader() },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    const body: any = await res.json().catch(() => ({}));
    const people: any[] = body?.people || [];
    for (const p of people) {
      const name: string = p.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || "";
      if (!name) continue;
      const emails: any[] = p.emails || [];
      const phones: any[] = p.phones || [];
      const primaryEmail = emails.find((e) => e.isPrimary) || emails[0];
      const primaryPhone = phones.find((ph) => ph.isPrimary) || phones[0];
      const rawAddresses: any[] = p.addresses || [];
      const primaryAddress = rawAddresses.find((a) => a.isPrimary) || rawAddresses[0];
      const addressStr = primaryAddress
        ? [primaryAddress.street, [primaryAddress.city, primaryAddress.state].filter(Boolean).join(", "), primaryAddress.code]
            .filter(Boolean).join(", ")
        : null;
      // v20.32.14 — carry every on-file address (not just the primary/first)
      // so a multi-property client (e.g. Ross Wood: Colorado home + a
      // Jacksonville vacant lot) can be picked correctly instead of the
      // consult always defaulting to whichever address FUB lists first.
      const allAddresses: FubAddress[] = rawAddresses
        .filter((a) => a && a.street)
        .map((a) => ({
          street: String(a.street).trim(),
          city: a.city ? String(a.city).trim() : null,
          state: a.state ? String(a.state).trim() : null,
          zip: a.code ? String(a.code).trim() : null,
          label: a.isPrimary ? "Primary" : (a.type ? String(a.type) : null),
        }));
      out.push({
        id: p.id,
        name,
        email: primaryEmail?.value || null,
        phone: primaryPhone?.value || null,
        address: addressStr || null,
        addresses: allAddresses,
      });
    }
    const total = body?._metadata?.total ?? 0;
    offset += PAGE_LIMIT;
    if (people.length < PAGE_LIMIT || offset >= total) break;
  }
  return out;
}

async function ensureFresh(): Promise<void> {
  const stale = Date.now() - lastFetchedAt > CACHE_TTL_MS;
  if (!stale && cache.length > 0) return;
  if (fetchingPromise) return fetchingPromise;
  fetchingPromise = (async () => {
    try {
      const fresh = await fetchAllContacts();
      if (fresh.length > 0) {
        cache = fresh;
        lastFetchedAt = Date.now();
      }
      // If the fetch came back empty (API hiccup, key issue), keep serving
      // whatever cache we already have rather than wiping it — lastFetchedAt
      // stays old so the next search retries the refresh.
    } finally {
      fetchingPromise = null;
    }
  })();
  return fetchingPromise;
}

export function registerFubContactsRoutes(app: Express) {
  app.get("/api/fub/contacts/search", async (req: Request, res: Response) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json({ results: [] });
    try {
      await ensureFresh();
    } catch {
      // serve whatever cache we have
    }
    const results = cache.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20);
    res.json({ results, cacheSize: cache.length, cacheAgeMs: cache.length ? Date.now() - lastFetchedAt : null });
  });

  // Manual force-refresh, e.g. right after adding a brand-new FUB contact
  // mid-appointment and wanting them searchable immediately.
  app.post("/api/fub/contacts/refresh", async (_req: Request, res: Response) => {
    lastFetchedAt = 0;
    try {
      await ensureFresh();
      res.json({ ok: true, cacheSize: cache.length });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
