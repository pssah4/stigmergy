import { describe, it, expect } from 'vitest'
import { FixedClock, SystemClock } from './clock'

describe('FixedClock', () => {
  it('returns the set time, advances, and resets', () => {
    const c = new FixedClock(1000)
    expect(c.now()).toBe(1000)
    c.advance(500)
    expect(c.now()).toBe(1500)
    c.set(42)
    expect(c.now()).toBe(42)
  })
})

describe('SystemClock', () => {
  it('returns a positive epoch in ms', () => {
    expect(new SystemClock().now()).toBeGreaterThan(0)
  })
})
