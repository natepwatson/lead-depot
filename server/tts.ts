// server/tts.ts
// v20.37.5 — Kokoro-JS TTS engine for Lexi's voice.
//
// Runs 100% locally via kokoro-js (Node-native, no Python subprocess). The
// quantized ONNX model + tokenizer files are committed to server/kokoro-cache/
// so Railway never needs network access to Hugging Face at build or runtime —
// same "commit the binary, don't depend on a live download" pattern used for
// agent headshots and the self-hosted fonts.
//
// The model is loaded once as a module-level singleton at server startup
// (load takes ~2-3s) so the first real request doesn't pay that cost.
import path from "node:path";

// __dirname is a genuine CJS global in the production bundle (esbuild --format=cjs)
// and is polyfilled by tsx in dev, matching the pattern already used in
// server/db.ts and server/routes.ts — avoids the "import.meta is empty in cjs
// output" esbuild warning/footgun.
const CACHE_DIR = path.join(__dirname, "kokoro-cache");
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";
// Faster-than-default speaking cadence per Alex's explicit request (v20.37.5).
// Kokoro's default speed is 1.0; 1.15 is a noticeable-but-natural bump.
const SPEED = 1.15;

let ttsPromise: Promise<any> | null = null;

async function loadTTS(): Promise<any> {
  // @huggingface/transformers ships as an optional peer of kokoro-js; import
  // it directly so we can force local-only model loading before kokoro-js
  // touches the network.
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = false; // never hit the network — model is committed to the repo
  env.allowLocalModels = true;

  const { KokoroTTS } = await import("kokoro-js");
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: "q8",
    device: "cpu",
  });
}

function getTTS(): Promise<any> {
  if (!ttsPromise) ttsPromise = loadTTS();
  return ttsPromise;
}

// Kick off model load immediately at server startup (fire-and-forget) so it's
// warm before Lexi's first spoken reply of the day.
getTTS()
  .then(() => console.log("[TTS] Kokoro voice model warmed up."))
  .catch((err) => console.error("[TTS] Kokoro warm-up load failed:", err?.message));

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
 * Generates spoken audio for the given text using the Kokoro voice model.
 * Returns a WAV file as a Buffer, ready to send with content-type audio/wav.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const clean = cleanForSpeech(text);
  if (!clean) throw new Error("Empty text after cleanup — nothing to speak.");

  const tts = await getTTS();
  const audio = await tts.generate(clean, { voice: VOICE, speed: SPEED });
  const wavArrayBuffer: ArrayBuffer = audio.toWav();
  return Buffer.from(wavArrayBuffer);
}
