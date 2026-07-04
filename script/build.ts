import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, copyFile, mkdir, readdir } from "node:fs/promises";
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
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
