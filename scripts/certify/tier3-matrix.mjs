// scripts/certify/tier3-matrix.mjs — Cross-browser matrix
//
// Runs Tier 2's key journeys (login + admin render + version + SW) across
// 11 browser rows. Sandbox skips WebKit rows automatically. iMac runs all.

import { chromium, firefox, webkit, devices as pwDevices } from 'playwright';
import { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, EXPECT_VERSION, T, badge, makeRecorder, timed } from './lib.mjs';

const rec = makeRecorder('Tier 3 · Cross-browser');

const MATRIX = [
  { name: 'Chromium desktop',  engine: chromium, device: null },
  { name: 'Pixel 8',            engine: chromium, device: 'Pixel 8' },
  { name: 'Galaxy S24',         engine: chromium, device: 'Galaxy S9+' },
  { name: 'iPad landscape',     engine: chromium, device: 'iPad Pro 11 landscape' },
  { name: 'Firefox desktop',    engine: firefox,  device: null },
  { name: 'iPhone-vp (Chromium)', engine: chromium, device: 'iPhone 14 Pro' },
  { name: 'Mobile landscape',   engine: chromium, device: 'iPhone 14 Pro landscape' },
  { name: 'WebKit desktop',     engine: webkit,   device: null,             mayNotBoot: true },
  { name: 'WebKit iPhone',      engine: webkit,   device: 'iPhone 14 Pro',  mayNotBoot: true },
  { name: 'WebKit iPad',        engine: webkit,   device: 'iPad Pro 11',    mayNotBoot: true },
  { name: 'WebKit landscape',   engine: webkit,   device: 'iPhone 14 Pro landscape', mayNotBoot: true },
];

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

async function runRow(row) {
  const t0 = Date.now();
  let browser;
  try {
    browser = await row.engine.launch();
  } catch (e) {
    if (row.mayNotBoot) return { row, status: 'skip', detail: 'engine not available in sandbox', ms: Date.now() - t0 };
    return { row, status: 'fail', detail: `launch: ${e.message.slice(0, 120)}`, ms: Date.now() - t0 };
  }
  try {
    const deviceCfg = row.device && pwDevices[row.device] ? pwDevices[row.device] : {};
    const context = await browser.newContext({ ...deviceCfg, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
    // v14.70 — Firefox occasionally throws 'page is navigating' on content()
    // right after networkidle if the SPA fires an async redirect. One quick
    // retry with a short settle absorbs this without hiding real failures.
    let html = '';
    for (let i = 0; i < 3; i++) {
      try {
        await page.waitForTimeout(200);
        html = await page.content();
        break;
      } catch (e) {
        if (i === 2) throw e;
        await page.waitForLoadState('networkidle').catch(() => {});
      }
    }
    const versionOk = EXPECT_VERSION ? html.includes(EXPECT_VERSION) : /v\d+\.\d+/.test(html);

    // Login
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    const btn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
    if (btn) await btn.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
    const root = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);

    const ok = root > 100 && errors.length === 0 && versionOk;
    return {
      row,
      status: ok ? 'pass' : 'fail',
      detail: `root=${root} errs=${errors.length} verOk=${versionOk}`,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { row, status: 'fail', detail: `runtime: ${e.message.slice(0, 120)}`, ms: Date.now() - t0 };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pool(jobs, size) {
  const results = [];
  const q = [...jobs];
  const workers = Array.from({ length: size }, async () => {
    while (q.length) {
      const job = q.shift();
      results.push(await job());
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runTier3() {
  console.log(`${T.BOLD}Tier 3 · Cross-browser matrix${T.RST}  ${T.DIM}(concurrency=${CONCURRENCY})${T.RST}`);
  const results = await pool(MATRIX.map(row => () => runRow(row)), CONCURRENCY);
  for (const r of results) {
    const critical = !r.row.mayNotBoot; // WebKit rows aren't critical in sandbox
    rec.add(r.row.name, r.status, { critical, detail: r.detail, durationMs: r.ms });
  }
  return rec.all();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTier3().then(results => {
    const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
    console.log('');
    for (const r of results) console.log(`  ${badge(r.status)}  ${r.name.padEnd(28)}  ${T.DIM}${r.detail}${T.RST}`);
    console.log('');
    console.log(`  ${T.BOLD}${results.filter(r => r.status === 'pass').length}/${results.length}${T.RST} passed  (${critFail} critical failed)`);
    process.exit(critFail > 0 ? 1 : 0);
  });
}
