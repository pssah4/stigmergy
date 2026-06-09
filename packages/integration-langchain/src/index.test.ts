import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import type { StigmergyEngine } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { createLangchainIntegration } from './index.js'

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

describe('LangChain integration', () => {
  it('with narrow:true drops the request tools to the surfaced set', async () => {
    const engine = await makeEngine()
    for (const id of ['tool:a', 'tool:b', 'tool:c']) {
      await engine.registerCapability({ id, type: 'tool', description: `${id} helper` })
    }
    const sx = createLangchainIntegration(engine, { taskId: 't1', context: 'tool:a helper', topK: 2, narrow: true })

    const request = { tools: [{ name: 'tool:a' }, { name: 'tool:b' }, { name: 'tool:c' }], temperature: 0 }
    let seen: readonly { name?: string }[] = []
    const res = await sx.wrapModelCall(request, async (req) => {
      seen = req.tools ?? []
      return 'model-response'
    })
    expect(res).toBe('model-response')
    expect(seen).toHaveLength(2) // narrowed to the surfaced set (opt-in)
    expect(seen.map((t) => t.name)).toContain('tool:a')

    const run = sx.instrument('tool:a', async () => 'A')
    await run()
    await sx.end()
    await sx.accept(500)
    expect((await engine.stats()).tasks).toBe(1)
    expect(await startPheromone(engine, 'tool:a', 'tool:a helper')).toBeGreaterThan(0.05)
    await engine.close()
  })

  it('by default passes the request through UNCHANGED: no reorder, no narrow (IMP-04-10-03)', async () => {
    const engine = await makeEngine()
    for (const id of ['tool:a', 'tool:b', 'tool:c']) {
      await engine.registerCapability({ id, type: 'tool', description: `${id} helper` })
    }
    const sx = createLangchainIntegration(engine, { taskId: 't1', context: 'tool:a helper', topK: 2 })
    let seen: readonly { name?: string }[] = []
    await sx.wrapModelCall({ tools: [{ name: 'tool:b' }, { name: 'tool:c' }, { name: 'tool:a' }] }, async (req) => {
      seen = req.tools ?? []
      return 'ok'
    })
    // Stigmergy is recall, not a second selector (ADR-26): the tool set and order are the host's, untouched.
    expect(seen.map((t) => t.name)).toEqual(['tool:b', 'tool:c', 'tool:a'])
    await engine.close()
  })

  it('exposes the learned path as guidance for a sequence decision (IMP-04-09-03)', async () => {
    const engine = {
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => ({ mode: 'sequence', nextCapability: 'tool:a', parameters: {}, remainingPath: ['tool:b'] }),
    } as unknown as StigmergyEngine
    const sx = createLangchainIntegration(engine, { taskId: 't1', context: 'x', candidateIds: ['tool:a', 'tool:b'] })
    const g = await sx.pathGuidance()
    expect(g.path).toEqual(['tool:a', 'tool:b'])
    expect(g.text.length).toBeGreaterThan(0)
  })

  it('passes the request through unchanged when nothing is surfaced (fail open, AUDIT F-21)', async () => {
    const engine = await makeEngine() // no capabilities registered -> consult surfaces nothing
    const sx = createLangchainIntegration(engine, { taskId: 't1', context: 'x' })
    let seen: readonly { name?: string }[] = []
    await sx.wrapModelCall({ tools: [{ name: 'tool:x' }, { name: 'tool:y' }] }, async (req) => {
      seen = req.tools ?? []
      return 'ok'
    })
    expect(seen).toHaveLength(2) // not stripped to zero
    await engine.close()
  })

  it('instrument rethrows and records a failure when the tool throws', async () => {
    const engine = await makeEngine()
    await engine.registerCapability({ id: 'tool:x', type: 'tool', description: 'flaky' })
    const sx = createLangchainIntegration(engine, { taskId: 't1', context: 'flaky', candidateIds: ['tool:x'] })
    await sx.wrapModelCall({ tools: [{ name: 'tool:x' }] }, async () => 'ok')
    const run = sx.instrument('tool:x', async () => {
      throw new Error('boom')
    })
    await expect(run()).rejects.toThrow('boom')
    await engine.close()
  })
})
