// Studio design tokens (FEAT-05-01, ADR-21). A central, typed source for the Studio's visual
// vocabulary, aligned to Vault Operator's look (dark, neutral surfaces, one accent). The Studio uses
// NO Ant Design and NO CSS framework (ADR-21 amendment 2026-06-01): the panels style via inline
// `style` objects, so these tokens and the style factories below are consumed directly by those
// inline styles. Pure (only a type-only React import), so the monorepo vitest covers them. NO model
// tiers and no tier vocabulary anywhere.

import type { CSSProperties } from 'react'

export const tokens = {
  color: {
    bg: '#1e1e1e',
    surface: '#252526',
    surfaceRaised: '#2d2d30',
    border: '#3c3c3c',
    text: '#e6e6e6',
    textMuted: '#9b9b9b',
    accent: '#4a8cff',
    accentText: '#ffffff',
    danger: '#e5534b',
    success: '#3fb950',
    /** Amber accent for the edit-mode toggle and the "wired but off" banner. */
    warn: '#e0a458',
    // Interaction-state colors (FEAT-06-08): real hover/active surfaces so factories stop faking depth
    // with a brightness filter and every control shares one hover/active/focus grammar.
    accentHover: '#5b97ff',
    borderHover: '#4d4d52',
    surfaceHover: '#34343a',
    dangerHover: '#ef6b63',
  },
  /** Spacing scale in px, strictly increasing; index it for consistent gaps and padding. */
  space: [4, 8, 12, 16, 24, 32] as const,
  radius: { sm: 4, md: 6, lg: 10 },
  font: {
    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    size: { sm: 12, md: 13, lg: 15, xl: 18 },
    weight: { regular: 400, medium: 500, bold: 600 },
  },
  // Elevation tuned for the dark bg (layered black, not light-mode drop shadows), so cards/panels read
  // as raised instead of flat rectangles (FEAT-06-08).
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.4)',
    md: '0 2px 8px rgba(0,0,0,0.5)',
    lg: '0 8px 24px rgba(0,0,0,0.6)',
  },
  /** Motion durations (ms) and easing for transitions; fast for controls, normal for panels. */
  duration: { fast: 120, normal: 200, slow: 320 },
  easing: { standard: 'cubic-bezier(0.2,0,0,1)', decelerate: 'cubic-bezier(0,0,0,1)' },
  /** De-emphasis levels, so scattered 0.5/0.6/0.55 literals route through one scale. */
  opacity: { disabled: 0.5, muted: 0.6, subtle: 0.4 },
  lineHeight: { tight: 1.2, normal: 1.5, loose: 1.7 },
  letterSpacing: { normal: 0, wide: 0.5 },
  /** Shell dimensions: one right-panel width (was a 340/360 split) plus the app-shell bars (FEAT-06-08). */
  layout: { panelWidth: 360, topBar: 46, statusBar: 28 },
  /** Double ring so focus reads on any surface; applied via box-shadow in focus states. */
  focusRing: '0 0 0 2px #1e1e1e, 0 0 0 4px #4a8cff',
  zIndex: { overlay: 900, modal: 1000 },
} as const

/** Build a CSSProperties.transition string for the given properties at one duration/easing (FEAT-06-08).
 * Inline styles cannot express transitions on pseudo-classes, so wrappers drive hover/active/focus from
 * local state and rely on this transition to animate the swap. */
export function transition(props: readonly string[], ms: number = tokens.duration.fast, ease: string = tokens.easing.standard): string {
  return props.map((p) => `${p} ${ms}ms ${ease}`).join(', ')
}

export type ButtonVariant = 'primary' | 'default' | 'danger'
export type ControlState = 'default' | 'hover' | 'active' | 'focus' | 'disabled'
export type InputState = 'default' | 'hover' | 'focus' | 'error'

/** The app shell / page background. */
export function surfaceStyle(): CSSProperties {
  return {
    background: tokens.color.bg,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: tokens.font.size.md,
  }
}

/** A raised panel/card surface. */
export function cardStyle(): CSSProperties {
  return {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    padding: tokens.space[3],
    color: tokens.color.text,
  }
}

/** A button style for a variant and interaction state. Hover/disabled are explicit so a wrapper can
 * drive them from local state (inline styles cannot express :hover). */
export function buttonStyle(variant: ButtonVariant = 'default', state: ControlState = 'default'): CSSProperties {
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string; hoverBg: string; hoverBorder: string }> = {
    primary: { bg: tokens.color.accent, fg: tokens.color.accentText, border: tokens.color.accent, hoverBg: tokens.color.accentHover, hoverBorder: tokens.color.accentHover },
    default: { bg: tokens.color.surfaceRaised, fg: tokens.color.text, border: tokens.color.border, hoverBg: tokens.color.surfaceHover, hoverBorder: tokens.color.borderHover },
    danger: { bg: tokens.color.danger, fg: tokens.color.accentText, border: tokens.color.danger, hoverBg: tokens.color.dangerHover, hoverBorder: tokens.color.dangerHover },
  }
  const p = palette[variant]
  const base: CSSProperties = {
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    borderRadius: tokens.radius.sm,
    padding: `${tokens.space[1]}px ${tokens.space[3]}px`,
    fontSize: tokens.font.size.md,
    fontWeight: tokens.font.weight.medium,
    cursor: 'pointer',
    opacity: 1,
    transition: transition(['background', 'border-color', 'box-shadow', 'color', 'transform']),
  }
  // Real hover/active/focus instead of a brightness filter, so depth and feedback read on the dark theme.
  if (state === 'hover') return { ...base, background: p.hoverBg, border: `1px solid ${p.hoverBorder}`, boxShadow: tokens.shadow.sm }
  if (state === 'active') return { ...base, transform: 'scale(0.98)' }
  if (state === 'focus') return { ...base, boxShadow: tokens.focusRing }
  if (state === 'disabled') return { ...base, cursor: 'not-allowed', opacity: tokens.opacity.disabled }
  return base
}

/** A text input style for an interaction state; 'error' marks the border with the danger color. */
export function inputStyle(state: InputState = 'default'): CSSProperties {
  const borderColor =
    state === 'error' ? tokens.color.danger : state === 'hover' || state === 'focus' ? tokens.color.accent : tokens.color.border
  return {
    background: tokens.color.bg,
    color: tokens.color.text,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor,
    borderRadius: tokens.radius.sm,
    padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
    fontSize: tokens.font.size.md,
    fontFamily: tokens.font.family,
    outline: 'none',
    boxShadow: state === 'focus' ? tokens.focusRing : undefined,
    transition: transition(['border-color', 'box-shadow']),
  }
}

/** A small status badge. */
export function badgeStyle(): CSSProperties {
  return {
    display: 'inline-block',
    background: tokens.color.surfaceRaised,
    color: tokens.color.textMuted,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    padding: `0 ${tokens.space[1]}px`,
    fontSize: tokens.font.size.sm,
  }
}

/** Secondary, de-emphasized text. */
export function mutedTextStyle(): CSSProperties {
  return { color: tokens.color.textMuted, fontSize: tokens.font.size.sm }
}
