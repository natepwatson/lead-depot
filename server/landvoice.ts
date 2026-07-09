// LandVoice OAuth 2.0 + API client (v14.45 — Phase 1 of Intake v2)
// Auth flow: 3-legged authorization_code. See https://api2.landvoice.com/swagger/v2/swagger.json
// All persistence lives in the `landvoice_credentials` table (single row, id=1).

import { rawDb } from "./db";

const BASE = "https://api2.landvoice.com";
const REDIRECT_URI =
  process.env.LANDVOICE_REDIRECT_URI ||
  "https://depot.watsonbrothersgroup.com/api/admin/landvoice/oauth-callback";
const SCOPE = "readAccess";

type LVCreds = {
  id: number;
  client_id: string;
  client_secret: string;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  connected_at: string;
  last_refresh_at: string | null;
  last_error: string | null;
  is_active: number;
};

// ─── Row helpers ─────────────────────────────────────────────────────────────
export function getCredsRow(): LVCreds | null {
  return (rawDb.prepare("SELECT * FROM landvoice_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get() as LVCreds) || null;
}

export function getConnectionStatus() {
  const row = getCredsRow();
  if (!row) return { connected: false };
  return {
    connected: !!row.refresh_token,
    client_id_last4: row.client_id.slice(-4),
    connected_at: row.connected_at,
    last_refresh_at: row.last_refresh_at,
    last_error: row.last_error,
    has_access_token: !!row.access_token,
    access_expires_at: row.access_token_expires_at,
  };
}

export function saveInitialCreds(client_id: string, client_secret: string) {
  // Deactivate any prior rows and insert fresh
  rawDb.prepare("UPDATE landvoice_credentials SET is_active = 0").run();
  const now = new Date().toISOString();
  const info = rawDb.prepare(`
    INSERT INTO landvoice_credentials
      (client_id, client_secret, connected_at, is_active)
    VALUES (?, ?, ?, 1)
  `).run(client_id, client_secret, now);
  return info.lastInsertRowid as number;
}

export function disconnect() {
  rawDb.prepare("UPDATE landvoice_credentials SET is_active = 0, refresh_token = NULL, access_token = NULL WHERE is_active = 1").run();
}

// ─── OAuth flow ──────────────────────────────────────────────────────────────
export function getAuthorizeUrl(state: string): string {
  const row = getCredsRow();
  if (!row) throw new Error("LandVoice credentials not yet configured. Save client_id/client_secret first.");
  const qs = new URLSearchParams({
    client_id: row.client_id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return `${BASE}/Oauth/Authorize?${qs.toString()}`;
}

export async function exchangeCodeForTokens(code: string) {
  const row = getCredsRow();
  if (!row) throw new Error("LandVoice credentials row missing");
  const qs = new URLSearchParams({
    client_id: row.client_id,
    client_secret: row.client_secret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const resp = await fetch(`${BASE}/Oauth/Access?${qs.toString()}`, { method: "POST" });
  const body = await resp.text();
  if (!resp.ok) {
    rawDb.prepare("UPDATE landvoice_credentials SET last_error = ? WHERE id = ?").run(`exchange_code failed: HTTP ${resp.status} — ${body.slice(0, 500)}`, row.id);
    throw new Error(`LandVoice /Oauth/Access ${resp.status}: ${body.slice(0, 300)}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  const access = parsed.access_token || parsed.accessToken;
  const refresh = parsed.refresh_token || parsed.refreshToken;
  const expiresInSec = Number(parsed.expires_in || parsed.expiresIn || 3600);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const now = new Date().toISOString();
  rawDb.prepare(`
    UPDATE landvoice_credentials
    SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, last_refresh_at = ?, last_error = NULL
    WHERE id = ?
  `).run(access, refresh, expiresAt, now, row.id);
  return { access_token: access, refresh_token: refresh, expires_at: expiresAt };
}

export async function refreshAccessToken(): Promise<string> {
  const row = getCredsRow();
  if (!row) throw new Error("LandVoice credentials row missing");
  if (!row.refresh_token) throw new Error("No refresh_token stored — reconnect required.");
  const qs = new URLSearchParams({
    client_id: row.client_id,
    client_secret: row.client_secret,
    refresh_token: row.refresh_token,
    grant_type: "refresh_token",
  });
  const resp = await fetch(`${BASE}/Oauth/Refresh?${qs.toString()}`, { method: "POST" });
  const body = await resp.text();
  if (!resp.ok) {
    rawDb.prepare("UPDATE landvoice_credentials SET last_error = ? WHERE id = ?").run(`refresh failed: HTTP ${resp.status} — ${body.slice(0, 500)}`, row.id);
    throw new Error(`LandVoice /Oauth/Refresh ${resp.status}: ${body.slice(0, 300)}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  const access = parsed.access_token || parsed.accessToken;
  const newRefresh = parsed.refresh_token || parsed.refreshToken || row.refresh_token;
  const expiresInSec = Number(parsed.expires_in || parsed.expiresIn || 3600);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const now = new Date().toISOString();
  rawDb.prepare(`
    UPDATE landvoice_credentials
    SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, last_refresh_at = ?, last_error = NULL
    WHERE id = ?
  `).run(access, newRefresh, expiresAt, now, row.id);
  return access;
}

// Ensures we hold a valid access_token, refreshing if expired within 60s.
export async function ensureAccessToken(): Promise<string> {
  const row = getCredsRow();
  if (!row) throw new Error("LandVoice not connected");
  const hasToken = !!row.access_token;
  const exp = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  const stale = exp - Date.now() < 60_000;
  if (!hasToken || stale) return await refreshAccessToken();
  return row.access_token!;
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function authedFetch(path: string, params: Record<string, string | number | undefined>) {
  const token = await ensureAccessToken();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = `${BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`LandVoice ${path} ${resp.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return body; }
}

export async function whoAmI() {
  return authedFetch("/Oauth/Me", {});
}

export type ExpiredQuery = {
  beginDate?: string; // yyyy-MM-dd
  endDate?: string;
  DateSearchSource?: "MLSExpired" | "LandVoiceIngested";
  beds?: number;
  baths?: number;
  squareFeet?: number;
  minPrice?: number;
  maxPrice?: number;
  status?: "Active" | "Sold" | "Expired" | "Withdrawn";
  page?: number;
  pageSize?: number;
};

export async function fetchExpired(q: ExpiredQuery = {}) {
  return authedFetch("/api/Expired", q as any);
}

export async function fetchFsbo(q: Omit<ExpiredQuery, "DateSearchSource" | "status"> & { postalCode?: string } = {}) {
  return authedFetch("/api/Fsbo", q as any);
}

export async function fetchPreForeclosure(q: {
  beginDate?: string; endDate?: string; beds?: number; baths?: number; squareFeet?: number; postalCode?: string; page?: number; pageSize?: number;
} = {}) {
  return authedFetch("/api/PreForeclosure", q as any);
}
