import { chromium, devices } from 'playwright';

async function shot(viewport, label, outPath) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(viewport);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: '+m.text().slice(0,150)); });
  await page.goto('https://depot.watsonbrothersgroup.com/');
  await page.waitForTimeout(1200);
  await page.fill('input[type=email]', 'nate@watsonbrothersgroup.com');
  await page.fill('input[type=password]', 'brothers2028Xyz!');
  await page.click('button[type=submit]');
  await page.waitForTimeout(3500);
  // Look for the banner in the DOM
  const bannerInfo = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="on-air-banner"], [data-testid="prime-incoming-banner"]');
    if (!b) return { present: false, allTestIds: [...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')).slice(0,15) };
    const r = b.getBoundingClientRect();
    return { present: true, testId: b.getAttribute('data-testid'), top: r.top, height: r.height, text: b.innerText };
  });
  const heatDebug = await page.evaluate(() => {
    // Peek current tier from any element containing PRIME/MID/DOWN
    const nodes = [...document.querySelectorAll('*')].filter(e => /PRIME TIME|MID TIME|DOWNTIME|ON AIR|STAND BY/i.test(e.innerText || ''));
    return nodes.slice(0, 6).map(n => n.innerText.slice(0, 80));
  });
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`--- ${label} (${viewport.viewport.width}x${viewport.viewport.height}) ---`);
  console.log('errors:', errs.slice(0, 4));
  console.log('banner:', JSON.stringify(bannerInfo, null, 2));
  console.log('heat text nodes:', heatDebug);
  await browser.close();
}

// iPhone 13 viewport
await shot(devices['iPhone 13'], 'iPhone 13', '/home/user/workspace/onair-iphone-live.png');
// Desktop
await shot({ viewport: { width: 1280, height: 800 }}, 'Desktop 1280', '/home/user/workspace/onair-desktop-live.png');
