// Model metadata (FEAT-01-07, ADR-11). Lean port of Vault Operator src/types/model-registry.ts:
// only the fields the MVP needs. Pure data plus pure lookups, zero host coupling.

export interface ModelInfo {
  id: string
  provider: string
  contextWindow: number
  maxOutputTokens: number
  displayName: string
}

const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    displayName: 'Claude Haiku 4.5',
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    displayName: 'Claude Sonnet 4.6',
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    displayName: 'GPT-4o mini',
  },
  'llama3.1': {
    id: 'llama3.1',
    provider: 'ollama',
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    displayName: 'Llama 3.1 (local)',
  },
}

export function getModelInfo(id: string): ModelInfo | null {
  return MODELS[id] ?? null
}

export function listModels(): ModelInfo[] {
  return Object.values(MODELS)
}
