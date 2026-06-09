// Builder palette (FEAT-04-02, ADR-17). Lists the available capabilities (discovered tools / MCP /
// skills, not yet run) grouped by type, lets the user click them into a path, and saves that path as
// a pinned workflow, n8n-style. "Discover" enumerates the configured sources into the substrate. The
// composing reuses the App's edit state, so saving goes through the same pin command as the editor.
import { useState, type CSSProperties } from 'react'
import type { PinBehavior } from '@agentic-stigmergy/core'
import { groupAvailableByType, type SubstrateSnapshot } from '../shared/graph-model.js'
import { tokens } from '../shared/design-tokens.js'

const panelStyle: CSSProperties = {
  width: 360,
  flexShrink: 0,
  borderLeft: `1px solid ${tokens.color.border}`,
  padding: '16px 18px',
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
}
const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}
const TYPE_LABEL: Record<string, string> = { tool: 'Tools', mcp: 'MCP', skill: 'Skills', subagent: 'Subagents' }

export function PalettePanel({
  snapshot,
  composedPath,
  onAdd,
  onPin,
  onClear,
}: {
  snapshot: SubstrateSnapshot
  composedPath: string[]
  onAdd: (capabilityId: string) => void
  onPin: (behavior: PinBehavior) => void
  onClear: () => void
}): JSX.Element {
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const groups = groupAvailableByType(snapshot)

  async function discover(): Promise<void> {
    setBusy(true)
    setMessage('Discovering ...')
    try {
      const res = await window.studio.discover()
      const parts = [`Registered ${res.registered}`]
      if (res.skipped) parts.push(`skipped ${res.skipped}`)
      if (res.errors.length) parts.push(`errors: ${res.errors.join('; ')}`)
      setMessage(parts.join(', '))
    } catch (err) {
      setMessage(`Discover failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Add tools</h2>
      <p style={{ opacity: 0.7, fontSize: 12 }}>
        Discover the tools, MCP servers and skills you configured, then click them into a path and save it.
        Configure sources under Settings.
      </p>
      <button style={buttonStyle} onClick={() => void discover()} disabled={busy}>
        {busy ? 'Discovering ...' : 'Discover'}
      </button>
      {message ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85, wordBreak: 'break-word' }}>{message}</div> : null}

      {composedPath.length > 0 ? (
        <div style={{ margin: '14px 0', padding: '8px 10px', background: tokens.color.bg, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Composed path</div>
          <div style={{ fontSize: 12, wordBreak: 'break-word' }}>{composedPath.join('  ->  ')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button style={buttonStyle} onClick={() => onPin('preferred')}>
              Save path
            </button>
            <button style={buttonStyle} onClick={onClear}>
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p style={{ opacity: 0.55, fontSize: 12, marginTop: 14 }}>
          No available tools yet. Configure MCP servers or a skills folder under Settings, then Discover.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.type} style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', opacity: 0.55, letterSpacing: 0.5 }}>
              {TYPE_LABEL[g.type] ?? g.type}
            </div>
            {g.items.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <button style={{ ...buttonStyle, padding: '2px 8px' }} title={`Add ${c.id} to the path`} onClick={() => onAdd(c.id)}>
                  +
                </button>
                <span style={{ fontSize: 12, wordBreak: 'break-word' }}>
                  {c.id}
                  {c.description ? <span style={{ opacity: 0.5 }}> {c.description}</span> : null}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </aside>
  )
}
