import { useEffect, useRef } from "react";

/**
 * v14.50 — Pull-to-refresh hook.
 *
 * Attaches touch handlers to the document that trigger a reload / refetch
 * when the user pulls down from the top of the page (scrollY === 0) beyond
 * a small threshold. Only fires once per gesture, and only when the touch
 * starts near the top of the viewport.
 *
 * Usage:
 *   usePullToRefresh(() => queryClient.invalidateQueries());
 *   // or
 *   usePullToRefresh(() => window.location.reload());
 */
export function usePullToRefresh(onRefresh: () => void, threshold = 80) {
  const startYRef = useRef<number | null>(null);
  const triggeredRef = useRef<boolean>(false);

  useEffect(() => {
    function handleTouchStart(e: TouchEvent) {
      // Only start tracking when the page is already scrolled to the top.
      if (window.scrollY > 4) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0]?.clientY ?? null;
      triggeredRef.current = false;
    }

    function handleTouchMove(e: TouchEvent) {
      if (startYRef.current == null || triggeredRef.current) return;
      const currentY = e.touches[0]?.clientY ?? 0;
      const delta = currentY - startYRef.current;
      if (delta >= threshold && window.scrollY <= 4) {
        triggeredRef.current = true;
        try {
          onRefresh();
        } catch (err) {
          console.error("[usePullToRefresh] onRefresh error:", err);
        }
      }
    }

    function handleTouchEnd() {
      startYRef.current = null;
    }

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [onRefresh, threshold]);
}
