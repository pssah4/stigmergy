import { describe, it, expect } from 'vitest'
import { mulberry32, betaSample } from './rng'

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
  })

  it('produces values in [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('differs for different seeds', () => {
    expect(mulberry32(1).next()).not.toEqual(mulberry32(2).next())
  })
})

describe('betaSample', () => {
  it('is deterministic for the same seed', () => {
    expect(betaSample(2, 5, mulberry32(99))).toEqual(betaSample(2, 5, mulberry32(99)))
  })

  it('mean approximates a / (a + b)', () => {
    const r = mulberry32(2024)
    const n = 5000
    let sum = 0
    for (let i = 0; i < n; i++) sum += betaSample(2, 8, r)
    const mean = sum / n
    // true mean is 0.2
    expect(mean).toBeGreaterThan(0.16)
    expect(mean).toBeLessThan(0.24)
  })

  it('stays in [0, 1]', () => {
    const r = mulberry32(5)
    for (let i = 0; i < 500; i++) {
      const a = 1 + Math.floor(r.next() * 5)
      const b = 1 + Math.floor(r.next() * 5)
      const v = betaSample(a, b, r)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
