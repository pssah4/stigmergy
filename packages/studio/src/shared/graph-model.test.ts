import { describe, it, expect } from 'vitest'
import { START_NODE } from '@agentic-stigmergy/core'
import {
  toGraphModel,
  pheromoneToSize,
  graphSignature,
  groupAvailableByType,
  type CapabilityView,
  type EdgeView,
  type PinnedPathView,
  type SubstrateSnapshot,
} from './graph-model.js'

function cap(id: string, type = 'tool', description = id): CapabilityView {
  return { id, type, description }
}

function edge(from: string, to: string, pheromone: number, pinned = false): EdgeView {
  return { fromCapability: from, toCapability: to, pheromone, pinned }
}

function pinnedPath(capabilitySequence: string[], behavior = 'preferred', id = 'p1'): PinnedPathView {
  return { id, behavior, capabilitySequence }
}

describe('pheromoneToSize', () => {
  it('maps the pheromone range to at least three distinguishable thickness levels (SC-02)', () => {
    const cold = pheromoneToSize(0.05)
    const mid = pheromoneToSize(0.5)
    const hot = pheromoneToSize(1.0)
    expect(cold).toBeCloseTo(1, 5)
    expect(hot).toBeCloseTo(6, 5)
    expect(mid).toBeGreaterThan(cold)
    expect(hot).toBeGreaterThan(mid)
    expect(hot - cold).toBeGreaterThan(2) // visibly separable
  })
  it('clamps out-of-range pheromone', () => {
    expect(pheromoneToSize(-5)).toBeCloseTo(1, 5)
    expect(pheromoneToSize(99)).toBeCloseTo(6, 5)
  })
})

describe('toGraphModel', () => {
  it('maps every capability and edge from the substrate (SC-01)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [cap('tool:a'), cap('mcp:b', 'mcp')],
      edges: [edge(START_NODE, 'tool:a', 0.4), edge('tool:a', 'mcp:b', 0.8)],
    }
    const g = toGraphModel(snapshot)
    // Start node is synthesized because an edge references it -> 3 nodes total.
    expect(g.nodes.map((n) => n.id).sort()).toEqual([START_NODE, 'mcp:b', 'tool:a'])
    expect(g.edges).toHaveLength(2)
    expect(g.edges.find((e) => e.source === 'tool:a' && e.target === 'mcp:b')).toBeDefined()
  })

  it('colours nodes by capability type and labels the start sentinel as the nest', () => {
    const g = toGraphModel({ capabilities: [cap('tool:a'), cap('skill:c', 'skill')], edges: [edge(START_NODE, 'tool:a', 0.3)] })
    expect(g.nodes.find((n) => n.id === 'tool:a')?.color).toBe('#4f86c6')
    expect(g.nodes.find((n) => n.id === 'skill:c')?.color).toBe('#c678dd')
    const start = g.nodes.find((n) => n.id === START_NODE)
    expect(start?.label).toBe('Start')
    expect(start?.nodeType).toBe('start')
  })

  it('marks an edge red and pinned when a saved path covers it, thickening by pheromone (FIX-06-05-01)', () => {
    const g = toGraphModel({
      capabilities: [cap('tool:a'), cap('tool:b')],
      edges: [edge('tool:a', 'tool:b', 0.9, false)], // raw DB pinned flag is irrelevant now
      pinnedPaths: [pinnedPath(['tool:a', 'tool:b'])],
    })
    const e = g.edges.find((x) => x.source === 'tool:a' && x.target === 'tool:b')!
    expect(e.pinned).toBe(true)
    expect(e.color).toBe('#e06c75')
    expect(e.size).toBeGreaterThan(5) // 0.9 -> thick
  })

  it('renders an orphaned pinned edge (DB pinned flag set, no covering saved path) as a gray learned edge (FIX-06-05-01)', () => {
    const g = toGraphModel({
      capabilities: [cap('tool:a'), cap('tool:b')],
      edges: [edge('tool:a', 'tool:b', 0.9, true)], // pinned in the DB, but no path covers it
      pinnedPaths: [],
    })
    const e = g.edges[0]!
    expect(e.pinned).toBe(false)
    expect(e.color).toBe('#bbbbbb')
  })

  it('does not synthesize a start node when no edge references it, and drops dangling edges', () => {
    const g = toGraphModel({
      capabilities: [cap('tool:a'), cap('tool:b')],
      edges: [edge('tool:a', 'tool:b', 0.5), edge('tool:a', 'ghost:x', 0.5)],
    })
    expect(g.nodes.some((n) => n.id === START_NODE)).toBe(false)
    expect(g.edges).toHaveLength(1) // dangling edge to a non-node is dropped
  })

  it('returns an empty graph for an empty substrate', () => {
    expect(toGraphModel({ capabilities: [], edges: [] })).toEqual({ nodes: [], edges: [] })
  })

  it('suppresses the Start fan-out with hideStartFanout (FEAT-06-05)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [cap('tool:a'), cap('mcp:b')],
      edges: [edge(START_NODE, 'tool:a', 0.4), edge('tool:a', 'mcp:b', 0.8)],
    }
    const g = toGraphModel(snapshot, { hideStartFanout: true })
    // the synthesized Start node is gone, and the gray Start->capability spoke is dropped
    expect(g.nodes.some((n) => n.id === START_NODE)).toBe(false)
    expect(g.edges).toEqual([
      expect.objectContaining({ source: 'tool:a', target: 'mcp:b' }),
    ])
    // the meaningful capability-to-capability edge survives
    expect(g.edges).toHaveLength(1)
  })

  it('keeps the Start fan-out by default (hideStartFanout omitted)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [cap('tool:a')],
      edges: [edge(START_NODE, 'tool:a', 0.4)],
    }
    const g = toGraphModel(snapshot)
    expect(g.nodes.some((n) => n.id === START_NODE)).toBe(true)
    expect(g.edges).toHaveLength(1)
  })

  it('keeps a saved-path Start edge with hideStartFanout (a deliberate single-step workflow stays visible) (FIX-06-05-01)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [cap('tool:a')],
      edges: [edge(START_NODE, 'tool:a', 0.4, false)],
      pinnedPaths: [pinnedPath(['tool:a'])], // covers START->tool:a
    }
    const g = toGraphModel(snapshot, { hideStartFanout: true })
    expect(g.nodes.some((n) => n.id === START_NODE)).toBe(true)
    expect(g.edges).toEqual([expect.objectContaining({ source: START_NODE, target: 'tool:a', pinned: true })])
  })

  it('connectedOnly keeps only nodes a displayed edge touches, dropping isolated inventory (FEAT-06-09)', () => {
    const g = toGraphModel(
      { capabilities: [cap('tool:a'), cap('tool:b'), cap('tool:isolated')], edges: [edge('tool:a', 'tool:b', 0.5)] },
      { connectedOnly: true },
    )
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['tool:a', 'tool:b']) // tool:isolated has no edge -> dropped
    expect(g.edges).toHaveLength(1)
  })

  it('connectedOnly returns an empty graph when nothing is connected (honest "nothing learned yet")', () => {
    expect(toGraphModel({ capabilities: [cap('tool:a'), cap('tool:b')], edges: [] }, { connectedOnly: true })).toEqual({ nodes: [], edges: [] })
  })

  it('connectedOnly + hideStartFanout drops a node whose only edge was the hidden gray Start spoke (FEAT-06-09)', () => {
    const g = toGraphModel({ capabilities: [cap('tool:a')], edges: [edge(START_NODE, 'tool:a', 0.4)] }, { connectedOnly: true, hideStartFanout: true })
    expect(g.nodes).toEqual([]) // the gray Start spoke is hidden, so tool:a is isolated and dropped
    expect(g.edges).toEqual([])
  })

  it('drops an orphaned pinned Start edge with hideStartFanout (no covering path means it is not a workflow) (FIX-06-05-01)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [cap('tool:a'), cap('tool:b')],
      edges: [edge(START_NODE, 'tool:a', 0.4, true), edge('tool:a', 'tool:b', 0.5)], // pinned Start edge, but no path
      pinnedPaths: [],
    }
    const g = toGraphModel(snapshot, { hideStartFanout: true })
    expect(g.nodes.some((n) => n.id === START_NODE)).toBe(false)
    expect(g.edges).toEqual([expect.objectContaining({ source: 'tool:a', target: 'tool:b' })])
  })
})

describe('graphSignature', () => {
  const base: SubstrateSnapshot = {
    capabilities: [cap('tool:a'), cap('tool:b')],
    edges: [edge('tool:a', 'tool:b', 0.3)],
  }

  it('stays equal when only pheromone or pinned changes (no relayout on poll)', () => {
    const a = graphSignature(toGraphModel(base))
    const b = graphSignature(
      toGraphModel({ capabilities: base.capabilities, edges: [edge('tool:a', 'tool:b', 0.95, true)] }),
    )
    expect(b).toBe(a)
  })

  it('changes when a node or edge is added or removed (relayout needed)', () => {
    const a = graphSignature(toGraphModel(base))
    const withNode = graphSignature(
      toGraphModel({ capabilities: [...base.capabilities, cap('tool:c')], edges: base.edges }),
    )
    const withoutEdge = graphSignature(toGraphModel({ capabilities: base.capabilities, edges: [] }))
    expect(withNode).not.toBe(a)
    expect(withoutEdge).not.toBe(a)
  })

  it('is order-independent', () => {
    const a = graphSignature(toGraphModel(base))
    const reordered = graphSignature(
      toGraphModel({ capabilities: [cap('tool:b'), cap('tool:a')], edges: base.edges }),
    )
    expect(reordered).toBe(a)
  })
})

describe('groupAvailableByType (EPIC-04 FEAT-04-02)', () => {
  it('groups discovered-but-unobserved capabilities by type, excluding observed ones', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [
        { id: 'tool:ran', type: 'tool', description: 'used', source: 'observed' },
        { id: 'mcp:fs:read', type: 'mcp', description: 'read', source: 'mcp' },
        { id: 'tool:declared', type: 'tool', description: 'avail', source: 'declared' },
        { id: 'skill:hum', type: 'skill', description: 'humanize', source: 'skill' },
        { id: 'tool:legacy', type: 'tool', description: 'legacy' }, // no source -> excluded
      ],
      edges: [],
    }
    const groups = groupAvailableByType(snapshot)
    expect(groups.map((g) => g.type)).toEqual(['mcp', 'skill', 'tool']) // sorted, observed/legacy excluded
    expect(groups.find((g) => g.type === 'tool')!.items.map((c) => c.id)).toEqual(['tool:declared'])
    expect(groups.find((g) => g.type === 'mcp')!.items.map((c) => c.id)).toEqual(['mcp:fs:read'])
  })

  it('returns an empty array when nothing is available', () => {
    expect(groupAvailableByType({ capabilities: [{ id: 'a', type: 'tool', description: 'x', source: 'observed' }], edges: [] })).toEqual([])
  })
})
