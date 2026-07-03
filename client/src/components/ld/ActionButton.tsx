/**
 * Lead Depot — Canonical Button / Action Component Library
 * ─────────────────────────────────────────────────────────
 * Single source of truth for every interactive control in the app.
 * Import from "@/components/ld/ActionButton" — never redefine inline.
 *
 * Variants
 * ─────────
 *  LdPrimaryBtn   — full-width gold CTA (modals, forms, sheets)
 *  LdDangerBtn    — full-width red CTA (destructive confirms)
 *  LdCyanBtn      — full-width cyan CTA (recycle flow)
 *  LdGhostBtn     — secondary/cancel (side-by-side with a primary)
 *  LdIconBtn      — icon-only dismiss / close (X button)
 *  LdOutlineBtn   — bordered utility (toolbar actions, toggles)
 *  LdToggleSwitch — on/off pill toggle (lead flow, website leads)
 */

import React from "react";
import type { LucideIcon } from "lucide-react";

// ─── Shared base style helpers ────────────────────────────────────────────────

const BASE: React.CSSProperties = {
  display:        "flex",
  alignItems:     "center",
  justifyContent: "center",
  gap:            6,
  border:         "none",
  borderRadius:   12,
  fontFamily:     "'Switzer','Inter',sans-serif",
  fontWeight:     700,
  letterSpacing:  "0.04em",
  transition:     "opacity 0.15s, transform 0.12s",
  WebkitTapHighlightColor: "transparent",
};

// ─── LdPrimaryBtn ─────────────────────────────────────────────────────────────
// Gold gradient — main confirm / submit inside modals, sheets, dialogs.
// Use for: Confirm & Submit, Add Agent, Add Website Lead, Sign In, etc.
export interface LdPrimaryBtnProps {
  label: string;
  pendingLabel?: string;
  isPending?: boolean;
  disabled?:   boolean;
  onClick?:    () => void;
  fullWidth?:  boolean;
  marginTop?:  number;
  testId?:     string;
}

export function LdPrimaryBtn({
  label, pendingLabel, isPending = false, disabled = false,
  onClick, fullWidth = true, marginTop = 0, testId,
}: LdPrimaryBtnProps) {
  const isDisabled = isPending || disabled;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      data-testid={testId}
      style={{
        ...BASE,
        width:      fullWidth ? "100%" : "auto",
        padding:    "16px",
        marginTop,
        fontSize:   15,
        background: isDisabled
          ? "rgba(255,255,255,0.08)"
          : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
        color:      isDisabled ? "rgba(255,255,255,0.3)" : "#080808",
        cursor:     isDisabled ? "default" : "pointer",
        boxShadow:  isDisabled ? "none" : "0 6px 20px rgba(200,170,90,0.25)",
      }}
    >
      {isPending ? (pendingLabel ?? "Saving…") : label}
    </button>
  );
}

// ─── LdDangerBtn ─────────────────────────────────────────────────────────────
// Red — destructive confirm actions (Confirm Recycle, Deactivate, etc.)
export interface LdDangerBtnProps {
  label: string;
  pendingLabel?: string;
  isPending?: boolean;
  disabled?:   boolean;
  onClick?:    () => void;
  fullWidth?:  boolean;
  testId?:     string;
}

export function LdDangerBtn({
  label, pendingLabel, isPending = false, disabled = false,
  onClick, fullWidth = true, testId,
}: LdDangerBtnProps) {
  const isDisabled = isPending || disabled;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      data-testid={testId}
      style={{
        ...BASE,
        width:      fullWidth ? "100%" : "auto",
        padding:    "14px",
        fontSize:   14,
        background: isDisabled ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.85)",
        color:      "#fff",
        cursor:     isDisabled ? "default" : "pointer",
      }}
    >
      {isPending ? (pendingLabel ?? "Processing…") : label}
    </button>
  );
}

// ─── LdCyanBtn ───────────────────────────────────────────────────────────────
// Cyan gradient — recycle / reassign CTAs only.
export interface LdCyanBtnProps {
  label: string;
  pendingLabel?: string;
  isPending?: boolean;
  disabled?:   boolean;
  onClick?:    () => void;
  fullWidth?:  boolean;
  testId?:     string;
}

export function LdCyanBtn({
  label, pendingLabel, isPending = false, disabled = false,
  onClick, fullWidth = true, testId,
}: LdCyanBtnProps) {
  const isDisabled = isPending || disabled;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      data-testid={testId}
      style={{
        ...BASE,
        width:      fullWidth ? "100%" : "auto",
        padding:    "16px",
        fontSize:   15,
        background: isDisabled
          ? "rgba(255,255,255,0.08)"
          : "linear-gradient(135deg,#22d3ee,#0891b2)",
        color:      isDisabled ? "rgba(255,255,255,0.3)" : "#080808",
        cursor:     isDisabled ? "default" : "pointer",
      }}
    >
      {isPending ? (pendingLabel ?? "Recycling…") : label}
    </button>
  );
}

// ─── LdGhostBtn ──────────────────────────────────────────────────────────────
// Ghost secondary — Cancel, Dismiss, close-without-action. Always sits beside a primary.
export interface LdGhostBtnProps {
  label?:   string;
  onClick?: () => void;
  fullWidth?: boolean;
  testId?:  string;
}

export function LdGhostBtn({ label = "Cancel", onClick, fullWidth = true, testId }: LdGhostBtnProps) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      style={{
        ...BASE,
        width:      fullWidth ? "100%" : "auto",
        padding:    "14px",
        fontSize:   14,
        background: "rgba(255,255,255,0.05)",
        border:     "1px solid rgba(255,255,255,0.15)",
        color:      "rgba(255,255,255,0.6)",
        cursor:     "pointer",
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}

// ─── LdIconBtn ───────────────────────────────────────────────────────────────
// Bare icon — close / dismiss (X). No background, no border.
export interface LdIconBtnProps {
  icon:     LucideIcon;
  size?:    number;
  onClick?: () => void;
  color?:   string;
  testId?:  string;
  ariaLabel?: string;
}

export function LdIconBtn({
  icon: Icon, size = 16, onClick,
  color = "rgba(255,255,255,0.4)", testId, ariaLabel,
}: LdIconBtnProps) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-label={ariaLabel ?? "Close"}
      style={{
        background: "none", border: "none",
        cursor: "pointer", color, padding: 4,
        display: "flex", alignItems: "center",
      }}
    >
      <Icon size={size} />
    </button>
  );
}

// ─── LdOutlineBtn ────────────────────────────────────────────────────────────
// Bordered utility — toolbar Refresh buttons, Export, minor admin actions.
export interface LdOutlineBtnProps {
  label:    string;
  icon?:    LucideIcon;
  iconSize?: number;
  isPending?: boolean;
  pendingLabel?: string;
  disabled?:  boolean;
  onClick?:   () => void;
  color?:     string;
  borderColor?: string;
  testId?:    string;
}

export function LdOutlineBtn({
  label, icon: Icon, iconSize = 11, isPending = false, pendingLabel,
  disabled = false, onClick, color = "rgba(255,255,255,0.5)",
  borderColor = "rgba(255,255,255,0.1)", testId,
}: LdOutlineBtnProps) {
  const isDisabled = isPending || disabled;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      data-testid={testId}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        fontSize: 11, padding: "7px 14px",
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${borderColor}`,
        borderRadius: 7, color, cursor: isDisabled ? "default" : "pointer",
        opacity: isDisabled ? 0.5 : 1,
        fontFamily: "'Switzer','Inter',sans-serif",
      }}
    >
      {Icon && <Icon size={iconSize} />}
      {isPending ? (pendingLabel ?? label) : label}
    </button>
  );
}

// ─── LdToggleSwitch ──────────────────────────────────────────────────────────
// Pill toggle — lead flow on/off, website leads, any boolean setting.
// activeColor: border/bg hue when on. activeDot: the dot fill color when on.
export interface LdToggleSwitchProps {
  on:          boolean;
  onToggle:    () => void;
  disabled?:   boolean;
  activeColor?: string;
  activeDot?:  string;
  testId?:     string;
  ariaLabel?:  string;
}

export function LdToggleSwitch({
  on, onToggle, disabled = false,
  activeColor = "#c8aa5a", activeDot = "#c8aa5a",
  testId, ariaLabel,
}: LdToggleSwitchProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel ?? (on ? "Turn off" : "Turn on")}
      style={{
        position: "relative", display: "inline-flex",
        height: 22, width: 40,
        alignItems: "center", borderRadius: 11,
        background: on ? activeColor : "rgba(255,255,255,0.08)",
        border: `1px solid ${on ? activeDot + "60" : "rgba(255,255,255,0.12)"}`,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.2s, border-color 0.2s",
        padding: 0, flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: "absolute",
        left: on ? 20 : 3,
        width: 15, height: 15, borderRadius: "50%",
        background: on ? "#000" : "rgba(255,255,255,0.3)",
        transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}

// ─── LdConfirmRow ────────────────────────────────────────────────────────────
// Standard Cancel + Confirm side-by-side row. Used in every confirm sheet.
// Pass variant="danger" for destructive actions, "primary" for gold, "cyan" for recycle.
export interface LdConfirmRowProps {
  confirmLabel:   string;
  pendingLabel?:  string;
  isPending?:     boolean;
  onConfirm:      () => void;
  onCancel:       () => void;
  variant?:       "primary" | "danger" | "cyan";
  disabled?:      boolean;
}

export function LdConfirmRow({
  confirmLabel, pendingLabel, isPending = false,
  onConfirm, onCancel, variant = "primary", disabled = false,
}: LdConfirmRowProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 20 }}>
      <LdGhostBtn label="Cancel" onClick={onCancel} />
      {variant === "danger" && (
        <LdDangerBtn
          label={confirmLabel} pendingLabel={pendingLabel}
          isPending={isPending} disabled={disabled} onClick={onConfirm}
        />
      )}
      {variant === "cyan" && (
        <LdCyanBtn
          label={confirmLabel} pendingLabel={pendingLabel}
          isPending={isPending} disabled={disabled} onClick={onConfirm}
        />
      )}
      {variant === "primary" && (
        <LdPrimaryBtn
          label={confirmLabel} pendingLabel={pendingLabel}
          isPending={isPending} disabled={disabled} onClick={onConfirm}
        />
      )}
    </div>
  );
}
