/**
 * ConfettiCelebration — full-screen confetti burst + Web Audio fanfare (v11.39)
 * Triggered when an Appointment outcome is logged.
 * No external dependencies — pure canvas + Web Audio API.
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

const COLORS = [
  "#c8aa5a", "#a8893a", "#FFD700",
  "#22c55e", "#86efac",
  "#60a5fa", "#fff",
  "#f59e0b",
];

function randomBetween(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function playFanfare() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    const playNote = (freq: number, startTime: number, duration: number, gain = 0.18) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, startTime);
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    // Ascending fanfare — C E G C
    const t = ctx.currentTime;
    playNote(523.25, t + 0.00, 0.25); // C5
    playNote(659.25, t + 0.12, 0.25); // E5
    playNote(783.99, t + 0.24, 0.25); // G5
    playNote(1046.5, t + 0.36, 0.50, 0.22); // C6 — hold longer
    // Harmony chord on the final note
    playNote(783.99, t + 0.36, 0.45, 0.10); // G5 harmony
    playNote(659.25, t + 0.36, 0.45, 0.08); // E5 harmony
  } catch {
    // Web Audio not available — silent fallback
  }
}

export default function ConfettiCelebration({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    playFanfare();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Spawn particles from multiple launch points
    const particles: Particle[] = [];
    const COUNT = 180;
    const launchPoints = [
      { x: canvas.width * 0.2, y: canvas.height * 0.6 },
      { x: canvas.width * 0.5, y: canvas.height * 0.7 },
      { x: canvas.width * 0.8, y: canvas.height * 0.6 },
    ];

    for (let i = 0; i < COUNT; i++) {
      const lp = launchPoints[Math.floor(Math.random() * launchPoints.length)];
      const angle = randomBetween(-Math.PI * 0.9, -Math.PI * 0.1);
      const speed = randomBetween(6, 18);
      particles.push({
        x: lp.x + randomBetween(-30, 30),
        y: lp.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: randomBetween(6, 14),
        rotation: randomBetween(0, Math.PI * 2),
        rotSpeed: randomBetween(-0.15, 0.15),
        shape: ["rect", "rect", "circle", "star"][Math.floor(Math.random() * 4)] as Particle["shape"],
        alpha: 1,
      });
    }

    let frame = 0;
    const TOTAL_FRAMES = 120; // ~2s at 60fps

    function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
      const spikes = 5;
      const outerR = r;
      const innerR = r * 0.45;
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

      const gravity = 0.45;
      const fadeStart = TOTAL_FRAMES * 0.55;

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
  );
}
