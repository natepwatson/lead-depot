import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const compression = require("compression");

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // ── Gzip compression — level 1 is 10x faster than level 6, still ~70% smaller ──
  app.use(compression({ level: 1, threshold: 1024 }));

  // ── Agent headshots → no-cache (user-uploaded, changes at any time) ───────
  // In production: serve from persistent Railway volume so headshots survive deploys
  // Fallback: also serve from dist/public/headshots/ (committed slug files)
  const isProduction = process.env.NODE_ENV === "production";
  const headshotsPath = isProduction ? "/app/data/headshots" : path.join(distPath, "headshots");
  const headshotsFallbackPath = path.join(distPath, "headshots");
  if (!fs.existsSync(headshotsPath)) fs.mkdirSync(headshotsPath, { recursive: true });
  const headshotOpts = {
    maxAge: 0,
    etag: true,
    setHeaders(res: any) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  };
  // Primary: volume (user-uploaded headshots survive deploys)
  app.use("/headshots", express.static(headshotsPath, headshotOpts));
  // Fallback: committed slug files in dist/public/headshots/
  if (isProduction && headshotsFallbackPath !== headshotsPath) {
    app.use("/headshots", express.static(headshotsFallbackPath, headshotOpts));
  }

  // ── Repair Consult photos + generated quote PDFs → no-cache (user-uploaded / generated) ──
  const repairPhotosPath = isProduction ? "/app/data/repair-photos" : path.join(distPath, "repair-photos");
  if (!fs.existsSync(repairPhotosPath)) fs.mkdirSync(repairPhotosPath, { recursive: true });
  app.use("/repair-photos", express.static(repairPhotosPath, headshotOpts));

  const repairQuotesPath = isProduction ? "/app/data/repair-quotes" : path.join(distPath, "repair-quotes");
  if (!fs.existsSync(repairQuotesPath)) fs.mkdirSync(repairQuotesPath, { recursive: true });
  app.use("/repair-quotes", express.static(repairQuotesPath, headshotOpts));

  // ── Listing Consult photos (front-of-house + walkthrough gallery) → no-cache ──
  const listingPhotosPath = isProduction ? "/app/data/listing-photos" : path.join(distPath, "listing-photos");
  if (!fs.existsSync(listingPhotosPath)) fs.mkdirSync(listingPhotosPath, { recursive: true });
  app.use("/listing-photos", express.static(listingPhotosPath, headshotOpts));

  // ── Payment evidence + signed-receipt photos (Part 7, v20.32.13) → no-cache ──
  const paymentPhotosPath = isProduction ? "/app/data/payment-photos" : path.join(distPath, "payment-photos");
  if (!fs.existsSync(paymentPhotosPath)) fs.mkdirSync(paymentPhotosPath, { recursive: true });
  app.use("/payment-photos", express.static(paymentPhotosPath, headshotOpts));

  // ── Inspection wiring-instructions PDFs (v20.32.28) → no-cache ────────────
  const inspectionWiringPath = isProduction ? "/app/data/inspection-wiring" : path.join(distPath, "inspection-wiring");
  if (!fs.existsSync(inspectionWiringPath)) fs.mkdirSync(inspectionWiringPath, { recursive: true });
  app.use("/inspection-wiring", express.static(inspectionWiringPath, headshotOpts));

  // ── Hashed assets (JS/CSS bundles) → 1 year immutable cache ──────────────
  // Vite fingerprints filenames: index-AbCdEfGh.js — safe to cache forever
  app.use("/assets", express.static(path.join(distPath, "assets"), {
    maxAge: "1y",
    immutable: true,
    etag: false,
  }));

  // ── Fonts → 1 year cache (never change) ──────────────────────────────────
  app.use("/fonts", express.static(path.join(distPath, "fonts"), {
    maxAge: "1y",
    immutable: true,
    etag: false,
  }));

  // ── Icons + manifest → 7 day cache ───────────────────────────────────────
  app.use(express.static(distPath, {
    maxAge: "7d",
    etag: true,
    setHeaders(res, filePath) {
      // index.html and sw.js must never be cached — always fresh
      if (filePath.endsWith("index.html") || filePath.endsWith("sw.js")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  // ── Team photos for recruiting site ─────────────────────────────────────
  const teamPath = path.resolve(__dirname, "..", "public", "team");
  if (fs.existsSync(teamPath)) {
    app.use("/team", express.static(teamPath, { maxAge: "7d", etag: true }));
  }

  // ── Recruiting landing page — join.watsonbrothersgroup.com ───────────────
  // Served at /join and /join.html — redirect /join → /join.html so static middleware serves it
  app.get("/join", (_req, res) => {
    res.redirect(301, "/join.html");
  });

  // Bare join host (/) must serve join.html, not the SPA index (agent login).
  // Host check here works even with stale client JS / missing JoinHostRedirect.
  app.get("/", (req, res, next) => {
    const host = String(req.hostname || req.headers.host || "").toLowerCase().split(":")[0];
    const isJoinHost = host === "join.watsonbrothersgroup.com" || host.startsWith("join.");
    if (!isJoinHost) return next();
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "join.html"));
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
