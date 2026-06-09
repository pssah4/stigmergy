// Deterministic EmbeddingPort for conformance and integration tests. Bag-of-words
// hash projection, L2-normalised, so cosine geometry is real: overlapping texts
// score high, disjoint texts score low. No real ONNX/transformers.js in the MVP
// test setup. Not for production.

import type { EmbeddingPort } from '../ports.js'

const DIM = 64

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class FakeEmbedding implements EmbeddingPort {
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIM)
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    for (const t of tokens) {
      const idx = fnv1a(t) % DIM
      v[idx] = (v[idx] ?? 0) + 1
    }
    let norm = 0
    for (let i = 0; i < DIM; i++) norm += (v[i] ?? 0) * (v[i] ?? 0)
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm
    }
    return v
  }

  dimension(): number {
    return DIM
  }

  modelHash(): string {
    return 'fake-v1'
  }
}
