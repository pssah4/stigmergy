import { describe, it, expect } from 'vitest'
import { computeStats, isResetConfirmation } from './substrate-ops.js'
import type { SubstrateSnapshot, EdgeView } from './graph-model.js'

function edge(p: number): EdgeView {
  return { fromCapability: '__START__', toCapability: 'tool:a', pheromone: p, pinned: false }
}

describe('computeStats', () => {
  it('counts capabilities, edges, tasks, pinned paths and averages pheromone (SC-01)', () => {
    const snapshot: SubstrateSnapshot = {
      capabilities: [
        { id: 'tool:a', type: 'tool', description: 'a' },
        { id: 'mcp:b', type: 'mcp', description: 'b' },
      ],
      edges: [edge(0.2), edge(0.8)],
      pinnedPaths: [{ id: 'p1', behavior: 'preferred', capabilitySequence: ['tool:a'] }],
      taskCount: 5,
    }
    expect(computeStats(snapshot)).toEqual({ capabilities: 2, edges: 2, tasks: 5, pinnedPaths: 1, avgPheromone: 0.5 })
  })

  it('reports zero average for an empty substrate without dividing by zero', () => {
    expect(computeStats({ capabilities: [], edges: [] })).toEqual({
      capabilities: 0,
      edges: 0,
      tasks: 0,
      pinnedPaths: 0,
      avgPheromone: 0,
    })
  })
})

describe('isResetConfirmation', () => {
  it('accepts only the exact word DELETE (SC-06)', () => {
    expect(isResetConfirmation('DELETE')).toBe(true)
    expect(isResetConfirmation('delete')).toBe(false)
    expect(isResetConfirmation(' DELETE ')).toBe(false)
    expect(isResetConfirmation('')).toBe(false)
    expect(isResetConfirmation('DELETE NOW')).toBe(false)
  })
})
