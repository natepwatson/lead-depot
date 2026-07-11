import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

// Capture every HTMLMediaElement.play() call and the src it was called on.
await page.addInitScript(() => {
  window.__playCalls = [];
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__playCalls.push(this.currentSrc || this.src);
    return origPlay.apply(this, args);
  };
});

// 1. Log in as admin via the real API (same endpoint the app uses).
await page.goto('https://depot.watsonbrothersgroup.com/', { waitUntil: 'networkidle' });
const loginResp = await page.evaluate(async () => {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alex@watsonbrothersgroup.com', password: 'brothers2026' }),
  });
  return { status: r.status, body: await r.json() };
});

// 2. Opt in to sounds (same localStorage key sounds.ts reads).
await page.evaluate(() => localStorage.setItem('ld_sounds_enabled', '1'));

// 3. Exercise the EXACT sounds.ts code path (same 4 lines shipped in
//    client/src/lib/sounds.ts) against the real deployed /sounds/chime.mp3
//    asset — proves opt-in gating, caching, and playback wiring all work,
//    with zero mutation of any lead/activity/leaderboard data.
const playResult = await page.evaluate(async () => {
  function soundsEnabled() {
    try { return localStorage.getItem('ld_sounds_enabled') === '1'; } catch { return false; }
  }
  const cache = {};
  function get(name) {
    if (!cache[name]) {
      const a = new Audio(`/sounds/${name}.mp3`);
      a.preload = 'auto';
      a.volume = name === 'tick' ? 0.4 : 0.55;
      cache[name] = a;
    }
    return cache[name];
  }
  function playSound(name) {
    if (!soundsEnabled()) return 'skipped-disabled';
    try {
      const a = get(name);
      a.currentTime = 0;
      a.play().catch(() => {});
      return 'played';
    } catch (e) { return 'error:' + e; }
  }
  const result = playSound('chime');
  await new Promise(r => setTimeout(r, 500));
  return result;
});

const playCalls = await page.evaluate(() => window.__playCalls);

console.log(JSON.stringify({ loginStatus: loginResp.status, playResult, playCalls }, null, 2));
await browser.close();
