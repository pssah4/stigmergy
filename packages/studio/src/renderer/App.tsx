// App shell for Stigmergy Studio (FEAT-03-01/02, n8n-oriented layout in FEAT-03-08). A persistent
// left rail selects the right-hand panel; the centre is the capability map; the header carries the
// editor toggle and live counts. Read-mode and edit-mode stay strictly apart (ASR #1): in read mode
// a node/edge click selects for inspection, in edit mode a node click builds the path to pin.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { START_NODE, type PinBehavior } from '@agentic-stigmergy/core'
import { toGraphModel, TYPE_COLORS, type SubstrateSnapshot, type GraphNode, type GraphEdge } from '../shared/graph-model.js'
import { pathNodeIds, pathLabel, pathEdgeKeys } from '../shared/path-view.js'
import type { EditCommand } from '../shared/edit-commands.js'
import { initialEditState, toggleMode, clickNode, clearPath, appendNode } from '../shared/path-editor.js'
import { AntMap } from './AntMap.js'
import { DetailPanel, type Selection } from './DetailPanel.js'
import { EditPanel } from './EditPanel.js'
import { PalettePanel } from './PalettePanel.js'
import { OperationsPanel } from './OperationsPanel.js'
import { SettingsPanel } from './SettingsPanel.js'
import { Welcome } from './Welcome.js'
import { OnboardingWizard } from './OnboardingWizard.js'
import { TopBar, type StudioView } from './TopBar.js'
import { StatusBar } from './StatusBar.js'
import { IconButton, Toggle } from './components.js'
import { surfaceStyle, tokens } from '../shared/design-tokens.js'

const EMPTY: SubstrateSnapshot = { capabilities: [], edges: [], pinnedPaths: [] }

// Always-on key so the map explains itself (FEAT-06-05): what the dots, arrows, thickness and colours
// mean. Edge colours mirror the private constants in graph-model (gray = learned, red = pinned).
function GraphLegend({ chain }: { chain: boolean }): JSX.Element {
  const dot = (color: string): JSX.Element => <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
  const bar = (color: string, height: number): JSX.Element => <span style={{ width: 16, height, background: color, display: 'inline-block', flexShrink: 0 }} />
  const item = (swatch: JSX.Element, text: string): JSX.Element => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {swatch}
      <span>{text}</span>
    </span>
  )
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: 12,
        zIndex: 2,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        fontSize: 11,
        color: tokens.color.textMuted,
        background: 'rgba(30,30,30,0.74)',
        border: `1px solid ${tokens.color.border}`,
        borderRadius: 6,
        padding: '5px 9px',
        maxWidth: '72%',
        pointerEvents: 'none', // purely informational: let clicks pass through to the graph below
      }}
    >
      {item(dot(TYPE_COLORS.tool ?? '#4f86c6'), 'tool')}
      {item(dot(TYPE_COLORS.start ?? '#888888'), 'Start (entry)')}
      {item(bar('#bbbbbb', 2), 'learned step, arrow = order')}
      {item(bar('#bbbbbb', 5), 'thicker = used more often')}
      {item(bar('#e06c75', 5), 'saved workflow')}
      {chain ? <span style={{ opacity: 0.9 }}>selected workflow: steps left to right (1..N)</span> : null}
    </div>
  )
}

// Workflow-lens chip (FEAT-06-05): the active chip carries the accent; others are neutral pills.
function chipStyle(active: boolean): CSSProperties {
  return {
    padding: '3px 10px',
    borderRadius: 12,
    border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
    background: active ? tokens.color.accent : tokens.color.surfaceRaised,
    color: active ? tokens.color.accentText : tokens.color.text,
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  }
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<SubstrateSnapshot>(EMPTY)
  const [error, setError] = useState<string | undefined>(undefined)
  const [substratePath, setSubstratePath] = useState<string>('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [highlightedPathId, setHighlightedPathId] = useState<string | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [editState, setEditState] = useState(initialEditState)
  const [editError, setEditError] = useState<string | undefined>(undefined)
  const [view, setView] = useState<StudioView>('detail')
  // Deep-link a Settings tab (FEAT-06-08): the Welcome "connect" nudge opens Settings on the Connection
  // tab, since Connect loop now lives there instead of in the rail.
  const [settingsInitialTab, setSettingsInitialTab] = useState<'connection' | undefined>(undefined)
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const [connectedProject, setConnectedProject] = useState('')
  // First-run onboarding gate (FEAT-05-05, IMP-05-05-01): show the wizard until the operator finishes
  // it once. Once completed, the wizard is the only setup surface; no post-wizard Welcome prompt.
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(true)
  // Graph scope (FEAT-06-09): off = only the learned structure (connected nodes); on = the full tool
  // inventory including unused capabilities. The trail/workflow lens is a second selection level below it.
  const [showAllTools, setShowAllTools] = useState(false)

  useEffect(() => {
    void window.studio.getSettings().then((s) => {
      setOnboardingCompleted(s.onboarding.completed)
      setShowOnboarding(!s.onboarding.completed)
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.studio.onSubstrate((message) => {
      setSnapshot(message.snapshot)
      setError(message.error)
      // The active path rides on every push, so the header stays current after a settings-driven switch.
      if (message.substratePath) setSubstratePath(message.substratePath)
      if (message.connectedProject !== undefined) setConnectedProject(message.connectedProject)
    })
    void window.studio.substratePath().then(setSubstratePath)
    return unsubscribe
  }, [])

  // FEAT-06-05: suppress the gray Start fan-out so the map shows the meaningful capability-to-capability
  // edges, not a "Start touches everything" hairball.
  const graph = useMemo(() => toGraphModel(snapshot, { hideStartFanout: true, connectedOnly: !showAllTools }), [snapshot, showAllTools])
  const editing = editState.mode === 'edit'

  // Re-show the welcome when the memory goes back to empty (e.g. after a reset); a dismissal is
  // otherwise sticky for the session. The left-rail "Connect loop" is always available regardless.
  const everHadContent = useRef(false)
  useEffect(() => {
    if (graph.nodes.length > 0) {
      everHadContent.current = true
    } else if (everHadContent.current) {
      everHadContent.current = false
      setWelcomeDismissed(false)
    }
  }, [graph.nodes.length])

  async function dispatchEdit(command: EditCommand): Promise<boolean> {
    const result = await window.studio.edit(command)
    setEditError(result.ok ? undefined : result.error)
    return result.ok
  }

  function handleToggleMode(): void {
    setEditState(toggleMode(editState))
    setSelection(null)
    setEditError(undefined)
  }

  // The master Active toggle (FEAT-06-08): Stigmergy is only really active when BOTH the enabled flag is
  // set AND the Studio-managed daemon runs (the connected loop talks to the daemon, FEAT-04-04). So the
  // toggle drives both in lockstep: on starts the daemon and sets enabled; off stops the daemon and clears
  // enabled. Stopping the daemon does not blank the Studio (it reads the substrate file directly, not via
  // the daemon). A daemon start that fails (e.g. another daemon holds the role lock) is not silent: the
  // status bar surfaces the daemon error. The enabled flag is still written on, so an embedded (no-daemon)
  // loop also works; the daemon error there is benign.
  function handleSetEnabled(v: boolean): void {
    if (v) {
      void window.studio.setEnabled(true)
      void window.studio.startDaemon().catch(() => undefined)
    } else {
      void window.studio.setEnabled(false)
      void window.studio.stopDaemon().catch(() => undefined)
    }
  }

  function selectView(next: StudioView): void {
    setView(next)
    // Picking a panel from the rail leaves the editor so the chosen panel is actually shown.
    setEditState((s) => (s.mode === 'edit' ? { mode: 'read', path: [] } : s))
    setPanelCollapsed(false) // a rail click means the user wants that panel: expand it (FEAT-06-02)
    setSettingsInitialTab(undefined) // a rail click to Settings opens its default tab, not a deep-link
  }

  function handleSelectNode(node: GraphNode): void {
    // A graph node click in edit mode toggles the step (clickNode pops the last on a repeat click). Start
    // is the nest sentinel, never a path step, so clicking it is a no-op in edit mode.
    if (editing) {
      if (node.id === START_NODE) return
      setEditState((s) => clickNode(s, node.id))
    } else setSelection({ kind: 'node', node })
  }

  // Compose from the Builder palette / successor chips: ensure edit mode, then APPEND (no pop-on-last,
  // since an explicit add always means "add this", unlike a graph node click).
  function handleAddToPath(capabilityId: string): void {
    if (capabilityId === START_NODE) return
    setEditState((s) => appendNode(s.mode === 'edit' ? s : toggleMode(s), capabilityId))
  }

  // Drag-to-connect in the graph (FEAT-06-06): a directed drag from -> to always appends, honouring the
  // drawn source. Seed `from` unless it is already the tail (covers the empty path too), then append
  // `to`. Append-only, so dragging onto the current last node builds a revisit instead of undoing it.
  // Start is the nest sentinel, never a step.
  function handleConnect(from: string, to: string): void {
    if (from === START_NODE || to === START_NODE) return
    setEditState((s) => {
      if (s.mode !== 'edit') return s
      const last = s.path[s.path.length - 1]
      const seeded = last === from ? s : appendNode(s, from)
      return appendNode(seeded, to)
    })
  }

  function handleSelectEdge(edge: GraphEdge): void {
    if (!editing) setSelection({ kind: 'edge', edge })
  }

  // FEAT-06-05: the workflow-lens chips and the DetailPanel path rows both drive this single selection,
  // so picker and list stay in lockstep. Clicking the active trail again returns to "All trails".
  function toggleHighlightedPath(id: string): void {
    setHighlightedPathId((prev) => (prev === id ? null : id))
  }

  async function handlePin(name: string, behavior: PinBehavior): Promise<void> {
    const ok = await dispatchEdit({ kind: 'pin', name: name || undefined, behavior, capabilitySequence: editState.path })
    if (ok) setEditState((s) => clearPath(s))
  }

  // reinforcePath/weakenPath always bump the trail START->path[0]->..., so an edge out of START maps
  // exactly to [target]; a mid-graph edge has no isolated engine op, so reinforce/weaken is offered
  // only on START edges (an edge-level op in the engine is the follow-up).
  function edgeIsReinforceable(edge: GraphEdge): boolean {
    return edge.source === START_NODE
  }

  function rightPanel(): JSX.Element {
    // The editor inspector belongs to the Graph view; the palette composes in edit mode but keeps its
    // own panel, so only show EditPanel while the Graph is the active view.
    if (editing && view === 'detail')
      return (
        <EditPanel
          path={editState.path}
          snapshot={snapshot}
          onAdd={handleAddToPath}
          onRemoveLast={() => setEditState((s) => ({ ...s, path: s.path.slice(0, -1) }))}
          onPin={handlePin}
          onClear={() => setEditState((s) => clearPath(s))}
          onDelete={(pathId) => void dispatchEdit({ kind: 'unpin', pathId })}
        />
      )
    if (view === 'palette')
      return (
        <PalettePanel
          snapshot={snapshot}
          composedPath={editState.path}
          onAdd={handleAddToPath}
          onPin={(behavior) => void handlePin('', behavior)}
          onClear={() => setEditState((s) => clearPath(s))}
        />
      )
    if (view === 'ops') return <OperationsPanel snapshot={snapshot} />
    if (view === 'settings')
      return (
        <SettingsPanel
          enabled={snapshot.enabled ?? false}
          onSetEnabled={handleSetEnabled}
          onRerunOnboarding={() => setShowOnboarding(true)}
          substratePath={substratePath}
          connectedProject={connectedProject}
          initialTab={settingsInitialTab}
        />
      )
    return (
      <DetailPanel
        selection={selection}
        pinnedPaths={snapshot.pinnedPaths ?? []}
        highlightedPathId={highlightedPathId}
        canReinforceEdge={edgeIsReinforceable}
        onReinforce={(edge, strength) => void dispatchEdit({ kind: 'reinforce', path: [edge.target], strength })}
        onWeaken={(edge, strength) => void dispatchEdit({ kind: 'weaken', path: [edge.target], strength })}
        onUnpin={(pathId) => void dispatchEdit({ kind: 'unpin', pathId })}
        onSelectPath={(p) => toggleHighlightedPath(p.id)}
        onDeleteEdge={(edge) => {
          void dispatchEdit({ kind: 'deleteEdge', from: edge.source, to: edge.target })
          setSelection(null) // the selected edge is gone; clear so the panel does not show a stale row
        }}
      />
    )
  }

  // FEAT-06-01: in read mode, highlight the nodes of the selected pinned path; edit mode keeps the
  // path-under-construction highlight. A selected path that was unpinned resolves to no highlight.
  const highlightedPath = (snapshot.pinnedPaths ?? []).find((p) => p.id === highlightedPathId)
  // Memoised so their identity is stable across renders; AntMap's sync effect then re-runs only when the
  // lens actually changes, not on every parent render.
  const pathHighlight = useMemo(() => (highlightedPath ? pathNodeIds(highlightedPath) : []), [highlightedPath])

  // FEAT-06-05: the workflow lens shows only over the read-mode graph (edit mode owns its own
  // highlight). With a trail selected, the map dims everything outside it.
  const pinnedPaths = snapshot.pinnedPaths ?? []
  const showLens = view === 'detail' && !editing && pinnedPaths.length > 0
  // The lensed trail's consecutive step edges and node ids; the map lights only these under the lens.
  const lensEdges = useMemo(() => (highlightedPath ? pathEdgeKeys(highlightedPath) : []), [highlightedPath])
  // Dim only when the lens can actually be controlled (chip row visible) AND at least one of its nodes is
  // on the map: gating on showLens stops the dim outliving its chip row when the rail switches away, and
  // the intersection check stops a trail whose capabilities are absent from washing the whole map to gray.
  const graphNodeIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph])
  const lensActive = showLens && highlightedPath !== undefined && pathHighlight.some((id) => graphNodeIds.has(id))
  // With a workflow lensed, lay its steps out as a straight left-to-right chain (read as 1..N) instead of
  // the force scatter, so a single trail is legible as an ordered recipe (FEAT-06-05).
  const chainOrder = useMemo(
    () => (lensActive && highlightedPath ? highlightedPath.capabilitySequence.filter((id) => graphNodeIds.has(id)) : []),
    [lensActive, highlightedPath, graphNodeIds],
  )
  // The path being built (edit mode) is drawn as gold draft edges in the graph (FEAT-06-07), so a
  // brand-new connection shows immediately, before it is saved into the substrate.
  const draftPath = useMemo(() => (editing && view === 'detail' ? editState.path : []), [editing, view, editState.path])

  return (
    <div style={{ ...surfaceStyle(), display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>
      {showOnboarding ? (
        <OnboardingWizard
          substrateError={error}
          enabled={snapshot.enabled ?? false}
          connectedProject={connectedProject}
          substratePath={substratePath}
          onActivate={handleSetEnabled}
          onComplete={() => {
            setShowOnboarding(false)
            setOnboardingCompleted(true)
          }}
        />
      ) : null}
      <TopBar
        connectedProject={connectedProject}
        enabled={snapshot.enabled ?? false}
        onSetEnabled={handleSetEnabled}
        showEditToggle={view === 'detail'}
        editing={editing}
        onToggleEdit={handleToggleMode}
        view={view}
        onSelectView={selectView}
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 0, zIndex: 1 }}>
          <div style={{ position: 'absolute', top: 10, right: 12, zIndex: 2, display: 'flex', gap: 6, background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, boxShadow: tokens.shadow.sm, padding: 3 }}>
            <IconButton onClick={() => setPanelCollapsed((c) => !c)} active={panelCollapsed} title={panelCollapsed ? 'Show the side panel' : 'Hide the side panel, work in the graph only'}>
              {panelCollapsed ? 'Show panel' : 'Graph only'}
            </IconButton>
          </div>
        {view === 'detail' && !editing ? (
          <div style={{ position: 'absolute', top: 10, left: 12, zIndex: 2, maxWidth: 'calc(100% - 200px)', minWidth: 160, background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, boxShadow: tokens.shadow.sm, padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Level 1: scope of the graph -- only the learned structure, or the full tool inventory. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <span style={{ opacity: 0.6, flexShrink: 0 }} title="Off: only the tools and connections Stigmergy has learned. On: every discovered tool, including unused ones.">
                Show:
              </span>
              <Toggle on={showAllTools} onChange={setShowAllTools} title={showAllTools ? 'Showing all tools' : 'Showing the learned structure only'} />
              <span style={{ opacity: 0.85, flexShrink: 0 }}>{showAllTools ? 'All tools' : 'Learned only'}</span>
            </div>
            {/* Level 2: which learned workflow to isolate on the map (only when there are saved paths). */}
            {pinnedPaths.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, overflowX: 'auto', borderTop: `1px solid ${tokens.color.border}`, paddingTop: 6 }}>
                <span style={{ opacity: 0.6, marginRight: 2, flexShrink: 0 }} title="Filter the map to a single learned workflow">
                  Workflow:
                </span>
                <button onClick={() => setHighlightedPathId(null)} style={chipStyle(!highlightedPath)} title="Show all learned trails">
                  All trails
                </button>
                {pinnedPaths.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => toggleHighlightedPath(p.id)}
                    style={chipStyle(highlightedPathId === p.id)}
                    title={p.whenToUse ? `Use when: ${p.whenToUse}` : 'Isolate this workflow on the map'}
                  >
                    {pathLabel(p)}
                  </button>
                ))}
              </div>
            ) : null}
            {highlightedPath?.whenToUse ? (
              <div style={{ opacity: 0.6, fontSize: 12 }}>Use when: {highlightedPath.whenToUse}</div>
            ) : null}
          </div>
        ) : null}
        <AntMap
          graph={graph}
          highlightNodes={editing ? editState.path : view === 'detail' ? pathHighlight : []}
          lensEdges={lensEdges}
          chainOrder={chainOrder}
          draftPath={draftPath}
          dimOthers={lensActive}
          editing={editing && view === 'detail'}
          onConnect={handleConnect}
          onSelectNode={handleSelectNode}
          onSelectEdge={handleSelectEdge}
          onClearSelection={() => setSelection(null)}
        />
        {graph.nodes.length > 0 ? <GraphLegend chain={chainOrder.length > 0} /> : null}
        {!showOnboarding && !onboardingCompleted && graph.nodes.length === 0 && !welcomeDismissed && !connectedProject ? (
          <Welcome
            substratePath={substratePath}
            onConnect={() => {
              // Same view-entry resets as selectView (leave edit mode, expand the panel), but keep the
              // deep-link to the Connection tab, which selectView would otherwise clear.
              setSettingsInitialTab('connection')
              setView('settings')
              setEditState((s) => (s.mode === 'edit' ? { mode: 'read', path: [] } : s))
              setPanelCollapsed(false)
              setWelcomeDismissed(true)
            }}
            onDismiss={() => setWelcomeDismissed(true)}
          />
        ) : null}
        {view === 'detail' && !editing && !showOnboarding && connectedProject && graph.nodes.length === 0 && !showAllTools ? (
          // Learned-only view with nothing learned yet: explain the empty graph and offer the inventory.
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ pointerEvents: 'auto', textAlign: 'center', maxWidth: 340, background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.lg, boxShadow: tokens.shadow.md, padding: tokens.space[4], color: tokens.color.textMuted, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ color: tokens.color.text, fontWeight: tokens.font.weight.medium, marginBottom: 6 }}>No learned connections yet</div>
              As your agent runs tools, the paths it takes appear here. The {snapshot.capabilities.length} discovered tools live under <strong>Add tools</strong>.
              <div style={{ marginTop: 10 }}>
                <button onClick={() => setShowAllTools(true)} style={chipStyle(false)}>
                  Show all tools
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
        {panelCollapsed ? null : rightPanel()}
      </div>
      <StatusBar capabilityCount={snapshot.capabilities.length} pathCount={snapshot.edges.length} substratePath={substratePath} error={error} editError={editError} />
    </div>
  )
}
