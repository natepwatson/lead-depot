// v15.11 — Client-side helper to subscribe the browser to Web Push and hand
// the endpoint to the server. Silent no-op on unsupported browsers and when
// permission is denied — a per-tab in-app OnAirBanner still fires either way.

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buf = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) buf[i] = rawData.charCodeAt(i);
  return buf;
}

async function fetchVapidKey(): Promise<string | null> {
  try {
    const r = await fetch("/api/push/vapid-public-key");
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.publicKey === "string" ? j.publicKey : null;
  } catch { return null; }
}

async function postSubscription(sub: PushSubscription): Promise<boolean> {
  try {
    const r = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    return r.ok;
  } catch { return false; }
}

/**
 * Ensure the current browser is subscribed to Web Push, and register the
 * subscription with the server. Safe to call repeatedly (idempotent via
 * upsert on endpoint).
 *
 * Returns "granted" | "denied" | "default" | "unsupported" | "error".
 */
export async function ensurePushSubscription(): Promise<string> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return "unsupported";
    }
    // Ensure permission
    let perm = Notification.permission;
    if (perm === "default") {
      try { perm = await Notification.requestPermission(); } catch { perm = "denied"; }
    }
    if (perm !== "granted") return perm;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await fetchVapidKey();
      if (!key) return "error";
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      } catch { return "error"; }
    }
    await postSubscription(sub);
    return "granted";
  } catch {
    return "error";
  }
}

export async function currentPushStatus(): Promise<string> {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function unsubscribePush(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return true;
  } catch { return false; }
}
