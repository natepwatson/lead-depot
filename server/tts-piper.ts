// server/tts-piper.ts
// ACTIVE ENGINE (v20.37.5+) — Lexi's voice. Alex reverted from Kokoro back to
// Piper Amy on Aug 27, 2026: Kokoro's ~3-10s generation window was a real
// factor in dropped/broken-up voice turns (especially over a moving
// vehicle's cellular connection), and Piper's near-instant generation
// removes most of that failure window. Piper Amy (medium) was Alex's top
// pick among the three Piper voices he A/B tested. Speed bumped to 1.35x
// per Alex's request.
//
// Sandbox speed test on the same sentence used for the Kokoro production
// test: Piper Amy ~0.9s total (binary spawn + phonemize + infer) vs
// Kokoro's ~9.7s live — roughly 10x faster. Trade-off: Piper is a
// lighter/thinner-sounding voice than Kokoro.
import { spawn } from "node:child_process";
import path from "node:path";

const BIN_DIR = path.join(__dirname, "piper-cache", "bin");
const VOICE_DIR = path.join(__dirname, "piper-cache", "voices");
const PIPER_BIN = path.join(BIN_DIR, "piper");
const MODEL_PATH = path.join(VOICE_DIR, "en_US-amy-medium.onnx");
const CONFIG_PATH = path.join(VOICE_DIR, "en_US-amy-medium.onnx.json");

// Piper's --length_scale is inverse of speed (lower = faster speech).
// 0.74 ≈ 1 / 1.35 — Alex's requested 1.35x speed bump (v20.37.5).
const LENGTH_SCALE = "0.74";

/** Strips markdown/formatting so the model doesn't try to "read" symbols aloud. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generates spoken audio for the given text using the Piper Amy voice model.
 * Returns a WAV file as a Buffer, ready to send with content-type audio/wav.
 * Spawns the self-contained piper binary (native ELF + bundled shared libs,
 * committed at server/piper-cache/) — no npm package, no network call.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const clean = cleanForSpeech(text);
  if (!clean) throw new Error("Empty text after cleanup — nothing to speak.");

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      PIPER_BIN,
      ["-m", MODEL_PATH, "-c", CONFIG_PATH, "--length_scale", LENGTH_SCALE, "-f", "-"],
      {
        env: { ...process.env, LD_LIBRARY_PATH: BIN_DIR },
      }
    );

    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => reject(new Error(`piper spawn failed: ${err.message}`)));

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`piper exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.write(clean);
    child.stdin.end();
  });
}
