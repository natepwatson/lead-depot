// scripts/certify/lib.mjs — shared helpers for the Certify QA program
//
// One place for: env, colors, HTTP helpers, admin session, result recording,
// fixture identifiers. Every tier imports from here so behavior is consistent.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

export const BASE           = process.env.BASE || 'https://depot.watsonbrothersgroup.com';
export const ADMIN_EMAIL    = process.env.LD_EMAIL || 'nate@watsonbrothersgroup.com';
// v15.11.28 — Nate's actual admin password. The prior default 'brothers2028Xyz!' was
// stale (Nate rotated to TopProducer2026), which caused the 3 AM nightly certify cron
// to 401 on every admin-gated check. Keep this in sync when Nate's password rotates.
export const ADMIN_PASSWORD = process.env.LD_PASS  || 'TopProducer2026';
export const EXPECT_VERSION = process.env.EXPECT_VERSION || null;

// Fixture markers. Any agent or lead created by certify carries is_test=1
// so the /admin/purge-test-data endpoint can safely wipe them.
export const TEST_LEAD_PHONE_BASE = '5550100';      // 555-01xx reserved range
export const TEST_LEAD_ADDR_PREFIX = '__CERTIFY_TEST__';
export const TEST_AGENT_EMAIL_PREFIX = 'certify-test-';

export const T = {
  RED: '\x1b[31m', GREEN: '\x1b[32m', YEL: '\x1b[33m',
  DIM: '\x1b[2m',  RST:   '\x1b[0m', BOLD: '\x1b[1m',
  CYAN:'\x1b[36m', MAG:   '\x1b[35m',
};
export const badge = (s) =>
  s === 'pass' ? `${T.GREEN}✅${T.RST}` :
  s === 'fail' ? `${T.RED}❌${T.RST}` :
  s === 'skip' ? `${T.DIM}⏭${T.RST}` :
                 `${T.YEL}⚠️${T.RST}`;

// ─── Result recorder ───────────────────────────────────────────────────────
export function makeRecorder(tierName) {
  const results = [];
  return {
    add(name, status, { critical = false, detail = '', durationMs = 0 } = {}) {
      results.push({ tier: tierName, name, status, critical, detail, durationMs });
    },
    all() { return results; },
    summary() {
      const pass = results.filter(r => r.status === 'pass').length;
      const fail = results.filter(r => r.status === 'fail').length;
      const skip = results.filter(r => r.status === 'skip').length;
      const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
      return { pass, fail, skip, critFail, total: results.length };
    },
  };
}

// ─── Native fetch wrapper with cookie jar ──────────────────────────────────
export function makeJar() {
  let cookieHeader = '';
  return {
    getCookieHeader() { return cookieHeader; },
    setFromResponse(res) {
      const set = res.headers.getSetCookie?.() || [];
      if (set.length === 0) return;
      const pairs = set.map(c => c.split(';')[0]).filter(Boolean);
      cookieHeader = pairs.join('; ');
    },
  };
}

export async function httpJson(method, path, { body = null, jar = null, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : (BASE + path);
  const h = { 'accept': 'application/json', ...headers };
  if (body != null) h['content-type'] = 'application/json';
  if (jar && jar.getCookieHeader()) h['cookie'] = jar.getCookieHeader();
  const res = await fetch(url, {
    method,
    headers: h,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (jar) jar.setFromResponse(res);
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, res };
}

// ─── Admin session helper ──────────────────────────────────────────────────
export async function adminLogin(jar) {
  const r = await httpJson('POST', '/api/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    jar,
  });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

// ─── Timing helper ─────────────────────────────────────────────────────────
export async function timed(fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    return { out, ms: Date.now() - t0 };
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
}

// ─── Git helper (dirty tree detection etc.) ────────────────────────────────
export function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ─── Version-literal readers ───────────────────────────────────────────────
// v14.81.3 — Regex now captures optional patch component (v14.81 OR v14.81.3).
// Prior regex `v14\.\d+` only captured up to the second segment, so any patch
// release like v14.81.3 was reported as "has v14.81 (want v14.81.3)" — false
// negative in Tier 0 preflight even though every source spot was correctly
// bumped and J4 browser render confirmed v14.81.3.
export const VERSION_BUMP_SPOTS = [
  { file: 'client/src/pages/LoginPage.tsx',      pattern: /Lead Depot (v\d+\.\d+(?:\.\d+)?)/,        label: 'LoginPage footer' },
  // AdminDashboard header renders as JSX text — no quotes
  { file: 'client/src/pages/AdminDashboard.tsx', pattern: />\s*(v\d+\.\d+(?:\.\d+)?)\s*</,          label: 'AdminDashboard header pill' },
  { file: 'client/public/sw.js',                 pattern: /SW_VERSION\s*=\s*"(v\d+\.\d+(?:\.\d+)?)"/, label: 'sw.js SW_VERSION' },
  { file: 'server/routes.ts',                    pattern: /Lead Depot (v\d+\.\d+(?:\.\d+)?)/g,       label: 'routes.ts digest footer(s)', multi: true },
  // /api/health JSON: `version: "v14.66"` — no colon-space in JSON key form; source is JS object literal
  { file: 'server/routes.ts',                    pattern: /version:\s*"(v\d+\.\d+(?:\.\d+)?)"/,      label: 'routes.ts /api/health JSON' },
];

export function readVersionSpots(root = '.') {
  const found = [];
  for (const spec of VERSION_BUMP_SPOTS) {
    const p = `${root}/${spec.file}`;
    if (!existsSync(p)) { found.push({ ...spec, matches: [] }); continue; }
    const contents = readFileSync(p, 'utf8');
    if (spec.multi) {
      const matches = [...contents.matchAll(spec.pattern)].map(m => m[1]);
      found.push({ ...spec, matches });
    } else {
      const m = contents.match(spec.pattern);
      found.push({ ...spec, matches: m ? [m[1]] : [] });
    }
  }
  return found;
}
