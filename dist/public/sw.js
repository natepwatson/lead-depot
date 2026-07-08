// Lead Depot Service Worker — v14.21 cache-buster edition
// Does NOT intercept fetch. On activate: purges any legacy caches AND asks every
// open client page to reload so stale PWA installs don't show old builds.

const SW_VERSION = "v14.21";

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
