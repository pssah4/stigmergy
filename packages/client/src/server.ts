// Consult server handler (ADR-20, FEAT-04-08, FEAT-04-09). Pure request -> response: run the request
// through the engine and wrap the result. The daemon hosts this behind a socket (socket.ts); a thrown
// engine error becomes an { ok: false } response rather than crashing the connection.
import type { ConsultInput, Decision, LifecycleEvent, RegisterCapabilityInput } from '@agentic-stigmergy/core'
import type { ConsultRequest, ConsultResponse, RpcRequest, RpcResponse } from './protocol.js'

export interface ConsultLikeServer {
  consult(input: ConsultInput): Promise<Decision>
}

/** The slice of the engine the daemon exposes over the wire (FEAT-04-09): surfacing plus the write
 * side, so a host can run as a pure remote client with no local engine. registerCapability returns a
 * Capability locally, but we never send it back (it carries a Float32Array); the wire response is just
 * { ok }. */
export interface EngineLikeServer extends ConsultLikeServer {
  emit(event: LifecycleEvent): Promise<void>
  registerCapability(input: RegisterCapabilityInput): Promise<unknown>
  isEnabled(): Promise<boolean>
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function handleConsultRequest(engine: ConsultLikeServer, request: ConsultRequest): Promise<ConsultResponse> {
  // Guard the type: serveConsult casts an unknown frame to ConsultRequest, so a non-consult frame
  // (e.g. a 'register' sent to a consult-only endpoint) must be rejected, not passed to consult with
  // a wrong-shaped input (review w4pg93b97).
  if (!request || request.type !== 'consult') {
    return { ok: false, error: `expected a consult request, got ${(request as { type?: unknown } | null)?.type ?? 'none'}` }
  }
  try {
    return { ok: true, decision: await engine.consult(request.input) }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/** Dispatch any RPC request to the engine and wrap the result. A thrown engine error (or an unknown
 * request type) becomes { ok: false }, so one bad request never crashes the connection or the daemon. */
export async function handleRequest(engine: EngineLikeServer, request: RpcRequest): Promise<RpcResponse> {
  try {
    switch (request.type) {
      case 'consult':
        return { ok: true, decision: await engine.consult(request.input) }
      case 'emit':
        await engine.emit(request.event)
        return { ok: true }
      case 'register':
        await engine.registerCapability(request.input)
        return { ok: true }
      case 'isEnabled':
        return { ok: true, enabled: await engine.isEnabled() }
      case 'ping':
        return { ok: true }
      default:
        return { ok: false, error: `unknown request type: ${(request as { type?: unknown }).type}` }
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}
