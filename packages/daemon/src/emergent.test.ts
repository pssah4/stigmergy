import { describe, it, expect } from 'vitest'
import { START_NODE } from '@agentic-stigmergy/core'
import { selectEmergentCandidates, sequenceKey, type EmergentEdge } from './emergent.js'

function edge(from: string, to: string, successCount: number, pinned = false): EmergentEdge {
  return { fromCapability: from, toCapability: to, successCount, pinned }
}

describe('selectEmergentCandidates (EPIC-04 FEAT-04-04)', () => {
  it('returns nothing when no edge crosses the threshold', () => {
    expect(selectEmergentCandidates([edge(START_NODE, 'a', 1)], { threshold: 3 })).toEqual([])
  })

  it('surfaces a single strong START edge', () => {
    expect(selectEmergentCandidates([edge(START_NODE, 'a', 5)], { threshold: 3 })).toEqual([['a']])
  })

  it('walks a strong non-pinned chain greedily by success_count', () => {
    const edges = [edge(START_NODE, 'a', 5), edge('a', 'b', 4), edge('a', 'c', 2)]
    expect(selectEmergentCandidates(edges, { threshold: 3 })).toEqual([['a', 'b']]) // a->c is below threshold
  })

  it('stops the chain at a pinned edge', () => {
    const edges = [edge(START_NODE, 'a', 5), edge('a', 'b', 9, true)]
    expect(selectEmergentCandidates(edges, { threshold: 3 })).toEqual([['a']]) // the pinned a->b is not extended
  })

  it('excludes pinned START edges', () => {
    expect(selectEmergentCandidates([edge(START_NODE, 'a', 9, true)], { threshold: 3 })).toEqual([])
  })

  it('avoids cycles', () => {
    const edges = [edge(START_NODE, 'a', 5), edge('a', 'b', 5), edge('b', 'a', 5)]
    expect(selectEmergentCandidates(edges, { threshold: 3 })).toEqual([['a', 'b']]) // b->a would revisit a
  })

  it('caps the path length at maxLen', () => {
    const edges = [edge(START_NODE, 'a', 5), edge('a', 'b', 5), edge('b', 'c', 5)]
    expect(selectEmergentCandidates(edges, { threshold: 3, maxLen: 2 })).toEqual([['a', 'b']])
  })

  it('skips sequences already named', () => {
    const edges = [edge(START_NODE, 'a', 5)]
    const alreadyNamed = new Set([sequenceKey(['a'])])
    expect(selectEmergentCandidates(edges, { threshold: 3, alreadyNamed })).toEqual([])
  })
})
