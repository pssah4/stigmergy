import { describe, it, expect } from 'vitest'
import { desirability, select, scoreCandidates } from './score'
import type { Candidate } from './score'
import { mulberry32 } from './rng'
import { DEFAULT_SCORE_CONFIG } from './types'

const cfg = DEFAULT_SCORE_CONFIG

describe('desirability', () => {
  it('is multiplicative, a low eta suppresses a strong tau', () => {
    const strongTauLowEta = desirability(1.0, 0.01, cfg) // eta floored
    const midBoth = desirability(0.5, 0.5, cfg)
    expect(strongTauLowEta).toBeLessThan(midBoth)
  })

  it('applies the eta floor', () => {
    expect(desirability(0.5, 0, cfg)).toEqual(desirability(0.5, cfg.etaFloor, cfg))
  })

  it('is monotonic in tau and in eta', () => {
    expect(desirability(0.6, 0.5, cfg)).toBeGreaterThan(desirability(0.4, 0.5, cfg))
    expect(desirability(0.5, 0.6, cfg)).toBeGreaterThan(desirability(0.5, 0.4, cfg))
  })
})

describe('select', () => {
  const cands: Candidate[] = [
    { id: 'a', tauHat: 0.9, etaHat: 0.9, successCount: 10, failureCount: 0 },
    { id: 'b', tauHat: 0.2, etaHat: 0.3, successCount: 0, failureCount: 8 },
    { id: 'c', tauHat: 0.5, etaHat: 0.6, successCount: 2, failureCount: 1 },
  ]

  it('is deterministic for the same seed', () => {
    const r1 = select(cands, cfg, mulberry32(42)).map((x) => x.id)
    const r2 = select(cands, cfg, mulberry32(42)).map((x) => x.id)
    expect(r1).toEqual(r2)
  })

  it('ranks the strong candidate first in exploit mode (q0 = 1)', () => {
    const exploitCfg = { ...cfg, q0: 1 }
    const ranked = select(cands, exploitCfg, mulberry32(7))
    expect(ranked[0]!.id).toBe('a')
  })

  it('suppresses a failure-dominated candidate over many draws', () => {
    let aWins = 0
    let bWins = 0
    for (let s = 0; s < 200; s++) {
      const scored = scoreCandidates(cands, cfg, mulberry32(s))
      const a = scored.find((x) => x.id === 'a')!.score
      const b = scored.find((x) => x.id === 'b')!.score
      if (a > b) aWins++
      else bWins++
    }
    expect(aWins).toBeGreaterThan(bWins)
  })
})
