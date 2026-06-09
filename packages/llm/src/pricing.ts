// Model pricing (FEAT-01-07, ADR-11). Lean port of Vault Operator src/core/pricing/ModelPricing.ts:
// per-million-token rates plus a cost calculation. Pure, zero host coupling. Manually maintained.

export interface ModelPrice {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
}

const PRICING: Record<string, ModelPrice> = {
  'claude-haiku-4-5-20251001': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  'claude-sonnet-4-6': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'llama3.1': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
}

export function getModelPrice(modelId: string): ModelPrice | null {
  return PRICING[modelId] ?? null
}

/** USD cost of a call. Returns null for an unpriced model. */
export function computeCost(modelId: string, inputTokens: number, outputTokens: number): number | null {
  const p = getModelPrice(modelId)
  if (!p) return null
  return (inputTokens / 1_000_000) * p.inputPerMillionUsd + (outputTokens / 1_000_000) * p.outputPerMillionUsd
}
