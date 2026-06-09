import { describe, it, expect } from 'vitest'
import { decayedPheromone, decayedCount } from './decay'

const H = 7 * 24 * 60 * 60 * 1000 // one week in ms

describe('decayedPheromone', () => {
  it('halves after one half-life', () => {
    const v = decayedPheromone({ pheromone: 1, lastUpdated: 0, now: H, halfLifeMs: H, tauMin: 0, pinned: false })
    expect(v).toBeCloseTo(0.5, 6)
  })

  it('is unchanged at zero elapsed time', () => {
    const v = decayedPheromone({ pheromone: 0.8, lastUpdated: 100, now: 100, halfLifeMs: H, tauMin: 0.05, pinned: false })
    expect(v).toBeCloseTo(0.8, 6)
  })

  it('floors at tauMin', () => {
    const v = decayedPheromone({ pheromone: 1, lastUpdated: 0, now: H * 100, halfLifeMs: H, tauMin: 0.05, pinned: false })
    expect(v).toBe(0.05)
  })

  it('leaves pinned edges immune to decay', () => {
    const v = decayedPheromone({ pheromone: 0.9, lastUpdated: 0, now: H * 100, halfLifeMs: H, tauMin: 0.05, pinned: true })
    expect(v).toBe(0.9)
  })
})

describe('decayedCount', () => {
  it('halves after one half-life and trends to zero', () => {
    expect(decayedCount(10, 0, H, H)).toBeCloseTo(5, 6)
    expect(decayedCount(10, 0, H * 50, H)).toBeLessThan(0.001)
  })
  it('returns the count unchanged when halfLifeMs is zero (no NaN)', () => {
    expect(decayedCount(4, 0, 0, 0)).toBe(4)
  })
})

describe('decay non-finite guards', () => {
  it('does not decay (no division by zero) when halfLifeMs is zero', () => {
    const v = decayedPheromone({ pheromone: 0.6, lastUpdated: 0, now: 0, halfLifeMs: 0, tauMin: 0.05, pinned: false })
    expect(v).toBeCloseTo(0.6, 6)
  })
  it('heals a NaN pheromone to tauMin instead of propagating NaN', () => {
    const v = decayedPheromone({ pheromone: NaN, lastUpdated: 0, now: H, halfLifeMs: H, tauMin: 0.05, pinned: false })
    expect(v).toBe(0.05)
  })
  it('returns tauMin for a NaN-poisoned pinned edge', () => {
    const v = decayedPheromone({ pheromone: NaN, lastUpdated: 0, now: H, halfLifeMs: H, tauMin: 0.05, pinned: true })
    expect(v).toBe(0.05)
  })
})
