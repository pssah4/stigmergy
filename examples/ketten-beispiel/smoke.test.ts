// Smoke test for the Ketten-Beispiel (FEAT-04-05): runs the same chain as run.mjs against an
// in-memory sql.js substrate (deterministic, offline, no native ABI) and asserts the substrate
// filled and learning is reflected in consult. This locks the end-to-end chain in CI; run.mjs is
// the user-facing demo against a real file.
import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { StigmergyLoop } from '@agentic-stigmergy/loop'

describe('Ketten-Beispiel end-to-end (EPIC-04 FEAT-04-05)', () => {
  it('registers tools, runs turns through the loop, and the substrate reflects the learning', async () => {
    const engine = await createEngine({ storage: await createSqlJsStorage(), embedding: new FakeEmbedding() })
    await engine.setRuntimeFlag('enabled', '1') // wired-but-off by default; the demo turns it on

    const tools = ['tool:read_file', 'tool:summarize', 'tool:write_note', 'tool:search']
    for (const id of tools) await engine.registerCapability({ id, type: 'tool', description: id })

    const loop = new StigmergyLoop(engine)
    const turns = [
      { context: 'read and summarize a file', used: ['tool:read_file', 'tool:summarize'] },
      { context: 'read and summarize a file', used: ['tool:read_file', 'tool:summarize'] },
      { context: 'search the web and write a note', used: ['tool:search', 'tool:write_note'] },
    ]
    let n = 0
    for (const turn of turns) {
      const handle = await loop.beginTurn({ task_id: `task-${n++}`, prompt: turn.context, candidate_ids: tools })
      for (const tool of handle.instrument(turn.used.map((id) => ({ id, run: async () => 'ok' })))) await tool.run()
      await handle.end()
      await handle.accept(500)
    }

    const stats = await engine.stats()
    expect(stats.tasks).toBe(3)
    expect(stats.edges).toBeGreaterThan(0)
    expect(stats.avgPheromone).toBeGreaterThan(0.05) // reinforcement raised the trail above the floor

    // the twice-reinforced read_file should outrank the never-used write_note for its own context
    const d = await engine.consult({ task_id: 'probe', context: 'read and summarize a file', candidate_ids: tools })
    expect(d.mode).toBe('ranked')
    if (d.mode === 'ranked') {
      const rank = (id: string): number => d.ranked.findIndex((r) => r.capabilityId === id)
      expect(rank('tool:read_file')).toBeLessThan(rank('tool:write_note'))
    }
    await engine.close()
  })

  it('records nothing while disabled (the toggle gates the chain, FEAT-04-06)', async () => {
    const engine = await createEngine({ storage: await createSqlJsStorage(), embedding: new FakeEmbedding() })
    // default-disabled: do not enable
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    const loop = new StigmergyLoop(engine)
    const handle = await loop.beginTurn({ task_id: 't', prompt: 'alpha', candidate_ids: ['tool:a'] })
    for (const tool of handle.instrument([{ id: 'tool:a', run: async () => 'ok' }])) await tool.run()
    await handle.end()
    await handle.accept(500)
    expect((await engine.stats()).tasks).toBe(0) // disabled -> the chain is inert
    await engine.close()
  })
})
