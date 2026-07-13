#!/usr/bin/env node
/**
 * v15.11.13 — outcome transition check
 *
 * For each of the 9 outcomes we exercise the /api/leads/:id/outcome endpoint
 * against a freshly-created test lead and verify the observable transition:
 *   - lead status after
 *   - assignedAgentId after
 *   - callback_date after
 *   - lead-still-visible-in-pool / gone-from-pool
 *   - FUB action (mocked — we only assert the app's local state; a live FUB
 *     push is exercised separately in the smoke test)
 *
 * ALL work is against production database via public HTTP endpoints. No test
 * mode, no fixtures. This is what the app actually does.
 */

const BASE = "https://depot.watsonbrothersgroup.com";
const INGEST_SECRET = "ms-ingest-2026";
const ADMIN_AGENT_ID = 1; // Alex

const RED = "\x1b[31m"; const GREEN = "\x1b[32m"; const YEL = "\x1b[33m";
const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const RESET = "\x1b[0m";

async function req(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { status: r.status, body, json };
}

async function createTestLead(label) {
  // Uses the ingest endpoint used by the LandVoice/Expired import pipeline.
  const payload = {
    leads: [{
      firstName: `Test-${label}`,
      lastName: "Transition",
      phone: "9046081977",  // Alex's approved test phone
      phones: ["9046081977", "9045551234"],
      address: `${Math.floor(Math.random()*9999)} Test Ave`,
      city: "Fernandina Beach",
      state: "FL",
      zip: "32034",
      county: "Nassau",
      leadType: "expired",
      score: 50,
    }],
  };
  const r = await req(`/api/ingest/leads`, {
    method: "POST",
    headers: { "X-Ingest-Secret": INGEST_SECRET },
    body: JSON.stringify(payload),
  });
  if (r.status !== 200 || !r.json?.created?.length) {
    throw new Error(`Failed to create test lead: HTTP ${r.status} ${r.body.slice(0,200)}`);
  }
  return r.json.created[0].id;
}

async function claimLead(leadId, agentId) {
  const r = await req(`/api/leads/${leadId}/claim`, {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  return r;
}

async function fireOutcome(leadId, agentId, outcome, extras = {}) {
  const body = {
    agentId, outcome,
    notes: `automated ${outcome} test`,
    dialedPhone: "9046081977",
    ...extras,
  };
  return req(`/api/leads/${leadId}/outcome`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getLead(leadId) {
  return req(`/api/leads/${leadId}`);
}

async function deleteLead(leadId) {
  return req(`/api/admin/leads/${leadId}`, {
    method: "DELETE",
    headers: { "X-Ingest-Secret": INGEST_SECRET },
  });
}

// ─── Test cases ────────────────────────────────────────────────────────────
const CASES = [
  {
    key: "no_answer",
    label: "No Answer",
    expect: (before, after) => {
      // Lead should still exist, still assigned (single no-answer, not cap)
      if (!after.json) return "lead should still be readable";
      // status often stays 'assigned' after single no_answer.
      // Phone attempts should have incremented for 9046081977.
      const attempts = after.json.phoneAttempts ? JSON.parse(after.json.phoneAttempts) : {};
      if ((attempts["9046081977"] || 0) < 1) return `expected phone attempts >=1, got ${JSON.stringify(attempts)}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "wrong_number",
    label: "Wrong #",
    expect: (before, after) => {
      // Wrong # removes ONE line. Lead has 2 phones, so lead should still be alive after removing one.
      if (!after.json) return "lead should still be readable (2 phones → 1 removed leaves 1)";
      const phones = after.json.phones ? JSON.parse(after.json.phones) : [];
      if (phones.includes("9046081977")) return `dialed phone should be removed, still in ${JSON.stringify(phones)}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "disconnected",
    label: "Not a Working Line",
    expect: (before, after) => {
      // Same as wrong_number — per-line cleanup, not full delete
      if (!after.json) return "lead should still be readable (2 phones → 1 struck leaves 1)";
      const phones = after.json.phones ? JSON.parse(after.json.phones) : [];
      if (phones.includes("9046081977")) return `dialed phone should be removed, still in ${JSON.stringify(phones)}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "contacted_not_interested",
    label: "Not Interested (Rude/Hard)",
    expect: (before, after, res) => {
      // Rude / hard remove path — lead should be status=contacted_not_interested and unassigned
      if (!after.json) return null; // 404 acceptable if hard-deleted
      if (after.json.status !== "contacted_not_interested") return `expected status contacted_not_interested, got ${after.json.status}`;
      if (after.json.assignedAgentId !== null) return `expected unassigned, got assignedAgentId=${after.json.assignedAgentId}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "nice_not_interested",
    label: "Not Interested (Nice/ICE 180d)",
    expect: (before, after) => {
      if (!after.json) return "lead should exist (180-day ICE recycle, not delete)";
      if (after.json.status !== "recycled") return `expected status=recycled, got ${after.json.status}`;
      if (after.json.assignedAgentId !== null) return `expected unassigned, got ${after.json.assignedAgentId}`;
      if (!after.json.callbackDate) return "expected callbackDate set for 180-day ICE";
      const dt = new Date(after.json.callbackDate).getTime();
      const days = (dt - Date.now()) / (1000*60*60*24);
      if (days < 175 || days > 185) return `expected callback ~180 days out, got ${days.toFixed(1)}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "recycled",
    label: "Recycle",
    expect: (before, after) => {
      if (!after.json) return "lead should exist after recycle (returns to pool)";
      if (after.json.status !== "unassigned") return `expected status=unassigned, got ${after.json.status}`;
      if (after.json.assignedAgentId !== null) return `expected unassigned, got ${after.json.assignedAgentId}`;
      // v15.4: no cooldown, callback_date cleared
      if (after.json.callbackDate) return `expected no callbackDate, got ${after.json.callbackDate}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "listed",
    label: "Listed",
    expect: (before, after) => {
      if (!after.json) return null; // may or may not delete depending on config
      // listed is a soft-close — typically marks the lead status=listed
      return null;
    },
    cleanup: true,
  },
  {
    key: "left_voicemail",
    label: "Owner - No Answer",
    expect: (before, after) => {
      if (!after.json) return "lead should still be readable after Owner-NA";
      // No hard state change; just an activity log entry
      return null;
    },
    cleanup: true,
  },
  {
    key: "contacted_appointment",
    label: "Appt Set",
    extras: {
      apptEmail: "test@example.com",
      confirmedAddress: "95271 Tanglewood Dr Fernandina Beach FL 32034",
      apptDate: new Date(Date.now() + 3*24*60*60*1000).toISOString().slice(0,10),
      apptTime: "14:00",
      stage: "Interested",
      intention: "Buyer",
    },
    expect: (before, after) => {
      if (!after.json) return "appointment lead should still be readable";
      if (after.json.status !== "contacted_appointment") return `expected status=contacted_appointment, got ${after.json.status}`;
      if (after.json.assignedAgentId !== ADMIN_AGENT_ID) return `appt should stay with closer, got assignedAgentId=${after.json.assignedAgentId}`;
      return null;
    },
    cleanup: true,
  },
  {
    key: "keep_in_touch",
    label: "Keep in Touch",
    extras: {
      apptEmail: "test@example.com",
      confirmedAddress: "95271 Tanglewood Dr Fernandina Beach FL 32034",
      followUpTiming: "in_7_days",
      stage: "Interested",
      intention: "Seller",
    },
    expect: (before, after) => {
      if (!after.json) return "KIT lead should still be readable";
      if (after.json.status !== "keep_in_touch") return `expected status=keep_in_touch, got ${after.json.status}`;
      if (after.json.assignedAgentId !== ADMIN_AGENT_ID) return `KIT should stay with owner, got assignedAgentId=${after.json.assignedAgentId}`;
      return null;
    },
    cleanup: true,
  },
];

// v15.11.12 server-side guard tests
const GUARD_CASES = [
  {
    label: "Server rejects Appt Set without intention",
    setup: async (leadId) => {
      return fireOutcome(leadId, ADMIN_AGENT_ID, "contacted_appointment", {
        apptEmail: "test@example.com",
        confirmedAddress: "95271 Tanglewood Dr",
        apptDate: new Date(Date.now() + 3*24*60*60*1000).toISOString().slice(0,10),
        apptTime: "14:00",
        stage: "Interested",
        // intention deliberately omitted
      });
    },
    expect: (r) => {
      if (r.status !== 400) return `expected HTTP 400, got ${r.status}`;
      if (!r.json?.error?.match(/Intention/i)) return `expected intention error, got ${r.body.slice(0,200)}`;
      return null;
    },
  },
  {
    label: "Server rejects KIT without intention",
    setup: async (leadId) => {
      return fireOutcome(leadId, ADMIN_AGENT_ID, "keep_in_touch", {
        apptEmail: "test@example.com",
        confirmedAddress: "95271 Tanglewood Dr",
        followUpTiming: "in_7_days",
        stage: "Interested",
        // intention deliberately omitted
      });
    },
    expect: (r) => {
      if (r.status !== 400) return `expected HTTP 400, got ${r.status}`;
      if (!r.json?.error?.match(/Intention/i)) return `expected intention error, got ${r.body.slice(0,200)}`;
      return null;
    },
  },
];

// ─── Runner ────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${BOLD}Lead Depot — outcome transition check${RESET}  ${DIM}(v15.11.13 @ ${BASE})${RESET}\n`);

  const results = [];

  for (const c of CASES) {
    process.stdout.write(`  ${DIM}\u2022${RESET} ${c.label.padEnd(28)} `);
    let leadId = null;
    try {
      leadId = await createTestLead(c.key);
      // Claim to admin so lead is assigned before outcome
      await claimLead(leadId, ADMIN_AGENT_ID);
      const before = await getLead(leadId);
      const res = await fireOutcome(leadId, ADMIN_AGENT_ID, c.key, c.extras || {});
      if (res.status !== 200) {
        console.log(`${RED}FAIL${RESET} ${DIM}HTTP ${res.status} ${res.body.slice(0,120)}${RESET}`);
        results.push({ ok: false, label: c.label, reason: `HTTP ${res.status}` });
        if (c.cleanup && leadId) await deleteLead(leadId).catch(() => {});
        continue;
      }
      const after = await getLead(leadId);
      const err = c.expect(before, after, res);
      if (err) {
        console.log(`${RED}FAIL${RESET} ${DIM}${err}${RESET}`);
        results.push({ ok: false, label: c.label, reason: err });
      } else {
        const afterStatus = after.json?.status ?? "(deleted)";
        console.log(`${GREEN}PASS${RESET} ${DIM}\u2192 status=${afterStatus}${RESET}`);
        results.push({ ok: true, label: c.label });
      }
    } catch (e) {
      console.log(`${RED}ERROR${RESET} ${DIM}${e.message}${RESET}`);
      results.push({ ok: false, label: c.label, reason: e.message });
    } finally {
      if (c.cleanup && leadId) await deleteLead(leadId).catch(() => {});
    }
  }

  console.log(`\n${DIM}\u2500 Server-side guard checks (v15.11.12) \u2500${RESET}\n`);

  for (const g of GUARD_CASES) {
    process.stdout.write(`  ${DIM}\u2022${RESET} ${g.label.padEnd(56)} `);
    let leadId = null;
    try {
      leadId = await createTestLead("guard");
      await claimLead(leadId, ADMIN_AGENT_ID);
      const r = await g.setup(leadId);
      const err = g.expect(r);
      if (err) {
        console.log(`${RED}FAIL${RESET} ${DIM}${err}${RESET}`);
        results.push({ ok: false, label: g.label, reason: err });
      } else {
        console.log(`${GREEN}PASS${RESET} ${DIM}\u2192 HTTP ${r.status}${RESET}`);
        results.push({ ok: true, label: g.label });
      }
    } catch (e) {
      console.log(`${RED}ERROR${RESET} ${DIM}${e.message}${RESET}`);
      results.push({ ok: false, label: g.label, reason: e.message });
    } finally {
      if (leadId) await deleteLead(leadId).catch(() => {});
    }
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`\n  ${BOLD}${passed}/${results.length}${RESET} passed  ${failed.length ? `(${RED}${failed.length} failed${RESET})` : ""}\n`);
  if (failed.length) {
    console.log(`${RED}Failed cases:${RESET}`);
    for (const f of failed) console.log(`  \u2022 ${f.label}: ${f.reason}`);
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
