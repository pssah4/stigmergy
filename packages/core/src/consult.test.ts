import { describe, it, expect } from 'vitest'
import { prevOf, halfLifeFor, buildCandidate, resolvePinnedDecision, toRanking } from './consult.js'
import { START_NODE, DEFAULT_DECAY_CONFIG } from './types.js'
import type { Capability, Edge, PinnedPath } from './types.js'

const cfg = DEFAULT_DECAY_CONFIG

function cap(id: string): Capability {
  return { id, type: 'tool', description: id, firstSeen: '', lastSeen: '' }
}

function edge(from: string, to: string, over: Partial<Edge> = {}): Edge {
  return {
    fromCapability: from,
    toCapability: to,
    pheromone: 0.6,
    successCount: 4,
    failureCount: 1,
    pinned: false,
    pinBehavior: null,
    pinOwner: null,
    lastUpdated: new Date(0).toISOString(),
    ...over,
  }
}

describe('prevOf', () => {
  it('returns START_NODE for empty or missing history', () => {
    expect(prevOf()).toBe(START_NODE)
    expect(prevOf([])).toBe(START_NODE)
  })
  it('returns the last history element', () => {
    expect(prevOf(['a', 'b', 'c'])).toBe('c')
  })
})

describe('halfLifeFor', () => {
  it('falls back to defaultHalfLifeMs', () => {
    expect(halfLifeFor('tool', cfg)).toBe(cfg.defaultHalfLifeMs)
  })
  it('uses a per-type override', () => {
    expect(halfLifeFor('mcp', { ...cfg, halfLifeMsByType: { mcp: 123 } })).toBe(123)
  })
})

describe('buildCandidate', () => {
  const q = new Float32Array([1, 0, 0])
  const e = new Float32Array([1, 0, 0]) // identical -> cosine 1

  it('uses tauMin and zero counts for a missing edge', () => {
    const c = buildCandidate(cap('tool:a'), null, e, q, 0, cfg)
    expect(c.tauHat).toBe(cfg.tauMin)
    expect(c.successCount).toBe(0)
    expect(c.failureCount).toBe(0)
    expect(c.etaHat).toBeCloseTo(1, 6)
  })

  it('reflects the edge with no decay at zero elapsed', () => {
    const ed = edge(START_NODE, 'tool:a')
    const c = buildCandidate(cap('tool:a'), ed, e, q, 0, cfg)
    expect(c.tauHat).toBeCloseTo(0.6, 6)
    expect(c.successCount).toBeCloseTo(4, 6)
    expect(c.failureCount).toBeCloseTo(1, 6)
  })
})

describe('resolvePinnedDecision', () => {
  const seqPin: PinnedPath = {
    id: 'p1',
    capabilitySequence: ['tool:a', 'tool:b', 'tool:c'],
    behavior: 'sequence',
    parametersTemplate: { k: 1 },
    createdAt: '',
  }

  it('returns a sequence decision from START to the first step', () => {
    const res = resolvePinnedDecision(START_NODE, ['tool:a', 'tool:b'], [seqPin], [])
    expect(res?.kind).toBe('sequence')
    if (res?.kind === 'sequence' && res.decision.mode === 'sequence') {
      expect(res.decision.nextCapability).toBe('tool:a')
      expect(res.decision.remainingPath).toEqual(['tool:b', 'tool:c'])
      expect(res.decision.parameters).toEqual({ k: 1 })
    }
  })

  it('returns a sequence decision from a middle step', () => {
    const res = resolvePinnedDecision('tool:a', ['tool:b'], [seqPin], [])
    expect(res?.kind).toBe('sequence')
    if (res?.kind === 'sequence' && res.decision.mode === 'sequence') {
      expect(res.decision.nextCapability).toBe('tool:b')
      expect(res.decision.remainingPath).toEqual(['tool:c'])
    }
  })

  it('returns enforce when a pinned enforce edge targets a candidate', () => {
    const e1 = edge(START_NODE, 'tool:x', { pinned: true, pinBehavior: 'enforce' })
    const res = resolvePinnedDecision(START_NODE, ['tool:x', 'tool:y'], [], [e1])
    expect(res).toEqual({ kind: 'enforce', restrictTo: ['tool:x'] })
  })

  it('returns null when no pin applies', () => {
    expect(resolvePinnedDecision(START_NODE, ['tool:a'], [], [])).toBeNull()
  })

  it('returns null when the enforce target is not in the candidate set', () => {
    const e1 = edge(START_NODE, 'tool:x', { pinned: true, pinBehavior: 'enforce' })
    expect(resolvePinnedDecision(START_NODE, ['tool:y'], [], [e1])).toBeNull()
  })
})

describe('toRanking', () => {
  it('maps scored candidates to CapabilityRanking', () => {
    const ranked = toRanking([{ id: 'a', score: 0.5, components: { pheromone: 0.6, similarity: 0.9, thompson: 0.8 } }])
    expect(ranked[0]).toEqual({ capabilityId: 'a', score: 0.5, components: { pheromone: 0.6, similarity: 0.9, thompson: 0.8 } })
  })
})
