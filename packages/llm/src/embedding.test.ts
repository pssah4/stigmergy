import { describe, it, expect } from 'vitest'
import { makeOpenAiCompatibleEmbedding } from './embedding.js'
import type { ProviderDeps } from './types.js'

function fakeFetch(body: unknown, status = 200): {
  deps: ProviderDeps
  calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }>
} {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }> = []
  const fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method, headers: init?.headers ?? {}, body: init?.body })
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return { deps: { fetch }, calls }
}

describe('makeOpenAiCompatibleEmbedding (FEAT-05-06, ADR-24)', () => {
  it('posts to /v1/embeddings, reads data[0].embedding, and reports the dimension (SC-03)', async () => {
    const { deps, calls } = fakeFetch({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })
    const emb = makeOpenAiCompatibleEmbedding({ type: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-x' }, deps)
    const vec = await emb.embed('hello')
    expect(Array.from(vec)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ])
    expect(emb.dimension()).toBe(3) // auto-corrected from the first embedding
    expect(emb.modelHash()).toBe('openai:text-embedding-3-small')
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-x')
    expect(JSON.parse(calls[0].body!)).toEqual({ model: 'text-embedding-3-small', input: ['hello'] })
  })

  it('normalizes a local base URL and sends no auth header without a key', async () => {
    const { deps, calls } = fakeFetch({ data: [{ index: 0, embedding: [1, 0] }] })
    const emb = makeOpenAiCompatibleEmbedding({ type: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://localhost:11434' }, deps)
    await emb.embed('x')
    expect(calls[0].url).toBe('http://localhost:11434/v1/embeddings')
    expect(calls[0].headers['Authorization']).toBeUndefined()
    expect(emb.modelHash()).toBe('ollama:nomic-embed-text')
  })

  it('throws on a non-ok response and on a missing embedding', async () => {
    const err = fakeFetch({ error: 'bad' }, 401)
    const e1 = makeOpenAiCompatibleEmbedding({ type: 'openai', model: 'm', apiKey: 'k' }, err.deps)
    await expect(e1.embed('x')).rejects.toThrow(/401/)
    const empty = fakeFetch({ data: [] })
    const e2 = makeOpenAiCompatibleEmbedding({ type: 'custom', model: 'm', baseUrl: 'http://h/v1' }, empty.deps)
    await expect(e2.embed('x')).rejects.toThrow(/embedding/i)
  })
})
