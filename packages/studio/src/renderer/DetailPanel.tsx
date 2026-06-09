// Read-mode inspector (FEAT-03-01/02, relabelled in FEAT-03-08). Lists the locked-in paths (with
// unlock) and the selected node/edge, with strengthen/weaken on a selected edge. Plain-language
// labels from labels.ts; technical terms in the title tooltips.
import { useEffect, useState, type CSSProperties } from 'react'
import type { ConnectionTask, GraphNode, GraphEdge, PinnedPathView } from '../shared/graph-model.js'
import { filterPinnedPaths, pathLabel } from '../shared/path-view.js'
import { LABELS } from '../shared/labels.js'
import { tokens } from '../shared/design-tokens.js'

export type Selection = { kind: 'node'; node: GraphNode } | { kind: 'edge'; edge: GraphEdge }

interface DetailPanelProps {
  selection: Selection | null
  pinnedPaths: PinnedPathView[]
  /** The pinned path whose nodes are highlighted in the graph (FEAT-06-01), or null. */
  highlightedPathId: string | null
  canReinforceEdge: (edge: GraphEdge) => boolean
  onReinforce: (edge: GraphEdge, strength: number) => void
  onWeaken: (edge: GraphEdge, strength: number) => void
  onUnpin: (pathId: string) => void
  /** Toggle which pinned path is highlighted in the graph (FEAT-06-01). */
  onSelectPath: (path: PinnedPathView) => void
  /** Delete a single learned connection (FIX-06-06-01). Disabled for an edge that a saved path covers. */
  onDeleteEdge: (edge: GraphEdge) => void
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
  padding: '3px 9px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}
const labelStyle: CSSProperties = { opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }

function Row({ label, value, title }: { label: string; value: string; title?: string }): JSX.Element {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={labelStyle} title={title}>
        {label}
      </div>
      <div style={{ wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}

function PinnedPaths({
  paths,
  highlightedPathId,
  onUnpin,
  onSelectPath,
}: {
  paths: PinnedPathView[]
  highlightedPathId: string | null
  onUnpin: (id: string) => void
  onSelectPath: (path: PinnedPathView) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const shown = filterPinnedPaths(paths, query)
  return (
    <section style={{ marginBottom: 18 }}>
      <h2 style={{ ...labelStyle, marginTop: 0 }} title={LABELS.pinned.tooltip}>
        {LABELS.pinnedPathsCount.label} ({paths.length})
      </h2>
      <div style={{ opacity: 0.5, fontSize: 11, marginBottom: 8 }}>Routes you saved to prefer or enforce. The full learned graph lives in the Memory tab.</div>
      {paths.length === 0 ? (
        <div style={{ opacity: 0.5 }}>No saved paths yet.</div>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search paths..."
            style={{ display: 'block', width: '100%', marginBottom: 8, padding: '4px 6px', background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}
          />
          {shown.length === 0 ? (
            <div style={{ opacity: 0.5 }}>No path matches that search.</div>
          ) : (
            shown.map((p) => {
              const selected = p.id === highlightedPathId
              return (
                <div
                  key={p.id}
                  onClick={() => onSelectPath(p)}
                  title="Click to highlight this path in the graph"
                  style={{
                    marginBottom: 8,
                    borderBottom: `1px solid ${tokens.color.border}`,
                    paddingBottom: 8,
                    paddingLeft: 6,
                    cursor: 'pointer',
                    background: selected ? tokens.color.surfaceRaised : undefined,
                    borderLeft: `2px solid ${selected ? tokens.color.text : 'transparent'}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <strong>{pathLabel(p)}</strong>
                    <button
                      style={buttonStyle}
                      onClick={(e) => {
                        e.stopPropagation()
                        onUnpin(p.id)
                      }}
                      title={LABELS.unpin.tooltip}
                    >
                      {LABELS.unpin.label}
                    </button>
                  </div>
                  <div style={{ opacity: 0.6, fontSize: 11 }}>{p.behavior}</div>
                  {selected ? (
                    // The selected workflow expands into a numbered recipe, so its step order reads clearly
                    // without deciphering the force-graph path (FEAT-06-05).
                    <ol style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 12, opacity: 0.85 }}>
                      {p.capabilitySequence.map((c, i) => (
                        <li key={`${c}-${i}`}>{c}</li>
                      ))}
                    </ol>
                  ) : (
                    <div style={{ opacity: 0.8, fontSize: 12 }}>{p.capabilitySequence.join(' -> ')}</div>
                  )}
                  {p.whenToUse ? (
                    <div style={{ opacity: 0.55, fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>Use when: {p.whenToUse}</div>
                  ) : null}
                </div>
              )
            })
          )}
        </>
      )}
    </section>
  )
}

function EdgeActions({
  edge,
  reinforceable,
  onReinforce,
  onWeaken,
}: {
  edge: GraphEdge
  reinforceable: boolean
  onReinforce: (edge: GraphEdge, strength: number) => void
  onWeaken: (edge: GraphEdge, strength: number) => void
}): JSX.Element {
  const [strength, setStrength] = useState(0.1)
  if (!reinforceable) {
    return (
      <div style={{ marginTop: 8, opacity: 0.5, fontSize: 12 }}>
        Strengthen/Weaken is only available on start edges (edge-level is a follow-up).
      </div>
    )
  }
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ display: 'block', marginBottom: 6, opacity: 0.7, fontSize: 12 }}>
        {LABELS.strength.label}
        <input
          type="number"
          min={0.01}
          max={1}
          step={0.05}
          value={strength}
          onChange={(e) => setStrength(Number(e.target.value))}
          style={{ marginLeft: 8, width: 70, background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={buttonStyle} onClick={() => onReinforce(edge, strength)} title={LABELS.reinforce.tooltip}>
          {LABELS.reinforce.label}
        </button>
        <button style={buttonStyle} onClick={() => onWeaken(edge, strength)} title={LABELS.weaken.tooltip}>
          {LABELS.weaken.label}
        </button>
      </div>
    </div>
  )
}

function ConnectionTasks({ edge }: { edge: GraphEdge }): JSX.Element {
  // Edge provenance (BL-012): a learned connection has no name, its meaning is the tasks that formed it.
  // Fetch the recent tasks that traversed this from -> to so the operator sees "what it was learned for".
  const [tasks, setTasks] = useState<ConnectionTask[] | null>(null)
  useEffect(() => {
    let active = true
    setTasks(null)
    void window.studio
      .connectionTasks(edge.source, edge.target)
      .then((t) => active && setTasks(t))
      .catch(() => active && setTasks([]))
    return () => {
      active = false
    }
  }, [edge.source, edge.target])

  return (
    <div style={{ marginTop: 12 }}>
      <div style={labelStyle} title="The tasks whose run laid down this connection">
        What it was learned for
      </div>
      {tasks === null ? (
        <div style={{ opacity: 0.5, fontSize: 12, marginTop: 4 }}>Loading...</div>
      ) : tasks.length === 0 ? (
        <div style={{ opacity: 0.5, fontSize: 12, marginTop: 4 }}>No recorded task used this connection yet.</div>
      ) : (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
          {tasks.map((t, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              <span style={{ opacity: 0.85 }}>{t.context || '(no description)'}</span>
              {t.outcome ? <span style={{ opacity: 0.5 }}> ({t.outcome})</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DeleteEdgeAction({ edge, onDeleteEdge }: { edge: GraphEdge; onDeleteEdge: (edge: GraphEdge) => void }): JSX.Element {
  // A pinned edge belongs to a saved path; deleting it would orphan that path, so route the user to
  // unpin instead (the engine refuses it too). Only a learned connection is directly deletable.
  if (edge.pinned) {
    return (
      <div style={{ marginTop: 12, opacity: 0.5, fontSize: 12 }}>
        This connection is part of a saved path. Remove it by unpinning that path above.
      </div>
    )
  }
  return (
    <button
      style={{ ...buttonStyle, marginTop: 12, borderColor: tokens.color.danger, color: tokens.color.danger }}
      onClick={() => onDeleteEdge(edge)}
      title="Delete this learned connection from the graph"
    >
      Delete connection
    </button>
  )
}

export function DetailPanel({ selection, pinnedPaths, highlightedPathId, canReinforceEdge, onReinforce, onWeaken, onUnpin, onSelectPath, onDeleteEdge }: DetailPanelProps): JSX.Element {
  return (
    <aside style={panelStyle}>
      <PinnedPaths paths={pinnedPaths} highlightedPathId={highlightedPathId} onUnpin={onUnpin} onSelectPath={onSelectPath} />
      {!selection ? (
        <div style={{ opacity: 0.5 }}>{LABELS.selectHint.label}</div>
      ) : selection.kind === 'node' ? (
        <section>
          <h2 style={{ fontSize: 15, marginTop: 0 }} title={LABELS.capability.tooltip}>
            {selection.node.label}
          </h2>
          <Row label="Type" value={selection.node.nodeType} />
          <Row label="Description" value={selection.node.description || '(none)'} />
        </section>
      ) : (
        <section>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Connection</h2>
          <Row label="From" value={selection.edge.source} />
          <Row label="To" value={selection.edge.target} />
          <Row label={LABELS.pathStrength.label} value={selection.edge.pheromone.toFixed(3)} title={LABELS.pathStrength.tooltip} />
          <Row label={LABELS.pinned.label} value={selection.edge.pinned ? 'yes' : 'no'} title={LABELS.pinned.tooltip} />
          <ConnectionTasks key={`${selection.edge.source}->${selection.edge.target}`} edge={selection.edge} />
          <EdgeActions
            key={`act-${selection.edge.source}->${selection.edge.target}`}
            edge={selection.edge}
            reinforceable={canReinforceEdge(selection.edge)}
            onReinforce={onReinforce}
            onWeaken={onWeaken}
          />
          <DeleteEdgeAction edge={selection.edge} onDeleteEdge={onDeleteEdge} />
        </section>
      )}
    </aside>
  )
}
