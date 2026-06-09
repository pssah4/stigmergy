import { describe, it, expect } from 'vitest'
import { cosine, isoToMs } from './vector.js'

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    expect(cosine(v, v)).toBeCloseTo(1, 6)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6)
  })

  it('is 0 when one vector is the zero vector', () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })

  it('throws on a dimension mismatch', () => {
    expect(() => cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toThrow(/dimension mismatch/)
  })
})

describe('isoToMs', () => {
  it('roundtrips against Date.toISOString', () => {
    const ms = 1_700_000_000_000
    expect(isoToMs(new Date(ms).toISOString())).toBe(ms)
  })
})
