// First-run welcome / empty-state (FEAT-03-08, SC-04). Shown over the map when nothing has been
// learned yet. Answers the three things a newcomer is missing: what Stigmergy does, that a developer
// wires the loop once (it will not fill itself), and where the "path" comes from (your loop's project
// folder, not a URL).
import type { CSSProperties } from 'react'
import { Button } from './components.js'

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(30,33,39,0.92)',
}
const cardStyle: CSSProperties = {
  maxWidth: 560,
  padding: '28px 32px',
  border: '1px solid #30343c',
  borderRadius: 8,
  background: '#23262d',
  lineHeight: 1.6,
}

export function Welcome({
  substratePath,
  onConnect,
  onDismiss,
}: {
  substratePath: string
  onConnect: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: 20, marginTop: 0 }}>Welcome to Stigmergy Studio</h1>
        <p>
          Stigmergy learns which tools your agent loop reaches for, by watching it run. Right now it has watched
          nothing, so the map is empty. That is normal.
        </p>
        <p style={{ opacity: 0.85 }}>Two things happen before the map fills:</p>
        <ol style={{ opacity: 0.85, marginTop: 0 }}>
          <li>A developer wires the loop once (a small snippet).</li>
          <li>The loop runs one task. The first trail appears.</li>
        </ol>
        <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
          <Button variant="primary" onClick={onConnect}>
            Connect your agent loop
          </Button>
          <Button variant="default" onClick={onDismiss}>
            I'll just look around
          </Button>
        </div>
        <div style={{ opacity: 0.5, fontSize: 12, marginTop: 16 }}>
          Watching: {substratePath || '~/.stigmergy/pheromone.db'}
        </div>
      </div>
    </div>
  )
}
