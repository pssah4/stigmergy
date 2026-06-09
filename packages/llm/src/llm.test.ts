import { describe, it, expect, vi } from 'vitest'
import { buildApiHandler } from './factory.js'
import { AnthropicHandler } from './providers/anthropic.js'
import { OpenAiCompatibleHandler } from './providers/openai-compatible.js'
import { FakeApiHandler } from './fake.js'
import { makeCapabilityAugmenter } from './capability-augmenter.js'
import { getModelInfo, listModels } from './model-registry.js'
import { classifyModelTier } from './tier.js'
import { getModelPrice, computeCost } from './pricing.js'
import { noopCrypter, encryptCredentialsInPlace, decryptCredentialsInPlace, type SettingsCrypter } from './crypter.js'
import type { ApiHandler, ProviderDeps } from './types.js'

// A fetch stub matching typeof fetch that returns a JSON Response.
function jsonFetch(payload: unknown, init?: ResponseInit): ProviderDeps['fetch'] & { mock: { calls: unknown[][] } } {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, ...init })) as unknown as ProviderDeps['fetch'] & {
    mock: { calls: unknown[][] }
  }
}

describe('FakeApiHandler', () => {
  it('is deterministic and echoes the first non-empty prompt line', async () => {
    const h = new FakeApiHandler('rich')
    const a = await h.classifyText('first line\nsecond')
    const b = await h.classifyText('first line\nsecond')
    expect(a).toBe(b)
    expect(a).toBe('rich: first line')
  })
})

describe('buildApiHandler', () => {
  it('returns the right handler per provider type (exhaustive)', () => {
    expect(buildApiHandler({ type: 'anthropic', model: 'm' })).toBeInstanceOf(AnthropicHandler)
    for (const t of ['openai', 'ollama', 'lmstudio', 'openrouter', 'custom'] as const) {
      expect(buildApiHandler({ type: t, model: 'm' })).toBeInstanceOf(OpenAiCompatibleHandler)
    }
  })
})

describe('AnthropicHandler.classifyText', () => {
  it('posts to /v1/messages and extracts the trimmed text block', async () => {
    const fetch = jsonFetch({ content: [{ type: 'text', text: '  enriched  ' }] })
    const h = new AnthropicHandler({ type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' }, { fetch })
    expect(await h.classifyText('hello')).toBe('enriched')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
    expect((opts.headers as Record<string, string>)['x-api-key']).toBe('k')
    expect((opts.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(opts.body as string) as { model: string; max_tokens: number; messages: unknown[] }
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.max_tokens).toBe(128)
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('throws on a non-2xx response', async () => {
    const fetch = vi.fn(async () => new Response('no', { status: 500, statusText: 'err' })) as unknown as ProviderDeps['fetch']
    const h = new AnthropicHandler({ type: 'anthropic', model: 'm' }, { fetch })
    await expect(h.classifyText('x')).rejects.toThrow(/failed: 500/)
  })
})

describe('OpenAiCompatibleHandler.classifyText', () => {
  it('posts to /chat/completions on the ollama default base, no key -> no auth header', async () => {
    const fetch = jsonFetch({ choices: [{ message: { content: ' local out ' } }] })
    const h = new OpenAiCompatibleHandler({ type: 'ollama', model: 'llama3.1' }, { fetch })
    expect(await h.classifyText('hi')).toBe('local out')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('http://localhost:11434/v1/chat/completions')
    expect((opts.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('sends a bearer key when configured and honours a custom baseUrl', async () => {
    const fetch = jsonFetch({ choices: [{ message: { content: 'x' } }] })
    const h = new OpenAiCompatibleHandler({ type: 'custom', model: 'm', apiKey: 'sk', baseUrl: 'https://api.example.com/v1/' }, { fetch })
    await h.classifyText('hi')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://api.example.com/v1/chat/completions')
    expect((opts.headers as Record<string, string>).authorization).toBe('Bearer sk')
  })

  it('throws on a non-2xx response and returns empty on missing choices', async () => {
    const errFetch = vi.fn(async () => new Response('no', { status: 502, statusText: 'bad gateway' })) as unknown as ProviderDeps['fetch']
    const h = new OpenAiCompatibleHandler({ type: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }, { fetch: errFetch })
    await expect(h.classifyText('x')).rejects.toThrow(/failed: 502/)
    const empty = jsonFetch({ choices: [] })
    const h2 = new OpenAiCompatibleHandler({ type: 'openai', model: 'gpt-4o-mini' }, { fetch: empty })
    expect(await h2.classifyText('x')).toBe('')
  })
})

describe('AnthropicHandler edge cases', () => {
  it('returns empty when the response carries no text block', async () => {
    const fetch = jsonFetch({ content: [{ type: 'tool_use' }] })
    const h = new AnthropicHandler({ type: 'anthropic', model: 'm', apiKey: 'k' }, { fetch })
    expect(await h.classifyText('x')).toBe('')
  })
})

describe('makeCapabilityAugmenter', () => {
  it('augments via classifyText and records the model', async () => {
    const aug = makeCapabilityAugmenter(new FakeApiHandler('rich'), { model: 'claude-haiku-4-5-20251001' })
    const r = await aug.augment({ id: 'tool:a', type: 'tool', description: 'read a file' })
    expect(r?.model).toBe('claude-haiku-4-5-20251001')
    expect(r?.description.startsWith('rich:')).toBe(true)
  })

  it('returns null when classifyText throws (fallback to raw)', async () => {
    const throwing: ApiHandler = {
      classifyText: async () => {
        throw new Error('boom')
      },
    }
    const aug = makeCapabilityAugmenter(throwing, { model: 'm' })
    expect(await aug.augment({ id: 'a', type: 'tool', description: 'd' })).toBeNull()
  })

  it('returns null on empty output', async () => {
    const empty: ApiHandler = { classifyText: async () => '   ' }
    const aug = makeCapabilityAugmenter(empty, { model: 'm' })
    expect(await aug.augment({ id: 'a', type: 'tool', description: 'd' })).toBeNull()
  })

  it('aborts and returns null on timeout', async () => {
    const hanging: ApiHandler = {
      classifyText: (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const aug = makeCapabilityAugmenter(hanging, { model: 'm', timeoutMs: 10 })
    expect(await aug.augment({ id: 'a', type: 'tool', description: 'd' })).toBeNull()
  })

  it('enforces the deadline even when the handler ignores the abort signal', async () => {
    // A handler that never honours the signal and resolves only after a long delay must not
    // block past timeoutMs: the Promise.race deadline returns null first.
    const ignoresSignal: ApiHandler = {
      classifyText: () => new Promise((resolve) => setTimeout(() => resolve('too late'), 1000)),
    }
    const aug = makeCapabilityAugmenter(ignoresSignal, { model: 'm', timeoutMs: 20 })
    const start = Date.now()
    expect(await aug.augment({ id: 'a', type: 'tool', description: 'd' })).toBeNull()
    expect(Date.now() - start).toBeLessThan(500) // resolved at the deadline, not after 1000ms
  })
})

describe('model-registry / tier / pricing', () => {
  it('looks up model info and lists models', () => {
    expect(getModelInfo('gpt-4o-mini')?.provider).toBe('openai')
    expect(getModelInfo('does-not-exist')).toBeNull()
    expect(listModels().length).toBeGreaterThanOrEqual(3)
  })

  it('classifies tiers by pattern, local/unknown -> null', () => {
    expect(classifyModelTier('claude-opus-4-8')).toBe('flagship')
    expect(classifyModelTier('claude-sonnet-4-6')).toBe('mid')
    expect(classifyModelTier('claude-haiku-4-5')).toBe('fast')
    expect(classifyModelTier('gpt-4o-mini')).toBe('fast')
    expect(classifyModelTier('some-random-local')).toBeNull()
  })

  it('computes USD cost, null for an unpriced model', () => {
    expect(getModelPrice('gpt-4o-mini')?.inputPerMillionUsd).toBe(0.15)
    expect(computeCost('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6)
    expect(computeCost('unpriced', 100, 100)).toBeNull()
  })
})

describe('SettingsCrypter helpers', () => {
  it('noopCrypter is a passthrough', () => {
    expect(noopCrypter.isEncrypted('x')).toBe(false)
    expect(noopCrypter.encrypt('x')).toBe('x')
    expect(noopCrypter.decrypt('x')).toBe('x')
  })

  it('encrypt/decrypt credential fields in place, idempotent, skipping empties', () => {
    const crypter: SettingsCrypter = {
      isEncrypted: (v) => v.startsWith('enc:v1:'),
      encrypt: (v) => `enc:v1:${v}`,
      decrypt: (v) => (v.startsWith('enc:v1:') ? v.slice('enc:v1:'.length) : v),
    }
    const obj: Record<string, unknown> = { apiKey: 'secret', baseUrl: 'https://x', empty: '' }
    encryptCredentialsInPlace(obj, ['apiKey', 'empty'], crypter)
    expect(obj.apiKey).toBe('enc:v1:secret')
    expect(obj.empty).toBe('') // skipped
    encryptCredentialsInPlace(obj, ['apiKey'], crypter) // idempotent
    expect(obj.apiKey).toBe('enc:v1:secret')
    decryptCredentialsInPlace(obj, ['apiKey'], crypter)
    expect(obj.apiKey).toBe('secret')
    expect(obj.baseUrl).toBe('https://x') // untouched
  })
})
