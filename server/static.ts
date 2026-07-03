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
  const isProduction = process.env.NODE_ENV === "production";
  const headshotsPath = isProduction ? "/app/data/headshots" : path.join(distPath, "headshots");
  if (!fs.existsSync(headshotsPath)) fs.mkdirSync(headshotsPath, { recursive: true });
  app.use("/headshots", express.static(headshotsPath, {
    maxAge: 0,
    etag: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  }));

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
  // Served at /join.html and also as the root for the join subdomain
  app.get("/join", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "join.html"));
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
