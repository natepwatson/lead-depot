// v14.22 — Unified lead scoring engine.
// List-agnostic: works from whatever intel the source (BatchLeads, LandVoice,
// manual CSV, network referral) actually populated on the lead row.
//
// Design rules:
//   1. Never penalize a missing field — only reward present ones.
//   2. Every list has different data. Baseline 40; max 100.
//   3. The score gets recomputed on import and can be recomputed later
//      via /admin/backfill-scores when the formula changes.
//   4. Explains itself: `computeUnifiedScore` also returns a list of
//      reasons so the UI (and the admin backfill script) can log what
//      contributed to the number.

export interface ScoringInput {
  // Contact reach — the biggest predictor of connect-rate
  phoneCount?: number | null;         // total phones we can try
  hasEmail?: boolean | null;

  // Pricing intel
  listPrice?: number | null;          // last MLS listing amount
  assessedValue?: number | null;      // tax-assessed value

  // Ownership & motivation
  yearPurchased?: number | null;      // year of last sale — equity proxy

  // Property specs (LandVoice / rich lists)
  lotSizeAcres?: number | null;

  // Source-native rating (if any)
  sourceRating?: "high" | "medium" | "low" | null;

  // LandVoice-specific (extraData at import time — supported here for when we
  // start ingesting these columns; noop if absent).
  daysOnMarket?: number | null;       // higher = more motivated
  withdrawDaysAgo?: number | null;    // fresh withdrawal = hot lead

  // Lead type context — expired/absentee weight differently for us.
  leadType?: "expired" | "absentee" | "distressed" | "website_lead" | "fsbo" | "land" | string | null;
}

export interface ScoringResult {
  score: number;              // 0-100
  reasons: string[];          // human-readable contributions
}

export function computeUnifiedScore(input: ScoringInput): ScoringResult {
  const reasons: string[] = [];
  let s = 40; // baseline — every lead we bothered ingesting starts here

  // ── Contact reach ────────────────────────────────────────────────
  const phones = input.phoneCount ?? 0;
  if (phones >= 5) { s += 20; reasons.push("5+ phones (+20)"); }
  else if (phones >= 3) { s += 15; reasons.push("3–4 phones (+15)"); }
  else if (phones >= 2) { s += 8;  reasons.push("2 phones (+8)"); }
  else if (phones === 1) { s += 2; reasons.push("1 phone (+2)"); }

  if (input.hasEmail) { s += 3; reasons.push("Email on file (+3)"); }

  // ── Pricing intel — presence itself is signal ────────────────────
  if (input.listPrice && input.listPrice > 0) {
    s += 8;
    reasons.push(`List price known ($${input.listPrice.toLocaleString()}) (+8)`);
    if (input.listPrice >= 500_000) { s += 4; reasons.push("$500K+ list (+4)"); }
  }
  if (input.assessedValue && input.assessedValue > 0) {
    s += 3;
    reasons.push("Assessed value known (+3)");
  }

  // ── Equity proxy: years owned ────────────────────────────────────
  if (input.yearPurchased && input.yearPurchased > 1900) {
    const yrs = new Date().getFullYear() - input.yearPurchased;
    if (yrs >= 10) { s += 10; reasons.push(`Owned ${yrs}yr (+10 equity)`); }
    else if (yrs >= 5) { s += 6; reasons.push(`Owned ${yrs}yr (+6 equity)`); }
    else if (yrs >= 2) { s += 2; reasons.push(`Owned ${yrs}yr (+2)`); }
  }

  // ── Lot / land specs ─────────────────────────────────────────────
  if (input.lotSizeAcres && input.lotSizeAcres > 0) {
    s += 2;
    reasons.push("Lot size known (+2)");
    if (input.lotSizeAcres >= 1) { s += 3; reasons.push("1+ acre (+3)"); }
  }

  // ── LandVoice motivation signals (future-proof) ──────────────────
  if (input.daysOnMarket && input.daysOnMarket > 0) {
    if (input.daysOnMarket >= 90) { s += 12; reasons.push(`${input.daysOnMarket}d on market (+12)`); }
    else if (input.daysOnMarket >= 60) { s += 8; reasons.push(`${input.daysOnMarket}d on market (+8)`); }
    else if (input.daysOnMarket >= 30) { s += 4; reasons.push(`${input.daysOnMarket}d on market (+4)`); }
  }
  if (input.withdrawDaysAgo !== null && input.withdrawDaysAgo !== undefined && input.withdrawDaysAgo >= 0) {
    if (input.withdrawDaysAgo <= 14) { s += 15; reasons.push(`Withdrew ${input.withdrawDaysAgo}d ago — hot (+15)`); }
    else if (input.withdrawDaysAgo <= 45) { s += 8; reasons.push(`Withdrew ${input.withdrawDaysAgo}d ago (+8)`); }
    else if (input.withdrawDaysAgo <= 90) { s += 3; reasons.push(`Withdrew ${input.withdrawDaysAgo}d ago (+3)`); }
  }

  // ── Source-native rating: blend, don't override ──────────────────
  if (input.sourceRating === "high") { s += 8; reasons.push("Source: HIGH (+8)"); }
  else if (input.sourceRating === "medium") { s += 3; reasons.push("Source: MED (+3)"); }
  else if (input.sourceRating === "low") { s -= 2; reasons.push("Source: LOW (−2)"); }

  // ── Lead-type multipliers (Brothers Group priority order) ────────
  if (input.leadType === "expired") { s += 3; reasons.push("Expired priority (+3)"); }
  else if (input.leadType === "absentee") { s += 1; reasons.push("Absentee (+1)"); }
  else if (input.leadType === "website_lead") { s += 5; reasons.push("Inbound web lead (+5)"); }

  // Clamp 0..100
  s = Math.max(0, Math.min(100, Math.round(s)));

  return { score: s, reasons };
}

// Bucket a numeric score into a tier label the UI can style consistently.
export function scoreBucket(score: number): "hot" | "warm" | "cool" | "cold" {
  if (score >= 80) return "hot";
  if (score >= 65) return "warm";
  if (score >= 50) return "cool";
  return "cold";
}
