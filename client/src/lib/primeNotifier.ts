// v19.0 — In-app Prime Time notifier. No external service, no VAPID, no push.
//
// Strategy:
//   1. Client asks for Notification permission after the agent's first meaningful
//      interaction (opt-in banner shown from AgentView).
//   2. A single global setInterval ticks every 60 seconds while the tab is open.
//   3. On each tick we compute the current (dow, hour) in America/New_York and
//      ask listPrimeWindowStarts() whether we're at the START of a contiguous
//      prime block. If yes AND we haven't already notified for this specific
//      block-start today, fire ONE notification and record the block-key in
//      localStorage so we don't re-fire when the agent minimizes / re-opens
//      the tab an hour in.
//
// Because notifications only fire while the PWA / tab is open, this is a
// "reminder while you're in the app" affordance, not a background push. Alex
// said "no external features we don't have available", so this is the ceiling.

import { listPrimeWindowStarts } from "./callHeat";

const STORAGE_KEY = "ld_prime_notified_blocks_v1";

function todayDatestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readNotifiedBlocks(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (parsed?.date !== todayDatestamp()) return new Set(); // reset each day
    return new Set(parsed.keys || []);
  } catch { return new Set(); }
}

function writeNotifiedBlocks(keys: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayDatestamp(), keys: Array.from(keys) }));
  } catch {}
}

function currentEtDowHour(): { dow: number; hour: number } {
  // Convert local -> America/New_York using Intl.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const wd = parts.find(p => p.type === "weekday")?.value || "Sun";
  const hr = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: dowMap[wd] ?? 0, hour: hr % 24 };
}

async function fireNotification(hourLabel: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const title = "🔥 Prime Time is live";
  const body = `${hourLabel} — the phones are ripe. Start dialing now.`;
  const opts: NotificationOptions = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: "prime-time-on-air",
    requireInteraction: false,
  };

  try {
    // Prefer service worker if registered — this pops through on some iOS
    // versions where new Notification() is blocked in PWA installed mode.
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, opts);
        return;
      }
    }
    new Notification(title, opts);
  } catch (e) {
    console.warn("[primeNotifier] fire failed", e);
  }
}

function hourLabelFor(hour: number): string {
  return hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`;
}

let started = false;

/**
 * Start the once-per-minute polling loop. Safe to call repeatedly — idempotent.
 * Call this once at App-level mount after the agent is authenticated.
 */
export function startPrimeNotifier() {
  if (started || typeof window === "undefined") return;
  started = true;

  const tick = () => {
    if (Notification.permission !== "granted") return;
    const { dow, hour } = currentEtDowHour();
    const starts = listPrimeWindowStarts();
    const match = starts.find(s => s.dow === dow && s.hour === hour);
    if (!match) return;

    // Only fire in the first ~5 minutes of the hour so we don't re-fire when the
    // agent opens the tab 45 minutes into a prime block.
    const nowMin = new Date().getMinutes();
    if (nowMin > 5) return;

    const key = `${todayDatestamp()}|${dow}|${hour}`;
    const notified = readNotifiedBlocks();
    if (notified.has(key)) return;

    fireNotification(hourLabelFor(hour));
    notified.add(key);
    writeNotifiedBlocks(notified);
  };

  tick(); // fire immediately in case we opened right at the top of the hour
  window.setInterval(tick, 60_000);
}

/**
 * Ask the user for notification permission. Call from a user gesture (button click).
 * Returns the final permission state.
 */
export async function requestPrimeNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}
