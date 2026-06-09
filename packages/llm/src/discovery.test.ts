import { describe, it, expect } from 'vitest'
import { fetchModels, fetchEmbeddingModels } from './discovery.js'
import type { ProviderDeps } from './types.js'

// A fake fetch that returns a canned JSON body and records the requests, standing in for the global
// fetch (no real network). Mirrors the Response shape discovery.ts reads (ok/status/json()).
function fakeFetch(body: unknown, status = 200): { deps: ProviderDeps; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return { deps: { fetch }, calls }
}

describe('fetchModels (FEAT-05-06, ported from VO)', () => {
  it('lists OpenAI chat models, filters embeddings/image, sends the Bearer key (SC-01/SC-04)', async () => {
    const { deps, calls } = fakeFetch({
      data: [
        { id: 'gpt-4o', created: 2 },
        { id: 'gpt-4o-mini', created: 3 },
        { id: 'text-embedding-3-small', created: 1 },
        { id: 'dall-e-3', created: 1 },
        { id: 'o1', created: 4 },
      ],
    })
    const models = await fetchModels({ type: 'openai', apiKey: 'sk-x' }, deps)
    expect(models.map((m) => m.id)).toEqual(['o1', 'gpt-4o-mini', 'gpt-4o']) // chat only, newest first
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-x')
  })

  it('lists Anthropic claude models via x-api-key (SC-01/SC-04)', async () => {
    const { deps, calls } = fakeFetch({ data: [{ id: 'claude-opus-4', display_name: 'Claude Opus 4' }, { id: 'not-claude' }] })
    const models = await fetchModels({ type: 'anthropic', apiKey: 'sk-ant' }, deps)
    expect(models).toEqual([{ id: 'claude-opus-4', label: 'Claude Opus 4' }])
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[0].headers['x-api-key']).toBe('sk-ant')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
  })

  it('lists Ollama models from /api/tags without auth', async () => {
    const { deps, calls } = fakeFetch({ models: [{ name: 'qwen' }, { name: 'llama3' }] })
    const models = await fetchModels({ type: 'ollama', baseUrl: 'http://localhost:11434' }, deps)
    expect(models.map((m) => m.id)).toEqual(['llama3', 'qwen']) // sorted
    expect(calls[0].url).toBe('http://localhost:11434/api/tags')
    expect(calls[0].headers['Authorization']).toBeUndefined()
  })

  it('lists only tool-capable OpenRouter models', async () => {
    const { deps } = fakeFetch({
      data: [
        { id: 'a/b', name: 'A', supported_parameters: ['tools'] },
        { id: 'c/d', name: 'C', supported_parameters: ['temperature'] },
      ],
    })
    const models = await fetchModels({ type: 'openrouter' }, deps)
    expect(models).toEqual([{ id: 'a/b', label: 'A' }])
  })

  it('throws a clear error on a non-200 from a custom provider', async () => {
    const { deps } = fakeFetch({ error: 'nope' }, 500)
    await expect(fetchModels({ type: 'custom', baseUrl: 'http://localhost:9999' }, deps)).rejects.toThrow(/500/)
  })
})

describe('fetchEmbeddingModels (FEAT-05-06)', () => {
  it('returns the known OpenAI embedding list without a network call (SC-02)', async () => {
    const { deps, calls } = fakeFetch({})
    const models = await fetchEmbeddingModels({ type: 'openai', apiKey: 'sk-x' }, deps)
    expect(models.map((m) => m.id)).toContain('text-embedding-3-small')
    expect(calls).toHaveLength(0) // static list, no fetch
  })

  it('filters Ollama tags to embedding-looking models', async () => {
    const { deps } = fakeFetch({ models: [{ name: 'nomic-embed-text' }, { name: 'llama3' }, { name: 'bge-m3' }] })
    const models = await fetchEmbeddingModels({ type: 'ollama', baseUrl: 'http://localhost:11434' }, deps)
    expect(models.map((m) => m.id).sort()).toEqual(['bge-m3', 'nomic-embed-text'])
  })

  it('filters a custom /v1/models list by the embed pattern', async () => {
    const { deps } = fakeFetch({ data: [{ id: 'text-embedding-x' }, { id: 'chat-y' }] })
    const models = await fetchEmbeddingModels({ type: 'custom', baseUrl: 'http://host/v1' }, deps)
    expect(models.map((m) => m.id)).toEqual(['text-embedding-x'])
  })
})
