import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, Save, RotateCcw, Edit3 } from "lucide-react";

// v14.20 — Only two lead types run in production: Expired + Absentee.
// The former distressed / website_lead / fsbo / land / email_outreach scripts have
// been retired to keep the Scripts admin tightly focused on what agents actually dial.
const SCRIPT_TYPES = [
  { key: "expired",   label: "Expired Listing Script",   accentColor: "#fdab43" },
  { key: "absentee",  label: "Absentee Owner Script",    accentColor: "#c8aa5a" },
] as const;

type ScriptKey = typeof SCRIPT_TYPES[number]["key"];

interface ScriptEditorPanelProps {
  leadType: ScriptKey;
  label: string;
  accentColor: string;
}

function ScriptEditorPanel({ leadType, label, accentColor }: ScriptEditorPanelProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useQuery<{ content: string; updatedAt: string }>({
    queryKey: ["/api/scripts", leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${leadType}`).then(r => r.json()),
    staleTime: 30000,
  });

  const saveMutation = useMutation({
    mutationFn: (content: string) =>
      apiRequest("PATCH", `/api/scripts/${leadType}`, { content }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/scripts", leadType] });
      setEditing(false);
      toast({ title: "Script saved", description: `${label} updated successfully.` });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const handleEdit = () => {
    setDraft(data?.content || "");
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setDraft("");
  };

  return (
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
        background: `linear-gradient(to right, rgba(${accentColor === "#c8aa5a" ? "200,170,90" : "255,255,255"},0.04) 0%, transparent 100%)`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ScrollText size={13} style={{ color: accentColor }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: "#fff" }}>{label}</span>
          {data?.updatedAt && (
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }} className="hidden sm:inline">
              Last edited {new Date(data.updatedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                className="gap-1.5 text-xs text-muted-foreground"
                data-testid={`button-cancel-script-${leadType}`}
              >
                <RotateCcw size={12} /> Cancel
              </Button>
              <button
                onClick={() => saveMutation.mutate(draft)}
                disabled={saveMutation.isPending || !draft.trim()}
                data-testid={`button-save-script-${leadType}`}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "6px 14px",
                  background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                  border: "none", borderRadius: 4,
                  fontSize: 11, fontWeight: 600, letterSpacing: "0.1em",
                  color: "#080808", cursor: "pointer",
                  opacity: (saveMutation.isPending || !draft.trim()) ? 0.5 : 1,
                }}
              >
                {saveMutation.isPending ? (
                  <><RotateCcw size={11} className="animate-spin" /> Saving…</>
                ) : (
                  <><Save size={11} /> Save Script</>
                )}
              </button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleEdit}
              className="gap-1.5 text-xs border-border"
              data-testid={`button-edit-script-${leadType}`}
            >
              <Edit3 size={12} /> Edit Script
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: 18 }}>
        {isLoading ? (
          <div className="space-y-2">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-4 rounded" style={{ width: `${70 + Math.random() * 30}%` }} />)}
          </div>
        ) : editing ? (
          <div className="space-y-2">
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
              Edit the script below. Use plain text — blank lines between sections, dashes for dividers. Changes go live immediately on save.
            </p>
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="min-h-[420px] font-mono text-xs leading-relaxed resize-y"
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.8)",
              }}
              data-testid={`textarea-script-${leadType}`}
              autoFocus
            />
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", textAlign: "right" }}>{draft.length.toLocaleString()} characters</p>
          </div>
        ) : (
          <pre style={{
            fontSize: 12, color: "rgba(255,255,255,0.6)",
            whiteSpace: "pre-wrap", lineHeight: 1.7,
            fontFamily: "'DM Mono',monospace",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6, padding: 16,
            maxHeight: 420, overflowY: "auto",
          }}>
            {data?.content || "No script saved yet."}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function ScriptEditor() {
  return (
    <div className="space-y-4">
      <div>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.3rem", fontWeight: 300, color: "#fff",
          display: "flex", alignItems: "center", gap: 8, marginBottom: 4,
        }}>
          <ScrollText size={15} style={{ color: "rgba(200,170,90,0.7)" }} />
          Call Scripts
        </h2>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", letterSpacing: "0.02em" }}>
          Scripts appear on each agent's lead card during calls. Edit anytime — changes go live immediately across all active agent sessions.
        </p>
      </div>
      {SCRIPT_TYPES.map(s => (
        <ScriptEditorPanel key={s.key} leadType={s.key} label={s.label} accentColor={s.accentColor} />
      ))}
    </div>
  );
}
