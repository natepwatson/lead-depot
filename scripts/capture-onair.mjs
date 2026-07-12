import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Freeze Date to Thursday 4:30 PM ET (peak Prime). Real UTC: 20:30Z.
// Thursday 2026-07-16 20:30 UTC = 4:30 PM ET.
await page.addInitScript(() => {
  const fixed = new Date('2026-07-16T20:30:00Z').getTime();
  const RealDate = Date;
  const _now = fixed;
  // Override Date so the app computes heat as if it's Thursday 4:30 PM ET
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(_now);
      else super(...args);
    }
    static now() { return _now; }
  }
  Object.setPrototypeOf(MockDate, RealDate);
  window.Date = MockDate;
});

// Login as Nate then screenshot the whole page
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
await page.fill('input[type=password]', 'brothers2028Xyz!');
await page.click('button[type=submit]');
await page.waitForTimeout(3500);

await page.setViewportSize({ width: 400, height: 900 });
await page.screenshot({ path: '/home/user/workspace/onair-prime-shot.png', fullPage: false });
console.log('captured');
await browser.close();
