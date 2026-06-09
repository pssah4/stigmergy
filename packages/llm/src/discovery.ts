// Model discovery (FEAT-05-06, ADR-24). Ported from Vault Operator src/ui/settings/testModelConnection.ts
// (fetchProviderModels / fetchEmbeddingModels). Lists the models a configured provider offers, so the
// UI can show a picker instead of a free-text id field. Runs on the injectable fetch seam (ProviderDeps),
// so it is unit-tested without real network. Provider set is the @stigmergy/llm set; no gemini/bedrock/
// copilot/kilo. NO model tiers.

import type { ProviderType, ProviderDeps } from './types.js'

export interface DiscoveredModel {
  id: string
  label: string
}

export interface DiscoveryConfig {
  type: ProviderType
  apiKey?: string
  baseUrl?: string
}

interface ApiModelEntry {
  id?: string
  name?: string
  display_name?: string
  created?: number
  supported_parameters?: string[]
}

// OpenAI chat-completion filter (ported): keep gpt-/o[1-9]/chatgpt-/codex- prefixes, drop the non-chat
// modalities and Responses-only variants so the picker only offers usable chat models.
const CHAT_PREFIX_RE = /^(gpt-|o[1-9]|chatgpt-|codex-)/
const NONCHAT_EXCLUDE_RE = new RegExp(
  [
    String.raw`-(instruct|vision-preview|0314|0301|0613|0914|32k)$`,
    String.raw`:ft-`,
    String.raw`(?:^|-)(?:realtime|audio|tts|transcribe|whisper|image|search-preview|search-api|deep-research)(?:-|$)`,
    String.raw`(?:^|-)pro(?:-\d|$)`,
    String.raw`-codex(?:-|$)`,
    String.raw`^chatgpt-(?:image|realtime|audio|tts)`,
  ].join('|'),
  'i',
)

/** Whether an OpenAI model id is a chat-completion model (excludes embeddings, audio, image, etc.). */
export function isOpenAIChatCompletionModel(id: string): boolean {
  if (!id) return false
  if (!CHAT_PREFIX_RE.test(id)) return false
  if (NONCHAT_EXCLUDE_RE.test(id)) return false
  return true
}

/** A GET that returns {status, json}, with a 10s timeout. Uses the injectable fetch (no Obsidian requestUrl). */
async function getJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Model fetch timed out after 10s')), 10_000)
  })
  try {
    const res = (await Promise.race([fetchFn(url, { method: 'GET', headers }), timeout])) as Response
    let json: unknown
    try {
      json = await res.json()
    } catch {
      json = undefined
    }
    return { status: res.status, json }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function asEntries(json: unknown): ApiModelEntry[] {
  const data = (json as { data?: unknown })?.data
  return Array.isArray(data) ? (data as ApiModelEntry[]) : []
}

/** Normalize a base URL to the server root (strip a trailing /v1 and slashes). */
function root(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl || fallback).replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

/** Fetch the chat models a provider offers, as {id, label} pairs for a picker (SC-01). */
export async function fetchModels(
  config: DiscoveryConfig,
  deps: ProviderDeps = { fetch: globalThis.fetch },
): Promise<DiscoveredModel[]> {
  const { type, apiKey, baseUrl } = config
  const fetchFn = deps.fetch

  if (type === 'anthropic') {
    if (!apiKey) throw new Error('API key required for Anthropic')
    const res = await getJson(fetchFn, 'https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
    if (res.status === 401) throw new Error('Invalid API key (401 Unauthorized)')
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return asEntries(res.json)
      .filter((m) => /^claude-/.test(m.id ?? ''))
      .map((m) => ({ id: m.id as string, label: (m.display_name ?? m.id) as string }))
      .sort((a, b) => b.id.localeCompare(a.id))
  }

  if (type === 'openai') {
    if (!apiKey) throw new Error('API key required for OpenAI')
    const res = await getJson(fetchFn, 'https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` })
    if (res.status === 401) throw new Error('Invalid API key (401 Unauthorized)')
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return asEntries(res.json)
      .filter((m) => isOpenAIChatCompletionModel(m.id ?? ''))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id as string, label: m.id as string }))
  }

  if (type === 'openrouter') {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const res = await getJson(fetchFn, 'https://openrouter.ai/api/v1/models', headers)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return asEntries(res.json)
      .filter((m) => {
        const caps = m.supported_parameters ?? []
        if (caps.length === 0) return true
        return caps.includes('tools') || caps.includes('tool_choice')
      })
      .map((m) => ({ id: m.id as string, label: (m.name ?? m.id) as string }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  if (type === 'lmstudio') {
    const res = await getJson(fetchFn, `${root(baseUrl, 'http://localhost:1234')}/v1/models`)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}. Is LM Studio running with the local server enabled?`)
    return asEntries(res.json)
      .map((m) => ({ id: m.id as string, label: m.id as string }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  if (type === 'ollama') {
    const ollamaRoot = (baseUrl || 'http://localhost:11434').replace(/\/v\d[^/]*\/?$/, '').replace(/\/+$/, '')
    const res = await getJson(fetchFn, `${ollamaRoot}/api/tags`)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}. Is Ollama running?`)
    const models = (res.json as { models?: Array<{ name: string }> })?.models ?? []
    return models
      .map((m) => m.name)
      .sort()
      .map((id) => ({ id, label: id }))
  }

  // custom: OpenAI-compatible /v1/models
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const res = await getJson(fetchFn, `${root(baseUrl, 'http://localhost:1234')}/v1/models`, headers)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  return asEntries(res.json)
    .map((m) => ({ id: m.id as string, label: m.id as string }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Fetch the embedding models a provider offers (SC-02). anthropic has no embeddings. */
export async function fetchEmbeddingModels(
  config: DiscoveryConfig,
  deps: ProviderDeps = { fetch: globalThis.fetch },
): Promise<DiscoveredModel[]> {
  const { type, apiKey, baseUrl } = config
  const fetchFn = deps.fetch

  if (type === 'openai') {
    // OpenAI's /v1/models needs auth and mixes modalities; return the known stable embedding list.
    return [
      { id: 'text-embedding-3-small', label: 'text-embedding-3-small (1536 dims, recommended)' },
      { id: 'text-embedding-3-large', label: 'text-embedding-3-large (3072 dims, highest quality)' },
      { id: 'text-embedding-ada-002', label: 'text-embedding-ada-002 (1536 dims, legacy)' },
    ]
  }

  if (type === 'ollama') {
    const ollamaRoot = (baseUrl || 'http://localhost:11434').replace(/\/v\d[^/]*\/?$/, '').replace(/\/+$/, '')
    const res = await getJson(fetchFn, `${ollamaRoot}/api/tags`)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}. Is Ollama running?`)
    const all = ((res.json as { models?: Array<{ name: string }> })?.models ?? []).map((m) => m.name)
    const embeds = all.filter((n) => /embed|bge|minilm|arctic-embed|e5-|gte-/i.test(n))
    return (embeds.length > 0 ? embeds : all).sort().map((id) => ({ id, label: id }))
  }

  if (type === 'lmstudio') {
    const res = await getJson(fetchFn, `${root(baseUrl, 'http://localhost:1234')}/v1/models`)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}. Is LM Studio running?`)
    return asEntries(res.json)
      .map((m) => ({ id: m.id as string, label: m.id as string }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  if (type === 'openrouter') {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    try {
      const res = await getJson(fetchFn, 'https://openrouter.ai/api/v1/embeddings/models', headers)
      if (res.status === 200) {
        const entries = asEntries(res.json)
        if (entries.length > 0) {
          return entries.map((m) => ({ id: m.id as string, label: (m.name ?? m.id) as string })).sort((a, b) => a.label.localeCompare(b.label))
        }
      }
    } catch {
      /* fall through to the static fallback */
    }
    return [
      { id: 'openai/text-embedding-3-small', label: 'OpenAI: Text Embedding 3 Small' },
      { id: 'openai/text-embedding-3-large', label: 'OpenAI: Text Embedding 3 Large' },
    ]
  }

  if (type === 'custom') {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const res = await getJson(fetchFn, `${root(baseUrl, '')}/v1/models`, headers)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const all = asEntries(res.json).map((m) => ({ id: m.id as string, label: m.id as string }))
    const filtered = all.filter((m) => /embed/i.test(m.id))
    return (filtered.length > 0 ? filtered : all).sort((a, b) => a.id.localeCompare(b.id))
  }

  throw new Error(`${type} does not provide an embedding model list`)
}
