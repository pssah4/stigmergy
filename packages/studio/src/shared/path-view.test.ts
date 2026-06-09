import { describe, it, expect } from 'vitest'
import { filterPinnedPaths, pathNodeIds, pathLabel, pathEdgeKeys, successorCandidates, filterCapabilities } from './path-view.js'
import type { PinnedPathView, EdgeView, CapabilityView } from './graph-model.js'

const paths: PinnedPathView[] = [
  { id: 'pin-1', name: 'Cat care', behavior: 'sequence', capabilitySequence: ['tool:feed', 'tool:groom'] },
  { id: 'pin-2', name: 'Tax filing', behavior: 'preferred', capabilitySequence: ['tool:taxes'] },
  { id: 'pin-3', behavior: 'enforce', capabilitySequence: ['skill:summary'] }, // no name
]

describe('filterPinnedPaths (FEAT-06-01)', () => {
  it('returns all paths for an empty or whitespace query', () => {
    expect(filterPinnedPaths(paths, '')).toHaveLength(3)
    expect(filterPinnedPaths(paths, '   ')).toHaveLength(3)
  })

  it('matches the name case-insensitively', () => {
    expect(filterPinnedPaths(paths, 'cat').map((p) => p.id)).toEqual(['pin-1'])
    expect(filterPinnedPaths(paths, 'TAX').map((p) => p.id)).toEqual(['pin-2'])
  })

  it('matches a capability id in the sequence', () => {
    expect(filterPinnedPaths(paths, 'groom').map((p) => p.id)).toEqual(['pin-1'])
    expect(filterPinnedPaths(paths, 'skill:summary').map((p) => p.id)).toEqual(['pin-3'])
  })

  it('matches the behavior and the id (for an unnamed path)', () => {
    expect(filterPinnedPaths(paths, 'enforce').map((p) => p.id)).toEqual(['pin-3'])
    expect(filterPinnedPaths(paths, 'pin-2').map((p) => p.id)).toEqual(['pin-2'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPinnedPaths(paths, 'zzdisjoint')).toEqual([])
  })
})

describe('pathNodeIds (FEAT-06-01)', () => {
  it('returns the capability sequence as the highlight set', () => {
    expect(pathNodeIds(paths[0]!)).toEqual(['tool:feed', 'tool:groom'])
  })
})

describe('pathLabel (FEAT-06-05)', () => {
  it('uses the name when present', () => {
    expect(pathLabel(paths[0]!)).toBe('Cat care')
  })

  it('falls back to "first -> last" for an unnamed multi-step path', () => {
    expect(pathLabel({ id: 'p', behavior: 'sequence', capabilitySequence: ['read_file', 'patch', 'test'] })).toBe('read_file -> test')
  })

  it('uses the single capability for an unnamed one-step path', () => {
    expect(pathLabel(paths[2]!)).toBe('skill:summary')
  })

  it('falls back to the id when unnamed with an empty sequence', () => {
    expect(pathLabel({ id: 'pin-x', behavior: 'preferred', capabilitySequence: [] })).toBe('pin-x')
  })

  it('treats a blank/whitespace name as no name', () => {
    expect(pathLabel({ id: 'pin-y', name: '   ', behavior: 'preferred', capabilitySequence: ['a', 'b'] })).toBe('a -> b')
  })
})

describe('pathEdgeKeys (FEAT-06-05)', () => {
  it('returns the consecutive directed step keys, not every pair among the nodes', () => {
    expect(pathEdgeKeys({ id: 'p', behavior: 'sequence', capabilitySequence: ['a', 'b', 'c'] })).toEqual(['a->b', 'b->c'])
  })

  it('returns no keys for a single-step or empty path', () => {
    expect(pathEdgeKeys({ id: 'p', behavior: 'preferred', capabilitySequence: ['a'] })).toEqual([])
    expect(pathEdgeKeys({ id: 'p', behavior: 'preferred', capabilitySequence: [] })).toEqual([])
  })
})

describe('successorCandidates (FEAT-06-06)', () => {
  const edges: EdgeView[] = [
    { fromCapability: 'a', toCapability: 'b', pheromone: 0.3, pinned: false },
    { fromCapability: 'a', toCapability: 'c', pheromone: 0.9, pinned: false },
    { fromCapability: 'b', toCapability: 'c', pheromone: 0.5, pinned: false },
  ]

  it('returns the learned successors of a node, strongest first', () => {
    expect(successorCandidates(edges, 'a')).toEqual(['c', 'b'])
  })

  it('returns an empty list for a node with no outgoing edges', () => {
    expect(successorCandidates(edges, 'c')).toEqual([])
  })
})

describe('filterCapabilities (FEAT-06-06)', () => {
  const caps: CapabilityView[] = [
    { id: 'tool:read_file', type: 'tool', description: 'read a file' },
    { id: 'skill:summarize', type: 'skill', description: 'summarize text' },
    { id: 'mcp:srv:search', type: 'mcp', description: 'search the web' },
  ]

  it('returns all capabilities for an empty query', () => {
    expect(filterCapabilities(caps, '')).toHaveLength(3)
  })

  it('matches id, type and description case-insensitively', () => {
    expect(filterCapabilities(caps, 'READ').map((c) => c.id)).toEqual(['tool:read_file'])
    expect(filterCapabilities(caps, 'skill').map((c) => c.id)).toEqual(['skill:summarize'])
    expect(filterCapabilities(caps, 'web').map((c) => c.id)).toEqual(['mcp:srv:search'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterCapabilities(caps, 'zzz')).toEqual([])
  })
})
