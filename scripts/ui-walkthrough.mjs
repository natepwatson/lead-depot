// scripts/ui-walkthrough.mjs — Full admin UI screenshot walkthrough
//
// Logs in as admin, navigates through every top-level tab in the admin dashboard,
// screenshots each view, and captures any JS console errors or pageerrors.
// Outputs to /tmp/ui-walkthrough/ so Alex can review.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'https://depot.watsonbrothersgroup.com';
const EMAIL = 'nate@watsonbrothersgroup.com';
const PASSWORD = 'TopProducer2026';
const OUT_DIR = '/tmp/ui-walkthrough';

await mkdir(OUT_DIR, { recursive: true });

const errors = [];
const notes = [];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
page.on('pageerror', e => errors.push(`[pageerror] ${e}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`); });

console.log('→ Loading login page...');
await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT_DIR}/01-login.png`, fullPage: true });

console.log('→ Signing in as admin...');
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
await signInBtn.click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT_DIR}/02-post-login.png`, fullPage: true });

// Detect all top-level nav tabs to walk
const tabLabels = await page.$$eval(
  'button, a, [role="tab"], nav *',
  els => Array.from(new Set(els
    .map(e => e.textContent?.trim())
    .filter(t => t && t.length > 1 && t.length < 40)
  )).slice(0, 50)
);
console.log(`→ Detected candidate tab labels: ${tabLabels.slice(0, 30).join(', ')}`);

// Curated list of expected admin sections
const targetTabs = [
  'Agents',
  'Leads',
  'Leaderboard',
  'Reports',
  'Scripts',
  'Candidates',
  'Onboarding',
  'Pipeline',
  'Open Houses',
  'FUB',
  'Newsletter',
  'Master List',
  'Master Buyer List',
  'Inventory',
  'Health',
];

for (const label of targetTabs) {
  try {
    const selectors = [
      `button:has-text("${label}")`,
      `a:has-text("${label}")`,
      `[role="tab"]:has-text("${label}")`,
    ];
    let clicked = false;
    for (const sel of selectors) {
      const nodes = await page.$$(sel).catch(() => []);
      for (const n of nodes) {
        try {
          await n.click({ timeout: 2500, force: true });
          clicked = true;
          console.log(`  ✓ clicked ${label}`);
          break;
        } catch {}
      }
      if (clicked) break;
    }
    if (!clicked) {
      notes.push(`SKIP: no clickable "${label}" tab found`);
      continue;
    }
    await page.waitForTimeout(1800);
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await page.screenshot({ path: `${OUT_DIR}/tab-${safeLabel}.png`, fullPage: true });
  } catch (e) {
    notes.push(`FAIL clicking "${label}": ${e.message.slice(0, 120)}`);
  }
}

// Special: verify the Source of Truth Backup card is present where WeeklyWorkbookPanel used to be
console.log('→ Scanning for Source of Truth Backup card...');
const backupPresent = await page.evaluate(() => {
  const t = document.body.textContent || '';
  return {
    hasBackupCard: /source of truth backup|backup workbook/i.test(t),
    hasOldPanel: /weekly workbook upload/i.test(t),
  };
});
notes.push(`Backup card presence: ${JSON.stringify(backupPresent)}`);

await browser.close();

console.log('\n===== WALKTHROUGH RESULTS =====');
console.log(`Screenshots: ${OUT_DIR}/`);
console.log(`Console/page errors: ${errors.length}`);
errors.slice(0, 20).forEach(e => console.log('  ' + e));
console.log(`\nNotes: ${notes.length}`);
notes.forEach(n => console.log('  ' + n));
