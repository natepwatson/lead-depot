// scripts/certify/tier2-ui.mjs — UI Journey Suite (real Playwright)
//
// 7 real end-to-end journeys. Each journey is independent, each asserts a
// specific user outcome. Aggregate: any pageerror = fail.
//
// Runs in Chromium by default. Tier 3 reuses this on the multi-browser matrix.

import { chromium, devices as pwDevices } from 'playwright';
import {
  BASE, ADMIN_EMAIL, ADMIN_PASSWORD, EXPECT_VERSION,
  T, badge, makeRecorder, timed,
} from './lib.mjs';

const rec = makeRecorder('Tier 2 · UI Journeys');

// ─── One shared browser, one context per journey ───────────────────────────
async function withPage(deviceName, fn) {
  const browser = await chromium.launch();
  const device = deviceName && pwDevices[deviceName] ? pwDevices[deviceName] : {};
  const context = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  try {
    return await fn(page, errors);
  } finally {
    await browser.close();
  }
}

// ─── Journey helpers ──────────────────────────────────────────────────────
async function adminLoginUI(page) {
  await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  const btn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
  await btn.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

async function assertUI(name, opts, fn) {
  const { critical = false } = opts;
  const { out, err, ms } = await timed(fn);
  if (err) {
    rec.add(name, 'fail', { critical, detail: `threw: ${err.message.slice(0, 200)}`, durationMs: ms });
    return;
  }
  const [ok, detail] = Array.isArray(out) ? out : [out, ''];
  rec.add(name, ok ? 'pass' : 'fail', { critical, detail, durationMs: ms });
}

// ─── Journey 1: Admin morning routine ─────────────────────────────────────
async function journey1() {
  await assertUI('J1 · admin login + landing render', { critical: true }, () => withPage(null, async (page, errors) => {
    await adminLoginUI(page);
    const root = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    const versionOk = EXPECT_VERSION
      ? (await page.content()).includes(EXPECT_VERSION)
      : /v14\.\d+/.test(await page.content());
    return [root > 100 && errors.length === 0 && versionOk, `root=${root} errs=${errors.length} verOk=${versionOk}`];
  }));
}

// ─── Journey 2: Admin leaderboard has no duplicate names ──────────────────
async function journey2() {
  await assertUI('J2 · admin leaderboard has no duplicate active agent names', { critical: false }, () => withPage(null, async (page, errors) => {
    await adminLoginUI(page);
    // Navigate to leaderboard (if not already there)
    const tryLink = await page.$('text="Leaderboard"');
    if (tryLink) await tryLink.click();
    await page.waitForTimeout(1500);
    const names = await page.$$eval('[data-agent-name], .agent-name, td:nth-child(2)', els => els.map(e => e.textContent?.trim()).filter(Boolean));
    const seen = new Map();
    for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
    const dups = [...seen.entries()].filter(([_, c]) => c > 1 && _.length > 2);
    return [dups.length === 0 && errors.length === 0, `names=${names.length} dups=${dups.length}`];
  }));
}

// ─── Journey 3: Zero JS errors across nav paths ───────────────────────────
async function journey3() {
  await assertUI('J3 · zero JS errors across admin navigation', { critical: true }, () => withPage(null, async (page, errors) => {
    await adminLoginUI(page);
    // Click through common navigation elements
    for (const label of ['Agents', 'Leads', 'Leaderboard', 'Reports']) {
      const link = await page.$(`text="${label}"`);
      if (link) {
        await link.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }
    return [errors.length === 0, `errs=${errors.length} sample=${errors.slice(0,2).join(' | ').slice(0,200)}`];
  }));
}

// ─── Journey 4: Version literal appears in served HTML ────────────────────
async function journey4() {
  await assertUI('J4 · version literal renders on login page', { critical: true }, () => withPage(null, async (page, errors) => {
    await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
    const html = await page.content();
    const target = EXPECT_VERSION || (html.match(/v14\.\d+/) || [null])[0];
    const ok = !!target && html.includes(target) && errors.length === 0;
    return [ok, `target=${target} errs=${errors.length}`];
  }));
}

// ─── Journey 5: Mobile viewport renders admin without layout crash ────────
async function journey5() {
  await assertUI('J5 · mobile (Pixel 8) renders login + admin', { critical: true }, () => withPage('Pixel 8', async (page, errors) => {
    await adminLoginUI(page);
    const root = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
    return [root > 100 && errors.length === 0, `root=${root} errs=${errors.length}`];
  }));
}

// ─── Journey 6: Service worker registers ──────────────────────────────────
async function journey6() {
  await assertUI('J6 · service worker registers', { critical: false }, () => withPage(null, async (page, errors) => {
    await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const swReg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });
    return [swReg && errors.length === 0, `sw=${swReg} errs=${errors.length}`];
  }));
}

// ─── Journey 7: /api/health accessible from browser context ───────────────
async function journey7() {
  await assertUI('J7 · /api/health reachable from browser + reports healthy', { critical: true }, () => withPage(null, async (page, errors) => {
    await page.goto(`${BASE}/api/health`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const ok = json?.status === 'healthy' && (!EXPECT_VERSION || json.version === EXPECT_VERSION);
    return [ok, `status=${json?.status} ver=${json?.version}`];
  }));
}

// ─── Runner ────────────────────────────────────────────────────────────────
export async function runTier2() {
  console.log(`${T.BOLD}Tier 2 · UI Journey Suite${T.RST}  ${T.DIM}(${BASE})${T.RST}`);
  await journey1();
  await journey2();
  await journey3();
  await journey4();
  await journey5();
  await journey6();
  await journey7();
  return rec.all();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTier2().then(results => {
    const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
    console.log('');
    for (const r of results) console.log(`  ${badge(r.status)}  ${r.name.padEnd(58)}  ${T.DIM}${r.detail}${T.RST}`);
    console.log('');
    console.log(`  ${T.BOLD}${results.filter(r => r.status === 'pass').length}/${results.length}${T.RST} passed  (${critFail} critical failed)`);
    process.exit(critFail > 0 ? 1 : 0);
  });
}
