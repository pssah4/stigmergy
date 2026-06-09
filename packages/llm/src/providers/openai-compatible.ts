import type { ApiHandler, LLMProviderConfig, ProviderDeps, ProviderType } from '../types.js'

// OpenAI chat-completions handler (FEAT-01-07, ADR-11). Covers openai, ollama, lmstudio,
// openrouter and custom (all expose the OpenAI chat-completions shape; ollama and lmstudio do
// so on a local endpoint). Request composition ported from Vault Operator
// src/api/providers/openai.ts classifyText (model, max_tokens, single user message,
// choices[0].message.content trimmed) over an injectable fetch.

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: 'https://api.openai.com/v1',
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export class OpenAiCompatibleHandler implements ApiHandler {
  constructor(
    private readonly config: LLMProviderConfig,
    private readonly deps: ProviderDeps,
  ) {}

  async classifyText(prompt: string, signal?: AbortSignal): Promise<string> {
    const base = (this.config.baseUrl ?? DEFAULT_BASE_URLS[this.config.type]).replace(/\/+$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    const res = await this.deps.fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 128,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    })
    if (!res.ok) {
      throw new Error(`openai-compatible classifyText failed: ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as ChatCompletionResponse
    return (data.choices?.[0]?.message?.content ?? '').trim()
  }
}
