// The unification (FEAT-04-09 P0-3 / P1-6): a RemoteEngine satisfies the loop facade's LoopEngine, so
// the SAME StigmergyLoop (and therefore the SDK integrations, which wrap it) works over an external
// daemon with no local engine. This is the ergonomic onboarding path: a custom loop wires three calls
// (beginTurn / instrument / end+accept), not eight raw events.
import { describe, it, expect } from 'vitest'
import { StigmergyLoop } from '@agentic-stigmergy/loop'
import { createRemoteEngine } from './client.js'
import type { RpcRequest, RpcResponse } from './protocol.js'

const ranked: RpcResponse = {
  ok: true,
  decision: { mode: 'ranked', ranked: [{ capabilityId: 'tool:a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] },
}

describe('StigmergyLoop over a RemoteEngine (FEAT-04-09)', () => {
  it('drives a full turn through the daemon: begin -> instrument -> end -> accept all go over the wire', async () => {
    const sent: RpcRequest[] = []
    const send = async (req: RpcRequest): Promise<RpcResponse> => {
      sent.push(req)
      if (req.type === 'isEnabled') return { ok: true, enabled: true }
      if (req.type === 'consult') return ranked
      return { ok: true }
    }
    const loop = new StigmergyLoop(createRemoteEngine(send)) // RemoteEngine used AS a LoopEngine
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'do alpha', candidate_ids: ['tool:a'] })
    expect(turn.surfaced).toEqual(['tool:a'])
    const [tool] = turn.instrument([{ id: 'tool:a', run: async () => 'ok' }])
    await tool!.run()
    await turn.end()
    await turn.accept(100)

    const emitted = sent.filter((r) => r.type === 'emit').map((r) => (r as { event: { type: string } }).event.type)
    expect(sent.some((r) => r.type === 'isEnabled')).toBe(true)
    expect(sent.some((r) => r.type === 'consult')).toBe(true)
    // The full lifecycle reaches the daemon as emit frames -> the daemon learns.
    expect(emitted).toEqual(['task_started', 'capability_loaded', 'capability_invoked', 'capability_returned', 'response_delivered', 'task_accepted'])
  })

  it('no-ops the whole turn when the daemon reports disabled (host keeps all its tools)', async () => {
    const send = async (req: RpcRequest): Promise<RpcResponse> =>
      req.type === 'isEnabled' ? { ok: true, enabled: false } : { ok: true }
    const loop = new StigmergyLoop(createRemoteEngine(send))
    const turn = await loop.beginTurn({ task_id: 't', prompt: 'x', candidate_ids: ['tool:a'] })
    expect(turn.surfaced).toEqual([]) // surfaced nothing
    const tools = turn.instrument([{ id: 'tool:a', run: async () => 'ok' }])
    expect(tools).toHaveLength(1) // tools passed through unwrapped -> the host runs its normal full set
  })
})
