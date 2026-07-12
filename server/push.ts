// v15.11 — Web Push (VAPID) for the team-wide Prime Time notifier.
//
// This module owns:
//   1. VAPID keypair (env-backed with a hardcoded default so shipping without
//      Railway env config doesn't break the app — but Alex should set the env
//      vars to rotate keys)
//   2. The push_subscriptions table's CRUD helpers
//   3. The single fire function that blasts to every stored subscription
//   4. The scheduler that checks every 5 min whether a PRIME window is
//      starting in ~30 min and, if so, fires exactly once for that window
//   5. Public getter for VAPID public key so the client can subscribe

import webpush from "web-push";
import { rawDb } from "./db";
import { listPrimeWindowStarts } from "../shared/prime-schedule";

// ─────────────────────────────────────────────────────────────────────────────
// VAPID init. The public key is safe to bake into the client (that's its
// whole purpose). The private key MUST be kept server-side.
// Railway env vars override the defaults.
// ─────────────────────────────────────────────────────────────────────────────

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY
  || "BM9HbCWawEvwj08j9DkMxBPCWd3IR-7MSCpSxMryqdvHXcxSI-o7WuqD7wl8lv3MIILGXhD_4NN8YVdqEz80Z6w";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY
  || "-3K-Cj9UlkuRi74DwZA6m4lzhk3h8QxwThRTHnigD_g";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:alex@watsonbrothersgroup.com";

try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("[push] VAPID configured");
} catch (err) {
  console.error("[push] VAPID setup failed:", err);
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription storage helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface PushSubRow {
  id: number;
  agent_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
}

export function saveSubscription(params: {
  agentId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): void {
  const now = new Date().toISOString();
  // UPSERT by endpoint — one row per browser/device across re-subscribes.
  rawDb.prepare(`
    INSERT INTO push_subscriptions (agent_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      agent_id = excluded.agent_id,
      p256dh   = excluded.p256dh,
      auth     = excluded.auth,
      user_agent = excluded.user_agent,
      last_seen_at = excluded.last_seen_at
  `).run(params.agentId, params.endpoint, params.p256dh, params.auth, params.userAgent ?? null, now, now);
}

export function deleteSubscriptionByEndpoint(endpoint: string): number {
  const info = rawDb.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  return info.changes;
}

export function listAllSubscriptions(): PushSubRow[] {
  return rawDb.prepare(`SELECT * FROM push_subscriptions`).all() as PushSubRow[];
}

export function listSubscriptionsForActiveAgents(): PushSubRow[] {
  return rawDb.prepare(`
    SELECT ps.* FROM push_subscriptions ps
    JOIN agents a ON a.id = ps.agent_id
    WHERE a.deactivated_at IS NULL
  `).all() as PushSubRow[];
}

export function pushStats(): {
  totalSubs: number;
  activeSubs: number;
  distinctAgents: number;
  activeAgents: number;
} {
  const totalAgents = rawDb.prepare(`SELECT COUNT(*) as n FROM agents WHERE deactivated_at IS NULL`).get() as { n: number };
  const totalSubs = rawDb.prepare(`SELECT COUNT(*) as n FROM push_subscriptions`).get() as { n: number };
  const activeSubs = rawDb.prepare(`
    SELECT COUNT(*) as n FROM push_subscriptions ps
    JOIN agents a ON a.id = ps.agent_id WHERE a.deactivated_at IS NULL
  `).get() as { n: number };
  const distinctAgents = rawDb.prepare(`SELECT COUNT(DISTINCT agent_id) as n FROM push_subscriptions`).get() as { n: number };
  const activeAgentsWithSub = rawDb.prepare(`
    SELECT COUNT(DISTINCT ps.agent_id) as n FROM push_subscriptions ps
    JOIN agents a ON a.id = ps.agent_id WHERE a.deactivated_at IS NULL
  `).get() as { n: number };
  return {
    totalSubs: totalSubs.n,
    activeSubs: activeSubs.n,
    distinctAgents: distinctAgents.n,
    activeAgents: activeAgentsWithSub.n,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The fire function. Blasts to every subscription and prunes 404/410 (expired)
// endpoints so the table doesn't rot.
// ─────────────────────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToAll(
  payload: PushPayload,
  opts: { activeOnly?: boolean } = { activeOnly: true },
): Promise<{ sent: number; failed: number; pruned: number }> {
  const subs = opts.activeOnly ? listSubscriptionsForActiveAgents() : listAllSubscriptions();
  let sent = 0, failed = 0, pruned = 0;
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag ?? "ld-prime-time",
  });
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      }, body, { TTL: 15 * 60 });
      sent++;
    } catch (err: any) {
      failed++;
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        deleteSubscriptionByEndpoint(s.endpoint);
        pruned++;
      }
    }
  }));
  return { sent, failed, pruned };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prime-window scheduler
// ─────────────────────────────────────────────────────────────────────────────

// Convert the local (America/New_York) prime starts to today's UTC epoch ms.
// Returns array of { windowKey, fireAt } where fireAt is 30 min BEFORE the
// prime start.
function todaysPrimeWindows(tz = "America/New_York"): Array<{ windowKey: string; fireAt: number; primeAt: number }> {
  const now = new Date();
  const starts = listPrimeWindowStarts(tz);
  // Get local dow for "today"
  const localFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false });
  const parts = localFmt.formatToParts(now);
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = dowMap[wdStr] ?? 1;
  const yr = parts.find(p => p.type === "year")?.value ?? "1970";
  const mo = parts.find(p => p.type === "month")?.value ?? "01";
  const da = parts.find(p => p.type === "day")?.value ?? "01";

  const out: Array<{ windowKey: string; fireAt: number; primeAt: number }> = [];
  for (const s of starts) {
    if (s.dow !== todayDow) continue;
    // Build a Date at midnight ET on this local date, then add s.hour hours.
    // Easiest: construct ISO string in local tz using known trick — build a
    // Date whose UTC pieces we assume represent the local wallclock, then
    // reconcile with tz offset.
    // Use Intl formatToParts to figure out the tz offset at that moment.
    // Simpler approach: for each hour of the day today, compute the UTC ms
    // that corresponds to that hour in `tz`, by iterating.
    const primeAt = wallclockLocalToUtcMs(parseInt(yr,10), parseInt(mo,10), parseInt(da,10), s.hour, 0, tz);
    if (primeAt == null) continue;
    const fireAt = primeAt - 30 * 60 * 1000;
    const windowKey = `${yr}-${mo}-${da}_${String(s.hour).padStart(2,"0")}`;
    out.push({ windowKey, fireAt, primeAt });
  }
  return out;
}

/**
 * Convert (year, month, day, hour, minute) in tz `tz` to UTC epoch ms.
 * Uses the difference-of-offsets trick with Intl.DateTimeFormat.
 */
function wallclockLocalToUtcMs(year: number, month: number, day: number, hour: number, minute: number, tz: string): number | null {
  // Start with a UTC guess and adjust.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Ask what local wallclock the guess corresponds to.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(guess));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = parseInt(x.value, 10);
  if (p.hour === 24) p.hour = 0;
  // Reconstruct the local time it thinks the UTC guess is
  const asLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Delta says how far off the guess was.
  const delta = guess - asLocal;
  return guess + delta;
}

let schedulerRunning = false;

export function startPrimePushScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const runOnce = async () => {
    try {
      const nowMs = Date.now();
      const windows = todaysPrimeWindows();
      for (const w of windows) {
        // Only fire when we're within a 5-min window of fireAt (i.e. the
        // scheduler ticked past it) AND we haven't fired for this window yet.
        const withinFireWindow = nowMs >= w.fireAt && nowMs < w.fireAt + 15 * 60 * 1000;
        if (!withinFireWindow) continue;
        const already = rawDb.prepare(`SELECT id FROM push_fire_log WHERE window_key = ?`).get(w.windowKey);
        if (already) continue;
        // Idempotency reserve: insert row FIRST with 0 recipients; update after send.
        try {
          rawDb.prepare(`INSERT INTO push_fire_log (window_key, fired_at, recipients, errors) VALUES (?, ?, 0, 0)`)
            .run(w.windowKey, new Date().toISOString());
        } catch { /* another instance won the race */ continue; }
        const hour = parseInt(w.windowKey.slice(-2), 10);
        const hourLabel = hour === 12 ? "12 PM" : hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
        const result = await sendPushToAll({
          title: "🔴 ON AIR in 30 min",
          body: `Prime Time at ${hourLabel} ET. Clear your schedule — this is when owners answer.`,
          url: "/",
          tag: "ld-prime-team",
        });
        rawDb.prepare(`UPDATE push_fire_log SET recipients = ?, errors = ? WHERE window_key = ?`)
          .run(result.sent, result.failed, w.windowKey);
        console.log(`[push] Prime T-30 fired for window ${w.windowKey}: sent=${result.sent} failed=${result.failed} pruned=${result.pruned}`);
      }
    } catch (err) {
      console.error("[push] scheduler tick error:", err);
    }
  };
  // Run every 5 minutes.
  setInterval(runOnce, 5 * 60 * 1000);
  // Fire once immediately on boot so a restart during a fire window still delivers.
  setTimeout(runOnce, 15 * 1000);
  console.log("[push] Prime push scheduler running every 5 min");
}
