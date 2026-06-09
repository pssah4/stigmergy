// Emergent-path detection (ADR-19, FEAT-04-04). Pure graph logic the daemon runs each tick to find
// strongly-reinforced, not-yet-pinned trails worth auto-naming: chains of non-pinned edges starting
// at START whose decayed success_count crosses a threshold, walked greedily by success_count,
// cycle-free, capped in length, and excluding sequences already named. No IO, so it is unit-tested.
import { START_NODE } from '@agentic-stigmergy/core'

export interface EmergentEdge {
  fromCapability: string
  toCapability: string
  successCount: number
  pinned: boolean
}

export interface EmergentOptions {
  /** Minimum decayed success_count for an edge to count as reinforced. */
  threshold: number
  /** Max path length in capabilities (START excluded). Default 4. */
  maxLen?: number
  /** Sequence keys already named/pinned, to skip (key from sequenceKey). */
  alreadyNamed?: ReadonlySet<string>
}

/** Stable key for a capability sequence (NUL-joined, the same separator the engine uses for edge keys). */
export function sequenceKey(seq: readonly string[]): string {
  return seq.join('\u0000')
}

/** Candidate emergent paths worth auto-naming. Greedy along the strongest non-pinned, reinforced
 * edges from START; each candidate is the capability sequence (START excluded). */
export function selectEmergentCandidates(edges: readonly EmergentEdge[], opts: EmergentOptions): string[][] {
  const maxLen = opts.maxLen ?? 4
  const named = opts.alreadyNamed ?? new Set<string>()
  const byFrom = new Map<string, EmergentEdge[]>()
  for (const e of edges) {
    if (e.pinned || e.successCount < opts.threshold) continue // only reinforced, non-pinned edges
    const list = byFrom.get(e.fromCapability) ?? []
    list.push(e)
    byFrom.set(e.fromCapability, list)
  }
  for (const list of byFrom.values()) list.sort((a, b) => b.successCount - a.successCount)

  const out: string[][] = []
  const seen = new Set<string>()
  for (const first of byFrom.get(START_NODE) ?? []) {
    const seq: string[] = []
    const visited = new Set<string>([START_NODE])
    let edge: EmergentEdge | undefined = first
    while (edge && seq.length < maxLen && !visited.has(edge.toCapability)) {
      seq.push(edge.toCapability)
      visited.add(edge.toCapability)
      edge = (byFrom.get(edge.toCapability) ?? []).find((e) => !visited.has(e.toCapability))
    }
    if (seq.length === 0) continue
    const key = sequenceKey(seq)
    if (named.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(seq)
  }
  return out
}
