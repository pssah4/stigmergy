// Build-mode panel (FEAT-03-02, guided builder in FEAT-06-06). Plain-language labels come from
// labels.ts; the technical term (pin, enforce, ...) lives in the title tooltip. The operator builds a
// path by searching a capability and adding it as the next step, by picking a learned successor of the
// last step, or by clicking / dragging in the graph. The same panel lists saved paths with a real
// Delete (which also drops the edges the pin created, see engine.deletePath).
import { useState, type CSSProperties } from 'react'
import type { PinBehavior } from '@agentic-stigmergy/core'
import type { SubstrateSnapshot } from '../shared/graph-model.js'
import { successorCandidates, filterCapabilities, pathLabel } from '../shared/path-view.js'
import { LABELS } from '../shared/labels.js'
import { tokens } from '../shared/design-tokens.js'

interface EditPanelProps {
  path: string[]
  snapshot: SubstrateSnapshot
  onAdd: (capabilityId: string) => void
  onRemoveLast: () => void
  onPin: (name: string, behavior: PinBehavior) => void
  onClear: () => void
  onDelete: (pathId: string) => void
}

const panelStyle: CSSProperties = {
  width: 340,
  flexShrink: 0,
  borderLeft: `1px solid ${tokens.color.border}`,
  padding: '16px 18px',
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
}

const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}

const addChipStyle: CSSProperties = {
  padding: '3px 9px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
  fontSize: 12,
  textAlign: 'left',
}

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '4px 6px',
  background: tokens.color.bg,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
}

const sectionLabel: CSSProperties = { opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }

const BEHAVIORS: { value: PinBehavior; label: string; tooltip?: string }[] = [
  { value: 'preferred', label: LABELS.behaviorPreferred.label, tooltip: LABELS.behaviorPreferred.tooltip },
  { value: 'enforce', label: LABELS.behaviorEnforce.label, tooltip: LABELS.behaviorEnforce.tooltip },
  { value: 'sequence', label: LABELS.behaviorSequence.label, tooltip: LABELS.behaviorSequence.tooltip },
]

// Keep the search list bounded so a large inventory does not render hundreds of rows at once.
const MAX_LIST = 40

export function EditPanel({ path, snapshot, onAdd, onRemoveLast, onPin, onClear, onDelete }: EditPanelProps): JSX.Element {
  const [name, setName] = useState('')
  const [behavior, setBehavior] = useState<PinBehavior>('preferred')
  const [suggesting, setSuggesting] = useState(false)
  const [nameSource, setNameSource] = useState<'llm' | 'fallback' | null>(null)
  const [query, setQuery] = useState('')
  const canPin = path.length >= 1

  const last = path[path.length - 1]
  const successors = last ? successorCandidates(snapshot.edges ?? [], last) : []
  const matches = filterCapabilities(snapshot.capabilities ?? [], query)
  const pinned = snapshot.pinnedPaths ?? []

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: 15, marginTop: 0 }} title={LABELS.editModeOn.tooltip}>
        {LABELS.buildPath.label}
      </h2>
      <p style={{ opacity: 0.6, fontSize: 12 }}>{LABELS.buildPathHint.label}</p>

      <div style={{ marginBottom: 12 }}>
        <div style={sectionLabel}>Path ({path.length})</div>
        {path.length === 0 ? (
          <div style={{ opacity: 0.5 }}>empty</div>
        ) : (
          <>
            <ol style={{ margin: '4px 0', paddingLeft: 20 }}>
              {path.map((id, i) => (
                <li key={`${id}-${i}`} style={{ wordBreak: 'break-word' }}>
                  {id}
                </li>
              ))}
            </ol>
            <button style={{ ...buttonStyle, padding: '3px 9px', fontSize: 12 }} onClick={onRemoveLast} title="Remove the last step">
              Remove last
            </button>
          </>
        )}
      </div>

      {successors.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <div style={sectionLabel} title={`Capabilities linked after ${last} (learned or pinned), strongest first`}>
            Suggested next step
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {successors.slice(0, 8).map((id) => (
              <button key={id} style={addChipStyle} onClick={() => onAdd(id)} title={`Add ${id} as the next step`}>
                + {id}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ marginBottom: 12 }}>
        <div style={sectionLabel}>Add a capability</div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tools, skills, MCP..." style={{ ...inputStyle, marginTop: 4, marginBottom: 6 }} />
        {matches.length === 0 ? (
          <div style={{ opacity: 0.5 }}>No capability matches that search.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {matches.slice(0, MAX_LIST).map((c) => (
              <button key={c.id} style={addChipStyle} onClick={() => onAdd(c.id)} title={c.description || c.id}>
                + {c.id}
              </button>
            ))}
            {matches.length > MAX_LIST ? <div style={{ opacity: 0.5, fontSize: 11 }}>and {matches.length - MAX_LIST} more, narrow the search</div> : null}
          </div>
        )}
      </div>

      <label style={{ display: 'block', marginBottom: 6 }}>
        <span style={sectionLabel}>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research workflow" style={{ ...inputStyle, marginTop: 4 }} />
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          style={{ ...buttonStyle, opacity: canPin && !suggesting ? 1 : 0.4, cursor: canPin && !suggesting ? 'pointer' : 'not-allowed' }}
          disabled={!canPin || suggesting}
          onClick={() => {
            setSuggesting(true)
            void window.studio
              .proposeName(path)
              .then((proposed) => {
                setName(proposed.name)
                setNameSource(proposed.namedBy)
              })
              .catch(() => setNameSource(null))
              .finally(() => setSuggesting(false))
          }}
        >
          {suggesting ? 'Suggesting ...' : LABELS.suggestName.label}
        </button>
        {nameSource === 'fallback' ? <span style={{ opacity: 0.5, fontSize: 11 }}>Suggested without AI (no provider)</span> : null}
      </div>

      <fieldset style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm, marginBottom: 12, padding: '8px 10px' }}>
        <legend style={sectionLabel} title={LABELS.pinned.tooltip}>
          {LABELS.behaviorLabel.label}
        </legend>
        {BEHAVIORS.map((b) => (
          <label key={b.value} style={{ display: 'block', marginBottom: 4 }} title={b.tooltip}>
            <input type="radio" name="behavior" checked={behavior === b.value} onChange={() => setBehavior(b.value)} /> {b.label}
          </label>
        ))}
      </fieldset>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button style={{ ...buttonStyle, opacity: canPin ? 1 : 0.4, cursor: canPin ? 'pointer' : 'not-allowed' }} disabled={!canPin} onClick={() => onPin(name, behavior)} title={LABELS.save.tooltip}>
          {LABELS.save.label}
        </button>
        <button style={buttonStyle} onClick={onClear} disabled={path.length === 0} title="Discard the path you are building (saved paths are not affected)">
          {LABELS.clear.label}
        </button>
      </div>

      <section>
        <div style={sectionLabel} title={LABELS.pinned.tooltip}>
          {LABELS.pinnedPathsCount.label} ({pinned.length})
        </div>
        {pinned.length === 0 ? (
          <div style={{ opacity: 0.5, marginTop: 4 }}>No saved paths yet.</div>
        ) : (
          pinned.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', marginTop: 6, borderBottom: `1px solid ${tokens.color.border}`, paddingBottom: 6 }}>
              <span style={{ wordBreak: 'break-word' }}>{pathLabel(p)}</span>
              <button style={{ ...buttonStyle, padding: '3px 9px', fontSize: 12 }} onClick={() => onDelete(p.id)} title="Delete this saved path and the edges it created (real run history stays)">
                Delete
              </button>
            </div>
          ))
        )}
      </section>
    </aside>
  )
}
