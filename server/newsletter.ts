// v20.6.0 — Weekly newsletter system.
//   Two newsletters, one cadence:
//     Monday 6am ET  — prep email to Alex asking for BOTH newsletters' inputs
//     Tuesday 8am ET — LD Newsletter to all active agents (personalized)
//     Tuesday 8am ET — BGRE Weekly Newsletter draft to Nate for scheduling
//
// Endpoints (see routes.ts):
//   POST /api/admin/newsletter/prep-email      → sends Monday prep ask
//   POST /api/admin/newsletter/send-ld         → sends Tuesday LD to all active agents
//   POST /api/admin/newsletter/send-bgre       → sends Tuesday BGRE draft to Nate

import { rawDb } from "./db";
import { execSync } from "child_process";

export interface AlexInputs {
  quote?:         string;   // "Quote / scripture / wisdom of the week"
  wins?:          string;   // "Big wins & shoutouts" — free text, agent names + what they did
  conversation?:  string;   // "Conversation starters" — one-liners for calls
  coaching?:      string;   // "This week's coaching focus" — role-play / mindset / challenge
  bgre_topic?:    string;   // BGRE client newsletter: market concern → data → hope → solution
}

// ─── FEATURE ROTATION ──────────────────────────────────────────────────────
//   14 features cycle weekly. Uses ISO week number modulo list length.
const FEATURED_TOOLS: Array<{ title: string; body: string; where: string }> = [
  { title: "FUB Action Plans",       body: "Automated multi-touch cadences that fire without you thinking about it. Set once, never miss a follow-up.", where: "Follow Up Boss → People → pick a lead → Action Plans" },
  { title: "The Recycle Button",     body: "Callback is gone (retired v14.14). When you want to reach a lead later, hit Recycle — it drops them back in the shared pool for anyone to pull. No calendar coordination, no orphans.", where: "Agent view → outcome buttons → Recycle" },
  { title: "Network Referrals",      body: "Bring in a lead from your sphere and get first crack at working it. Earns points, counts on your leaderboard, and skips the shared pool.", where: "Agent view → + → Network Referral" },
  { title: "Open House Assignments", body: "Every Tuesday Denise posts the weekend's schedule. First come, first served. You get the address, access info, and prep checklist automatically.", where: "Agent view → Open Houses tab" },
  { title: "The Pipeline Tab",       body: "See every appointment, KIT, and closing you own. 60-day rolling window. Your business at a glance.", where: "Agent view → Pipeline tab" },
  { title: "Warm Lead Form",         body: "Door-knock, direct-mail, network — all captured through one form with intent selection. Backend routes it automatically to the right inventory bucket.", where: "Agent view → + → Warm Lead" },
  { title: "Daily 5:45pm Digest",    body: "Every weekday afternoon you get a personal email: pool status, your queue, appointments, KIT reminders, and recycles ready. Read it before you shut down.", where: "Your inbox, 5:45pm ET daily" },
  { title: "The Team Map",           body: "See every active listing, buyer, coming soon, and pocket listing on a live map of NEFL + Southeast GA. Toggle layers to focus. Great for lead conversion mid-call.", where: "Agent view → Leaderboard → Map toggle" },
  { title: "The Leaderboard",        body: "Live daily and weekly rankings across dials, appts, KIT, network referrals, and points. Refreshes every few seconds. If you're not on it, you're not moving.", where: "Agent view → Leaderboard tab" },
  { title: "Master List (admin)",    body: "Every buyer + renter in the system, merged across Excel, FUB, and Lead Depot. K to keep, X to kill, toggle rental type. Ask Alex to walk you through it.", where: "Admin only — Admin → Master List" },
  { title: "Buyers on the Hunt",     body: "Every active buyer we're representing, with their price range, preferred areas, and buyer's agent. Search before you show a listing to see if we already have a match.", where: "Agent view → Inventory → Buyers" },
  { title: "The Recycle Pool",       body: "When any agent hits Recycle or No Answer under Pull Mode, the lead flows here. First to grab wins. Refresh the pool if it looks empty — new leads land every hour.", where: "Agent view → Shared Pool" },
  { title: "Live On-Air Widget",     body: "The green dot on the leaderboard shows who's on the phones right now. Peer pressure works.", where: "Admin → Leaderboard, top-left" },
  { title: "The Version Pill",       body: "The little vN.x in the header tells you the app was updated. Tap it — if it says 'new version', pull-refresh to load it.", where: "Any page, top-right" },
];

function isoWeek(d = new Date()): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function featuredTool(): { title: string; body: string; where: string } {
  return FEATURED_TOOLS[isoWeek() % FEATURED_TOOLS.length];
}

// ─── GIT LOG (last 7 days of changes) ───────────────────────────────────
export function recentAppChanges(): Array<{ version: string; blurb: string }> {
  try {
    const raw = execSync(
      `cd /app 2>/dev/null || cd $(pwd); git log --since="7 days ago" --pretty=format:"%s" 2>/dev/null | head -30`,
      { encoding: "utf-8", timeout: 5000 }
    );
    if (!raw) return [];
    // Parse commit messages that start with vN.x — those are the user-visible ones.
    const lines = raw.split("\n").filter(l => /^v\d+\.\d+/.test(l));
    const uniqueVersions = new Map<string, string>();
    for (const line of lines) {
      const m = line.match(/^(v\d+\.\d+(?:\.\d+)?)\s+(?:—|-)?\s*(.+)$/);
      if (m && !uniqueVersions.has(m[1])) {
        uniqueVersions.set(m[1], m[2].trim().slice(0, 140));
      }
    }
    return Array.from(uniqueVersions.entries())
      .slice(0, 5)
      .map(([version, blurb]) => ({ version, blurb }));
  } catch { return []; }
}

// ─── PER-AGENT WEEKLY STATS ─────────────────────────────────────────────
export interface AgentWeekStats {
  agentId: number;
  name: string;
  email: string;
  dials: number;
  appts: number;
  kit: number;
  recycles: number;
  networkRefs: number;
  points: number;
  rank: number | null;    // 1-based rank on the team by points this week
  prevDials: number;
  prevAppts: number;
  prevPoints: number;
  totalAgents: number;
}

export function agentWeekStats(agentId: number, agentName: string, agentEmail: string): AgentWeekStats {
  const q = (sql: string) => (rawDb.prepare(sql).get({ id: agentId }) as any)?.n || 0;

  const dials = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason IN ('dial','call_attempt','wrong_number')`);
  const appts = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'appointment_set'`);
  const kit   = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'keep_in_touch'`);
  const recyc = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'recycled'`);
  const nrefs = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'network_referral'`);
  const points = Number((rawDb.prepare(`SELECT coalesce(SUM(points),0) as n FROM agent_points WHERE agent_id = @id AND created_at >= datetime('now','-7 days')`).get({ id: agentId }) as any)?.n || 0);

  const prevDials  = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-14 days') AND created_at <  datetime('now','-7 days') AND reason IN ('dial','call_attempt','wrong_number')`);
  const prevAppts  = q(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-14 days') AND created_at <  datetime('now','-7 days') AND reason = 'appointment_set'`);
  const prevPoints = Number((rawDb.prepare(`SELECT coalesce(SUM(points),0) as n FROM agent_points WHERE agent_id = @id AND created_at >= datetime('now','-14 days') AND created_at <  datetime('now','-7 days')`).get({ id: agentId }) as any)?.n || 0);

  // Rank by weekly points
  const leaderboard = rawDb.prepare(`
    SELECT ap.agent_id, coalesce(SUM(ap.points),0) as pts
    FROM agent_points ap
    JOIN agents a ON a.id = ap.agent_id
    WHERE ap.created_at >= datetime('now','-7 days') AND a.is_active = 1
    GROUP BY ap.agent_id
    ORDER BY pts DESC
  `).all() as any[];
  const rank = leaderboard.findIndex(r => r.agent_id === agentId);
  const totalAgents = (rawDb.prepare(`SELECT COUNT(*) as n FROM agents WHERE is_active = 1`).get() as any)?.n || 0;

  return {
    agentId, name: agentName, email: agentEmail,
    dials, appts, kit, recycles: recyc, networkRefs: nrefs, points,
    rank: rank >= 0 ? rank + 1 : null,
    prevDials, prevAppts, prevPoints,
    totalAgents,
  };
}

// ─── AVAILABLE OPEN HOUSES ──────────────────────────────────────────────
// Pull all approved & unclaimed OHs for this coming weekend + any beyond.
// Newsletter fires Wednesday morning; agents get 3-4 days to grab a slot.
export function availableOpenHouses(): Array<{
  id: number;
  address: string;
  date: string;
  time_start: string;
  time_end: string;
  list_price: number | null;
  listing_agent: string | null;
  notes: string | null;
}> {
  const rows = rawDb.prepare(`
    SELECT oh.id, oh.address, oh.date, oh.time_start, oh.time_end,
           oh.list_price, oh.listing_agent, oh.notes
    FROM open_houses oh
    WHERE oh.status = 'open'
      AND oh.claimed_by_agent_id IS NULL
      AND oh.date >= date('now')
    ORDER BY oh.date ASC, oh.time_start ASC
    LIMIT 20
  `).all() as any[];
  return rows;
}

export function topThisWeek(): Array<{ agentId: number; name: string; points: number; signature: string }> {
  const rows = rawDb.prepare(`
    SELECT ap.agent_id as agentId, a.name, coalesce(SUM(ap.points),0) as points
    FROM agent_points ap
    JOIN agents a ON a.id = ap.agent_id
    WHERE ap.created_at >= datetime('now','-7 days') AND a.is_active = 1
    GROUP BY ap.agent_id, a.name
    ORDER BY points DESC
    LIMIT 3
  `).all() as any[];

  return rows.map(r => {
    // Signature stat: dials, appts, or refs — whichever is highest
    const dials = (rawDb.prepare(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason IN ('dial','call_attempt','wrong_number')`).get({ id: r.agentId }) as any)?.n || 0;
    const appts = (rawDb.prepare(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'appointment_set'`).get({ id: r.agentId }) as any)?.n || 0;
    const refs  = (rawDb.prepare(`SELECT COUNT(*) as n FROM lead_activity WHERE agent_id = @id AND created_at >= datetime('now','-7 days') AND reason = 'network_referral'`).get({ id: r.agentId }) as any)?.n || 0;
    let signature = `${dials} dials`;
    if (appts >= 3) signature = `${appts} appointments set`;
    else if (refs >= 2) signature = `${refs} network referrals`;
    return { agentId: r.agentId, name: r.name, points: r.points, signature };
  });
}

// ─── PERSONALIZED RECOMMENDATIONS ───────────────────────────────────────
export function personalRecommendation(s: AgentWeekStats): string {
  const d = s.dials, a = s.appts, k = s.kit;
  const dialsUp   = s.prevDials  > 0 && d < s.prevDials * 0.8;
  const dialsDown = s.prevDials  > 0 && d < s.prevDials * 0.6;
  const pointsUp  = s.points > s.prevPoints * 1.15;

  if (d === 0 && a === 0 && k === 0) {
    return "You've been quiet this week. No shame — just a signal. Block 90 minutes tomorrow morning for pool dials. Momentum starts with the first ring.";
  }
  if (d > 200 && a < 2) {
    return "You're grinding dials but conversion is light. Try slowing down on the ones that pick up — ask ONE extra LPMAMA question before pitching an appointment. Quality over volume this week.";
  }
  if (a > 0 && k === 0) {
    return "You set appointments but no KITs. Every 'not right now' is a KIT waiting to happen. Log at least 3 KITs this week — future you will thank you.";
  }
  if (d > 100 && a >= 3) {
    return "Solid week. Dials are dialed in and appointments are landing. Now the leverage move: pick one appointment from last week and ask for a referral. That's how top producers compound.";
  }
  if (dialsDown) {
    return "Dials dropped 40%+ vs last week. Life happens — but the pool doesn't care. Get one focused 60-minute block on the calendar Monday and hit it.";
  }
  if (dialsUp) {
    return "You showed up. Keep the volume where it is and refine the conversation. Listen to yourself on the next 3 calls — you'll hear one script tweak that moves your appt rate.";
  }
  if (pointsUp) {
    return "You're up big on points vs last week. Whatever you changed — keep it. Write down what worked before you forget.";
  }
  return "Steady week. Steady is underrated. Show up Monday with one intention: one new appointment, one new KIT, one new referral ask. That's a killer week.";
}

// ─── LD NEWSLETTER HTML ─────────────────────────────────────────────────
export function ldNewsletterHtml(s: AgentWeekStats, inputs: AlexInputs, topWeek: ReturnType<typeof topThisWeek>): string {
  const tool = featuredTool();
  const changes = recentAppChanges();
  const rec = personalRecommendation(s);
  const openHouses = availableOpenHouses();

  const fmtOHDate = (d: string): string => {
    try {
      const [y, m, day] = d.split("-").map(Number);
      const dt = new Date(y, m - 1, day);
      return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    } catch { return d; }
  };
  const fmtOHTime = (t: string): string => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const period = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m > 0 ? `${h12}:${String(m).padStart(2,"0")}${period}` : `${h12}${period}`;
  };
  const fmtPrice = (n: number | null): string => {
    if (!n) return "";
    if (n >= 1000000) return `$${(n/1000000).toFixed(2).replace(/\.00$/,"")}M`;
    if (n >= 1000)    return `$${Math.round(n/1000)}K`;
    return `$${n}`;
  };

  const trend = (cur: number, prev: number): string => {
    if (prev === 0) return cur > 0 ? " (new)" : "";
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return " (flat)";
    return ` (${pct > 0 ? "+" : ""}${pct}%)`;
  };

  const first = s.name.split(" ")[0] || s.name;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0f0f0;line-height:1.6">
<div style="max-width:680px;margin:0 auto;padding:40px 32px">

  <!-- Header -->
  <div style="text-align:center;margin-bottom:32px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.3em;text-transform:uppercase;margin-bottom:8px">Watson Brothers Group · Wednesday Brief</div>
    <div style="color:#f0f0f0;font-size:26px;font-weight:600;letter-spacing:-.02em">Good morning, ${first}</div>
    <div style="color:#7a7a7a;font-size:13px;margin-top:6px">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
  </div>

  ${inputs.quote ? `
  <!-- Quote of the week -->
  <div style="background:#141414;border-left:3px solid #c8aa5a;padding:24px;margin-bottom:32px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">Wisdom for the week</div>
    <div style="color:#e8e8e8;font-size:16px;line-height:1.7;font-style:italic">${inputs.quote}</div>
  </div>
  ` : ""}

  ${inputs.wins ? `
  <!-- Big wins -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border:1px solid rgba(200,170,90,.15);border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:12px">🎯 Big wins last week</div>
    <div style="color:#e8e8e8;font-size:14px">${inputs.wins.replace(/\n/g, "<br>")}</div>
  </div>
  ` : ""}

  <!-- Your week -->
  <div style="background:#141414;padding:24px;margin-bottom:32px;border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:16px">📊 Your week</div>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px">Dials</td>
        <td style="padding:8px 0;color:#f0f0f0;font-size:15px;text-align:right;font-weight:600">${s.dials}<span style="color:#7a7a7a;font-size:11px;font-weight:400">${trend(s.dials, s.prevDials)}</span></td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Appointments set</td>
        <td style="padding:8px 0;color:#4ade80;font-size:15px;text-align:right;font-weight:600;border-top:1px solid #2a2a2a">${s.appts}<span style="color:#7a7a7a;font-size:11px;font-weight:400">${trend(s.appts, s.prevAppts)}</span></td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Kept in touch</td>
        <td style="padding:8px 0;color:#93c5fd;font-size:15px;text-align:right;font-weight:600;border-top:1px solid #2a2a2a">${s.kit}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Recycled</td>
        <td style="padding:8px 0;color:#f0f0f0;font-size:15px;text-align:right;font-weight:600;border-top:1px solid #2a2a2a">${s.recycles}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Network referrals</td>
        <td style="padding:8px 0;color:#facc15;font-size:15px;text-align:right;font-weight:600;border-top:1px solid #2a2a2a">${s.networkRefs}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Points earned</td>
        <td style="padding:8px 0;color:#c8aa5a;font-size:15px;text-align:right;font-weight:700;border-top:1px solid #2a2a2a">${s.points}<span style="color:#7a7a7a;font-size:11px;font-weight:400">${trend(s.points, s.prevPoints)}</span></td>
      </tr>
      ${s.rank ? `
      <tr>
        <td style="padding:8px 0;color:#a0a0a0;font-size:13px;border-top:1px solid #2a2a2a">Team rank</td>
        <td style="padding:8px 0;color:${s.rank <= 3 ? '#c8aa5a' : '#f0f0f0'};font-size:15px;text-align:right;font-weight:700;border-top:1px solid #2a2a2a">#${s.rank} of ${s.totalAgents}</td>
      </tr>
      ` : ""}
    </table>
  </div>

  <!-- Personalized recommendation -->
  <div style="background:#141414;border-left:3px solid #4ade80;padding:20px 24px;margin-bottom:32px">
    <div style="color:#4ade80;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">Recommendation for you</div>
    <div style="color:#e8e8e8;font-size:14px">${rec}</div>
  </div>

  ${topWeek.length ? `
  <!-- Team leaderboard -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:14px">🏆 Team leaderboard</div>
    ${topWeek.map((r, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i > 0 ? 'border-top:1px solid #2a2a2a' : ''}">
      <div>
        <span style="color:${i === 0 ? '#c8aa5a' : i === 1 ? '#d4d4d4' : '#a67c52'};font-weight:700;font-size:15px">#${i+1}</span>
        <span style="color:#f0f0f0;font-weight:600;margin-left:10px">${r.name}</span>
        <span style="color:#7a7a7a;font-size:12px;margin-left:6px">— ${r.signature}</span>
      </div>
      <div style="color:#c8aa5a;font-weight:700">${r.points} pts</div>
    </div>
    `).join("")}
  </div>
  ` : ""}

  ${inputs.coaching ? `
  <!-- Coaching focus -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border:1px solid rgba(147,197,253,.15);border-radius:6px">
    <div style="color:#93c5fd;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:12px">🎓 Coaching focus this week</div>
    <div style="color:#e8e8e8;font-size:14px">${inputs.coaching.replace(/\n/g, "<br>")}</div>
  </div>
  ` : ""}

  ${inputs.conversation ? `
  <!-- Conversation starters -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border:1px solid rgba(250,204,21,.15);border-radius:6px">
    <div style="color:#facc15;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:12px">💬 Drop these into your calls</div>
    <div style="color:#e8e8e8;font-size:14px">${inputs.conversation.replace(/\n/g, "<br>")}</div>
  </div>
  ` : ""}

  ${openHouses.length ? `
  <!-- Available open houses (grab-a-slot) -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border:1px solid rgba(200,170,90,.25);border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:6px">🏡 Open houses up for grabs</div>
    <div style="color:#7a7a7a;font-size:12px;margin-bottom:14px">Approved. Unclaimed. First-come, first-served — grab in the app.</div>
    ${openHouses.map((oh, i) => `
      <div style="padding:12px 0;${i > 0 ? 'border-top:1px solid #2a2a2a' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <div style="color:#f0f0f0;font-size:14px;font-weight:600">${oh.address}</div>
          ${oh.list_price ? `<div style="color:#c8aa5a;font-size:13px;font-weight:600">${fmtPrice(oh.list_price)}</div>` : ""}
        </div>
        <div style="color:#a0a0a0;font-size:13px">
          ${fmtOHDate(oh.date)} · ${fmtOHTime(oh.time_start)}–${fmtOHTime(oh.time_end)}
          ${oh.listing_agent ? ` · <span style="color:#7a7a7a">listing: ${oh.listing_agent}</span>` : ""}
        </div>
        ${oh.notes ? `<div style="color:#7a7a7a;font-size:12px;margin-top:4px;font-style:italic">${oh.notes}</div>` : ""}
      </div>
    `).join("")}
    <div style="margin-top:14px;text-align:center">
      <a href="https://depot.watsonbrothersgroup.com" style="display:inline-block;padding:8px 18px;background:#c8aa5a;color:#0a0a0a;text-decoration:none;border-radius:4px;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Grab a slot in Lead Depot</a>
    </div>
  </div>
  ` : ""}

  <!-- Featured tool -->
  <div style="background:linear-gradient(135deg,#1a1408 0%,#0f0a04 100%);padding:24px;margin-bottom:32px;border:1px solid rgba(200,170,90,.25);border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:12px">🛠 Feature of the week</div>
    <div style="color:#c8aa5a;font-size:18px;font-weight:700;margin-bottom:8px">${tool.title}</div>
    <div style="color:#e8e8e8;font-size:14px;margin-bottom:10px">${tool.body}</div>
    <div style="color:#7a7a7a;font-size:12px">Where: ${tool.where}</div>
  </div>

  ${changes.length ? `
  <!-- What's new -->
  <div style="background:#141414;padding:20px 24px;margin-bottom:32px;border-radius:6px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:12px">🚀 What's new in the app</div>
    ${changes.map(c => `
      <div style="margin-bottom:8px;padding-left:12px;border-left:2px solid rgba(200,170,90,.3)">
        <span style="color:#c8aa5a;font-weight:700;font-size:13px">${c.version}</span>
        <span style="color:#e8e8e8;font-size:13px;margin-left:8px">${c.blurb}</span>
      </div>
    `).join("")}
  </div>
  ` : ""}

  <!-- Footer -->
  <div style="border-top:1px solid #2a2a2a;padding-top:24px;text-align:center">
    <div style="color:#a0a0a0;font-size:13px;margin-bottom:12px">
      <a href="https://depot.watsonbrothersgroup.com" style="color:#c8aa5a;text-decoration:none;font-weight:600">Open Lead Depot</a>
    </div>
    <div style="color:#5a5a5a;font-size:11px">
      Reply to this email if anything's broken, unclear, or exciting. — Alex
    </div>
  </div>

</div>
</body></html>`;
}

// ─── PREP-EMAIL HTML (Monday 6am ask) ───────────────────────────────────
export function prepEmailHtml(): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0f0f0;line-height:1.6">
<div style="max-width:640px;margin:0 auto;padding:40px 32px">

  <div style="text-align:center;margin-bottom:32px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.3em;text-transform:uppercase;margin-bottom:8px">Newsletter Heads-Up · Monday Morning</div>
    <div style="color:#f0f0f0;font-size:24px;font-weight:600;letter-spacing:-.02em">Newsletter buckets for this week</div>
    <div style="color:#7a7a7a;font-size:13px;margin-top:6px">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
  </div>

  <div style="background:#141414;padding:20px 24px;margin-bottom:28px;border-radius:6px">
    <div style="color:#e8e8e8;font-size:14px;margin-bottom:16px">
      Heads-up email — no reply needed. BGRE client draft goes to Nate Tuesday 8am ET. The LD team newsletter fires Wednesday 8am ET. If you want to shape the content for this week, log into Lead Depot and drop your inputs into the Newsletter Inputs panel any time before Wednesday 8am. Everything below shows what each bucket is for.
    </div>
  </div>

  <div style="background:#141414;border-left:3px solid #c8aa5a;padding:20px 24px;margin-bottom:20px">
    <div style="color:#c8aa5a;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">1 · Wisdom for the week</div>
    <div style="color:#e8e8e8;font-size:14px">Quote, scripture, or reflection to open the LD newsletter. One is enough.</div>
  </div>

  <div style="background:#141414;border-left:3px solid #4ade80;padding:20px 24px;margin-bottom:20px">
    <div style="color:#4ade80;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">2 · Big wins & shoutouts</div>
    <div style="color:#e8e8e8;font-size:14px">Named agents + what they did last week. Closings, breakthroughs, hustle moments. Reinforces team identity.</div>
  </div>

  <div style="background:#141414;border-left:3px solid #93c5fd;padding:20px 24px;margin-bottom:20px">
    <div style="color:#93c5fd;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">3 · This week's coaching focus</div>
    <div style="color:#e8e8e8;font-size:14px">One skill, mindset, role-play prompt, or accountability challenge for the whole team this week.</div>
  </div>

  <div style="background:#141414;border-left:3px solid #facc15;padding:20px 24px;margin-bottom:20px">
    <div style="color:#facc15;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">4 · Conversation starters</div>
    <div style="color:#e8e8e8;font-size:14px">One-liners agents can drop into calls this week. e.g. "the window is always open," rate/home-price relationship. Give me 2-3.</div>
  </div>

  <div style="background:#141414;border-left:3px solid #a78bfa;padding:20px 24px;margin-bottom:28px">
    <div style="color:#a78bfa;font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;margin-bottom:10px">5 · BGRE client newsletter — this week's angle</div>
    <div style="color:#e8e8e8;font-size:14px">One paragraph: What's the market concern? What's the data angle? What's the pivot to hope? What's the practical solution? I'll write the newsletter and hand it to Nate Tuesday 8am.</div>
    <div style="color:#7a7a7a;font-size:12px;margin-top:8px">This one still fires Tuesday morning — LD team newsletter is Wednesday 8am.</div>
  </div>

  <div style="background:rgba(200,170,90,.05);padding:16px 20px;border-radius:6px;border:1px solid rgba(200,170,90,.15);text-align:center">
    <div style="color:#7a7a7a;font-size:12px">If you don't submit anything by Wednesday 8am, the LD newsletter still ships with agent stats, leaderboard, available open houses, feature of the week, and app changelog. Manual buckets just get skipped.</div>
  </div>

</div>
</body></html>`;
}
