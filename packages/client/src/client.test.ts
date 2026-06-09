import { describe, it, expect } from 'vitest'
import type { Decision, StigmergyEngine } from '@agentic-stigmergy/core'
import { createConsultClient, connectEngine, createRemoteEngine, type ConsultLike } from './client.js'
import type { RpcRequest, RpcResponse } from './protocol.js'

const remote: Decision = { mode: 'ranked', ranked: [{ capabilityId: 'remote', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] }
const localD: Decision = { mode: 'ranked', ranked: [{ capabilityId: 'local', score: 1, components: { pheromone: 0.5, similarity: 0, thompson: 1 } }] }
const localEngine: ConsultLike = { consult: async () => localD }

describe('createConsultClient (EPIC-04 FEAT-04-08)', () => {
  it('returns the daemon decision when the send succeeds', async () => {
    const c = createConsultClient(async () => ({ ok: true, decision: remote }), localEngine)
    expect(await c.consult({ task_id: 't', context: 'x' })).toBe(remote)
  })

  it('falls back to local when the send rejects (daemon down)', async () => {
    const c = createConsultClient(async () => {
      throw new Error('ECONNREFUSED')
    }, localEngine)
    expect(await c.consult({ task_id: 't', context: 'x' })).toBe(localD)
  })

  it('falls back to local on a server-side error response', async () => {
    const c = createConsultClient(async () => ({ ok: false, error: 'boom' }), localEngine)
    expect(await c.consult({ task_id: 't', context: 'x' })).toBe(localD)
  })
})

describe('connectEngine (EPIC-04 FEAT-04-08)', () => {
  it('routes consult to the daemon but delegates everything else to the local engine', async () => {
    const emitted: unknown[] = []
    const local = {
      consult: async () => localD,
      emit: async (e: unknown) => void emitted.push(e),
      isEnabled: async () => true,
    } as unknown as StigmergyEngine
    const engine = connectEngine(local, async () => ({ ok: true, decision: remote }))
    expect(await engine.consult({ task_id: 't', context: 'x' })).toBe(remote) // consult -> daemon
    await engine.emit({ type: 'task_started', taskId: 't', context: 'x' })
    expect(emitted).toHaveLength(1) // emit -> local
    expect(await engine.isEnabled()).toBe(true) // other methods -> local
  })
})

describe('createRemoteEngine (EPIC-04 FEAT-04-09, pure client, no local engine)', () => {
  it('returns the daemon decision for consult and forwards emit/register over the wire', async () => {
    const sent: RpcRequest[] = []
    const send = async (req: RpcRequest): Promise<RpcResponse> => {
      sent.push(req)
      if (req.type === 'consult') return { ok: true, decision: remote }
      return { ok: true }
    }
    const engine = createRemoteEngine(send)
    expect(await engine.consult({ task_id: 't', context: 'x', candidate_ids: ['tool:a'] })).toBe(remote)
    await engine.emit({ type: 'task_started', taskId: 't', context: 'x' })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    expect(sent.map((r) => r.type)).toEqual(['consult', 'emit', 'register'])
  })

  it('consult degrades to a passthrough of all candidates when the daemon is unreachable (no narrowing)', async () => {
    const engine = createRemoteEngine(async () => {
      throw new Error('ECONNREFUSED')
    })
    const d = await engine.consult({ task_id: 't', context: 'x', candidate_ids: ['tool:a', 'tool:b'] })
    expect(d.mode).toBe('ranked')
    if (d.mode === 'ranked') expect(d.ranked.map((r) => r.capabilityId)).toEqual(['tool:a', 'tool:b']) // all kept
  })

  it('consult degrades to passthrough on a server-side error response too', async () => {
    const engine = createRemoteEngine(async () => ({ ok: false, error: 'boom' }))
    const d = await engine.consult({ task_id: 't', context: 'x', candidate_ids: ['tool:a'] })
    if (d.mode === 'ranked') expect(d.ranked.map((r) => r.capabilityId)).toEqual(['tool:a'])
  })

  it('emit and registerCapability are best-effort no-ops when the daemon is down (host never breaks)', async () => {
    const engine = createRemoteEngine(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(engine.emit({ type: 'response_delivered', taskId: 't' })).resolves.toBeUndefined()
    await expect(engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a' })).resolves.toBeUndefined()
  })

  it('isEnabled reflects the daemon flag, and is false when the daemon is unreachable', async () => {
    expect(await createRemoteEngine(async () => ({ ok: true, enabled: true })).isEnabled()).toBe(true)
    expect(await createRemoteEngine(async () => ({ ok: true, enabled: false })).isEnabled()).toBe(false)
    expect(
      await createRemoteEngine(async () => {
        throw new Error('ECONNREFUSED')
      }).isEnabled(),
    ).toBe(false) // daemon down -> treated as off
  })

  it('ping is true when the daemon answers and false when it is down', async () => {
    expect(await createRemoteEngine(async () => ({ ok: true })).ping()).toBe(true)
    expect(
      await createRemoteEngine(async () => {
        throw new Error('ECONNREFUSED')
      }).ping(),
    ).toBe(false)
  })

  it('reports server-side { ok: false } errors via onError instead of swallowing them silently (review w4pg93b97)', async () => {
    const errors: Array<[string, string]> = []
    const engine = createRemoteEngine(
      async () => ({ ok: false, error: 'engine boom' }),
      (op, detail) => errors.push([op, detail]),
    )
    // All non-fatal: none throw, but each surfaces the server error to the sink.
    await engine.emit({ type: 'response_delivered', taskId: 't' })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a' })
    await engine.consult({ task_id: 't', context: 'x', candidate_ids: ['tool:a'] })
    expect(errors.map((e) => e[0])).toEqual(['emit', 'register', 'consult'])
    expect(errors.every((e) => e[1] === 'engine boom')).toBe(true)
  })

  it('also reports transport failures via onError (daemon down)', async () => {
    const ops: string[] = []
    const engine = createRemoteEngine(
      async () => {
        throw new Error('ECONNREFUSED')
      },
      (op) => ops.push(op),
    )
    await engine.emit({ type: 'response_delivered', taskId: 't' })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a' })
    expect(ops).toEqual(['emit', 'register'])
  })
})
