#!/usr/bin/env node
/**
 * Post-login blackscreen smoke test.
 *
 * The v15.11.13 bug was a client-side `ReferenceError: legal is not defined`
 * from a bad `computeCallHeat` return. That crash hits every user identically
 * because the bundle is shared. So the smoke test does two things:
 *
 *   1. Unauthenticated bundle probe. Load /, click the sign-in page, wait for
 *      the whole JS bundle to hydrate. Capture ANY pageerror. If we see the
 *      `legal is not defined` bug (or ANY crash) here, everyone is broken.
 *
 *   2. Two representative logins (admin + agent) — force-reset just those two
 *      to a known password, log in, wait 4s, verify dashboard renders with
 *      zero pageerrors and > 500 chars of root DOM.
 *
 * We do NOT force-reset the whole team. That would nuke their real passwords.
 */

import { chromium } from "playwright";

const BASE = "https://depot.watsonbrothersgroup.com";
const SECRET = "ms-ingest-2026";
const PW = "brothers2026-smoketest";

const REPRESENTATIVE = [
  { id: 2,  role: "admin", email: "nate@watsonbrothersgroup.com",         name: "Nate Watson" },
  { id: 7,  role: "agent", email: "gabrielduran@watsonbrothersgroup.com", name: "Gabriel Duran" },
];

const RED = "\x1b[31m", GREEN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

async function forceReset(id, pw) {
  const r = await fetch(`${BASE}/api/admin/agents/${id}/force-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Secret": SECRET },
    body: JSON.stringify({ password: pw }),
  });
  return { status: r.status, body: await r.text() };
}

console.log(`\n${BOLD}Post-login smoke${RESET} ${DIM}@ ${BASE}${RESET}\n`);

const browser = await chromium.launch();

// ── PHASE 1 — Bundle probe (unauthenticated) ──────────────────────────────
console.log(`${DIM}\u2500 Phase 1: bundle load, unauthenticated (catches shared-bundle crashes) \u2500${RESET}`);
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const rootSize = await page.evaluate(() => document.getElementById("root")?.innerHTML?.length || 0);
  const hasLoginForm = await page.evaluate(() =>
    !!document.querySelector('input[type=email], input[name=email]')
  );
  const version = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    const m = t.match(/Lead Depot v[\d.]+/);
    return m ? m[0] : "not-found";
  });
  await ctx.close();
  const ok = errs.length === 0 && rootSize > 500 && hasLoginForm;
  const badge = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${badge}  Login page renders          ${DIM}root=${rootSize} loginForm=${hasLoginForm} ${version}${RESET}`);
  if (errs.length) {
    console.log(`${RED}  Bundle errors (this crashes EVERY user):${RESET}`);
    for (const e of errs.slice(0, 3)) console.log(`    ${e.split("\n")[0]}`);
  }
}

// ── PHASE 2 — Representative logins ───────────────────────────────────────
console.log(`\n${DIM}\u2500 Phase 2: representative logins (admin + agent) \u2500${RESET}`);

// Reset just those two accounts so we know the password.
for (const a of REPRESENTATIVE) {
  const r = await forceReset(a.id, PW);
  console.log(`  ${DIM}reset ${a.name} \u2192 HTTP ${r.status}${RESET}`);
}

const results = [];
for (const agent of REPRESENTATIVE) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  const start = Date.now();
  await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: "networkidle" });
  await page.fill('input[type=email], input[name=email]', agent.email);
  await page.fill('input[type=password], input[name=password]', PW);
  const [loginResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/login"), { timeout: 10000 }),
    page.click('button[type=submit], button:has-text("Sign In"), button:has-text("Log In")'),
  ]);
  const loginStatus = loginResp.status();
  await page.waitForTimeout(4000);
  const rootSize = await page.evaluate(() => document.getElementById("root")?.innerHTML?.length || 0);
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const looksLoggedIn = /DIAL|APPTS SET|POINTS|Admin|Agents|Leaderboard|Pipeline|Queue|On Air|DOWNTIME|PRIME/i.test(bodyText);
  await ctx.close();

  const ok = loginStatus === 200 && errs.length === 0 && rootSize > 500 && looksLoggedIn;
  results.push({ agent, ok, ms: Date.now() - start, loginStatus, rootSize, errs, looksLoggedIn });
  const badge = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const detail = ok
    ? `HTTP ${loginStatus}, root=${rootSize}, dashboard UI present`
    : `HTTP ${loginStatus}, root=${rootSize}, dashUI=${looksLoggedIn}, errs=${errs.length}`;
  console.log(`  ${badge}  ${agent.name.padEnd(18)} ${String(Date.now() - start).padStart(5)}ms  ${DIM}${detail}${RESET}`);
  if (errs.length) {
    for (const e of errs.slice(0, 2)) console.log(`    ${RED}${e.split("\n")[0]}${RESET}`);
  }
}

await browser.close();

const pass = results.filter((r) => r.ok).length;
console.log(`\n  ${BOLD}${pass}/${results.length}${RESET} representative logins passed`);
console.log();
process.exit(pass === results.length ? 0 : 1);
