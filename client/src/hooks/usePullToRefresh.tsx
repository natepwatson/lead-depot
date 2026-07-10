import { useEffect, useRef, useState } from "react";

/**
 * v14.52 — Pull-to-refresh hook with visible feedback.
 *
 * Attaches touch handlers to the document that trigger a reload / refetch
 * when the user pulls down from the top of the page (scrollY === 0) beyond
 * a small threshold. Renders a gold chevron + text as the user pulls, and a
 * spinning gold ring on the top of the page for ~800ms after the refresh fires
 * so the gesture feels connected to real work.
 *
 * Usage:
 *   const { indicator } = usePullToRefresh(() => queryClient.invalidateQueries());
 *   return (<>{indicator}<YourPage/></>);
 *
 * Returns:
 *   - indicator: a JSX element that renders the pull/refresh chip. Insert at
 *     the top of your page (position:fixed so it floats).
 */
export function usePullToRefresh(onRefresh: () => void, threshold = 80) {
  const startYRef = useRef<number | null>(null);
  const triggeredRef = useRef<boolean>(false);
  const [pulling, setPulling] = useState<number>(0); // 0..1 based on progress toward threshold
  const [refreshing, setRefreshing] = useState<boolean>(false);

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
      if (delta > 12) {
        // Progress toward threshold, capped 0..1 for indicator opacity/size.
        setPulling(Math.min(1, delta / threshold));
      }
      if (delta >= threshold && window.scrollY <= 4) {
        triggeredRef.current = true;
        setPulling(0);
        setRefreshing(true);
        try {
          onRefresh();
        } catch (err) {
          console.error("[usePullToRefresh] onRefresh error:", err);
        }
        // Show the refreshing chip for a short beat so it's visible even when
        // queries resolve from cache immediately.
        setTimeout(() => setRefreshing(false), 900);
      }
    }

    function handleTouchEnd() {
      startYRef.current = null;
      setPulling(0);
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

  // ── Visible indicator: a small floating gold chip that shows either the pull
  // progress (chevron) or the refreshing state (spinner). Uses inline styles so
  // it stays visually consistent with the app's gold accent even outside CSS scope.
  const visible = pulling > 0.05 || refreshing;
  const label = refreshing ? "Refreshing…" : (pulling >= 1 ? "Release to refresh" : "Pull to refresh");
  const indicator = visible ? (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 8 + (refreshing ? 0 : pulling * 12),
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        background: "rgba(0,0,0,0.75)",
        border: "1px solid rgba(200,170,90,0.45)",
        color: "#c8aa5a",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        backdropFilter: "blur(6px)",
        opacity: refreshing ? 1 : pulling,
        transition: "opacity 120ms ease-out, top 120ms ease-out",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 12,
          height: 12,
          borderRadius: "50%",
          border: "2px solid rgba(200,170,90,0.25)",
          borderTopColor: "#c8aa5a",
          animation: refreshing ? "pplx-ptr-spin 0.8s linear infinite" : "none",
          transform: refreshing ? "none" : `rotate(${pulling * 180}deg)`,
        }}
      />
      <span>{label}</span>
      <style>{`@keyframes pplx-ptr-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
    </div>
  ) : null;

  return { indicator, refreshing };
}
