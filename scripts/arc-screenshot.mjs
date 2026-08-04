// scripts/arc-screenshot.mjs — Screenshot the dial arc on an iPhone-size viewport.
import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'https://depot.watsonbrothersgroup.com';
// alex@ agent password is broken; use nate@ (admin can access agent view via impersonate).
const AGENT_EMAIL = 'nate@watsonbrothersgroup.com';
const AGENT_PASSWORD = 'TopProducer2026';
const OUT = '/tmp/arc-shots';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices['iPhone 14 Pro'],
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 200)));

console.log('Loading login (nocache)...');
await page.goto(`${BASE}/?nc=${Date.now()}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/1-login.png` });

console.log('Signing in as agent...');
await page.fill('input[type="email"], input[name="email"]', AGENT_EMAIL);
await page.fill('input[type="password"]', AGENT_PASSWORD);
const btn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
await btn.click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/2-post-login.png` });

// Try to skip any onboarding overlay
for (const label of ['Skip for now', 'Skip', 'Not now', 'Later']) {
  const b = await page.$(`button:has-text("${label}")`).catch(() => null);
  if (b) {
    console.log(`  clicking "${label}"...`);
    await b.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);
    break;
  }
}

// nate@ is admin — hop directly to /dial to hit the agent-view path.
console.log('Navigating to /dial...');
await page.goto(`${BASE}/dial?nc=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
for (const label of ['Skip for now', 'Skip', 'Not now', 'Later']) {
  const b = await page.$(`button:has-text("${label}")`).catch(() => null);
  if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); break; }
}
await page.screenshot({ path: `${OUT}/3-post-skip.png` });

// The FAB is the middle nav item — the collapsed Dial hero. Click it to open the arc.
console.log('Opening arc via FAB...');
// The FAB has the Plus icon; find the middle button of bottom nav
const nav = await page.$('nav[data-ld-nav="bottom"], nav');
if (nav) {
  const buttons = await nav.$$('button');
  console.log(`  nav has ${buttons.length} buttons`);
  if (buttons.length >= 3) {
    // Middle button = FAB
    const mid = buttons[Math.floor(buttons.length / 2)];
    await mid.click({ force: true });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/4a-arc-entrance-200ms.png` });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/4b-arc-entrance-600ms.png` });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/4c-arc-settled.png` });
  }
}

// Also capture the closed-state FAB alone
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);
// Click backdrop to close
await page.mouse.click(50, 50).catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/5-fab-at-rest.png` });

await browser.close();
console.log('Screenshots saved to', OUT);
