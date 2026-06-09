import type { ApiHandler, LLMProviderConfig, ProviderDeps } from '../types.js'

// Anthropic Messages-API handler (FEAT-01-07, ADR-11). Request composition ported faithfully
// from Vault Operator src/api/providers/anthropic.ts classifyText (model, max_tokens, single
// user message, first text block trimmed). The Obsidian SDK is replaced by an injectable fetch
// against the documented HTTP API, which is the ADR-11 decoupling point (requestUrl -> fetch).

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_BASE = 'https://api.anthropic.com'

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>
}

export class AnthropicHandler implements ApiHandler {
  constructor(
    private readonly config: LLMProviderConfig,
    private readonly deps: ProviderDeps,
  ) {}

  async classifyText(prompt: string, signal?: AbortSignal): Promise<string> {
    const base = (this.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
    const res = await this.deps.fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 128,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    })
    if (!res.ok) {
      throw new Error(`anthropic classifyText failed: ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as AnthropicMessagesResponse
    const text = data.content?.find((b) => b.type === 'text')?.text ?? ''
    return text.trim()
  }
}
