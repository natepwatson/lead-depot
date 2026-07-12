import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Login as Nate (admin)
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
await page.fill('input[type=password]', 'brothers2028Xyz!');
await page.click('button[type=submit]');
await page.waitForTimeout(2000);

// Now hit push stats endpoint
const stats = await page.evaluate(async () => {
  const r = await fetch('/api/admin/push/stats', { credentials: 'include' });
  return { status: r.status, body: await r.text() };
});
console.log('STATS:', JSON.stringify(stats, null, 2));

// Trigger a push test
const testRes = await page.evaluate(async () => {
  const r = await fetch('/api/admin/push/test', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: '{}',
  });
  return { status: r.status, body: await r.text() };
});
console.log('TEST BLAST:', JSON.stringify(testRes, null, 2));

// Also verify VAPID pubkey endpoint (no auth needed)
const vp = await page.evaluate(async () => {
  const r = await fetch('/api/push/vapid-public-key');
  return await r.text();
});
console.log('VAPID PUB:', vp);

await browser.close();
