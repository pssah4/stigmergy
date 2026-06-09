// OpenAI-compatible embedding adapter (FEAT-05-06, ADR-24). An EmbeddingPort that computes embeddings
// through an API provider's /v1/embeddings endpoint, ported from Vault Operator's SemanticIndexService
// embedding path. Covers openai, openrouter, ollama, lmstudio, custom (all OpenAI-compatible). Runs on
// the injectable fetch seam (ProviderDeps), so it is unit-tested without real network. NO model tiers.

import type { EmbeddingPort } from '@agentic-stigmergy/core'
import { ValidationError } from '@agentic-stigmergy/core'
import type { ProviderType, ProviderDeps } from './types.js'

export interface OpenAiCompatibleEmbeddingConfig {
  /** API provider type. anthropic is not embedding-capable and must not be used here. */
  type: ProviderType
  /** The embedding model name sent in the request body. */
  model: string
  apiKey?: string
  baseUrl?: string
  /** Reported dimension before the first embedding; auto-corrected from the real output. */
  dimension?: number
}

const MAX_EMBED_CHARS = 100_000
const DEFAULT_DIM = 1536
const EMBED_TIMEOUT_MS = 30_000

/** Resolve the OpenAI-compatible base URL (ending before /embeddings) per provider (ported from VO). */
function embeddingBaseUrl(type: ProviderType, baseUrl?: string): string {
  if (type === 'openai') return 'https://api.openai.com/v1'
  if (type === 'openrouter') return 'https://openrouter.ai/api/v1'
  if (type === 'ollama' || type === 'lmstudio') {
    const def = type === 'lmstudio' ? 'http://localhost:1234' : 'http://localhost:11434'
    const root = (baseUrl || def).replace(/\/v1\/?$/, '').replace(/\/+$/, '')
    return `${root}/v1`
  }
  // custom: respect an explicit /v1 suffix, else append it.
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

/** Build an EmbeddingPort backed by an OpenAI-compatible /v1/embeddings endpoint (FEAT-05-06 SC-03). */
export function makeOpenAiCompatibleEmbedding(
  config: OpenAiCompatibleEmbeddingConfig,
  deps: ProviderDeps = { fetch: globalThis.fetch },
): EmbeddingPort {
  let dim = config.dimension ?? DEFAULT_DIM
  const url = `${embeddingBaseUrl(config.type, config.baseUrl)}/embeddings`
  const fetchFn = deps.fetch

  return {
    async embed(text: string): Promise<Float32Array> {
      if (text.length > MAX_EMBED_CHARS) {
        throw new ValidationError(`embed: text exceeds ${MAX_EMBED_CHARS} characters`)
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('embedding request timed out after 30s')), EMBED_TIMEOUT_MS)
      })
      let res: Response
      try {
        res = (await Promise.race([
          fetchFn(url, { method: 'POST', headers, body: JSON.stringify({ model: config.model, input: [text] }) }),
          timeout,
        ])) as Response
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      const vec = json?.data?.[0]?.embedding
      if (!Array.isArray(vec)) throw new Error('embedding response missing data[0].embedding')
      const out = Float32Array.from(vec)
      dim = out.length // auto-correct the reported dimension from the real model output
      return out
    },
    dimension(): number {
      return dim
    },
    modelHash(): string {
      return `${config.type}:${config.model}`
    },
  }
}
