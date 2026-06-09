import { describe, it, expect } from 'vitest'
import { FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { runVariant, runWorkload, depositPath, type RunnerDeps, type Variant } from './runner.js'
import type { Workload } from './workload.js'

const T0 = 1_700_000_000_000

const workload: Workload = {
  id: 'wl-runner',
  version: '1.0',
  capabilities: [
    { id: 'tool:alpha', type: 'tool', description: 'alpha report builder', defTokens: 300 },
    { id: 'tool:beta', type: 'tool', description: 'beta search query', defTokens: 300 },
    { id: 'tool:gamma', type: 'tool', description: 'gamma format markdown', defTokens: 300 },
  ],
  tasks: Array.from({ length: 4 }, (_, i) => ({
    id: `t${i + 1}`,
    context: 'alpha report builder',
    expectedCapabilityClasses: ['build'],
    oracle: 'tool:alpha',
    successCriteria: ['report produced'],
    tokenBudget: 5000,
  })),
}

function deps(): RunnerDeps {
  return {
    makeStorage: () => createSqlJsStorage(),
    makeEmbedding: () => new FakeEmbedding(),
    makeClock: () => new FixedClock(T0),
  }
}

const baseline: Variant = { name: 'baseline', knobs: {}, learn: false } // all candidates, no learning
const treatment: Variant = { name: 'treatment', knobs: {}, topK: 2, learn: true }

describe('runVariant determinism (SC-01)', () => {
  it('two runs with the same seed and workload are bit-identical', async () => {
    const a = await runVariant(workload, treatment, 7, deps())
    const b = await runVariant(workload, treatment, 7, deps())
    expect(a).toEqual(b)
  })
})

describe('treatment vs baseline token cost (H1 mechanic)', () => {
  it('treatment surfaces fewer definitions, so it costs fewer tokens than the static baseline', async () => {
    const [base, treat] = await runWorkload(workload, [baseline, treatment], 7, deps())
    const sum = (r: { tasks: { tokenCost: number }[] }) => r.tasks.reduce((s, t) => s + t.tokenCost, 0)
    expect(treat).toBeDefined()
    expect(base).toBeDefined()
    expect(sum(treat!)).toBeLessThan(sum(base!))
  })

  it('the static baseline surfaces the whole pool, so each task carries all definition tokens', async () => {
    const base = await runVariant(workload, baseline, 7, deps())
    const allDefs = workload.capabilities.reduce((s, c) => s + c.defTokens, 0) // 900
    for (const t of base.tasks) expect(t.tokenCost).toBeGreaterThanOrEqual(allDefs)
  })

  it('every task result is well-formed', async () => {
    const treat = await runVariant(workload, treatment, 7, deps())
    expect(treat.tasks).toHaveLength(4)
    for (const t of treat.tasks) {
      expect(t.attempts).toBeGreaterThanOrEqual(1)
      expect(t.tokenCost).toBeGreaterThan(0)
    }
  })
})

describe('depositPath (AUDIT: deposit the real trail, never a synthetic oracle)', () => {
  it('returns the actual invoked trail', () => {
    expect(depositPath(['tool:wrong', 'tool:alpha'])).toEqual(['tool:wrong', 'tool:alpha'])
  })
  it('returns null for an empty trail so no fabricated edge is deposited', () => {
    expect(depositPath([])).toBeNull()
  })
})

describe('topK guard (AUDIT: topK=0 yields a vacuous run)', () => {
  it('rejects a topK below 1', async () => {
    await expect(runVariant(workload, { name: 'bad', knobs: {}, topK: 0 }, 7, deps())).rejects.toThrow(/topK must be a positive integer/)
  })
})

describe('ablation comparison (SC-03 mechanic)', () => {
  it('decay-on vs decay-off run reproducibly so the comparison is decidable', async () => {
    const decayOn: Variant = { name: 'decay-on', knobs: { decay: true }, topK: 2, learn: true }
    const decayOff: Variant = { name: 'decay-off', knobs: { decay: false }, topK: 2, learn: true }
    const r1 = await runWorkload(workload, [decayOn, decayOff], 7, deps())
    const r2 = await runWorkload(workload, [decayOn, decayOff], 7, deps())
    expect(r1).toEqual(r2) // the ablation comparison is bit-identical across runs
    expect(r1[0]!.tasks).toHaveLength(4)
    expect(r1[1]!.tasks).toHaveLength(4)
  })
})

describe('exploration policies end to end through the engine (FEAT-02-05)', () => {
  it('runs UCB and adaptive-epsilon variants reproducibly (exercises the engine recent-success window)', async () => {
    const ucb: Variant = { name: 'ucb', knobs: { selection: 'ucb' }, topK: 2, learn: true }
    const eps: Variant = { name: 'eps', knobs: { selection: 'adaptive-epsilon', explorationBudget: 0.5 }, topK: 2, learn: true }
    const r1 = await runWorkload(workload, [ucb, eps], 7, deps())
    const r2 = await runWorkload(workload, [ucb, eps], 7, deps())
    expect(r1).toEqual(r2) // both policies are deterministic through the full engine path
    expect(r1[0]!.tasks).toHaveLength(4)
    expect(r1[1]!.tasks).toHaveLength(4)
  })
})
