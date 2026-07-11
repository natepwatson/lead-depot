// server/recommendation.ts
// v15.6 — Phase 2 recommendation algorithm.
// Given a submitted questionnaire (28 questions per ONBOARDING_SPEC.md),
// produce a 0..100 score, a category, and a one-line reason.
//
// The spec is the source of truth — do not change weightings without Alex's
// approval. Every rule below maps 1:1 to a line in ONBOARDING_SPEC.md
// "Recommendation Algorithm (v1)".

export type RecCategory = "STRONG_FIT" | "WORTH_A_CALL" | "SOFT_PASS" | "HARD_PASS";

export interface RecommendationResult {
  score: number;                // 0..100 (clamped)
  category: RecCategory;
  reason: string;               // one-line "why", <= 120 chars
  breakdown: Record<string, number>;
}

// The questionnaire JSON is loosely typed on submission — we defensively read.
type Q = Record<string, any>;

function num(v: any, d = 0): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function str(v: any): string {
  return typeof v === "string" ? v : "";
}
function has(v: any): boolean {
  return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
}

const TX_MAP: Record<string, number> = {
  "0": 2, "1-2": 6, "3-5": 12, "6-10": 16, "11-20": 20, "20+": 25,
};

const PROACTIVE_KEYWORDS = [
  "learn", "grow", "try again", "next call", "improve", "feedback",
  "opportunity", "reset", "resilient", "bounce",
];

export function computeRecommendation(q: Q): RecommendationResult {
  const b: Record<string, number> = {};

  // --- Section 1: license status
  const license = str(q.license_status).toLowerCase();
  let licenseScore = 0;
  if (license === "active_fl") licenseScore = 20;
  else if (license === "inactive_fl" || license === "in_course") licenseScore = 12;
  else if (license === "active_other") licenseScore = 8;
  else if (license === "unlicensed_interested" || license === "unlicensed") licenseScore = 4;
  b.license = licenseScore;

  // --- Section 3: sliders 1..10 → *2 each → max 20 each
  b.cold_call = Math.max(0, Math.min(10, Math.round(num(q.cold_call_comfort)))) * 2;
  b.learning  = Math.max(0, Math.min(10, Math.round(num(q.learning_comfort))))  * 2;

  // --- Section 3: 7-day willingness
  const willingness = str(q.seven_day_willingness).toLowerCase();
  b.willingness =
    willingness === "yes" ? 15 :
    willingness === "depends" ? 6 :
    0;

  // --- Section 2: production signal (last 12 mo closed)
  const tx = str(q.closed_transactions_12mo);
  b.production = TX_MAP[tx] ?? 0;

  // --- Textual signal bumps
  const rejection = str(q.rejection_handling).toLowerCase();
  b.rejection_bump = PROACTIVE_KEYWORDS.some(k => rejection.includes(k)) ? 5 : 0;

  const why = str(q.why_real_estate);
  const whyLower = why.toLowerCase();
  const whyMentions = /people|help|impact|family|community|relationship|serve|clients/.test(whyLower);
  b.why_bump = (why.length > 40 && whyMentions) ? 3 : 0;

  const income = str(q.income_meaning);
  const incomeConcrete = /\$|\d{2,}|goal|debt|save|invest|house|car|kids|college/i.test(income);
  b.income_bump = (income.length > 30 && incomeConcrete) ? 3 : 0;

  // --- Sum + clamp
  let score = Object.values(b).reduce((a, n) => a + n, 0);
  score = Math.max(0, Math.min(100, score));

  // --- Categorize (spec)
  let category: RecCategory;
  if (score >= 75) category = "STRONG_FIT";
  else if (score >= 55) category = "WORTH_A_CALL";
  else if (score >= 35) category = "SOFT_PASS";
  else category = "HARD_PASS";

  // --- Auto-flags (spec section)
  const teamEthic = q.agreement_team_ethic === true || q.agreement_team_ethic === "true" || q.agreement_team_ethic === 1;
  if (!teamEthic) {
    // If they didn't confirm team ethic, hard pass. Spec: "if agreement_team_ethic is unchecked: category = HARD_PASS"
    category = "HARD_PASS";
  }
  if (
    Math.round(num(q.cold_call_comfort)) <= 3 &&
    willingness === "no_boundaries"
  ) {
    // "if cold_call_comfort <= 3 and seven_day_willingness == 'no_boundaries': category = SOFT_PASS"
    // (only downgrade — don't upgrade a HARD_PASS)
    if (category !== "HARD_PASS") category = "SOFT_PASS";
  }

  // --- One-line reason
  const reason = buildReason({ category, score, license, willingness, tx, coldCall: b.cold_call/2, teamEthic });

  return { score, category, reason, breakdown: b };
}

function buildReason(x: {
  category: RecCategory;
  score: number;
  license: string;
  willingness: string;
  tx: string;
  coldCall: number;
  teamEthic: boolean;
}): string {
  const bits: string[] = [];
  if (!x.teamEthic) return "Did not confirm team-ethic agreement.";
  if (x.license === "active_fl") bits.push("active FL licensee");
  else if (x.license === "inactive_fl") bits.push("inactive FL license");
  else if (x.license === "in_course") bits.push("license course in-progress");
  else if (x.license === "active_other") bits.push("licensed out-of-state");
  else if (x.license === "unlicensed_interested" || x.license === "unlicensed") bits.push("unlicensed");
  if (has(x.tx) && x.tx !== "0") bits.push(`${x.tx} closed in last 12mo`);
  if (x.coldCall >= 8) bits.push("strong cold-call comfort");
  else if (x.coldCall <= 3) bits.push("cold-call reluctant");
  if (x.willingness === "yes") bits.push("says yes to 7-day availability");
  else if (x.willingness === "no_boundaries") bits.push("firm work-week boundaries");
  const head = x.category === "STRONG_FIT"     ? "Strong fit"
             : x.category === "WORTH_A_CALL"   ? "Worth a call"
             : x.category === "SOFT_PASS"      ? "Soft pass"
             :                                   "Hard pass";
  const body = bits.length ? bits.slice(0, 3).join(", ") : "limited signal";
  return `${head} (${x.score}/100) — ${body}.`;
}

// Small helper for admin review email body / FUB note body.
export function formatQuestionnaireForHumans(q: Q): string {
  const line = (label: string, val: any) => {
    if (val === true) return `${label}: yes`;
    if (val === false) return `${label}: no`;
    if (Array.isArray(val)) return `${label}: ${val.join(", ") || "—"}`;
    return `${label}: ${has(val) ? String(val) : "—"}`;
  };
  const lines: string[] = [];
  lines.push("== Section 1 — Basics ==");
  lines.push(line("Full name", q.full_name));
  lines.push(line("Phone", q.phone));
  lines.push(line("Email", q.email));
  lines.push(line("City / County", q.city_county));
  lines.push(line("License status", q.license_status));
  lines.push(line("License #", q.license_number));
  lines.push("");
  lines.push("== Section 2 — Background ==");
  lines.push(line("Current brokerage", q.current_brokerage));
  lines.push(line("Brokerage tenure", q.brokerage_tenure));
  lines.push(line("Why leaving", q.why_leaving));
  lines.push(line("Closed 12mo", q.closed_transactions_12mo));
  lines.push(line("GCI range", q.gci_range));
  lines.push(line("Years in RE", q.years_in_re));
  lines.push("");
  lines.push("== Section 3 — Drive ==");
  lines.push(line("Why real estate", q.why_real_estate));
  lines.push(line("Income meaning", q.income_meaning));
  lines.push(line("Cold-call comfort (1-10)", q.cold_call_comfort));
  lines.push(line("Learning comfort (1-10)", q.learning_comfort));
  lines.push(line("7-day willingness", q.seven_day_willingness));
  lines.push(line("Rejection handling", q.rejection_handling));
  lines.push("");
  lines.push("== Section 4 — Network & Style ==");
  lines.push(line("Local network size", q.local_network_size));
  lines.push(line("Prior sales background", q.prior_sales_background));
  lines.push(line("Self description", q.self_description));
  lines.push(line("Recent learning", q.recent_learning));
  lines.push("");
  lines.push("== Section 5 — Fit ==");
  lines.push(line("Team vs solo", q.team_vs_solo));
  lines.push(line("Hopes", q.hopes));
  lines.push(line("Start when", q.start_when));
  lines.push(line("Anything else", q.anything_else));
  lines.push(line("Referred by", q.referred_by));
  lines.push("");
  lines.push("== Section 6 — Agreements ==");
  lines.push(line("Team ethic agreement", q.agreement_team_ethic));
  lines.push(line("License verification agreement", q.agreement_verify));
  lines.push(line("Marketing/text consent", q.agreement_marketing));
  return lines.join("\n");
}
