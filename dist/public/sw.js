// Lead Depot Service Worker — cache-buster + Web Push.
// - Does NOT intercept fetch.
// - On activate: purges any legacy caches AND asks every open client page to
//   reload so stale PWA installs don't show old builds.
// - Handles `push` events (v15.11.4) so agents get Prime Time alerts on
//   locked phones and closed browsers.
//
// IMPORTANT: SW_VERSION must be bumped on EVERY deploy. Browsers only fetch a
// new service worker when the SW file bytes differ. If the version stays the
// same, an installed PWA can lag a build by many hours (until its next daily
// SW check). This is the 6th mandatory version-bump spot in the deploy workflow.

const SW_VERSION = "v15.11.27";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 1) delete every named cache — nothing in this app relies on cached responses
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (_e) { /* ignore */ }
    // 2) claim all clients immediately
    await self.clients.claim();
    // 3) tell every open page to hard-reload so it picks up the new HTML + JS
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try { c.postMessage({ type: "SW_UPDATED", version: SW_VERSION }); } catch (_e) { /* ignore */ }
    }
  })());
});

// v15.11.4 — Web Push event. Payload is JSON: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let payload = { title: "Lead Depot", body: "", url: "/", tag: "ld-generic" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_e) {
    try { payload.body = event.data ? event.data.text() : ""; } catch (_e2) { /* ignore */ }
  }
  const options = {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag,
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 80, 200],
    data: { url: payload.url },
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// v15.11.4 — Focus/open the app when the notification is tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        if ("focus" in c) { await c.focus(); return; }
      } catch (_e) { /* ignore */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
