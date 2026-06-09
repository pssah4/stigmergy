// Unix-socket transport for the consult protocol (ADR-20, FEAT-04-08). serveConsult hosts the
// daemon's consult server; socketRpcSend is the loop's client send. Thin glue over node:net plus the
// pure protocol codec; the request/response logic itself lives in server.ts/client.ts.
import { createServer, connect, type Server } from 'node:net'
import { unlinkSync, chmodSync } from 'node:fs'
import { encodeFrame, FrameDecoder, type ConsultRequest, type RpcRequest, type RpcResponse } from './protocol.js'
import { handleConsultRequest, handleRequest, type ConsultLikeServer, type EngineLikeServer } from './server.js'
import type { RpcSend } from './client.js'

/** Shared Unix-socket server: feed each decoded frame to `dispatch` and write the response back.
 * Hardened (FEAT-04-08): a frame that fails to decode drops only that connection (never crashes the
 * daemon), a stale socket file from an unclean exit is removed before listen so a restart does not hit
 * EADDRINUSE, and the bound socket is chmodded 0600 so only the owner can connect (AUDIT EPIC-04 M-1). */
function serve(dispatch: (msg: unknown) => Promise<RpcResponse>, socketPath: string): Server {
  const server = createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      let msgs: unknown[]
      try {
        msgs = decoder.push(chunk) // throws on an oversized or non-JSON frame
      } catch {
        socket.destroy() // a bad frame closes this one connection; the server keeps serving others
        return
      }
      for (const msg of msgs) {
        void dispatch(msg).then((res) => {
          if (!socket.destroyed) socket.write(encodeFrame(res))
        })
      }
    })
    socket.on('error', () => {
      /* per-connection errors must not crash the server */
    })
  })
  // A net.Server 'error' (EADDRINUSE/EACCES from listen) is emitted, not thrown; without a listener it
  // reaches uncaughtException and kills the daemon. Swallow it here so the process survives.
  server.on('error', () => {
    /* listen/bind errors are surfaced via the daemon lifecycle, not by crashing the process */
  })
  try {
    unlinkSync(socketPath) // remove a stale socket file from an unclean prior exit (ENOENT is fine)
  } catch {
    /* no stale socket, or not removable; listen will report a real conflict on its own */
  }
  // Bind, then restrict the socket to the owner: chmod in the listen callback so the file already exists.
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600)
    } catch {
      /* best-effort: on a platform without unix-socket chmod the parent dir perms still apply */
    }
  })
  return server
}

/** Listen on a socket path and answer consult-only requests from `engine` (FEAT-04-08, back-compat). */
export function serveConsult(engine: ConsultLikeServer, socketPath: string): Server {
  return serve((msg) => handleConsultRequest(engine, msg as ConsultRequest), socketPath)
}

/** Listen on a socket path and serve the full engine surface (consult plus the write side) so a host
 * can run as a pure remote client with no local engine (FEAT-04-09). */
export function serveEngine(engine: EngineLikeServer, socketPath: string): Server {
  return serve((msg) => handleRequest(engine, msg as RpcRequest), socketPath)
}

/** A client send that connects to `socketPath` per request, with a timeout. Rejects on any failure so
 * the client's fallback path engages. One request/response per connection (simple, robust). */
export function socketRpcSend(socketPath: string, timeoutMs = 2000): RpcSend {
  return (request) =>
    new Promise<RpcResponse>((resolve, reject) => {
      const socket = connect(socketPath)
      const decoder = new FrameDecoder()
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('consult timeout'))
      }, timeoutMs)
      socket.on('connect', () => socket.write(encodeFrame(request)))
      socket.on('data', (chunk: Buffer) => {
        let msgs: unknown[]
        try {
          msgs = decoder.push(chunk) // a malformed/oversized response frame rejects (client falls back)
        } catch (e) {
          clearTimeout(timer)
          socket.destroy()
          reject(e instanceof Error ? e : new Error('malformed consult response'))
          return
        }
        if (msgs.length > 0) {
          clearTimeout(timer)
          socket.end()
          resolve(msgs[0] as RpcResponse)
        }
      })
      socket.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
}
