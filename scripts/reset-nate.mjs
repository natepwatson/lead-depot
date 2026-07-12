import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
await page.fill('input[type=password]', 'brothers2028Xyz!');
await page.click('button[type=submit]');
await page.waitForTimeout(2500);
const agents = await page.evaluate(async () => {
  const r = await fetch('/api/agents', { credentials: 'include' });
  return await r.json();
});
const nate = agents.find(a => (a.email||'').toLowerCase().startsWith('nate@'));
console.log('Nate ID:', nate?.id);
const res = await page.evaluate(async (id) => {
  const r = await fetch(`/api/admin/agents/${id}/reset-password`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: '{}',
  });
  return { status: r.status, body: await r.text() };
}, nate.id);
console.log('RESET:', res.status, res.body);
await browser.close();
