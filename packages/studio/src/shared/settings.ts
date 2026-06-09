// Studio settings (FEAT-03-05, FEAT-04-07, FEAT-05-02). Persisted as JSON in the Electron userData dir
// (SC-01); the substrate path drives a UI re-connect when it changes (SC-02); every value is validated
// against its range (SC-05). No React/Electron import, so the monorepo vitest covers the defaults, the
// validator, the migration, and the resolvers.
//
// FEAT-05-02 (ADR-22): the provider config is a list plus an active pointer (providerConfigs +
// activeProviderId), and embedding is a model list (embeddingModels + activeEmbeddingModelKey). This
// replaces the flat naming fields and the fake/transformers toggle. The flat fields stay readable as a
// migration source and interim fallback (the provider UI lands with FEAT-05-03). NO model tiers: each
// provider carries exactly one `model`, no tier mapping (owner correction, was VO-chat-specific).

import type { McpServerConfig } from '@stigmergy/discovery'
import type { ProviderType, SettingsCrypter } from '@stigmergy/llm'

export type ExplorationPolicy = 'thompson' | 'epsilon-greedy' | 'ucb'

export const EXPLORATION_POLICIES: readonly ExplorationPolicy[] = ['thompson', 'epsilon-greedy', 'ucb']

/** Embedding backend for semantic indexing (FEAT-04-07, ADR-18, FEAT-05-06). 'disabled' = no real
 * semantics (an offline stand-in, the default); 'transformers' = a local ONNX model the Studio owns,
 * downloaded on first use; the rest are API embedding providers (OpenAI-compatible /v1/embeddings). */
export type EmbeddingProvider = 'disabled' | 'transformers' | 'openai' | 'ollama' | 'lmstudio' | 'openrouter' | 'custom'
export const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ['disabled', 'transformers', 'openai', 'ollama', 'lmstudio', 'openrouter', 'custom']
/** The API embedding providers (need a model, optional key/baseUrl); 'disabled' and 'transformers' are local. */
export const API_EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ['openai', 'ollama', 'lmstudio', 'openrouter', 'custom']

/** LLM provider for path naming and capability augmentation (FEAT-04-07). 'none' = no LLM (fallback
 * id-names). The Studio owns this config independently of the host loop's models. */
export type NamingProvider = ProviderType | 'none'
export const NAMING_PROVIDERS: readonly NamingProvider[] = ['none', 'anthropic', 'openai', 'ollama', 'lmstudio', 'openrouter', 'custom']

/** The provider types the Studio can configure (the @stigmergy/llm set, without the 'none' sentinel). */
export const PROVIDER_TYPES: readonly ProviderType[] = NAMING_PROVIDERS.filter((p): p is ProviderType => p !== 'none')

/** A single configured LLM provider (FEAT-05-02, ADR-22). Carries exactly one model; NO tier mapping. */
export interface ProviderConfig {
  /** Stable unique id within the list (the active pointer references it). */
  id: string
  type: ProviderType
  displayName: string
  enabled: boolean
  /** API key, encrypted at rest via the credential walker (FEAT-05-02). Empty for keyless local providers. */
  apiKey: string
  /** Optional base URL override (e.g. a local Ollama endpoint). */
  baseUrl?: string
  /** The single chosen model. There is no tier mapping. */
  model: string
  /** Models discovered from the provider (prefill for the picker, FEAT-05-03). */
  discoveredModels?: string[]
}

/** A selectable embedding model (FEAT-05-02, FEAT-05-06). A backend ('disabled'/'transformers') or an
 * API provider plus a model; API entries carry their own key/baseUrl, like a ProviderConfig. */
export interface EmbeddingModelConfig {
  /** Stable unique key within the list (the active pointer references it). */
  key: string
  provider: EmbeddingProvider
  /** Hugging Face model id for 'transformers', the embedding model name for an API provider; empty for 'disabled'. */
  modelId: string
  displayName: string
  /** API key for an API embedding provider, encrypted at rest (FEAT-05-06). Empty for local/keyless. */
  apiKey?: string
  /** Optional base URL override for an API embedding provider. */
  baseUrl?: string
}

export interface StudioSettings {
  /** Substrate file path; empty string means the default (~/.stigmergy/pheromone.db). */
  substratePath: string
  /** Root folder for exported workflows; an optional named integration adds its own subdirectory. */
  workflowRoot: string
  /** The loop project directory the user connected (persisted, so the connection survives a restart). */
  connectedProject: string
  /** Configured MCP servers to enumerate on Discover (FEAT-04-02). */
  mcpServers: McpServerConfig[]
  /** Root folder scanned for SKILL.md files on Discover (FEAT-04-02); empty disables the scan. */
  skillRoot: string

  // FEAT-05-02 provider/embedding config model (ADR-22).
  /** Configured LLM providers (FEAT-05-02). The active one drives naming, augmentation, and the daemon. */
  providerConfigs: ProviderConfig[]
  /** Id of the active provider, or null when none is active. */
  activeProviderId: string | null
  /** Configured embedding models (FEAT-05-02). The active one drives the embedding port. */
  embeddingModels: EmbeddingModelConfig[]
  /** Key of the active embedding model, or null to fall back to the offline default. */
  activeEmbeddingModelKey: string | null
  /** First-run onboarding state (FEAT-05-05). */
  onboarding: { completed: boolean }

  // Deprecated flat fields (FEAT-04-07). Kept as the migration source and interim fallback; the
  // provider UI (FEAT-05-03) replaces them. New code reads the resolvers, not these.
  /** @deprecated use embeddingModels + activeEmbeddingModelKey. */
  embeddingProvider: EmbeddingProvider
  /** @deprecated use embeddingModels + activeEmbeddingModelKey. */
  embeddingModelId: string
  /** @deprecated use providerConfigs + activeProviderId. */
  namingProvider: NamingProvider
  /** @deprecated */
  namingModel: string
  /** @deprecated */
  namingApiKey: string
  /** @deprecated */
  namingBaseUrl: string

  decayHalfLifeHours: number
  tauMin: number
  tauMax: number
  explorationPolicy: ExplorationPolicy
  heterogeneousEvaluator: boolean
}

export const defaultSettings: StudioSettings = {
  substratePath: '',
  workflowRoot: '',
  connectedProject: '',
  mcpServers: [],
  skillRoot: '',
  providerConfigs: [],
  activeProviderId: null,
  embeddingModels: [],
  activeEmbeddingModelKey: null,
  onboarding: { completed: false },
  embeddingProvider: 'disabled',
  embeddingModelId: '',
  namingProvider: 'none',
  namingModel: '',
  namingApiKey: '',
  namingBaseUrl: '',
  decayHalfLifeHours: 168,
  tauMin: 0.05,
  tauMax: 1.0,
  explorationPolicy: 'thompson',
  heterogeneousEvaluator: false,
}

/** The offline embedding default returned when no model is active (FEAT-05-02, FEAT-05-06). */
const DISABLED_EMBEDDING_DEFAULT: EmbeddingModelConfig = {
  key: 'disabled:default',
  provider: 'disabled',
  modelId: '',
  displayName: 'Disabled (no semantics)',
}

/** A human label for an embedding entry derived from its backend (FEAT-05-06). */
export function embeddingDisplayName(provider: EmbeddingProvider, modelId: string): string {
  if (provider === 'disabled') return DISABLED_EMBEDDING_DEFAULT.displayName
  if (provider === 'transformers') return modelId ? `Local model (${modelId})` : 'Local model (downloaded)'
  return modelId || provider
}

/** Normalize a legacy embedding backend value: the old 'fake' is now 'disabled' (FEAT-05-06). */
function normalizeEmbeddingProvider(p: string): EmbeddingProvider {
  return (p === 'fake' ? 'disabled' : (p as EmbeddingProvider))
}

/** A stable key for an embedding model derived from a backend plus model id. */
export function embeddingKey(provider: EmbeddingProvider, modelId: string): string {
  return modelId ? `${provider}:${modelId}` : `${provider}:default`
}

/** Derive the new provider/embedding model from the flat fields when the lists are still empty.
 * Idempotent: once a list has entries, the derivation is skipped (FEAT-05-02 SC-04). */
function migrateFlatToProviderModel(s: StudioSettings): StudioSettings {
  let providerConfigs = s.providerConfigs
  let activeProviderId = s.activeProviderId
  if (providerConfigs.length === 0 && s.namingProvider !== 'none' && s.namingModel.trim() !== '') {
    const id = `migrated-${s.namingProvider}`
    const entry: ProviderConfig = {
      id,
      type: s.namingProvider,
      displayName: s.namingProvider,
      enabled: true,
      apiKey: s.namingApiKey,
      model: s.namingModel,
    }
    if (s.namingBaseUrl.trim() !== '') entry.baseUrl = s.namingBaseUrl
    providerConfigs = [entry]
    activeProviderId = id
  }

  let embeddingModels = s.embeddingModels
  let activeEmbeddingModelKey = s.activeEmbeddingModelKey
  if (embeddingModels.length === 0) {
    const provider = normalizeEmbeddingProvider(s.embeddingProvider)
    const key = embeddingKey(provider, s.embeddingModelId)
    embeddingModels = [{ key, provider, modelId: s.embeddingModelId, displayName: embeddingDisplayName(provider, s.embeddingModelId) }]
    activeEmbeddingModelKey = key
  }

  return { ...s, providerConfigs, activeProviderId, embeddingModels, activeEmbeddingModelKey }
}

/** Fill any missing field from the defaults, then migrate the flat fields into the provider model.
 * Used when loading a settings file that predates a field (FEAT-03-05 SC-01, FEAT-05-02 SC-04). */
export function mergeSettings(partial: Partial<StudioSettings>): StudioSettings {
  const merged: StudioSettings = {
    ...defaultSettings,
    ...partial,
    onboarding: { ...defaultSettings.onboarding, ...(partial.onboarding ?? {}) },
  }
  // Normalize the legacy 'fake' embedding backend to 'disabled' (FEAT-05-06), on the flat field and on
  // any persisted embedding-model entries, before the migration derives or reads them.
  merged.embeddingProvider = normalizeEmbeddingProvider(merged.embeddingProvider)
  if (Array.isArray(merged.embeddingModels)) {
    merged.embeddingModels = merged.embeddingModels.map((m) =>
      m && (m.provider as string) === 'fake' ? { ...m, provider: 'disabled', displayName: DISABLED_EMBEDDING_DEFAULT.displayName } : m,
    )
  }
  return migrateFlatToProviderModel(merged)
}

/** The active, enabled provider, or null. Falls back to the flat naming fields when the list carries
 * no usable entry (interim safety net until FEAT-05-03 removes the flat fields). */
export function resolveActiveProvider(s: StudioSettings): ProviderConfig | null {
  const active = s.providerConfigs.find((p) => p.id === s.activeProviderId)
  if (active && active.enabled && active.model.trim() !== '') return active
  if (active && !active.enabled) return null
  if (s.namingProvider !== 'none' && s.namingModel.trim() !== '') {
    const entry: ProviderConfig = {
      id: `flat-${s.namingProvider}`,
      type: s.namingProvider,
      displayName: s.namingProvider,
      enabled: true,
      apiKey: s.namingApiKey,
      model: s.namingModel,
    }
    if (s.namingBaseUrl.trim() !== '') entry.baseUrl = s.namingBaseUrl
    return entry
  }
  return null
}

/** The active embedding model, or the offline fake default when none is active (FEAT-05-02 SC-02).
 * Falls back to the flat embedding fields when the list is empty (interim safety net until FEAT-05-03). */
export function resolveActiveEmbeddingModel(s: StudioSettings): EmbeddingModelConfig {
  const active = s.embeddingModels.find((m) => m.key === s.activeEmbeddingModelKey)
  if (active) return active
  if (s.embeddingModels.length > 0) return s.embeddingModels[0]
  if (s.embeddingProvider) {
    const provider = normalizeEmbeddingProvider(s.embeddingProvider)
    return {
      key: embeddingKey(provider, s.embeddingModelId),
      provider,
      modelId: s.embeddingModelId,
      displayName: embeddingDisplayName(provider, s.embeddingModelId),
    }
  }
  return DISABLED_EMBEDDING_DEFAULT
}

/** True when at least one enabled provider carries an API key (FEAT-05-02 SC-05). */
export function hasAnyCredentials(s: StudioSettings): boolean {
  return s.providerConfigs.some((p) => p.enabled && p.apiKey.trim() !== '')
}

/**
 * A snapshot of settings safe to encrypt in place for persistence, without mutating the live
 * settings (FIX-05-02-01). The credential-bearing nested arrays (providerConfigs AND embeddingModels)
 * are cloned so encrypt*InPlace cannot reach the live objects. Without cloning embeddingModels, the
 * in-place encrypt turns the live embedding apiKey into ciphertext, and the next embedding call sends
 * `Authorization: Bearer <ciphertext>` (HTTP 401). Top-level credential primitives are isolated by the
 * shallow spread already.
 */
export function cloneSettingsForPersist(s: StudioSettings): StudioSettings {
  return {
    ...s,
    providerConfigs: s.providerConfigs.map((p) => ({ ...p })),
    embeddingModels: s.embeddingModels.map((m) => ({ ...m })),
  }
}

/** Encrypt every provider and API-embedding apiKey in place via the crypter. Skips empty or
 * already-encrypted values; idempotent. The array analogue of encryptCredentialsInPlace, walking
 * providerConfigs and embeddingModels (FEAT-05-02/FEAT-05-06 SC-05). */
export function encryptProviderConfigsInPlace(s: StudioSettings, crypter: SettingsCrypter): void {
  for (const p of s.providerConfigs) {
    if (p.apiKey && !crypter.isEncrypted(p.apiKey)) p.apiKey = crypter.encrypt(p.apiKey)
  }
  for (const m of s.embeddingModels) {
    if (m.apiKey && !crypter.isEncrypted(m.apiKey)) m.apiKey = crypter.encrypt(m.apiKey)
  }
}

/** Decrypt every provider and API-embedding apiKey in place. Tolerates already-plaintext values. */
export function decryptProviderConfigsInPlace(s: StudioSettings, crypter: SettingsCrypter): void {
  for (const p of s.providerConfigs) {
    if (p.apiKey) p.apiKey = crypter.decrypt(p.apiKey)
  }
  for (const m of s.embeddingModels) {
    if (m.apiKey) m.apiKey = crypter.decrypt(m.apiKey)
  }
}

/** Validate settings against their ranges. Returns a list of human-readable error messages; an
 * empty list means the settings are safe to persist (SC-05). */
export function validateSettings(s: StudioSettings): string[] {
  const errors: string[] = []
  // Number.isFinite first, so a non-numeric value from a hand-edited file (or an empty input field
  // that produced NaN) is caught rather than silently slipping past a comparison.
  if (!Number.isFinite(s.decayHalfLifeHours) || s.decayHalfLifeHours <= 0) {
    errors.push('Fade time must be a number greater than 0.')
  }
  if (!Number.isFinite(s.tauMin) || s.tauMin < 0) errors.push('tauMin (min strength) must be a number >= 0.')
  if (!Number.isFinite(s.tauMax) || !(s.tauMax > s.tauMin)) errors.push('tauMax (max strength) must be a number greater than tauMin.')
  if (Number.isFinite(s.tauMax) && s.tauMax > 1) errors.push('tauMax must not exceed 1.')
  if (typeof s.heterogeneousEvaluator !== 'boolean') errors.push('Multi-perspective scoring must be true or false.')
  if (!EXPLORATION_POLICIES.includes(s.explorationPolicy)) {
    errors.push(`Unknown selection strategy: ${s.explorationPolicy}.`)
  }
  if (!Array.isArray(s.mcpServers)) {
    errors.push('MCP servers must be a list.')
  } else {
    // Validate each entry shape (AUDIT EPIC-04 L-3): a hand-edited file must produce a clear error
    // rather than reaching discoverMcpTools, which spawns command or constructs a URL from it.
    s.mcpServers.forEach((srv, i) => {
      if (!srv || typeof srv !== 'object') {
        errors.push(`MCP server ${i + 1} must be an object.`)
        return
      }
      if (typeof srv.name !== 'string' || srv.name.trim() === '') errors.push(`MCP server ${i + 1} needs a name.`)
      const hasCommand = typeof srv.command === 'string' && srv.command.trim() !== ''
      const hasUrl = typeof srv.url === 'string' && srv.url.trim() !== ''
      if (hasCommand === hasUrl) errors.push(`MCP server ${i + 1} needs exactly one of command or url.`)
    })
  }
  if (typeof s.skillRoot !== 'string') errors.push('Skill folder must be a path string.')
  if (!EMBEDDING_PROVIDERS.includes(s.embeddingProvider)) errors.push(`Unknown embedding provider: ${s.embeddingProvider}.`)
  if (!NAMING_PROVIDERS.includes(s.namingProvider)) errors.push(`Unknown naming provider: ${s.namingProvider}.`)
  if (s.namingProvider !== 'none' && s.namingModel.trim() === '') errors.push('A naming model is required when a naming provider is set.')

  // FEAT-05-02 provider/embedding config model (ADR-22).
  if (!Array.isArray(s.providerConfigs)) {
    errors.push('Providers must be a list.')
  } else {
    s.providerConfigs.forEach((p, i) => {
      if (!p || typeof p !== 'object') {
        errors.push(`Provider ${i + 1} must be an object.`)
        return
      }
      if (typeof p.id !== 'string' || p.id.trim() === '') errors.push(`Provider ${i + 1} needs an id.`)
      if (!PROVIDER_TYPES.includes(p.type)) errors.push(`Provider ${i + 1} has an unknown provider type: ${p.type}.`)
      if (p.enabled && (typeof p.model !== 'string' || p.model.trim() === '')) {
        errors.push(`Provider ${i + 1} needs a model when enabled.`)
      }
    })
  }
  if (s.activeProviderId !== null && !s.providerConfigs.some((p) => p.id === s.activeProviderId)) {
    errors.push('The active provider points to no configured provider.')
  }
  if (!Array.isArray(s.embeddingModels)) {
    errors.push('Embedding models must be a list.')
  } else {
    s.embeddingModels.forEach((m, i) => {
      if (!m || typeof m !== 'object') {
        errors.push(`Embedding model ${i + 1} must be an object.`)
        return
      }
      if (typeof m.key !== 'string' || m.key.trim() === '') errors.push(`Embedding model ${i + 1} needs a key.`)
      if (!EMBEDDING_PROVIDERS.includes(m.provider)) errors.push(`Embedding model ${i + 1} has an unknown provider: ${m.provider}.`)
    })
  }
  if (s.activeEmbeddingModelKey !== null && !s.embeddingModels.some((m) => m.key === s.activeEmbeddingModelKey)) {
    errors.push('The active embedding model points to no configured model.')
  }
  if (!s.onboarding || typeof s.onboarding.completed !== 'boolean') {
    errors.push('Onboarding state must carry a boolean completed flag.')
  }
  return errors
}
