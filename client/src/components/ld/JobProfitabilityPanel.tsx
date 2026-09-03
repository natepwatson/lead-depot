// v20.53.0 — Job Profitability Calculator. BGRE-branded admin tool for
// evaluating repair/turnover job costs: original approved price + change
// orders (to see how the contract price developed) minus itemized expenses
// = net profit and margin. Jobs are saved locally per-browser so Alex/Nate
// can keep a running list without needing a backend table for v1.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Plus, Trash2, Save, FilePlus2, FolderOpen, Printer } from "lucide-react";

const GOLD = "#c8aa5a";
const STORAGE_KEY = "ld_job_profitability_jobs_v1";

const CATEGORIES = ["Materials", "Labor", "Subcontractor", "Permits & Fees", "Equipment Rental", "Disposal / Dump", "Travel", "Other"];

type LineItem = { id: string; desc: string; amount: string };
type ExpenseItem = LineItem & { category: string };

type Job = {
  id: string;
  clientName: string;
  address: string;
  originalPrice: string;
  changeOrders: LineItem[];
  expenses: ExpenseItem[];
  updatedAt: number;
};

const uid = () => Math.random().toString(36).slice(2, 10);

function emptyJob(): Job {
  return {
    id: uid(),
    clientName: "",
    address: "",
    originalPrice: "",
    changeOrders: [],
    expenses: [{ id: uid(), category: "Materials", desc: "", amount: "" }],
    updatedAt: Date.now(),
  };
}

const money = (n: number) => {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const cardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.02)",
  border: "1px solid rgba(200,170,90,0.15)",
  borderRadius: 10,
  padding: 18,
  marginBottom: 16,
};

const sectionLabel: CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
  color: GOLD, marginBottom: 12,
};

const fieldLabel: CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, color: "#94a3b8", marginBottom: 5,
};

const inputStyle: CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#e5e7eb", fontSize: 13,
};

const selectStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };

const rmBtnStyle: CSSProperties = {
  width: 30, height: 30, borderRadius: 6, background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#94a3b8", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};

const addBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 7,
  background: "rgba(200,170,90,0.1)", border: "1px solid rgba(200,170,90,0.35)",
  color: GOLD, fontSize: 12, fontWeight: 600, cursor: "pointer", marginTop: 4,
};

const toolbarBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 7,
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)",
  color: "#e5e7eb", fontSize: 12, fontWeight: 600, cursor: "pointer",
};

function StatBlock({ label, value, tone }: { label: string; value: string; tone?: "gold" | "green" | "red" }) {
  const color = tone === "green" ? "#4ade80" : tone === "red" ? "#f87171" : tone === "gold" ? GOLD : "#e5e7eb";
  const bg = tone === "green" ? "rgba(74,222,128,0.06)" : tone === "red" ? "rgba(248,113,113,0.06)" : "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)";
  const border = tone === "green" ? "rgba(74,222,128,0.25)" : tone === "red" ? "rgba(248,113,113,0.25)" : "rgba(200,170,90,0.1)";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 24, fontWeight: 300, lineHeight: 1, marginBottom: 4, color }}>{value}</div>
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "#64748b" }}>{label}</div>
    </div>
  );
}

export function JobProfitabilityPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job>(emptyJob());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: Job[] = JSON.parse(raw);
        setJobs(parsed);
        if (parsed.length) setJob(parsed[0]);
      }
    } catch { /* ignore */ }
  }, []);

  const persist = (updatedJobs: Job[]) => {
    setJobs(updatedJobs);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedJobs)); } catch { /* ignore */ }
  };

  const saveCurrent = () => {
    const toSave = { ...job, updatedAt: Date.now() };
    const existingIdx = jobs.findIndex(j => j.id === toSave.id);
    const next = existingIdx >= 0
      ? jobs.map((j, i) => (i === existingIdx ? toSave : j))
      : [toSave, ...jobs];
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    persist(next);
    setJob(toSave);
  };

  const deleteCurrent = () => {
    if (!confirm(`Delete saved job "${job.clientName || "Untitled"}"?`)) return;
    const next = jobs.filter(j => j.id !== job.id);
    persist(next);
    setJob(next[0] || emptyJob());
  };

  const originalPrice = parseFloat(job.originalPrice) || 0;
  const changeOrderTotal = job.changeOrders.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  const revenue = originalPrice + changeOrderTotal;
  const totalExpenses = job.expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  const profit = revenue - totalExpenses;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const addChangeOrder = () => setJob(j => ({ ...j, changeOrders: [...j.changeOrders, { id: uid(), desc: "", amount: "" }] }));
  const removeChangeOrder = (id: string) => setJob(j => ({ ...j, changeOrders: j.changeOrders.filter(c => c.id !== id) }));
  const updateChangeOrder = (id: string, field: "desc" | "amount", value: string) =>
    setJob(j => ({ ...j, changeOrders: j.changeOrders.map(c => (c.id === id ? { ...c, [field]: value } : c)) }));

  const addExpense = () => setJob(j => ({ ...j, expenses: [...j.expenses, { id: uid(), category: "Materials", desc: "", amount: "" }] }));
  const removeExpense = (id: string) => setJob(j => ({ ...j, expenses: j.expenses.filter(e => e.id !== id) }));
  const updateExpense = (id: string, field: "category" | "desc" | "amount", value: string) =>
    setJob(j => ({ ...j, expenses: j.expenses.map(e => (e.id === id ? { ...e, [field]: value } : e)) }));

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <button style={toolbarBtnStyle} onClick={() => setJob(emptyJob())}>
          <FilePlus2 size={13} /> New Job
        </button>
        {jobs.length > 0 && (
          <select
            style={{ ...selectStyle, width: "auto", minWidth: 180 }}
            value={job.id}
            onChange={e => {
              const found = jobs.find(j => j.id === e.target.value);
              if (found) setJob(found);
            }}
          >
            {!jobs.find(j => j.id === job.id) && <option value={job.id}>(unsaved) {job.clientName || "New Job"}</option>}
            {jobs.map(j => (
              <option key={j.id} value={j.id}>{j.clientName || "Untitled"} {j.address ? `— ${j.address}` : ""}</option>
            ))}
          </select>
        )}
        <button style={{ ...toolbarBtnStyle, background: "rgba(200,170,90,0.12)", borderColor: "rgba(200,170,90,0.4)", color: GOLD }} onClick={saveCurrent}>
          <Save size={13} /> Save Job
        </button>
        {jobs.find(j => j.id === job.id) && (
          <button style={{ ...toolbarBtnStyle, color: "#f87171" }} onClick={deleteCurrent}>
            <Trash2 size={13} /> Delete
          </button>
        )}
        <button style={toolbarBtnStyle} onClick={() => window.print()}>
          <Printer size={13} /> Print
        </button>
      </div>

      {/* Job Details */}
      <div style={cardStyle}>
        <div style={sectionLabel}>Job Details</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 14 }}>
          <div>
            <label style={fieldLabel}>Client / Job Name</label>
            <input style={inputStyle} value={job.clientName} placeholder="e.g. Laura Dodson"
              onChange={e => setJob(j => ({ ...j, clientName: e.target.value }))} />
          </div>
          <div>
            <label style={fieldLabel}>Address / Notes</label>
            <input style={inputStyle} value={job.address} placeholder="Property address or job notes"
              onChange={e => setJob(j => ({ ...j, address: e.target.value }))} />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={fieldLabel}>Original Approved Price ($)</label>
          <input type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 220 }} value={job.originalPrice}
            placeholder="0.00" onChange={e => setJob(j => ({ ...j, originalPrice: e.target.value }))} />
        </div>

        <div>
          <label style={fieldLabel}>Change Orders</label>
          {job.changeOrders.map(co => (
            <div key={co.id} style={{ display: "grid", gridTemplateColumns: "1fr 130px 34px", gap: 8, marginBottom: 8 }}>
              <input style={inputStyle} value={co.desc} placeholder="Change order description (e.g. added deck repair)"
                onChange={e => updateChangeOrder(co.id, "desc", e.target.value)} />
              <input type="number" step="0.01" style={{ ...inputStyle, textAlign: "right" }} value={co.amount}
                placeholder="0.00" title="Use a negative number for a credit / price decrease"
                onChange={e => updateChangeOrder(co.id, "amount", e.target.value)} />
              <button style={rmBtnStyle} onClick={() => removeChangeOrder(co.id)} title="Remove change order">✕</button>
            </div>
          ))}
          <button style={addBtnStyle} onClick={addChangeOrder}><Plus size={13} /> Add Change Order</button>
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16,
          padding: "11px 15px", borderRadius: 8, background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.3)",
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: GOLD, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Current Contract Price
          </span>
          <span style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>{money(revenue)}</span>
        </div>
      </div>

      {/* Expenses */}
      <div style={cardStyle}>
        <div style={sectionLabel}>Expenses</div>
        {job.expenses.map(exp => (
          <div key={exp.id} style={{ display: "grid", gridTemplateColumns: "160px 1fr 130px 34px", gap: 8, marginBottom: 8 }}>
            <select style={selectStyle} value={exp.category} onChange={e => updateExpense(exp.id, "category", e.target.value)}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input style={inputStyle} value={exp.desc} placeholder="Description (optional)"
              onChange={e => updateExpense(exp.id, "desc", e.target.value)} />
            <input type="number" step="0.01" min="0" style={{ ...inputStyle, textAlign: "right" }} value={exp.amount}
              placeholder="0.00" onChange={e => updateExpense(exp.id, "amount", e.target.value)} />
            <button style={rmBtnStyle} onClick={() => removeExpense(exp.id)} title="Remove expense">✕</button>
          </div>
        ))}
        <button style={addBtnStyle} onClick={addExpense}><Plus size={13} /> Add Expense</button>
      </div>

      {/* Summary */}
      <div style={cardStyle}>
        <div style={sectionLabel}>Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <StatBlock label="Total Revenue" value={money(revenue)} tone="gold" />
          <StatBlock label="Total Expenses" value={money(totalExpenses)} />
          <StatBlock label="Net Profit" value={money(profit)} tone={profit >= 0 ? "green" : "red"} />
          <StatBlock label="Profit Margin" value={`${revenue > 0 ? margin.toFixed(1) : "0.0"}%`} tone={profit >= 0 ? "green" : "red"} />
        </div>
      </div>

    </div>
  );
}
