// Ant-Map: the Sigma.js graph view of the substrate (FEAT-03-01, SC-01..05). Capabilities are
// coloured nodes, pheromone paths are edges whose thickness encodes pheromone strength, pinned
// paths are highlighted. The renderable model comes from the unit-tested toGraphModel; this file
// only wires it into graphology/Sigma and forwards hover/click selection up to App.
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import '@react-sigma/core/lib/style.css'
import { graphSignature, type GraphModel, type GraphNode, type GraphEdge } from '../shared/graph-model.js'
import { tokens } from '../shared/design-tokens.js'
import type { Settings } from 'sigma/settings'
import type { NodeDisplayData, PartialButFor } from 'sigma/types'

interface AntMapProps {
  graph: GraphModel
  /** Node ids on the path under construction (edit mode); highlighted on the map for live feedback. */
  highlightNodes?: string[]
  /** Workflow lens (FEAT-06-05): when set, every non-highlighted node and every edge that is not a step
   * of the lensed trail fades to a low-opacity wash, so the trail stands out. */
  dimOthers?: boolean
  /** The lensed trail's consecutive step keys ("source->target"); only these edges stay bright under the
   * lens, so a learned shortcut or back-edge among the trail's nodes is not mistaken for a step. */
  lensEdges?: string[]
  /** The lensed trail's node ids in step order (FEAT-06-05). When non-empty, the map lays them out as a
   * straight left-to-right chain (read as steps 1..N) instead of the force scatter, and parks every other
   * node in a quiet row below. Empty = the force-directed overview of all trails. */
  chainOrder?: string[]
  /** Edit mode (FEAT-06-06): enables drag-to-connect (drag from one node to another to append a step). */
  editing?: boolean
  /** Called when the operator drags from one node to another in edit mode; (from, to) appends the step. */
  onConnect?: (from: string, to: string) => void
  /** The path being built in edit mode (FEAT-06-07): its consecutive steps are drawn as gold edges so a
   * brand-new connection is visible immediately, before the path is saved into the substrate. */
  draftPath?: string[]
  onSelectNode: (node: GraphNode) => void
  onSelectEdge: (edge: GraphEdge) => void
  onClearSelection: () => void
}

// Dark canvas to match the app chrome (one theme, no light/dark mix); labels render light on it.
const sigmaStyle = { height: '100%', width: '100%', backgroundColor: tokens.color.bg }

type LabelData = PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Draw the node label as light text on a dark rounded pill (FEAT-06-08 graph polish). Sigma's default
// light-on-transparent label is lost wherever it overlaps an edge or another node on the dark canvas, so
// some labels read as unreadable; the pill gives every shown label its own readable backdrop. Reused as
// the hover renderer too, so the hovered label gets the same dark box instead of sigma's default white
// box (which clashes with the dark theme). NodeHoverDrawingFunction shares this signature.
function drawDarkLabel(context: CanvasRenderingContext2D, data: LabelData, settings: Settings): void {
  const label = data.label
  if (typeof label !== 'string' || label === '') return
  const size = settings.labelSize
  context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`
  context.textBaseline = 'middle'
  const x = Math.round(data.x + data.size + 4)
  const y = Math.round(data.y)
  const padX = 5
  const h = size + 6
  const w = context.measureText(label).width + padX * 2
  context.fillStyle = 'rgba(20,20,22,0.82)'
  roundRectPath(context, x - padX, y - h / 2, w, h, 4)
  context.fill()
  const labelColor = settings.labelColor as { color?: string }
  context.fillStyle = labelColor.color ?? tokens.color.text
  context.fillText(label, x, y)
}

const sigmaSettings = {
  allowInvalidContainer: true,
  defaultEdgeType: 'arrow' as const,
  labelColor: { color: tokens.color.text },
  labelFont: tokens.font.family,
  labelWeight: '500',
  // Semantic zoom (FEAT-06-09): keep sigma's map-style label declutter (only non-overlapping labels
  // render, the biggest nodes win), so the overview stays readable and more labels appear as you zoom in.
  // Forcing every label on (threshold 0) was the wrong move; readability comes from showing the LEARNED
  // subgraph (connectedOnly), sizing hubs larger, forceLabel on hubs, and the hover focus reducer below.
  defaultDrawNodeLabel: drawDarkLabel,
  defaultDrawNodeHover: drawDarkLabel,
}
const HIGHLIGHT_COLOR = '#ffd166'

function nodeColor(node: GraphNode, highlight: Set<string>): string {
  return highlight.has(node.id) ? HIGHLIGHT_COLOR : node.color
}
function degreeMap(model: GraphModel): Map<string, number> {
  const d = new Map<string, number>()
  for (const e of model.edges) {
    d.set(e.source, (d.get(e.source) ?? 0) + 1)
    d.set(e.target, (d.get(e.target) ?? 0) + 1)
  }
  return d
}
function nodeSize(node: GraphNode, highlight: Set<string>, degree = 0): number {
  // Visual hierarchy (FEAT-06-09): a hub used by many trails is larger, so the eye and sigma's label grid
  // prioritise it. Start is fixed; a capability grows with its degree (capped).
  const base = node.nodeType === 'start' ? 12 : 6 + Math.min(degree, 6)
  return highlight.has(node.id) ? base + 4 : base
}
// Workflow lens (FEAT-06-05): hide everything that is not the lensed trail, so the selected workflow
// shows alone. Hiding (not dimming) is background-independent: a faint wash was nearly invisible on the
// light graph canvas and left ghost arrows. A non-trail node hides; an edge hides unless it is a
// consecutive step of the trail (Sigma also auto-hides edges that touch a hidden node).
function nodeHidden(node: GraphNode, highlight: Set<string>, dimOthers: boolean): boolean {
  return dimOthers && !highlight.has(node.id)
}
function edgeHidden(edge: GraphEdge, lensEdges: Set<string>, dimOthers: boolean): boolean {
  return dimOthers && !lensEdges.has(`${edge.source}->${edge.target}`)
}

/** Draw the path under construction as gold edges (FEAT-06-07): a brand-new connection (no substrate edge
 * yet) is added so it shows immediately; a step that rides an existing edge is recoloured gold. Edges this
 * added are tracked so they are dropped when they leave the draft; existing edges revert via the model sync.
 * Runs after the model sync, so it wins the colour while a draft exists. */
function reconcileDraftEdges(g: Graph, draftPath: string[], added: Set<string>): void {
  const desired = new Map<string, [string, string]>()
  for (let i = 0; i < draftPath.length - 1; i++) {
    const from = draftPath[i]!
    const to = draftPath[i + 1]!
    if (from !== to) desired.set(`${from}->${to}`, [from, to])
  }
  for (const key of [...added]) {
    if (!desired.has(key)) {
      if (g.hasEdge(key)) g.dropEdge(key)
      added.delete(key)
    }
  }
  for (const [key, [from, to]] of desired) {
    if (g.hasEdge(key)) {
      g.setEdgeAttribute(key, 'color', HIGHLIGHT_COLOR)
      g.setEdgeAttribute(key, 'size', 3)
      g.setEdgeAttribute(key, 'hidden', false)
    } else if (g.hasNode(from) && g.hasNode(to)) {
      // INVARIANT: when this draft edge later becomes a real substrate edge, the structural change bumps
      // graphSignature (graph-model.ts), forcing a full rebuild that resets addedDraft, so the added
      // gold edge is not left behind as a duplicate of the now-real edge.
      g.addEdgeWithKey(key, from, to, { size: 3, color: HIGHLIGHT_COLOR, type: 'arrow' })
      added.add(key)
    }
  }
}

function buildGraph(model: GraphModel, highlight: Set<string>, lensEdges: Set<string>, dimOthers: boolean, chainOrder: string[]): Graph {
  const g = new Graph({ type: 'directed' })
  // Build the chain order from DISTINCT ids that are real nodes (first occurrence wins), so a loop-back
  // workflow (a -> b -> a) or a step whose capability is absent never leaves a gap or miscounts the
  // parked row: each distinct node gets exactly one slot and otherN is the exact complement.
  const nodeIds = new Set(model.nodes.map((nd) => nd.id))
  const chainIndex = new Map<string, number>()
  for (const id of chainOrder) {
    if (nodeIds.has(id) && !chainIndex.has(id)) chainIndex.set(id, chainIndex.size)
  }
  const chainN = chainIndex.size
  const n = Math.max(model.nodes.length, 1)
  const chainCentre = Math.max(chainN - 1, 0) / 2
  const deg = degreeMap(model)
  model.nodes.forEach((node, i) => {
    let x: number
    let y: number
    const ci = chainIndex.get(node.id)
    if (chainN > 0 && ci !== undefined) {
      // the lensed trail, laid out as a straight row read left-to-right as steps 1..N
      x = ci
      y = 0
    } else if (chainN > 0) {
      // hidden in lens mode; parked at the chain centre so it never expands the camera bounding box
      x = chainCentre
      y = 0
    } else {
      const angle = (2 * Math.PI * i) / n
      x = Math.cos(angle)
      y = Math.sin(angle)
    }
    const degree = deg.get(node.id) ?? 0
    g.addNode(node.id, {
      label: node.label,
      color: nodeColor(node, highlight),
      size: nodeSize(node, highlight, degree),
      // Hubs (>= 2 connections) keep their label at any zoom; the rest follow semantic-zoom declutter.
      forceLabel: degree >= 2,
      hidden: nodeHidden(node, highlight, dimOthers),
      x,
      y,
    })
  })
  model.edges.forEach((edge) => {
    if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) return
    const key = `${edge.source}->${edge.target}`
    if (g.hasEdge(key)) return // defensive: a malformed snapshot with a duplicate directed edge
    g.addEdgeWithKey(key, edge.source, edge.target, { size: edge.size, color: edge.color, type: 'arrow', hidden: edgeHidden(edge, lensEdges, dimOthers) })
  })
  // The chain layout sets explicit positions; only the force-directed overview runs ForceAtlas2.
  if (chainN === 0 && g.order > 2) {
    // Small learned graph: space nodes by their LABEL footprint so labels do not overlap. ForceAtlas2
    // `adjustSizes` treats `size` as a collision radius, so we temporarily inflate each node's size to
    // ~half its label width, lay out, then restore the small render size. (Camera fits the result, so the
    // absolute scale is irrelevant; only relative footprints matter.)
    //
    // Large all-tools graph (~150 nodes, mostly edge-less inventory): that label-footprint packing shoves
    // the disconnected inventory into a tight blob that drifts away from the connected core, reading as
    // "two graphs in one" (FEAT-06-09 bug). There, drop adjustSizes and use strong gravity so every node
    // stays in ONE cohesive cloud around the learned core; labels come from hover-focus + zoom, not from
    // spacing 150 of them apart.
    const labelAware = g.order <= 40
    const renderSizes = new Map<string, number>()
    if (labelAware) {
      g.forEachNode((id, attrs) => {
        renderSizes.set(id, attrs.size as number)
        const label = (attrs.label as string) || id
        g.setNodeAttribute(id, 'size', Math.max(8, label.length * 3))
      })
    }
    forceAtlas2.assign(g, {
      iterations: labelAware ? 300 : 200,
      settings: {
        ...forceAtlas2.inferSettings(g),
        adjustSizes: labelAware,
        scalingRatio: labelAware ? 4 : 8,
        gravity: labelAware ? 0.8 : 3,
        strongGravityMode: !labelAware,
        barnesHutOptimize: g.order > 60,
      },
    })
    if (labelAware) g.forEachNode((id) => g.setNodeAttribute(id, 'size', renderSizes.get(id) ?? 6))
  }
  return g
}

/**
 * Keep the Sigma graph in sync with the model. A full rebuild (and a layout pass) runs only when the
 * layout changes: the structure (graphSignature) OR the lens chain order. When just pheromone, pinned
 * or the dim/highlight flips (every 2s poll or a chip toggle that keeps the same layout), edge and node
 * visuals update in place so positions stay put and the force layout never jumps. Selecting a workflow
 * does change the layout (force overview -> straight chain), which is a deliberate, user-driven relayout.
 */
function GraphSync({ model, highlightNodes, lensEdges, dimOthers, chainOrder, draftPath, dragInFlight }: { model: GraphModel; highlightNodes: string[]; lensEdges: string[]; dimOthers: boolean; chainOrder: string[]; draftPath: string[]; dragInFlight: MutableRefObject<boolean> }): null {
  const loadGraph = useLoadGraph()
  const sigma = useSigma()
  const lastLayout = useRef<string | null>(null)
  const addedDraft = useRef<Set<string>>(new Set())
  const highlightKey = highlightNodes.join(',')
  const lensKey = lensEdges.join(',')
  const chainKey = chainOrder.join(',')
  const draftKey = draftPath.join(',')

  useEffect(() => {
    // While the operator is dragging a node (reposition or connect), a poll-driven rebuild/relayout
    // would teleport the node under the cursor; skip the sync until the drag ends (FEAT-06-07).
    if (dragInFlight.current) return
    const highlight = new Set(highlightNodes)
    const lensSet = new Set(lensEdges)
    const layoutKey = `${graphSignature(model)}|${chainKey}`
    if (layoutKey !== lastLayout.current) {
      loadGraph(buildGraph(model, highlight, lensSet, dimOthers, chainOrder))
      lastLayout.current = layoutKey
      addedDraft.current = new Set() // the rebuild made a fresh graph; previously-added draft edges are gone
    } else {
      const g = sigma.getGraph()
      const deg = degreeMap(model)
      model.nodes.forEach((node) => {
        if (!g.hasNode(node.id)) return
        const degree = deg.get(node.id) ?? 0
        g.setNodeAttribute(node.id, 'color', nodeColor(node, highlight))
        g.setNodeAttribute(node.id, 'size', nodeSize(node, highlight, degree))
        g.setNodeAttribute(node.id, 'label', node.label)
        g.setNodeAttribute(node.id, 'forceLabel', degree >= 2)
        g.setNodeAttribute(node.id, 'hidden', nodeHidden(node, highlight, dimOthers))
      })
      model.edges.forEach((edge) => {
        const key = `${edge.source}->${edge.target}`
        if (!g.hasEdge(key)) return
        g.setEdgeAttribute(key, 'size', edge.size)
        g.setEdgeAttribute(key, 'color', edge.color)
        g.setEdgeAttribute(key, 'hidden', edgeHidden(edge, lensSet, dimOthers))
      })
    }
    // Draw the draft path on top (gold), after the model sync so it wins the colour while building.
    reconcileDraftEdges(sigma.getGraph(), draftPath, addedDraft.current)
    sigma.refresh()
    // highlightKey, lensKey, chainKey, draftKey and dimOthers are the view identity; re-sync on any change.
  }, [loadGraph, sigma, model, highlightNodes, highlightKey, lensEdges, lensKey, chainOrder, chainKey, draftPath, draftKey, dimOthers])

  return null
}

/**
 * Wire Sigma events to selection plus the two node-drag gestures, resolving keys via the current model.
 * In READ mode, dragging a node repositions it (so the operator can arrange the map; a plain click still
 * selects). In EDIT mode, dragging from a node draws a rubber-band (an SVG overlay line from the source
 * to the cursor) and releasing on another node appends the step (FEAT-06-06/07). The rubber-band is an
 * overlay, not a graph node, so it never shadows Sigma's hover picking and onConnect resolves the real
 * target. The camera pan is suppressed only while a node drag is in flight; a drag also sets dragInFlight
 * so the poll does not rebuild under the cursor, and suppresses the click that would otherwise fire on
 * release.
 */
function SelectionEvents({
  graph,
  editing,
  onConnect,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  rubberRef,
  dragInFlight,
}: AntMapProps & { rubberRef: RefObject<SVGLineElement>; dragInFlight: MutableRefObject<boolean> }): null {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()
  const dragFrom = useRef<string | null>(null) // edit mode: the connect source
  const moveNode = useRef<string | null>(null) // read mode: the node being repositioned
  const hoverNode = useRef<string | null>(null)
  const moved = useRef(false) // a real drag happened this interaction (suppress the trailing click)

  useEffect(() => {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    const edgeByKey = new Map(graph.edges.map((edge) => [`${edge.source}->${edge.target}`, edge]))

    const hideRubber = (): void => {
      if (rubberRef.current) rubberRef.current.style.display = 'none'
    }
    const endDrag = (): void => {
      dragFrom.current = null
      moveNode.current = null
      dragInFlight.current = false
      hideRubber()
    }

    // Focus + context (FEAT-06-09): on hover, keep the hovered node and its direct neighbours bright and
    // labelled, fade the rest (label dropped), and hide edges that do not touch the hovered node, so any
    // node becomes readable on demand without a permanent label cloud. Off in edit mode, where the path
    // builder owns the highlight. enterNode/leaveNode call sigma.refresh() to re-run these.
    sigma.setSetting('nodeReducer', (node, data) => {
      const h = hoverNode.current
      if (editing || !h) return data
      const gg = sigma.getGraph()
      if (!gg.hasNode(h)) return data
      if (node === h || gg.areNeighbors(h, node)) return { ...data, forceLabel: true }
      return { ...data, label: '', color: tokens.color.borderHover, forceLabel: false }
    })
    sigma.setSetting('edgeReducer', (edge, data) => {
      const h = hoverNode.current
      if (editing || !h) return data
      const gg = sigma.getGraph()
      if (!gg.hasNode(h)) return data
      return gg.extremities(edge).includes(h) ? data : { ...data, hidden: true }
    })

    registerEvents({
      clickNode: ({ node }) => {
        if (moved.current) return // a drag, not a click
        const model = nodeById.get(node)
        if (model) onSelectNode(model)
      },
      clickEdge: ({ edge }) => {
        const model = edgeByKey.get(edge)
        if (model) onSelectEdge(model)
      },
      clickStage: () => {
        if (!moved.current) onClearSelection()
      },
      enterNode: ({ node }) => {
        hoverNode.current = node
        if (!editing) sigma.refresh()
      },
      leaveNode: () => {
        hoverNode.current = null
        if (!editing) sigma.refresh()
      },
      downNode: ({ node }) => {
        moved.current = false
        if (editing) dragFrom.current = onConnect ? node : null // edit: connect (only if a handler exists)
        else moveNode.current = node // read: reposition
      },
      mousemovebody: (e) => {
        if (dragFrom.current && editing && onConnect) {
          moved.current = true
          dragInFlight.current = true
          e.preventSigmaDefault()
          const g = sigma.getGraph()
          // Anchor the line at the source node: graphToViewport expects RAW graph coords (the ones we
          // store via setNodeAttribute), not the normalized display data, so read the attributes directly.
          if (g.hasNode(dragFrom.current) && rubberRef.current) {
            const src = sigma.graphToViewport({ x: g.getNodeAttribute(dragFrom.current, 'x'), y: g.getNodeAttribute(dragFrom.current, 'y') })
            const ln = rubberRef.current
            ln.setAttribute('x1', String(src.x))
            ln.setAttribute('y1', String(src.y))
            ln.setAttribute('x2', String(e.x))
            ln.setAttribute('y2', String(e.y))
            ln.style.display = ''
          }
        } else if (moveNode.current) {
          moved.current = true
          dragInFlight.current = true
          e.preventSigmaDefault()
          const g = sigma.getGraph()
          const pos = sigma.viewportToGraph({ x: e.x, y: e.y })
          if (g.hasNode(moveNode.current)) {
            g.setNodeAttribute(moveNode.current, 'x', pos.x)
            g.setNodeAttribute(moveNode.current, 'y', pos.y)
          }
        }
      },
      mouseup: () => {
        const from = dragFrom.current
        const wasConnect = editing && !!onConnect && !!from && moved.current
        const to = hoverNode.current
        endDrag()
        // Connect only on a real drag that released over a different real node (overlay rubber-band means
        // hover picking returns the true target, never a ghost).
        if (wasConnect && from && to && to !== from && nodeById.has(from) && nodeById.has(to)) onConnect!(from, to)
      },
    })

    // Terminal-event fallback (FEAT-06-07 review): if the button is released after focus is stolen
    // (alt-tab while held, OS dialog, tab hidden), Sigma's document mouseup may never fire, leaving
    // dragInFlight stuck true, which freezes the whole map (GraphSync early-returns). Reset on blur /
    // tab-hide. NOT in the effect cleanup: that runs on every poll re-render and would abort a live drag.
    const onBlur = (): void => endDrag()
    const onVisibility = (): void => {
      if (document.hidden) endDrag()
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [registerEvents, sigma, graph, editing, onConnect, onSelectNode, onSelectEdge, onClearSelection, rubberRef, dragInFlight])
  return null
}

export function AntMap({ graph, highlightNodes = [], lensEdges = [], chainOrder = [], draftPath = [], dimOthers = false, editing = false, onConnect, onSelectNode, onSelectEdge, onClearSelection }: AntMapProps): JSX.Element {
  // Shared across the inner components: the rubber-band line (drawn imperatively for smoothness) and a
  // flag that pauses the poll-driven sync while a node drag is in flight.
  const rubberRef = useRef<SVGLineElement>(null)
  const dragInFlight = useRef(false)
  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <SigmaContainer style={sigmaStyle} settings={sigmaSettings}>
        <GraphSync model={graph} highlightNodes={highlightNodes} lensEdges={lensEdges} dimOthers={dimOthers} chainOrder={chainOrder} draftPath={draftPath} dragInFlight={dragInFlight} />
        <SelectionEvents
          graph={graph}
          editing={editing}
          onConnect={onConnect}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          onClearSelection={onClearSelection}
          rubberRef={rubberRef}
          dragInFlight={dragInFlight}
        />
      </SigmaContainer>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line ref={rubberRef} stroke={HIGHLIGHT_COLOR} strokeWidth={2.5} strokeLinecap="round" style={{ display: 'none' }} />
      </svg>
    </div>
  )
}
