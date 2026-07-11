import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type="email"]', 'alex@watsonbrothersgroup.com');
await page.fill('input[type="password"]', 'brothers2026');
await page.click('button[type="submit"]');
await page.waitForTimeout(2000);
const r = await page.evaluate(async () => {
  const del = await fetch('/api/leads/5630', { method: 'DELETE' });
  return { httpStatus: del.status, body: await del.text().catch(() => '') };
});
console.log('delete result:', JSON.stringify(r));
await browser.close();
