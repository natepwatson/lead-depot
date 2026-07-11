/**
 * CandidatesTab — v15.5 Admin Candidates management
 *
 * Flow:
 *   1. Admin picks entry path (7 options)
 *   2. Admin picks delivery mode (4 options)
 *   3. Submit → /api/candidates/invite → handle response
 *      - show_qr: opens QR modal (person scans on their phone)
 *      - text: opens sms: deep link on admin's phone
 *      - email: confirms email sent
 *      - create_only: just confirms candidate exists in Lead Depot + FUB
 *
 * Below the invite button: sortable/filterable candidate list
 */
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, QrCode, MessageSquare, Mail, Clock, AlertCircle, CheckCircle2, Copy, Send, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface EntryPath {
  key: string;
  label: string;
  temperature: "nurture" | "hot_prospect" | "vendor";
  fubStage: string;
  tags: string[];
}

interface Candidate {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  entryPath: string;
  temperature: string;
  fubStage: string;
  status: string;
  deliveryMode?: string;
  fubPersonId?: number | null;
  fubSyncedAt?: string | null;
  createdAt?: string;
  firstOpenedAt?: string | null;
  applicationUrl?: string | null;
  tokenExpiresAt?: string | null;
}

interface DeliveryResult {
  mode: string;
  qrDataUrl?: string;
  shortUrl?: string;
  smsLink?: string;
  smsBody?: string;
  emailSent?: boolean;
  emailError?: string;
}

const TEMP_COLOR: Record<string, string> = {
  nurture: "#8a8478",
  hot_prospect: "#c8aa5a",
  vendor: "#5ec27c",
};

const STATUS_COLOR: Record<string, string> = {
  invited: "#c8aa5a",
  started: "#5ec27c",
  submitted: "#5ec27c",
  approved: "#5ec27c",
  active: "#5ec27c",
  ghosted: "#8a8478",
  expired: "#8a8478",
  declined: "#e07272",
};

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CandidatesTab() {
  const { toast } = useToast();

  const [paths, setPaths] = useState<EntryPath[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [entryPath, setEntryPath] = useState<string>("");
  const [deliveryMode, setDeliveryMode] = useState<"show_qr" | "text" | "email" | "create_only">("show_qr");
  const [submitting, setSubmitting] = useState(false);

  const [dupWarn, setDupWarn] = useState<any>(null);
  const [deliveryModal, setDeliveryModal] = useState<{ candidate: Candidate; delivery: DeliveryResult } | null>(null);
  const [detailModal, setDetailModal] = useState<Candidate | null>(null);

  // Load entry paths once
  useEffect(() => {
    (async () => {
      try {
        const r = await apiRequest("GET", "/api/candidates/entry-paths");
        const j = await r.json();
        setPaths(j.paths || []);
        if (j.paths?.[0]) setEntryPath(j.paths[0].key);
      } catch (e) {
        console.error("Failed to load entry paths", e);
      }
    })();
  }, []);

  const refreshList = async () => {
    setLoadingList(true);
    try {
      const r = await apiRequest("GET", `/api/candidates/list?status=${statusFilter}`);
      const j = await r.json();
      setCandidates(j.candidates || []);
    } catch (e) {
      console.error("Failed to load candidates", e);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const resetInviteForm = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setDupWarn(null);
    if (paths[0]) setEntryPath(paths[0].key);
    setDeliveryMode("show_qr");
  };

  const submitInvite = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: "Name required", description: "First and last name are required.", variant: "destructive" });
      return;
    }
    if (!email.trim() && !phone.trim()) {
      toast({ title: "Contact required", description: "Email or phone is required.", variant: "destructive" });
      return;
    }
    if (!entryPath) {
      toast({ title: "Entry path required", description: "Pick the entry path.", variant: "destructive" });
      return;
    }
    if (deliveryMode === "email" && !email.trim()) {
      toast({ title: "Email required for email delivery", variant: "destructive" });
      return;
    }
    if (deliveryMode === "text" && !phone.trim()) {
      toast({ title: "Phone required for text delivery", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    setDupWarn(null);
    try {
      const r = await apiRequest("POST", "/api/candidates/invite", {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        entryPath,
        deliveryMode,
      });
      if (r.status === 409) {
        const j = await r.json();
        setDupWarn(j.existing);
        setSubmitting(false);
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = await r.json();

      toast({
        title: "Candidate invited",
        description: `${j.candidate.firstName} ${j.candidate.lastName} → ${j.candidate.fubStage}${j.fubPersonId ? ` · FUB #${j.fubPersonId}` : " · FUB skipped"}`,
      });

      setDeliveryModal({ candidate: j.candidate, delivery: j.delivery });
      setInviteOpen(false);
      resetInviteForm();
      await refreshList();
    } catch (err: any) {
      toast({ title: "Invite failed", description: err.message || String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const copyToClipboard = async (text: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: label });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const selectedPath = paths.find(p => p.key === entryPath);

  return (
    <div className="mt-5" style={{ color: "#fff", fontFamily: "'Switzer','Inter',sans-serif" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 20,
        padding: 14, background: "rgba(200,170,90,0.04)",
        border: "1px solid rgba(200,170,90,0.15)", borderRadius: 10,
      }}>
        <Button
          onClick={() => { resetInviteForm(); setInviteOpen(true); }}
          style={{ background: "#c8aa5a", color: "#0d0b08", fontWeight: 600 }}
        >
          <UserPlus size={16} className="mr-2" />
          Invite Candidate
        </Button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <Label style={{ fontSize: 12, color: "#8a8478" }}>Status:</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger style={{ width: 160 }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="invited">Invited</SelectItem>
              <SelectItem value="started">Started</SelectItem>
              <SelectItem value="submitted">Submitted</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
              <SelectItem value="ghosted">Ghosted</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Candidate list */}
      {loadingList ? (
        <div style={{ opacity: 0.6, padding: 20, textAlign: "center" }}>Loading candidates…</div>
      ) : candidates.length === 0 ? (
        <div style={{ opacity: 0.6, padding: 40, textAlign: "center", border: "1px dashed rgba(200,170,90,0.2)", borderRadius: 10 }}>
          No candidates yet. Click Invite Candidate above to start.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {candidates.map(c => (
            <button
              key={c.id}
              onClick={() => setDetailModal(c)}
              style={{
                textAlign: "left",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(200,170,90,0.12)",
                borderRadius: 10,
                padding: "14px 16px",
                cursor: "pointer",
                color: "#fff",
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                gap: 12,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>
                  {c.firstName} {c.lastName}
                </div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  {c.email || c.phone || "—"} · {paths.find(p => p.key === c.entryPath)?.label || c.entryPath}
                </div>
              </div>
              <span style={{
                fontSize: 11, padding: "3px 8px", borderRadius: 999,
                background: `${TEMP_COLOR[c.temperature] || "#8a8478"}22`,
                color: TEMP_COLOR[c.temperature] || "#8a8478",
                textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 500,
              }}>
                {c.temperature.replace("_", " ")}
              </span>
              <span style={{
                fontSize: 11, padding: "3px 8px", borderRadius: 999,
                background: `${STATUS_COLOR[c.status] || "#8a8478"}22`,
                color: STATUS_COLOR[c.status] || "#8a8478",
                textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 500,
              }}>
                {c.status}
              </span>
              <div style={{ fontSize: 11, opacity: 0.55, minWidth: 70, textAlign: "right" }}>
                {timeAgo(c.createdAt)}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* INVITE DIALOG */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent style={{ maxWidth: 560 }}>
          <DialogHeader>
            <DialogTitle>Invite Candidate</DialogTitle>
          </DialogHeader>

          <div style={{ display: "grid", gap: 14, marginTop: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>First name *</Label>
                <Input value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus />
              </div>
              <div>
                <Label>Last name *</Label>
                <Input value={lastName} onChange={e => setLastName(e.target.value)} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>Email</Label>
                <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="required for email delivery" />
              </div>
              <div>
                <Label>Phone</Label>
                <Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="required for text delivery" />
              </div>
            </div>

            <div>
              <Label>Entry path *</Label>
              <Select value={entryPath} onValueChange={setEntryPath}>
                <SelectTrigger>
                  <SelectValue placeholder="How did they get here?" />
                </SelectTrigger>
                <SelectContent>
                  {paths.map(p => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label} → {p.fubStage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPath && (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
                  Temperature: <span style={{ color: TEMP_COLOR[selectedPath.temperature], fontWeight: 500 }}>{selectedPath.temperature.replace("_", " ")}</span>
                  {" · "}FUB tags: {selectedPath.tags.join(", ")}
                </div>
              )}
            </div>

            <div>
              <Label>How to deliver the link *</Label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
                {[
                  { key: "show_qr", label: "Show on my phone", icon: QrCode, help: "QR code to scan" },
                  { key: "text", label: "Text link", icon: MessageSquare, help: "sms: deep link" },
                  { key: "email", label: "Email link", icon: Mail, help: "sends now" },
                  { key: "create_only", label: "Create only", icon: User, help: "no delivery" },
                ].map(opt => {
                  const active = deliveryMode === opt.key;
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setDeliveryMode(opt.key as any)}
                      type="button"
                      style={{
                        padding: "12px",
                        borderRadius: 8,
                        border: `1px solid ${active ? "#c8aa5a" : "rgba(200,170,90,0.2)"}`,
                        background: active ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.03)",
                        color: active ? "#c8aa5a" : "#fff",
                        cursor: "pointer",
                        textAlign: "left",
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <Icon size={18} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</div>
                        <div style={{ fontSize: 11, opacity: 0.6 }}>{opt.help}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {dupWarn && (
              <div style={{
                padding: 12, background: "rgba(224,114,114,0.1)",
                border: "1px solid #e07272", borderRadius: 8, fontSize: 13,
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <AlertCircle size={14} color="#e07272" />
                  <strong>Already in the system</strong>
                </div>
                {dupWarn.firstName} {dupWarn.lastName} ({dupWarn.email || dupWarn.phone}) is already a candidate with status <strong>{dupWarn.status}</strong>. Reach out through their existing candidate record.
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
              <Button variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button
                onClick={submitInvite}
                disabled={submitting}
                style={{ background: "#c8aa5a", color: "#0d0b08" }}
              >
                {submitting ? "Sending…" : "Invite"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* DELIVERY RESULT MODAL */}
      <Dialog open={!!deliveryModal} onOpenChange={(open) => !open && setDeliveryModal(null)}>
        <DialogContent style={{ maxWidth: 480 }}>
          <DialogHeader>
            <DialogTitle>
              {deliveryModal?.delivery.mode === "show_qr" && "Show this to them"}
              {deliveryModal?.delivery.mode === "text" && "Text the link"}
              {deliveryModal?.delivery.mode === "email" && "Email sent"}
              {deliveryModal?.delivery.mode === "create_only" && "Candidate created"}
            </DialogTitle>
          </DialogHeader>

          {deliveryModal && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 16 }}>
                {deliveryModal.candidate.firstName} {deliveryModal.candidate.lastName} → {deliveryModal.candidate.fubStage}
              </div>

              {deliveryModal.delivery.mode === "show_qr" && deliveryModal.delivery.qrDataUrl && (
                <div style={{ textAlign: "center" }}>
                  <img
                    src={deliveryModal.delivery.qrDataUrl}
                    alt="Application QR code"
                    style={{ width: 260, height: 260, margin: "0 auto", background: "#fff", padding: 12, borderRadius: 12 }}
                  />
                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6, wordBreak: "break-all" }}>
                    {deliveryModal.delivery.shortUrl}
                  </div>
                  <Button
                    variant="ghost"
                    style={{ marginTop: 10 }}
                    onClick={() => copyToClipboard(deliveryModal.delivery.shortUrl || "", "Link copied")}
                  >
                    <Copy size={14} className="mr-2" /> Copy link
                  </Button>
                </div>
              )}

              {deliveryModal.delivery.mode === "text" && deliveryModal.delivery.smsLink && (
                <div>
                  <p style={{ fontSize: 13, marginBottom: 12, opacity: 0.85 }}>
                    Tap below to open Messages with the number and body prefilled:
                  </p>
                  <a
                    href={deliveryModal.delivery.smsLink}
                    style={{
                      display: "block", padding: "14px", background: "#c8aa5a", color: "#0d0b08",
                      borderRadius: 8, textAlign: "center", fontWeight: 600, textDecoration: "none",
                    }}
                  >
                    <Send size={14} style={{ display: "inline", marginRight: 6 }} />
                    Open Messages
                  </a>
                  <div style={{ marginTop: 12, padding: 10, background: "rgba(255,255,255,0.04)", borderRadius: 6, fontSize: 12, opacity: 0.75 }}>
                    <strong>Preview:</strong><br />
                    {deliveryModal.delivery.smsBody}
                  </div>
                </div>
              )}

              {deliveryModal.delivery.mode === "email" && (
                <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 14, background: "rgba(94,194,124,0.1)", border: "1px solid #5ec27c", borderRadius: 8 }}>
                  <CheckCircle2 size={18} color="#5ec27c" />
                  <div style={{ fontSize: 14 }}>
                    {deliveryModal.delivery.emailSent
                      ? `Invitation email sent to ${deliveryModal.candidate.email}`
                      : `Email delivery failed: ${deliveryModal.delivery.emailError || "unknown error"}`}
                  </div>
                </div>
              )}

              {deliveryModal.delivery.mode === "create_only" && (
                <div style={{ padding: 14, background: "rgba(94,194,124,0.1)", border: "1px solid #5ec27c", borderRadius: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <CheckCircle2 size={18} color="#5ec27c" />
                    <div style={{ fontSize: 14 }}>Candidate created in Lead Depot and pushed to FUB. No link sent.</div>
                  </div>
                  {deliveryModal.candidate.applicationUrl && (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7, wordBreak: "break-all" }}>
                      Link if you need it later: {deliveryModal.candidate.applicationUrl}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* CANDIDATE DETAIL MODAL */}
      <Dialog open={!!detailModal} onOpenChange={(open) => !open && setDetailModal(null)}>
        <DialogContent style={{ maxWidth: 520 }}>
          <DialogHeader>
            <DialogTitle>{detailModal?.firstName} {detailModal?.lastName}</DialogTitle>
          </DialogHeader>
          {detailModal && (
            <div style={{ display: "grid", gap: 10, marginTop: 12, fontSize: 13 }}>
              <Row label="Status" value={<span style={{ color: STATUS_COLOR[detailModal.status] || "#8a8478", textTransform: "uppercase" }}>{detailModal.status}</span>} />
              <Row label="Entry path" value={paths.find(p => p.key === detailModal.entryPath)?.label || detailModal.entryPath} />
              <Row label="Temperature" value={<span style={{ color: TEMP_COLOR[detailModal.temperature] }}>{detailModal.temperature.replace("_", " ")}</span>} />
              <Row label="FUB stage" value={detailModal.fubStage} />
              <Row label="FUB person" value={detailModal.fubPersonId ? `#${detailModal.fubPersonId}` : "not synced"} />
              <Row label="Email" value={detailModal.email || "—"} />
              <Row label="Phone" value={detailModal.phone || "—"} />
              <Row label="Delivery mode" value={detailModal.deliveryMode || "—"} />
              <Row label="Invited" value={timeAgo(detailModal.createdAt)} />
              <Row label="First opened" value={timeAgo(detailModal.firstOpenedAt)} />
              <Row label="Token expires" value={detailModal.tokenExpiresAt ? new Date(detailModal.tokenExpiresAt).toLocaleDateString() : "—"} />
              {detailModal.applicationUrl && (
                <div style={{ marginTop: 8, padding: 10, background: "rgba(200,170,90,0.06)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Application link</div>
                  <div style={{ fontSize: 12, wordBreak: "break-all" }}>{detailModal.applicationUrl}</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ marginTop: 8 }}
                    onClick={() => copyToClipboard(detailModal.applicationUrl || "", "Link copied")}
                  >
                    <Copy size={12} className="mr-1" /> Copy
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, padding: "6px 0", borderBottom: "1px solid rgba(200,170,90,0.08)" }}>
      <div style={{ opacity: 0.6, fontSize: 12 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
