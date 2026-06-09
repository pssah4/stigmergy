// Wire protocol for the consult server (ADR-20, FEAT-04-08). Length-prefixed JSON frames: a 4-byte
// big-endian length, then the UTF-8 JSON body. Pure encode/decode so it is unit-tested without a
// socket; the net transport (socket.ts) just feeds chunks through FrameDecoder and writes encodeFrame.
import type { ConsultInput, Decision, LifecycleEvent, RegisterCapabilityInput } from '@agentic-stigmergy/core'

export interface ConsultRequest {
  type: 'consult'
  input: ConsultInput
}

/** Report one loop lifecycle event so the daemon's engine can learn (deposit). FEAT-04-09. */
export interface EmitRequest {
  type: 'emit'
  event: LifecycleEvent
}

/** Tell the daemon about a host capability (e.g. one of the host's tools) so consult can rank it.
 * The embedding is computed in the daemon, so no Float32Array ever crosses the wire. FEAT-04-09. */
export interface RegisterRequest {
  type: 'register'
  input: RegisterCapabilityInput
}

/** Ask the daemon whether Stigmergy is enabled, so a remote host (with no local engine) can no-op a
 * turn when the operator toggled it off in the Studio (FEAT-04-09 / ADR-20). */
export interface IsEnabledRequest {
  type: 'isEnabled'
}

/** Liveness check: a host can tell a down daemon apart from a real empty ranking (FEAT-04-09). */
export interface PingRequest {
  type: 'ping'
}

/** Every request a remote host can send to the daemon (consult plus the write side plus control). */
export type RpcRequest = ConsultRequest | EmitRequest | RegisterRequest | IsEnabledRequest | PingRequest

export type ConsultResponse = { ok: true; decision: Decision } | { ok: false; error: string }
/** Response for a write/control request (emit/register/ping): success or a server-side error. */
export type OkResponse = { ok: true } | { ok: false; error: string }
/** Response for isEnabled: the flag value, or a server-side error. */
export type IsEnabledResponse = { ok: true; enabled: boolean } | { ok: false; error: string }
export type RpcResponse = ConsultResponse | OkResponse | IsEnabledResponse

/** Max frame body size (16 MiB). A consult request/response is tiny; a larger declared length is a
 * bug or a hostile peer, so we reject rather than buffer unbounded (OOM guard). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Encode a value as a length-prefixed JSON frame. */
export function encodeFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(json.length, 0)
  return Buffer.concat([header, json])
}

/** Streaming decoder: push socket chunks, get back the complete frames parsed so far. Holds the
 * partial tail between pushes so a frame split across chunks is reassembled. Throws on an oversized
 * declared length or a non-JSON body; the socket caller catches and drops the connection rather than
 * letting the throw reach uncaughtException and kill the process. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) throw new Error(`frame too large: ${len} bytes`)
      if (this.buf.length < 4 + len) break // wait for the rest of this frame
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      out.push(JSON.parse(body.toString('utf8'))) // throws on a malformed/empty body; the caller catches
    }
    return out
  }
}
