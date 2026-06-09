import { describe, it, expect } from 'vitest'
import type { EmbeddingPort } from '@agentic-stigmergy/core'
import type { ApiHandler, LLMProviderConfig } from '@stigmergy/llm'
import { studioEngineModels, type StudioModelDeps } from './studio-models.js'
import { defaultSettings, type StudioSettings } from './settings.js'

function fakeDeps(): { deps: StudioModelDeps; calls: { embed: number }; handlerConfigs: LLMProviderConfig[] } {
  const calls = { embed: 0 }
  const handlerConfigs: LLMProviderConfig[] = []
  const port = { embed: async () => new Float32Array(), dimension: () => 1, modelHash: () => 'm' } as EmbeddingPort
  const handler: ApiHandler = { classifyText: async () => 'x' }
  const deps: StudioModelDeps = {
    makeEmbedding: () => {
      calls.embed++
      return port
    },
    makeHandler: (config) => {
      handlerConfigs.push(config)
      return handler
    },
  }
  return { deps, calls, handlerConfigs }
}

describe('studioEngineModels (EPIC-04 FEAT-04-07, ADR-25)', () => {
  it('always builds the local embedding (hard-wired) and no augmenter by default (IMP-05-06-02)', () => {
    const { deps, calls } = fakeDeps()
    const models = studioEngineModels(defaultSettings, deps)
    expect(calls.embed).toBe(1) // the embedding is always built, regardless of settings
    expect(models.augmenter).toBeUndefined()
  })

  it('ignores any embedding config: the embedding is hard-wired local, not selectable (IMP-05-06-02)', () => {
    const { deps, calls } = fakeDeps()
    const s: StudioSettings = {
      ...defaultSettings,
      embeddingModels: [{ key: 'openrouter:x', provider: 'openrouter', modelId: 'm', displayName: 'X', apiKey: 'k' }],
      activeEmbeddingModelKey: 'openrouter:x',
    }
    studioEngineModels(s, deps)
    expect(calls.embed).toBe(1) // makeEmbedding takes no provider: the configured API embedding is ignored
  })

  it('builds an augmenter from the naming provider config when set', () => {
    const { deps, handlerConfigs } = fakeDeps()
    const s: StudioSettings = { ...defaultSettings, namingProvider: 'anthropic', namingModel: 'claude-x', namingApiKey: 'k', namingBaseUrl: '' }
    const models = studioEngineModels(s, deps)
    expect(handlerConfigs).toEqual([{ type: 'anthropic', model: 'claude-x', apiKey: 'k', baseUrl: undefined }])
    expect(models.augmenter).toBeDefined()
  })

  it('builds no augmenter when the provider is set but the model is empty', () => {
    const { deps, handlerConfigs } = fakeDeps()
    const s: StudioSettings = { ...defaultSettings, namingProvider: 'anthropic', namingModel: '' }
    expect(studioEngineModels(s, deps).augmenter).toBeUndefined()
    expect(handlerConfigs).toEqual([])
  })

  it('resolves the active LLM provider for the augmenter from the new config model (FEAT-05-02 SC-06)', () => {
    const { deps, handlerConfigs } = fakeDeps()
    const s: StudioSettings = {
      ...defaultSettings,
      providerConfigs: [
        { id: 'off', type: 'openai', displayName: 'Off', enabled: false, apiKey: 'k0', model: 'm0' },
        { id: 'on', type: 'anthropic', displayName: 'On', enabled: true, apiKey: 'k1', model: 'claude-y', baseUrl: 'https://x' },
      ],
      activeProviderId: 'on',
    }
    const models = studioEngineModels(s, deps)
    expect(handlerConfigs).toEqual([{ type: 'anthropic', model: 'claude-y', apiKey: 'k1', baseUrl: 'https://x' }])
    expect(models.augmenter).toBeDefined()
  })
})
