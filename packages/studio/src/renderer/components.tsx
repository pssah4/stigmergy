// Studio component library (FEAT-05-01, ADR-21). Thin React wrappers over the design-token style
// factories (../shared/design-tokens). They exist so panels stop hand-rolling raw inline styles and
// share one visual grammar. Inline styles cannot express :hover, so the interactive wrappers drive
// hover/disabled from local state. NO Ant Design, NO model tiers.
import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  buttonStyle,
  cardStyle,
  inputStyle,
  badgeStyle,
  mutedTextStyle,
  tokens,
  transition,
  type ButtonVariant,
  type InputState,
} from '../shared/design-tokens.js'

export function Button({
  variant = 'default',
  disabled = false,
  onClick,
  children,
  style,
  title,
}: {
  variant?: ButtonVariant
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  style?: CSSProperties
  title?: string
}): JSX.Element {
  const [hover, setHover] = useState(false)
  const state = disabled ? 'disabled' : hover ? 'hover' : 'default'
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={disabled ? undefined : onClick}
      style={{ ...buttonStyle(variant, state), ...style }}
    >
      {children}
    </button>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return <div style={{ ...cardStyle(), ...style }}>{children}</div>
}

export function Badge({ children }: { children: ReactNode }): JSX.Element {
  return <span style={badgeStyle()}>{children}</span>
}

export function MutedText({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return <span style={{ ...mutedTextStyle(), ...style }}>{children}</span>
}

export function TextField({
  value,
  onChange,
  placeholder,
  error = false,
  type = 'text',
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  error?: boolean
  type?: 'text' | 'password'
  style?: CSSProperties
}): JSX.Element {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const state: InputState = error ? 'error' : focus ? 'focus' : hover ? 'hover' : 'default'
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle(state), ...style }}
    />
  )
}

/** A segmented control (FEAT-06-08): mutually-exclusive options as one pill, the active one filled with
 * the accent. Used for the Read|Edit mode switch so the mode reads as a clear grammar, not a lone button. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  title,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  title?: string
}): JSX.Element {
  const [hovered, setHovered] = useState<T | null>(null)
  return (
    <div role="tablist" title={title} style={{ display: 'inline-flex', background: tokens.color.bg, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: 2, gap: 2 }}>
      {options.map((o) => {
        const active = o.value === value
        const hover = !active && hovered === o.value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            onMouseEnter={() => setHovered(o.value)}
            onMouseLeave={() => setHovered((h) => (h === o.value ? null : h))}
            style={{
              padding: `2px ${tokens.space[2]}px`,
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: 'pointer',
              fontSize: tokens.font.size.md,
              fontWeight: active ? tokens.font.weight.medium : tokens.font.weight.regular,
              background: active ? tokens.color.accent : hover ? tokens.color.surfaceHover : 'transparent',
              color: active ? tokens.color.accentText : hover ? tokens.color.text : tokens.color.textMuted,
              transition: transition(['background', 'color']),
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** A small on/off switch (FEAT-06-08): a sliding knob, ON eased to a colour (default success green). */
export function Toggle({ on, onChange, title, accent = tokens.color.success }: { on: boolean; onChange: (v: boolean) => void; title?: string; accent?: string }): JSX.Element {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={() => onChange(!on)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        width: 34,
        height: 18,
        borderRadius: 999,
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        background: on ? accent : tokens.color.surfaceHover,
        position: 'relative',
        padding: 0,
        boxShadow: focus ? tokens.focusRing : hover ? tokens.shadow.sm : undefined,
        transition: transition(['background', 'box-shadow']),
      }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: transition(['left']) }} />
    </button>
  )
}

/** A square ghost icon button (FEAT-06-08): de-emphasized until hover/active, for chrome actions. */
export function IconButton({ onClick, title, active = false, children }: { onClick?: () => void; title?: string; active?: boolean; children: ReactNode }): JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.space[1],
        padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
        borderRadius: tokens.radius.sm,
        border: `1px solid ${active ? tokens.color.accent : 'transparent'}`,
        background: active || hover ? tokens.color.surfaceHover : 'transparent',
        color: active ? tokens.color.text : tokens.color.textMuted,
        cursor: 'pointer',
        fontSize: tokens.font.size.md,
        transition: transition(['background', 'border-color', 'color']),
      }}
    >
      {children}
    </button>
  )
}
