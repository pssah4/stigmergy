import { describe, it, expect } from 'vitest'
import {
  defaultSettings,
  validateSettings,
  mergeSettings,
  resolveActiveProvider,
  resolveActiveEmbeddingModel,
  hasAnyCredentials,
  encryptProviderConfigsInPlace,
  decryptProviderConfigsInPlace,
  cloneSettingsForPersist,
  type StudioSettings,
} from './settings.js'

// A prefix-based test crypter standing in for the Electron safeStorage crypter.
const testCrypter = {
  isEncrypted: (v: string) => v.startsWith('ENC:'),
  encrypt: (v: string) => `ENC:${v}`,
  decrypt: (v: string) => (v.startsWith('ENC:') ? v.slice('ENC:'.length) : v),
}

describe('settings defaults and merge', () => {
  it('has sane defaults that validate', () => {
    expect(validateSettings(defaultSettings)).toEqual([])
  })

  it('merge fills missing fields from the defaults (SC-01 load tolerance)', () => {
    const merged = mergeSettings({ substratePath: '/x/y.db' })
    expect(merged.substratePath).toBe('/x/y.db')
    expect(merged.tauMin).toBe(defaultSettings.tauMin)
    expect(merged.explorationPolicy).toBe(defaultSettings.explorationPolicy)
  })
})

describe('validateSettings (SC-05)', () => {
  it('rejects unknown model providers and requires a model when a naming provider is set (EPIC-04 FEAT-04-07)', () => {
    expect(validateSettings({ ...defaultSettings, embeddingProvider: 'bogus' as never })).toContainEqual(
      expect.stringMatching(/embedding provider/),
    )
    expect(validateSettings({ ...defaultSettings, namingProvider: 'bogus' as never })).toContainEqual(
      expect.stringMatching(/naming provider/),
    )
    expect(validateSettings({ ...defaultSettings, namingProvider: 'anthropic', namingModel: '' })).toContainEqual(
      expect.stringMatching(/naming model is required/),
    )
    // a fully-specified naming provider validates
    expect(validateSettings({ ...defaultSettings, namingProvider: 'anthropic', namingModel: 'claude-x' })).toEqual([])
  })

  it('rejects a non-array mcpServers and a non-string skillRoot (EPIC-04 FEAT-04-02)', () => {
    expect(validateSettings({ ...defaultSettings, mcpServers: 'nope' as unknown as [] })).toContainEqual(
      expect.stringMatching(/MCP servers/),
    )
    expect(validateSettings({ ...defaultSettings, skillRoot: 5 as unknown as string })).toContainEqual(
      expect.stringMatching(/Skill folder/),
    )
    expect(validateSettings(defaultSettings)).toEqual([]) // defaults (empty array, empty string) are valid
  })

  it('validates each mcpServers entry shape (AUDIT EPIC-04 L-3)', () => {
    // a well-formed stdio and a well-formed http entry validate
    expect(
      validateSettings({
        ...defaultSettings,
        mcpServers: [
          { name: 'fs', command: 'mcp-fs', args: ['--root', '/x'] },
          { name: 'web', url: 'https://mcp.example/v1' },
        ],
      }),
    ).toEqual([])
    // missing name
    expect(validateSettings({ ...defaultSettings, mcpServers: [{ command: 'x' } as never] })).toContainEqual(
      expect.stringMatching(/needs a name/),
    )
    // neither command nor url
    expect(validateSettings({ ...defaultSettings, mcpServers: [{ name: 'x' } as never] })).toContainEqual(
      expect.stringMatching(/exactly one of command or url/),
    )
    // both command and url
    expect(
      validateSettings({ ...defaultSettings, mcpServers: [{ name: 'x', command: 'c', url: 'https://u' } as never] }),
    ).toContainEqual(expect.stringMatching(/exactly one of command or url/))
    // a non-object entry
    expect(validateSettings({ ...defaultSettings, mcpServers: [null as never] })).toContainEqual(
      expect.stringMatching(/must be an object/),
    )
  })

  it('rejects a non-positive decay half-life', () => {
    expect(validateSettings({ ...defaultSettings, decayHalfLifeHours: 0 })).toContainEqual(expect.stringMatching(/Fade time/))
    expect(validateSettings({ ...defaultSettings, decayHalfLifeHours: -5 })).toContainEqual(expect.stringMatching(/Fade time/))
  })

  it('rejects a negative tauMin and a tauMax not above tauMin', () => {
    expect(validateSettings({ ...defaultSettings, tauMin: -0.1 })).toContainEqual(expect.stringMatching(/tauMin/))
    expect(validateSettings({ ...defaultSettings, tauMin: 0.5, tauMax: 0.5 })).toContainEqual(expect.stringMatching(/tauMax/))
    expect(validateSettings({ ...defaultSettings, tauMin: 0.5, tauMax: 0.3 })).toContainEqual(expect.stringMatching(/tauMax/))
  })

  it('rejects a tauMax above 1', () => {
    expect(validateSettings({ ...defaultSettings, tauMax: 1.5 })).toContainEqual(expect.stringMatching(/tauMax/))
  })

  it('rejects an unknown exploration policy', () => {
    expect(validateSettings({ ...defaultSettings, explorationPolicy: 'magic' as never })).toContainEqual(
      expect.stringMatching(/selection strategy/),
    )
  })

  it('returns no errors for a valid settings object', () => {
    expect(validateSettings({ ...defaultSettings, decayHalfLifeHours: 72, tauMin: 0.1, tauMax: 0.9 })).toEqual([])
  })

  it('rejects NaN and non-numeric values (empty input field or hand-edited file)', () => {
    expect(validateSettings({ ...defaultSettings, tauMin: NaN })).toContainEqual(expect.stringMatching(/tauMin/))
    expect(validateSettings({ ...defaultSettings, decayHalfLifeHours: NaN })).toContainEqual(expect.stringMatching(/Fade time/))
    // a string slipping in from a hand-edited JSON must not pass a comparison silently
    expect(validateSettings({ ...defaultSettings, tauMin: '0.5' as never })).toContainEqual(expect.stringMatching(/tauMin/))
  })

  it('rejects a non-boolean heterogeneousEvaluator', () => {
    expect(validateSettings({ ...defaultSettings, heterogeneousEvaluator: 'false' as never })).toContainEqual(
      expect.stringMatching(/scoring/),
    )
  })
})

describe('provider/embedding config model (FEAT-05-02, ADR-22)', () => {
  it('migrates flat naming fields into a provider entry, idempotently (SC-04)', () => {
    const flat: Partial<StudioSettings> = {
      namingProvider: 'anthropic',
      namingModel: 'claude-x',
      namingApiKey: 'sk-test',
      namingBaseUrl: 'https://api.example',
    }
    const once = mergeSettings(flat)
    expect(once.providerConfigs).toHaveLength(1)
    const p = once.providerConfigs[0]
    expect(p.type).toBe('anthropic')
    expect(p.model).toBe('claude-x')
    expect(p.apiKey).toBe('sk-test')
    expect(p.baseUrl).toBe('https://api.example')
    expect(p.enabled).toBe(true)
    expect(once.activeProviderId).toBe(p.id)
    // no tier mapping leaked into the provider entry (SC-07)
    expect(p).not.toHaveProperty('tier')
    expect(p).not.toHaveProperty('tierMapping')
    // idempotent: a second merge of the already-migrated object is identical
    const twice = mergeSettings(once)
    expect(twice).toEqual(once)
  })

  it('migrates the flat embedding fields into an embedding-model entry (SC-02)', () => {
    const merged = mergeSettings({ embeddingProvider: 'transformers', embeddingModelId: 'my/model' })
    expect(merged.embeddingModels.length).toBeGreaterThanOrEqual(1)
    const active = resolveActiveEmbeddingModel(merged)
    expect(active.provider).toBe('transformers')
    expect(active.modelId).toBe('my/model')
    expect(merged.activeEmbeddingModelKey).toBe(active.key)
  })

  it('leaves no provider entry when the flat naming provider is none (SC-01)', () => {
    const merged = mergeSettings({ namingProvider: 'none' })
    expect(merged.providerConfigs).toEqual([])
    expect(merged.activeProviderId).toBeNull()
    expect(resolveActiveProvider(merged)).toBeNull()
  })

  it('resolveActiveProvider returns the active enabled provider and ignores disabled ones (SC-03)', () => {
    const s: StudioSettings = {
      ...defaultSettings,
      providerConfigs: [
        { id: 'a', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'k', model: 'm-a' },
        { id: 'b', type: 'openai', displayName: 'B', enabled: true, apiKey: 'k2', model: 'm-b' },
      ],
      activeProviderId: 'b',
    }
    expect(resolveActiveProvider(s)?.id).toBe('b')
    // a disabled active provider resolves to null (never used)
    const disabled: StudioSettings = {
      ...s,
      providerConfigs: [{ ...s.providerConfigs[0], id: 'b', enabled: false }],
      activeProviderId: 'b',
    }
    expect(resolveActiveProvider(disabled)).toBeNull()
  })

  it('resolveActiveEmbeddingModel falls back to the disabled default when none is active (SC-02)', () => {
    const active = resolveActiveEmbeddingModel(defaultSettings)
    expect(active.provider).toBe('disabled')
  })

  it('migrates the legacy "fake" embedding backend to "disabled", verlustfrei (FEAT-05-06 SC-05)', () => {
    // a settings file written before FEAT-05-06 (flat fake + a persisted fake embedding entry)
    const merged = mergeSettings({
      embeddingProvider: 'fake' as never,
      embeddingModels: [{ key: 'fake:default', provider: 'fake' as never, modelId: '', displayName: 'No semantics (offline)' }],
      activeEmbeddingModelKey: 'fake:default',
    })
    expect(merged.embeddingProvider).toBe('disabled')
    expect(merged.embeddingModels[0].provider).toBe('disabled')
    expect(validateSettings(merged)).toEqual([])
  })

  it('validates an API embedding model entry (FEAT-05-06)', () => {
    const s: StudioSettings = {
      ...defaultSettings,
      embeddingModels: [{ key: 'openai:text-embedding-3-small', provider: 'openai', modelId: 'text-embedding-3-small', displayName: 'OpenAI', apiKey: 'sk-x' }],
      activeEmbeddingModelKey: 'openai:text-embedding-3-small',
    }
    expect(validateSettings(s)).toEqual([])
  })

  it('encrypts and decrypts provider apiKeys in place, idempotently (SC-05)', () => {
    const s: StudioSettings = {
      ...defaultSettings,
      providerConfigs: [
        { id: 'a', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'sk-1', model: 'm' },
        { id: 'b', type: 'ollama', displayName: 'B', enabled: true, apiKey: '', model: 'm2' }, // empty key untouched
      ],
      activeProviderId: 'a',
    }
    encryptProviderConfigsInPlace(s, testCrypter)
    expect(s.providerConfigs[0].apiKey).toBe('ENC:sk-1') // not plaintext at rest
    expect(s.providerConfigs[1].apiKey).toBe('') // empty stays empty
    // idempotent: a second encrypt does not double-wrap
    encryptProviderConfigsInPlace(s, testCrypter)
    expect(s.providerConfigs[0].apiKey).toBe('ENC:sk-1')
    // round-trip back to plaintext
    decryptProviderConfigsInPlace(s, testCrypter)
    expect(s.providerConfigs[0].apiKey).toBe('sk-1')
    expect(s.providerConfigs[1].apiKey).toBe('')
  })

  it('cloneSettingsForPersist isolates providerConfigs AND embeddingModels so encrypting the snapshot never mutates the live settings (FIX-05-02-01)', () => {
    const s: StudioSettings = {
      ...defaultSettings,
      providerConfigs: [{ id: 'a', type: 'openai', displayName: 'A', enabled: true, apiKey: 'sk-prov', model: 'm' }],
      activeProviderId: 'a',
      embeddingModels: [{ key: 'openai:e', provider: 'openai', modelId: 'text-embedding-3-small', displayName: 'E', apiKey: 'sk-embed' }],
      activeEmbeddingModelKey: 'openai:e',
    }
    const snap = cloneSettingsForPersist(s)
    // encrypt the on-disk snapshot in place (what persistSettings does)
    encryptProviderConfigsInPlace(snap, testCrypter)
    expect(snap.providerConfigs[0].apiKey).toBe('ENC:sk-prov') // snapshot encrypted (goes to disk)
    expect(snap.embeddingModels[0].apiKey).toBe('ENC:sk-embed')
    // the LIVE settings must stay plaintext; otherwise the next embedding/provider call sends the
    // ciphertext as the bearer token (the HTTP 401 bug).
    expect(s.providerConfigs[0].apiKey).toBe('sk-prov')
    expect(s.embeddingModels[0].apiKey).toBe('sk-embed')
  })

  it('hasAnyCredentials reflects whether an enabled provider carries a key (SC-05)', () => {
    expect(hasAnyCredentials(defaultSettings)).toBe(false)
    const s: StudioSettings = {
      ...defaultSettings,
      providerConfigs: [{ id: 'a', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'k', model: 'm' }],
      activeProviderId: 'a',
    }
    expect(hasAnyCredentials(s)).toBe(true)
  })

  it('validateSettings checks the provider array, models, and the active pointer (SC-01/SC-03/SC-07)', () => {
    // unknown provider type
    expect(
      validateSettings({
        ...defaultSettings,
        providerConfigs: [{ id: 'a', type: 'bogus' as never, displayName: 'A', enabled: true, apiKey: '', model: 'm' }],
        activeProviderId: 'a',
      }),
    ).toContainEqual(expect.stringMatching(/provider/i))
    // enabled provider without a model
    expect(
      validateSettings({
        ...defaultSettings,
        providerConfigs: [{ id: 'a', type: 'anthropic', displayName: 'A', enabled: true, apiKey: '', model: '' }],
        activeProviderId: 'a',
      }),
    ).toContainEqual(expect.stringMatching(/model/i))
    // dangling active pointer
    expect(
      validateSettings({ ...defaultSettings, providerConfigs: [], activeProviderId: 'ghost' }),
    ).toContainEqual(expect.stringMatching(/active provider/i))
    // a well-formed provider array validates
    expect(
      validateSettings({
        ...defaultSettings,
        providerConfigs: [{ id: 'a', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'k', model: 'm' }],
        activeProviderId: 'a',
      }),
    ).toEqual([])
  })
})
