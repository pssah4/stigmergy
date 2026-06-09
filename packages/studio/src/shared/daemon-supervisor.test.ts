import { describe, it, expect } from 'vitest'
import { restartDelayMs, shouldRestart, appendLogLines, DEFAULT_RESTART_POLICY } from './daemon-supervisor.js'

describe('restartDelayMs (FEAT-04-09 P1-5)', () => {
  it('backs off exponentially and caps at maxDelayMs', () => {
    expect(restartDelayMs(0)).toBe(500)
    expect(restartDelayMs(1)).toBe(1000)
    expect(restartDelayMs(2)).toBe(2000)
    expect(restartDelayMs(99)).toBe(DEFAULT_RESTART_POLICY.maxDelayMs) // capped
  })
})

describe('shouldRestart (FEAT-04-09 P1-5)', () => {
  it('does not restart when the operator stopped it intentionally', () => {
    expect(shouldRestart({ intentional: true, code: 1, attempt: 0 })).toBe(false)
  })
  it('does not restart on a clean exit (code 0)', () => {
    expect(shouldRestart({ intentional: false, code: 0, attempt: 0 })).toBe(false)
  })
  it('restarts on a crash while retries remain, and gives up once exhausted', () => {
    expect(shouldRestart({ intentional: false, code: 1, attempt: 0 })).toBe(true)
    expect(shouldRestart({ intentional: false, code: null, attempt: 4 })).toBe(true) // killed by signal, 1 retry left
    expect(shouldRestart({ intentional: false, code: 1, attempt: DEFAULT_RESTART_POLICY.maxRetries })).toBe(false)
  })
  it('never restarts on a terminal/refusal exit code (4 = lock contention, 2 = bad args)', () => {
    expect(shouldRestart({ intentional: false, code: 4, attempt: 0 })).toBe(false) // another daemon owns it
    expect(shouldRestart({ intentional: false, code: 2, attempt: 0 })).toBe(false) // bad arguments
  })
})

describe('appendLogLines (FEAT-04-09 P1-5)', () => {
  it('appends non-blank lines and keeps only the last `max`', () => {
    let buf: string[] = []
    buf = appendLogLines(buf, 'starting\n\nserving on socket\n')
    expect(buf).toEqual(['starting', 'serving on socket'])
    buf = appendLogLines(buf, 'a\nb\nc', 3) // -> [starting, serving, a, b, c] capped to the last 3
    expect(buf).toEqual(['a', 'b', 'c'])
  })
  it('returns an unchanged copy when the chunk is all blank', () => {
    expect(appendLogLines(['x'], '\n  \n')).toEqual(['x'])
  })
})
