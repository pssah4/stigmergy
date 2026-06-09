import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { executeRunConfig } from './cli.js'
import type { RunnerDeps } from './runner.js'

const T0 = 1_700_000_000_000

function deps(): RunnerDeps {
  return {
    makeStorage: () => createSqlJsStorage(),
    makeEmbedding: () => new FakeEmbedding(),
    makeClock: () => new FixedClock(T0),
  }
}

const workload = {
  id: 'wl-cli',
  version: '1.0',
  capabilities: [
    { id: 'tool:search', type: 'tool', description: 'search the vault for notes', defTokens: 500 },
    { id: 'tool:read', type: 'tool', description: 'read the contents of a note', defTokens: 500 },
    { id: 'tool:write', type: 'tool', description: 'write a new note to the vault', defTokens: 500 },
  ],
  tasks: [
    { id: 't1', context: 'search the vault for notes', expectedCapabilityClasses: ['search'], oracle: 'tool:search', successCriteria: [], tokenBudget: 4000 },
    { id: 't2', context: 'read the contents of a note', expectedCapabilityClasses: ['read'], oracle: 'tool:read', successCriteria: [], tokenBudget: 4000 },
    { id: 't3', context: 'write a new note to the vault', expectedCapabilityClasses: ['write'], oracle: 'tool:write', successCriteria: [], tokenBudget: 4000 },
  ],
}

const runConfig = {
  workloadFile: 'wl.json',
  seed: 7,
  variants: [
    { name: 'baseline', knobs: {}, learn: false },
    { name: 'treatment', knobs: {}, topK: 2, learn: true },
  ],
}

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-cli-'))
  await writeFile(join(dir, 'wl.json'), JSON.stringify(workload), 'utf8')
  await writeFile(join(dir, 'run.json'), JSON.stringify(runConfig), 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('executeRunConfig (SC-04 config-driven, SC-01 determinism, SC-05/06 reports)', () => {
  it('runs the config, writes JSON+MD per variant plus a diff, and is reproducible', async () => {
    const a = await executeRunConfig(join(dir, 'run.json'), deps(), join(dir, 'out-a'), '20260530T000000Z')
    const b = await executeRunConfig(join(dir, 'run.json'), deps(), join(dir, 'out-b'), '20260530T000000Z')

    expect(a.reports).toEqual(b.reports) // SC-01: same seed/workload/deps -> identical reports
    expect(a.reports).toHaveLength(2)
    expect(a.diff).toBeDefined()

    expect(a.written.filter((p) => p.endsWith('.json'))).toHaveLength(2) // SC-06
    expect(a.written.filter((p) => p.endsWith('.md'))).toHaveLength(3) // 2 reports + 1 diff

    const jsonPath = a.written.find((p) => p.endsWith('.json'))!
    const onDisk = JSON.parse(await readFile(jsonPath, 'utf8')) as { workload: { hash: string } }
    expect(onDisk.workload.hash).toMatch(/^[0-9a-f]{64}$/) // SC-05: content hash anchored

    expect(a.diff!.tokenReductionPct).toBeGreaterThan(0) // H1 mechanic: treatment surfaces fewer definitions
    // Note: successRateDelta is NOT asserted >= 0 here. On a cold substrate aggressive
    // top_k filtering can drop the oracle and regress success vs the all-visible baseline.
    // That is a real finding for the H1 experiment (warm-up or adequate top_k matters),
    // surfaced by the harness; the no-regression half of H1 is decided on a real run (SC-02).
    expect(typeof a.diff!.successRateDelta).toBe('number')
  })

  it('rejects a report-path collision between case-folding variant names (AUDIT)', async () => {
    const cfg = { workloadFile: 'wl.json', seed: 7, variants: [{ name: 'base', knobs: {}, learn: false }, { name: 'Base', knobs: {}, learn: false }] }
    await writeFile(join(dir, 'run-collide.json'), JSON.stringify(cfg), 'utf8')
    await expect(executeRunConfig(join(dir, 'run-collide.json'), deps(), join(dir, 'out-collide'), 'stamp')).rejects.toThrow(/collision/)
  })

  it('rejects an output path that escapes outDir via a traversing stamp (CWE-22, SEC L-1)', async () => {
    await expect(executeRunConfig(join(dir, 'run.json'), deps(), join(dir, 'out-x'), '../escape')).rejects.toThrow(/escapes the output directory/)
  })
})
