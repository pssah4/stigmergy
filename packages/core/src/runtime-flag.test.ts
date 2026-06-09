import { describe, it, expect } from 'vitest'
import { CachedFlag } from './runtime-flag.js'

describe('CachedFlag (EPIC-04 FEAT-04-06)', () => {
  it('reads once and serves cache hits within the TTL', async () => {
    const flag = new CachedFlag(2000)
    let reads = 0
    const read = async (): Promise<boolean> => {
      reads++
      return true
    }
    expect(await flag.get(0, read)).toBe(true)
    expect(await flag.get(1000, read)).toBe(true) // within TTL -> cache hit
    expect(await flag.get(1999, read)).toBe(true)
    expect(reads).toBe(1) // no storage call on a hit (SC-04)
  })

  it('re-reads after the TTL elapses', async () => {
    const flag = new CachedFlag(2000)
    let reads = 0
    const read = async (): Promise<boolean> => {
      reads++
      return reads === 1 // first read true, later false
    }
    expect(await flag.get(0, read)).toBe(true)
    expect(await flag.get(2000, read)).toBe(false) // TTL elapsed -> re-read
    expect(reads).toBe(2)
  })

  it('re-reads immediately after invalidate (a local write)', async () => {
    const flag = new CachedFlag(2000)
    let value = false
    const read = async (): Promise<boolean> => value
    expect(await flag.get(0, read)).toBe(false)
    value = true
    flag.invalidate()
    expect(await flag.get(1, read)).toBe(true) // invalidate forces a re-read before the TTL
  })
})
