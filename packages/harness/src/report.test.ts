import { describe, it, expect } from 'vitest'
import { buildReport, reportToJson, reportToMarkdown, type Report } from './report.js'
import type { WorkloadWithHash } from './workload.js'
import type { Variant, VariantResult } from './runner.js'

const w: WorkloadWithHash = {
  workload: {
    id: 'wl-report',
    version: '2.0',
    capabilities: [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 100 }],
    tasks: [{ id: 't1', context: 'c', expectedCapabilityClasses: [], oracle: 'tool:a', successCriteria: [], tokenBudget: 1000 }],
  },
  hash: 'abcdef0123456789',
  file: 'workloads/wl-report-v2.json',
}

const variant: Variant = { name: 'treatment', knobs: { decay: false }, topK: 2, learn: true }

const result: VariantResult = {
  variant: 'treatment',
  tasks: [
    { taskId: 't1', success: true, attempts: 1, firstTryCorrect: true, tokenCost: 250 },
    { taskId: 't2', success: false, attempts: 2, firstTryCorrect: false, tokenCost: 350 },
  ],
}

describe('buildReport', () => {
  it('carries the workload hash, seed, variant and aggregated metrics', () => {
    const r = buildReport(w, variant, 42, result)
    expect(r.workload.hash).toBe('abcdef0123456789')
    expect(r.workload.file).toBe('workloads/wl-report-v2.json')
    expect(r.seed).toBe(42)
    expect(r.variant.name).toBe('treatment')
    expect(r.variant.learn).toBe(true)
    expect(r.metrics.taskCount).toBe(2)
    expect(r.metrics.successRate).toBe(0.5)
    expect(r.metrics.totalTokens).toBe(600)
  })
})

describe('report serialization (SC-06)', () => {
  let r: Report
  it('emits valid JSON that round-trips and contains the hash', () => {
    r = buildReport(w, variant, 42, result)
    const json = reportToJson(r)
    const parsed = JSON.parse(json) as Report
    expect(parsed.workload.hash).toBe('abcdef0123456789')
    expect(parsed.metrics.totalTokens).toBe(600)
  })

  it('emits Markdown with the variant name, hash and a metrics table', () => {
    const md = reportToMarkdown(buildReport(w, variant, 42, result))
    expect(md).toContain('# Harness report: treatment')
    expect(md).toContain('abcdef012345') // 12-char hash prefix
    expect(md).toContain('Seed: 42')
    expect(md).toContain('| Total tokens | 600 |')
    expect(md).toContain('| t1 | yes | 1 | yes | 250 |')
  })

  it('defaults missing knobs to {} and renders an inline workload (no file) with topK=all', () => {
    const inline: WorkloadWithHash = {
      workload: {
        id: 'wl-inline',
        version: '1',
        capabilities: [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }],
        tasks: [{ id: 't', context: 'c', expectedCapabilityClasses: [], oracle: 'tool:a', successCriteria: [], tokenBudget: 100 }],
      },
      hash: 'deadbeef',
    } // no file
    const bare: Variant = { name: 'bare' } // no knobs, no topK, no learn
    const r = buildReport(inline, bare, 1, { variant: 'bare', tasks: [] })
    expect(r.variant.knobs).toEqual({})
    expect(r.variant.learn).toBe(true)
    const md = reportToMarkdown(r)
    expect(md).toContain('File: (inline)')
    expect(md).toContain('topK=all')
  })
})
