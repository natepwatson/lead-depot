import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center" style={{ background: "#080808" }}>
      <div style={{
        width: "100%", maxWidth: 420, margin: "0 16px",
        background: "#0f0f0f", border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12, padding: "32px 24px",
      }}>
        <div className="flex items-center gap-3 mb-4">
          <AlertCircle className="h-7 w-7 text-red-400" />
          <h1 style={{ fontSize: "1.3rem", fontWeight: 600, color: "#fff" }}>404 — Not Found</h1>
        </div>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)" }}>
          This page doesn't exist. Head back to the app.
        </p>
      </div>
    </div>
  );
}
