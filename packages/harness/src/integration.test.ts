import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { executeRunConfig } from './cli.js'
import { parseWorkload } from './workload.js'
import type { RunnerDeps } from './runner.js'

// End-to-end against the committed artifacts (not inline fixtures): the real run-config
// and the real v1 workload, driven through executeRunConfig with the deterministic deps.
// Guards that the shipped workload + run-config + harness reproduce the demo numbers.
const T0 = 1_700_000_000_000
const CONFIG = '_devprocess/metrics/run-h1-demo.json'
const WORKLOAD = '_devprocess/metrics/workloads/workload-synthetic-v1.json'

function deps(): RunnerDeps {
  return {
    makeStorage: () => createSqlJsStorage(),
    makeEmbedding: () => new FakeEmbedding(),
    makeClock: () => new FixedClock(T0),
  }
}

let dir: string

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('integration: committed v1 workload + run-config end to end', () => {
  it('reproduces the shipped demo deterministically, hash-anchored, with token reduction', async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-it-'))
    const a = await executeRunConfig(CONFIG, deps(), join(dir, 'a'), 'it')
    const b = await executeRunConfig(CONFIG, deps(), join(dir, 'b'), 'it')

    expect(a.reports).toEqual(b.reports) // SC-01 reproducibility against the real artifacts
    expect(a.reports.map((r) => r.variant.name)).toEqual(['baseline-static', 'treatment-stigmergy'])

    expect(a.diff).toBeDefined()
    expect(a.diff!.tokenReductionPct).toBeGreaterThan(0.4) // shipped demo is ~0.48

    const w = parseWorkload(readFileSync(WORKLOAD, 'utf8'))
    expect(a.reports[0]!.workload.id).toBe('workload-synthetic-v1')
    expect(a.reports[0]!.workload.hash).toBe(w.hash) // SC-05: report hash equals workload content hash
    expect(a.reports[0]!.workload.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
