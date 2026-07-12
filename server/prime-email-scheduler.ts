// v15.11.3 — Prime Time 30-min email notifier.
//
// Sends ONE email to every active agent 30 minutes before each PRIME block
// starts. A contiguous multi-hour block (e.g. Wed 3-7 PM) fires exactly ONE
// email, not one per hour, because listPrimeWindowStarts() only returns block
// starts, and prime_email_fire_log.window_key has a UNIQUE constraint so
// double-tick races collapse to a single insert.
//
// Zero opt-in. Zero permissions. Zero device dance. Every active, non-tombstoned
// agent's email address gets one Resend message before every Prime window.

import { Resend } from "resend";
import { rawDb } from "./db";
import { listPrimeWindowStarts } from "../shared/prime-schedule";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Ensure the fire log table exists (mirrors push_fire_log shape).
try {
  rawDb.exec(`CREATE TABLE IF NOT EXISTS prime_email_fire_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_key TEXT NOT NULL UNIQUE,
    fired_at TEXT NOT NULL,
    recipients INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0
  )`);
} catch {}

function wallclockLocalToUtcMs(year: number, month: number, day: number, hour: number, minute: number, tz: string): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(guess));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = parseInt(x.value, 10);
  if (p.hour === 24) p.hour = 0;
  const asLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const delta = guess - asLocal;
  return guess + delta;
}

function todaysPrimeWindows(tz = "America/New_York"): Array<{ windowKey: string; fireAt: number; primeAt: number; hour: number }> {
  const starts = listPrimeWindowStarts(tz);
  const now = new Date();
  const localFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false });
  const parts = localFmt.formatToParts(now);
  const wdStr = parts.find(p => p.type === "weekday")?.value ?? "Mon";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = dowMap[wdStr] ?? 1;
  const yr = parts.find(p => p.type === "year")?.value ?? "1970";
  const mo = parts.find(p => p.type === "month")?.value ?? "01";
  const da = parts.find(p => p.type === "day")?.value ?? "01";

  const out: Array<{ windowKey: string; fireAt: number; primeAt: number; hour: number }> = [];
  for (const s of starts) {
    if (s.dow !== todayDow) continue;
    const primeAt = wallclockLocalToUtcMs(parseInt(yr,10), parseInt(mo,10), parseInt(da,10), s.hour, 0, tz);
    if (primeAt == null) continue;
    const fireAt = primeAt - 30 * 60 * 1000;
    const windowKey = `${yr}-${mo}-${da}_${String(s.hour).padStart(2,"0")}`;
    out.push({ windowKey, fireAt, primeAt, hour: s.hour });
  }
  return out;
}

function hourLabel(h: number): string {
  return h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function getActiveAgentEmails(): string[] {
  try {
    const rows = rawDb.prepare(
      `SELECT email FROM agents WHERE active = 1 AND email NOT LIKE 'tombstone:%' AND email LIKE '%@%'`
    ).all() as Array<{ email: string }>;
    return rows.map(r => r.email).filter(Boolean);
  } catch {
    return [];
  }
}

export async function sendPrimeEmailToTeam(hour: number): Promise<{ sent: number; failed: number }> {
  if (!resend) {
    console.log("[prime-email] RESEND_API_KEY not set — skipping send");
    return { sent: 0, failed: 0 };
  }
  const recipients = getActiveAgentEmails();
  if (recipients.length === 0) return { sent: 0, failed: 0 };

  const label = hourLabel(hour);
  const subject = `🔴 Prime Time in 30 minutes — ${label} ET`;
  const html = `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0a0908;color:#f5f2ec">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="display:inline-block;padding:6px 12px;background:#dc2626;color:white;font-weight:700;font-size:12px;letter-spacing:0.06em;border-radius:4px">PRIME TIME · T-30</div>
    <h1 style="font-size:28px;line-height:1.2;margin:20px 0 12px 0">On air at ${label} ET.</h1>
    <p style="font-size:16px;line-height:1.5;color:#d9d4c9;margin:0 0 24px 0">Clear your schedule. This is when owners answer.</p>
    <a href="https://depot.watsonbrothersgroup.com/" style="display:inline-block;padding:12px 22px;background:#c8a355;color:#0a0908;font-weight:700;text-decoration:none;border-radius:6px">Open Lead Depot →</a>
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1e1c19;font-size:11px;color:#666">Lead Depot v15.11.3 — Brothers Group · Momentum Realty</div>
  </div>
</body></html>`;

  let sent = 0, failed = 0;
  // Send individually so a single bad address doesn't kill the batch.
  await Promise.all(recipients.map(async (to) => {
    try {
      await resend.emails.send({
        from: "Lead Depot <noreply@watsonbrothersgroup.com>",
        to: [to],
        subject,
        html,
      });
      sent++;
    } catch (err) {
      failed++;
      console.error(`[prime-email] send failed to ${to}:`, err);
    }
  }));
  return { sent, failed };
}

let schedulerRunning = false;

export function startPrimeEmailScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const runOnce = async () => {
    try {
      const nowMs = Date.now();
      const windows = todaysPrimeWindows();
      for (const w of windows) {
        const withinFireWindow = nowMs >= w.fireAt && nowMs < w.fireAt + 15 * 60 * 1000;
        if (!withinFireWindow) continue;
        const already = rawDb.prepare(`SELECT id FROM prime_email_fire_log WHERE window_key = ?`).get(w.windowKey);
        if (already) continue;
        try {
          rawDb.prepare(`INSERT INTO prime_email_fire_log (window_key, fired_at, recipients, errors) VALUES (?, ?, 0, 0)`)
            .run(w.windowKey, new Date().toISOString());
        } catch { continue; /* race lost */ }
        const result = await sendPrimeEmailToTeam(w.hour);
        rawDb.prepare(`UPDATE prime_email_fire_log SET recipients = ?, errors = ? WHERE window_key = ?`)
          .run(result.sent, result.failed, w.windowKey);
        console.log(`[prime-email] T-30 fired for ${w.windowKey}: sent=${result.sent} failed=${result.failed}`);
      }
    } catch (err) {
      console.error("[prime-email] scheduler tick error:", err);
    }
  };
  // Tick every 5 minutes.
  runOnce().catch(() => {});
  setInterval(runOnce, 5 * 60 * 1000);
  console.log("[prime-email] scheduler started (ticks every 5 min, fires 30 min before each Prime block)");
}
