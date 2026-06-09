// Shared EmbeddingPort conformance suite (FEAT-01-05). Every embedding adapter
// (and the deterministic FakeEmbedding test double) runs it so the contract that
// consult relies on holds identically: a fixed positive dimension, a stable model
// hash, deterministic L2-normalized vectors, and a similarity geometry where
// overlapping text scores above disjoint text (ADR-12).

import { describe, it, expect, beforeEach } from 'vitest'
import { cosine } from '@agentic-stigmergy/core'
import type { EmbeddingPort } from '@agentic-stigmergy/core'

export function defineEmbeddingConformance(name: string, makeEmbedding: () => Promise<EmbeddingPort>): void {
  describe(`EmbeddingPort conformance: ${name}`, () => {
    let e: EmbeddingPort

    beforeEach(async () => {
      e = await makeEmbedding()
    })

    it('reports a positive integer dimension and embeds to it', async () => {
      const d = e.dimension()
      expect(Number.isInteger(d)).toBe(true)
      expect(d).toBeGreaterThan(0)
      const v = await e.embed('hello world')
      expect(v).toBeInstanceOf(Float32Array)
      expect(v.length).toBe(d)
    })

    it('has a stable non-empty modelHash', async () => {
      const h = e.modelHash()
      expect(typeof h).toBe('string')
      expect(h.length).toBeGreaterThan(0)
      expect(e.modelHash()).toBe(h)
    })

    it('is deterministic for the same text', async () => {
      const a = await e.embed('the quick brown fox')
      const b = await e.embed('the quick brown fox')
      expect(Array.from(a)).toEqual(Array.from(b))
    })

    it('produces L2-normalized vectors (self-cosine is 1)', async () => {
      const v = await e.embed('alpha beta gamma')
      let norm = 0
      for (const x of v) norm += x * x
      expect(Math.sqrt(norm)).toBeCloseTo(1, 3)
      expect(cosine(v, v)).toBeCloseTo(1, 5)
    })

    it('scores overlapping text above disjoint text', async () => {
      const base = await e.embed('alpha beta gamma delta')
      const overlap = await e.embed('alpha beta gamma epsilon')
      const disjoint = await e.embed('zeta eta theta iota')
      expect(cosine(base, overlap)).toBeGreaterThan(cosine(base, disjoint))
    })
  })
}
