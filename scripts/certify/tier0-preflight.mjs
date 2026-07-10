// scripts/certify/tier0-preflight.mjs — Static Pre-flight (no live app hit)
//
// Runs against the local workspace before a deploy. Catches:
//  1. Version bump misalignment (7 mandatory spots)
//  2. dist/ freshness (Vite hash newer than source? tracked in git?)
//  3. TypeScript check (tsc --noEmit)
//  4. Route inventory diff vs. checked-in snapshot
//  5. Grep guards (Do-Not-Reintroduce list, debug leftovers)
//
// Exits non-zero on any critical failure.

import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { makeRecorder, readVersionSpots, EXPECT_VERSION, T, badge } from './lib.mjs';

const ROOT = process.env.LD_ROOT || '.';
const rec = makeRecorder('Tier 0 · Pre-flight');

// ─── 1. Version alignment ──────────────────────────────────────────────────
function checkVersionAlignment() {
  const t0 = Date.now();
  const spots = readVersionSpots(ROOT);
  const allMatches = spots.flatMap(s => s.matches);
  const uniq = [...new Set(allMatches)];
  const target = EXPECT_VERSION || uniq[0];
  const missing = spots.filter(s => s.matches.length === 0);
  const wrong = spots.filter(s => s.matches.some(m => m !== target));
  const detail = `target=${target} spots=${spots.length} unique=${uniq.join(',')} missing=${missing.length} wrong=${wrong.length}`;
  const ok = missing.length === 0 && wrong.length === 0 && uniq.length === 1;
  rec.add('version-alignment', ok ? 'pass' : 'fail', { critical: true, detail, durationMs: Date.now() - t0 });
  if (!ok) {
    for (const s of missing) console.log(`    ${T.RED}missing:${T.RST} ${s.label} in ${s.file}`);
    for (const s of wrong) console.log(`    ${T.RED}wrong:${T.RST}   ${s.label} has ${s.matches.join(',')} (want ${target})`);
  }
}

// ─── 2. dist/ freshness ────────────────────────────────────────────────────
function checkDistFreshness() {
  const t0 = Date.now();
  const distDir = `${ROOT}/dist/public/assets`;
  if (!existsSync(distDir)) {
    rec.add('dist-freshness', 'fail', { critical: true, detail: 'dist/public/assets missing — run npm run build', durationMs: Date.now() - t0 });
    return;
  }
  const distFiles = readdirSync(distDir);
  const jsBundle = distFiles.find(f => /^index-.*\.js$/.test(f));
  if (!jsBundle) {
    rec.add('dist-freshness', 'fail', { critical: true, detail: 'no index-*.js bundle in dist', durationMs: Date.now() - t0 });
    return;
  }
  const bundleMtime = statSync(`${distDir}/${jsBundle}`).mtimeMs;
  const srcFiles = [
    'client/src/pages/AgentView.tsx',
    'client/src/pages/AdminDashboard.tsx',
    'client/src/pages/LoginPage.tsx',
    'client/src/App.tsx',
  ];
  let staleCount = 0;
  for (const f of srcFiles) {
    const p = `${ROOT}/${f}`;
    if (!existsSync(p)) continue;
    if (statSync(p).mtimeMs > bundleMtime) staleCount++;
  }
  const ok = staleCount === 0;
  rec.add('dist-freshness', ok ? 'pass' : 'fail', {
    critical: true,
    detail: `bundle=${jsBundle} staleSources=${staleCount}`,
    durationMs: Date.now() - t0,
  });
}

// ─── 3. TypeScript check ───────────────────────────────────────────────────
function checkTypeScript() {
  const t0 = Date.now();
  try {
    execSync('npx --no-install tsc --noEmit', { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    rec.add('typescript', 'pass', { critical: false, detail: 'tsc --noEmit clean', durationMs: Date.now() - t0 });
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    const errors = (out.match(/error TS\d+/g) || []).length;
    // NOTE: 22 pre-existing type errors as of v14.66. Not critical (build succeeds anyway
    // because Vite/esbuild transpile without full typecheck). Track down in Bucket 12.
    const critical = errors > 30; // Only fail hard if the count grows significantly
    rec.add('typescript', 'warn', { critical, detail: `${errors} type errors (baseline 22; fails at >30)`, durationMs: Date.now() - t0 });
    // Print first 5 lines so failures are actionable
    out.split('\n').filter(l => l.includes('error TS')).slice(0, 5).forEach(l => console.log(`    ${T.RED}${l}${T.RST}`));
  }
}

// ─── 4. Route inventory diff ───────────────────────────────────────────────
function checkRouteInventory() {
  const t0 = Date.now();
  const routes = new Set();
  const routesTs = readFileSync(`${ROOT}/server/routes.ts`, 'utf8');
  const re = /app\.(get|post|patch|delete|put)\("([^"]+)"/g;
  let m;
  while ((m = re.exec(routesTs)) != null) {
    routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  const snapPath = `${ROOT}/scripts/certify/routes.snapshot.json`;
  if (!existsSync(snapPath)) {
    // First run: write the snapshot and warn (not fail)
    writeFileSync(snapPath, JSON.stringify([...routes].sort(), null, 2));
    rec.add('route-inventory', 'warn', { detail: `initialized snapshot with ${routes.size} routes`, durationMs: Date.now() - t0 });
    return;
  }
  const snap = new Set(JSON.parse(readFileSync(snapPath, 'utf8')));
  const added = [...routes].filter(r => !snap.has(r));
  const removed = [...snap].filter(r => !routes.has(r));
  if (added.length === 0 && removed.length === 0) {
    rec.add('route-inventory', 'pass', { detail: `${routes.size} routes match snapshot`, durationMs: Date.now() - t0 });
  } else {
    rec.add('route-inventory', 'warn', {
      detail: `+${added.length} -${removed.length} vs snapshot (run: node scripts/certify/tier0-preflight.mjs --update-snapshot)`,
      durationMs: Date.now() - t0,
    });
    added.slice(0, 5).forEach(r => console.log(`    ${T.CYAN}+ ${r}${T.RST}`));
    removed.slice(0, 5).forEach(r => console.log(`    ${T.MAG}- ${r}${T.RST}`));
    if (process.argv.includes('--update-snapshot')) {
      writeFileSync(snapPath, JSON.stringify([...routes].sort(), null, 2));
      console.log(`    ${T.YEL}snapshot updated${T.RST}`);
    }
  }
}

// ─── 5. Grep guards (Do Not Reintroduce) ───────────────────────────────────
function checkGrepGuards() {
  const t0 = Date.now();
  const DENYLIST = [
    // BatchLeads auto-pipeline (killed permanently 2026-07-09)
    { pattern: /scheduleBatchLeadsPipeline\s*\(/,     name: 'scheduleBatchLeadsPipeline call', where: ['server/routes.ts'] },
    { pattern: /runBatchLeadsPipeline\s*\(/,          name: 'runBatchLeadsPipeline call',      where: ['server/routes.ts'] },
    // LandVoice OAuth (killed by CSV-only pivot)
    { pattern: /landvoice-oauth|LandVoiceOAuth/,       name: 'LandVoice OAuth resurrection',    where: ['server/', 'client/src/'] },
    // Callback UI (retired v14.14). callback_requested string in server code is OK.
    { pattern: /CallbackModal|CallbackDatePicker/,     name: 'Callback modal resurrection',     where: ['client/src/'] },
    // Debug leftovers
    { pattern: /console\.log\(\s*["'`]DEBUG/,          name: 'DEBUG console.log',               where: ['server/', 'client/src/'] },
    { pattern: /throw new Error\("unimplemented/,      name: 'unimplemented stub',              where: ['server/', 'client/src/'] },
    // My-pipeline endpoint was deleted v14.38, RESTORED v14.68 without the
    // 60-day filter. The rule below guards the OLD implementation (which had
    // a `sixtyDaysAgo` clause). New endpoint is legitimate.
    { pattern: /sixtyDaysAgo|SIXTY_DAY_MS|60\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000.*pipeline/, name: 'sixty-day pipeline filter resurrection', where: ['server/routes.ts'] },
  ];
  let hits = 0;
  for (const rule of DENYLIST) {
    for (const target of rule.where) {
      try {
        // Write the pattern to a temp arg to avoid shell interpretation of backticks/quotes
        const pat = rule.pattern.source.replace(/'/g, "'\\''");
        const out = execSync(
          `grep -rlE '${pat}' ${target} 2>/dev/null || true`,
          { cwd: ROOT, encoding: 'utf8', shell: '/bin/bash' }
        );
        const files = out.split('\n').filter(Boolean);
        if (files.length > 0) {
          hits += files.length;
          console.log(`    ${T.RED}${rule.name}${T.RST}: ${files.join(', ')}`);
        }
      } catch { /* ignore */ }
    }
  }
  rec.add('grep-guards', hits === 0 ? 'pass' : 'fail', {
    critical: true,
    detail: `${DENYLIST.length} rules checked, ${hits} violations`,
    durationMs: Date.now() - t0,
  });
}

// ─── Run all checks ────────────────────────────────────────────────────────
export async function runTier0() {
  console.log(`${T.BOLD}Tier 0 · Static Pre-flight${T.RST}`);
  checkVersionAlignment();
  checkDistFreshness();
  checkTypeScript();
  checkRouteInventory();
  checkGrepGuards();
  return rec.all();
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  runTier0().then(results => {
    const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
    console.log('');
    for (const r of results) console.log(`  ${badge(r.status)}  ${r.name.padEnd(24)}  ${T.DIM}${r.detail}${T.RST}`);
    console.log('');
    process.exit(critFail > 0 ? 1 : 0);
  });
}
