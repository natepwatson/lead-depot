#!/usr/bin/env node
// scripts/browser-matrix.mjs — Lead Depot 11-row cross-engine × device matrix
//
// Runs the same 12-phase walkthrough across 11 browser configurations that
// approximate every real-world browser Alex's agents actually use:
//   - Chromium: desktop, Pixel 8 (Android), Galaxy S24 (Samsung), iPad
//   - WebKit:   desktop Safari, iPhone 15 Pro, iPhone SE (small), iPad Safari
//   - Firefox:  desktop
//   - Chromium (iPhone viewport): Chrome-on-iOS-branded layout
//   - Chromium mobile landscape
//
// Exits non-zero if any row fails a CRITICAL phase (login, health, JS errors).
// Prints a compact pass/fail matrix.
//
// Usage:
//   node scripts/browser-matrix.mjs
//   BASE=https://depot.watsonbrothersgroup.com EXPECT_VERSION=v14.51 node scripts/browser-matrix.mjs

import { chromium, webkit, firefox, devices } from 'playwright';

// ─── Engine availability probe ───────────────────────────────────────────
// WebKit needs system libs that some sandboxes don't have. If an engine
// can't launch, we mark its rows as SKIPPED instead of failing the run.
async function probeEngines() {
  const status = {};
  for (const [name, e] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) {
    try {
      const b = await e.launch();
      await b.close();
      status[name] = true;
    } catch (err) {
      status[name] = false;
    }
  }
  return status;
}

const BASE = process.env.BASE || 'https://depot.watsonbrothersgroup.com';
const EMAIL = process.env.LD_EMAIL || 'alex@watsonbrothersgroup.com';
const PASS  = process.env.LD_PASS  || 'brothers2026';
const EXPECT_VERSION = process.env.EXPECT_VERSION;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

const T = { RED: '\x1b[31m', GREEN: '\x1b[32m', YEL: '\x1b[33m', DIM: '\x1b[2m', RST: '\x1b[0m', BOLD: '\x1b[1m', CYAN: '\x1b[36m' };

// ─── The 11-row matrix ─────────────────────────────────────────────────────
const MATRIX = [
  { id: 'chromium-desktop',    engine: chromium, label: 'Chromium desktop',        approximates: 'Chrome/Edge on Mac/PC',        contextOpts: { viewport: { width: 1440, height: 900 } } },
  { id: 'chromium-pixel8',     engine: chromium, label: 'Chromium · Pixel 8',      approximates: 'Chrome on Android',            contextOpts: devices['Pixel 7'] || devices['Galaxy S24'] },
  { id: 'chromium-galaxys24',  engine: chromium, label: 'Chromium · Galaxy S24',   approximates: 'Samsung Internet / Chrome',    contextOpts: devices['Galaxy S24'] },
  { id: 'chromium-ipadpro',    engine: chromium, label: 'Chromium · iPad Pro 11',  approximates: 'Chrome on iPad',               contextOpts: devices['iPad Pro 11'] || devices['iPad (gen 11)'] },
  { id: 'webkit-desktop',      engine: webkit,   label: 'WebKit desktop',          approximates: 'Safari on Mac',                contextOpts: { viewport: { width: 1440, height: 900 } } },
  { id: 'webkit-iphone15pro',  engine: webkit,   label: 'WebKit · iPhone 15 Pro',  approximates: 'Safari on iOS 17',             contextOpts: devices['iPhone 15 Pro'] || devices['iPhone 14 Pro'] || devices['iPhone 13 Pro'] },
  { id: 'webkit-iphonese',     engine: webkit,   label: 'WebKit · iPhone SE',      approximates: 'Safari on small iPhone',        contextOpts: devices['iPhone SE'] || devices['iPhone 8'] },
  { id: 'webkit-ipadpro',      engine: webkit,   label: 'WebKit · iPad Pro 11',    approximates: 'Safari on iPad',               contextOpts: devices['iPad Pro 11'] || devices['iPad (gen 11)'] },
  { id: 'firefox-desktop',     engine: firefox,  label: 'Firefox desktop',         approximates: 'Firefox on desktop',           contextOpts: { viewport: { width: 1440, height: 900 } } },
  { id: 'chromium-iphone-vp',  engine: chromium, label: 'Chromium @ iPhone vp',    approximates: 'Chrome-on-iOS layout',         contextOpts: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1' } },
  { id: 'chromium-landscape',  engine: chromium, label: 'Chromium mobile landscape', approximates: 'Phone in landscape',         contextOpts: { viewport: { width: 932, height: 430 }, isMobile: true, hasTouch: true } },
];

// ─── One row = one full 12-phase walkthrough ──────────────────────────────
async function runRow(row) {
  const started = Date.now();
  const browser = await row.engine.launch();
  const ctxOpts = row.contextOpts || {};
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errs = [];
  const consoleErrs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)); });

  const phases = {};
  const set = (k, ok, critical, detail) => { phases[k] = { ok, critical, detail }; };
  const nc = () => '?nc=' + Date.now();

  try {
    // Phase 1: Login page renders
    await page.goto(BASE + '/' + nc(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    const rootSize1 = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    // v14.81.2+ — allow optional patch suffix (e.g. v14.81.2 not just v14.81)
    const versionText = await page.evaluate(() => document.body.innerText.match(/v14\.\d+(?:\.\d+)?/)?.[0] || null);
    set('login_renders', rootSize1 > 100 && errs.length === 0, true, `root=${rootSize1}`);
    set('version_marker', EXPECT_VERSION ? versionText === EXPECT_VERSION : !!versionText, true, `${versionText || 'none'}`);

    // Phase 2-3: Login flow
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASS);
    await page.click('button[type=submit]');
    await page.waitForTimeout(5500);
    const rootSize2 = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    const errsAfterLogin = errs.length;
    set('login_flow', rootSize2 > 5000 && errsAfterLogin === 0, true, `root=${rootSize2}`);

    // Phase 4: Admin bottom nav (v14.51+)
    // v14.80+ shipped 5-button admin nav: Dashboard | Pipeline | Dial | Referrals | Profile
    const bottomNavBtns = await page.$$('[data-testid^="admin-bottom-nav-"]');
    set('admin_bottom_nav', bottomNavBtns.length === 5, false, `btns=${bottomNavBtns.length}`);

    // Phase 5: Leaderboard populated
    const bodyText = await page.evaluate(() => document.body.innerText);
    const hasAgentNames = /Denise|Nate|Alex|Noah|Danny/i.test(bodyText);
    set('leaderboard_populated', hasAgentNames, false, hasAgentNames ? 'ok' : 'empty');

    // Phase 6: /api/health
    const health = await page.evaluate(async (base) => {
      try { const r = await fetch(base + '/api/health'); const j = await r.json();
        return { status: r.status, version: j.version, apiStatus: j.status }; }
      catch (e) { return { error: String(e) }; }
    }, BASE);
    set('api_health', health.status === 200 && (health.apiStatus === 'healthy' || health.apiStatus === 'degraded'), true, `${health.status}/${health.apiStatus}`);

    // Phase 7: /api/agent/leaderboard
    const lb = await page.evaluate(async (base) => {
      try { const r = await fetch(base + '/api/agent/leaderboard', { credentials: 'include' }); const j = await r.json();
        return { status: r.status, count: Array.isArray(j) ? j.length : (j?.agents?.length || 0) }; }
      catch (e) { return { error: String(e) }; }
    }, BASE);
    set('api_leaderboard', lb.status === 200 && lb.count > 0, false, `${lb.status}/${lb.count}agents`);

    // Phase 8: Admin → Dial nav (tap on mobile, click on desktop)
    try {
      const dialLoc = page.locator('[data-testid="admin-bottom-nav-dial"]');
      const cnt = await dialLoc.count();
      if (cnt > 0) {
        // scrollIntoView first — fixed-bottom nav can be off-screen with small keyboards etc.
        await dialLoc.first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await dialLoc.first().tap({ timeout: 5000 }).catch(async () => {
          // Fall back to click for engines/contexts without touch
          await dialLoc.first().click({ timeout: 5000, force: true });
        });
        await page.waitForTimeout(5000);
      }
    } catch (e) { /* swallow — phase result covers it */ }
    const onDialPage = await page.evaluate(() => !!document.querySelector('a[href^="tel:"]'));
    set('admin_to_dial', onDialPage, false, onDialPage ? 'ok' : 'no tel:');

    // Phase 9: Dial page hides inactive numbers
    const leaked = await page.evaluate(() => (document.body.innerText.match(/Line \d+:\s*\d{7,}/g) || []).length);
    set('numbers_hidden', leaked === 0, false, `leaked=${leaked}`);

    // Phase 10: Active DIAL button
    const dialInfo = await page.evaluate(() => {
      const a = document.querySelector('a[href^="tel:"]');
      return a ? { href: a.getAttribute('href'), textLen: (a.textContent || '').trim().length } : null;
    });
    set('dial_button', !!(dialInfo && dialInfo.href && dialInfo.textLen > 5), false, dialInfo?.href || 'missing');

    // Phase 11: Agent bottom nav
    const agentNavCount = await page.evaluate(() => {
      const navs = document.querySelectorAll('nav');
      for (const n of navs) {
        const s = getComputedStyle(n);
        if (s.position === 'fixed' && parseInt(s.bottom) === 0) return n.querySelectorAll('button, a').length;
      }
      return 0;
    });
    set('agent_bottom_nav', agentNavCount >= 3, false, `btns=${agentNavCount}`);

    // Phase 12: Zero JS errors
    set('zero_js_errors', errs.length === 0, true, `pageerrs=${errs.length} console=${consoleErrs.length}`);

  } catch (e) {
    set('fatal', false, true, e.message.slice(0, 120));
  } finally {
    await browser.close();
  }

  return {
    row,
    phases,
    errs: errs.slice(0, 3),
    consoleErrs: consoleErrs.slice(0, 3),
    durationMs: Date.now() - started,
  };
}

// ─── Concurrency pool ─────────────────────────────────────────────────────
async function pool(items, size, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await worker(items[my], my);
    }
  });
  await Promise.all(runners);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  console.log('');
  console.log(`${T.BOLD}Lead Depot — 11-row browser matrix${T.RST}  ${T.DIM}(${BASE})${T.RST}`);
  console.log(`${T.DIM}Concurrency: ${CONCURRENCY}  |  Expected version: ${EXPECT_VERSION || 'any'}${T.RST}`);
  console.log('');

  // Probe which engines this host can actually launch.
  const engineStatus = await probeEngines();
  const skipped = [];
  const enabled = MATRIX.filter(row => {
    const engineName = row.engine === chromium ? 'chromium' : row.engine === webkit ? 'webkit' : 'firefox';
    if (!engineStatus[engineName]) {
      skipped.push({ row, reason: `${engineName} engine unavailable on this host` });
      return false;
    }
    return true;
  });
  if (skipped.length) {
    console.log(`${T.YEL}Skipping ${skipped.length} row(s):${T.RST}`);
    skipped.forEach(s => console.log(`  ${T.DIM}- ${s.row.label} (${s.reason})${T.RST}`));
    console.log('');
  }

  const results = await pool(enabled, CONCURRENCY, runRow);

  // Compact matrix table
  const PHASE_KEYS = ['login_renders', 'version_marker', 'login_flow', 'admin_bottom_nav', 'leaderboard_populated', 'api_health', 'api_leaderboard', 'admin_to_dial', 'numbers_hidden', 'dial_button', 'agent_bottom_nav', 'zero_js_errors'];
  const PHASE_NUM  = PHASE_KEYS.reduce((m, k, i) => (m[k] = i + 1, m), {});

  console.log(`  ${T.BOLD}#   Browser                                  approximates${T.RST}`);
  console.log(`  ${T.DIM}─────────────────────────────────────────────────────────────────────${T.RST}`);
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

  let anyCriticalFailed = false;
  results.forEach((r, i) => {
    const results12 = PHASE_KEYS.map(k => {
      const p = r.phases[k];
      if (!p) return `${T.DIM}·${T.RST}`;
      return p.ok ? `${T.GREEN}✓${T.RST}` : (p.critical ? `${T.RED}✗${T.RST}` : `${T.YEL}!${T.RST}`);
    }).join(' ');
    const critFails = PHASE_KEYS.filter(k => r.phases[k] && !r.phases[k].ok && r.phases[k].critical).length;
    const nonCritFails = PHASE_KEYS.filter(k => r.phases[k] && !r.phases[k].ok && !r.phases[k].critical).length;
    if (critFails > 0) anyCriticalFailed = true;
    const passes = PHASE_KEYS.filter(k => r.phases[k]?.ok).length;
    const rowBadge = critFails > 0 ? `${T.RED}✗${T.RST}` : (nonCritFails > 0 ? `${T.YEL}!${T.RST}` : `${T.GREEN}✓${T.RST}`);
    console.log(`  ${rowBadge} ${pad(String(i+1), 2)} ${T.CYAN}${pad(r.row.label, 34)}${T.RST} ${T.DIM}${pad(r.row.approximates, 30)}${T.RST}`);
    console.log(`      ${T.DIM}phases:${T.RST} ${results12}  ${T.DIM}${passes}/12  ${(r.durationMs/1000).toFixed(1)}s${T.RST}`);
  });

  console.log('');
  console.log(`  ${T.DIM}Legend: phases 1-12 = ${PHASE_KEYS.join(', ')}${T.RST}`);
  console.log('');

  // Detail on failures only
  const anyFailure = results.some(r => Object.values(r.phases).some(p => !p.ok));
  if (anyFailure) {
    console.log(`  ${T.BOLD}Failure detail:${T.RST}`);
    results.forEach((r, i) => {
      const fails = PHASE_KEYS.filter(k => r.phases[k] && !r.phases[k].ok);
      if (fails.length === 0) return;
      console.log(`  ${T.CYAN}${r.row.label}${T.RST}`);
      fails.forEach(k => {
        const p = r.phases[k];
        const tag = p.critical ? `${T.RED}CRITICAL${T.RST}` : `${T.YEL}warn${T.RST}`;
        console.log(`    ${tag}  ${PHASE_NUM[k]}. ${k} — ${p.detail}`);
      });
      if (r.errs.length) r.errs.forEach(e => console.log(`    ${T.DIM}page error: ${e.slice(0, 200)}${T.RST}`));
    });
    console.log('');
  }

  const totalTime = ((Date.now() - started) / 1000).toFixed(1);
  const passCount = results.filter(r => !PHASE_KEYS.some(k => r.phases[k] && !r.phases[k].ok && r.phases[k].critical)).length;
  const skipNote = skipped.length ? `  ${T.YEL}(${skipped.length} skipped)${T.RST}` : '';
  console.log(`  ${T.BOLD}${passCount}/${results.length}${T.RST} browsers passed all critical phases${skipNote}  ${T.DIM}(total ${totalTime}s)${T.RST}`);
  console.log('');

  process.exit(anyCriticalFailed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
