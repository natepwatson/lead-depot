import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = []; const consoleErrs = [];
page.on('pageerror', e => errs.push({where: page.url(), msg: e.message, stack: (e.stack||'').split('\n').slice(0,4).join(' | ')}));
page.on('console', m => { if (m.type()==='error') consoleErrs.push({where: page.url(), text: m.text().slice(0,300)}); });

// Login as Nate (still admin)
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
await page.fill('input[type=password]', 'brothers2028Xyz!');
await page.click('button[type=submit]');
await page.waitForTimeout(2500);

// --- STEP 1: enumerate agent list to find Nate's own id
const agents = await page.evaluate(async () => {
  const r = await fetch('/api/agents', { credentials: 'include' });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return j.map(a => ({ id: a.id, name: a.name, email: a.email }));
});
console.log('AGENTS:', JSON.stringify(agents, null, 2));

// Find the admin reset endpoint. Look at OpenAPI/route probes.
// Try a few likely paths.
const nate = Array.isArray(agents) ? agents.find(a => (a.email||'').toLowerCase().startsWith('nate@')) : null;
if (nate) {
  const probes = [
    `/api/admin/agents/${nate.id}/reset-password`,
    `/api/admin/agents/${nate.id}/send-reset`,
    `/api/admin/reset-password/${nate.id}`,
    `/api/agents/${nate.id}/reset-password`,
  ];
  for (const p of probes) {
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}' });
      return { url: u, status: r.status, body: (await r.text()).slice(0, 300) };
    }, p);
    console.log('PROBE:', res.status, res.url, res.body);
  }
}

// --- STEP 2: capture Profile black
console.log('--- PROFILE ---');
errs.length = 0; consoleErrs.length = 0;
// Look for the profile route/button on the current dashboard
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.waitForTimeout(2000);
// Try the bottom nav "Profile" button (v14.51+ has bottom nav on admin too)
const profileBtn = await page.$('button:has-text("Profile"), a:has-text("Profile"), [data-testid="bottom-nav-profile"]');
if (profileBtn) {
  await profileBtn.click();
  await page.waitForTimeout(2500);
} else {
  console.log('NO profile button found; trying direct /profile');
}
const rootSizeProfile = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
const bodyTextProfile = await page.evaluate(() => document.body.innerText.slice(0, 600));
console.log('PROFILE errors:', JSON.stringify(errs, null, 2));
console.log('PROFILE console errors:', JSON.stringify(consoleErrs.slice(0, 6), null, 2));
console.log('PROFILE root size:', rootSizeProfile);
console.log('PROFILE body text:', bodyTextProfile);
await page.screenshot({ path: '/home/user/workspace/triage-profile.png', fullPage: false });

// --- STEP 3: capture Map
console.log('--- MAP ---');
errs.length = 0; consoleErrs.length = 0;
await page.goto('https://depot.watsonbrothersgroup.com/');
await page.waitForTimeout(2000);
const mapBtn = await page.$('button:has-text("Map View"), button:has-text("MAP VIEW"), a:has-text("Map View")');
if (mapBtn) {
  await mapBtn.click();
  await page.waitForTimeout(4000);
}
const rootSizeMap = await page.evaluate(() => document.getElementById('root')?.innerHTML?.length || 0);
const bodyTextMap = await page.evaluate(() => document.body.innerText.slice(0, 600));
console.log('MAP errors:', JSON.stringify(errs, null, 2));
console.log('MAP console errors:', JSON.stringify(consoleErrs.slice(0, 8), null, 2));
console.log('MAP root size:', rootSizeMap);
console.log('MAP body text:', bodyTextMap);
await page.screenshot({ path: '/home/user/workspace/triage-map.png', fullPage: false });

await browser.close();
