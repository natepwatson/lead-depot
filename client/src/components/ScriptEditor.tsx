import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, Save, RotateCcw, Edit3 } from "lucide-react";

const SCRIPT_TYPES = [
  { key: "expired",      label: "Expired Listing Script",     accentClass: "text-orange-400" },
  { key: "distressed",   label: "Distressed Property Script", accentClass: "text-red-400" },
  { key: "website_lead", label: "Website Lead Script",        accentClass: "text-blue-400" },
  { key: "fsbo",         label: "FSBO Script",                accentClass: "text-violet-400" },
  { key: "land",         label: "Land / Vacant Lot Script",   accentClass: "text-emerald-400" },
] as const;

type ScriptKey = typeof SCRIPT_TYPES[number]["key"];

interface ScriptEditorPanelProps {
  leadType: ScriptKey;
  label: string;
  accentClass: string;
}

function ScriptEditorPanel({ leadType, label, accentClass }: ScriptEditorPanelProps) {
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
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
        <div className="flex items-center gap-2.5">
          <ScrollText size={14} className={accentClass} />
          <span className="text-sm font-semibold text-foreground">{label}</span>
          {data?.updatedAt && (
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Last edited {new Date(data.updatedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(draft)}
                disabled={saveMutation.isPending || !draft.trim()}
                className="gap-1.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid={`button-save-script-${leadType}`}
              >
                {saveMutation.isPending ? (
                  <><RotateCcw size={12} className="animate-spin" /> Saving…</>
                ) : (
                  <><Save size={12} /> Save Script</>
                )}
              </Button>
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
      <div className="p-5">
        {isLoading ? (
          <div className="space-y-2">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-4 rounded" style={{ width: `${70 + Math.random() * 30}%` }} />)}
          </div>
        ) : editing ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Edit the script below. Use plain text — blank lines between sections, dashes for dividers. Changes go live immediately on save.
            </p>
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="min-h-[420px] font-mono text-xs bg-secondary border-border text-foreground/90 leading-relaxed resize-y"
              data-testid={`textarea-script-${leadType}`}
              autoFocus
            />
            <p className="text-xs text-muted-foreground/50 text-right">{draft.length.toLocaleString()} characters</p>
          </div>
        ) : (
          <pre className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed font-mono bg-secondary/40 rounded-lg p-4 border border-border max-h-[420px] overflow-y-auto">
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
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <ScrollText size={14} className="text-primary" /> Call Scripts
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Scripts appear on each agent's lead card during calls. Edit anytime — changes go live immediately across all active agent sessions.
        </p>
      </div>
      {SCRIPT_TYPES.map(s => (
        <ScriptEditorPanel key={s.key} leadType={s.key} label={s.label} accentClass={s.accentClass} />
      ))}
    </div>
  );
}
