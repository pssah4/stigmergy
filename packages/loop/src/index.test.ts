import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import type { StigmergyEngine, LifecycleEvent } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { StigmergyLoop, TurnHandle, surfacedIds, orderBySurfaced, pathGuidanceFor, instrumentRun, safeEmit } from './index.js'

const T0 = 1_700_000_000_000

async function makeEngine(): Promise<StigmergyEngine> {
  const engine = await createEngine({
    storage: await createSqlJsStorage(),
    embedding: new FakeEmbedding(),
    clock: new FixedClock(T0),
  })
  // The facade tests exercise the enabled path; Stigmergy is disabled by default (FEAT-04-06).
  await engine.setRuntimeFlag('enabled', '1')
  return engine
}

/** Pheromone of the START -> cap edge, read via a probe consult. */
async function startPheromone(engine: StigmergyEngine, cap: string, context: string): Promise<number> {
  const d = await engine.consult({ task_id: `probe-${cap}`, context, candidate_ids: [cap] })
  return d.mode === 'ranked' && d.ranked[0] ? d.ranked[0].components.pheromone : 0
}

/** Minimal recording engine to assert which lifecycle events the facade emits. */
function recordingEngine(): { engine: StigmergyEngine; events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = []
  const engine = { emit: async (e: LifecycleEvent) => void events.push(e) } as unknown as StigmergyEngine
  return { engine, events }
}

describe('surfacedIds', () => {
  it('returns the ranked ids for a ranked decision', () => {
    expect(
      surfacedIds({
        mode: 'ranked',
        ranked: [{ capabilityId: 'a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }],
      }),
    ).toEqual(['a'])
  })
  it('returns the next capability for a sequence decision', () => {
    expect(surfacedIds({ mode: 'sequence', nextCapability: 'a', parameters: {}, remainingPath: ['b'] })).toEqual(['a'])
  })
})

describe('orderBySurfaced (rank-all, IMP-04-09-02)', () => {
  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  it('orders tools by the surfaced ranking and keeps every tool (never hides)', () => {
    const out = orderBySurfaced(tools, ['c', 'a'], (t) => t.name)
    expect(out.map((t) => t.name)).toEqual(['c', 'a', 'b']) // ranked first, unranked appended in original order
    expect(out).toHaveLength(tools.length)
  })
  it('is a no-op (original order) when nothing is surfaced (cold / disabled turn)', () => {
    expect(orderBySurfaced(tools, [], (t) => t.name).map((t) => t.name)).toEqual(['a', 'b', 'c'])
  })
  it('is stable for tools that share the same surfaced rank (i.e. all unranked)', () => {
    const out = orderBySurfaced(tools, ['x', 'y'], (t) => t.name) // none match
    expect(out.map((t) => t.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('pathGuidanceFor (learned path as guidance, IMP-04-09-02)', () => {
  it('renders a sequence decision into a path plus an injectable guidance text', () => {
    const g = pathGuidanceFor({ mode: 'sequence', nextCapability: 'tool:a', parameters: {}, remainingPath: ['tool:b', 'tool:c'] })
    expect(g.path).toEqual(['tool:a', 'tool:b', 'tool:c'])
    expect(g.text).toContain('tool:a')
    expect(g.text).toContain('tool:c')
    expect(g.text.length).toBeGreaterThan(0)
  })
  it('includes capability descriptions when a describe callback is given', () => {
    const g = pathGuidanceFor(
      { mode: 'sequence', nextCapability: 'tool:a', parameters: {}, remainingPath: [] },
      (id) => (id === 'tool:a' ? 'alpha helper' : undefined),
    )
    expect(g.text).toContain('alpha helper')
  })
  it('returns empty for a ranked decision (no learned path for this task yet)', () => {
    const g = pathGuidanceFor({ mode: 'ranked', ranked: [{ capabilityId: 'a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] })
    expect(g.path).toEqual([])
    expect(g.text).toBe('')
  })
})

describe('TurnHandle.orderTools / pathGuidance (IMP-04-09-02)', () => {
  const { engine } = recordingEngine()
  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const seq = { mode: 'sequence' as const, nextCapability: 'tool:a', parameters: {}, remainingPath: ['tool:b'] }

  it('orderTools ranks the full set by surfaced when enabled', () => {
    const turn = new TurnHandle(engine, 't', { mode: 'ranked', ranked: [] }, ['c', 'a'])
    expect(turn.orderTools(tools, (t) => t.name).map((t) => t.name)).toEqual(['c', 'a', 'b'])
  })
  it('orderTools is a no-op (original order) on a disabled turn', () => {
    const turn = new TurnHandle(engine, 't', { mode: 'ranked', ranked: [] }, [], true)
    expect(turn.orderTools(tools, (t) => t.name).map((t) => t.name)).toEqual(['a', 'b', 'c'])
  })
  it('pathGuidance surfaces the learned path when enabled, and nothing when disabled', () => {
    const enabled = new TurnHandle(engine, 't', seq, ['tool:a'])
    expect(enabled.pathGuidance().path).toEqual(['tool:a', 'tool:b'])
    expect(enabled.pathGuidance().text.length).toBeGreaterThan(0)
    const disabled = new TurnHandle(engine, 't', seq, [], true)
    expect(disabled.pathGuidance()).toEqual({ path: [], text: '' })
  })
})

describe('TurnHandle.instrument emissions', () => {
  it('emits invoked then returned(success) around a successful tool call', async () => {
    const { engine, events } = recordingEngine()
    const turn = new TurnHandle(engine, 't1', { mode: 'ranked', ranked: [] }, [])
    const [tool] = turn.instrument([{ id: 'tool:x', run: async () => 'ok' }])
    await expect(tool!.run()).resolves.toBe('ok')
    expect(events).toEqual([
      { type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:x' },
      { type: 'capability_returned', taskId: 't1', capabilityId: 'tool:x', success: true },
    ])
  })

  it('emits returned(success=false) when the tool throws, and rethrows', async () => {
    const { engine, events } = recordingEngine()
    const turn = new TurnHandle(engine, 't1', { mode: 'ranked', ranked: [] }, [])
    const [tool] = turn.instrument([
      {
        id: 'tool:x',
        run: async () => {
          throw new Error('boom')
        },
      },
    ])
    await expect(tool!.run()).rejects.toThrow('boom')
    expect(events).toEqual([
      { type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:x' },
      { type: 'capability_returned', taskId: 't1', capabilityId: 'tool:x', success: false },
    ])
  })

  it('preserves the original tool error even if recording the failure rejects (AUDIT F-25)', async () => {
    const engine = {
      emit: async (e: LifecycleEvent) => {
        if (e.type === 'capability_returned' && e.success === false) throw new Error('emit-down')
      },
    } as unknown as StigmergyEngine
    const turn = new TurnHandle(engine, 't1', { mode: 'ranked', ranked: [] }, [])
    const [tool] = turn.instrument([
      {
        id: 'tool:x',
        run: async () => {
          throw new Error('boom')
        },
      },
    ])
    await expect(tool!.run()).rejects.toThrow('boom') // not 'emit-down'
  })
})

describe('StigmergyLoop facade (engine + sql.js + FakeEmbedding)', () => {
  it('surfaces a top_k-filtered set and learns when an instrumented tool is accepted', async () => {
    const engine = await makeEngine()
    const loop = new StigmergyLoop(engine)
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha task helper' })
    await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta task helper' })
    await engine.registerCapability({ id: 'tool:c', type: 'tool', description: 'gamma task helper' })

    let aCalls = 0
    const tools = [
      { id: 'tool:a', run: async () => { aCalls++; return 'A' } },
      { id: 'tool:b', run: async () => 'B' },
      { id: 'tool:c', run: async () => 'C' },
    ]

    const turn = await loop.beginTurn({
      task_id: 't1',
      prompt: 'alpha task helper',
      candidate_ids: ['tool:a', 'tool:b', 'tool:c'],
      top_k: 2,
    })
    expect(turn.surfaced).toHaveLength(2) // proactive pre-filtering: model sees only the top 2
    expect(turn.surfaced).toContain('tool:a')

    const wrapped = turn.instrument(tools)
    await wrapped.find((t) => t.id === 'tool:a')!.run()
    expect(aCalls).toBe(1)
    await turn.end()
    await turn.accept(500)

    expect((await engine.stats()).tasks).toBe(1)
    expect(await startPheromone(engine, 'tool:a', 'alpha task helper')).toBeGreaterThan(0.05)
    await engine.close()
  })

  it('records a surfaced-but-not-invoked capability as negative space', async () => {
    const engine = await makeEngine()
    const loop = new StigmergyLoop(engine)
    await engine.registerCapability({ id: 'tool:used', type: 'tool', description: 'shared context word' })
    await engine.registerCapability({ id: 'tool:shown', type: 'tool', description: 'shared context word' })

    const turn = await loop.beginTurn({
      task_id: 't1',
      prompt: 'shared context word',
      candidate_ids: ['tool:used', 'tool:shown'],
    })
    expect(turn.surfaced).toEqual(expect.arrayContaining(['tool:used', 'tool:shown']))

    const wrapped = turn.instrument([
      { id: 'tool:used', run: async () => 'ok' },
      { id: 'tool:shown', run: async () => 'ok' },
    ])
    await wrapped.find((t) => t.id === 'tool:used')!.run() // only tool:used is invoked
    await turn.end()
    await turn.accept(500)

    expect((await engine.stats()).edges).toBe(2) // START->used (success) and START->shown (discarded)
    expect(await startPheromone(engine, 'tool:used', 'shared context word')).toBeGreaterThan(0.05)
    expect(await startPheromone(engine, 'tool:shown', 'shared context word')).toBeCloseTo(0.05, 5)
    await engine.close()
  })

  it('does nothing when Stigmergy is disabled: no surfacing, no emits, tools pass through (FEAT-04-06 SC-05)', async () => {
    const engine = await makeEngine()
    await engine.setRuntimeFlag('enabled', '0') // disable (default is also disabled; this is explicit)
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    const loop = new StigmergyLoop(engine)

    const turn = await loop.beginTurn({ task_id: 't', prompt: 'alpha', candidate_ids: ['tool:a'] })
    expect(turn.surfaced).toEqual([]) // nothing surfaced
    expect(turn.decision).toEqual({ mode: 'ranked', ranked: [] })

    const [tool] = turn.instrument([{ id: 'tool:a', run: async () => 'ok' }])
    await expect(tool!.run()).resolves.toBe('ok') // unwrapped: runs but emits nothing
    await turn.end()
    await turn.accept(100)

    const stats = await engine.stats()
    expect(stats.tasks).toBe(0) // no learning deposit
    expect(stats.edges).toBe(0)
    await engine.close()
  })
})

describe('graceful degrade: the facade never throws into the host loop (FIX-02-08-01)', () => {
  const eng = (over: Partial<StigmergyEngine>): StigmergyEngine =>
    ({
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => ({ mode: 'ranked', ranked: [] }),
      ...over,
    }) as unknown as StigmergyEngine

  it('beginTurn returns a no-op turn when isEnabled() rejects (daemon down)', async () => {
    const loop = new StigmergyLoop(eng({ isEnabled: async () => { throw new Error('ECONNREFUSED') } }))
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn.enabled).toBe(false)
    expect(turn.surfaced).toEqual([])
    await expect(turn.end()).resolves.toBeUndefined()
    await expect(turn.accept(1)).resolves.toBeUndefined()
  })

  it('beginTurn does not throw when emit(task_started) rejects', async () => {
    const loop = new StigmergyLoop(eng({ emit: async () => { throw new Error('down') } }))
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn).toBeInstanceOf(TurnHandle)
  })

  it('beginTurn yields an empty surfaced set (no throw) when consult rejects', async () => {
    const loop = new StigmergyLoop(eng({ consult: async () => { throw new Error('boom') } }))
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn.surfaced).toEqual([])
  })

  it('beginTurn does not throw on a malformed decision (ranked without an array)', async () => {
    const loop = new StigmergyLoop(eng({ consult: async () => ({ mode: 'ranked' }) as never }))
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn.surfaced).toEqual([])
  })

  it('end/accept/iterate/abandon do not throw when emit rejects mid-turn', async () => {
    const turn = new TurnHandle(eng({ emit: async () => { throw new Error('down') } }), 't', { mode: 'ranked', ranked: [] }, [])
    await expect(turn.end()).resolves.toBeUndefined()
    await expect(turn.accept(1)).resolves.toBeUndefined()
    await expect(turn.iterate()).resolves.toBeUndefined()
    await expect(turn.abandon()).resolves.toBeUndefined()
  })

  it('instrumentRun runs the host tool and returns its value even if the leading invoked emit rejects', async () => {
    let ran = false
    const wrapped = instrumentRun(eng({ emit: async () => { throw new Error('down') } }), 't', 'tool:a', async () => {
      ran = true
      return 'RESULT'
    })
    await expect(wrapped()).resolves.toBe('RESULT')
    expect(ran).toBe(true)
  })

  it('surfacedIds and pathGuidanceFor are shape-defensive against a malformed decision', () => {
    expect(surfacedIds({ mode: 'ranked' } as never)).toEqual([])
    expect(surfacedIds({ mode: 'sequence' } as never)).toEqual([])
    expect(pathGuidanceFor({ mode: 'sequence' } as never)).toEqual({ path: [], text: '' })
  })
})

describe('graceful degrade: a slow/hanging engine is bounded by a timeout (FIX-02-08-02)', () => {
  // A promise that never settles: it stands in for a daemon that is reachable but stuck on a slow
  // (rate-limited) embedding. Promise<never> is assignable to every engine return type.
  const never = (): Promise<never> => new Promise<never>(() => {})
  const eng = (over: Partial<StigmergyEngine>): StigmergyEngine =>
    ({
      isEnabled: async () => true,
      emit: async () => {},
      consult: async () => ({ mode: 'ranked', ranked: [] }),
      ...over,
    }) as unknown as StigmergyEngine

  it('beginTurn does not hang when consult never resolves; it degrades to an empty decision', async () => {
    const loop = new StigmergyLoop(eng({ consult: () => never() }), { consultTimeoutMs: 30 })
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn.surfaced).toEqual([]) // consult timed out -> empty decision, the host runs its full set
    expect(turn.enabled).toBe(true) // isEnabled answered; only the consult was slow
  }, 2000)

  it('beginTurn does not hang when isEnabled never resolves; it degrades to a no-op turn', async () => {
    const loop = new StigmergyLoop(eng({ isEnabled: () => never() }), { gateTimeoutMs: 30 })
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['a'] })
    expect(turn.enabled).toBe(false) // a slow gate is treated as off, indistinguishable from disabled
  }, 2000)

  it('safeEmit resolves (swallow) within the timeout when emit never resolves', async () => {
    await expect(
      safeEmit(eng({ emit: () => never() }), { type: 'task_started', taskId: 't', context: 'x' }, 30),
    ).resolves.toBeUndefined()
  }, 2000)
})
