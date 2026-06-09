import { describe, it, expect } from 'vitest'
import { FakeEmbedding } from './fake-embedding.js'
import { cosine } from '../vector.js'

const fe = new FakeEmbedding()

describe('FakeEmbedding', () => {
  it('is deterministic for the same text', async () => {
    expect(Array.from(await fe.embed('hello world'))).toEqual(Array.from(await fe.embed('hello world')))
  })

  it('cosine of identical texts is 1', async () => {
    expect(cosine(await fe.embed('report quarterly sales'), await fe.embed('report quarterly sales'))).toBeCloseTo(1, 6)
  })

  it('overlapping texts score at or above 0.5 (iteration)', async () => {
    const sim = cosine(await fe.embed('report quarterly sales'), await fe.embed('report quarterly revenue'))
    expect(sim).toBeGreaterThanOrEqual(0.5)
  })

  it('disjoint texts score below 0.5 (topic shift)', async () => {
    const sim = cosine(await fe.embed('alpha beta gamma'), await fe.embed('delta epsilon zeta'))
    expect(sim).toBeLessThan(0.5)
  })

  it('dimension and modelHash are constant', () => {
    expect(fe.dimension()).toBe(64)
    expect(fe.modelHash()).toBe('fake-v1')
  })
})
