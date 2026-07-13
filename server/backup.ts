// server/backup.ts — v15.9. Lead Depot backup system.
//
// Two tiers of backup:
//
//   TIER 1 (hourly, on-volume): Copy data.db + headshots/ into
//     /app/data/backups/YYYY-MM-DD_HH.tar.gz. Keep the most recent 48 hours.
//     Runs every hour on the hour. Cheap, fast, always-on. Protects against
//     "I ran the wrong migration and half the leads are gone" — you can lose
//     at most 59 minutes of work.
//
//     Not enough by itself: if the Railway volume is lost/detached/corrupted,
//     all 48 rolling snapshots go with it.
//
//   TIER 2 (daily, off-volume): Once per day at 05:00 EDT (09:00 UTC), send
//     the most recent snapshot as an email attachment to alex@ + nate@ via
//     Resend. That's the "the volume is gone" recovery path. Data lives in
//     the admins' inboxes forever.
//
//     Constraints: Resend attachment cap is 40 MB. We gzip the sqlite file
//     (typically compresses 4-6x). If the raw DB ever exceeds ~150 MB (i.e.
//     compressed > 40 MB) we log a warning and skip Tier 2 for the day \u2014 the
//     Tier 1 rolling snapshots are still fine. When that day comes, migrate
//     Tier 2 to S3/R2.
//
//   MANUAL RESTORE: In an emergency, download the .tar.gz from the email,
//     ungzip, extract, stop the Railway container, replace /app/data/data.db
//     with the extracted file, start again. That's it. There's no fancy
//     restore endpoint on purpose — a restore should be a deliberate,
//     human-in-the-loop operation.
//
// State: last-run timestamps stored in the settings table (keys
//   `backup_hourly_last_ok_ts`, `backup_hourly_last_error`,
//   `backup_daily_last_ok_ts`, `backup_daily_last_error`) so /api/admin/
//   backup-status can report them and the nightly Certify cron can alert if
//   they go stale.
//
// Zero routing/assignment/PULL MODE / round-robin changes.

import { rawDb } from "./db";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const IS_PROD = process.env.NODE_ENV === "production";
const DATA_DIR = IS_PROD ? "/app/data" : path.join(process.cwd(), "data-dev");
const DB_PATH = path.join(DATA_DIR, "data.db");
const HEADSHOTS_DIR = path.join(DATA_DIR, "headshots");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const HOURLY_RETENTION_HOURS = 48;
const RESEND_ATTACHMENT_LIMIT_BYTES = 38 * 1024 * 1024; // 38 MB, under Resend's 40 MB cap

function log(...args: any[]) { console.log("[backup]", ...args); }
function logErr(...args: any[]) { console.error("[backup]", ...args); }

function setSetting(key: string, value: string) {
  try {
    rawDb.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } catch (e) { logErr("setSetting failed:", key, e); }
}

function getSetting(key: string): string | null {
  try {
    const row = rawDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  } catch { return null; }
}

// ─── SQLite online backup (safe copy of the live DB) ─────────────────────────
// Uses better-sqlite3's built-in .backup() API. Does NOT block writers. Copies
// pages incrementally under the hood.
async function snapshotSqliteTo(destPath: string): Promise<void> {
  await (rawDb as any).backup(destPath, {
    // Copy 200 pages at a time between yields to keep the app responsive
    step: 200,
  });
}

// ─── TIER 1: hourly on-volume snapshot ───────────────────────────────────────
export async function runHourlyBackup(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 13).replace("T", "_")}`; // YYYY-MM-DD_HH (UTC)
    const workDir = path.join(BACKUP_DIR, `.work_${stamp}`);
    const finalPath = path.join(BACKUP_DIR, `${stamp}.tar.gz`);

    // If we already made this hour's snapshot, no-op (idempotent).
    if (fs.existsSync(finalPath)) {
      setSetting("backup_hourly_last_ok_ts", now.toISOString());
      return { ok: true, path: finalPath };
    }

    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });

    // 1. Sqlite online backup into workdir/data.db
    const stagedDb = path.join(workDir, "data.db");
    await snapshotSqliteTo(stagedDb);

    // 2. Copy headshots directory (small: <5 MB typically)
    if (fs.existsSync(HEADSHOTS_DIR)) {
      const stagedHeadshots = path.join(workDir, "headshots");
      fs.mkdirSync(stagedHeadshots, { recursive: true });
      for (const f of fs.readdirSync(HEADSHOTS_DIR)) {
        const src = path.join(HEADSHOTS_DIR, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(stagedHeadshots, f));
        }
      }
    }

    // 3. tar + gzip the workdir into finalPath
    execSync(`tar -czf "${finalPath}" -C "${workDir}" .`, { stdio: ["ignore", "ignore", "pipe"] });

    // 4. Cleanup workdir
    fs.rmSync(workDir, { recursive: true, force: true });

    // 5. Prune snapshots older than retention window
    pruneOldSnapshots();

    const sizeMB = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2);
    setSetting("backup_hourly_last_ok_ts", now.toISOString());
    setSetting("backup_hourly_last_error", "");
    log(`hourly snapshot ok: ${finalPath} (${sizeMB} MB)`);
    return { ok: true, path: finalPath };
  } catch (e: any) {
    const msg = e?.message || String(e);
    setSetting("backup_hourly_last_error", `${new Date().toISOString()} :: ${msg}`);
    logErr("hourly snapshot FAILED:", msg);
    return { ok: false, error: msg };
  }
}

function pruneOldSnapshots() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith(".tar.gz"))
      .map(f => ({ name: f, full: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - HOURLY_RETENTION_HOURS * 60 * 60 * 1000;
    for (const f of files) {
      if (f.mtime < cutoff) {
        try { fs.unlinkSync(f.full); log("pruned old snapshot:", f.name); } catch {}
      }
    }
  } catch (e) { logErr("prune failed:", e); }
}

// ─── TIER 2: daily off-volume backup via Resend email ────────────────────────
export async function runDailyOffVolumeBackup(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Take a fresh snapshot first so today's email has today's data
    const snap = await runHourlyBackup();
    if (!snap.ok || !snap.path) throw new Error("upstream snapshot failed: " + snap.error);

    const size = fs.statSync(snap.path).size;
    if (size > RESEND_ATTACHMENT_LIMIT_BYTES) {
      const msg = `snapshot ${(size / 1024 / 1024).toFixed(2)}MB exceeds Resend cap ${(RESEND_ATTACHMENT_LIMIT_BYTES / 1024 / 1024).toFixed(2)}MB \u2014 Tier 2 skipped, migrate to S3 soon`;
      setSetting("backup_daily_last_error", `${new Date().toISOString()} :: ${msg}`);
      logErr(msg);
      return { ok: false, error: msg };
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) throw new Error("RESEND_API_KEY not set \u2014 cannot email backup");

    const attachmentB64 = fs.readFileSync(snap.path).toString("base64");
    const filename = path.basename(snap.path);
    const now = new Date();
    const stampNice = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const sizeMB = (size / 1024 / 1024).toFixed(2);

    // Snapshot counts \u2014 nice to show admins whether the DB looks alive
    let leadCount = 0, agentCount = 0, activityCount = 0;
    try { leadCount = (rawDb.prepare("SELECT COUNT(*) c FROM leads").get() as any).c; } catch {}
    try { agentCount = (rawDb.prepare("SELECT COUNT(*) c FROM agents WHERE is_active=1").get() as any).c; } catch {}
    try { activityCount = (rawDb.prepare("SELECT COUNT(*) c FROM lead_activity").get() as any).c; } catch {}

    const body = `Lead Depot daily off-volume backup.

Snapshot: ${filename}
Taken:    ${stampNice}
Size:     ${sizeMB} MB (gzip'd tar of data.db + headshots)

Row counts at snapshot time:
  \u2022 Active agents: ${agentCount}
  \u2022 Leads:         ${leadCount}
  \u2022 Activities:    ${activityCount}

RESTORE (only if the Railway volume is lost):
  1. Download the attached ${filename}
  2. tar -xzf ${filename} \u2014> extracts data.db + headshots/
  3. Stop the Railway service
  4. Replace /app/data/data.db with the extracted data.db
  5. Copy the headshots/ contents into /app/data/headshots/
  6. Start the Railway service

Do NOT reply to this email. This is an automated system message.
\u2014 Lead Depot v15.11.22`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Lead Depot Backup <noreply@watsonbrothersgroup.com>",
        to: ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com"],
        subject: `Lead Depot backup \u2014 ${filename} (${sizeMB} MB)`,
        text: body,
        attachments: [
          { filename, content: attachmentB64 },
        ],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`resend ${resp.status}: ${errText.slice(0, 300)}`);
    }
    setSetting("backup_daily_last_ok_ts", now.toISOString());
    setSetting("backup_daily_last_error", "");
    log(`daily off-volume backup emailed: ${filename} (${sizeMB} MB)`);
    return { ok: true };
  } catch (e: any) {
    const msg = e?.message || String(e);
    setSetting("backup_daily_last_error", `${new Date().toISOString()} :: ${msg}`);
    logErr("daily off-volume backup FAILED:", msg);
    return { ok: false, error: msg };
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────
// setInterval-based scheduler. Runs hourly backups on every hour boundary
// (aligns to :00 minute), daily off-volume at 09:00 UTC (05:00 EDT).
//
// Idempotency: both entry points no-op if their target snapshot already exists
// for the current hour, so a slight jitter is fine and container restarts
// don't spam extra snapshots.

let schedulerStarted = false;

export function startBackupScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  log("backup scheduler starting \u2014 hourly + daily 05:00 EDT");

  // Kick off one backup shortly after boot so a fresh container has a
  // recent snapshot without waiting up to an hour.
  setTimeout(() => { runHourlyBackup().catch(() => {}); }, 60 * 1000);

  // Tick every minute; run hourly backup at :00, daily at 09:00 UTC (05:00 EDT).
  setInterval(async () => {
    try {
      const now = new Date();
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      if (utcM === 0) {
        // Hourly snapshot at the top of every hour
        await runHourlyBackup();
      }
      if (utcH === 9 && utcM === 5) {
        // Daily off-volume backup at 09:05 UTC = 05:05 EDT (avoids the same-minute
        // pileup with the hourly at :00).
        await runDailyOffVolumeBackup();
      }
    } catch (e) { logErr("scheduler tick failed:", e); }
  }, 60 * 1000);
}

// ─── STATUS (called by /api/admin/backup-status) ─────────────────────────────

export function getBackupStatus() {
  let snapshotFiles: { name: string; size: number; mtime: string }[] = [];
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      snapshotFiles = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith(".tar.gz"))
        .map(f => {
          const full = path.join(BACKUP_DIR, f);
          const st = fs.statSync(full);
          return { name: f, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    }
  } catch {}

  return {
    hourly: {
      lastOkTs: getSetting("backup_hourly_last_ok_ts"),
      lastError: getSetting("backup_hourly_last_error"),
      snapshotCount: snapshotFiles.length,
      totalBytes: snapshotFiles.reduce((s, f) => s + f.size, 0),
      newest: snapshotFiles[0] ?? null,
      oldest: snapshotFiles[snapshotFiles.length - 1] ?? null,
    },
    daily: {
      lastOkTs: getSetting("backup_daily_last_ok_ts"),
      lastError: getSetting("backup_daily_last_error"),
    },
    config: {
      retentionHours: HOURLY_RETENTION_HOURS,
      attachmentLimitMB: RESEND_ATTACHMENT_LIMIT_BYTES / 1024 / 1024,
      dataDir: DATA_DIR,
      backupDir: BACKUP_DIR,
    },
  };
}
