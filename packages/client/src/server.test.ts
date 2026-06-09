import { describe, it, expect } from 'vitest'
import type { Decision, LifecycleEvent, RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { handleConsultRequest, handleRequest, type EngineLikeServer } from './server.js'

const ranked: Decision = {
  mode: 'ranked',
  ranked: [{ capabilityId: 'tool:a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }],
}

describe('handleConsultRequest (EPIC-04 FEAT-04-08)', () => {
  it('wraps a successful consult as { ok: true, decision }', async () => {
    const engine = { consult: async () => ranked }
    const res = await handleConsultRequest(engine, { type: 'consult', input: { task_id: 't', context: 'x' } })
    expect(res).toEqual({ ok: true, decision: ranked })
  })

  it('wraps a thrown engine error as { ok: false } with the message (never crashes the connection)', async () => {
    const engine = {
      consult: async () => {
        throw new Error('engine boom')
      },
    }
    const res = await handleConsultRequest(engine, { type: 'consult', input: { task_id: 't', context: 'x' } })
    expect(res).toEqual({ ok: false, error: 'engine boom' })
  })

  it('rejects a non-consult request rather than passing a wrong-shaped input to consult (review w4pg93b97)', async () => {
    const engine = { consult: async () => ranked }
    const res = await handleConsultRequest(engine, { type: 'register', input: { id: 'x', type: 'tool', description: 'd' } } as never)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/expected a consult request/)
  })

  it('stringifies a non-Error throw in the error field', async () => {
    const engine = {
      consult: async () => {
        throw 'plain string failure' // eslint-disable-line no-throw-literal
      },
    }
    const res = await handleConsultRequest(engine, { type: 'consult', input: { task_id: 't', context: 'x' } })
    expect(res).toEqual({ ok: false, error: 'plain string failure' })
  })
})

describe('handleRequest dispatch (EPIC-04 FEAT-04-09)', () => {
  function makeEngine(over: Partial<EngineLikeServer> = {}): { engine: EngineLikeServer; emitted: LifecycleEvent[]; registered: RegisterCapabilityInput[] } {
    const emitted: LifecycleEvent[] = []
    const registered: RegisterCapabilityInput[] = []
    const engine: EngineLikeServer = {
      consult: async () => ranked,
      emit: async (e) => void emitted.push(e),
      registerCapability: async (i) => void registered.push(i),
      isEnabled: async () => true,
      ...over,
    }
    return { engine, emitted, registered }
  }

  it('dispatches consult to engine.consult', async () => {
    const { engine } = makeEngine()
    const res = await handleRequest(engine, { type: 'consult', input: { task_id: 't', context: 'x' } })
    expect(res).toEqual({ ok: true, decision: ranked })
  })

  it('dispatches emit to engine.emit and returns { ok: true }', async () => {
    const { engine, emitted } = makeEngine()
    const event: LifecycleEvent = { type: 'task_started', taskId: 't', context: 'x' }
    const res = await handleRequest(engine, { type: 'emit', event })
    expect(res).toEqual({ ok: true })
    expect(emitted).toEqual([event])
  })

  it('dispatches register to engine.registerCapability and returns { ok: true } (no Capability on the wire)', async () => {
    const { engine, registered } = makeEngine()
    const input: RegisterCapabilityInput = { id: 'tool:a', type: 'tool', description: 'alpha' }
    const res = await handleRequest(engine, { type: 'register', input })
    expect(res).toEqual({ ok: true })
    expect(registered).toEqual([input])
  })

  it('wraps a thrown engine error from any handler as { ok: false }', async () => {
    const { engine } = makeEngine({
      emit: async () => {
        throw new Error('deposit boom')
      },
    })
    const res = await handleRequest(engine, { type: 'emit', event: { type: 'response_delivered', taskId: 't' } })
    expect(res).toEqual({ ok: false, error: 'deposit boom' })
  })

  it('returns { ok: false } for an unknown request type rather than throwing', async () => {
    const { engine } = makeEngine()
    const res = await handleRequest(engine, { type: 'bogus' } as never)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/unknown request type/)
  })

  it('answers isEnabled with the engine flag and ping with ok (FEAT-04-09)', async () => {
    const off = makeEngine({ isEnabled: async () => false })
    const res = await handleRequest(off.engine, { type: 'isEnabled' })
    expect(res).toEqual({ ok: true, enabled: false })
    const on = makeEngine({ isEnabled: async () => true })
    expect(await handleRequest(on.engine, { type: 'isEnabled' })).toEqual({ ok: true, enabled: true })
    expect(await handleRequest(on.engine, { type: 'ping' })).toEqual({ ok: true })
  })
})
