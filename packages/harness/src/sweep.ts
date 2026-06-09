// Sweep: run several variants over one workload in a single call and return a report
// per variant (FEAT-02-03 SC-04, Story 4). Pure orchestration over the runner; disk
// writes live in the CLI so this stays deterministic and testable.
import type { WorkloadWithHash } from './workload.js'
import type { Variant, RunnerDeps } from './runner.js'
import { runVariant } from './runner.js'
import { buildReport, type Report } from './report.js'

export async function runSweep(
  w: WorkloadWithHash,
  variants: Variant[],
  seed: number,
  deps: RunnerDeps,
): Promise<Report[]> {
  const reports: Report[] = []
  for (const v of variants) {
    const result = await runVariant(w.workload, v, seed, deps)
    reports.push(buildReport(w, v, seed, result))
  }
  return reports
}
