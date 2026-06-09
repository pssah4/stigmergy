// Provider-layer types (FEAT-01-07, ADR-11). Ported from Vault Operator src/api/types.ts.
// The MVP carries only classifyText (a light non-streaming completion); createMessage
// (streaming plus tools) is ported with the heterogeneous evaluator (FEAT-02-04).

/** Provider families supported in the MVP. anthropic uses the Messages API; the rest are
 * OpenAI-chat-completions compatible (ollama and lmstudio expose that endpoint locally). */
export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'lmstudio' | 'openrouter' | 'custom'

export interface LLMProviderConfig {
  type: ProviderType
  model: string
  apiKey?: string
  /** Override the provider base URL (e.g. a local Ollama endpoint). */
  baseUrl?: string
  /** Max output tokens for classifyText. Default 128 (enough for a one-sentence augmentation). */
  maxTokens?: number
}

/** The ported ApiHandler contract. Only classifyText is needed for capability augmentation. */
export interface ApiHandler {
  classifyText(prompt: string, signal?: AbortSignal): Promise<string>
}

/** Injectable host dependencies. The fetch decouples Obsidian's requestUrl (ADR-11) and is the
 * test seam; default callers pass the global fetch (Node 18+). */
export interface ProviderDeps {
  fetch: typeof fetch
}
