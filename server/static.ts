import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Only serve static files for non-API paths
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    express.static(distPath)(req, res, next);
  });

  // Fall through to index.html for non-API routes (SPA routing)
  app.use("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
