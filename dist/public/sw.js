// Lead Depot Service Worker — minimal, install-only
// Does NOT intercept any fetch requests — zero impact on page load speed

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
