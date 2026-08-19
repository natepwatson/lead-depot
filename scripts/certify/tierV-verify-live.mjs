// scripts/certify/tierV-verify-live.mjs
// v20.7.53 — Tier V: live post-deploy verification against a per-version
// manifest. Runs three layers (server contract, bundle content, computed
// math) and returns certify-shaped results so the orchestrator can roll
// them into the report + AUTO_REVERT decision.

import fs from "node:fs";
import path from "node:path";
import { T, EXPECT_VERSION } from "./lib.mjs";

const BASE = process.env.BASE || "https://depot.watsonbrothersgroup.com";
const NATE = { email: "nate@watsonbrothersgroup.com", password: "TopProducer2026" };

function loadManifest(version) {
  const p = path.resolve(process.cwd(), `./scripts/certify/manifests/${version}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(NATE),
  });
  if (!r.ok) return null;
  const cookie = r.headers.get("set-cookie");
  return cookie ? cookie.split(";")[0] : null;
}

function res(name, pass, detail, critical = true) {
  return {
    tier: "V",
    name,
    status: pass ? "pass" : "fail",
    critical,
    detail: detail || "",
    durationMs: 0,
  };
}

export async function runTierV() {
  const version = EXPECT_VERSION;
  console.log(`${T.BOLD}Tier V · Verify-Live${T.RST}`);
  const out = [];

  if (!version) {
    out.push(res("V · manifest lookup", false, "EXPECT_VERSION not set — cannot pick manifest"));
    return out;
  }

  const manifest = loadManifest(version);
  if (!manifest) {
    out.push(res("V · manifest lookup", true, `no manifest for ${version} (version-only check)`, false));
    // Fall through to version-only check
    try {
      const h = await fetchJson(`${BASE}/api/health`);
      out.push(res("V · /api/health version", h.body?.version === version, `expected=${version} live=${h.body?.version}`));
    } catch (e) {
      out.push(res("V · /api/health version", false, `err=${e.message}`));
    }
    return out;
  }

  const cookie = await login();
  if (!cookie) {
    out.push(res("V · admin login", false, "could not obtain admin session — admin checks will be skipped", false));
  }

  // ── Layer 1: server contract ────────────────────────────────────────────
  const h = await fetchJson(`${BASE}/api/health`);
  out.push(res("V-L1 · /api/health version", h.body?.version === version, `expected=${version} live=${h.body?.version}`));

  for (const spec of manifest.endpoints || []) {
    try {
      const opts = { headers: {} };
      if (spec.auth === "admin" && cookie) opts.headers.Cookie = cookie;
      if (spec.method === "POST") {
        opts.method = "POST";
        opts.headers["Content-Type"] = "application/json";
        if (spec.body) opts.body = JSON.stringify(spec.body);
      }
      const r = await fetchJson(`${BASE}${spec.path}`, opts);
      let ok = r.status === (spec.expectStatus || 200);
      const misses = [];
      if (ok && spec.expectKeys) {
        for (const k of spec.expectKeys) {
          if (!(k in (r.body || {}))) { ok = false; misses.push(`missing key ${k}`); }
        }
      }
      out.push(res(
        `V-L1 · ${spec.method || "GET"} ${spec.path}`,
        ok,
        ok ? `http=${r.status}` : `http=${r.status} ${misses.join("; ")}`,
      ));
    } catch (e) {
      out.push(res(`V-L1 · ${spec.path}`, false, `err=${e.message}`));
    }
  }

  // ── Layer 2: bundle content ─────────────────────────────────────────────
  try {
    const html = await (await fetch(`${BASE}/`)).text();
    const m = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html);
    if (!m) {
      out.push(res("V-L2 · asset discovery", false, "no /assets/index-*.js in index.html"));
    } else {
      const js = await (await fetch(`${BASE}${m[0]}`)).text();
      out.push(res("V-L2 · asset discovery", true, `asset=${m[0]} bytes=${js.length}`, false));

      for (const p of manifest.bundleMustContain || []) {
        if (p.startsWith("__")) continue;
        const hits = js.split(p).length - 1;
        out.push(res(`V-L2 · contains "${p}"`, hits > 0, hits > 0 ? `hits=${hits}` : "NOT in deployed bundle"));
      }
      for (const p of manifest.bundleMustNotContain || []) {
        const hits = js.split(p).length - 1;
        out.push(res(`V-L2 · absent "${p}"`, hits === 0, hits === 0 ? "clean" : `LEAK hits=${hits}`));
      }
    }
  } catch (e) {
    out.push(res("V-L2 · bundle fetch", false, `err=${e.message}`));
  }

  // ── Layer 3: computed math ──────────────────────────────────────────────
  for (const check of manifest.mathChecks || []) {
    try {
      const opts = { headers: {} };
      if (check.auth === "admin" && cookie) opts.headers.Cookie = cookie;
      const r = await fetchJson(`${BASE}${check.path}`, opts);
      const body = r.body || {};
      const fn = new Function("body", `return (${check.expr});`);
      const ok = !!fn(body);
      out.push(res(`V-L3 · ${check.name}`, ok, ok ? "match" : `expr false: ${check.expr}`));
    } catch (e) {
      out.push(res(`V-L3 · ${check.name}`, false, `err=${e.message}`));
    }
  }

  // Print inline (mimics other tiers' formatting)
  for (const r of out) {
    const icon = r.status === "pass" ? `${T.GRN}✅${T.RST}` : `${T.RED}❌${T.RST}`;
    console.log(`  ${icon}  ${r.name.padEnd(56)}  ${T.DIM}${r.detail}${T.RST}`);
  }

  return out;
}
