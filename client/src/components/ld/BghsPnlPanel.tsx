// v20.34.0 — BGHS (Brothers Group Home Solutions) Profit & Loss Center.
// Revenue pulled live from repair_consults / payment_records (the existing
// repair engine — no parallel pricing logic). Vendor-quoted line items carry
// their own known cost (vendor_quote_amount) and are folded in automatically.
// Manual expense ledger below covers everything the app doesn't already
// track: materials, in-house labor, fuel, tools, insurance, marketing,
// overhead. Scope note: this is the repair/touch-up program only —
// Inspections+ is a separate product line and is not included here.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, DollarSign, TrendingUp, TrendingDown, Plus, Trash2, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";

const GOLD = "#c8aa5a";

type Job = { id: number; property_address: string; status: string; total: number; created_at: string };

type PerJobRow = {
  consultId: number;
  propertyAddress: string;
  agentName: string | null;
  status: string;
  referenceDate: string | null;
  contractTotal: number;
  collected: number;
  vendorCost: number;
  expenses: number;
  profit: number;
  marginPct: number | null;
};

type PnlResponse = {
  range: { from: string | null; to: string | null };
  revenueCollected: number;
  revenueContracted: number;
  vendorCostTotal: number;
  expensesTotal: number;
  expensesByCategory: Record<string, number>;
  grossProfit: number;
  grossMarginPct: number | null;
  jobCount: number;
  perJob: PerJobRow[];
};

type Expense = {
  id: number;
  consult_id: number | null;
  category: string;
  description: string;
  amount: number;
  vendor_name: string | null;
  expense_date: string;
  property_address: string | null;
  recorded_by_name: string | null;
  notes: string | null;
};

const CATEGORY_LABELS: Record<string, string> = {
  materials: "Materials", labor: "Labor", equipment: "Equipment", fuel: "Fuel",
  insurance: "Insurance", marketing: "Marketing", tools: "Tools", overhead: "Overhead", other: "Other",
};
const CATEGORY_OPTIONS = Object.keys(CATEGORY_LABELS);

const money = (n: number) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const pct = (n: number | null) => n === null ? "—" : `${n.toFixed(1)}%`;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
function firstOfYear() { return `${new Date().getFullYear()}-01-01`; }
function firstOfLastMonth() { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
function lastOfLastMonth() { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 10); }
function firstOfQuarter() { const d = new Date(); const qm = Math.floor(d.getMonth() / 3) * 3; return `${d.getFullYear()}-${String(qm + 1).padStart(2, "0")}-01`; }

const cardStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, background: "rgba(255,255,255,0.02)",
};
const inputStyle: CSSProperties = {
  padding: "6px 9px", borderRadius: 6, background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.14)", color: "#e5e7eb", fontSize: 12,
};
const actionBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 6,
  fontSize: 11, fontWeight: 600, background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#c7d1dd", cursor: "pointer",
};

export function BghsPnlPanel() {
  const [range, setRange] = useState<"this_month" | "last_month" | "this_quarter" | "ytd" | "all_time" | "custom">("this_month");
  const [customFrom, setCustomFrom] = useState(firstOfMonth());
  const [customTo, setCustomTo] = useState(todayStr());
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showJobBreakdown, setShowJobBreakdown] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    category: "materials", description: "", amount: "", vendorName: "",
    expenseDate: todayStr(), consultId: "", notes: "",
  });

  function computeRange(): { from: string | null; to: string | null } {
    switch (range) {
      case "this_month": return { from: firstOfMonth(), to: todayStr() };
      case "last_month": return { from: firstOfLastMonth(), to: lastOfLastMonth() };
      case "this_quarter": return { from: firstOfQuarter(), to: todayStr() };
      case "ytd": return { from: firstOfYear(), to: todayStr() };
      case "all_time": return { from: null, to: null };
      case "custom": return { from: customFrom, to: customTo };
    }
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = computeRange();
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const [pnlRes, expRes, jobsRes] = await Promise.all([
        fetch(`/api/admin/bghs/pnl?${qs.toString()}`, { credentials: "include" }),
        fetch(`/api/admin/bghs/expenses?${qs.toString()}`, { credentials: "include" }),
        fetch(`/api/admin/bghs/jobs-for-expense`, { credentials: "include" }),
      ]);
      if (!pnlRes.ok) throw new Error("Failed to load P&L");
      setPnl(await pnlRes.json());
      const expData = await expRes.json();
      setExpenses(expData.expenses || []);
      const jobsData = await jobsRes.json();
      setJobs(jobsData.jobs || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load BGHS P&L");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [range, customFrom, customTo]);

  async function submitExpense() {
    setError(null);
    const amt = parseFloat(form.amount);
    if (!form.description.trim()) { setError("Description is required."); return; }
    if (!amt || amt <= 0) { setError("Enter a valid amount."); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/bghs/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          category: form.category,
          description: form.description.trim(),
          amount: amt,
          vendorName: form.vendorName.trim() || undefined,
          expenseDate: form.expenseDate,
          consultId: form.consultId || undefined,
          notes: form.notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save expense");
      setForm({ category: "materials", description: "", amount: "", vendorName: "", expenseDate: todayStr(), consultId: "", notes: "" });
      setShowAddExpense(false);
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to save expense");
    } finally {
      setSaving(false);
    }
  }

  async function deleteExpense(id: number) {
    if (!window.confirm("Remove this expense entry?")) return;
    try {
      const res = await fetch(`/api/admin/bghs/expenses/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete");
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to delete expense");
    }
  }

  const rangeBtn = (val: typeof range, label: string) => (
    <button onClick={() => setRange(val)} style={{
      ...actionBtnStyle,
      background: range === val ? "rgba(200,170,90,0.14)" : actionBtnStyle.background,
      borderColor: range === val ? "rgba(200,170,90,0.45)" : actionBtnStyle.border as string,
      color: range === val ? GOLD : actionBtnStyle.color,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
          <DollarSign size={13} color={GOLD} /> BGHS Profit &amp; Loss
        </h3>
        <button onClick={load} style={actionBtnStyle}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Brothers Group Home Solutions (repair/touch-up program) only — Inspections+ is a separate line and isn't
        included here. Revenue Collected is cash actually received; Vendor Cost pulls automatically from vendor-quoted
        line items. Logged Expenses are whatever's added below (materials, in-house labor, overhead, etc.) — Gross
        Profit will overstate margin on jobs where in-house labor time was never logged as an expense.
      </p>

      {/* Range selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {rangeBtn("this_month", "This Month")}
        {rangeBtn("last_month", "Last Month")}
        {rangeBtn("this_quarter", "This Quarter")}
        {rangeBtn("ytd", "YTD")}
        {rangeBtn("all_time", "All Time")}
        {rangeBtn("custom", "Custom")}
        {range === "custom" && (
          <>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: "#94a3b8", fontSize: 11 }}>to</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
          </>
        )}
      </div>

      {error && (
        <div style={{ ...cardStyle, borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.06)", color: "#f87171", fontSize: 12, marginBottom: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {loading || !pnl ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading P&amp;L…</div>
      ) : (
        <>
          {/* Summary cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div style={{ ...cardStyle, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.05)" }}>
              <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Revenue Collected</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>{money(pnl.revenueCollected)}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Contracted (Backlog)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#c7d1dd" }}>{money(pnl.revenueContracted)}</div>
            </div>
            <div style={{ ...cardStyle, border: "1px solid rgba(251,146,60,0.3)", background: "rgba(251,146,60,0.05)" }}>
              <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Vendor Cost</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#fb923c" }}>{money(pnl.vendorCostTotal)}</div>
            </div>
            <div style={{ ...cardStyle, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(248,113,113,0.05)" }}>
              <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Logged Expenses</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#f87171" }}>{money(pnl.expensesTotal)}</div>
            </div>
            <div style={{ ...cardStyle, border: `1px solid ${pnl.grossProfit >= 0 ? "rgba(200,170,90,0.4)" : "rgba(248,113,113,0.4)"}`, background: pnl.grossProfit >= 0 ? "rgba(200,170,90,0.06)" : "rgba(248,113,113,0.06)" }}>
              <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                {pnl.grossProfit >= 0 ? <TrendingUp size={10} color={GOLD} /> : <TrendingDown size={10} color="#f87171" />} Gross Profit
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: pnl.grossProfit >= 0 ? GOLD : "#f87171" }}>{money(pnl.grossProfit)}</div>
              <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 2 }}>{pct(pnl.grossMarginPct)} margin · {pnl.jobCount} job{pnl.jobCount === 1 ? "" : "s"}</div>
            </div>
          </div>

          {/* Expense category breakdown */}
          {Object.keys(pnl.expensesByCategory).length > 0 && (
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#c7d1dd", marginBottom: 8 }}>Logged Expenses by Category</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(pnl.expensesByCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => {
                  const wPct = pnl.expensesTotal > 0 ? (amt / pnl.expensesTotal) * 100 : 0;
                  return (
                    <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 90, fontSize: 11, color: "#94a3b8" }}>{CATEGORY_LABELS[cat] || cat}</div>
                      <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${wPct}%`, height: "100%", background: GOLD, borderRadius: 4 }} />
                      </div>
                      <div style={{ width: 80, textAlign: "right", fontSize: 11.5, fontWeight: 600, color: "#c7d1dd" }}>{money(amt)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Add expense */}
          <div style={{ marginBottom: 14 }}>
            <button onClick={() => setShowAddExpense(s => !s)} style={{ ...actionBtnStyle, color: GOLD, borderColor: "rgba(200,170,90,0.4)", background: "rgba(200,170,90,0.08)" }}>
              <Plus size={11} /> Log Expense
            </button>
            {showAddExpense && (
              <div style={{ ...cardStyle, marginTop: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Category</label>
                    <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ ...inputStyle, width: "100%" }}>
                      {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Amount</label>
                    <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ ...inputStyle, width: "100%" }} placeholder="0.00" />
                  </div>
                  <div>
                    <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Date</label>
                    <input type="date" value={form.expenseDate} onChange={e => setForm(f => ({ ...f, expenseDate: e.target.value }))} style={{ ...inputStyle, width: "100%" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Job (optional)</label>
                    <select value={form.consultId} onChange={e => setForm(f => ({ ...f, consultId: e.target.value }))} style={{ ...inputStyle, width: "100%" }}>
                      <option value="">— General / Overhead —</option>
                      {jobs.map(j => <option key={j.id} value={j.id}>{j.property_address}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Vendor/Payee (optional)</label>
                    <input type="text" value={form.vendorName} onChange={e => setForm(f => ({ ...f, vendorName: e.target.value }))} style={{ ...inputStyle, width: "100%" }} />
                  </div>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 10.5, color: "#94a3b8", display: "block", marginBottom: 3 }}>Description</label>
                  <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ ...inputStyle, width: "100%" }} placeholder="e.g. Paint & supplies from Sherwin-Williams" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={submitExpense} disabled={saving} style={{ ...actionBtnStyle, color: "#4ade80", borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.08)" }}>
                    {saving ? "Saving…" : "Save Expense"}
                  </button>
                  <button onClick={() => setShowAddExpense(false)} style={actionBtnStyle}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Per-job breakdown */}
          <div style={{ marginBottom: 14 }}>
            <button onClick={() => setShowJobBreakdown(s => !s)} style={{ ...actionBtnStyle, width: "100%", justifyContent: "space-between" }}>
              <span>Per-Job Breakdown ({pnl.perJob.length})</span>
              {showJobBreakdown ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showJobBreakdown && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                {pnl.perJob.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>No signed jobs in this range.</div>
                ) : pnl.perJob.map(r => (
                  <div key={r.consultId} style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#e5e7eb" }}>{r.propertyAddress}</div>
                      <span style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 4, textTransform: "capitalize", color: "#e8d8a8", background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.35)" }}>{r.status.replace(/_/g, " ")}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: "#94a3b8", marginBottom: 8 }}>Agent: {r.agentName || "—"}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8 }}>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Contract</div><div style={{ fontSize: 12, fontWeight: 600, color: "#c7d1dd" }}>{money(r.contractTotal)}</div></div>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Collected</div><div style={{ fontSize: 12, fontWeight: 600, color: "#4ade80" }}>{money(r.collected)}</div></div>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Vendor Cost</div><div style={{ fontSize: 12, fontWeight: 600, color: "#fb923c" }}>{money(r.vendorCost)}</div></div>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Expenses</div><div style={{ fontSize: 12, fontWeight: 600, color: "#f87171" }}>{money(r.expenses)}</div></div>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Profit</div><div style={{ fontSize: 12, fontWeight: 700, color: r.profit >= 0 ? GOLD : "#f87171" }}>{money(r.profit)}</div></div>
                      <div><div style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase" }}>Margin</div><div style={{ fontSize: 12, fontWeight: 600, color: "#c7d1dd" }}>{pct(r.marginPct)}</div></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Expense ledger */}
          <div>
            <button onClick={() => setShowLedger(s => !s)} style={{ ...actionBtnStyle, width: "100%", justifyContent: "space-between" }}>
              <span>Expense Ledger ({expenses.length})</span>
              {showLedger ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showLedger && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {expenses.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>No expenses logged in this range.</div>
                ) : expenses.map(e => (
                  <div key={e.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#e5e7eb" }}>{e.description}</div>
                      <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 2 }}>
                        {e.expense_date} · {CATEGORY_LABELS[e.category] || e.category}
                        {e.vendor_name ? ` · ${e.vendor_name}` : ""}
                        {e.property_address ? ` · ${e.property_address}` : " · General/Overhead"}
                        {e.recorded_by_name ? ` · logged by ${e.recorded_by_name}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#f87171" }}>{money(e.amount)}</div>
                      <button onClick={() => deleteExpense(e.id)} style={{ ...actionBtnStyle, padding: 6, color: "#f87171", borderColor: "rgba(248,113,113,0.35)" }}><Trash2 size={11} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
