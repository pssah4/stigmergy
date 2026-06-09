// Deterministic aggregation of per-task results into the report metrics (FEAT-02-03).
// median and percentile are pure and order-independent (they sort a copy), so the same
// task set always yields the same numbers.
import type { TaskResult } from './runner.js'

export interface VariantMetrics {
  taskCount: number
  /** Fraction of tasks that succeeded, in [0, 1]. */
  successRate: number
  tokenMedian: number
  tokenP95: number
  attemptsMedian: number
  /** Fraction of tasks where the first surfaced capability was the oracle, in [0, 1]. */
  firstTryCorrectRate: number
  totalTokens: number
}

/** Median; for an even count the mean of the two middle values. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/** Nearest-rank percentile; p in [0, 1]. p95 over 4 values returns the maximum. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const rank = Math.ceil(p * s.length)
  const idx = Math.min(s.length - 1, Math.max(0, rank - 1))
  return s[idx]!
}

export function aggregate(tasks: readonly TaskResult[]): VariantMetrics {
  const n = tasks.length
  const tokens = tasks.map((t) => t.tokenCost)
  const attempts = tasks.map((t) => t.attempts)
  const successes = tasks.filter((t) => t.success).length
  const ftc = tasks.filter((t) => t.firstTryCorrect).length
  return {
    taskCount: n,
    successRate: n > 0 ? successes / n : 0,
    tokenMedian: median(tokens),
    tokenP95: percentile(tokens, 0.95),
    attemptsMedian: median(attempts),
    firstTryCorrectRate: n > 0 ? ftc / n : 0,
    totalTokens: tokens.reduce((a, b) => a + b, 0),
  }
}
