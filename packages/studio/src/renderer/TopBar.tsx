// App top bar (FEAT-06-08): the full-width application header of the Studio shell. It now also carries
// the primary navigation as a tab strip (replacing the old left rail, which felt redundant), plus the
// connected-loop status, the master Stigmergy ON/OFF switch, and the Read|Edit mode segmented control
// (graph view only). Settings is one of the nav tabs, so there is no separate Settings button. Styled
// from design-tokens (ADR-21, one dark theme).
import { useState } from 'react'
import { tokens, transition } from '../shared/design-tokens.js'
import { LABELS, type LabelKey } from '../shared/labels.js'
import { SegmentedControl, Toggle } from './components.js'

// The primary destinations (was the left rail). 'detail' is the graph, 'palette' the path builder,
// 'ops' the memory/substrate surface, 'settings' configuration (incl. the Connection tab).
export type StudioView = 'detail' | 'palette' | 'ops' | 'settings'
const NAV: { view: StudioView; key: LabelKey }[] = [
  { view: 'detail', key: 'navGraph' },
  { view: 'palette', key: 'navPalette' },
  { view: 'ops', key: 'navSubstrate' },
  { view: 'settings', key: 'navSettings' },
]

function Tab({ label, tooltip, active, onClick }: { label: string; tooltip?: string; active: boolean; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={tooltip}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: `0 ${tokens.space[2]}px`,
        height: tokens.layout.topBar,
        // Drop the 2px accent onto the header's own 1px bottom border so the active underline reads cleanly
        // instead of stacking above the divider (matches the Settings tab bar).
        marginBottom: -1,
        background: 'transparent',
        border: 'none',
        borderBottom: `2px solid ${active ? tokens.color.accent : 'transparent'}`,
        color: active ? tokens.color.text : hover ? tokens.color.text : tokens.color.textMuted,
        fontSize: tokens.font.size.md,
        fontWeight: active ? tokens.font.weight.medium : tokens.font.weight.regular,
        cursor: 'pointer',
        transition: transition(['color', 'border-color']),
      }}
    >
      {label}
    </button>
  )
}

export function TopBar({
  connectedProject,
  enabled,
  onSetEnabled,
  showEditToggle,
  editing,
  onToggleEdit,
  view,
  onSelectView,
}: {
  connectedProject: string
  enabled: boolean
  onSetEnabled: (enabled: boolean) => void
  showEditToggle: boolean
  editing: boolean
  onToggleEdit: () => void
  view: StudioView
  onSelectView: (view: StudioView) => void
}): JSX.Element {
  const projectName = connectedProject ? connectedProject.split(/[/\\]/).filter(Boolean).pop() ?? connectedProject : ''
  const dotColor = !connectedProject ? tokens.color.textMuted : enabled ? tokens.color.success : tokens.color.warn
  return (
    <header
      style={{
        height: tokens.layout.topBar,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.space[3],
        padding: `0 ${tokens.space[3]}px`,
        background: tokens.color.surfaceRaised,
        borderBottom: `1px solid ${tokens.color.border}`,
        boxShadow: tokens.shadow.sm,
        zIndex: 3,
      }}
    >
      <span style={{ fontSize: tokens.font.size.lg, fontWeight: tokens.font.weight.bold, letterSpacing: tokens.letterSpacing.wide, flexShrink: 0 }}>Stigmergy</span>

      <nav style={{ display: 'flex', alignItems: 'stretch', gap: tokens.space[1], flexShrink: 0 }}>
        {NAV.map((item) => (
          <Tab key={item.view} label={LABELS[item.key].label} tooltip={LABELS[item.key].tooltip} active={item.view === view} onClick={() => onSelectView(item.view)} />
        ))}
      </nav>

      <span style={{ flex: 1, minWidth: tokens.space[2] }} />

      <span
        title={connectedProject ? `Connected loop: ${connectedProject}` : 'No loop connected yet'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space[1], fontSize: tokens.font.size.sm, color: tokens.color.textMuted, minWidth: 0, maxWidth: 220, overflow: 'hidden' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}`, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connectedProject ? projectName : 'not connected'}</span>
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[3], flexShrink: 0 }}>
        {showEditToggle ? (
          <SegmentedControl
            title="Read mode inspects; Edit mode builds a path by clicking or dragging"
            options={[
              { value: 'read', label: 'Read' },
              { value: 'edit', label: 'Edit' },
            ]}
            value={editing ? 'edit' : 'read'}
            onChange={(v) => {
              if ((v === 'edit') !== editing) onToggleEdit()
            }}
          />
        ) : null}

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space[1], fontSize: tokens.font.size.sm, color: tokens.color.textMuted }} title="Active runs the daemon and lets the connected loop learn. Off stops both.">
          Active
          <Toggle on={enabled} onChange={onSetEnabled} accent={tokens.color.success} title={enabled ? 'On' : 'Off'} />
        </span>

        {connectedProject && !enabled ? (
          <span style={{ fontSize: tokens.font.size.sm, color: tokens.color.warn }} title="Stigmergy is wired into your loop but switched off. Turn it on to start learning.">
            switch on to learn
          </span>
        ) : null}
      </div>
    </header>
  )
}
