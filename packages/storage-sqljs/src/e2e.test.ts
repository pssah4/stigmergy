import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from './index.js'

// End-to-end proof of the whole embedded stack on the real sql.js adapter: createEngine wires
// storage plus embedding, a foraging loop (consult -> lifecycle events -> deposit) runs, and the
// substrate learns (an accepted path's pheromone rises on later consults). Deterministic via
// FakeEmbedding plus FixedClock; the real embedding adapter is verified separately (env-gated).
describe('end-to-end foraging loop (engine + sql.js + FakeEmbedding)', () => {
  it('reinforces an accepted capability so its pheromone rises on the next consult', async () => {
    const engine = await createEngine({
      storage: await createSqlJsStorage(),
      embedding: new FakeEmbedding(),
      clock: new FixedClock(1_700_000_000_000),
    })
    await engine.registerCapability({
      id: 'tool:summarize',
      type: 'tool',
      description: 'summarize long documents into key points',
    })
    await engine.registerCapability({
      id: 'tool:translate',
      type: 'tool',
      description: 'translate text between languages',
    })
    const context = 'summarize this report into bullet points'

    const before = await engine.consult({ task_id: 'q0', context, candidate_ids: ['tool:summarize'] })
    const phBefore = before.mode === 'ranked' ? before.ranked[0]!.components.pheromone : 0
    expect(phBefore).toBeCloseTo(0.05, 5) // floor: no edge learned yet

    for (let i = 1; i <= 3; i++) {
      const id = `t${i}`
      await engine.emit({ type: 'task_started', taskId: id, context })
      await engine.emit({ type: 'capability_loaded', taskId: id, capabilityId: 'tool:summarize' })
      await engine.emit({ type: 'capability_invoked', taskId: id, capabilityId: 'tool:summarize' })
      await engine.emit({ type: 'capability_returned', taskId: id, capabilityId: 'tool:summarize', success: true })
      await engine.emit({ type: 'response_delivered', taskId: id })
      await engine.emit({ type: 'task_accepted', taskId: id, tokenCost: 800 })
    }

    const after = await engine.consult({ task_id: 'q1', context, candidate_ids: ['tool:summarize'] })
    const phAfter = after.mode === 'ranked' ? after.ranked[0]!.components.pheromone : 0
    expect(phAfter).toBeGreaterThan(phBefore)

    const stats = await engine.stats()
    expect(stats.tasks).toBe(3)
    expect(stats.edges).toBe(1)
    await engine.close()
  })

  it('ranks a reinforced capability ahead of an un-reinforced peer for the same context', async () => {
    const engine = await createEngine({
      storage: await createSqlJsStorage(),
      embedding: new FakeEmbedding(),
      clock: new FixedClock(1_700_000_000_000),
      config: { score: { alpha: 1, beta: 2, etaFloor: 0.05, q0: 1 } }, // exploit for a deterministic order
    })
    // two capabilities with identical similarity to the context: only learning can break the tie
    await engine.registerCapability({ id: 'tool:alpha', type: 'tool', description: 'alpha beta gamma' })
    await engine.registerCapability({ id: 'tool:omega', type: 'tool', description: 'alpha beta gamma' })
    const context = 'alpha beta gamma'

    for (let i = 1; i <= 4; i++) {
      const id = `r${i}`
      await engine.emit({ type: 'task_started', taskId: id, context })
      await engine.emit({ type: 'capability_loaded', taskId: id, capabilityId: 'tool:alpha' })
      await engine.emit({ type: 'capability_invoked', taskId: id, capabilityId: 'tool:alpha' })
      await engine.emit({ type: 'capability_returned', taskId: id, capabilityId: 'tool:alpha', success: true })
      await engine.emit({ type: 'response_delivered', taskId: id })
      await engine.emit({ type: 'task_accepted', taskId: id, tokenCost: 500 })
    }

    const d = await engine.consult({ task_id: 'q', context, top_k: 2 })
    expect(d.mode).toBe('ranked')
    if (d.mode === 'ranked') {
      expect(d.ranked[0]!.capabilityId).toBe('tool:alpha') // the reinforced edge tilts the tie
    }
    await engine.close()
  })
})
