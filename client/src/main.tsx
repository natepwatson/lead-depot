import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);

// Register service worker for PWA install support (v14.21 cache-buster wired)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
  // v14.21 — when the SW activates a new version, it posts SW_UPDATED. Reload once
  // (guarded so we don't loop) so the tab picks up the fresh HTML + hashed JS/CSS.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SW_UPDATED") {
      const KEY = "ld_sw_reload_" + event.data.version;
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, "1");
        // Small delay so the SW finishes its activate promise
        setTimeout(() => window.location.reload(), 300);
      }
    }
  });
}
