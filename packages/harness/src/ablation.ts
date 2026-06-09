// Ablation knobs mapped onto a complete StigmergyConfig (FEAT-02-03, FEAT-02-05, ADR-13).
// The mapping returns a COMPLETE config (built from the engine default), so it is robust
// to the engine's config-merge semantics: every top-level key is fully specified.
//
// FEAT-02-05 wired the selection-policy axis (thompson default, ucb, adaptive-epsilon)
// and the exploration budget. Still deferred and throwing when set: scoreMode=linear
// (a FEAT-01-02 follow-up IMP, ADR-04 chose multiplicative) and heterogeneousEvaluator
// (FEAT-02-04, not yet built).
import { DEFAULT_STIGMERGY_CONFIG, type StigmergyConfig, type ExplorationPolicy } from '@agentic-stigmergy/core'

export interface AblationKnobs {
  /** Pheromone decay on (default) or off (no forgetting, infinite half-life). */
  decay?: boolean
  /** Uniform half-life in ms for the decay sweep; overrides the default. Ignored when decay is off. */
  halfLifeMs?: number
  /** Lower pheromone bound for the tau_min sweep. */
  tauMin?: number
  /** Context conditioning (similarity term) on (default) or off (beta = 0). */
  contextConditioning?: boolean
  /** Cost-aware reward (efficiency factor) on (default) or off (efficiency pinned to 1). */
  costAwareReward?: boolean
  /** Selection policy (FEAT-02-05): 'thompson' (default), 'ucb', or 'adaptive-epsilon'. */
  selection?: ExplorationPolicy
  /** Exploration budget cap in [0, 1] (FEAT-02-05); 1 = no cap. */
  explorationBudget?: number
  /** Deferred: 'linear' throws; 'multiplicative' is the no-op default. */
  scoreMode?: 'multiplicative' | 'linear'
  /** Deferred: true throws (heterogeneous evaluator is FEAT-02-04). */
  heterogeneousEvaluator?: boolean
}

/** Raised when a run-config sets an ablation axis not available in Scope A. */
export class UnsupportedAblationError extends Error {
  constructor(
    readonly axis: string,
    reason: string,
  ) {
    super(`unsupported ablation axis '${axis}' in Scope A: ${reason}`)
    this.name = 'UnsupportedAblationError'
  }
}

const NO_DECAY_HALF_LIFE_MS = Number.POSITIVE_INFINITY

function guardDeferred(k: AblationKnobs): void {
  if (k.scoreMode === 'linear') {
    throw new UnsupportedAblationError(
      'scoreMode=linear',
      'engine is multiplicative-only (ADR-04 chose multiplicative over linear); linear mode is a FEAT-01-02 follow-up IMP',
    )
  }
  if (k.explorationBudget !== undefined && (!Number.isFinite(k.explorationBudget) || k.explorationBudget < 0 || k.explorationBudget > 1)) {
    throw new RangeError(`explorationBudget must be a finite number within [0, 1], got ${k.explorationBudget}`)
  }
  if (k.heterogeneousEvaluator) {
    throw new UnsupportedAblationError('heterogeneousEvaluator', 'the heterogeneous evaluator is FEAT-02-04, not yet built')
  }
}

/**
 * Build a complete StigmergyConfig for a variant from the ablation knobs and the seed.
 * decay-off takes precedence over a half-life value.
 */
export function applyAblation(knobs: AblationKnobs, seed: number): StigmergyConfig {
  guardDeferred(knobs)
  if (knobs.tauMin !== undefined && (knobs.tauMin < 0 || knobs.tauMin > DEFAULT_STIGMERGY_CONFIG.decay.tauMax)) {
    throw new RangeError(`tauMin must be within [0, ${DEFAULT_STIGMERGY_CONFIG.decay.tauMax}], got ${knobs.tauMin}`)
  }
  const base = DEFAULT_STIGMERGY_CONFIG
  const decayOn = knobs.decay ?? true
  const contextOn = knobs.contextConditioning ?? true
  const costOn = knobs.costAwareReward ?? true
  return {
    ...base,
    seed,
    score: { ...base.score, beta: contextOn ? base.score.beta : 0 },
    decay: {
      ...base.decay,
      defaultHalfLifeMs: decayOn ? (knobs.halfLifeMs ?? base.decay.defaultHalfLifeMs) : NO_DECAY_HALF_LIFE_MS,
      tauMin: knobs.tauMin ?? base.decay.tauMin,
    },
    deposit: {
      ...base.deposit,
      eMin: costOn ? base.deposit.eMin : 1,
      eMax: costOn ? base.deposit.eMax : 1,
    },
    exploration: {
      ...base.exploration,
      policy: knobs.selection ?? base.exploration.policy,
      explorationBudget: knobs.explorationBudget ?? base.exploration.explorationBudget,
    },
  }
}
