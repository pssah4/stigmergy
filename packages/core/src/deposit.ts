// Pure deposit math (ADR-04 Deposit). Advantage-relative: reward = quality x
// efficiency, applied to the pheromone of each edge along the path under MMAS
// bounds. quality and efficiency stay separate so the harness can ablate them.

import { START_NODE } from './types.js'
import type { Outcome } from './types.js'

export function acceptanceWeight(outcome: Outcome): number {
  switch (outcome) {
    case 'accepted':
      return 1.0
    case 'iterated':
      return 0.3
    case 'abandoned':
      return 0.0
    default:
      // Out-of-enum value from a tampered/imported substrate: no reward (AUDIT F-04).
      return 0.0
  }
}

/**
 * efficiency = clamp(baselineCost / tokenCost, [eMin, eMax]).
 * Non-finite or non-positive cost clamps to eMin: conservative reward, and NaN never
 * propagates into the pheromone (PLAN-04 critique, AUDIT F-02).
 */
export function clampEfficiency(baselineCost: number, tokenCost: number, eMin: number, eMax: number): number {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) return eMin
  return clip(baselineCost / tokenCost, eMin, eMax)
}

export function computeDelta(quality: number, efficiency: number, rho: number): number {
  return rho * quality * efficiency
}

export function clip(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min // NaN/Infinity floors to min, never poisons the substrate (AUDIT F-02)
  return Math.min(max, Math.max(min, value))
}

/** Edge pairs along [START_NODE, ...path], so [START->p0, p0->p1, ...]. */
export function edgePairs(path: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  let prev = START_NODE
  for (const c of path) {
    pairs.push([prev, c])
    prev = c
  }
  return pairs
}
