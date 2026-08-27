import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, copyFile, mkdir, readdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // ── Post-build: copy static assets that Vite doesn't handle ─────────────
  // join.html — recruiting landing page
  if (existsSync("public/join.html")) {
    await copyFile("public/join.html", "dist/public/join.html");
    console.log("copied public/join.html → dist/public/join.html");
  }

  // join-fast-track.html — /join/fast-track playbook subpage
  if (existsSync("public/join-fast-track.html")) {
    await copyFile("public/join-fast-track.html", "dist/public/join-fast-track.html");
    console.log("copied public/join-fast-track.html → dist/public/join-fast-track.html");
  }

  // apply.html — v19.7 token-based candidate application page (served at /join/:token)
  if (existsSync("public/apply.html")) {
    await copyFile("public/apply.html", "dist/public/apply.html");
    console.log("copied public/apply.html → dist/public/apply.html");
  }

  // ecosystem.html — v20.32.39 master "ecosystem" hub page (served at /ecosystem)
  if (existsSync("public/ecosystem.html")) {
    await copyFile("public/ecosystem.html", "dist/public/ecosystem.html");
    console.log("copied public/ecosystem.html → dist/public/ecosystem.html");
  }

  // home-solutions.html — v20.34.0 BGHS public quote-request app (served at /home-solutions)
  if (existsSync("public/home-solutions.html")) {
    await copyFile("public/home-solutions.html", "dist/public/home-solutions.html");
    console.log("copied public/home-solutions.html → dist/public/home-solutions.html");
  }

  // get-in-touch.html — v20.35.0 per-agent public lead-capture landing page (served at /get-in-touch/:id)
  if (existsSync("public/get-in-touch.html")) {
    await copyFile("public/get-in-touch.html", "dist/public/get-in-touch.html");
    console.log("copied public/get-in-touch.html → dist/public/get-in-touch.html");
  }

  // agent headshots — slug-named jpg files served at /headshots/
  const headshotSrc = "public/headshots";
  const headshotDst = "dist/public/headshots";
  if (existsSync(headshotSrc)) {
    await mkdir(headshotDst, { recursive: true });
    const files = await readdir(headshotSrc);
    for (const f of files) {
      await copyFile(path.join(headshotSrc, f), path.join(headshotDst, f));
    }
    console.log(`copied ${files.length} headshots → dist/public/headshots/`);
  }

  // team photos — recruiting page headshots
  const teamSrc = "public/team";
  const teamDst = "dist/public/team";
  if (existsSync(teamSrc)) {
    await mkdir(teamDst, { recursive: true });
    const files = await readdir(teamSrc);
    for (const f of files) {
      await copyFile(path.join(teamSrc, f), path.join(teamDst, f));
    }
    console.log(`copied ${files.length} team photos → dist/public/team/`);
  }

  // v20.33.3 — BGHS (Brothers Group Home Solutions) brand assets used on the
  // overhauled /ecosystem "Empire" page Home Solutions hub.
  const bghsSrc = "public/bghs";
  const bghsDst = "dist/public/bghs";
  if (existsSync(bghsSrc)) {
    await mkdir(bghsDst, { recursive: true });
    const files = await readdir(bghsSrc);
    for (const f of files) {
      await copyFile(path.join(bghsSrc, f), path.join(bghsDst, f));
    }
    console.log(`copied ${files.length} BGHS brand assets → dist/public/bghs/`);
  }

  // v20.37.4 — Kokoro voice model (server/tts.ts resolves it relative to
  // __dirname, which at runtime is dist/, not server/). Recursive copy since
  // it contains a nested onnx/ subfolder. Kept for a possible future revert
  // even though v20.37.5 no longer imports server/tts.ts by default.
  const kokoroSrc = "server/kokoro-cache";
  const kokoroDst = "dist/kokoro-cache";
  if (existsSync(kokoroSrc)) {
    await cp(kokoroSrc, kokoroDst, { recursive: true });
    console.log("copied Kokoro voice model → dist/kokoro-cache/");
  }

  // v20.37.5 — Piper binary + Amy voice model (server/tts-piper.ts resolves
  // it relative to __dirname, which at runtime is dist/, not server/).
  // This is now the ACTIVE voice engine for Lexi.
  const piperSrc = "server/piper-cache";
  const piperDst = "dist/piper-cache";
  if (existsSync(piperSrc)) {
    await cp(piperSrc, piperDst, { recursive: true });
    console.log("copied Piper voice engine → dist/piper-cache/");
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
