/**
 * GrandCelebration — v15.11.48
 *
 * Bigger, longer, gold-only celebration reserved for Keep in Touch outcomes.
 * Everything about this file exists to make KIT feel MORE grandiose than the
 * regular appointment confetti:
 *   - Palette: all-gold + soft white sparks. No blues, no greens.
 *   - Particle count: 320 (vs 180 on ConfettiCelebration).
 *   - Duration: ~3.0s (vs ~2.0s).
 *   - Extra sparkle layer that twinkles slowly across the viewport.
 *   - Radial gold-shimmer sweep across the whole screen.
 *   - Richer 6-note fanfare with sustained chord + upper harmony.
 *
 * Pure canvas + Web Audio, no external dependencies.
 */
import { useEffect, useRef } from "react";

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  color: string;
  size: number;
  rotation: number;
  rotSpeed: number;
  shape: "rect" | "circle" | "star";
  alpha: number;
}

interface Sparkle {
  x: number; y: number;
  size: number;
  phase: number;      // starting phase for twinkle
  speed: number;      // twinkle rate
  born: number;       // frame it appeared
  life: number;       // total frames it lives
  color: string;
}

const GOLD_COLORS = [
  "#c8aa5a", // brand gold
  "#a8893a", // deep gold
  "#FFD700", // pure gold
  "#e5c66a", // light gold
  "#f4d47c", // pale gold
  "#fff8dc", // cornsilk (white-ish shimmer)
  "#ffffff", // pure white spark
];

function randomBetween(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function playGrandFanfare() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    const playNote = (freq: number, startTime: number, duration: number, gain = 0.16, type: OscillatorType = "triangle") => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.03);
      gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const t = ctx.currentTime;
    // Ascending 6-note run: C E G C E G, then a sustained C-E-G-C chord.
    playNote(523.25, t + 0.00, 0.20);           // C5
    playNote(659.25, t + 0.10, 0.20);           // E5
    playNote(783.99, t + 0.20, 0.20);           // G5
    playNote(1046.5, t + 0.30, 0.28);           // C6
    playNote(1318.5, t + 0.42, 0.28);           // E6
    playNote(1568.0, t + 0.54, 0.35);           // G6

    // Sustained gold chord under the run (soft strings feel)
    playNote(523.25, t + 0.66, 1.20, 0.10);     // C5
    playNote(659.25, t + 0.66, 1.20, 0.08);     // E5
    playNote(783.99, t + 0.66, 1.20, 0.08);     // G5
    playNote(1046.5, t + 0.66, 1.20, 0.12);     // C6 top

    // A whisper of high sparkle
    playNote(2093.0, t + 0.70, 0.60, 0.05, "sine"); // C7
    playNote(2637.0, t + 0.85, 0.60, 0.04, "sine"); // E7
  } catch {
    // Web Audio unavailable — silent fallback
  }
}

export default function GrandCelebration({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    playGrandFanfare();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Larger burst count, spawned from 4 launch points across the viewport.
    const particles: Particle[] = [];
    const COUNT = 320;
    const launchPoints = [
      { x: canvas.width * 0.12, y: canvas.height * 0.62 },
      { x: canvas.width * 0.35, y: canvas.height * 0.70 },
      { x: canvas.width * 0.65, y: canvas.height * 0.70 },
      { x: canvas.width * 0.88, y: canvas.height * 0.62 },
    ];

    for (let i = 0; i < COUNT; i++) {
      const lp = launchPoints[Math.floor(Math.random() * launchPoints.length)];
      const angle = randomBetween(-Math.PI * 0.92, -Math.PI * 0.08);
      const speed = randomBetween(7, 20);
      particles.push({
        x: lp.x + randomBetween(-30, 30),
        y: lp.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: GOLD_COLORS[Math.floor(Math.random() * GOLD_COLORS.length)],
        size: randomBetween(6, 16),
        rotation: randomBetween(0, Math.PI * 2),
        rotSpeed: randomBetween(-0.18, 0.18),
        shape: ["rect", "rect", "circle", "star", "star"][Math.floor(Math.random() * 5)] as Particle["shape"],
        alpha: 1,
      });
    }

    // Slow sparkle layer — small twinkling dots spread across whole viewport.
    // Continuously respawn while animation runs.
    const sparkles: Sparkle[] = [];
    const SPARKLE_TARGET = 90;

    const spawnSparkle = (bornFrame: number) => {
      sparkles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height * 0.85,
        size: randomBetween(1.4, 3.2),
        phase: Math.random() * Math.PI * 2,
        speed: randomBetween(0.06, 0.14),
        born: bornFrame,
        life: Math.floor(randomBetween(40, 90)),
        color: GOLD_COLORS[Math.floor(Math.random() * 4)], // gold shades only for sparkles
      });
    };

    let frame = 0;
    const TOTAL_FRAMES = 180; // ~3.0s at 60fps

    // Prime the field with initial sparkles so they show immediately.
    for (let i = 0; i < 40; i++) spawnSparkle(0);

    function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
      const spikes = 5;
      const outerR = r;
      const innerR = r * 0.42;
      let rot = (Math.PI / 2) * 3;
      const step = Math.PI / spikes;
      ctx.beginPath();
      ctx.moveTo(cx, cy - outerR);
      for (let i = 0; i < spikes; i++) {
        ctx.lineTo(cx + Math.cos(rot) * outerR, cy - Math.sin(rot) * outerR);
        rot += step;
        ctx.lineTo(cx + Math.cos(rot) * innerR, cy - Math.sin(rot) * innerR);
        rot += step;
      }
      ctx.lineTo(cx, cy - outerR);
      ctx.closePath();
      ctx.fill();
    }

    function animate() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);

      const gravity = 0.42;
      const fadeStart = TOTAL_FRAMES * 0.60;

      // ── Sparkle layer (drawn UNDER particles) ─────────────────────────
      // Respawn to keep target density.
      while (sparkles.length < SPARKLE_TARGET && frame < TOTAL_FRAMES - 30) {
        spawnSparkle(frame);
      }
      for (let i = sparkles.length - 1; i >= 0; i--) {
        const s = sparkles[i];
        const age = frame - s.born;
        if (age > s.life) { sparkles.splice(i, 1); continue; }
        // 0 → 1 → 0 alpha over life.
        const t = age / s.life;
        const alpha = Math.sin(t * Math.PI) * (0.5 + 0.5 * Math.sin(s.phase + age * s.speed));
        if (alpha > 0.02) {
          ctx!.save();
          ctx!.globalAlpha = Math.min(1, alpha);
          ctx!.fillStyle = s.color;
          ctx!.shadowBlur = 8;
          ctx!.shadowColor = s.color;
          ctx!.beginPath();
          ctx!.arc(s.x, s.y, s.size, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.restore();
        }
      }

      // ── Confetti particles ────────────────────────────────────────────
      for (const p of particles) {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        p.vx *= 0.99;

        if (frame > fadeStart) {
          p.alpha = Math.max(0, 1 - (frame - fadeStart) / (TOTAL_FRAMES - fadeStart));
        }

        ctx!.save();
        ctx!.globalAlpha = p.alpha;
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.rotation);
        ctx!.fillStyle = p.color;

        if (p.shape === "circle") {
          ctx!.beginPath();
          ctx!.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx!.fill();
        } else if (p.shape === "star") {
          // Extra glow on stars — they're the "lights".
          ctx!.shadowBlur = 12;
          ctx!.shadowColor = p.color;
          drawStar(ctx!, 0, 0, p.size / 2);
        } else {
          ctx!.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx!.restore();
      }

      frame++;
      if (frame < TOTAL_FRAMES) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        onDone();
      }
    }

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [onDone]);

  return (
    <>
      {/* Radial gold shimmer overlay — fades in, then out over ~3s */}
      <div
        ref={overlayRef}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9998,
          pointerEvents: "none",
          background:
            "radial-gradient(circle at 50% 55%, rgba(255,215,0,0.22) 0%, rgba(200,170,90,0.16) 22%, rgba(200,170,90,0.06) 45%, transparent 70%)",
          animation: "ldGrandShimmer 3.0s ease-out forwards",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          pointerEvents: "none",
          width: "100dvw",
          height: "100dvh",
        }}
      />
      {/* Keyframes injected inline so this component is self-contained */}
      <style>{`
        @keyframes ldGrandShimmer {
          0%   { opacity: 0; }
          15%  { opacity: 1; }
          70%  { opacity: 0.9; }
          100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
