// Lazy exponential decay, computed at read time (ADR-06). All half-lives are in
// milliseconds (see FEAT-01-02: config values like "7 days" are converted on load).

export interface DecayParams {
  /** Pheromone value at lastUpdated. */
  pheromone: number
  lastUpdated: number
  now: number
  halfLifeMs: number
  tauMin: number
  pinned: boolean
}

export function decayedPheromone(p: DecayParams): number {
  // Heal a NaN-poisoned value to the floor (AUDIT F-02).
  if (p.pinned) return Number.isFinite(p.pheromone) ? p.pheromone : p.tauMin
  const elapsed = Math.max(0, p.now - p.lastUpdated)
  // A non-finite elapsed (bad timestamp) or non-positive/non-finite half-life degrades to no decay.
  if (!Number.isFinite(elapsed) || !Number.isFinite(p.halfLifeMs) || p.halfLifeMs <= 0) {
    return Number.isFinite(p.pheromone) ? Math.max(p.tauMin, p.pheromone) : p.tauMin
  }
  const factor = Math.exp(-(elapsed * Math.LN2) / p.halfLifeMs)
  const decayed = Math.max(p.tauMin, p.pheromone * factor)
  return Number.isFinite(decayed) ? decayed : p.tauMin
}

/** Decays accumulated success/failure evidence toward zero, no floor. */
export function decayedCount(count: number, lastUpdated: number, now: number, halfLifeMs: number): number {
  const elapsed = Math.max(0, now - lastUpdated)
  if (!Number.isFinite(elapsed) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return Number.isFinite(count) ? count : 0
  }
  const r = count * Math.exp(-(elapsed * Math.LN2) / halfLifeMs)
  return Number.isFinite(r) ? r : 0
}
