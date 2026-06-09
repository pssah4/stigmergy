import { describe, it, expect, vi } from 'vitest'
import { VirtualScheduler, RealScheduler } from './scheduler.js'
import { FixedClock } from './clock.js'

describe('VirtualScheduler', () => {
  it('fires a timer at runDue once it is due', async () => {
    const clock = new FixedClock(0)
    const s = new VirtualScheduler(clock)
    let fired = false
    s.setTimer(100, () => {
      fired = true
    })
    clock.advance(50)
    await s.runDue(clock.now())
    expect(fired).toBe(false)
    clock.advance(50)
    await s.runDue(clock.now())
    expect(fired).toBe(true)
  })

  it('clear removes a timer before it fires', async () => {
    const clock = new FixedClock(0)
    const s = new VirtualScheduler(clock)
    let fired = false
    const h = s.setTimer(100, () => {
      fired = true
    })
    s.clear(h)
    clock.advance(200)
    await s.runDue(clock.now())
    expect(fired).toBe(false)
  })

  it('fires two timers of equal due time in FIFO (seq) order', async () => {
    const clock = new FixedClock(0)
    const s = new VirtualScheduler(clock)
    const order: number[] = []
    s.setTimer(100, () => {
      order.push(1)
    })
    s.setTimer(100, () => {
      order.push(2)
    })
    clock.advance(100)
    await s.runDue(clock.now())
    expect(order).toEqual([1, 2])
  })

  it('awaits async callbacks before resolving runDue', async () => {
    const clock = new FixedClock(0)
    const s = new VirtualScheduler(clock)
    let done = false
    s.setTimer(10, async () => {
      await Promise.resolve()
      done = true
    })
    clock.advance(10)
    await s.runDue(clock.now())
    expect(done).toBe(true)
  })
})

describe('RealScheduler', () => {
  it('invokes the callback via setTimeout', async () => {
    vi.useFakeTimers()
    try {
      const s = new RealScheduler()
      let fired = false
      s.setTimer(100, () => {
        fired = true
      })
      // The callback runs one microtask after the timer fires (so a rejection can be caught).
      await vi.advanceTimersByTimeAsync(99)
      expect(fired).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(fired).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes a rejected callback to onError instead of an unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      let captured: unknown
      const s = new RealScheduler((err) => {
        captured = err
      })
      s.setTimer(10, async () => {
        throw new Error('boom')
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(captured).toBeInstanceOf(Error)
      expect((captured as Error).message).toBe('boom')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clear cancels the timer', () => {
    vi.useFakeTimers()
    try {
      const s = new RealScheduler()
      let fired = false
      const h = s.setTimer(100, () => {
        fired = true
      })
      s.clear(h)
      vi.advanceTimersByTime(200)
      expect(fired).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
