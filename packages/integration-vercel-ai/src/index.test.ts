import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import type { StigmergyEngine } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { createVercelIntegration } from './index.js'

const T0 = 1_700_000_000_000
async function makeEngine(): Promise<StigmergyEngine> {
  const engine = await createEngine({ storage: await createSqlJsStorage(), embedding: new FakeEmbedding(), clock: new FixedClock(T0) })
  await engine.setRuntimeFlag('enabled', '1') // the loop facade is gated; enable for the integration tests (FEAT-04-06)
  return engine
}
async function startPheromone(engine: StigmergyEngine, cap: string, context: string): Promise<number> {
  const d = await engine.consult({ task_id: `p-${cap}`, context, candidate_ids: [cap] })
  return d.mode === 'ranked' && d.ranked[0] ? d.ranked[0].components.pheromone : 0
}

describe('Vercel AI integration', () => {
  it('with narrow:true returns the filtered activeTools and instrumented tools learn on accept', async () => {
    const engine = await makeEngine()
    for (const id of ['tool:a', 'tool:b', 'tool:c']) {
      await engine.registerCapability({ id, type: 'tool', description: `${id} helper` })
    }
    const sx = createVercelIntegration(engine, {
      taskId: 't1',
      context: 'tool:a helper',
      candidateIds: ['tool:a', 'tool:b', 'tool:c'],
      topK: 2,
      narrow: true, // opt in to narrowing (IMP-04-09-03); the default keeps all tools active
    })

    const step = await sx.prepareStep()
    expect(step.activeTools).toHaveLength(2) // proactive pre-filter (opt-in)
    expect(step.activeTools).toContain('tool:a')

    let called = false
    const tools = sx.wrapTools({ 'tool:a': { execute: async () => ((called = true), 'A') } })
    await tools['tool:a']!.execute!()
    expect(called).toBe(true)

    await sx.end()
    await sx.accept(500)
    expect((await engine.stats()).tasks).toBe(1)
    expect(await startPheromone(engine, 'tool:a', 'tool:a helper')).toBeGreaterThan(0.05)
    await engine.close()
  })

  it('shares one consult across concurrent prepareStep calls (AUDIT F-12 race)', async () => {
    let consults = 0
    const engine = {
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => {
        consults++
        return { mode: 'ranked', ranked: [{ capabilityId: 'tool:a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] }
      },
    } as unknown as StigmergyEngine
    const sx = createVercelIntegration(engine, { taskId: 't1', context: 'x', candidateIds: ['tool:a'] })
    await Promise.all([sx.prepareStep(), sx.prepareStep(), sx.prepareStep()])
    expect(consults).toBe(1)
  })

  it('emits nothing and runs tools unwrapped when the turn is disabled (review w4pg93b97)', async () => {
    const events: string[] = []
    const engine = {
      isEnabled: async () => false,
      emit: async (e: { type: string }) => void events.push(e.type),
      consult: async () => ({ mode: 'ranked', ranked: [] }),
    } as unknown as StigmergyEngine
    const sx = createVercelIntegration(engine, { taskId: 't1', context: 'x', candidateIds: ['tool:a'], narrow: true })
    const step = await sx.prepareStep()
    expect(step.activeTools).toEqual([]) // disabled -> nothing surfaced (even with narrow:true)

    let called = false
    const tools = sx.wrapTools({ 'tool:a': { execute: async () => ((called = true), 'A') } })
    await tools['tool:a']!.execute!()
    expect(called).toBe(true) // the tool still runs

    await sx.end()
    await sx.accept(500)
    await sx.iterate('x2')
    await sx.abandon()
    expect(events).toEqual([]) // no lifecycle events leaked on a disabled turn
  })

  it('by default keeps all tools active (no activeTools) and exposes path guidance (IMP-04-09-03)', async () => {
    const engine = {
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => ({ mode: 'sequence', nextCapability: 'tool:a', parameters: {}, remainingPath: ['tool:b'] }),
    } as unknown as StigmergyEngine
    const sx = createVercelIntegration(engine, { taskId: 't1', context: 'x', candidateIds: ['tool:a', 'tool:b'] })
    const step = await sx.prepareStep()
    expect(step.activeTools).toBeUndefined() // default: nothing narrowed, every tool stays active
    const g = await sx.pathGuidance()
    expect(g.path).toEqual(['tool:a', 'tool:b'])
    expect(g.text.length).toBeGreaterThan(0)
  })

  it('prepareStep is idempotent (one consult per turn)', async () => {
    const engine = await makeEngine()
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a helper' })
    const sx = createVercelIntegration(engine, { taskId: 't1', context: 'a helper', candidateIds: ['tool:a'] })
    const s1 = await sx.prepareStep()
    const s2 = await sx.prepareStep()
    expect(s2.activeTools).toEqual(s1.activeTools)
    expect((await engine.stats()).tasks).toBe(0) // no resolution yet
    await engine.close()
  })
})
