// EPIC-05 integration seams (FEAT-05-01..05). The unit tests cover each module in isolation; these
// exercise the cross-module flows that the unit tests stub: the credential round-trip through a
// serialize boundary, the migration-to-consumer chain (flat settings -> resolvers -> engine models),
// the onboarding walk with a ctx derived from the migrated settings, and the provider reducer feeding
// the active-provider resolver. Pure layer only (no Electron, no React). NO model tiers anywhere.
import { describe, it, expect } from 'vitest'
import type { EmbeddingPort } from '@agentic-stigmergy/core'
import { encryptCredentialsInPlace, decryptCredentialsInPlace, type ApiHandler, type LLMProviderConfig, type SettingsCrypter } from '@stigmergy/llm'
import {
  mergeSettings,
  resolveActiveProvider,
  resolveActiveEmbeddingModel,
  encryptProviderConfigsInPlace,
  decryptProviderConfigsInPlace,
  type StudioSettings,
} from './settings.js'
import { studioEngineModels, type StudioModelDeps } from './studio-models.js'
import { addProvider, updateProvider, setActiveProvider, canProbe } from './provider-settings.js'
import { initialOnboardingState, next, skip, isComplete, currentStep, type OnboardingCtx } from './onboarding-wizard.js'
import { isNativeRebuildError } from './friendly-error.js'

// A base64 crypter standing in for the Electron safeStorage crypter (idempotent, reversible). Base64
// (like safeStorage's real output) actually obscures the value, so a plaintext-at-rest assertion is
// meaningful (a naive prefix crypter would leave the plaintext readable as a substring).
const ENC = 'enc:'
const crypter: SettingsCrypter = {
  isEncrypted: (v) => v.startsWith(ENC),
  encrypt: (v) => (v.startsWith(ENC) ? v : ENC + Buffer.from(v, 'utf8').toString('base64')),
  decrypt: (v) => (v.startsWith(ENC) ? Buffer.from(v.slice(ENC.length), 'base64').toString('utf8') : v),
}

function fakeModelDeps(): { deps: StudioModelDeps; embedCalls: Array<[string, string | undefined]>; handlerConfigs: LLMProviderConfig[] } {
  const embedCalls: Array<[string, string | undefined]> = []
  const handlerConfigs: LLMProviderConfig[] = []
  const port = { embed: async () => new Float32Array(), dimension: () => 1, modelHash: () => 'm' } as EmbeddingPort
  const handler: ApiHandler = { classifyText: async () => 'ok' }
  return {
    deps: {
      makeEmbedding: () => {
        embedCalls.push(['local', undefined]) // hard-wired local embedding (IMP-05-06-02): no provider arg
        return port
      },
      makeHandler: (config) => {
        handlerConfigs.push(config)
        return handler
      },
    },
    embedCalls,
    handlerConfigs,
  }
}

describe('EPIC-05 integration: credential round-trip through a serialize boundary (FEAT-05-02 SC-05)', () => {
  it('keeps provider keys encrypted at rest and recovers them on load', () => {
    const loaded = mergeSettings({
      namingProvider: 'anthropic',
      namingModel: 'claude-haiku-4-5',
      namingApiKey: 'sk-secret-value-123',
      namingBaseUrl: '',
    })
    expect(loaded.providerConfigs[0].apiKey).toBe('sk-secret-value-123') // plaintext in memory

    // Simulate persistSettings: deep-copy, encrypt the flat cred fields AND the provider array, serialize.
    const onDisk: StudioSettings = { ...loaded, providerConfigs: loaded.providerConfigs.map((p) => ({ ...p })) }
    encryptCredentialsInPlace(onDisk as unknown as Record<string, unknown>, ['namingApiKey'], crypter)
    encryptProviderConfigsInPlace(onDisk, crypter)
    const serialized = JSON.stringify(onDisk)
    expect(serialized).not.toContain('sk-secret-value-123') // never plaintext at rest (flat or array)
    expect(serialized).toContain(ENC + Buffer.from('sk-secret-value-123', 'utf8').toString('base64'))
    // The in-memory copy stayed plaintext (deep-copy isolation).
    expect(loaded.providerConfigs[0].apiKey).toBe('sk-secret-value-123')

    // Simulate loadSettings: parse, merge, decrypt both seams.
    const reloaded = mergeSettings(JSON.parse(serialized) as Partial<StudioSettings>)
    decryptCredentialsInPlace(reloaded as unknown as Record<string, unknown>, ['namingApiKey'], crypter)
    decryptProviderConfigsInPlace(reloaded, crypter)
    expect(reloaded.providerConfigs[0].apiKey).toBe('sk-secret-value-123')
  })
})

describe('EPIC-05 integration: migration to engine models (FEAT-05-02 SC-04/SC-06)', () => {
  it('lifts flat settings into the provider model and drives studioEngineModels from the resolved active config', () => {
    const flat: Partial<StudioSettings> = {
      namingProvider: 'anthropic',
      namingModel: 'claude-haiku-4-5',
      namingApiKey: 'sk-key',
      namingBaseUrl: 'https://api.anthropic.test',
      embeddingProvider: 'transformers',
      embeddingModelId: 'Xenova/all-MiniLM-L6-v2',
    }
    const merged = mergeSettings(flat)

    const provider = resolveActiveProvider(merged)
    expect(provider?.type).toBe('anthropic')
    expect(provider?.model).toBe('claude-haiku-4-5')
    const emb = resolveActiveEmbeddingModel(merged)
    expect(emb.provider).toBe('transformers')
    expect(emb.modelId).toBe('Xenova/all-MiniLM-L6-v2')
    expect(JSON.stringify(merged).toLowerCase()).not.toContain('tier')

    const { deps, embedCalls, handlerConfigs } = fakeModelDeps()
    const models = studioEngineModels(merged, deps)
    expect(embedCalls).toHaveLength(1) // embedding is hard-wired local, not driven by settings (IMP-05-06-02)
    expect(handlerConfigs).toEqual([{ type: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-key', baseUrl: 'https://api.anthropic.test' }])
    expect(models.augmenter).toBeDefined()

    // Idempotent: re-merging the already-migrated settings changes nothing.
    expect(mergeSettings(merged)).toEqual(merged)
  })
})

describe('EPIC-05 integration: onboarding walk with derived ctx (FEAT-05-05 SC-01/SC-02)', () => {
  it('runs from welcome to done, gated by the same conditions the components derive', () => {
    const settings = mergeSettings({
      namingProvider: 'anthropic',
      namingModel: 'claude-haiku-4-5',
      namingApiKey: 'sk-key',
      embeddingProvider: 'transformers',
      embeddingModelId: 'Xenova/all-MiniLM-L6-v2',
    })
    const baseCtx = (over: Partial<OnboardingCtx>): OnboardingCtx => ({
      nativeOk: !isNativeRebuildError(''), // no error -> native ok
      hasActiveProvider: resolveActiveProvider(settings) !== null,
      daemonRunning: false,
      loopConnected: false,
      enabled: false,
      ...over,
    })

    let s = initialOnboardingState
    s = next(s, baseCtx({})) // welcome -> native
    expect(currentStep(s)).toBe('native')

    // A native rebuild error blocks the gate.
    const blocked = next(s, baseCtx({ nativeOk: !isNativeRebuildError('NODE_MODULE_VERSION 141 requires 125') }))
    expect(currentStep(blocked)).toBe('native')

    s = next(s, baseCtx({})) // native ok -> substrate
    s = next(s, baseCtx({})) // substrate -> provider
    s = next(s, baseCtx({})) // provider (hasActiveProvider true) -> daemon (no embedding step, IMP-05-06-02)
    expect(currentStep(s)).toBe('daemon')
    s = skip(s) // daemon not running -> skip to connect
    expect(currentStep(s)).toBe('connect')
    s = skip(s) // loop not connected yet -> skip to activate
    expect(currentStep(s)).toBe('activate')
    expect(next(s, baseCtx({ enabled: false })).step).toBe('activate') // gated until enabled
    s = next(s, baseCtx({ enabled: true })) // activate -> done
    expect(isComplete(s)).toBe(true)
  })
})

describe('EPIC-05 integration: provider reducer feeds the active-provider resolver (FEAT-05-03)', () => {
  it('builds a usable local provider and gates the probe by provider kind', () => {
    let s = mergeSettings({ namingProvider: 'none' }) // start with no provider
    expect(resolveActiveProvider(s)).toBeNull()

    s = addProvider(s, 'ollama')
    expect(resolveActiveProvider(s)).toBeNull() // no model yet
    s = updateProvider(s, 'p1', { model: 'llama3' })
    const local = resolveActiveProvider(s)
    expect(local?.type).toBe('ollama')
    expect(canProbe(local!).ok).toBe(true) // local provider needs no key

    s = addProvider(s, 'anthropic')
    s = updateProvider(s, 'p2', { model: 'claude-haiku-4-5' })
    s = setActiveProvider(s, 'p2')
    const remote = resolveActiveProvider(s)
    expect(remote?.type).toBe('anthropic')
    expect(canProbe(remote!).ok).toBe(false) // remote provider needs a key
    s = updateProvider(s, 'p2', { apiKey: 'sk-key' })
    expect(canProbe(resolveActiveProvider(s)!).ok).toBe(true)
  })
})
