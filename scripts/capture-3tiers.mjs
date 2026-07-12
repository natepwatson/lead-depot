import { chromium, devices } from 'playwright';

// Prime window (Sun-Wed): 6:30-8:30 PM ET.  So 7 PM ET Tuesday → 23:00 UTC Tue → pick a Tue.
// Mid: try 4 PM ET Tuesday → 20:00 UTC.
// Down: 2 AM ET Tuesday → 06:00 UTC.
const scenarios = [
  { label: 'PRIME',    when: '2026-07-14T23:00:00Z', file: '/home/user/workspace/onair-prime.png' },
  { label: 'MID',      when: '2026-07-14T20:00:00Z', file: '/home/user/workspace/onair-mid.png' },
  { label: 'DOWN',     when: '2026-07-14T06:00:00Z', file: '/home/user/workspace/onair-down.png' },
];

for (const s of scenarios) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(devices['iPhone 13']);
  const page = await ctx.newPage();
  // Fix time BEFORE navigating
  await page.addInitScript((iso) => {
    const fixed = new Date(iso).getTime();
    const _Date = Date;
    // eslint-disable-next-line
    globalThis.Date = class extends _Date {
      constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
      static now() { return fixed; }
    };
  }, s.when);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('https://depot.watsonbrothersgroup.com/');
  await page.waitForTimeout(1200);
  await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
  await page.fill('input[type=password]', 'brothers2028Xyz!');
  await page.click('button[type=submit]');
  await page.waitForTimeout(3500);
  // Navigate to the Dial tab so we can see the dial button state
  const dialTab = page.locator('[data-testid*="bottom-nav-dial"]').first();
  if (await dialTab.count() > 0) { await dialTab.click({ force: true }).catch(()=>{}); await page.waitForTimeout(1500); }
  const banner = await page.evaluate(() => {
    const b = document.querySelector('[data-testid^="onair-banner-"]');
    if (!b) return { present: false };
    const r = b.getBoundingClientRect();
    return { present: true, tier: b.getAttribute('data-tier'), top: r.top, height: r.height, text: b.innerText.slice(0,120) };
  });
  const dialBtn = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="dial-line"], [data-testid="dial-line-locked"]');
    if (!b) return { present: false };
    return { present: true, locked: b.getAttribute('data-testid') === 'dial-line-locked', text: b.innerText.slice(0,80) };
  });
  await page.screenshot({ path: s.file, fullPage: false });
  console.log(`--- ${s.label} @ ${s.when} ---`);
  console.log('errors:', errs.slice(0,3));
  console.log('banner:', JSON.stringify(banner));
  console.log('dial:', JSON.stringify(dialBtn));
  await browser.close();
}
