// Multiplicative desirability on the concrete transition plus Thompson-weighted
// selection (ADR-04, ADR-13). desirability(c) = tauHat^alpha * etaHat^beta.

import type { ScoreConfig, ExplorationConfig } from './types.js'
import { DEFAULT_EXPLORATION_CONFIG } from './types.js'
import type { SeededRng } from './rng.js'
import { betaSample } from './rng.js'

export function desirability(tauHat: number, etaHat: number, cfg: ScoreConfig): number {
  // Heal a non-finite similarity (e.g. a poisoned embedding) to the floor so the score
  // stays finite and ranking is deterministic (AUDIT FEAT-02-05 F-5, cf. decay.ts NaN-heal).
  const eta = Math.max(cfg.etaFloor, Number.isFinite(etaHat) ? etaHat : cfg.etaFloor)
  return Math.pow(tauHat, cfg.alpha) * Math.pow(eta, cfg.beta)
}

export interface Candidate {
  id: string
  /** Decayed pheromone of the transition prev->c, in [tauMin, tauMax]. */
  tauHat: number
  /** Cosine similarity between c.description and the task context. */
  etaHat: number
  successCount: number
  failureCount: number
}

export interface ScoredCandidate {
  id: string
  score: number
  components: { pheromone: number; similarity: number; thompson: number }
}

export function scoreCandidates(cands: Candidate[], cfg: ScoreConfig, rng: SeededRng): ScoredCandidate[] {
  return cands.map((c) => {
    const theta = betaSample(1 + c.successCount, 1 + c.failureCount, rng)
    const base = desirability(c.tauHat, c.etaHat, cfg)
    return {
      id: c.id,
      score: theta * base,
      components: {
        pheromone: c.tauHat,
        similarity: Math.max(cfg.etaFloor, c.etaHat),
        thompson: theta,
      },
    }
  })
}

/**
 * Seedable selection over scored candidates (ADR-13, FEAT-02-05). The default policy
 * 'thompson' is the shipped behavior, byte-identical: with probability q0 exploit by
 * score, otherwise sample without replacement proportional to score. 'ucb' ranks
 * deterministically by desirability times a UCB confidence term. 'adaptive-epsilon'
 * explores with a rate derived from the recent success rate, capped by the budget.
 */
export function select(
  cands: Candidate[],
  cfg: ScoreConfig,
  rng: SeededRng,
  exploreCfg: ExplorationConfig = DEFAULT_EXPLORATION_CONFIG,
  recentSuccessRate?: number,
): ScoredCandidate[] {
  const scored = scoreCandidates(cands, cfg, rng)
  switch (exploreCfg.policy) {
    case 'ucb':
      return rankUcb(scored, cands, cfg, exploreCfg)
    case 'adaptive-epsilon':
      return epsilonGreedy(scored, exploreCfg, rng, recentSuccessRate)
    default: {
      // 'thompson': identical to the shipped path (one q0 draw, then exploit or sample).
      const exploit = rng.next() < cfg.q0
      return exploit ? [...scored].sort((a, b) => b.score - a.score) : sampleWithoutReplacement(scored, rng)
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** UCB-over-desirability: rank by desirability(c) times (mean reward + uncertainty bonus). */
function rankUcb(scored: ScoredCandidate[], cands: Candidate[], cfg: ScoreConfig, exploreCfg: ExplorationConfig): ScoredCandidate[] {
  const byId = new Map(cands.map((c) => [c.id, c]))
  const totalN = cands.reduce((s, c) => s + c.successCount + c.failureCount, 0)
  const lnN = Math.log(totalN + 1)
  const value = (s: ScoredCandidate): number => {
    const c = byId.get(s.id)!
    const n = c.successCount + c.failureCount
    const mean = n > 0 ? c.successCount / n : 1 // optimistic for an unseen arm
    const bonus = exploreCfg.ucbC * Math.sqrt(lnN / (n + 1))
    return desirability(c.tauHat, c.etaHat, cfg) * (mean + bonus)
  }
  return [...scored].sort((a, b) => value(b) - value(a))
}

/**
 * Adaptive exploration rate (FEAT-02-05 SC-02): eps rises as the recent success rate
 * falls below the target and falls as it climbs above, clamped to [epsilonMin, epsilonMax].
 * A young substrate (recentSuccessRate undefined) yields eps = epsilonBase.
 */
export function adaptiveEpsilon(recentSuccessRate: number | undefined, cfg: ExplorationConfig): number {
  const recentS = recentSuccessRate ?? cfg.epsilonTarget
  return clamp(cfg.epsilonBase + (cfg.epsilonTarget - recentS) * cfg.epsilonGain, cfg.epsilonMin, cfg.epsilonMax)
}

/** epsilon-greedy with an adaptive rate from the recent success rate, capped by the budget. */
function epsilonGreedy(scored: ScoredCandidate[], exploreCfg: ExplorationConfig, rng: SeededRng, recentSuccessRate?: number): ScoredCandidate[] {
  const eps = adaptiveEpsilon(recentSuccessRate, exploreCfg)
  const exploitRanked = [...scored].sort((a, b) => b.score - a.score)
  if (rng.next() >= eps) return exploitRanked
  return budgetedExplore(exploitRanked, scored, exploreCfg.explorationBudget, rng)
}

/**
 * Keep the top (1 - budget) fraction as exploit picks; sample the rest. The explore share
 * (len - keep) is floor(budget * len), so it never exceeds the budget (AUDIT FEAT-02-05 F-1).
 * A non-finite budget falls back to 1 (no cap) rather than a degenerate split (F-4).
 */
function budgetedExplore(exploitRanked: ScoredCandidate[], scored: ScoredCandidate[], budget: number, rng: SeededRng): ScoredCandidate[] {
  const b = Number.isFinite(budget) ? clamp(budget, 0, 1) : 1
  const keep = Math.ceil((1 - b) * exploitRanked.length)
  const head = exploitRanked.slice(0, keep)
  const headIds = new Set(head.map((s) => s.id))
  const rest = scored.filter((s) => !headIds.has(s.id))
  return [...head, ...sampleWithoutReplacement(rest, rng)]
}

function sampleWithoutReplacement(scored: ScoredCandidate[], rng: SeededRng): ScoredCandidate[] {
  const pool = [...scored]
  const result: ScoredCandidate[] = []
  while (pool.length > 0) {
    const total = pool.reduce((s, c) => s + Math.max(0, c.score), 0)
    if (total <= 0) {
      result.push(...pool)
      break
    }
    let r = rng.next() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(0, pool[i]!.score)
      if (r <= 0) {
        idx = i
        break
      }
    }
    result.push(pool[idx]!)
    pool.splice(idx, 1)
  }
  return result
}
