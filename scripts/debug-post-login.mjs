import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.waitForTimeout(1000);
// Try login
await page.fill('input[type="email"]', 'alex@watsonbrothersgroup.com');
await page.fill('input[type="password"]', process.env.ADMIN_PW || 'brothers2026');
await page.click('button[type="submit"]');
await page.waitForTimeout(3000);
const url = page.url();
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
console.log('URL:', url);
console.log('BODY:', bodyText);
await browser.close();
