import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import type { StigmergyEngine } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { createOpenAIAgentsIntegration } from './index.js'

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

describe('OpenAI Agents integration', () => {
  it('with narrow:true isEnabled reflects the surfaced set after prime, and tool hooks learn on accept', async () => {
    const engine = await makeEngine()
    for (const id of ['tool:a', 'tool:b', 'tool:c']) {
      await engine.registerCapability({ id, type: 'tool', description: `${id} helper` })
    }
    const sx = createOpenAIAgentsIntegration(engine, {
      taskId: 't1',
      context: 'tool:a helper',
      candidateIds: ['tool:a', 'tool:b', 'tool:c'],
      topK: 2,
      narrow: true, // opt in to gating (IMP-04-09-03); the default enables every tool
    })

    expect(sx.isEnabled('tool:a')).toBe(false) // not primed yet: closed under narrow
    await sx.prime()
    expect(sx.isEnabled('tool:a')).toBe(true) // the clear best match is surfaced
    const enabled = ['tool:a', 'tool:b', 'tool:c'].filter((id) => sx.isEnabled(id))
    expect(enabled).toHaveLength(2) // top_k = 2: exactly two are surfaced, one is filtered out

    await sx.onToolStart('tool:a')
    await sx.onToolEnd('tool:a', true)
    await sx.end()
    await sx.accept(500)

    expect((await engine.stats()).tasks).toBe(1)
    expect(await startPheromone(engine, 'tool:a', 'tool:a helper')).toBeGreaterThan(0.05)
    await engine.close()
  })

  it('by default enables every tool (no gating) and exposes path guidance (IMP-04-09-03)', async () => {
    const engine = {
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => ({ mode: 'sequence', nextCapability: 'tool:a', parameters: {}, remainingPath: ['tool:b'] }),
    } as unknown as StigmergyEngine
    const sx = createOpenAIAgentsIntegration(engine, { taskId: 't1', context: 'x', candidateIds: ['tool:a', 'tool:b'] })
    expect(sx.isEnabled('tool:a')).toBe(true) // default: enabled even before prime
    expect(sx.isEnabled('tool:zzz')).toBe(true) // and even for a tool that would not be surfaced
    const g = await sx.pathGuidance()
    expect(g.path).toEqual(['tool:a', 'tool:b'])
    expect(g.text.length).toBeGreaterThan(0)
  })

  it('onToolEnd with success=false records a failure', async () => {
    const engine = await makeEngine()
    await engine.registerCapability({ id: 'tool:x', type: 'tool', description: 'flaky' })
    const sx = createOpenAIAgentsIntegration(engine, { taskId: 't1', context: 'flaky', candidateIds: ['tool:x'] })
    await sx.prime()
    expect(sx.isEnabled('tool:x')).toBe(true)
    await sx.onToolStart('tool:x')
    await sx.onToolEnd('tool:x', false)
    await sx.end()
    await sx.accept(500)
    expect((await engine.stats()).edges).toBe(1)
    await engine.close()
  })

  it('onToolStart/onToolEnd never throw when the daemon rejects mid-turn (FIX-02-08-01)', async () => {
    // Enabled at prime time, then the daemon rejects every emit (socket dropped mid-turn). The host
    // hooks must degrade to a no-op, not propagate the rejection into the on_tool_start/end loop.
    const engine = {
      isEnabled: async () => true,
      consult: async () => ({ mode: 'ranked', ranked: [] }),
      emit: async () => {
        throw new Error('ECONNREFUSED mid-turn')
      },
    } as unknown as StigmergyEngine
    const sx = createOpenAIAgentsIntegration(engine, { taskId: 't', context: 'x', candidateIds: ['tool:a'] })
    await sx.prime() // succeeds: the hardened facade swallows the failing emits
    await expect(sx.onToolStart('tool:a')).resolves.toBeUndefined()
    await expect(sx.onToolEnd('tool:a', true)).resolves.toBeUndefined()
  })
})
