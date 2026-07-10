// v14.80 — Opt-in sound effects. Silent by default. Respects device mute switch on iOS.
const KEY = "ld_sounds_enabled";

export function soundsEnabled(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setSoundsEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {}
}

const cache: Record<string, HTMLAudioElement> = {};
function get(name: string): HTMLAudioElement {
  if (!cache[name]) {
    const a = new Audio(`/sounds/${name}.mp3`);
    a.preload = "auto";
    a.volume = name === "tick" ? 0.4 : 0.55;
    cache[name] = a;
  }
  return cache[name];
}

export function playSound(name: "chime" | "tick" | "lift") {
  if (!soundsEnabled()) return;
  try {
    const a = get(name);
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {}
}
