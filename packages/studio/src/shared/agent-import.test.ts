import { describe, it, expect } from 'vitest'
import { parseAgentModels } from './agent-import.js'

describe('parseAgentModels (EPIC-04 FEAT-04-07c)', () => {
  it('lifts valid model fields and never imports a secret', () => {
    const out = parseAgentModels({
      embeddingProvider: 'transformers',
      embeddingModelId: 'Xenova/bge-small',
      namingProvider: 'anthropic',
      namingModel: 'claude-x',
      namingBaseUrl: 'http://localhost:11434',
      namingApiKey: 'sk-secret', // must be ignored
    })
    expect(out).toEqual({
      embeddingProvider: 'transformers',
      embeddingModelId: 'Xenova/bge-small',
      namingProvider: 'anthropic',
      namingModel: 'claude-x',
      namingBaseUrl: 'http://localhost:11434',
    })
    expect('namingApiKey' in out).toBe(false) // no secret imported
  })

  it('drops unknown providers and non-objects (best-effort)', () => {
    expect(parseAgentModels({ embeddingProvider: 'bogus', namingProvider: 'nonsense' })).toEqual({})
    expect(parseAgentModels(null)).toEqual({})
    expect(parseAgentModels('nope')).toEqual({})
  })
})
