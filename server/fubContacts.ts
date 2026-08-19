// v20.15.0 — Live Follow Up Boss contact picker, backing the Listing Consult
// Prep step's "Find in FUB" search box. FUB's people API has no documented
// name-search parameter (only exact ?email= and a checkDuplicate lookup), so
// we cache the account's people list in memory and search it locally. Cache
// refreshes lazily on first stale search — no cron, no DB table.
import type { Express, Request, Response } from "express";

type FubContact = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
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
    const url = `https://api.followupboss.com/v1/people?limit=${PAGE_LIMIT}&offset=${offset}&fields=id,name,firstName,lastName,emails,phones`;
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
      out.push({
        id: p.id,
        name,
        email: primaryEmail?.value || null,
        phone: primaryPhone?.value || null,
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
