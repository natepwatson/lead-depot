import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const fails = [];
page.on('response', r => {
  if (r.status() >= 500) fails.push({ url: r.url(), status: r.status() });
});
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type="email"], input[name="email"]', 'nate@watsonbrothersgroup.com');
await page.fill('input[type="password"]', 'TopProducer2026');
await page.click('button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]');
await page.waitForTimeout(4000);
// navigate to a few admin tabs
for (const btn of ['Leaderboard','Pipeline','Diversity','DB Health','Agents','Scripts','Reports']) {
  try {
    const b = await page.locator(`button:has-text("${btn}"), [role="tab"]:has-text("${btn}")`).first();
    if (await b.isVisible({timeout:500}).catch(()=>false)) {
      await b.click().catch(()=>{});
      await page.waitForTimeout(1200);
    }
  } catch {}
}
console.log(JSON.stringify(fails, null, 2));
await browser.close();
