// v18.3 — Challenges library.
//
// 37 daily + 25 weekly challenges, hardcoded per Alex's spec:
//   turn_0707 (daily final list)
//   turn_0708 (Direct Mail — all gated)
//   turn_0709 (weekly outcomes — all gated, admin discretion on evidence)
//   turn_0710 (points timing — non-gated instant, gated on approval)
//
// Design principles:
//   - Read-only library in code. No admin editing. Tweak = deploy.
//   - Cycle forever. Same 37 daily every day, same 25 weekly every week.
//   - Non-gated: instant point payout on completion detection.
//   - Gated: agent claims → approval_requests row → admin approves → points post.
//   - Difficulty tier (1/2/3) drives card color. Higher tier = bigger reward.
//   - `kind` distinguishes leg for filtering + admin approval routing.

import { rawDb } from "./db";

export type ChallengeCadence = "daily" | "weekly";
export type ChallengeLeg = "dial" | "open_house" | "knock" | "direct_mail" | "network" | "meta";
export type ChallengeTier = 1 | 2 | 3;

export interface ChallengeDef {
  key: string;                       // stable id (e.g. "daily.dial.25")
  cadence: ChallengeCadence;
  leg: ChallengeLeg;
  tier: ChallengeTier;
  points: number;
  label: string;
  detail: string;                    // short description shown on card
  gated: boolean;                    // true = admin approval before points post
  autoDetect?: string;               // event name that auto-marks complete (non-gated only)
                                     // e.g. "dial:25" means server checks lead_activity count
  evidencePrompt?: string;           // shown to agent when submitting evidence
}

// ─── DAILY (37) ────────────────────────────────────────────────────────────

const DAILY: ChallengeDef[] = [
  // Dial (7) — all non-gated, auto-detected from lead_activity
  { key: "daily.dial.25",       cadence: "daily", leg: "dial", tier: 1, points: 15,  label: "Dial 25",                 detail: "25 outbound dials today.",                 gated: false, autoDetect: "dial_count:25" },
  { key: "daily.dial.50",       cadence: "daily", leg: "dial", tier: 2, points: 25,  label: "Dial 50",                 detail: "50 outbound dials today.",                 gated: false, autoDetect: "dial_count:50" },
  { key: "daily.dial.100",      cadence: "daily", leg: "dial", tier: 3, points: 50,  label: "Dial 100",                detail: "100 outbound dials today.",                gated: false, autoDetect: "dial_count:100" },
  { key: "daily.dial.kit5",     cadence: "daily", leg: "dial", tier: 2, points: 25,  label: "5 KITs",                  detail: "Log 5 Keep-in-Touch outcomes today.",      gated: false, autoDetect: "kit_count:5" },
  { key: "daily.dial.appt1",    cadence: "daily", leg: "dial", tier: 3, points: 40,  label: "1 Appt Set",              detail: "Set at least one appointment today.",      gated: false, autoDetect: "appt_count:1" },
  { key: "daily.dial.convertNA",cadence: "daily", leg: "dial", tier: 2, points: 20,  label: "Convert 3 No-Answers",    detail: "Turn 3 previous no-answers into contact.", gated: false, autoDetect: "na_converted:3" },
  { key: "daily.dial.prime2hr", cadence: "daily", leg: "dial", tier: 2, points: 25,  label: "Prime Time 2hr",          detail: "Dial for 2hrs during Prime Time today.",   gated: false, autoDetect: "prime_hours:2" },

  // Open House (7) — some gated (photo evidence)
  { key: "daily.oh.log1",       cadence: "daily", leg: "open_house", tier: 1, points: 20, label: "Log 1 OH",                     detail: "Log one Open House event.",            gated: false, autoDetect: "oh_log:1" },
  { key: "daily.oh.piggyback",  cadence: "daily", leg: "open_house", tier: 3, points: 50, label: "OH + Piggyback Knock",         detail: "Log OH with piggyback knock route.",   gated: true,  evidencePrompt: "Photo of route start location + OH selfie." },
  { key: "daily.oh.leadFromOH", cadence: "daily", leg: "open_house", tier: 3, points: 40, label: "Bring Lead From OH",           detail: "Capture 1+ warm lead from your OH.",   gated: false, autoDetect: "warm_lead:open_house" },
  { key: "daily.oh.coverAgent", cadence: "daily", leg: "open_house", tier: 2, points: 30, label: "Cover Agent-Needed OH",        detail: "Cover an OH for another agent.",       gated: true,  evidencePrompt: "Confirm which agent's OH you covered." },
  { key: "daily.oh.selfieStart",cadence: "daily", leg: "open_house", tier: 1, points: 10, label: "OH Selfie Before Start",       detail: "Selfie at OH before doors open.",      gated: true,  evidencePrompt: "Selfie at the OH location." },
  { key: "daily.oh.two",        cadence: "daily", leg: "open_house", tier: 3, points: 45, label: "2 OHs This Weekend",           detail: "Log 2+ OHs Sat/Sun.",                  gated: false, autoDetect: "weekend_oh:2" },
  { key: "daily.oh.support",    cadence: "daily", leg: "open_house", tier: 2, points: 25, label: "Attend Teammate's OH (support)", detail: "Show up as support at a teammate's OH.", gated: true, evidencePrompt: "Selfie at teammate's OH location." },

  // Knock (8) — most non-gated (rep-card app is evidence), piggyback gated
  { key: "daily.knock.route1",  cadence: "daily", leg: "knock", tier: 1, points: 15, label: "Complete 1 Knock Route",       detail: "Finish one door-knock route.",          gated: false, autoDetect: "knock_route:1" },
  { key: "daily.knock.d25",     cadence: "daily", leg: "knock", tier: 1, points: 20, label: "Knock 25 Doors",               detail: "25 doors knocked today.",              gated: false, autoDetect: "doors:25" },
  { key: "daily.knock.d50",     cadence: "daily", leg: "knock", tier: 2, points: 35, label: "Knock 50 Doors",               detail: "50 doors knocked today.",              gated: false, autoDetect: "doors:50" },
  { key: "daily.knock.leadFrom",cadence: "daily", leg: "knock", tier: 3, points: 40, label: "Bring Lead From Route",        detail: "Capture warm lead from knock route.",  gated: false, autoDetect: "warm_lead:door_knock" },
  { key: "daily.knock.piggyback",cadence:"daily", leg: "knock", tier: 3, points: 50, label: "Piggyback Knock at Teammate's OH", detail: "Route off a teammate's OH — both get 50pts.", gated: true, evidencePrompt: "Selfie at OH before starting route." },
  { key: "daily.knock.prime",   cadence: "daily", leg: "knock", tier: 2, points: 25, label: "Route in Prime Time",          detail: "Complete route during Prime Time window.", gated: false, autoDetect: "knock_route_prime:1" },
  { key: "daily.knock.convo3",  cadence: "daily", leg: "knock", tier: 2, points: 25, label: "3-Door Conversation Ratio",    detail: "1 real convo per 3 doors on route.",   gated: false, autoDetect: "knock_convo_ratio:0.33" },
  { key: "daily.knock.sunday",  cadence: "daily", leg: "knock", tier: 2, points: 30, label: "Sunday Route",                 detail: "Route on a Sunday.",                   gated: false, autoDetect: "knock_route_sunday:1" },

  // Direct Mail (7) — ALL GATED per turn_0708
  { key: "daily.mail.campaign1",cadence: "daily", leg: "direct_mail", tier: 1, points: 15, label: "Send 1 Campaign",       detail: "Send at least one mail campaign.",     gated: true, evidencePrompt: "Photo of materials or receipt." },
  { key: "daily.mail.p50",      cadence: "daily", leg: "direct_mail", tier: 2, points: 25, label: "Send 50 Pieces",        detail: "50 mail pieces sent today.",           gated: true, evidencePrompt: "Photo of stack / receipt / address list." },
  { key: "daily.mail.p100",     cadence: "daily", leg: "direct_mail", tier: 3, points: 50, label: "Send 100 Pieces",       detail: "100 mail pieces sent today.",          gated: true, evidencePrompt: "Photo of stack / receipt / address list." },
  { key: "daily.mail.leadFrom", cadence: "daily", leg: "direct_mail", tier: 3, points: 40, label: "Bring Lead From Mail",  detail: "Capture warm lead from mail response.",gated: true, evidencePrompt: "Screenshot of response / call log." },
  { key: "daily.mail.freshFarm",cadence: "daily", leg: "direct_mail", tier: 2, points: 25, label: "Fresh Farming Area",    detail: "Mail into a brand-new farming area.",  gated: true, evidencePrompt: "Address list showing new zip / neighborhood." },
  { key: "daily.mail.checkpts", cadence: "daily", leg: "direct_mail", tier: 2, points: 30, label: "All 3 Checkpoints",     detail: "Hit all 3 checkpoints in day.",        gated: true, evidencePrompt: "Photos at each checkpoint." },
  { key: "daily.mail.3hoods",   cadence: "daily", leg: "direct_mail", tier: 2, points: 30, label: "3 Neighborhoods",       detail: "Mail into 3 neighborhoods same day.",  gated: true, evidencePrompt: "Address lists for each neighborhood." },

  // Network Referral (8) — most non-gated, out-of-Jax gated
  { key: "daily.net.r1",        cadence: "daily", leg: "network", tier: 1, points: 20, label: "Log 1 Referral",              detail: "Submit 1 network referral.",          gated: false, autoDetect: "referral_count:1" },
  { key: "daily.net.r2",        cadence: "daily", leg: "network", tier: 2, points: 35, label: "Log 2 Referrals",             detail: "Submit 2 network referrals.",         gated: false, autoDetect: "referral_count:2" },
  { key: "daily.net.convert",   cadence: "daily", leg: "network", tier: 3, points: 60, label: "Convert Referral to Appt",    detail: "Turn a referral into an appointment.",gated: false, autoDetect: "referral_to_appt:1" },
  { key: "daily.net.pastClient",cadence: "daily", leg: "network", tier: 2, points: 30, label: "Referral From Past Client",   detail: "Referral came from a closed client.", gated: false, autoDetect: "referral_past_client:1" },
  { key: "daily.net.nonClient", cadence: "daily", leg: "network", tier: 2, points: 25, label: "Referral From Non-Client",    detail: "Referral from friend/family/network.",gated: false, autoDetect: "referral_non_client:1" },
  { key: "daily.net.warmXfer",  cadence: "daily", leg: "network", tier: 2, points: 25, label: "Warm Transfer to BGRE Agent", detail: "Live-transfer prospect to teammate.", gated: false, autoDetect: "warm_transfer:1" },
  { key: "daily.net.crossSame", cadence: "daily", leg: "network", tier: 2, points: 25, label: "Cross-Referral Same Day",     detail: "Give AND receive referral same day.", gated: false, autoDetect: "cross_referral:1" },
  { key: "daily.net.outOfJax",  cadence: "daily", leg: "network", tier: 2, points: 30, label: "Referral Outside Jax",        detail: "Log a referral outside the Jax market.", gated: true, evidencePrompt: "Referral agreement or signed doc." },
];

// ─── WEEKLY (25) ───────────────────────────────────────────────────────────

const WEEKLY: ChallengeDef[] = [
  // Volume (5)
  { key: "weekly.vol.dial500",  cadence: "weekly", leg: "dial",         tier: 3, points: 200, label: "Dial 500",           detail: "500+ dials this week.",             gated: false, autoDetect: "week_dials:500" },
  { key: "weekly.vol.knock250", cadence: "weekly", leg: "knock",        tier: 3, points: 200, label: "Knock 250 Doors",    detail: "250+ doors this week.",             gated: false, autoDetect: "week_doors:250" },
  { key: "weekly.vol.oh4",      cadence: "weekly", leg: "open_house",   tier: 3, points: 180, label: "Log 4 OHs",          detail: "4+ OHs this week.",                 gated: false, autoDetect: "week_oh:4" },
  { key: "weekly.vol.mail500",  cadence: "weekly", leg: "direct_mail",  tier: 3, points: 200, label: "Send 500 Mail",      detail: "500+ mail pieces this week.",       gated: true,  evidencePrompt: "Weekly receipts / postage records." },
  { key: "weekly.vol.ref8",     cadence: "weekly", leg: "network",      tier: 3, points: 180, label: "Log 8 Referrals",    detail: "8+ referrals this week.",           gated: false, autoDetect: "week_refs:8" },

  // Cross-activity (5)
  { key: "weekly.cross.3legs",  cadence: "weekly", leg: "meta", tier: 2, points: 120, label: "Hit 3+ Legs This Week",         detail: "Log activity in 3+ lead-gen legs.",           gated: false, autoDetect: "week_legs:3" },
  { key: "weekly.cross.5legs",  cadence: "weekly", leg: "meta", tier: 3, points: 200, label: "Hit ALL 5 Legs This Week",      detail: "Activity in all 5 legs — Grand Slam.",        gated: false, autoDetect: "week_legs:5" },
  { key: "weekly.cross.oh2k2",  cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "2 OHs + 2 Knock Routes",        detail: "2 OHs AND 2 knock routes same week.",         gated: false, autoDetect: "week_oh:2+week_routes:2" },
  { key: "weekly.cross.d300oh2",cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "Dial 300 + Log 2 OHs",          detail: "300 dials AND 2 OHs same week.",              gated: false, autoDetect: "week_dials:300+week_oh:2" },
  { key: "weekly.cross.m200r3", cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "Mail 200 + Log 3 Referrals",    detail: "200 mail AND 3 referrals same week.",         gated: true,  evidencePrompt: "Mail evidence + referral submissions." },

  // Meta (5)
  { key: "weekly.meta.appt5",   cadence: "weekly", leg: "meta", tier: 3, points: 180, label: "Set 5 Appointments",            detail: "5+ appointments this week.",                  gated: false, autoDetect: "week_appts:5" },
  { key: "weekly.meta.kit10",   cadence: "weekly", leg: "meta", tier: 2, points: 120, label: "Convert 10 KITs",               detail: "10+ Keep-in-Touch conversions.",              gated: false, autoDetect: "week_kits:10" },
  { key: "weekly.meta.new5",    cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "Bring 5 New Leads",             detail: "5+ new warm/network leads this week.",        gated: false, autoDetect: "week_new_leads:5" },
  { key: "weekly.meta.kit20",   cadence: "weekly", leg: "meta", tier: 3, points: 180, label: "20 Leads to KIT Stage",         detail: "Move 20 leads into KIT stage.",               gated: false, autoDetect: "week_leads_to_kit:20" },
  { key: "weekly.meta.zeroRcyc",cadence: "weekly", leg: "meta", tier: 3, points: 180, label: "Zero Recycles This Week",       detail: "Ship every lead — no recycles.",              gated: false, autoDetect: "week_recycles:0" },

  // Streak (5)
  { key: "weekly.streak.every", cadence: "weekly", leg: "meta", tier: 2, points: 120, label: "Activity Every Day",            detail: "1+ activity every day of the week.",          gated: false, autoDetect: "week_days_active:7" },
  { key: "weekly.streak.prime5",cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "Prime Time 5 Days",             detail: "Log Prime Time activity 5 days.",             gated: false, autoDetect: "week_prime_days:5" },
  { key: "weekly.streak.all3d1",cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "All 3 Daily Challenges Once",   detail: "Hit 3 daily challenges in one day.",          gated: false, autoDetect: "day_challenges:3" },
  { key: "weekly.streak.all3d3",cadence: "weekly", leg: "meta", tier: 3, points: 200, label: "3 Daily Challenges × 3 Days",   detail: "Hit 3 daily challenges 3 days running.",      gated: false, autoDetect: "streak_challenges:3x3" },
  { key: "weekly.streak.fiveDay",cadence:"weekly", leg: "meta", tier: 2, points: 120, label: "Full 5-Day Work Week",          detail: "Log activity M-F.",                           gated: false, autoDetect: "week_days_M_F:5" },

  // Outcome (5) — ALL GATED per turn_0709 (admin discretion on evidence)
  { key: "weekly.out.close1",   cadence: "weekly", leg: "meta", tier: 3, points: 200, label: "1 Close This Week",             detail: "Close 1 transaction this week.",              gated: true, evidencePrompt: "Optional — closing doc if admin requests." },
  { key: "weekly.out.list1",    cadence: "weekly", leg: "meta", tier: 3, points: 180, label: "1 Listing Signed",              detail: "Sign 1 new listing agreement.",               gated: true, evidencePrompt: "Optional — signed listing agreement." },
  { key: "weekly.out.buy2",     cadence: "weekly", leg: "meta", tier: 3, points: 200, label: "2 Buyer Contracts",             detail: "2 buyer contracts under contract.",           gated: true, evidencePrompt: "Optional — buyer agreements." },
  { key: "weekly.out.pipe500k", cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "$500K+ Pipeline Added",         detail: "Add $500K+ in pipeline value.",               gated: true, evidencePrompt: "Optional — pipeline summary." },
  { key: "weekly.out.oh2appt",  cadence: "weekly", leg: "meta", tier: 2, points: 140, label: "Convert OH Lead to Appt",       detail: "Turn an OH lead into an appointment.",        gated: true, evidencePrompt: "Optional — FUB appt confirmation." },
];

export const ALL_CHALLENGES: ChallengeDef[] = [...DAILY, ...WEEKLY];
export const CHALLENGE_MAP: Record<string, ChallengeDef> = Object.fromEntries(ALL_CHALLENGES.map(c => [c.key, c]));

if (DAILY.length !== 37) throw new Error(`Expected 37 daily challenges, got ${DAILY.length}`);
if (WEEKLY.length !== 25) throw new Error(`Expected 25 weekly challenges, got ${WEEKLY.length}`);

// ─── DB SCHEMA ─────────────────────────────────────────────────────────────

export function ensureChallengeSchema() {
  // challenge_accepts: agent has "accepted" this challenge for this period.
  // period_key is YYYY-MM-DD for daily and ISO-week YYYY-WNN for weekly.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS challenge_accepts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      INTEGER NOT NULL,
      challenge_key TEXT NOT NULL,
      period_key    TEXT NOT NULL,
      accepted_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, challenge_key, period_key)
    )
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_ch_accepts_period ON challenge_accepts(period_key, challenge_key)`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_ch_accepts_agent ON challenge_accepts(agent_id, period_key)`);

  // challenge_completions: challenge was completed by an agent in a period.
  // For non-gated: written directly by detection sweep. status=complete, points_awarded>0.
  // For gated: written on agent claim with status=pending; admin transitions to approved/rejected.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS challenge_completions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       INTEGER NOT NULL,
      challenge_key  TEXT NOT NULL,
      period_key     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'complete',  -- 'pending' | 'approved' | 'rejected' | 'complete'
      points_awarded INTEGER NOT NULL DEFAULT 0,
      completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by    INTEGER,
      approved_at    TEXT,
      rejected_reason TEXT,
      approval_request_id INTEGER,     -- FK to approval_requests when gated
      UNIQUE(agent_id, challenge_key, period_key)
    )
  `);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_ch_completions_agent ON challenge_completions(agent_id, period_key)`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_ch_completions_status ON challenge_completions(status, completed_at DESC)`);

  console.log("[challenges] schema ready — 37 daily, 25 weekly");
}

// ─── PERIOD KEY HELPERS ────────────────────────────────────────────────────

export function currentDailyKey(now: Date = new Date()): string {
  // ET-aware daily key. Using UTC date-only is close enough for challenge cycle;
  // agents in Jax are all ET so ET midnight ≈ UTC midnight - 4/5h. Backend uses
  // getETDayBounds elsewhere; here we just need a stable YYYY-MM-DD partition.
  const et = new Date(now.getTime() - 5 * 60 * 60 * 1000);   // EST offset (winter)
  const y = et.getUTCFullYear();
  const m = String(et.getUTCMonth() + 1).padStart(2, "0");
  const d = String(et.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function currentWeeklyKey(now: Date = new Date()): string {
  // ISO week: YYYY-Www. Week starts Monday, week 1 contains Jan 4.
  const d = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}
