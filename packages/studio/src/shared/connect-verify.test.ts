import { describe, it, expect } from 'vitest'
import { probeActivity, compareActivity } from './connect-verify.js'
import type { SubstrateSnapshot, EdgeView } from './graph-model.js'

function edge(from: string, to: string, pheromone: number): EdgeView {
  return { fromCapability: from, toCapability: to, pheromone, pinned: false }
}

function snapshot(taskCount: number, edges: EdgeView[]): SubstrateSnapshot {
  return { capabilities: [], edges, pinnedPaths: [], taskCount }
}

describe('connect-verify activity detection', () => {
  it('probes task count and an edge-activity fingerprint', () => {
    const p = probeActivity(snapshot(3, [edge('__START__', 'tool:a', 0.5)]))
    expect(p.taskCount).toBe(3)
    expect(p.edgeActivity).toBeCloseTo(1.5, 5) // 1 edge + 0.5 pheromone
  })

  it('treats a missing taskCount as zero', () => {
    expect(probeActivity({ capabilities: [], edges: [] }).taskCount).toBe(0)
  })

  it('flags consult when the task count rises (SC-03)', () => {
    const base = probeActivity(snapshot(0, []))
    const now = probeActivity(snapshot(1, []))
    expect(compareActivity(base, now).consultSeen).toBe(true)
  })

  it('flags an event when edge activity changes (SC-03)', () => {
    const base = probeActivity(snapshot(0, [edge('__START__', 'tool:a', 0.3)]))
    const now = probeActivity(snapshot(0, [edge('__START__', 'tool:a', 0.6)]))
    expect(compareActivity(base, now).eventSeen).toBe(true)
  })

  it('only turns green once both a consult and an event are seen', () => {
    const base = probeActivity(snapshot(0, [edge('__START__', 'tool:a', 0.3)]))
    const consultOnly = probeActivity(snapshot(1, [edge('__START__', 'tool:a', 0.3)]))
    const both = probeActivity(snapshot(1, [edge('__START__', 'tool:a', 0.9)]))
    expect(compareActivity(base, consultOnly).green).toBe(false)
    expect(compareActivity(base, both).green).toBe(true)
  })

  it('stays grey when nothing changed (no loop activity)', () => {
    const base = probeActivity(snapshot(2, [edge('__START__', 'tool:a', 0.4)]))
    const same = probeActivity(snapshot(2, [edge('__START__', 'tool:a', 0.4)]))
    const progress = compareActivity(base, same)
    expect(progress).toEqual({ consultSeen: false, eventSeen: false, green: false })
  })
})
