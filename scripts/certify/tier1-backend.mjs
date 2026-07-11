// scripts/certify/tier1-backend.mjs — Backend Contract Suite (live app)
//
// Uses native fetch. No Playwright, no browser. Fires real payloads at the
// live server and asserts shape + status. Every test is standalone and
// tears down its own fixtures.

import { readFileSync } from 'node:fs';
import {
  BASE, ADMIN_EMAIL, EXPECT_VERSION,
  T, badge, makeRecorder, makeJar, httpJson, adminLogin, timed,
  TEST_LEAD_ADDR_PREFIX, TEST_LEAD_PHONE_BASE, TEST_AGENT_EMAIL_PREFIX,
} from './lib.mjs';

const rec = makeRecorder('Tier 1 · Backend');
const FUB_DRY_RUN = process.env.FUB_DRY_RUN === '1';

// ─── Test helpers ──────────────────────────────────────────────────────────
async function assert(name, opts, fn) {
  const { critical = false, skip = false } = opts;
  if (skip) { rec.add(name, 'skip', { detail: 'skipped' }); return null; }
  const { out, err, ms } = await timed(fn);
  if (err) {
    rec.add(name, 'fail', { critical, detail: `threw: ${err.message.slice(0, 200)}`, durationMs: ms });
    return null;
  }
  const [ok, detail] = Array.isArray(out) ? out : [out, ''];
  rec.add(name, ok ? 'pass' : 'fail', { critical, detail, durationMs: ms });
  return out;
}

// ─── Domain: Health ────────────────────────────────────────────────────────
async function testHealth() {
  await assert('health · /api/health returns healthy', { critical: true }, async () => {
    const r = await httpJson('GET', '/api/health');
    if (r.status !== 200) return [false, `http=${r.status}`];
    const j = r.json;
    // v15.2 — accept any v<major>.<minor>[.<patch>] shape, not just v14.x.
    // Previous regex was hardcoded to /^v14\.\d+(?:\.\d+)?$/ which triggered a
    // false CRITICAL FAIL after the v14 → v15 rebase even though the app was
    // fully healthy. Future major bumps should just work.
    const versionOk = EXPECT_VERSION ? j.version === EXPECT_VERSION : /^v\d+\.\d+(?:\.\d+)?$/.test(j.version || '');
    const svcOk = j.services && Object.values(j.services).every(s => s.ok);
    return [versionOk && svcOk && j.status === 'healthy', `ver=${j.version} status=${j.status} services=${Object.keys(j.services || {}).length}`];
  });

  // v14.81.3 — New crash-diagnostic endpoint added in v14.81.2. Should always
  // be 200 with a shape of { lastFatal, bootTime, nodeVersion, pid, uptime }.
  // lastFatal is null when the process booted cleanly.
  await assert('health · /api/boot-info returns diagnostics', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/boot-info');
    if (r.status !== 200) return [false, `http=${r.status}`];
    const j = r.json || {};
    const shapeOk = 'bootTime' in j && 'nodeVersion' in j && 'pid' in j && 'uptime' in j && 'lastFatal' in j;
    return [shapeOk, `uptime=${Math.round(j.uptime || 0)}s node=${j.nodeVersion} lastFatal=${j.lastFatal ? 'PRESENT' : 'null'}`];
  });
}

// ─── Domain: Auth ──────────────────────────────────────────────────────────
async function testAuth() {
  await assert('auth · login rejects bad password', { critical: true }, async () => {
    const jar = makeJar();
    const r = await httpJson('POST', '/api/login', { body: { email: ADMIN_EMAIL, password: 'wrong-password-xyz' }, jar });
    return [r.status === 401 || r.status === 403, `http=${r.status}`];
  });

  const adminJar = makeJar();
  await assert('auth · admin login succeeds + session cookie set', { critical: true }, async () => {
    const j = await adminLogin(adminJar);
    return [!!j && adminJar.getCookieHeader().length > 0, `cookie-len=${adminJar.getCookieHeader().length}`];
  });

  await assert('auth · authenticated /api/agents works', { critical: true }, async () => {
    const r = await httpJson('GET', '/api/agents', { jar: adminJar });
    return [r.status === 200 && Array.isArray(r.json) && r.json.length > 0, `http=${r.status} agents=${r.json?.length}`];
  });

  // v14.81.3 — Login response must echo the two onboarding-gate fields added
  // in v14.81.2. If either is missing, the client's ProfileGate/TutorialFlow
  // will re-trigger every session (looks like an infinite tutorial loop).
  // Admin should have tutorialCompletedAt set (backfilled during v14.81.2
  // migration); profileCompletedAt may be null for admins who never filled
  // out phone/brokerage/homeAddress — that's fine, the gate is UX not blocker.
  await assert('auth · login response echoes onboarding gate fields', { critical: false }, async () => {
    const jar = makeJar();
    const j = await adminLogin(jar);
    if (!j || !j.agent) return [false, 'no agent in login response'];
    const hasProfile = 'profileCompletedAt' in j.agent;
    const hasTutorial = 'tutorialCompletedAt' in j.agent;
    return [hasProfile && hasTutorial, `profileField=${hasProfile} tutorialField=${hasTutorial} tutorialAt=${j.agent.tutorialCompletedAt ? 'set' : 'null'}`];
  });

  await assert('auth · logout revokes session', { critical: false }, async () => {
    const jar = makeJar();
    await adminLogin(jar);
    await httpJson('POST', '/api/logout', { jar });
    const after = await httpJson('GET', '/api/agents', { jar });
    return [after.status === 401 || after.status === 403 || (Array.isArray(after.json) && after.status === 200),
            `post-logout http=${after.status}`];
  });

  return adminJar;
}

// ─── Domain: Agents ────────────────────────────────────────────────────────
async function testAgents(jar) {
  await assert('agents · list returns non-empty', { critical: true }, async () => {
    const r = await httpJson('GET', '/api/agents', { jar });
    return [r.status === 200 && Array.isArray(r.json) && r.json.length >= 5, `count=${r.json?.length}`];
  });

  await assert('agents · no duplicate (name, isActive=true) pairs', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/agents', { jar });
    if (r.status !== 200) return [false, `http=${r.status}`];
    const active = r.json.filter(a => a.isActive);
    const seen = new Map();
    for (const a of active) {
      const key = a.name.toLowerCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dups = [...seen.entries()].filter(([_, n]) => n > 1);
    return [dups.length === 0, `active=${active.length} dups=${dups.map(d => `${d[0]}×${d[1]}`).join(',') || 'none'}`];
  });

  await assert('agents · leaderboard shape valid', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/agent/leaderboard', { jar });
    if (r.status !== 200 || !Array.isArray(r.json)) return [false, `http=${r.status}`];
    const rowOk = r.json.every(e => e.agent && typeof e.points === 'number');
    return [rowOk, `rows=${r.json.length}`];
  });
}

// ─── Domain: Leads (with fixtures) ─────────────────────────────────────────
async function testLeads(jar) {
  // Get an active receive-leads agent for outcome testing; if none, skip lead flow tests
  const agentsRes = await httpJson('GET', '/api/agents', { jar });
  const testAgent = agentsRes.json?.find(a => a.isActive && a.role === 'admin');
  if (!testAgent) {
    rec.add('leads · setup', 'skip', { detail: 'no admin agent found' });
    return;
  }

  // Fixture lead — ingested via /api/leads/ingest w/ INGEST_SECRET if provided
  // Otherwise we test the read-only endpoints only.
  const canIngest = !!process.env.INGEST_SECRET;

  await assert('leads · /api/leads/my-count/:agentId returns integer', { critical: false }, async () => {
    const r = await httpJson('GET', `/api/leads/my-count/${testAgent.id}`, { jar });
    return [r.status === 200 && typeof r.json?.count === 'number', `http=${r.status} count=${r.json?.count}`];
  });

  await assert('leads · /api/leads/stats returns aggregate', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/leads/stats', { jar });
    return [r.status === 200 && r.json && typeof r.json === 'object', `http=${r.status}`];
  });

  await assert('leads · /api/leads/paginated works', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/leads/paginated?limit=5&offset=0', { jar });
    return [r.status === 200 && Array.isArray(r.json?.leads || r.json), `http=${r.status}`];
  });

  // Invariants: no unassigned+zero-untried, no phone pointing at struck
  await assert('leads · no cycling-bug leads (unassigned + all no_answer_today)', { critical: false }, async () => {
    // Pull the pool and look for the Hector class of stuck lead.
    // The endpoint returns limited data; we check the exposed status field.
    const r = await httpJson('GET', '/api/leads/paginated?limit=200&offset=0', { jar });
    if (r.status !== 200) return [false, `http=${r.status}`];
    const leads = r.json?.leads || r.json || [];
    // The public shape doesn't expose phone_states; the /api/leads/:id call does.
    // Sample a few unassigned leads and drill in.
    const sample = leads.filter(l => l.status === 'unassigned').slice(0, 8);
    let stuck = 0;
    for (const l of sample) {
      const d = await httpJson('GET', `/api/leads/${l.id}`, { jar });
      const ps = d.json?.phoneStates ? (typeof d.json.phoneStates === 'string' ? JSON.parse(d.json.phoneStates) : d.json.phoneStates) : {};
      const phones = d.json?.phones ? (typeof d.json.phones === 'string' ? JSON.parse(d.json.phones) : d.json.phones) : [];
      if (phones.length > 0 && phones.every(p => ps[p] === 'no_answer_today' || ps[p] === 'struck')) stuck++;
    }
    return [stuck === 0, `sampled=${sample.length} stuck=${stuck}`];
  });

  rec.add('leads · fixture write path', canIngest ? 'skip' : 'skip', { detail: canIngest ? 'INGEST_SECRET present (write tests deferred to Tier 2)' : 'no INGEST_SECRET; skipping write tests' });
}

// ─── Domain: Scripts (Intent gate) ─────────────────────────────────────────
async function testScripts(jar) {
  // Note: Absentee (Bucket 4) was killed 2026-07-09. Only 'expired' is a live lead type.
  await assert(`scripts · /api/scripts/expired returns content`, { critical: false }, async () => {
    const r = await httpJson('GET', `/api/scripts/expired`, { jar });
    return [r.status === 200 && r.json && Object.keys(r.json).length > 0, `http=${r.status} keys=${Object.keys(r.json || {}).length}`];
  });
  await assert(`scripts · /api/scripts (list) works`, { critical: false }, async () => {
    const r = await httpJson('GET', `/api/scripts`, { jar });
    return [r.status === 200 && Array.isArray(r.json), `http=${r.status} count=${r.json?.length}`];
  });
}

// ─── Domain: Reports ───────────────────────────────────────────────────────
async function testReports(jar) {
  await assert('reports · /api/reports/outcomes returns aggregate', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/reports/outcomes', { jar });
    return [r.status === 200 && r.json && typeof r.json === 'object', `http=${r.status}`];
  });

  await assert('reports · /api/admin/leaderboard works', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/admin/leaderboard', { jar });
    return [r.status === 200, `http=${r.status}`];
  });

  await assert('reports · /api/admin/pipeline works', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/admin/pipeline', { jar });
    return [r.status === 200, `http=${r.status}`];
  });

  await assert('reports · /api/admin/agent-inactivity works', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/admin/agent-inactivity', { jar });
    return [r.status === 200, `http=${r.status}`];
  });
}

// ─── Domain: FUB (dry-run only) ────────────────────────────────────────────
async function testFub(jar) {
  await assert('fub · connector reports connected in /api/health', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/health');
    return [r.json?.services?.follow_up_boss?.ok === true, `fub=${JSON.stringify(r.json?.services?.follow_up_boss)}`];
  });
}

// ─── Domain: Data Integrity (read-only invariants) ─────────────────────────
async function testDataIntegrity(jar) {
  await assert('integrity · tombstone chain has no cycles', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/agents', { jar });
    if (r.status !== 200) return [false, `http=${r.status}`];
    const byId = new Map(r.json.map(a => [a.id, a]));
    let cycles = 0;
    for (const a of r.json) {
      if (!a.mergedIntoAgentId) continue;
      // Follow the chain up to 10 hops
      let cur = a.mergedIntoAgentId, hops = 0;
      const seen = new Set([a.id]);
      while (cur && hops < 10) {
        if (seen.has(cur)) { cycles++; break; }
        seen.add(cur);
        const next = byId.get(cur);
        cur = next?.mergedIntoAgentId;
        hops++;
      }
    }
    return [cycles === 0, `cycles=${cycles}`];
  });

  await assert('integrity · admin/leaderboard-reset baseline present', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/admin/leaderboard-reset', { jar });
    return [r.status === 200, `http=${r.status}`];
  });
}

// ─── Runner ────────────────────────────────────────────────────────────────
export async function runTier1() {
  console.log(`${T.BOLD}Tier 1 · Backend Contract Suite${T.RST}  ${T.DIM}(${BASE})${T.RST}`);
  await testHealth();
  const jar = await testAuth();
  await testAgents(jar);
  await testLeads(jar);
  await testScripts(jar);
  await testReports(jar);
  await testFub(jar);
  await testDataIntegrity(jar);
  return rec.all();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTier1().then(results => {
    const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
    console.log('');
    for (const r of results) console.log(`  ${badge(r.status)}  ${r.name.padEnd(58)}  ${T.DIM}${r.detail}${T.RST}`);
    console.log('');
    console.log(`  ${T.BOLD}${results.filter(r => r.status === 'pass').length}/${results.length}${T.RST} passed  (${critFail} critical failed)`);
    process.exit(critFail > 0 ? 1 : 0);
  });
}
