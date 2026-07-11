import { chromium } from 'playwright';

const ts = Date.now();
const url = `https://depot.watsonbrothersgroup.com/?nc=${ts}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);
const rootSize = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);

console.log(JSON.stringify({ errors, rootSize }, null, 2));
await browser.close();
process.exit(errors.length > 0 || rootSize <= 100 ? 1 : 0);
