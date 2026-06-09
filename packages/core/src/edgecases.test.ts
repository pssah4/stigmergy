import { describe, it, expect } from 'vitest'
import * as core from './index'
import { USER_VERSION, SCHEMA_SQL } from './schema'
import { betaSample, mulberry32 } from './rng'
import { select } from './score'
import type { Candidate } from './score'
import { decayedPheromone } from './decay'
import { DEFAULT_SCORE_CONFIG } from './types'

describe('barrel exports (index)', () => {
  it('re-exports the public surface', () => {
    expect(typeof core.decayedPheromone).toBe('function')
    expect(typeof core.select).toBe('function')
    expect(typeof core.mulberry32).toBe('function')
    expect(core.USER_VERSION).toBe(5)
    expect(core.START_NODE).toBe('__START__')
  })
})

describe('schema', () => {
  it('declares the current user_version and the evidence, augmentation, inventory and runtime columns', () => {
    expect(USER_VERSION).toBe(5)
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS edges')
    expect(SCHEMA_SQL).toContain('success_count')
    expect(SCHEMA_SQL).toContain('failure_count')
    expect(SCHEMA_SQL).toContain('description_augmented')
    expect(SCHEMA_SQL).toContain('source TEXT')
    expect(SCHEMA_SQL).toContain('when_to_use')
    expect(SCHEMA_SQL).toContain('path_source')
    expect(SCHEMA_SQL).toContain('runtime_config')
  })
})

describe('betaSample with shape below 1', () => {
  it('stays in [0,1] and is deterministic for fractional shapes', () => {
    const v1 = betaSample(0.5, 0.5, mulberry32(11))
    const v2 = betaSample(0.5, 0.5, mulberry32(11))
    expect(v1).toEqual(v2)
    expect(v1).toBeGreaterThanOrEqual(0)
    expect(v1).toBeLessThanOrEqual(1)
  })
})

describe('select explore path (q0 = 0)', () => {
  const cands: Candidate[] = [
    { id: 'a', tauHat: 0.9, etaHat: 0.9, successCount: 5, failureCount: 0 },
    { id: 'b', tauHat: 0.5, etaHat: 0.5, successCount: 1, failureCount: 1 },
    { id: 'c', tauHat: 0.3, etaHat: 0.4, successCount: 0, failureCount: 2 },
  ]
  const exploreCfg = { ...DEFAULT_SCORE_CONFIG, q0: 0 }

  it('returns a full permutation, deterministic for the same seed', () => {
    const r1 = select(cands, exploreCfg, mulberry32(3)).map((x) => x.id).sort()
    expect(r1).toEqual(['a', 'b', 'c'])
    const a = select(cands, exploreCfg, mulberry32(9)).map((x) => x.id)
    const b = select(cands, exploreCfg, mulberry32(9)).map((x) => x.id)
    expect(a).toEqual(b)
  })

  it('keeps all candidates when every score is zero', () => {
    const zero: Candidate[] = [
      { id: 'x', tauHat: 0, etaHat: 0, successCount: 0, failureCount: 0 },
      { id: 'y', tauHat: 0, etaHat: 0, successCount: 0, failureCount: 0 },
    ]
    const out = select(zero, exploreCfg, mulberry32(1))
    expect(out.map((o) => o.id).sort()).toEqual(['x', 'y'])
  })
})

describe('decayedPheromone with now < lastUpdated', () => {
  it('clamps negative elapsed to zero, value unchanged', () => {
    const v = decayedPheromone({
      pheromone: 0.7,
      lastUpdated: 1000,
      now: 500,
      halfLifeMs: 1000,
      tauMin: 0.05,
      pinned: false,
    })
    expect(v).toBeCloseTo(0.7, 6)
  })
})
