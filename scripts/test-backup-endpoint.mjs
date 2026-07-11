import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type="email"]', 'alex@watsonbrothersgroup.com');
await page.fill('input[type="password"]', 'brothers2026');
await page.click('button[type="submit"]');
await page.waitForTimeout(2000);
// Now hit the backup-status endpoint using the authenticated cookie
const status = await page.evaluate(async () => {
  const r = await fetch('/api/admin/backup-status');
  return { httpStatus: r.status, body: await r.json() };
});
console.log('backup-status:', JSON.stringify(status, null, 2));
// Test unauth path: hard-reset without cookie should be 401 now
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
const rejects = await p2.evaluate(async () => {
  const r = await fetch('https://depot.watsonbrothersgroup.com/api/admin/seller-hard-reset', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ confirm: 'RESET' }),
  });
  return { httpStatus: r.status, body: await r.text() };
});
console.log('unauth hard-reset:', JSON.stringify(rejects, null, 2));
await browser.close();
