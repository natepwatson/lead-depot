// server/auth.ts — Phase A (v14.58): password hashing + server-side sessions.
//
// Design goals:
//  1. bcryptjs for password hashing (pure JS, no native compile).
//     Uses the existing `agents.password` column — a bcrypt hash begins with
//     "$2" so a boot migration can detect any legacy plaintext row and hash
//     it in place. Login accepts EITHER a bcrypt match OR a legacy plaintext
//     match (auto-upgrading on the fly) for one deploy so nobody gets locked
//     out mid-flight. Legacy fallback will be removed in v14.59.
//
//  2. Opaque server-side sessions stored in the `sessions` table.
//     Login mints a 32-byte token, stores it hashed, sets an httpOnly cookie
//     (`sd_session=<token>`). Server middleware reads the cookie, looks up
//     the session, attaches `req.session` and `req.currentAgent`.
//
//  3. Zero touches to routing / assignment / home-county / PULL MODE /
//     round-robin / my-next / my-count SQL. This module is auth only.
//
// Cookie flags:
//   httpOnly ..... always
//   secure ....... in production only (Railway serves via HTTPS)
//   sameSite ..... "lax" (works with same-origin + top-level nav)
//   path ......... "/"
//   maxAge ....... 30 days (matches expires_at)

import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { rawDb } from "./db";

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_DAYS = 30;
export const SESSION_COOKIE = "sd_session";

// ─── SCHEMA ────────────────────────────────────────────────────────────────

export function initAuthSchema() {
  // Sessions table — opaque tokens, one row per active login.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
  `);
}

// ─── PASSWORD HELPERS ──────────────────────────────────────────────────────

function isBcryptHash(s: string | null | undefined): boolean {
  if (!s || typeof s !== "string") return false;
  return /^\$2[abxy]?\$\d{2}\$/.test(s);
}

export async function hashPassword(plaintext: string): Promise<string> {
  return await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

// Legacy-tolerant compare. Returns { ok, needsRehash }.
//   ok           .. true if password matches (either bcrypt or legacy plaintext)
//   needsRehash  .. true if the stored value was legacy plaintext and the
//                   caller should rehash + persist to convert.
export async function verifyPassword(plaintext: string, stored: string | null | undefined): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (!stored || typeof stored !== "string" || !plaintext) return { ok: false, needsRehash: false };
  if (isBcryptHash(stored)) {
    try {
      const ok = await bcrypt.compare(plaintext, stored);
      return { ok, needsRehash: false };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }
  // Legacy plaintext row — string equality with constant-ish guard.
  // (Timing side-channel is negligible for our internal 10-user portal, but
  //  we bcrypt-hash immediately on success to fix it.)
  const ok = stored === plaintext;
  return { ok, needsRehash: ok };
}

// Boot migration — one-time on server start.
// Hashes any row in `agents` whose `password` doesn't look like a bcrypt hash.
export async function migrateLegacyPasswords(): Promise<{ migrated: number; alreadyHashed: number }> {
  const rows = rawDb.prepare(`SELECT id, password FROM agents WHERE password IS NOT NULL`).all() as { id: number; password: string }[];
  let migrated = 0;
  let alreadyHashed = 0;
  const upd = rawDb.prepare(`UPDATE agents SET password = ? WHERE id = ?`);
  for (const r of rows) {
    if (isBcryptHash(r.password)) { alreadyHashed++; continue; }
    if (!r.password) continue;
    const h = await bcrypt.hash(r.password, BCRYPT_ROUNDS);
    upd.run(h, r.id);
    migrated++;
  }
  return { migrated, alreadyHashed };
}

// ─── SESSION HELPERS ───────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createSession(agentId: number, meta: { userAgent?: string; ip?: string } = {}): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url"); // 43-char URL-safe
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  rawDb.prepare(`
    INSERT INTO sessions (agent_id, token_hash, created_at, expires_at, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agentId, tokenHash, now.toISOString(), expiresAt.toISOString(), meta.userAgent ?? null, meta.ip ?? null);
  return { token, expiresAt: expiresAt.toISOString() };
}

export interface SessionRow {
  id: number;
  agent_id: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export function lookupSession(token: string | null | undefined): SessionRow | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = rawDb.prepare(`
    SELECT id, agent_id, created_at, expires_at, revoked_at
      FROM sessions
     WHERE token_hash = ?
     LIMIT 1
  `).get(tokenHash) as SessionRow | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function revokeSession(token: string) {
  const tokenHash = sha256(token);
  rawDb.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(new Date().toISOString(), tokenHash);
}

export function revokeAllSessionsForAgent(agentId: number) {
  rawDb.prepare(`UPDATE sessions SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), agentId);
}

// Best-effort cleanup — deletes rows expired more than 7 days ago so the
// table doesn't grow forever. Called on boot after migration.
export function purgeOldSessions() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  rawDb.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(cutoff);
}

// ─── COOKIE HELPERS ────────────────────────────────────────────────────────

export function setSessionCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      session?: SessionRow;
      currentAgent?: { id: number; role: string; name: string; email: string };
    }
  }
}

// Attaches req.session + req.currentAgent if a valid session cookie is present.
// Non-blocking — routes that need auth check req.session themselves.
export function attachSession(req: Request, _res: Response, next: NextFunction) {
  const token = (req as any).cookies?.[SESSION_COOKIE];
  const session = lookupSession(token);
  if (session) {
    req.session = session;
    const a = rawDb.prepare(`SELECT id, role, name, email, is_active FROM agents WHERE id = ?`).get(session.agent_id) as any;
    if (a && a.is_active) {
      req.currentAgent = { id: a.id, role: a.role, name: a.name, email: a.email };
    }
  }
  next();
}

// Guards — call these inside a route to enforce a policy.
export function requireSession(req: Request, res: Response): boolean {
  if (!req.currentAgent) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

export function requireSelfOrAdmin(req: Request, res: Response, targetAgentId: number): boolean {
  if (!req.currentAgent) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  if (req.currentAgent.id === targetAgentId) return true;
  if (req.currentAgent.role === "admin") return true;
  res.status(403).json({ error: "Forbidden" });
  return false;
}

export function requireAdmin(req: Request, res: Response): boolean {
  if (!req.currentAgent) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  if (req.currentAgent.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return false;
  }
  return true;
}
