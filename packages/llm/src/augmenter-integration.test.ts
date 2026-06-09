import { describe, it, expect, vi } from 'vitest'
import { createEngine, FakeEmbedding } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { buildApiHandler, makeCapabilityAugmenter } from './index.js'
import type { ProviderDeps } from './types.js'

// Integration: the REAL augmenter (makeCapabilityAugmenter over a real ApiHandler built by the
// factory, driven by a mock fetch) flows through createEngine.registerCapability all the way into
// the stored descriptionEmbedding. Earlier tests cover the engine side with FakeAugmenter and the
// llm side in isolation; this stitches the two halves together (FEAT-01-07).

function mockChatFetch(content: string): ProviderDeps['fetch'] & { mock: { calls: unknown[][] } } {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as ProviderDeps['fetch'] & {
    mock: { calls: unknown[][] }
  }
}

describe('augmenter through the engine (FEAT-01-07 integration)', () => {
  it('stores the provider-augmented description and embeds it, not the raw name', async () => {
    const enriched = 'A precise file reader for code-analysis workflows.'
    const fetch = mockChatFetch(enriched)
    const handler = buildApiHandler({ type: 'ollama', model: 'llama3.1' }, { fetch })
    const augmenter = makeCapabilityAugmenter(handler, { model: 'llama3.1' })

    const storage = await createSqlJsStorage()
    const engine = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter })
    try {
      // registerCapability returns the raw row immediately; augmentation + embedding run in the
      // background (ADR-25, IMP-04-09-04), so we drain, then read the persisted row back.
      await engine.registerCapability({ id: 'tool:read', type: 'tool', description: 'file_read' })
      await engine.whenEmbeddingsIdle?.()
      const cap = (await engine.listCapabilities()).find((c) => c.id === 'tool:read')!
      expect(cap.descriptionAugmented).toBe(enriched)
      expect(cap.augmentedBy).toBe('llama3.1')
      // The mock provider was actually reached through classifyText (once, in the background).
      expect(fetch.mock.calls.length).toBe(1)
      // The stored embedding reflects the enriched text, not the raw "file_read".
      const augEmb = await new FakeEmbedding().embed(enriched)
      const rawEmb = await new FakeEmbedding().embed('file_read')
      expect(Array.from(cap.descriptionEmbedding ?? [])).toEqual(Array.from(augEmb))
      expect(Array.from(cap.descriptionEmbedding ?? [])).not.toEqual(Array.from(rawEmb))
    } finally {
      await engine.close()
    }
  })

  it('makes zero provider calls when no augmenter is configured (default off, SC-02)', async () => {
    const fetch = mockChatFetch('should-never-be-called')
    void buildApiHandler({ type: 'ollama', model: 'llama3.1' }, { fetch }) // a handler exists but is NOT injected
    const storage = await createSqlJsStorage()
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    try {
      const cap = await engine.registerCapability({ id: 'tool:x', type: 'tool', description: 'raw' })
      expect(cap.descriptionAugmented).toBeUndefined()
      expect(fetch.mock.calls.length).toBe(0) // the provider is only reached through an injected augmenter
    } finally {
      await engine.close()
    }
  })
})
