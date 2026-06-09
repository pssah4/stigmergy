// Scheduler port for the auto-accept timeout (ADR-05). RealScheduler in
// production, VirtualScheduler (clock-driven) in tests so timeouts are
// deterministic (FEAT-01-03 SC-04, ADR-06).

import type { ClockProvider } from './clock.js'

export type TimerHandle = unknown
export type TimerCallback = () => void | Promise<void>

export interface Scheduler {
  setTimer(delayMs: number, cb: TimerCallback): TimerHandle
  clear(handle: TimerHandle): void
}

export class RealScheduler implements Scheduler {
  /** onError surfaces a rejected timer callback (e.g. a rolled-back deposit) instead of an unhandled rejection. */
  constructor(private readonly onError?: (err: unknown) => void) {}

  setTimer(delayMs: number, cb: TimerCallback): TimerHandle {
    return setTimeout(() => {
      Promise.resolve()
        .then(cb)
        .catch((err) => {
          if (this.onError) this.onError(err)
        })
    }, delayMs)
  }

  clear(handle: TimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

interface QueuedTimer {
  dueAt: number
  seq: number
  cb: TimerCallback
  handle: object
}

export class VirtualScheduler implements Scheduler {
  private queue: QueuedTimer[] = []
  private seq = 0

  constructor(private readonly clock: ClockProvider) {}

  setTimer(delayMs: number, cb: TimerCallback): TimerHandle {
    const handle = {}
    this.queue.push({ dueAt: this.clock.now() + delayMs, seq: this.seq++, cb, handle })
    return handle
  }

  clear(handle: TimerHandle): void {
    this.queue = this.queue.filter((e) => e.handle !== handle)
  }

  /** Fire every timer due at or before `now`, in (dueAt, seq) order. Awaits async callbacks. */
  async runDue(now: number): Promise<void> {
    const due = this.queue
      .filter((e) => e.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)
    this.queue = this.queue.filter((e) => e.dueAt > now)
    for (const e of due) {
      await e.cb()
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
