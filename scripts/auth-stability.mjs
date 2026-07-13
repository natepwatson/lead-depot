#!/usr/bin/env node
/**
 * Auth stability test — v15.11.14
 *
 * Probes every failure mode a real agent can hit:
 *   1. Login with correct email + wrong password         → 401 (not 500, not timeout)
 *   2. Login with wrong email (unknown)                   → 401
 *   3. Login with correct email + correct password       → 200 + session cookie
 *   4. Session cookie hits /api/session-agent             → 200 + agent JSON
 *   5. Nate w/ default password                          → 200 (still works, degraded flag is cosmetic)
 *   6. Server rejects malformed JSON                     → 400/500 not silent
 *   7. Server responds within 2s for all above           → no cold-start timeouts
 *   8. Rate limiter locks out after 5 fails from same IP → 429
 *   9. Health endpoint still 200                          → auth path didn't crash the server
 *
 * Also runs the Gabriel Duran scenario:
 *   - Tries login with BOTH his old (gmail) and new (WBG) email
 *   - Reports which one exists in the DB
 */

const BASE = "https://depot.watsonbrothersgroup.com";
const RED = "\x1b[31m", GREEN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

async function timed(fn) {
  const t0 = Date.now();
  const r = await fn();
  return { ...r, ms: Date.now() - t0 };
}

async function login(email, password) {
  return timed(async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: r.status, body, json, cookies: r.headers.get("set-cookie") };
  });
}

async function getSessionAgent(cookie) {
  return timed(async () => {
    const r = await fetch(`${BASE}/api/session-agent`, { headers: { "cookie": cookie || "" } });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: r.status, body, json };
  });
}

async function health() {
  return timed(async () => {
    const r = await fetch(`${BASE}/api/health`);
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: r.status, json };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const badge = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${badge}  ${name.padEnd(60)} ${DIM}${detail}${RESET}`);
}

console.log(`\n${BOLD}Lead Depot \u2014 auth stability${RESET} ${DIM}@ ${BASE}${RESET}\n`);

// 1. Health baseline
console.log(`${DIM}\u2500 Baseline \u2500${RESET}`);
const h1 = await health();
check("Health responds < 2s", h1.status === 200 && h1.ms < 2000, `HTTP ${h1.status} in ${h1.ms}ms, version=${h1.json?.version}`);

// 2. Login negative paths
console.log(`\n${DIM}\u2500 Negative paths \u2500${RESET}`);
const l1 = await login("alex@watsonbrothersgroup.com", "definitely-wrong-password-xyz");
check("Wrong password returns 401", l1.status === 401 && l1.ms < 2000, `HTTP ${l1.status} in ${l1.ms}ms`);

const l2 = await login("nobody-exists-abc@nowhere.com", "whatever");
check("Unknown email returns 401", l2.status === 401 && l2.ms < 2000, `HTTP ${l2.status} in ${l2.ms}ms`);

const l3 = await login("", "");
check("Empty credentials return 4xx (not 500)", l3.status >= 400 && l3.status < 500, `HTTP ${l3.status}`);

// 3. Known-good login (Nate on default)
console.log(`\n${DIM}\u2500 Positive paths \u2500${RESET}`);
const nate = await login("nate@watsonbrothersgroup.com", "brothers2026");
check("Nate + brothers2026 succeeds", nate.status === 200 && !!nate.cookies, `HTTP ${nate.status} in ${nate.ms}ms, session cookie ${nate.cookies ? "SET" : "MISSING"}`);
let nateAgent = null;
if (nate.status === 200 && nate.cookies) {
  const sess = await getSessionAgent(nate.cookies.split(";")[0]);
  nateAgent = sess.json;
  check("Nate session-agent lookup succeeds", sess.status === 200 && sess.json?.email, `role=${sess.json?.role} id=${sess.json?.id}`);
}

// 4. Gabriel Duran scenarios
console.log(`\n${DIM}\u2500 Gabriel Duran (id=7) \u2500${RESET}`);
const gOld = await login("gabrielduran.realtor@gmail.com", "brothers2026");
check("gabrielduran.realtor@gmail.com + brothers2026", gOld.status === 200, `HTTP ${gOld.status} \u2014 ${gOld.status === 200 ? "logs in" : "REJECTED"}`);

const gNew = await login("gabrielduran@watsonbrothersgroup.com", "brothers2026");
check("gabrielduran@watsonbrothersgroup.com + brothers2026 (new email)", gNew.status === 200, `HTTP ${gNew.status} \u2014 ${gNew.status === 200 ? "logs in" : "REJECTED (email not in DB)"}`);

// 5. Rate limiter
console.log(`\n${DIM}\u2500 Rate limiter (5 fast fails from this IP) \u2500${RESET}`);
let lastRateStatus = null;
for (let i = 0; i < 7; i++) {
  const r = await login("alex@watsonbrothersgroup.com", `wrong-${i}`);
  lastRateStatus = r.status;
}
check("Rate limiter engages after \u22655 fails (429)", lastRateStatus === 429, `final HTTP ${lastRateStatus}`);

// 6. Health after auth abuse
const h2 = await health();
check("Server still healthy after 7 rapid logins", h2.status === 200, `HTTP ${h2.status} in ${h2.ms}ms`);

// 7. Malformed body
const badBody = await timed(async () => {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  return { status: r.status };
});
check("Malformed JSON returns 4xx (not 500)", badBody.status >= 400 && badBody.status < 500, `HTTP ${badBody.status}`);

// ─── Summary ───────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok);
console.log(`\n  ${BOLD}${passed}/${results.length}${RESET} passed  ${failed.length ? `(${RED}${failed.length} failed${RESET})` : ""}`);
if (failed.length) {
  console.log(`\n${RED}Failed checks:${RESET}`);
  for (const f of failed) console.log(`  \u2022 ${f.name}: ${f.detail}`);
}
console.log();
