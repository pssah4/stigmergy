// Pure substrate-to-graph mapping for the Ant-Map (FEAT-03-01, ADR-15). No React, Electron or
// Sigma imports, so it runs under the monorepo vitest. The Electron main process builds a
// SubstrateSnapshot from the StoragePort (listCapabilities + listEdges) and ships it to the
// renderer, which feeds it through toGraphModel before handing it to Sigma/graphology.

import { START_NODE, edgePairs } from '@agentic-stigmergy/core'

// Lean, JSON-safe views of the substrate. The Electron main process builds these from the
// read-only storage and ships them over IPC, so they carry only the fields the map needs
// (no Float32Array embeddings, no timestamps) and survive structured-clone unchanged.
export interface CapabilityView {
  id: string
  type: string
  description: string
  descriptionAugmented?: string
  /** Provenance (ADR-17): 'observed' once a loop ran it, else 'declared' | 'mcp' | 'skill'. */
  source?: string
}

export interface EdgeView {
  fromCapability: string
  toCapability: string
  pheromone: number
  pinned: boolean
}

/** A pinned path (explicit user workflow). Drives the editor's workflow list and unpin-by-id, AND is
 * the source toGraphModel uses to decide which edges read as "saved" (red), so the map and the
 * Saved-paths panel stay consistent (FIX-06-05-01). */
export interface PinnedPathView {
  id: string
  name?: string
  behavior: string
  capabilitySequence: string[]
  /** Plain-language gate ("use when ...") the engine matches against the task context (ADR-18). Shipped
   * to the renderer so the workflow lens can show what a trail is for (FEAT-06-05). */
  whenToUse?: string
}

/** A task that traversed a given learned connection (edge provenance): the "what for" of a gray step.
 * Shipped to the Connection inspector so a learned edge can be explained by the tasks that formed it. */
export interface ConnectionTask {
  /** The task's context, the plain-language description of what the loop was doing. */
  context: string
  /** The recorded outcome (accepted / rejected / ...), or '' if unknown. */
  outcome: string
}

export interface SubstrateSnapshot {
  capabilities: CapabilityView[]
  edges: EdgeView[]
  pinnedPaths?: PinnedPathView[]
  /** Task row count. Rises when a loop resolves a task (connect-verify reads this to detect a run). */
  taskCount?: number
  /** Whether Stigmergy is enabled for the connected loop (FEAT-04-06); default false on a pre-v4 substrate. */
  enabled?: boolean
}

export interface GraphNode {
  id: string
  label: string
  color: string
  nodeType: string
  description: string
}

export interface GraphEdge {
  source: string
  target: string
  /** Visual thickness, derived from pheromone (see pheromoneToSize). */
  size: number
  color: string
  pinned: boolean
  pheromone: number
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Node colour per capability type. The reserved start sentinel and any unknown type fall back to grey. */
export const TYPE_COLORS: Record<string, string> = {
  tool: '#4f86c6',
  mcp: '#6cc644',
  skill: '#c678dd',
  subagent: '#e0a458',
  start: '#888888',
}

const PINNED_COLOR = '#e06c75'
const EDGE_COLOR = '#bbbbbb'

/** Map a pheromone value in [tauMin, tauMax] to an edge thickness in [1, 6]. The linear ramp gives
 * clearly distinguishable levels (a cold edge at tauMin is 1, a saturated edge at tauMax is 6),
 * so SC-02's "at least three distinguishable levels" holds. Values outside the range are clamped. */
export function pheromoneToSize(pheromone: number, tauMin = 0.05, tauMax = 1.0): number {
  const span = tauMax - tauMin
  const clamped = Math.max(tauMin, Math.min(tauMax, pheromone))
  const t = span > 0 ? (clamped - tauMin) / span : 0
  return 1 + t * 5
}

/** A structural fingerprint of the graph: which nodes and which directed edges exist, ignoring
 * pheromone, colour and size. The renderer relayouts only when this changes; when just pheromone
 * shifts (every poll), the signature stays equal so the layout does not jump and visual attributes
 * update in place. */
export function graphSignature(model: GraphModel): string {
  const nodes = model.nodes.map((n) => n.id).sort()
  const edges = model.edges.map((e) => `${e.source}->${e.target}`).sort()
  return `${nodes.join(',')}|${edges.join(',')}`
}

/** Build the renderable graph from a substrate snapshot. Capabilities become coloured nodes,
 * edges become pheromone-thick lines, pinned edges are highlighted. The start sentinel is shown as
 * a single "Start" node (the ant nest) only when an edge references it, so all substrate edges are
 * visible (SC-01) without leaking the sentinel as a normal capability.
 *
 * An edge reads as "saved" (red, pinned) only when a pinned PATH covers it, the same source the
 * Saved-paths panel lists (FIX-06-05-01). This keeps the graph and the panel consistent by construction:
 * an orphaned pinned edge (a stale DB pinned flag with no covering path, a drift reconcilePinnedEdges
 * heals on the engine's next write) renders as a normal gray learned edge, not a phantom workflow.
 *
 * With `hideStartFanout` (FEAT-06-05) the gray Start->capability spokes are dropped, so the cluttered
 * "Start touches everything" hairball never paints; only the meaningful capability-to-capability edges
 * remain. A saved-path Start edge survives, because a pinned path is a deliberate workflow (its first
 * step keeps its red Start->first edge), so a single-step pin and the reinforce/weaken-on-start-edge
 * action stay visible and the Start node is still synthesized when a covered edge references it. */
export function toGraphModel(snapshot: SubstrateSnapshot, opts: { hideStartFanout?: boolean; connectedOnly?: boolean } = {}): GraphModel {
  const { hideStartFanout = false, connectedOnly = false } = opts
  // Edge pairs covered by a pinned path (incl. START->first via edgePairs); the single source of "saved".
  const covered = new Set<string>()
  for (const p of snapshot.pinnedPaths ?? []) {
    for (const [from, to] of edgePairs(p.capabilitySequence)) covered.add(`${from}->${to}`)
  }
  const isCovered = (e: EdgeView): boolean => covered.has(`${e.fromCapability}->${e.toCapability}`)
  const sourceEdges = hideStartFanout
    ? snapshot.edges.filter((e) => isCovered(e) || (e.fromCapability !== START_NODE && e.toCapability !== START_NODE))
    : snapshot.edges

  const nodes: GraphNode[] = snapshot.capabilities
    .filter((c) => c.id !== START_NODE)
    .map((c) => ({
      id: c.id,
      label: c.id,
      color: TYPE_COLORS[c.type] ?? TYPE_COLORS.start!,
      nodeType: c.type,
      description: c.descriptionAugmented ?? c.description,
    }))

  const referencesStart = sourceEdges.some((e) => e.fromCapability === START_NODE || e.toCapability === START_NODE)
  if (referencesStart) {
    nodes.unshift({ id: START_NODE, label: 'Start', color: TYPE_COLORS.start!, nodeType: 'start', description: 'path start (ant nest)' })
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = sourceEdges
    .filter((e) => nodeIds.has(e.fromCapability) && nodeIds.has(e.toCapability))
    .map((e) => ({
      source: e.fromCapability,
      target: e.toCapability,
      size: pheromoneToSize(e.pheromone),
      color: isCovered(e) ? PINNED_COLOR : EDGE_COLOR,
      pinned: isCovered(e),
      pheromone: e.pheromone,
    }))

  // Default graph view: show only the LEARNED structure (FEAT-06-09). A capability that no displayed edge
  // touches is an unused inventory item, not part of any learned trail; dumping all of them produces an
  // unreadable hairball of labels. So with connectedOnly we keep only the nodes an edge connects (START
  // included only when a displayed edge references it). The full inventory stays available via the "All
  // tools" toggle and the Add-tools palette. An empty result is honest: nothing learned yet.
  if (connectedOnly) {
    const connected = new Set<string>()
    for (const e of edges) {
      connected.add(e.source)
      connected.add(e.target)
    }
    return { nodes: nodes.filter((n) => connected.has(n.id)), edges }
  }

  return { nodes, edges }
}

/** Group the "available" capabilities (declared/mcp/skill, discovered but not yet run) by type, for
 * the Builder palette (FEAT-04-02). Observed capabilities are the learned graph, not palette items,
 * so they are excluded. Types and items are sorted for a stable, deterministic rendering. */
export function groupAvailableByType(snapshot: SubstrateSnapshot): { type: string; items: CapabilityView[] }[] {
  const available = (snapshot.capabilities ?? []).filter((c) => c.source !== undefined && c.source !== 'observed')
  const byType = new Map<string, CapabilityView[]>()
  for (const c of available) {
    const list = byType.get(c.type) ?? []
    list.push(c)
    byType.set(c.type, list)
  }
  return [...byType.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([type, items]) => ({ type, items: items.sort((x, y) => (x.id < y.id ? -1 : 1)) }))
}
