import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, Lock } from "lucide-react";

// v15.11.40 — LOCKDOWN.
// Only the Expired Listing Script exists in the app. It is READ-ONLY here.
// The former Absentee + email-flow surfaces have been removed from this admin view.
// Script content can only ever be Alex-authored — no AI-generated defaults allowed.
// See server/expired-script.ts (canonical human-written source) and server/routes.ts
// where PATCH /api/scripts/expired is locked behind INGEST_SECRET.

export default function ScriptEditor() {
  const { data, isLoading } = useQuery<{ content: string; updatedAt: string }>({
    queryKey: ["/api/scripts", "expired"],
    queryFn: () => apiRequest("GET", `/api/scripts/expired`).then(r => r.json()),
    staleTime: 30000,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{
        background: "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10, overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          background: "linear-gradient(to right, rgba(253,171,67,0.04) 0%, transparent 100%)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ScrollText size={13} style={{ color: "#fdab43" }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "#fff" }}>Expired Listing Script</span>
            {data?.updatedAt && (
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }} className="hidden sm:inline">
                Last edited {new Date(data.updatedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 10, color: "rgba(255,255,255,0.4)",
            padding: "3px 8px",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 4,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}>
            <Lock size={10} /> Read-only
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 18 }}>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <pre style={{
              margin: 0,
              padding: "14px 16px",
              background: "#050505",
              border: "1px solid rgba(255,255,255,0.05)",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.6,
              color: "rgba(255,255,255,0.85)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
              maxHeight: "70vh",
              overflow: "auto",
            }}>{data?.content || ""}</pre>
          )}
          <p style={{
            marginTop: 12,
            fontSize: 11,
            color: "rgba(255,255,255,0.35)",
            lineHeight: 1.5,
          }}>
            This script is locked and human-authored. To change it, edit
            <code style={{ margin: "0 4px", color: "rgba(255,255,255,0.6)" }}>server/expired-script.ts</code>
            and deploy — the app is prohibited from generating or defaulting to any
            AI-written script.
          </p>
        </div>
      </div>
    </div>
  );
}
