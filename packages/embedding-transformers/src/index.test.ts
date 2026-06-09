import { describe, it, expect } from 'vitest'
import { defineEmbeddingConformance } from '@stigmergy/storage-conformance'
import { TransformersEmbedding, type FeatureExtractor } from './index.js'

// Deterministic unit tests for the audit fixes, using the loadPipeline injector so no model or
// network is needed (AUDIT 2).
const extractorOf = (data: Float32Array): (() => Promise<FeatureExtractor>) => {
  return async () => async () => ({ data })
}

describe('TransformersEmbedding (audit fixes, injected pipeline)', () => {
  it('pins a model revision in modelHash by default, and marks local mode', () => {
    expect(new TransformersEmbedding().modelHash()).toContain('@751bff')
    expect(new TransformersEmbedding({ localModelPath: '/models/minilm' }).modelHash()).toBe(
      'local:Xenova/all-MiniLM-L6-v2',
    )
  })

  it('does not poison the adapter after a transient first-load failure (retries)', async () => {
    let calls = 0
    const emb = new TransformersEmbedding({
      loadPipeline: async () => {
        calls++
        if (calls === 1) throw new Error('load-fail')
        return async () => ({ data: new Float32Array([0.1, 0.2]) })
      },
    })
    await expect(emb.embed('x')).rejects.toThrow('load-fail')
    await expect(emb.embed('x')).resolves.toBeInstanceOf(Float32Array) // retried, not poisoned
    expect(calls).toBe(2)
  })

  it('auto-corrects the reported dimension from the first embedding', async () => {
    const emb = new TransformersEmbedding({ dimension: 384, loadPipeline: extractorOf(new Float32Array(8)) })
    expect(emb.dimension()).toBe(384) // configured default before any embed
    await emb.embed('x')
    expect(emb.dimension()).toBe(8) // corrected from the real output
  })

  it('returns a defensive copy, never the pipeline buffer', async () => {
    const shared = new Float32Array([1, 2, 3])
    const emb = new TransformersEmbedding({ loadPipeline: extractorOf(shared) })
    const r1 = await emb.embed('a')
    r1[0] = 99
    const r2 = await emb.embed('b')
    expect(r2[0]).toBe(1) // unaffected by mutating an earlier result
    expect(shared[0]).toBe(1) // the pipeline buffer is untouched
  })

  it('rejects oversize input', async () => {
    const emb = new TransformersEmbedding({ loadPipeline: extractorOf(new Float32Array(2)) })
    await expect(emb.embed('x'.repeat(100_001))).rejects.toThrow()
  })
})

// The real model download (network plus filesystem) is the trust boundary the deep audit will
// cover, so this integration test is opt-in: the default suite stays offline and deterministic
// (the EmbeddingPort contract is already proven against FakeEmbedding in the conformance package).
// Run with: STIGMERGY_EMBEDDING_IT=1 npm test
if (process.env.STIGMERGY_EMBEDDING_IT === '1') {
  defineEmbeddingConformance('all-MiniLM-L6-v2 (transformers.js on onnxruntime-node)', async () => new TransformersEmbedding())
} else {
  describe.skip('EmbeddingPort conformance: all-MiniLM-L6-v2 (set STIGMERGY_EMBEDDING_IT=1 to run the real model)', () => {
    it('is skipped without a model and network', () => {})
  })
}
