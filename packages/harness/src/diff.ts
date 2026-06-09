// Baseline-vs-treatment diff over two reports (FEAT-02-03, Story 1/2). tokenReductionPct
// is the H1-relevant number: (baseline.total - treatment.total) / baseline.total. A value
// of 0.15 or higher on a real workload supports H1; successRateDelta >= 0 guards the
// "no regression" half of H1.
import type { Report } from './report.js'

export interface ReportDiff {
  baseline: string
  treatment: string
  /** treatment.total - baseline.total; negative means the treatment is cheaper. */
  totalTokenDelta: number
  /** (baseline.total - treatment.total) / baseline.total; the H1 token-reduction figure. */
  tokenReductionPct: number
  tokenMedianDelta: number
  /** treatment - baseline; >= 0 means no success regression. */
  successRateDelta: number
  attemptsMedianDelta: number
  firstTryCorrectRateDelta: number
}

export function diffReports(baseline: Report, treatment: Report): ReportDiff {
  const b = baseline.metrics
  const t = treatment.metrics
  return {
    baseline: baseline.variant.name,
    treatment: treatment.variant.name,
    totalTokenDelta: t.totalTokens - b.totalTokens,
    tokenReductionPct: b.totalTokens > 0 ? (b.totalTokens - t.totalTokens) / b.totalTokens : 0,
    tokenMedianDelta: t.tokenMedian - b.tokenMedian,
    successRateDelta: t.successRate - b.successRate,
    attemptsMedianDelta: t.attemptsMedian - b.attemptsMedian,
    firstTryCorrectRateDelta: t.firstTryCorrectRate - b.firstTryCorrectRate,
  }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

export function diffToMarkdown(d: ReportDiff): string {
  return [
    `# Diff: ${d.treatment} vs ${d.baseline}`,
    '',
    '| Metric | Delta (treatment - baseline) |',
    '|---|---|',
    `| Token reduction | ${pct(d.tokenReductionPct)} |`,
    `| Total tokens | ${d.totalTokenDelta} |`,
    `| Tokens median | ${d.tokenMedianDelta} |`,
    `| Success rate | ${pct(d.successRateDelta)} |`,
    `| Attempts median | ${d.attemptsMedianDelta} |`,
    `| First-try-correct rate | ${pct(d.firstTryCorrectRateDelta)} |`,
    '',
  ].join('\n')
}
