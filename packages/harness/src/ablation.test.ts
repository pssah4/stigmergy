import { describe, it, expect } from 'vitest'
import { DEFAULT_STIGMERGY_CONFIG } from '@agentic-stigmergy/core'
import { applyAblation, UnsupportedAblationError } from './ablation.js'

describe('applyAblation: five Scope-A axes', () => {
  it('with no knobs matches the engine default config plus the seed', () => {
    const c = applyAblation({}, 42)
    expect(c.seed).toBe(42)
    expect(c.score.beta).toBe(DEFAULT_STIGMERGY_CONFIG.score.beta)
    expect(c.decay.defaultHalfLifeMs).toBe(DEFAULT_STIGMERGY_CONFIG.decay.defaultHalfLifeMs)
    expect(c.decay.tauMin).toBe(DEFAULT_STIGMERGY_CONFIG.decay.tauMin)
    expect(c.deposit.eMin).toBe(DEFAULT_STIGMERGY_CONFIG.deposit.eMin)
    expect(c.deposit.eMax).toBe(DEFAULT_STIGMERGY_CONFIG.deposit.eMax)
  })

  it('decay off sets an infinite half-life (no forgetting)', () => {
    expect(applyAblation({ decay: false }, 1).decay.defaultHalfLifeMs).toBe(Number.POSITIVE_INFINITY)
  })

  it('half-life sweep overrides the default half-life', () => {
    expect(applyAblation({ halfLifeMs: 3_600_000 }, 1).decay.defaultHalfLifeMs).toBe(3_600_000)
  })

  it('decay off wins over a half-life value', () => {
    expect(applyAblation({ decay: false, halfLifeMs: 1000 }, 1).decay.defaultHalfLifeMs).toBe(Number.POSITIVE_INFINITY)
  })

  it('tau_min sweep sets the pheromone floor', () => {
    expect(applyAblation({ tauMin: 0.2 }, 1).decay.tauMin).toBe(0.2)
  })

  it('context conditioning off zeroes the similarity exponent', () => {
    expect(applyAblation({ contextConditioning: false }, 1).score.beta).toBe(0)
  })

  it('cost-aware reward off pins efficiency to 1', () => {
    const c = applyAblation({ costAwareReward: false }, 1)
    expect(c.deposit.eMin).toBe(1)
    expect(c.deposit.eMax).toBe(1)
  })

  it('rejects a tau_min outside [0, tauMax]', () => {
    expect(() => applyAblation({ tauMin: 5 }, 1)).toThrow(RangeError)
  })
})

describe('applyAblation: deferred axes throw (Scope A)', () => {
  it('linear score mode throws', () => {
    expect(() => applyAblation({ scoreMode: 'linear' }, 1)).toThrow(UnsupportedAblationError)
  })

  it('heterogeneous evaluator throws', () => {
    expect(() => applyAblation({ heterogeneousEvaluator: true }, 1)).toThrow(UnsupportedAblationError)
  })

  it('multiplicative and thompson are allowed no-ops', () => {
    expect(() => applyAblation({ scoreMode: 'multiplicative', selection: 'thompson' }, 1)).not.toThrow()
  })
})

describe('selection policy mapping (FEAT-02-05, was deferred in Scope A)', () => {
  it('maps selection to exploration.policy (UCB no longer throws)', () => {
    expect(applyAblation({ selection: 'ucb' }, 1).exploration.policy).toBe('ucb')
    expect(applyAblation({ selection: 'adaptive-epsilon' }, 1).exploration.policy).toBe('adaptive-epsilon')
    expect(applyAblation({}, 1).exploration.policy).toBe('thompson')
  })

  it('maps explorationBudget onto the config', () => {
    expect(applyAblation({ explorationBudget: 0.3 }, 1).exploration.explorationBudget).toBe(0.3)
    expect(applyAblation({}, 1).exploration.explorationBudget).toBe(1)
  })

  it('rejects an explorationBudget outside [0, 1]', () => {
    expect(() => applyAblation({ explorationBudget: 1.5 }, 1)).toThrow(RangeError)
  })

  it('rejects a non-finite explorationBudget (AUDIT F-4)', () => {
    expect(() => applyAblation({ explorationBudget: Number.NaN }, 1)).toThrow(RangeError)
  })
})
