// Model tier classifier (FEAT-01-07, ADR-11). Lean port of Vault Operator
// src/core/routing/ModelTierClassifier.ts: pattern-based tiering, local providers return null.
// Pure, zero host coupling. Used later by FEAT-02-04 (heterogeneous evaluator) for model routing.

export type ModelTier = 'fast' | 'mid' | 'flagship'

const FLAGSHIP_PATTERNS: readonly RegExp[] = [/opus/i, /gpt-4\.1/i, /\bo3\b/i, /gpt-5/i]
const MID_PATTERNS: readonly RegExp[] = [/sonnet/i, /gpt-4o(?!-mini)/i, /gemini-1\.5-pro/i]
const FAST_PATTERNS: readonly RegExp[] = [/haiku/i, /mini/i, /flash/i, /llama/i]

/** Classify a model id into a tier by name pattern. Returns null for unknown or local models. */
export function classifyModelTier(modelId: string): ModelTier | null {
  if (FLAGSHIP_PATTERNS.some((r) => r.test(modelId))) return 'flagship'
  if (MID_PATTERNS.some((r) => r.test(modelId))) return 'mid'
  if (FAST_PATTERNS.some((r) => r.test(modelId))) return 'fast'
  return null
}
