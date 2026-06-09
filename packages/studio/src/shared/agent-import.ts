// Import models from the connected agent project (FEAT-04-07c). A best-effort prefill: read the
// project's .stigmergy/models.json and lift the model choices into the Studio settings form. Never
// imports secrets (no apiKey), validates enum fields, and drops anything unknown. Pure, so it is
// unit-tested; the IPC reads the file and hands the JSON here. The user still reviews and saves.
import { EMBEDDING_PROVIDERS, NAMING_PROVIDERS, type EmbeddingProvider, type NamingProvider, type StudioSettings } from './settings.js'

/** The subset of model settings safe to prefill from another project's config (no credentials). */
export type ImportedModels = Partial<
  Pick<StudioSettings, 'embeddingProvider' | 'embeddingModelId' | 'namingProvider' | 'namingModel' | 'namingBaseUrl'>
>

export function parseAgentModels(raw: unknown): ImportedModels {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const out: ImportedModels = {}
  const ep = o['embeddingProvider']
  if (typeof ep === 'string' && (EMBEDDING_PROVIDERS as readonly string[]).includes(ep)) out.embeddingProvider = ep as EmbeddingProvider
  if (typeof o['embeddingModelId'] === 'string') out.embeddingModelId = o['embeddingModelId']
  const np = o['namingProvider']
  if (typeof np === 'string' && (NAMING_PROVIDERS as readonly string[]).includes(np)) out.namingProvider = np as NamingProvider
  if (typeof o['namingModel'] === 'string') out.namingModel = o['namingModel']
  if (typeof o['namingBaseUrl'] === 'string') out.namingBaseUrl = o['namingBaseUrl']
  return out
}
