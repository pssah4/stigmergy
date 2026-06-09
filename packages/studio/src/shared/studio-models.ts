// Studio-owned model wiring (FEAT-04-07, ADR-18, ADR-25). The embedding is HARD-WIRED to the local
// transformers model (IMP-05-06-02): no fake and no remote embedding in the Studio runtime, matching the
// daemon, so a Discover and the daemon share one 384-dim space and there are no fakes in production. The
// LLM provider (the optional augmenter) stays configurable. The makers are injectable for unit tests.
import type { EmbeddingPort, CapabilityAugmenter } from '@agentic-stigmergy/core'
import { TransformersEmbedding } from '@stigmergy/embedding-transformers'
import { buildApiHandler, makeCapabilityAugmenter, type ApiHandler, type LLMProviderConfig } from '@stigmergy/llm'
import { resolveActiveProvider, type StudioSettings } from './settings.js'

export interface StudioEngineModels {
  embedding: EmbeddingPort
  augmenter?: CapabilityAugmenter
}

export interface StudioModelDeps {
  /** Build the embedding. Hard-wired to the local model; injectable so tests pass a FakeEmbedding. */
  makeEmbedding: () => EmbeddingPort
  makeHandler: (config: LLMProviderConfig) => ApiHandler
}

const defaultDeps: StudioModelDeps = {
  makeEmbedding: () => new TransformersEmbedding(),
  makeHandler: (config) => buildApiHandler(config),
}

/** Resolve the embedding port (always the local model) and the optional augmenter from the Studio's
 * active LLM provider (FEAT-04-07, ADR-25). The embedding is not configurable: the loop's consult path
 * runs the embedding per turn, where a fast offline local model is the only sensible choice. */
export function studioEngineModels(settings: StudioSettings, deps: StudioModelDeps = defaultDeps): StudioEngineModels {
  const embedding = deps.makeEmbedding()
  const provider = resolveActiveProvider(settings)
  if (!provider) return { embedding }
  const handler = deps.makeHandler({
    type: provider.type,
    model: provider.model,
    apiKey: provider.apiKey || undefined,
    baseUrl: provider.baseUrl || undefined,
  })
  return { embedding, augmenter: makeCapabilityAugmenter(handler, { model: provider.model }) }
}
