// Consult client with fallback (ADR-20, FEAT-04-08) plus the pure remote engine (FEAT-04-09). The loop
// either keeps a local engine and only delegates consult (createConsultClient/connectEngine), or runs
// as a pure remote client with no local engine at all (createRemoteEngine): it sends consult, emit and
// registerCapability over the wire and degrades gracefully when the daemon is down. The RPC send is
// injectable, so the logic is unit-tested without a socket; socket.ts supplies the real send.
import type { ConsultInput, Decision, LifecycleEvent, RegisterCapabilityInput, StigmergyEngine } from '@agentic-stigmergy/core'
import type { RpcRequest, RpcResponse } from './protocol.js'

/** The slice of the engine the client implements (and falls back to). */
export interface ConsultLike {
  consult(input: ConsultInput): Promise<Decision>
}

/** Send a request frame and resolve the response; rejects on transport failure/timeout. */
export type RpcSend = (request: RpcRequest) => Promise<RpcResponse>

/** A ConsultLike backed by the daemon, falling back to `local` on transport failure or a server error. */
export function createConsultClient(send: RpcSend, local: ConsultLike): ConsultLike {
  return {
    async consult(input: ConsultInput): Promise<Decision> {
      let res: RpcResponse
      try {
        res = await send({ type: 'consult', input })
      } catch {
        return local.consult(input) // daemon unreachable/timeout -> behavior-only local surfacing
      }
      if (res.ok && 'decision' in res) return res.decision
      return local.consult(input) // server-side error -> fall back rather than fail the turn
    },
  }
}

/** Wrap a local engine so consult routes to the daemon (with fallback), while every other method
 * (emit/deposit/isEnabled/...) stays local: writes are local, only surfacing is delegated (ADR-12
 * client transport). The loop wires this engine into StigmergyLoop and is otherwise unchanged. */
export function connectEngine(local: StigmergyEngine, send: RpcSend): StigmergyEngine {
  const client = createConsultClient(send, local)
  return new Proxy(local, {
    get(target, prop, receiver) {
      if (prop === 'consult') return (input: ConsultInput) => client.consult(input)
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The engine surface a pure remote host (e.g. Vault Operator) uses: no local engine, everything over
 * the wire. registerCapability resolves void (the daemon keeps the Capability; no Float32Array is sent
 * back). FEAT-04-09. */
export interface RemoteEngine {
  consult(input: ConsultInput): Promise<Decision>
  emit(event: LifecycleEvent): Promise<void>
  registerCapability(input: RegisterCapabilityInput): Promise<void>
  /** Whether Stigmergy is enabled (ADR-20). Returns false when the daemon is unreachable, so a host
   * with no local engine treats "daemon down" as "off" and runs its normal full behaviour. */
  isEnabled(): Promise<boolean>
  /** Liveness: true if the daemon answered, false if unreachable. Lets a host distinguish a down
   * daemon from a real empty ranking. */
  ping(): Promise<boolean>
}

/** A ranked decision that surfaces every candidate unchanged, used when the daemon is unreachable so a
 * host that narrows on the result keeps all its tools (no filtering rather than dropping everything). */
function passthroughDecision(input: ConsultInput): Decision {
  const ids = input.candidate_ids ?? []
  return { mode: 'ranked', ranked: ids.map((capabilityId) => ({ capabilityId, score: 0, components: { pheromone: 0, similarity: 0, thompson: 0 } })) }
}

/** Optional observer for non-fatal remote failures, so a host can log/surface them. createRemoteEngine
 * never throws (graceful degrade); onError is how a server-side { ok: false } or a transport failure
 * becomes visible instead of silent (review w4pg93b97). */
export type RemoteErrorSink = (op: 'consult' | 'emit' | 'register' | 'isEnabled' | 'ping', detail: string) => void

/** A pure remote engine over the daemon socket. Graceful degrade: if the daemon is down or errors,
 * consult returns a passthrough decision (all candidates surfaced, no narrowing) and emit/register
 * become no-ops (learning pauses, the host never breaks). A server-side { ok: false } is reported via
 * the optional onError sink rather than swallowed silently. FEAT-04-09. */
export function createRemoteEngine(send: RpcSend, onError: RemoteErrorSink = () => {}): RemoteEngine {
  return {
    async consult(input: ConsultInput): Promise<Decision> {
      try {
        const res = await send({ type: 'consult', input })
        if (res.ok && 'decision' in res) return res.decision
        if (!res.ok) onError('consult', res.error)
        return passthroughDecision(input) // server-side error -> do not narrow the host's tools
      } catch (e) {
        onError('consult', e instanceof Error ? e.message : String(e))
        return passthroughDecision(input) // daemon unreachable -> behave as if Stigmergy is absent
      }
    },
    async emit(event: LifecycleEvent): Promise<void> {
      try {
        const res = await send({ type: 'emit', event })
        if (!res.ok) onError('emit', res.error) // daemon up but the engine rejected/failed the event
      } catch (e) {
        onError('emit', e instanceof Error ? e.message : String(e)) // daemon down: learning pauses
      }
    },
    async registerCapability(input: RegisterCapabilityInput): Promise<void> {
      try {
        const res = await send({ type: 'register', input })
        if (!res.ok) onError('register', res.error) // server-side failure, not just a transport drop
      } catch (e) {
        onError('register', e instanceof Error ? e.message : String(e))
      }
    },
    async isEnabled(): Promise<boolean> {
      try {
        const res = await send({ type: 'isEnabled' })
        if (res.ok && 'enabled' in res) return res.enabled
        if (!res.ok) onError('isEnabled', res.error)
        return false
      } catch (e) {
        onError('isEnabled', e instanceof Error ? e.message : String(e))
        return false // daemon unreachable -> treat as off (the host runs its normal full behaviour)
      }
    },
    async ping(): Promise<boolean> {
      try {
        const res = await send({ type: 'ping' })
        return res.ok
      } catch {
        return false
      }
    },
  }
}
