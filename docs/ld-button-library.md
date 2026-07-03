# Lead Depot — Button Component Library

**File:** `client/src/components/ld/ActionButton.tsx`  
**Import path:** `@/components/ld/ActionButton`

All interactive controls in Lead Depot must come from this file. Never define an inline `<button>` with a custom style in a page or modal — use the canonical component and extend it here if needed.

---

## Why This Exists

The Recycle button was defined three separate times with three different styles. The `queryClient` scoping bug was introduced because button mutation logic was copy-pasted between contexts. This library ensures:

- Every action has exactly one visual definition
- Pending/disabled states are handled consistently everywhere
- Swapping a color or padding happens in one place, updates everywhere

---

## Component Reference

### `LdPrimaryBtn` — Gold CTA
**Use for:** Confirm & Submit, Add Agent, Add Website Lead, Sign In

```tsx
<LdPrimaryBtn
  label="Confirm & Submit"
  pendingLabel="Saving…"
  isPending={mutation.isPending}
  disabled={!canSubmit}
  onClick={() => mutation.mutate(data)}
  marginTop={28}        // optional, default 0
  fullWidth             // default true
  testId="button-submit-appt"
/>
```

**Replaces these hardcoded patterns:**
```tsx
// AgentView ApptModal line 243 — DELETE and use LdPrimaryBtn
<button style={{ background: "linear-gradient(135deg,#c8aa5a,#a8893a)", ... }}>
  {isPending ? "Saving…" : "Confirm & Submit"}
</button>

// AdminDashboard Add Agent dialog line 1748 — DELETE and use LdPrimaryBtn
<button style={{ background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)", ... }}>
  {createAgentMutation.isPending ? "Adding…" : "Add Agent"}
</button>

// AdminDashboard Add Website Lead line 1566 — DELETE and use LdPrimaryBtn
<button style={{ background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)", ... }}>
  {submittingWebsiteLead ? "Submitting…" : "Add Website Lead & Assign"}
</button>
```

---

### `LdDangerBtn` — Red Destructive
**Use for:** Confirm Recycle (in RecycleButton sheet), Deactivate Agent

```tsx
<LdDangerBtn
  label="Confirm Recycle"
  pendingLabel="Recycling…"
  isPending={recycleMutation.isPending}
  onClick={() => recycleMutation.mutate()}
/>
```

**Replaces:**
```tsx
// AgentView RecycleButton confirm sheet line 409 — DELETE and use LdDangerBtn
<button style={{ background: recycleMutation.isPending ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.85)", ... }}>
  {recycleMutation.isPending ? "Recycling…" : "Confirm Recycle"}
</button>
```

---

### `LdCyanBtn` — Cyan Recycle Flow
**Use for:** "Recycle to Pool" in the CallbackModal (bottom sheet triggered by RecycleButton)

```tsx
<LdCyanBtn
  label="Recycle to Pool"
  pendingLabel="Recycling…"
  isPending={isPending}
  onClick={() => onSubmit({ callbackDate: "", callbackTime: "" })}
/>
```

**Replaces:**
```tsx
// AgentView CallbackModal line 294 — DELETE and use LdCyanBtn
<button style={{ background: !isPending ? "linear-gradient(135deg,#22d3ee,#0891b2)" : "...", ... }}>
  {isPending ? "Recycling…" : "Recycle to Pool"}
</button>
```

---

### `LdGhostBtn` — Cancel / Secondary
**Use for:** Cancel in any confirm row, side-by-side with a primary or danger button

```tsx
<LdGhostBtn label="Cancel" onClick={() => setConfirming(false)} />
```

**Replaces:**
```tsx
// AgentView RecycleButton confirm line 401 — DELETE and use LdGhostBtn
<button style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", ... }}>
  Cancel
</button>
```

---

### `LdConfirmRow` — Cancel + Confirm side-by-side
**Use for:** Any confirmation sheet that needs a Cancel and a primary action together. Wraps LdGhostBtn + one of the colored primaries automatically.

```tsx
// Danger variant — RecycleButton confirm sheet
<LdConfirmRow
  confirmLabel="Confirm Recycle"
  pendingLabel="Recycling…"
  isPending={recycleMutation.isPending}
  onConfirm={() => recycleMutation.mutate()}
  onCancel={() => setConfirming(false)}
  variant="danger"
/>

// Primary variant — any gold confirm
<LdConfirmRow
  confirmLabel="Confirm & Submit"
  pendingLabel="Saving…"
  isPending={mutation.isPending}
  disabled={!canSubmit}
  onConfirm={handleSubmit}
  onCancel={onClose}
  variant="primary"
/>
```

---

### `LdIconBtn` — Bare icon (close / dismiss)
**Use for:** X close buttons on modals, drilldown panels

```tsx
import { X } from "lucide-react";

<LdIconBtn icon={X} onClick={onClose} ariaLabel="Close panel" />
```

**Replaces:**
```tsx
// AdminDashboard AgentDrilldown line 158 — DELETE and use LdIconBtn
<button style={{ background: "none", border: "none", cursor: "pointer", ... }}>
  <X size={16} />
</button>
```

---

### `LdOutlineBtn` — Bordered utility / toolbar
**Use for:** Refresh buttons in leaderboard/pipeline headers, Export DB

```tsx
import { RefreshCw } from "lucide-react";

<LdOutlineBtn
  label="Refresh"
  icon={RefreshCw}
  onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/leaderboard"] })}
/>
```

**Replaces:**
```tsx
// AdminDashboard leaderboard header lines 981, 1185, 1284 — DELETE and use LdOutlineBtn
<button style={{ background: "rgba(255,255,255,0.04)", border: "1px solid ...", ... }}>
  <RefreshCw size={11} /> Refresh
</button>
```

---

### `LdToggleSwitch` — Boolean pill toggle
**Use for:** Lead Flow on/off, Website Leads toggle in Agents panel

```tsx
<LdToggleSwitch
  on={agent.leadFlowOn}
  onToggle={() => toggleLeadFlowMutation.mutate({ id: agent.id, leadFlowOn: !agent.leadFlowOn })}
  disabled={toggleLeadFlowMutation.isPending}
  activeColor="#c8aa5a"
  activeDot="#c8aa5a"
  testId={`toggle-lead-flow-${agent.id}`}
/>
```

---

## Swap Checklist

When touching any file, replace these inline patterns with the canonical component:

| Location | Line (approx) | Current pattern | Replace with |
|---|---|---|---|
| `AgentView` — ApptModal | 243 | Gold `<button>` "Confirm & Submit" | `<LdPrimaryBtn>` |
| `AgentView` — CallbackModal | 294 | Cyan `<button>` "Recycle to Pool" | `<LdCyanBtn>` |
| `AgentView` — RecycleButton cancel | 401 | Ghost `<button>` "Cancel" | `<LdGhostBtn>` |
| `AgentView` — RecycleButton confirm | 409 | Red `<button>` "Confirm Recycle" | `<LdDangerBtn>` |
| `AgentView` — RecycleButton (both) | 401+409 | Cancel + Confirm pair | `<LdConfirmRow variant="danger">` |
| `AdminDashboard` — Drilldown X close | 158 | Icon `<button>` | `<LdIconBtn>` |
| `AdminDashboard` — Leaderboard Refresh | 981 | Outline `<button>` | `<LdOutlineBtn>` |
| `AdminDashboard` — Pipeline Refresh | 1185, 1284 | Outline `<button>` | `<LdOutlineBtn>` |
| `AdminDashboard` — Add Agent | 1748 | Gold `<button>` | `<LdPrimaryBtn>` |
| `AdminDashboard` — Add Website Lead | 1566 | Gold `<button>` | `<LdPrimaryBtn>` |

---

## Adding a New Action

1. **Does an existing variant cover it?** Use that directly.
2. **New color/style?** Add a new exported component to `ActionButton.tsx` — do not add an inline style to the page.
3. **New confirm flow?** Use `<LdConfirmRow>` — do not rebuild the cancel+confirm grid.
4. **Never** pass `style={{}}` overrides to these components in call sites. If the design needs a tweak, update the component definition.

---

## Duplication Audit Summary

The static analysis found these button duplication patterns before this library was created:

| Pattern | Occurrences | Files |
|---|---|---|
| Gold gradient CTA (`#c8aa5a → #a8893a`) | 4x | AgentView, AdminDashboard (×3) |
| Cyan gradient CTA (`#22d3ee → #0891b2`) | 2x | AgentView CallbackModal, RecycleModal |
| Red danger CTA (`rgba(239,68,68,...)`) | 2x | AgentView RecycleButton |
| Ghost Cancel | 2x | AgentView RecycleButton, ApptModal area |
| Outline Refresh (`rgba(255,255,255,0.04)` border) | 3x | AdminDashboard headers |
| Icon-only close (`background: none`) | 2x | AdminDashboard drilldown, AgentView back |
| Toggle pill switch | 2x+ | AdminDashboard Agents panel |

The "Recycle" label appeared on **3 separate buttons** with 3 different implementations (OUTCOMES grid, CallbackModal bottom sheet, RecycleButton confirm sheet). The OUTCOMES grid entry was removed in v11.35. The remaining two are now canonical via `LdCyanBtn` and `LdDangerBtn`.
