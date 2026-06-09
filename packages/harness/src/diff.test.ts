import { describe, it, expect } from 'vitest'
import { diffReports, diffToMarkdown } from './diff.js'
import type { Report } from './report.js'

function report(name: string, totalTokens: number, tokenMedian: number, successRate: number): Report {
  return {
    workload: { id: 'w', version: '1', hash: 'h' },
    variant: { name, learn: true, knobs: {} },
    seed: 1,
    metrics: { taskCount: 4, successRate, tokenMedian, tokenP95: tokenMedian, attemptsMedian: 1, firstTryCorrectRate: successRate, totalTokens },
    tasks: [],
  }
}

describe('diffReports', () => {
  it('computes the H1 token-reduction figure and a non-negative success delta', () => {
    const base = report('baseline', 4000, 1000, 0.8)
    const treat = report('treatment', 3000, 750, 0.8)
    const d = diffReports(base, treat)
    expect(d.totalTokenDelta).toBe(-1000)
    expect(d.tokenReductionPct).toBeCloseTo(0.25, 5) // (4000-3000)/4000
    expect(d.successRateDelta).toBe(0)
  })

  it('is safe when the baseline has zero tokens', () => {
    expect(diffReports(report('b', 0, 0, 0), report('t', 0, 0, 0)).tokenReductionPct).toBe(0)
  })
})

describe('diffToMarkdown', () => {
  it('renders the token reduction percentage', () => {
    const md = diffToMarkdown(diffReports(report('baseline', 4000, 1000, 0.8), report('treatment', 3000, 750, 0.9)))
    expect(md).toContain('# Diff: treatment vs baseline')
    expect(md).toContain('| Token reduction | 25.0% |')
  })
})
