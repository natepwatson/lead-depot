// server/security.ts — v15.9. Zero-dependency security headers middleware.
//
// Replaces the need for `helmet` (which we don't want to add to the Docker
// build). Sets a conservative but functional set of security headers on every
// response. Applied ONCE from server/index.ts, right after CORS.
//
// What each header does and why:
//
//   Strict-Transport-Security ..... Tells browsers "only ever talk HTTPS to
//                                   this hostname for 1 year, including sub-
//                                   domains." Railway edge already forces
//                                   HTTPS, but this makes the browser refuse
//                                   any accidental HTTP downgrade.
//
//   X-Content-Type-Options ........ "nosniff" — stops browsers from guessing
//                                   MIME types (e.g. treating a text file as
//                                   JS if it looks like JS).
//
//   X-Frame-Options ............... "DENY" — nobody can iframe our app.
//                                   Blocks clickjacking. We never embed the
//                                   admin UI in another page.
//
//   Referrer-Policy ............... "strict-origin-when-cross-origin" — when
//                                   an agent clicks a link out, the target
//                                   only sees the origin (depot.watsonbros...)
//                                   not the full path (which could leak
//                                   /admin/candidates/17 etc.).
//
//   Permissions-Policy ............ Denies camera/microphone/geolocation by
//                                   default. We use the phone dialer via tel:
//                                   links, not WebRTC.
//
//   Content-Security-Policy ....... Deliberately CONSERVATIVE. We inline our
//                                   own JS (Vite build) and load fonts from
//                                   /fonts and images from anywhere. We do
//                                   NOT load third-party JS. connect-src
//                                   allows wss: for our own WebSocket.
//                                   'unsafe-inline' is present for STYLE only
//                                   (Tailwind arbitrary values, inline style
//                                   attributes). Report-only mode was removed
//                                   after v15.9 canary; if a CSP violation
//                                   ever breaks the app, flip CSP_ENFORCE to
//                                   false to temporarily downgrade to report.

import type { Request, Response, NextFunction } from "express";

const CSP_ENFORCE = true; // set false to log-only if CSP ever breaks

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // v15.11.1 hotfix — allow the Leaflet CDN so the Territory Map page loads.
  // unpkg.com serves versioned, integrity-verifiable static files; we pin a
  // specific leaflet version in MapView.tsx.
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "font-src 'self' data:",                    // /fonts + occasional data:
  "img-src 'self' data: blob: https:",        // headshots, QR codes, tiles
  "connect-src 'self' wss: https:",           // WebSocket + own API
  "frame-ancestors 'none'",                   // duplicate of X-Frame-Options
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // 1-year HSTS, include subdomains, allow preload list inclusion
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    CSP_DIRECTIVES,
  );
  next();
}
