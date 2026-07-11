import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { createRequire } from "node:module";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { initWebSocket } from "./ws";
import { createServer } from "node:http";
import cookieParser from "cookie-parser";
import { attachSession } from "./auth";
import { securityHeaders } from "./security";
import { startBackupScheduler } from "./backup";

// v14.81.1 — CRASH OBSERVABILITY. Capture any uncaught exception or unhandled
// rejection to stderr + memory so /api/health can surface it. This is the ONLY
// way to see why the process died when Railway logs aren't accessible from
// the sandbox.
(globalThis as any).__lastFatal = null;
process.on("uncaughtException", (err) => {
  const msg = `[FATAL uncaughtException] ${(err as any)?.message || err}\n${(err as any)?.stack || ""}`;
  console.error(msg);
  (globalThis as any).__lastFatal = { type: "uncaughtException", ts: new Date().toISOString(), message: (err as any)?.message || String(err), stack: (err as any)?.stack || null };
});
process.on("unhandledRejection", (reason: any) => {
  const msg = `[FATAL unhandledRejection] ${reason?.message || reason}\n${reason?.stack || ""}`;
  console.error(msg);
  (globalThis as any).__lastFatal = { type: "unhandledRejection", ts: new Date().toISOString(), message: reason?.message || String(reason), stack: reason?.stack || null };
});
(globalThis as any).__bootTime = new Date().toISOString();
console.log("[boot] v14.81.1 crash observability installed at", (globalThis as any).__bootTime);

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const compression = require("compression");

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── CORS — allow KPI dashboard (hosted on pplx.app/sites) to call the API ──
const CORS_ALLOWED = [
  /\.pplx\.app$/,
  /\.perplexity\.ai$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];
app.use((req: any, res: any, next: any) => {
  const origin = req.headers["origin"] || "";
  if (CORS_ALLOWED.some(re => re.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Id, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// v15.9 SECURITY: HSTS + CSP + nosniff + no-frame + referrer policy on every
// response. Zero-dependency (see server/security.ts).
app.use(securityHeaders);

// Compression first — before ALL routes including API, at level 1 (fast)
app.use(compression({ level: 1, threshold: 1024 }));

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "10mb" }));

// v14.58 — Phase A: parse cookies + attach session (non-blocking).
// Routes that need auth check req.currentAgent themselves via requireSession /
// requireSelfOrAdmin / requireAdmin.
app.use(cookieParser());
app.use(attachSession);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  initWebSocket(httpServer);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      // v15.9 SECURITY: start the backup scheduler AFTER the HTTP server is
      // listening so a boot failure in backup code can't take the whole app
      // down. Hourly on-volume snapshots + daily 05:00 EDT off-volume email.
      try {
        startBackupScheduler();
      } catch (e) {
        console.error("[boot] backup scheduler failed to start:", e);
      }
    },
  );
})();
