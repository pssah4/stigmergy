import type { ApiHandler, LLMProviderConfig, ProviderDeps } from './types.js'
import { AnthropicHandler } from './providers/anthropic.js'
import { OpenAiCompatibleHandler } from './providers/openai-compatible.js'

// Provider factory (FEAT-01-07, ADR-11). Ported from Vault Operator src/api/index.ts
// buildApiHandler: an exhaustive switch over the provider type. The default deps use the global
// fetch (Node 18+); pass a fetch to decouple from Obsidian's requestUrl or to mock in tests.
export function buildApiHandler(
  config: LLMProviderConfig,
  deps: ProviderDeps = { fetch: globalThis.fetch },
): ApiHandler {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicHandler(config, deps)
    case 'openai':
    case 'ollama':
    case 'lmstudio':
    case 'openrouter':
    case 'custom':
      return new OpenAiCompatibleHandler(config, deps)
    default: {
      const exhaustive: never = config.type
      throw new Error(`unknown provider type: ${String(exhaustive)}`)
    }
  }
}
