#!/usr/bin/env node
// scripts/certify.mjs — Comprehensive QA program orchestrator
//
// Replaces: fast-chromium smoke, e2e-walkthrough.mjs, browser-matrix.mjs.
// Usage:
//   node scripts/certify.mjs --tier=preflight   # Tier 0 only (before deploy)
//   node scripts/certify.mjs --tier=post-deploy # T1 + T2 + T4 (after deploy)
//   node scripts/certify.mjs --tier=full        # T0 + T1 + T2 + T3 + T4
//   node scripts/certify.mjs --tier=nightly     # T1 + T4 only (data drift)
//
// Env:
//   EXPECT_VERSION=v14.66   Enforce version match
//   BASE=https://depot...   Target base URL
//   FUB_DRY_RUN=1           Skip real FUB writes
//   CONCURRENCY=3           Tier 3 parallelism
//   AUTO_REVERT=1           Auto git-revert on critical fail (post-deploy only)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { runTier0 } from './certify/tier0-preflight.mjs';
import { runTier1 } from './certify/tier1-backend.mjs';
import { runTier2 } from './certify/tier2-ui.mjs';
import { runTier3 } from './certify/tier3-matrix.mjs';
import { runTier4 } from './certify/tier4-integrity.mjs';
import { T, badge, EXPECT_VERSION } from './certify/lib.mjs';

const arg = (name, def = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=', 2)[1] : def;
};

const tier = arg('tier', 'post-deploy');
const skipTiers = (arg('skip', '') || '').split(',').filter(Boolean);
const startedAt = new Date().toISOString();

const plan = {
  preflight:   ['T0'],
  'post-deploy': ['T1', 'T2', 'T4'],
  full:        ['T0', 'T1', 'T2', 'T3', 'T4'],
  nightly:     ['T1', 'T4'],
}[tier];

if (!plan) {
  console.error(`unknown --tier=${tier}; use preflight|post-deploy|full|nightly`);
  process.exit(2);
}

console.log(`${T.BOLD}${T.CYAN}Certify${T.RST}  ${T.DIM}tier=${tier} plan=${plan.join('+')} version=${EXPECT_VERSION || '(any)'}${T.RST}`);
console.log('');

const all = [];
const t0 = Date.now();

for (const key of plan) {
  if (skipTiers.includes(key)) {
    console.log(`${T.YEL}skip ${key}${T.RST}`);
    continue;
  }
  try {
    if (key === 'T0') all.push(...await runTier0());
    if (key === 'T1') all.push(...await runTier1());
    if (key === 'T2') all.push(...await runTier2());
    if (key === 'T3') all.push(...await runTier3());
    if (key === 'T4') all.push(...await runTier4());
  } catch (e) {
    console.log(`${T.RED}${key} threw:${T.RST} ${e.message}`);
    all.push({ tier: key, name: `${key} · orchestrator`, status: 'fail', critical: true, detail: e.message.slice(0, 200), durationMs: 0 });
  }
  console.log('');
}

const totalMs = Date.now() - t0;
const passed = all.filter(r => r.status === 'pass').length;
const failed = all.filter(r => r.status === 'fail').length;
const critFail = all.filter(r => r.status === 'fail' && r.critical).length;
const skipped = all.filter(r => r.status === 'skip').length;

// ─── Report file ───────────────────────────────────────────────────────────
mkdirSync('./certify-reports', { recursive: true });
const reportPath = `./certify-reports/certify-${EXPECT_VERSION || 'unknown'}-${Date.now()}.json`;
writeFileSync(reportPath, JSON.stringify({
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs: totalMs,
  tier,
  plan,
  version: EXPECT_VERSION,
  summary: { passed, failed, critFail, skipped, total: all.length },
  results: all,
}, null, 2));

// ─── Console summary ───────────────────────────────────────────────────────
console.log('─'.repeat(80));
console.log(`${T.BOLD}Certify summary${T.RST}`);
for (const r of all) {
  const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '';
  console.log(`  ${badge(r.status)}  ${(r.name || 'unnamed').padEnd(60)} ${T.DIM}${dur.padStart(6)}  ${(r.detail || '').slice(0, 60)}${T.RST}`);
}
console.log('─'.repeat(80));
console.log(`  ${T.BOLD}${passed}/${all.length}${T.RST} passed · ${failed} failed (${T.RED}${critFail} critical${T.RST}) · ${skipped} skipped · ${(totalMs / 1000).toFixed(1)}s total`);
console.log(`  ${T.DIM}Report: ${reportPath}${T.RST}`);

// ─── Auto-revert on critical fail ─────────────────────────────────────────
if (critFail > 0 && process.env.AUTO_REVERT === '1' && tier === 'post-deploy') {
  console.log('');
  console.log(`${T.RED}${T.BOLD}CRITICAL FAILURE — auto-reverting HEAD${T.RST}`);
  try {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    console.log(`  Reverting ${head}`);
    execSync(`git revert --no-edit ${head}`, { stdio: 'inherit' });
    execSync(`git push origin main`, { stdio: 'inherit' });
    console.log(`${T.YEL}Revert pushed. Wait ~2 min for Railway rollback.${T.RST}`);
  } catch (e) {
    console.log(`${T.RED}Auto-revert failed:${T.RST} ${e.message}`);
  }
}

process.exit(critFail > 0 ? 1 : 0);
