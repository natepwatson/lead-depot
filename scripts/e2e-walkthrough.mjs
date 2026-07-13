#!/usr/bin/env node
// scripts/e2e-walkthrough.js — Lead Depot 12-phase end-to-end walkthrough
//
// Runs a single headless Chromium session that logs in as alex@ and steps
// through the same 12 checks the 2026-07-04 browser walkthrough did on v12.9.
// Prints a pass/fail table and exits non-zero if any critical phase fails.
//
// Usage:
//   node scripts/e2e-walkthrough.js                 # runs against prod
//   BASE=https://depot.watsonbrothersgroup.com node scripts/e2e-walkthrough.js
//   BASE=http://localhost:5000 node scripts/e2e-walkthrough.js

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// v15.11.20 — Load credentials from .env.local (gitignored) instead of
// hardcoding the seed default. Rotating an admin password no longer breaks
// the walkthrough — just update .env.local and re-run.
//
// File format (one KEY=VALUE per line, no quotes required, # comments ok):
//   LD_EMAIL=nate@watsonbrothersgroup.com
//   LD_PASS=TopProducer2026
//   INGEST_SECRET=ms-ingest-2026
function loadDotEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Don't overwrite existing env vars — CLI overrides file.
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const BASE = process.env.BASE || 'https://depot.watsonbrothersgroup.com';
const EMAIL = process.env.LD_EMAIL || 'nate@watsonbrothersgroup.com';
const PASS  = process.env.LD_PASS  || 'brothers2026';
const EXPECT_VERSION = process.env.EXPECT_VERSION; // e.g. "v14.51"; optional strict check
if (PASS === 'brothers2026') {
  console.warn('\x1b[33m⚠️  Using default seed password. Set LD_PASS in .env.local for current passwords.\x1b[0m');
}

const nc = () => '?nc=' + Date.now();
const T = { RED: '\x1b[31m', GREEN: '\x1b[32m', YEL: '\x1b[33m', DIM: '\x1b[2m', RST: '\x1b[0m', BOLD: '\x1b[1m' };
const badge = (ok, warn = false) => (ok ? `${T.GREEN}✅${T.RST}` : warn ? `${T.YEL}⚠️${T.RST}` : `${T.RED}❌${T.RST}`);

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errs = [];
  const consoleErrs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  const results = [];  // { phase, ok, critical, detail }
  const add = (phase, ok, critical, detail) => results.push({ phase, ok, critical, detail });

  try {
    // ─── Phase 1: Login page renders + version marker ────────────────────
    await page.goto(BASE + '/' + nc(), { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    const rootSize1 = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    // v14.81.2+ — allow optional patch suffix (e.g. v14.81.2 not just v14.81)
    const versionText = await page.evaluate(() => document.body.innerText.match(/v\d+\.\d+(?:\.\d+)?/)?.[0] || null);
    const versionOk = EXPECT_VERSION ? versionText === EXPECT_VERSION : !!versionText;
    add('1. Login page renders', rootSize1 > 100 && errs.length === 0, true, `root=${rootSize1} ver=${versionText} errs=${errs.length}`);
    add('2. Version marker present', versionOk, true, EXPECT_VERSION ? `expected ${EXPECT_VERSION} got ${versionText}` : `${versionText}`);

    // ─── Phase 3: Login flow ─────────────────────────────────────────────
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASS);
    await page.click('button[type=submit]');
    await page.waitForTimeout(4500);
    const rootSize2 = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    const loginErrs = errs.length;
    add('3. Login succeeds → Admin dashboard', rootSize2 > 5000 && loginErrs === 0, true, `root=${rootSize2} errs=${loginErrs}`);

    // ─── Phase 4: Admin bottom nav (v14.80+: 5 buttons — Pipeline added) ─────
    // v14.80 intentionally shipped a 5-button admin nav: Dashboard | Pipeline |
    // Dial | Referrals | Profile. Pipeline routes into AgentView pipeline tab.
    const bottomNavBtns = await page.$$('[data-testid^="admin-bottom-nav-"]');
    const bottomNavLabels = [];
    for (const b of bottomNavBtns) bottomNavLabels.push((await b.textContent()).trim());
    const navOk = bottomNavLabels.length === 5 &&
      bottomNavLabels.includes('Dashboard') && bottomNavLabels.includes('Pipeline') &&
      bottomNavLabels.includes('Dial') && bottomNavLabels.includes('Referrals') &&
      bottomNavLabels.includes('Profile');
    add('4. Admin bottom nav (5 buttons)', navOk, false, `[${bottomNavLabels.join(',')}]`);

    // ─── Phase 5: Leaderboard populated with agents ──────────────────────
    // Admin default tab is leaderboard; wait for agent rows
    const agentLeaderboardText = await page.evaluate(() => document.body.innerText);
    const hasAgentNames = /Denise|Nate|Alex|Noah|Danny/i.test(agentLeaderboardText);
    add('5. Leaderboard populated', hasAgentNames, false, hasAgentNames ? 'agent names visible' : 'no agent names found');

    // ─── Phase 6: /api/health returns healthy + version ──────────────────
    const health = await page.evaluate(async (base) => {
      try {
        const r = await fetch(base + '/api/health');
        const j = await r.json();
        return { status: r.status, version: j.version, apiStatus: j.status };
      } catch (e) { return { error: String(e) }; }
    }, BASE);
    // v15.9: 207 + degraded is acceptable — that means non-critical warnings
    // (e.g. default admin password still in use, backup snapshot pending) but
    // db + resend are healthy. Only 503 or a network error is a real failure.
    const healthOk = (health.status === 200 || health.status === 207) && (health.apiStatus === 'healthy' || health.apiStatus === 'degraded');
    add('6. /api/health responds', healthOk, true, `http=${health.status} status=${health.apiStatus} ver=${health.version}`);

    // ─── Phase 7: /api/agent/leaderboard returns data ────────────────────
    const lb = await page.evaluate(async (base) => {
      try {
        const r = await fetch(base + '/api/agent/leaderboard', { credentials: 'include' });
        const j = await r.json();
        return { status: r.status, count: Array.isArray(j) ? j.length : (j?.agents?.length || 0) };
      } catch (e) { return { error: String(e) }; }
    }, BASE);
    add('7. Leaderboard API returns agents', lb.status === 200 && lb.count > 0, false, `status=${lb.status} agents=${lb.count}`);

    // ─── Phase 8: Navigate to Dial (via admin bottom nav) ────────────────
    // v15.11.13+: during downtime the dial CTA is gated by a confirm sheet, so
    // there's no raw <a href="tel:"> until the user confirms. Check for either
    // the tel: link (Prime Time) OR the DOWNTIME / confirm-sheet state.
    const dialBtn = await page.$('[data-testid="admin-bottom-nav-dial"]');
    if (dialBtn) {
      await dialBtn.click();
      await page.waitForTimeout(3500);
    }
    const dialState = await page.evaluate(() => {
      const hasTel = !!document.querySelector('a[href^="tel:"]');
      const txt = document.body.innerText || '';
      const gatedText = /(DOWNTIME|MID TIME|CONFIRM|Dial anyway|On Air at)/.test(txt);
      const hasOutcomeBtns = /No Answer|Wrong #|Not a Working Line/.test(txt);
      return { hasTel, gatedText, hasOutcomeBtns };
    });
    const onDialPage = dialState.hasTel || (dialState.gatedText && dialState.hasOutcomeBtns);
    add('8. Admin → Dial nav works', onDialPage, false,
      onDialPage ? (dialState.hasTel ? 'tel: link (Prime)' : 'gated by downtime confirm sheet') : 'no dial UI');

    // ─── Phase 9: Dial page — inactive numbers hidden (v14.51+) ──────────
    const leaked = await page.evaluate(() => {
      const t = document.body.innerText;
      return (t.match(/Line \d+:\s*\d{7,}/g) || []).length;
    });
    add('9. Dial page hides inactive numbers', leaked === 0, false, `leaked=${leaked}`);

    // ─── Phase 10: Active dial button renders (tel: link or downtime-gated CTA) ──
    // v15.11.13+: downtime replaces the raw tel: link with a confirm-sheet CTA.
    // Accept EITHER a working tel: link OR a visible DIAL/CONFIRM control.
    const dialCta = await page.evaluate(() => {
      const a = document.querySelector('a[href^="tel:"]');
      if (a) return { kind: 'tel', href: a.getAttribute('href'), textLen: (a.textContent || '').trim().length };
      const btn = Array.from(document.querySelectorAll('button')).find(b => /DIAL|CALL|CONFIRM/i.test((b.textContent || '').trim()));
      if (btn) return { kind: 'button', text: (btn.textContent || '').trim().slice(0, 40) };
      return null;
    });
    const dialCtaOk = !!dialCta && (dialCta.kind === 'tel'
      ? (!!dialCta.href && dialCta.textLen > 5)
      : !!dialCta.text);
    add('10. Active DIAL LINE button', dialCtaOk, false,
      dialCta ? (dialCta.kind === 'tel' ? `tel href=${dialCta.href}` : `downtime CTA="${dialCta.text}"`) : 'missing');

    // ─── Phase 11: Agent bottom nav (Dashboard/Dial/Refer/Profile) ───────
    const agentNavBtns = await page.$$('[data-testid^="nav-"]');
    let agentNavCount = agentNavBtns.length;
    // fallback: look for standard nav labels in the fixed bottom bar
    if (agentNavCount === 0) {
      agentNavCount = await page.evaluate(() => {
        const navs = document.querySelectorAll('nav');
        for (const n of navs) {
          const style = getComputedStyle(n);
          if (style.position === 'fixed' && parseInt(style.bottom) === 0) {
            return n.querySelectorAll('button, a').length;
          }
        }
        return 0;
      });
    }
    add('11. Agent bottom nav renders', agentNavCount >= 3, false, `buttons=${agentNavCount}`);

    // ─── Phase 12: No uncaught JS errors across the whole session ────────
    add('12. Zero JS errors', errs.length === 0, true, `pageerrors=${errs.length} consoleErrors=${consoleErrs.length}`);

  } catch (e) {
    add('FATAL', false, true, e.message);
  } finally {
    await browser.close();
  }

  // ─── Print results ──────────────────────────────────────────────────────
  console.log('');
  console.log(`${T.BOLD}Lead Depot — 12-phase E2E walkthrough${T.RST}  ${T.DIM}(${BASE})${T.RST}`);
  console.log('');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  for (const r of results) {
    console.log(`  ${badge(r.ok)}  ${pad(r.phase, 42)}  ${T.DIM}${r.detail}${T.RST}`);
  }
  const failed = results.filter(r => !r.ok);
  const criticalFailed = failed.filter(r => r.critical);
  const pass = results.filter(r => r.ok).length;
  console.log('');
  console.log(`  ${T.BOLD}${pass}/${results.length}${T.RST} passed  (${criticalFailed.length} critical failed, ${failed.length - criticalFailed.length} non-critical failed)`);
  console.log('');

  if (errs.length) {
    console.log(`  ${T.RED}Page errors:${T.RST}`);
    errs.forEach(e => console.log(`    - ${e}`));
  }

  process.exit(criticalFailed.length > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(2); });
