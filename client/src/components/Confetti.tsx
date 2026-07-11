/**
 * Confetti — v14.81
 * Lightweight canvas confetti burst used by TutorialFlow Chapter 6's
 * appointment celebration. Gold + white particles, gravity + fade, no deps.
 */
import { useEffect, useRef } from "react";

export default function Confetti({ duration = 2500 }: { duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!; const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
      ctx.scale(dpr, dpr);
    };
    resize();
    const colors = ["#c8aa5a", "#e6d089", "#ffffff", "#f0e2b8"];
    type P = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; c: string; size: number };
    const parts: P[] = Array.from({ length: 80 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 60,
      y: innerHeight / 2,
      vx: (Math.random() - 0.5) * 8,
      vy: -Math.random() * 10 - 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 6 + 4,
    }));
    let raf = 0; const start = performance.now();
    const tick = (t: number) => {
      const elapsed = t - start;
      const alpha = Math.max(0, 1 - elapsed / duration);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts.forEach(p => {
        p.vy += 0.25; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (elapsed < duration) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 200 }} />;
}
