// Run reports, machine-readable (JSON) and human-readable (Markdown) (FEAT-02-03,
// SC-06). Each report is self-contained (ADR-08): it carries the workload id, version
// and content-hash, the seed, and the full variant definition, so re-running
// applyAblation(knobs, seed) reproduces the exact config the numbers came from.
import type { WorkloadWithHash } from './workload.js'
import type { AblationKnobs } from './ablation.js'
import type { Variant, VariantResult, TaskResult } from './runner.js'
import { aggregate, type VariantMetrics } from './metrics.js'

export interface ReportWorkloadRef {
  id: string
  version: string
  hash: string
  file?: string
}

export interface ReportVariant {
  name: string
  topK?: number
  learn: boolean
  knobs: AblationKnobs
}

export interface Report {
  workload: ReportWorkloadRef
  variant: ReportVariant
  seed: number
  metrics: VariantMetrics
  tasks: TaskResult[]
}

export function buildReport(w: WorkloadWithHash, variant: Variant, seed: number, result: VariantResult): Report {
  return {
    workload: { id: w.workload.id, version: w.workload.version, hash: w.hash, file: w.file },
    variant: { name: variant.name, topK: variant.topK, learn: variant.learn ?? true, knobs: variant.knobs ?? {} },
    seed,
    metrics: aggregate(result.tasks),
    tasks: result.tasks,
  }
}

export function reportToJson(r: Report): string {
  return JSON.stringify(r, null, 2)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

export function reportToMarkdown(r: Report): string {
  const m = r.metrics
  const topK = r.variant.topK === undefined ? 'all' : String(r.variant.topK)
  const lines = [
    `# Harness report: ${r.variant.name}`,
    '',
    `- Workload: ${r.workload.id} v${r.workload.version} (hash ${r.workload.hash.slice(0, 12)})`,
    `- File: ${r.workload.file ?? '(inline)'}`,
    `- Seed: ${r.seed}`,
    `- Variant: topK=${topK}, learn=${r.variant.learn}, knobs=${JSON.stringify(r.variant.knobs)}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Tasks | ${m.taskCount} |`,
    `| Success rate | ${pct(m.successRate)} |`,
    `| Tokens median | ${m.tokenMedian} |`,
    `| Tokens p95 | ${m.tokenP95} |`,
    `| Attempts median | ${m.attemptsMedian} |`,
    `| First-try-correct rate | ${pct(m.firstTryCorrectRate)} |`,
    `| Total tokens | ${m.totalTokens} |`,
    '',
    '## Tasks',
    '',
    '| Task | Success | Attempts | First-try | Tokens |',
    '|---|---|---|---|---|',
    ...r.tasks.map((t) => `| ${t.taskId} | ${t.success ? 'yes' : 'no'} | ${t.attempts} | ${t.firstTryCorrect ? 'yes' : 'no'} | ${t.tokenCost} |`),
    '',
  ]
  return lines.join('\n')
}
