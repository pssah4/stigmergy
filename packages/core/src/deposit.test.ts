import { describe, it, expect } from 'vitest'
import { acceptanceWeight, clampEfficiency, computeDelta, clip, edgePairs } from './deposit.js'
import { START_NODE } from './types.js'

describe('acceptanceWeight', () => {
  it('is 1.0 accepted, 0.3 iterated, 0.0 abandoned', () => {
    expect(acceptanceWeight('accepted')).toBe(1.0)
    expect(acceptanceWeight('iterated')).toBe(0.3)
    expect(acceptanceWeight('abandoned')).toBe(0.0)
  })
})

describe('clampEfficiency', () => {
  it('clamps baselineCost/tokenCost into [eMin, eMax]', () => {
    expect(clampEfficiency(100, 100, 0.5, 2)).toBeCloseTo(1, 6)
    expect(clampEfficiency(100, 10, 0.5, 2)).toBe(2) // raw 10 -> eMax
    expect(clampEfficiency(100, 1000, 0.5, 2)).toBe(0.5) // raw 0.1 -> eMin
  })
  it('clamps unknown cost (tokenCost <= 0) to eMin (conservative)', () => {
    expect(clampEfficiency(100, 0, 0.5, 2)).toBe(0.5)
    expect(clampEfficiency(100, -5, 0.5, 2)).toBe(0.5)
  })
})

describe('computeDelta', () => {
  it('is rho * quality * efficiency', () => {
    expect(computeDelta(1.0, 1.0, 0.3)).toBeCloseTo(0.3, 6)
    expect(computeDelta(0.3, 1.0, 0.3)).toBeCloseTo(0.09, 6)
    expect(computeDelta(0.0, 2.0, 0.3)).toBe(0) // abandoned -> no reinforcement
  })
  it('iterated yields a smaller delta than accepted', () => {
    expect(computeDelta(0.3, 1, 0.3)).toBeLessThan(computeDelta(1.0, 1, 0.3))
  })
})

describe('clip', () => {
  it('bounds a value', () => {
    expect(clip(1.5, 0.05, 1.0)).toBe(1.0)
    expect(clip(0.0, 0.05, 1.0)).toBe(0.05)
    expect(clip(0.5, 0.05, 1.0)).toBe(0.5)
  })
  it('floors NaN to min so non-finite values cannot poison the substrate', () => {
    expect(clip(NaN, 0.05, 1.0)).toBe(0.05)
  })
})

describe('clampEfficiency non-finite guard', () => {
  it('clamps a NaN tokenCost to eMin', () => {
    expect(clampEfficiency(100, NaN, 0.5, 2)).toBe(0.5)
  })
  it('clamps an infinite tokenCost to eMin', () => {
    expect(clampEfficiency(100, Infinity, 0.5, 2)).toBe(0.5)
  })
})

describe('acceptanceWeight default', () => {
  it('returns 0 for an out-of-enum outcome instead of undefined', () => {
    expect(acceptanceWeight('bogus' as unknown as 'accepted')).toBe(0)
  })
})

describe('edgePairs', () => {
  it('prepends START_NODE and pairs consecutive steps', () => {
    expect(edgePairs(['a', 'b', 'c'])).toEqual([
      [START_NODE, 'a'],
      ['a', 'b'],
      ['b', 'c'],
    ])
  })
  it('is empty for an empty path', () => {
    expect(edgePairs([])).toEqual([])
  })
})
