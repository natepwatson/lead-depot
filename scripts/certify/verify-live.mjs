#!/usr/bin/env node
// v20.7.53 — Verify-live: the mandatory "did the code we shipped actually
// take effect in production" gate. Baked in because I said "done" twice
// on team-pot changes without verifying live, and Alex called it out.
//
// Runs three independent layers on the LIVE app and fails if any layer
// disagrees with the source we shipped:
//
//   L1  server contract — hit /api/health for version, hit any endpoint
//                          declared in the manifest, assert the JSON shape
//                          matches what the source expects to be returned.
//   L2  bundle content  — download the current /assets/index-*.js and
//                          assert every string / substring in the manifest
//                          is present (or absent), so we know the built
//                          dist that Alex's browser downloads reflects the
//                          source changes.
//   L3  computed math   — for endpoints that produce derived values,
//                          reproduce the derivation from the live payload
//                          and assert the client-side math matches.
//
// The manifest is a plain JSON file next to this script that each deploy
// authors alongside its code changes. If no manifest exists for the given
// version, verify-live falls back to a version-only check (v20.7.53+).
//
// Usage:
//   node scripts/certify/verify-live.mjs --version=v20.7.53
//   node scripts/certify/verify-live.mjs --version=v20.7.53 --manifest=./scripts/certify/manifests/v20.7.53.json
//
// Exit code:
//   0 = all layers passed
//   1 = at least one critical failure (build/deploy did NOT take effect)

import fs from "node:fs";
import path from "node:path";

const BASE = "https://depot.watsonbrothersgroup.com";
const NATE = { email: "nate@watsonbrothersgroup.com", password: "TopProducer2026" };

function parseArgs() {
  const args = { version: null, manifest: null };
  for (const a of process.argv.slice(2)) {
    const m = /^--(\w+)=(.*)$/.exec(a);
    if (m) args[m[1]] = m[2];
  }
  if (!args.version) {
    const env = process.env.EXPECT_VERSION;
    if (env) args.version = env;
  }
  return args;
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(NATE),
  });
  if (!r.ok) throw new Error(`login failed HTTP ${r.status}`);
  const cookie = r.headers.get("set-cookie");
  if (!cookie) throw new Error("no set-cookie from login");
  return cookie.split(";")[0]; // just the name=value pair
}

function log(kind, name, detail) {
  const icon = { pass: "✅", fail: "❌", warn: "⚠️", info: "•" }[kind] || "•";
  console.log(`  ${icon}  ${name.padEnd(58)}  ${detail || ""}`);
}

function loadManifest(version) {
  const auto = `./scripts/certify/manifests/${version}.json`;
  const p = path.resolve(process.cwd(), auto);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  return null;
}

// --- Layer 1: server contract ------------------------------------------------

async function layer1_server(version, manifest, cookie) {
  const results = [];

  // Always: /api/health returns the expected version
  const health = await fetchJson(`${BASE}/api/health`);
  const liveVer = health.body?.version;
  results.push({
    name: "L1 /api/health version",
    pass: liveVer === version,
    detail: `expected=${version} live=${liveVer}`,
  });

  // Manifest-declared endpoints
  for (const spec of manifest?.endpoints || []) {
    try {
      const opts = { headers: {} };
      if (spec.auth === "admin" && cookie) opts.headers.Cookie = cookie;
      if (spec.method === "POST") {
        opts.method = "POST";
        opts.headers["Content-Type"] = "application/json";
        if (spec.body) opts.body = JSON.stringify(spec.body);
      }
      const res = await fetchJson(`${BASE}${spec.path}`, opts);
      let ok = res.status === (spec.expectStatus || 200);
      const misses = [];
      if (ok && spec.expectKeys) {
        for (const k of spec.expectKeys) {
          if (!(k in (res.body || {}))) { ok = false; misses.push(`missing key ${k}`); }
        }
      }
      if (ok && spec.expectShape) {
        for (const [k, v] of Object.entries(spec.expectShape)) {
          const actual = res.body?.[k];
          const matches = Array.isArray(v)
            ? (Array.isArray(actual) && actual.length >= v.length)
            : (typeof actual === typeof v);
          if (!matches) { ok = false; misses.push(`shape mismatch ${k} (got ${JSON.stringify(actual)?.slice(0,60)})`); }
        }
      }
      results.push({
        name: `L1 ${spec.method || "GET"} ${spec.path}`,
        pass: ok,
        detail: ok ? `http=${res.status}` : `http=${res.status} ${misses.join("; ")}`,
      });
    } catch (e) {
      results.push({ name: `L1 ${spec.path}`, pass: false, detail: `err=${e.message}` });
    }
  }

  return results;
}

// --- Layer 2: bundle content -------------------------------------------------

async function layer2_bundle(manifest) {
  const results = [];
  // Discover the current index-*.js from the deployed index.html
  const html = await (await fetch(`${BASE}/`)).text();
  const m = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html);
  if (!m) {
    results.push({ name: "L2 asset discovery", pass: false, detail: "no /assets/index-*.js in index.html" });
    return results;
  }
  const assetPath = m[0];
  const js = await (await fetch(`${BASE}${assetPath}`)).text();
  results.push({ name: "L2 asset discovery", pass: true, detail: `asset=${assetPath} bytes=${js.length}` });

  for (const p of manifest?.bundleMustContain || []) {
    const hits = js.split(p).length - 1;
    results.push({
      name: `L2 must-contain "${p}"`,
      pass: hits > 0,
      detail: hits > 0 ? `hits=${hits}` : "NOT FOUND in deployed bundle",
    });
  }
  for (const p of manifest?.bundleMustNotContain || []) {
    const hits = js.split(p).length - 1;
    results.push({
      name: `L2 must-NOT-contain "${p}"`,
      pass: hits === 0,
      detail: hits === 0 ? "clean" : `LEAK hits=${hits}`,
    });
  }

  return results;
}

// --- Layer 3: computed math --------------------------------------------------

async function layer3_math(manifest, cookie) {
  const results = [];
  for (const check of manifest?.mathChecks || []) {
    try {
      const opts = { headers: {} };
      if (check.auth === "admin" && cookie) opts.headers.Cookie = cookie;
      const res = await fetchJson(`${BASE}${check.path}`, opts);
      const body = res.body || {};
      // Manifest gives a JS expression string that must return true.
      // We evaluate it with `body` in scope. Kept sandbox-simple: no `require`
      // and no filesystem access.
      const fn = new Function("body", `return (${check.expr});`);
      const ok = !!fn(body);
      results.push({
        name: `L3 ${check.name}`,
        pass: ok,
        detail: ok ? "match" : `expr false: ${check.expr}`,
      });
    } catch (e) {
      results.push({ name: `L3 ${check.name}`, pass: false, detail: `err=${e.message}` });
    }
  }
  return results;
}

// --- driver -----------------------------------------------------------------

(async () => {
  const args = parseArgs();
  const version = args.version;
  if (!version) {
    console.error("usage: --version=vX.Y.Z (or set EXPECT_VERSION)");
    process.exit(2);
  }
  const manifest = args.manifest
    ? JSON.parse(fs.readFileSync(args.manifest, "utf-8"))
    : loadManifest(version);

  console.log(`\n\x1b[1mCertify · Verify-Live\x1b[0m target=${version}${manifest ? "" : " (no manifest — version-only check)"}\n`);

  let cookie = null;
  try { cookie = await login(); } catch (e) { console.warn(`  (login failed: ${e.message} — admin-only checks will skip)`); }

  const all = [];
  all.push(...(await layer1_server(version, manifest, cookie)));
  if (manifest) {
    all.push(...(await layer2_bundle(manifest)));
    all.push(...(await layer3_math(manifest, cookie)));
  }

  console.log(`\n${"─".repeat(80)}\n\x1b[1mVerify-Live summary\x1b[0m`);
  let failed = 0;
  for (const r of all) {
    log(r.pass ? "pass" : "fail", r.name, r.detail);
    if (!r.pass) failed++;
  }
  console.log(`${"─".repeat(80)}`);
  console.log(`  \x1b[1m${all.length - failed}/${all.length}\x1b[0m passed · \x1b[31m${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
