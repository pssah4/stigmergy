import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { ConsultLike } from './client.js'
import type { Decision, LifecycleEvent, RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { serveConsult, serveEngine, socketRpcSend } from './socket.js'
import { createConsultClient, createRemoteEngine } from './client.js'
import type { EngineLikeServer } from './server.js'

describe('consult socket transport (EPIC-04 FEAT-04-08)', () => {
  let server: Server | undefined
  let dir: string | undefined
  afterEach(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a consult request over a real unix socket and the client uses the daemon decision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 's.sock')
    const engine: ConsultLike = {
      consult: async (input) => ({
        mode: 'ranked',
        ranked: [{ capabilityId: `for:${input.context}`, score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }],
      }),
    }
    server = serveConsult(engine, sockPath)
    await new Promise((r) => server!.once('listening', r))

    const local: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [] }) }
    const client = createConsultClient(socketRpcSend(sockPath), local)
    const d = await client.consult({ task_id: 't', context: 'alpha' })
    expect(d.mode).toBe('ranked')
    if (d.mode === 'ranked') expect(d.ranked[0]!.capabilityId).toBe('for:alpha') // came from the daemon
  })

  it('falls back to local when the socket path is unreachable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const local: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [{ capabilityId: 'local', score: 1, components: { pheromone: 0.5, similarity: 0, thompson: 1 } }] }) }
    const client = createConsultClient(socketRpcSend(join(dir, 'nope.sock'), 500), local)
    const d = await client.consult({ task_id: 't', context: 'x' })
    if (d.mode === 'ranked') expect(d.ranked[0]!.capabilityId).toBe('local') // daemon unreachable -> fallback
  })

  // Hardening (pre-merge review wxfcn1jf7, CRITICAL): a hostile/buggy peer sending a malformed frame
  // must not crash the server; it drops that connection and keeps serving the next client.
  it('survives a malformed frame from one peer and still serves the next', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 's.sock')
    const engine: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [{ capabilityId: 'ok', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] }) }
    server = serveConsult(engine, sockPath)
    await new Promise((r) => server!.once('listening', r))

    // Send a zero-length frame (4 zero bytes -> JSON.parse('') would throw inside the data handler).
    await new Promise<void>((resolve) => {
      const evil = connect(sockPath, () => {
        evil.write(Buffer.alloc(4))
        evil.end()
        resolve()
      })
      evil.on('error', () => resolve())
    })

    // The server must still be alive: a fresh client gets a normal answer.
    const client = createConsultClient(socketRpcSend(sockPath, 1000), { consult: async () => ({ mode: 'ranked', ranked: [] }) })
    const d = await client.consult({ task_id: 't', context: 'x' })
    if (d.mode === 'ranked') expect(d.ranked[0]!.capabilityId).toBe('ok') // server survived, daemon answered
  })

  it('removes a stale socket file before listening so a restart does not hit EADDRINUSE', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 's.sock')
    writeFileSync(sockPath, '') // leftover file from an unclean prior exit
    const engine: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [] }) }
    server = serveConsult(engine, sockPath) // must not throw EADDRINUSE
    await new Promise((r) => server!.once('listening', r))
    expect(server.listening).toBe(true)
  })

  it('restricts the consult socket to the owner (mode 0600, AUDIT EPIC-04 M-1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 's.sock')
    const engine: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [] }) }
    server = serveConsult(engine, sockPath)
    await new Promise((r) => server!.once('listening', r))
    const mode = statSync(sockPath).mode & 0o777
    expect(mode & 0o077).toBe(0) // no group/other access
  })

  it('serves the full engine surface (register, emit, consult) to a pure remote client (FEAT-04-09)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 'e.sock')
    const emitted: LifecycleEvent[] = []
    const registered: RegisterCapabilityInput[] = []
    const ranked: Decision = { mode: 'ranked', ranked: [{ capabilityId: 'tool:a', score: 1, components: { pheromone: 0.5, similarity: 1, thompson: 1 } }] }
    const engine: EngineLikeServer = {
      consult: async () => ranked,
      emit: async (e) => void emitted.push(e),
      registerCapability: async (i) => void registered.push(i),
    }
    server = serveEngine(engine, sockPath)
    await new Promise((r) => server!.once('listening', r))

    const remote = createRemoteEngine(socketRpcSend(sockPath, 2000))
    await remote.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    await remote.emit({ type: 'task_started', taskId: 't', context: 'x' })
    const d = await remote.consult({ task_id: 't', context: 'x', candidate_ids: ['tool:a'] })

    expect(registered.map((r) => r.id)).toEqual(['tool:a']) // register reached the engine over the wire
    expect(emitted.map((e) => e.type)).toEqual(['task_started']) // emit reached the engine over the wire
    if (d.mode === 'ranked') expect(d.ranked[0]!.capabilityId).toBe('tool:a') // consult answered by the engine
  })

  it('rejects (and the client falls back) when the daemon sends a malformed response frame', async () => {
    dir = mkdtempSync(join(tmpdir(), 'consult-sock-'))
    const sockPath = join(dir, 's.sock')
    // A raw server that replies with a valid 4-byte length header followed by a non-JSON body.
    server = createServerRaw(sockPath)
    await new Promise((r) => server!.once('listening', r))

    const local: ConsultLike = { consult: async () => ({ mode: 'ranked', ranked: [{ capabilityId: 'local', score: 1, components: { pheromone: 0.5, similarity: 0, thompson: 1 } }] }) }
    const client = createConsultClient(socketRpcSend(sockPath, 1000), local)
    const d = await client.consult({ task_id: 't', context: 'x' })
    if (d.mode === 'ranked') expect(d.ranked[0]!.capabilityId).toBe('local') // malformed response -> reject -> fallback
  })
})

/** A raw net server that, on any connection, writes a frame whose body is not JSON, to exercise the
 * client decoder's reject path (socket.ts). Returns the listening server. */
function createServerRaw(socketPath: string): Server {
  const srv = createServer((sock: Socket) => {
    const body = Buffer.from('not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    sock.write(Buffer.concat([header, body]))
  })
  srv.listen(socketPath)
  return srv
}
