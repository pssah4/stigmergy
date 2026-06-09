// Pure helpers for path visibility (FEAT-06-01) and the guided editor (FEAT-06-06): filter the
// pinned-path list, derive a path's node/edge set for the graph, suggest learned successors and search
// capabilities. No React/DOM, so the monorepo vitest covers it.
import type { PinnedPathView, EdgeView, CapabilityView } from './graph-model.js'

/** Filter pinned paths by a case-insensitive substring over name, behavior, id, and the capability ids
 * in the sequence. An empty/whitespace query returns all, so a user can find one path among many. */
export function filterPinnedPaths(paths: readonly PinnedPathView[], query: string): PinnedPathView[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...paths]
  return paths.filter(
    (p) =>
      (p.name ?? '').toLowerCase().includes(q) ||
      p.behavior.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.capabilitySequence.some((c) => c.toLowerCase().includes(q)),
  )
}

/** The capability node ids of a pinned path, used as the AntMap highlight set so clicking a path lights
 * up exactly its nodes in the graph. */
export function pathNodeIds(path: PinnedPathView): string[] {
  return [...path.capabilitySequence]
}

/** The directed edge keys ("source->target") of a path's consecutive steps (FEAT-06-05). The workflow
 * lens lights only these, so a learned shortcut (a->c) or back-edge (c->a) among a trail's nodes is not
 * mistaken for a step of the trail. Mirrors the "source->target" key AntMap builds per edge. */
export function pathEdgeKeys(path: PinnedPathView): string[] {
  const seq = path.capabilitySequence
  const keys: string[] = []
  for (let i = 0; i < seq.length - 1; i++) keys.push(`${seq[i]}->${seq[i + 1]}`)
  return keys
}

/** The learned successors of a node (FEAT-06-06): capability ids reachable by one learned edge from
 * `lastNodeId`, strongest pheromone first. Drives the editor's "next step" suggestions. */
export function successorCandidates(edges: readonly EdgeView[], lastNodeId: string): string[] {
  return edges
    .filter((e) => e.fromCapability === lastNodeId)
    .slice()
    .sort((a, b) => b.pheromone - a.pheromone)
    .map((e) => e.toCapability)
}

/** Case-insensitive search over capabilities by id, type and description (FEAT-06-06). An empty query
 * returns all, so the editor can list everything and narrow as the operator types. */
export function filterCapabilities(caps: readonly CapabilityView[], query: string): CapabilityView[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...caps]
  return caps.filter(
    (c) => c.id.toLowerCase().includes(q) || c.type.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
  )
}

/** A readable label for a workflow chip/row (FEAT-06-05). Uses the human name when present; otherwise
 * derives "first -> last" from the capability sequence (a single step shows that step), so unnamed
 * trails still read clearly without an LLM naming provider. Empty sequence falls back to the id. */
export function pathLabel(path: PinnedPathView): string {
  const name = path.name?.trim()
  if (name) return name
  const seq = path.capabilitySequence
  if (seq.length === 0) return path.id
  if (seq.length === 1) return seq[0]!
  return `${seq[0]} -> ${seq[seq.length - 1]}`
}
