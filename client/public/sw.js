// Lead Depot Service Worker — cache-buster edition.
// Does NOT intercept fetch. On activate: purges any legacy caches AND asks every
// open client page to reload so stale PWA installs don't show old builds.
//
// IMPORTANT: SW_VERSION must be bumped on EVERY deploy. Browsers only fetch a new
// service worker when the SW file bytes differ. If the version stays the same, an
// installed PWA can lag a build by many hours (until its next daily SW check). Bumping
// this literal every deploy guarantees the SW byte-diffs, triggers a fresh install,
// which then broadcasts SW_UPDATED to every open tab and forces a reload.
// This is the 6th mandatory version-bump spot in the deploy workflow.

const SW_VERSION = "v15.0";

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
