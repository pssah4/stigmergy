import { describe, it, expect } from 'vitest'
import { BackgroundEmbedder } from './embedding-worker.js'
import type { EmbeddingPort } from './ports.js'

// A counting EmbeddingPort: deterministic vectors, counts calls, can be made to fail once.
function makeEmbedding(opts: { failFirst?: boolean } = {}): EmbeddingPort & { calls: number } {
  let failed = false
  return {
    calls: 0,
    async embed(text: string): Promise<Float32Array> {
      ;(this as { calls: number }).calls++
      if (opts.failFirst && !failed) {
        failed = true
        throw new Error('embed boom')
      }
      // a stable 3-dim vector derived from the text length, enough to assert identity
      const n = text.length
      return new Float32Array([n, n + 1, n + 2])
    },
    dimension: () => 3,
    modelHash: () => 'test-model',
  }
}

describe('BackgroundEmbedder (IMP-04-09-04)', () => {
  it('embeds a capability off the hot path: getCapabilityVector is undefined until drained, then set', async () => {
    const embedding = makeEmbedding()
    const persisted: string[] = []
    const w = new BackgroundEmbedder({ embedding, onCapabilityEmbedded: async (r) => void persisted.push(r.id) })

    w.enqueueCapability('tool:a', 'helper', 'tool')
    expect(w.getCapabilityVector('tool:a')).toBeUndefined() // not embedded synchronously

    await w.whenIdle()
    const got = w.getCapabilityVector('tool:a')
    expect(got?.modelHash).toBe('test-model')
    expect(Array.from(got!.vector)).toEqual([6, 7, 8]) // 'helper'.length === 6
    expect(persisted).toEqual(['tool:a']) // persisted exactly once
    await w.stop()
  })

  it('embeds a query off the hot path and serves it from getQueryVector after drain', async () => {
    const embedding = makeEmbedding()
    const w = new BackgroundEmbedder({ embedding })
    w.enqueueQuery('find docs')
    expect(w.getQueryVector('find docs')).toBeUndefined()
    await w.whenIdle()
    expect(Array.from(w.getQueryVector('find docs')!)).toEqual([9, 10, 11]) // 'find docs'.length === 9
    await w.stop()
  })

  it('dedupes repeated enqueues before a drain so embed runs once', async () => {
    const embedding = makeEmbedding()
    const w = new BackgroundEmbedder({ embedding })
    w.enqueueCapability('tool:a', 'same text', 'tool')
    w.enqueueCapability('tool:a', 'same text', 'tool')
    w.enqueueQuery('q')
    w.enqueueQuery('q')
    await w.whenIdle()
    expect(embedding.calls).toBe(2) // one capability + one query, not four
    await w.stop()
  })

  it('a failing embed does not poison the queue: later work still drains', async () => {
    const embedding = makeEmbedding({ failFirst: true })
    const errors: unknown[] = []
    const w = new BackgroundEmbedder({ embedding, onError: (e) => void errors.push(e) })
    w.enqueueCapability('tool:bad', 'will fail first', 'tool')
    await w.whenIdle()
    expect(errors).toHaveLength(1) // the failure surfaced to onError, not thrown
    w.enqueueCapability('tool:good', 'works now', 'tool')
    await w.whenIdle()
    expect(w.getCapabilityVector('tool:good')).toBeDefined()
    await w.stop()
  })

  it('stop() halts draining: enqueues after stop are not embedded', async () => {
    const embedding = makeEmbedding()
    const w = new BackgroundEmbedder({ embedding })
    await w.stop()
    w.enqueueCapability('tool:a', 'x', 'tool')
    await w.whenIdle()
    expect(embedding.calls).toBe(0)
    expect(w.getCapabilityVector('tool:a')).toBeUndefined()
  })
})
