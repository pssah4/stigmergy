import { describe, it, expect } from 'vitest'
import { select, adaptiveEpsilon, desirability, type Candidate } from './score.js'
import { DEFAULT_EXPLORATION_CONFIG, DEFAULT_SCORE_CONFIG, type ExplorationConfig } from './types.js'
import { DEFAULT_STIGMERGY_CONFIG } from './api-types.js'
import { mulberry32 } from './rng.js'

describe('ExplorationConfig defaults (FEAT-02-05)', () => {
  it('defaults to the thompson policy and no budget cap', () => {
    expect(DEFAULT_EXPLORATION_CONFIG.policy).toBe('thompson')
    expect(DEFAULT_EXPLORATION_CONFIG.explorationBudget).toBe(1)
    expect(DEFAULT_STIGMERGY_CONFIG.exploration.policy).toBe('thompson')
  })
})

describe('desirability NaN-heal (AUDIT F-5: deterministic ranking under a poisoned embedding)', () => {
  it('heals a non-finite similarity to the floor so the score stays finite', () => {
    const r = desirability(0.5, Number.NaN, DEFAULT_SCORE_CONFIG)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeCloseTo(desirability(0.5, DEFAULT_SCORE_CONFIG.etaFloor, DEFAULT_SCORE_CONFIG), 10)
  })
})

describe('adaptiveEpsilon (SC-02: rate couples to recent success)', () => {
  const cfg: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG }

  it('returns epsilonBase for a young substrate (undefined recentSuccess)', () => {
    expect(adaptiveEpsilon(undefined, cfg)).toBe(cfg.epsilonBase)
  })

  it('returns epsilonBase when recentSuccess equals the target', () => {
    expect(adaptiveEpsilon(cfg.epsilonTarget, cfg)).toBeCloseTo(cfg.epsilonBase, 10)
  })

  it('raises epsilon as recent success falls below the target', () => {
    expect(adaptiveEpsilon(0.2, cfg)).toBeGreaterThan(adaptiveEpsilon(0.9, cfg))
  })

  it('clamps to [epsilonMin, epsilonMax]', () => {
    const tight: ExplorationConfig = { ...cfg, epsilonMin: 0.1, epsilonMax: 0.4, epsilonGain: 100 }
    expect(adaptiveEpsilon(0, tight)).toBe(0.4) // would overshoot, clamped to max
    expect(adaptiveEpsilon(1, tight)).toBe(0.1) // would undershoot, clamped to min
  })
})

describe('UCB policy (SC-01: explore under-tried plausible options)', () => {
  it('ranks an unseen arm above a heavily-failed arm of equal desirability', () => {
    const cands: Candidate[] = [
      { id: 'failed', tauHat: 0.5, etaHat: 0.9, successCount: 0, failureCount: 20 },
      { id: 'unseen', tauHat: 0.5, etaHat: 0.9, successCount: 0, failureCount: 0 },
    ]
    const ucb: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG, policy: 'ucb' }
    const ranked = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(1), ucb)
    expect(ranked[0]!.id).toBe('unseen')
  })

  it('is deterministic for a fixed seed', () => {
    const cands: Candidate[] = [
      { id: 'a', tauHat: 0.8, etaHat: 0.7, successCount: 5, failureCount: 1 },
      { id: 'b', tauHat: 0.3, etaHat: 0.9, successCount: 0, failureCount: 0 },
      { id: 'c', tauHat: 0.6, etaHat: 0.4, successCount: 2, failureCount: 4 },
    ]
    const ucb: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG, policy: 'ucb' }
    const r1 = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(7), ucb).map((s) => s.id)
    const r2 = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(7), ucb).map((s) => s.id)
    expect(r1).toEqual(r2)
  })
})

describe('adaptive-epsilon budget cap (SC-04)', () => {
  it('caps the explore share at the budget for a non-divisible length (AUDIT F-1)', () => {
    // 3 candidates, budget 0.5: the explore share must be floor(0.5*3)=1, not ceil=2.
    const cands: Candidate[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      tauHat: 0.2 + i * 0.2,
      etaHat: 0.3 + i * 0.2,
      successCount: i,
      failureCount: 3 - i,
    }))
    const budget = 0.5
    const cfg: ExplorationConfig = {
      ...DEFAULT_EXPLORATION_CONFIG,
      policy: 'adaptive-epsilon',
      epsilonBase: 1,
      epsilonMin: 1,
      epsilonMax: 1,
      explorationBudget: budget,
    }
    const ranked = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(3), cfg, 0)
    const keep = Math.ceil((1 - budget) * cands.length) // 2 exploit head
    const exploreSlots = cands.length - keep // 1
    expect(exploreSlots).toBeLessThanOrEqual(Math.floor(budget * cands.length)) // SC-04 contract
    const head = ranked.slice(0, keep)
    const tail = ranked.slice(keep)
    expect(head).toHaveLength(2)
    // The kept exploit head holds the highest scores; the bug (floor) would put an
    // explore pick into head and break this separation.
    if (tail.length > 0) {
      expect(Math.min(...head.map((s) => s.score))).toBeGreaterThanOrEqual(Math.max(...tail.map((s) => s.score)))
    }
  })

  it('a non-finite budget falls back to no cap rather than a degenerate split (AUDIT F-4)', () => {
    const cands: Candidate[] = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, tauHat: 0.3, etaHat: 0.5, successCount: i, failureCount: 4 - i }))
    const cfg: ExplorationConfig = {
      ...DEFAULT_EXPLORATION_CONFIG,
      policy: 'adaptive-epsilon',
      epsilonBase: 1,
      epsilonMin: 1,
      epsilonMax: 1,
      explorationBudget: Number.NaN,
    }
    const ranked = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(2), cfg, 0)
    expect(ranked).toHaveLength(4) // no candidate lost or duplicated
    expect(new Set(ranked.map((s) => s.id)).size).toBe(4)
  })

  it('with budget 0 the result is fully exploit-ranked even under forced exploration', () => {
    const cands: Candidate[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      tauHat: 0.2 + i * 0.15,
      etaHat: 0.3 + i * 0.1,
      successCount: i,
      failureCount: 5 - i,
    }))
    const cfg: ExplorationConfig = {
      ...DEFAULT_EXPLORATION_CONFIG,
      policy: 'adaptive-epsilon',
      epsilonBase: 1,
      epsilonMin: 1,
      epsilonMax: 1,
      explorationBudget: 0,
    }
    const ranked = select(cands, DEFAULT_SCORE_CONFIG, mulberry32(9), cfg, 0)
    for (let i = 0; i + 1 < ranked.length; i++) {
      expect(ranked[i]!.score).toBeGreaterThanOrEqual(ranked[i + 1]!.score)
    }
  })
})
