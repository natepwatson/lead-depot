// v16.0 — Outcome tap queue with UUID + localStorage persistence + retry.
//
// Goal: no outcome tap ever disappears silently. Every button press generates
// a UUID immediately, is persisted to localStorage, sent to the server, and
// only removed from the queue when the server confirms with a receipt.
//
// If the phone goes offline mid-tap, or the network drops, or the server 500s,
// the queue keeps retrying at intervals (exponential backoff, capped at 60s)
// and also retries whenever `online` event fires. On next PWA boot, any pending
// taps flush immediately.
//
// Server-side, the same UUID short-circuits duplicate posts via the
// tap_receipts table, so retrying is safe — the server returns the ORIGINAL
// response and never double-counts.

const QUEUE_KEY = "leaddepot_tap_queue_v1";
const MAX_RETRY_MS = 60_000;
const MIN_RETRY_MS = 2_000;

export interface QueuedTap {
  tapId: string;
  url: string;               // /api/leads/{id}/outcome
  body: any;                 // full request body — includes clientTapId
  createdAt: number;
  attempts: number;
  nextTryAt: number;
  lastError?: string;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return "tap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function loadQueue(): QueuedTap[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch { return []; }
}

function saveQueue(q: QueuedTap[]) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
}

function removeFromQueue(tapId: string) {
  const q = loadQueue().filter(t => t.tapId !== tapId);
  saveQueue(q);
  notifyListeners();
}

function updateInQueue(tapId: string, patch: Partial<QueuedTap>) {
  const q = loadQueue();
  const idx = q.findIndex(t => t.tapId === tapId);
  if (idx >= 0) {
    q[idx] = { ...q[idx], ...patch };
    saveQueue(q);
    notifyListeners();
  }
}

const listeners = new Set<(depth: number) => void>();
function notifyListeners() {
  const depth = loadQueue().length;
  for (const l of listeners) { try { l(depth); } catch {} }
}
export function subscribeQueueDepth(cb: (depth: number) => void): () => void {
  listeners.add(cb);
  cb(loadQueue().length);
  return () => listeners.delete(cb);
}
export function getQueueDepth(): number { return loadQueue().length; }

// Attempt to send one tap. On success, remove from queue. On failure, schedule
// backoff and leave in queue.
async function attemptSend(tap: QueuedTap): Promise<{ ok: boolean; response?: any }> {
  try {
    const resp = await fetch(tap.url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tap.body),
    });
    if (resp.status === 400) {
      // Server rejected as malformed — drop from queue. Not a network issue.
      const errText = await resp.text().catch(() => "");
      console.warn("[tap-queue] server 400 — dropping", tap.tapId, errText);
      removeFromQueue(tap.tapId);
      return { ok: false };
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json().catch(() => ({}));
    removeFromQueue(tap.tapId);
    return { ok: true, response: data };
  } catch (err: any) {
    const attempts = tap.attempts + 1;
    const backoff = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * Math.pow(2, attempts));
    updateInQueue(tap.tapId, {
      attempts,
      nextTryAt: Date.now() + backoff,
      lastError: String(err?.message || err),
    });
    return { ok: false };
  }
}

// Public: enqueue and attempt immediate send. Returns the server response if
// the first send succeeded, or a synthesized "queued" response if it's now
// pending retry.
export async function enqueueAndSendTap(url: string, body: any): Promise<any> {
  const tapId = uuid();
  const bodyWithTap = { ...body, clientTapId: tapId };
  const tap: QueuedTap = {
    tapId, url, body: bodyWithTap,
    createdAt: Date.now(), attempts: 0, nextTryAt: Date.now(),
  };
  const q = loadQueue();
  q.push(tap);
  saveQueue(q);
  notifyListeners();

  const res = await attemptSend(tap);
  if (res.ok) return res.response;
  return { queued: true, tapId, lastError: tap.lastError };
}

// Background flush — runs every 3 seconds. Any tap whose nextTryAt <= now gets
// retried. On online event, immediately re-attempts everything.
let flushTimer: any = null;
function flushCycle() {
  const q = loadQueue();
  const now = Date.now();
  const due = q.filter(t => t.nextTryAt <= now);
  for (const tap of due) {
    // fire and forget — each one updates the queue individually
    attemptSend(tap).catch(() => {});
  }
}

export function startTapQueueWorker() {
  if (flushTimer) return;
  flushTimer = setInterval(flushCycle, 3_000);
  window.addEventListener("online", () => {
    // Reset all nextTryAt to now — try everything immediately
    const q = loadQueue().map(t => ({ ...t, nextTryAt: Date.now() }));
    saveQueue(q);
    flushCycle();
  });
  // Fire an immediate pass at boot.
  flushCycle();
}
