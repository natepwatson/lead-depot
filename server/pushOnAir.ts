// v15.11.10 — 15-min-before On Air push notification system.
//
// Contract:
//   * Agents opt in via Profile toggle → agents.push_notif_on_air = 1.
//   * The client subscribes to Web Push via PushManager (public VAPID key
//     exposed at /api/push/public-key). Subscriptions stored in
//     push_subscriptions table, keyed by (agent_id, endpoint UNIQUE).
//   * A server-side scheduler runs every 5 minutes; when the next PRIME
//     window start is within [10, 20) minutes from now, it fires a single
//     notification to every opted-in agent. Idempotency: push_fire_log
//     records window_key = "<dow>-<hour>-<YYYY-MM-DD>" so a window fires
//     exactly once per calendar day.
//
// VAPID keys: read from env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. If either
// is missing, everything degrades to no-op (endpoints still respond, cron
// still runs; no push fired).

import type { Express, Request, Response } from "express";
import webpush from "web-push";
import { rawDb } from "./db";
import { listPrimeWindowStarts, nextPrimeStartAfter } from "../shared/prime-schedule";

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const CONTACT = process.env.VAPID_CONTACT || "mailto:alex@watsonbrothersgroup.com";

let vapidConfigured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidConfigured = true;
    console.log("[push] VAPID configured");
  } catch (e: any) {
    console.warn("[push] VAPID setup failed:", e?.message);
  }
} else {
  console.log("[push] VAPID keys not set — push disabled. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in Railway env to enable.");
}

export function isPushEnabled(): boolean { return vapidConfigured; }

interface PushSubRow {
  id: number;
  agent_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Register routes
export function registerPushRoutes(app: Express) {
  // Public key for the client to subscribe with
  app.get("/api/push/public-key", (_req: Request, res: Response) => {
    res.json({ publicKey: VAPID_PUBLIC, enabled: vapidConfigured });
  });

  // Get opt-in state
  app.get("/api/agents/:id/push-prefs", (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const row = rawDb.prepare("SELECT push_notif_on_air FROM agents WHERE id = ?").get(id) as { push_notif_on_air?: number } | undefined;
    res.json({ pushNotifOnAir: !!row?.push_notif_on_air });
  });

  // Set opt-in state
  app.post("/api/agents/:id/push-prefs", (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const v = req.body?.pushNotifOnAir ? 1 : 0;
    rawDb.prepare("UPDATE agents SET push_notif_on_air = ? WHERE id = ?").run(v, id);
    res.json({ ok: true, pushNotifOnAir: !!v });
  });

  // Subscribe (upsert)
  app.post("/api/push/subscribe", (req: Request, res: Response) => {
    const { agentId, subscription, userAgent } = req.body || {};
    if (!agentId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: "missing fields" });
    }
    const now = new Date().toISOString();
    // UPSERT — endpoint is UNIQUE
    try {
      rawDb.prepare(`
        INSERT INTO push_subscriptions (agent_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET agent_id = excluded.agent_id, last_seen_at = excluded.last_seen_at
      `).run(agentId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent || null, now, now);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "db error" });
    }
    res.json({ ok: true });
  });

  // Unsubscribe
  app.post("/api/push/unsubscribe", (req: Request, res: Response) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "missing endpoint" });
    rawDb.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    res.json({ ok: true });
  });

  // v15.11.10 — Test endpoint: fire a push to a single agent right now.
  // Guarded by INGEST_SECRET so only Alex/Nate can trigger.
  app.post("/api/push/test", async (req: Request, res: Response) => {
    if (req.headers["x-ingest-secret"] !== process.env.INGEST_SECRET) return res.status(403).json({ error: "forbidden" });
    if (!vapidConfigured) return res.status(400).json({ error: "vapid not configured" });
    const agentId = parseInt(String(req.body?.agentId || ""), 10);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: "bad agentId" });
    const subs = rawDb.prepare("SELECT * FROM push_subscriptions WHERE agent_id = ?").all(agentId) as PushSubRow[];
    let sent = 0, failed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } } as any, JSON.stringify({
          title: "On Air Test",
          body: "This is a test push from Lead Depot.",
          tag: "onair-test",
          url: "/",
        }));
        sent++;
      } catch (e: any) {
        failed++;
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          rawDb.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
        }
      }
    }
    res.json({ sent, failed, totalSubs: subs.length });
  });
}

/**
 * Fire push to all opted-in agents 15 min before the next PRIME window.
 * Called by an interval scheduler (5-min tick).
 * Idempotent per calendar day via push_fire_log.
 */
export async function tickOnAirPush(): Promise<{ fired: number; sent: number; failed: number } | null> {
  if (!vapidConfigured) return null;

  const now = new Date();
  const tz = "America/New_York";
  const nextStart = nextPrimeStartAfter(tz, now);
  const minutesUntil = (nextStart.getTime() - now.getTime()) / 60_000;

  // Fire when we're inside [10, 20) minutes before the window. 5-min cron gives one hit per window.
  if (minutesUntil < 10 || minutesUntil >= 20) return null;

  // Idempotency key: "<yyyy-mm-dd-in-ET>-<hh>"
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false }).formatToParts(nextStart);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  const hh = parts.find(p => p.type === "hour")?.value;
  const windowKey = `${y}-${m}-${d}-${hh}`;

  const existing = rawDb.prepare("SELECT window_key FROM push_fire_log WHERE window_key = ?").get(windowKey);
  if (existing) return null;

  // Query all opted-in agents with active subs
  const rows = rawDb.prepare(`
    SELECT s.endpoint, s.p256dh, s.auth
    FROM push_subscriptions s
    JOIN agents a ON a.id = s.agent_id
    WHERE a.push_notif_on_air = 1 AND a.is_active = 1
  `).all() as { endpoint: string; p256dh: string; auth: string }[];

  if (rows.length === 0) {
    rawDb.prepare("INSERT INTO push_fire_log (window_key, fired_at, recipients, errors) VALUES (?, ?, 0, 0)").run(windowKey, new Date().toISOString());
    return { fired: 1, sent: 0, failed: 0 };
  }

  const hourLabel = (h: string) => {
    const n = parseInt(h, 10);
    if (n === 0) return "12 AM";
    if (n < 12) return `${n} AM`;
    if (n === 12) return "12 PM";
    return `${n - 12} PM`;
  };

  const payload = JSON.stringify({
    title: "🔴 ON AIR in 15 min",
    body: `Prime window starts at ${hourLabel(hh || "0")}. Get ready to dial.`,
    tag: "onair-15min",
    url: "/",
  });

  let sent = 0, failed = 0;
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } } as any, payload);
      sent++;
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        rawDb.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
      }
    }
  }
  rawDb.prepare("INSERT INTO push_fire_log (window_key, fired_at, recipients, errors) VALUES (?, ?, ?, ?)").run(windowKey, new Date().toISOString(), sent, failed);
  console.log(`[push] fired On Air 15min alert: ${sent}/${sent + failed} sent for window ${windowKey}`);
  return { fired: 1, sent, failed };
}

/** Start the 5-minute scheduler. Idempotent — safe to call multiple times. */
let schedulerStarted = false;
export function startOnAirPushScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Fire immediately then every 5 minutes
  const runOnce = () => { tickOnAirPush().catch(err => console.warn("[push] tick error", err?.message)); };
  setTimeout(runOnce, 15_000); // 15s after boot
  setInterval(runOnce, 5 * 60 * 1000);
  console.log("[push] On Air 15-min scheduler started (5min interval)");
}

// Utility for a Profile/admin page: enumerate prime starts for the week
export function primeStartsForWeek() {
  return listPrimeWindowStarts("America/New_York");
}
