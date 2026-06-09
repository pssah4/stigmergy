// Pure editing reducer for the LLM-provider config model (FEAT-05-03, ADR-22). The SettingsPanel drives
// all provider edits through these functions, so the list-plus-active-pointer logic is unit-tested
// without React. No Date/Random (ids are derived from existing ids). NO model tiers. The embedding is
// hard-wired to the local model (ADR-25, IMP-05-06-02), so there are no embedding-model reducers.
import { type StudioSettings, type ProviderConfig } from './settings.js'
import type { ProviderType } from '@stigmergy/llm'

/** Remote providers send an API key to a hosted endpoint; local ones (ollama/lmstudio/custom) need none. */
const REMOTE_PROVIDERS: readonly ProviderType[] = ['anthropic', 'openai', 'openrouter']

/** Next stable provider id (`p1`, `p2`, ...) derived from the existing ids, no Date/Random. */
function nextProviderId(s: StudioSettings): string {
  let max = 0
  for (const p of s.providerConfigs) {
    const m = /^p(\d+)$/.exec(p.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `p${max + 1}`
}

/** Append a new provider of the given type. The first provider becomes active; later ones do not steal it. */
export function addProvider(s: StudioSettings, type: ProviderType): StudioSettings {
  const id = nextProviderId(s)
  const entry: ProviderConfig = { id, type, displayName: type, enabled: true, apiKey: '', model: '' }
  const providerConfigs = [...s.providerConfigs, entry]
  const activeProviderId = s.activeProviderId ?? id
  return { ...s, providerConfigs, activeProviderId }
}

/** Merge a patch into the matching provider entry. */
export function updateProvider(s: StudioSettings, id: string, patch: Partial<ProviderConfig>): StudioSettings {
  return { ...s, providerConfigs: s.providerConfigs.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)) }
}

/** Remove a provider; if it was active, the active pointer is cleared. */
export function removeProvider(s: StudioSettings, id: string): StudioSettings {
  return {
    ...s,
    providerConfigs: s.providerConfigs.filter((p) => p.id !== id),
    activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
  }
}

/** Set the active provider (only when the id exists). */
export function setActiveProvider(s: StudioSettings, id: string): StudioSettings {
  if (!s.providerConfigs.some((p) => p.id === id)) return s
  return { ...s, activeProviderId: id }
}

/** Whether a provider can be live-tested: it needs a model, and a remote provider needs an API key. */
export function canProbe(config: ProviderConfig): { ok: true } | { ok: false; reason: string } {
  if (config.model.trim() === '') return { ok: false, reason: 'A model is required before testing.' }
  if (REMOTE_PROVIDERS.includes(config.type) && config.apiKey.trim() === '') {
    return { ok: false, reason: 'An API key is required for this provider.' }
  }
  return { ok: true }
}
