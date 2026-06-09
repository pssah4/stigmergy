// Pure consult helpers. The engine wires these with storage reads; they hold no
// state and do no IO, so they are deterministically unit-testable (ADR-04).

import { START_NODE } from './types.js'
import type { Capability, Decision, CapabilityRanking, Edge, PinnedPath, DecayConfig } from './types.js'
import type { Candidate, ScoredCandidate } from './score.js'
import { decayedPheromone, decayedCount } from './decay.js'
import { cosine, isoToMs } from './vector.js'

export function prevOf(history?: string[]): string {
  return history && history.length > 0 ? history[history.length - 1]! : START_NODE
}

export function halfLifeFor(type: string, cfg: DecayConfig): number {
  return cfg.halfLifeMsByType[type] ?? cfg.defaultHalfLifeMs
}

/**
 * Build a score.ts Candidate for capability `c` on the transition prev->c.
 * The edge (or null for a missing transition) is passed in; this stays pure.
 */
export function buildCandidate(
  c: Capability,
  edge: Edge | null,
  capEmbedding: Float32Array | undefined,
  queryEmbedding: Float32Array | undefined,
  nowMs: number,
  decayCfg: DecayConfig,
): Candidate {
  const halfLife = halfLifeFor(c.type, decayCfg)
  // A missing vector (the background embedder has not produced it yet, ADR-25) or a dimension mismatch
  // yields a non-finite etaHat, which select() heals to etaFloor: the turn ranks on pheromone alone.
  const etaHat =
    capEmbedding && queryEmbedding && capEmbedding.length === queryEmbedding.length
      ? cosine(capEmbedding, queryEmbedding)
      : Number.NaN
  if (!edge) {
    // Missing transition: minimum strength, optimistic Beta(1,1) via zero counts.
    return { id: c.id, tauHat: decayCfg.tauMin, etaHat, successCount: 0, failureCount: 0 }
  }
  const lastMs = isoToMs(edge.lastUpdated)
  return {
    id: c.id,
    tauHat: decayedPheromone({
      pheromone: edge.pheromone,
      lastUpdated: lastMs,
      now: nowMs,
      halfLifeMs: halfLife,
      tauMin: decayCfg.tauMin,
      pinned: edge.pinned,
    }),
    etaHat,
    successCount: decayedCount(edge.successCount, lastMs, nowMs, halfLife),
    failureCount: decayedCount(edge.failureCount, lastMs, nowMs, halfLife),
  }
}

export function toRanking(scored: ScoredCandidate[]): CapabilityRanking[] {
  return scored.map((s) => ({ capabilityId: s.id, score: s.score, components: s.components }))
}

export type PinResolution =
  | { kind: 'sequence'; decision: Decision }
  | { kind: 'enforce'; restrictTo: string[] }
  | null

/**
 * Decide whether a pin applies for the transition out of `prev`.
 * - sequence: a pinned path whose sequence contains prev (or START), next step in the candidate set.
 * - enforce: pinned outgoing edges with behavior 'enforce' whose target is in the candidate set.
 * - null: no pin applies, the caller falls back to ranked.
 */
export function resolvePinnedDecision(
  prev: string,
  candidateIds: string[],
  pinnedPaths: PinnedPath[],
  outgoingEdges: Edge[],
  /** whenToUse gate (ADR-18, FEAT-04-03): a 'sequence' pin fires only when its gate is open. Default
   * always-open (no gating). enforce is never gated (a hard lock stays hard); preferred is a soft
   * bias via pheromone and is not gated here. */
  gateOpen: (pp: PinnedPath) => boolean = () => true,
): PinResolution {
  const idSet = new Set(candidateIds)

  for (const pp of pinnedPaths) {
    if (pp.behavior !== 'sequence') continue
    if (!gateOpen(pp)) continue // off-topic for this task: let normal foraging select instead
    const seq = pp.capabilitySequence
    const i = prev === START_NODE ? -1 : seq.indexOf(prev)
    if (prev !== START_NODE && i === -1) continue
    const next = seq[i + 1]
    if (next !== undefined && idSet.has(next)) {
      return {
        kind: 'sequence',
        decision: {
          mode: 'sequence',
          nextCapability: next,
          parameters: pp.parametersTemplate ?? {},
          remainingPath: seq.slice(i + 2),
        },
      }
    }
  }

  const enforced = outgoingEdges
    .filter((e) => e.pinned && e.pinBehavior === 'enforce' && idSet.has(e.toCapability))
    .map((e) => e.toCapability)
  if (enforced.length > 0) return { kind: 'enforce', restrictTo: enforced }

  return null
}
