// v20.32.43 — Extracted from server/routes.ts so other route modules
// (writeOffer.ts, listingConsult.ts, inspections.ts) can call awardPoints()
// directly without a circular import back into routes.ts. Logic is
// unchanged from the original routes.ts implementation — this is a pure
// move, not a rewrite. routes.ts now imports awardPoints from here too.
import { rawDb } from "./db";
import { broadcast } from "./ws";
import { getCallHeatTier } from "../shared/prime-schedule";
import { checkAndAwardAutoDetect } from "./challenges_routes";
import { currentDailyKey, currentWeeklyKey } from "./challenges";

// v12.5 — scoped: "seller" (default, existing seller-side call flow) or
// "recruiting" (agent-recruiting depot). Leaderboards + hard resets filter by
// scope so the two systems stay fully isolated.
export function awardPoints(
  agentId: number | null | undefined,
  outcome: string,
  leadId?: number,
  scope: "seller" | "recruiting" = "seller",
  // v20.50.0 — optional audit suffix appended to the stored `reason` (e.g.
  // "past_client" for the Past Client Appt gold bubble). Point lookup and the
  // FLAT_OUTCOMES check still use the bare `outcome`, so behavior/pricing is
  // unchanged — this only tags the ledger row for reporting. Every leaderboard
  // query filters with `reason LIKE 'contacted_appointment%'`, so the suffix
  // stays compatible with existing rollups.
  sourceTag?: string,
) {
  if (!agentId) return;
  // v15.11.26 — REBALANCED point system.
  // Appt Set crushes everything (only outcome that generates revenue). KIT is a real
  // conversation. Network referral is meaningful but doesn't move revenue directly.
  // Emails and voicemails award ZERO points — they were noise. Base dial fallback = 1.
  const pts: Record<string, number> = {
    contacted_appointment:     60,   // v15.11.31 — bumped 40→60. One Prime appt (120 pts) crushes 8 Prime KITs. Producers win.
    keep_in_touch:             15,   // v15.11.31 — trimmed 20→15. Still real convo value but no longer dial-farmable.
    network_referral:          20,   // v15.11.31 — bumped 15→20. Referrals ARE revenue-direct.
    open_house_lead:           20,   // v16.7 — OH captured lead. Same value as network referral (real capture, revenue-direct).
    open_house_log:            50,   // v17.6 — OH physical presence log, bumped 20→50 (evidence bar higher, encourages field work).
    oh_knock_route:            40,   // v17.6 — OH knock route piggyback, bumped 15→40 (SetRep evidence, real effort during OH).
    direct_mail:                1,   // v20.4.4 — Direct Mail: 1 point per mailer approved (was 3).
    door_knock:                 2,   // v17.6 — Base per-door value. Actual session points_potential = doors × 2 (25+ doors min).
    social_post:               10,   // v20.7.20 — BASE per-platform. Actual points_potential = 10 × platforms.length (1-3). 2/day cap enforced upstream.
    contacted_not_interested:   5,   // Real contact, worth something.
    // v20.33.3 — audit fix: was missing from this dict entirely, so it fell
    // through to the anonymous base-dial fallback (1 pt, still multiplied by
    // the Prime-time tier). nice_not_interested is a CONFIRMED real owner
    // contact (same evidence bar as contacted_not_interested) that gets
    // nurtured with a 180-day recycle instead of a dead delete — priced the
    // same as contacted_not_interested, not the anonymous-dial default.
    nice_not_interested:         5,
    listed:                     3,   // Rare informational outcome.
    recycled:                   2,   // Re-queue, minor effort.
    no_answer:                  2,   // Real dial, most common outcome.
    wrong_number:               1,   // Data cleanup.
    disconnected:               1,   // Data cleanup.
    left_voicemail:             6,   // v15.11.41 — Owner - No Answer: confirmed owner + recycle + boost. 6 pts.
    // v20.33.3 — audit fix: header comment above has always said "Emails and
    // voicemails award ZERO points", but email_sent had no explicit dict entry
    // and was silently falling to the 1-pt anonymous-dial fallback (up to 2x
    // at Prime). Voicemail was deliberately re-priced later (see left_voicemail
    // above); email never was — this closes that gap and matches the documented
    // intent, preventing point-farming via repeated manual email taps.
    email_sent:                  0,
    agent_referral_approved:  100,   // v19.6 — Referred agent got hired. Big deal.
    agent_invite_sent:         50,   // v20.7.9 — Immediate credit when an agent sends an invite (before candidate submits or gets approved).
    // v20.32.43 — Milestone events with a direct line to closed revenue.
    // Awarded once per event, flat (see FLAT_OUTCOMES below — no Prime multiplier;
    // these aren't dial activity and can happen at any hour).
    offer_submitted:                    200,  // Buyer's offer written + sent to TC.
    listing_signed:                     200,  // Seller signed the listing contract.
    inspection_request_submitted:        50,  // Inspections+ order sent to client for approval.
    inspection_approved:                 50,  // Client e-signed / accepted the inspection order.
    // v20.33.4 — Repairs was the one milestone tool with zero points wired
    // in. Mirrors the Inspections+ pair exactly: 50 when the quote goes out,
    // 50 when the client e-signs it (repairConsult.ts send-to-client / the
    // public /api/repair-quote/:token/accept endpoint).
    repair_quote_sent:                    50,  // Repair quote generated + sent to client.
    repair_quote_accepted:                50,  // Client e-signed the repair agreement.
    // v20.33.3 — golden-bubble milestone: an EXISTING active listing (already
    // on the market) goes under contract. Distinct from listing_signed (getting
    // the listing in the first place) — this rewards actually selling it.
    listing_under_contract:              200,  // Existing listing flips active/coming_soon/pocket -> pending.
    // Any other outcome falls back to base dial (1).
  };
  const basePoints = pts[outcome] ?? 1;
  // v17.6 — Evidence-gated field activities are FLAT (no Prime multiplier).
  // The dial multiplier exists because dial connect rates vary by hour; field
  // work happens whenever the agent shows up and admin approval can be delayed
  // hours or days, so multiplying by tier-at-approval is arbitrary and gameable.
  // Award the flat rate and short-circuit.
  const FLAT_OUTCOMES = new Set([
    "open_house_log", "open_house_lead", "oh_knock_route", "direct_mail", "door_knock",
    "social_post", "network_referral", "agent_referral_approved", "agent_invite_sent",
    // v20.32.43 — milestone events (see note above): flat, no Prime multiplier.
    "offer_submitted", "listing_signed", "inspection_request_submitted", "inspection_approved",
    "repair_quote_sent", "repair_quote_accepted", "listing_under_contract",
  ]);
  if (FLAT_OUTCOMES.has(outcome)) {
    if (basePoints === 0) return;
    const flatReason = sourceTag ? `${outcome}_${sourceTag}` : outcome;
    rawDb.prepare(
      `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(agentId, basePoints, flatReason, leadId ?? null, scope, new Date().toISOString());
    // v19.5 — Instant broadcast so leaderboard/team-pot/agent-stats refresh with no poll delay.
    try { broadcast({ type: "points_awarded", agentId, delta: basePoints, outcome, scope, ts: new Date().toISOString() }); } catch {}
    return;
  }
  // v15.11.26 — 5-TIER call-heat multiplier (was 2-tier). Multipliers align with
  // the 5-tier schedule grid in shared/prime-schedule.ts and drive the leaderboard
  // toward proven high-connect hours.
  //   Prime  🟢 → 2×
  //   Mid    🟡 → 1.5×
  //   Low    🟠 → 1.25×
  //   Down   ⬜ → 1× (dial-locked in UI; multiplier here as belt-and-suspenders)
  //   Illegal ⬛ → never awards (upstream endpoints refuse the call in the first place)
  let multiplier = 1;
  let tier: string = "base";
  try {
    tier = getCallHeatTier();
    if (tier === "prime") multiplier = 2;
    else if (tier === "mid") multiplier = 1.5;
    else if (tier === "low") multiplier = 1.25;
    else if (tier === "down") multiplier = 1;
    else multiplier = 1; // illegal shouldn't reach here, but be safe
  } catch (err) {
    console.error("[awardPoints] tier lookup failed", err);
  }
  // If the base points are 0 (emails, voicemail), no multiplier can save them.
  if (basePoints === 0) return;
  const points = Math.round(basePoints * multiplier);
  const outcomeLabel = sourceTag ? `${outcome}_${sourceTag}` : outcome;
  const reason = multiplier > 1 ? `${outcomeLabel}_${tier}_${multiplier}x` : outcomeLabel;
  rawDb.prepare(
    `INSERT INTO agent_points (agent_id, points, reason, lead_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, points, reason, leadId ?? null, scope, new Date().toISOString());
  // v19.5 — Instant broadcast so leaderboard/team-pot/agent-stats refresh with no poll delay.
  try { broadcast({ type: "points_awarded", agentId, delta: points, outcome, tier, scope, ts: new Date().toISOString() }); } catch {}
  // v20.7.8 — Auto-detect challenge completions immediately (used to only run
  // when the agent opened the Challenges tab). Fires the daily + weekly sweep.
  // Broadcasts a challenges refresh signal so the Home card + Challenges tab
  // live-update without a full refetch.
  try {
    const dailyAwarded = checkAndAwardAutoDetect(agentId, currentDailyKey(), "daily");
    const weeklyAwarded = checkAndAwardAutoDetect(agentId, currentWeeklyKey(), "weekly");
    if (dailyAwarded > 0 || weeklyAwarded > 0) {
      try { broadcast({ type: "challenges_updated", agentId, dailyAwarded, weeklyAwarded, ts: new Date().toISOString() }); } catch {}
    }
  } catch (e) {
    console.error("[awardPoints] challenge auto-detect failed:", e);
  }
}
