// scripts/certify/tier4-integrity.mjs — Data Integrity Post-flight
//
// Read-only invariants on the live DB via the admin API. Cheap to run.
// Suitable for post-deploy AND nightly cron.

import {
  BASE, T, badge, makeRecorder, makeJar, httpJson, adminLogin, timed,
} from './lib.mjs';

const rec = makeRecorder('Tier 4 · Data Integrity');

async function inv(name, opts, fn) {
  const { critical = false } = opts;
  const { out, err, ms } = await timed(fn);
  if (err) {
    rec.add(name, 'fail', { critical, detail: `threw: ${err.message.slice(0, 200)}`, durationMs: ms });
    return;
  }
  const [ok, detail] = Array.isArray(out) ? out : [out, ''];
  rec.add(name, ok ? 'pass' : 'fail', { critical, detail, durationMs: ms });
}

export async function runTier4() {
  console.log(`${T.BOLD}Tier 4 · Data Integrity Post-flight${T.RST}  ${T.DIM}(${BASE})${T.RST}`);
  const jar = makeJar();
  await adminLogin(jar);

  const agentsR = await httpJson('GET', '/api/agents', { jar });
  const agents = agentsR.json || [];

  // Invariant 1: no duplicate (name, isActive=true) pairs
  await inv('inv · no duplicate active agent names', { critical: false }, async () => {
    const active = agents.filter(a => a.isActive);
    const seen = new Map();
    for (const a of active) {
      const key = a.name.toLowerCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dups = [...seen.entries()].filter(([_, n]) => n > 1);
    return [dups.length === 0, `active=${active.length} dups=${dups.map(d => `${d[0]}×${d[1]}`).join(',') || 'none'}`];
  });

  // Invariant 2: tombstone chain has no cycles / dangling refs
  await inv('inv · merge tombstone chain valid', { critical: false }, async () => {
    const byId = new Map(agents.map(a => [a.id, a]));
    let cycles = 0, dangling = 0;
    for (const a of agents) {
      if (!a.mergedIntoAgentId) continue;
      if (!byId.has(a.mergedIntoAgentId)) { dangling++; continue; }
      let cur = a.mergedIntoAgentId, hops = 0;
      const seen = new Set([a.id]);
      while (cur && hops < 20) {
        if (seen.has(cur)) { cycles++; break; }
        seen.add(cur);
        cur = byId.get(cur)?.mergedIntoAgentId;
        hops++;
      }
    }
    return [cycles === 0 && dangling === 0, `cycles=${cycles} dangling=${dangling}`];
  });

  // Invariant 3: cycling-bug detector (sample unassigned leads)
  await inv('inv · no cycling-bug leads (Hector class)', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/leads/paginated?limit=100&offset=0', { jar });
    const leads = r.json?.leads || r.json || [];
    const sample = leads.filter(l => l.status === 'unassigned').slice(0, 12);
    let stuck = 0;
    for (const l of sample) {
      const d = await httpJson('GET', `/api/leads/${l.id}`, { jar });
      const ps = d.json?.phoneStates ? (typeof d.json.phoneStates === 'string' ? JSON.parse(d.json.phoneStates) : d.json.phoneStates) : {};
      const phones = d.json?.phones ? (typeof d.json.phones === 'string' ? JSON.parse(d.json.phones) : d.json.phones) : [];
      if (phones.length > 0 && phones.every(p => ps[p] === 'no_answer_today' || ps[p] === 'struck')) stuck++;
    }
    return [stuck === 0, `sampled=${sample.length} stuck=${stuck}`];
  });

  // Invariant 4: dead_lines does not overlap phones[] (v14.65 boot-sweep sanity)
  await inv('inv · dead_lines disjoint from phones (v14.65 sweep)', { critical: false }, async () => {
    const r = await httpJson('GET', '/api/leads/paginated?limit=200&offset=0', { jar });
    const leads = r.json?.leads || r.json || [];
    const sample = leads.slice(0, 25);
    let overlap = 0;
    for (const l of sample) {
      const d = await httpJson('GET', `/api/leads/${l.id}`, { jar });
      const phones = d.json?.phones ? (typeof d.json.phones === 'string' ? JSON.parse(d.json.phones) : d.json.phones) : [];
      const dead = d.json?.deadLines ? (typeof d.json.deadLines === 'string' ? JSON.parse(d.json.deadLines) : d.json.deadLines) : [];
      const intersect = phones.filter(p => dead.includes(p));
      if (intersect.length > 0) overlap++;
    }
    return [overlap === 0, `sampled=${sample.length} overlap=${overlap}`];
  });

  // Invariant 5: /api/health reports all services ok
  await inv('inv · /api/health all services ok', { critical: true }, async () => {
    const r = await httpJson('GET', '/api/health');
    const services = r.json?.services || {};
    const bad = Object.entries(services).filter(([_, s]) => !s.ok);
    return [bad.length === 0, `bad=${bad.map(b => b[0]).join(',') || 'none'}`];
  });

  // Invariant 6 (v14.81.3): No stale audit rows without corresponding actions.
  // Specifically catch the class of bug we fixed in v14.81.3: hard_deleted
  // audit entries where the target agent row still exists. Before the fix,
  // probe agent id=15 had 11 orphan hard_deleted entries. If this ever
  // returns > 0 again, a hard-delete transaction is silently failing after
  // the audit log write.
  await inv('inv · no orphan hard_deleted audit rows (v14.81.3 regression guard)', { critical: false }, async () => {
    const agentsRes = await httpJson('GET', '/api/agents', { jar });
    const agentIds = new Set((agentsRes.json || []).map(a => a.id));
    // Only admins have audit-log access. Sample recent agent ids and check
    // whether any of them have hard_deleted audit rows despite the row still
    // being present. Cheap heuristic: check first 20 known agents.
    const sample = [...agentIds].slice(0, 20);
    let orphans = 0;
    for (const id of sample) {
      const r = await httpJson('GET', `/api/admin/agents/${id}/audit-log`, { jar });
      const entries = r.json?.entries || [];
      const hardDeletes = entries.filter(e => e.event === 'hard_deleted');
      // Agent still exists (in agentIds) but has hard_deleted rows = orphan.
      if (hardDeletes.length > 0 && agentIds.has(id)) orphans += hardDeletes.length;
    }
    return [orphans === 0, `sampled=${sample.length} orphanRows=${orphans}`];
  });

  return rec.all();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTier4().then(results => {
    const critFail = results.filter(r => r.status === 'fail' && r.critical).length;
    console.log('');
    for (const r of results) console.log(`  ${badge(r.status)}  ${r.name.padEnd(58)}  ${T.DIM}${r.detail}${T.RST}`);
    console.log('');
    console.log(`  ${T.BOLD}${results.filter(r => r.status === 'pass').length}/${results.length}${T.RST} passed  (${critFail} critical failed)`);
    process.exit(critFail > 0 ? 1 : 0);
  });
}
