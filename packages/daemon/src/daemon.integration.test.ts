// Integration tests for the daemon (EPIC-04 FEAT-04-04, FEAT-04-08). These wire the real pieces the
// unit tests stub: a real engine on a real better-sqlite3 substrate, served over a real Unix socket,
// consulted by a real client; and the emergent-naming pass driven off a real foraged substrate. They
// cover the seams the pure tests cannot (transport round-trip with a real decision, backup->select->pin
// against real storage). No process spawn or Electron; startDaemon is called in-process.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, FakeEmbedding, type StigmergyEngine } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { createConsultClient, socketRpcSend } from '@agentic-stigmergy/client'
import { startDaemon, type DaemonHandle } from './run.js'
import { nameEmergentPaths } from './controller.js'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'daemon-it-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Wait for the daemon's Unix socket to bind (the file appears once listen() succeeds). */
async function waitForSocket(path: string): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('daemon consult server end-to-end (FEAT-04-08)', () => {
  it('serves a real engine decision over the socket to a real client', async () => {
    const dir = tmp()
    const substratePath = join(dir, 'pheromone.db')

    // Seed the substrate with a short-lived engine, then close it so the daemon owns the single writer.
    const seed = await createEngine({ storage: new BetterSqlite3Storage(substratePath), embedding: new FakeEmbedding() })
    await seed.registerCapability({ id: 'tool:cats', type: 'tool', description: 'cat feeding schedule' })
    await seed.registerCapability({ id: 'tool:taxes', type: 'tool', description: 'quarterly tax filing' })
    await seed.close()

    const socketPath = join(dir, 'd.sock')
    let handle: DaemonHandle | null = null
    try {
      handle = await startDaemon(
        { substratePath, socketPath, lockPath: join(dir, 'd.lock'), intervalMs: 1_000_000 },
        { makeEmbedding: () => new FakeEmbedding(), makeHandler: () => null },
      )
      expect(handle).not.toBeNull()
      await waitForSocket(socketPath)

      // The client's local fallback returns empty; a non-empty ranked result proves it came over the wire.
      const client = createConsultClient(socketRpcSend(socketPath, 2000), { consult: async () => ({ mode: 'ranked', ranked: [] }) })
      const d = await client.consult({ task_id: 't', context: 'cat feeding schedule', top_k: 2 })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') {
        expect(d.ranked.length).toBeGreaterThan(0)
        expect(d.ranked[0]!.capabilityId).toBe('tool:cats') // the real engine ranked it, served over the socket
      }
    } finally {
      await handle?.stop()
    }
  })
})

describe('emergent naming against a real substrate (FEAT-04-04)', () => {
  async function forageAccept(engine: StigmergyEngine, taskId: string, context: string, capId: string): Promise<void> {
    await engine.emit({ type: 'task_started', taskId, context })
    await engine.emit({ type: 'capability_loaded', taskId, capabilityId: capId })
    await engine.emit({ type: 'capability_invoked', taskId, capabilityId: capId })
    await engine.emit({ type: 'capability_returned', taskId, capabilityId: capId, success: true })
    await engine.emit({ type: 'response_delivered', taskId })
    await engine.emit({ type: 'task_accepted', taskId, tokenCost: 500 })
  }

  it('names and pins a reinforced emergent path read back from real storage', async () => {
    const dir = tmp()
    const engine = await createEngine({ storage: new BetterSqlite3Storage(join(dir, 'p.db')), embedding: new FakeEmbedding() })
    try {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha task' })
      await forageAccept(engine, 't1', 'alpha task', 'tool:a') // reinforces START -> tool:a (successCount >= 1)

      const namer = async (): Promise<{ name: string; whenToUse: string }> => ({ name: 'Alpha Flow', whenToUse: 'use for alpha tasks' })
      const res = await nameEmergentPaths(engine, namer, { threshold: 1, namedBy: 'daemon' })
      expect(res.named).toBe(1)
      expect(res.skipped).toBe(0)

      const dump = await engine.backup()
      const named = dump.pinnedPaths.find((p) => p.capabilitySequence.includes('tool:a'))
      expect(named).toBeDefined()
      expect(named!.name).toBe('Alpha Flow')
      expect(named!.pathSource).toBe('emergent')
      expect(named!.whenToUse).toBe('use for alpha tasks')
      expect(named!.namedBy).toBe('daemon')
    } finally {
      await engine.close()
    }
  })

  it('gates the emergent path on its whenToUse: the sequence fires only when the task matches (FEAT-04-09, ADR-18)', async () => {
    const dir = tmp()
    const engine = await createEngine({ storage: new BetterSqlite3Storage(join(dir, 'p.db')), embedding: new FakeEmbedding() })
    try {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await forageAccept(engine, 't1', 'alpha', 'tool:a') // reinforce START -> tool:a
      // A distinctive single-token whenToUse so the gate is unambiguous under FakeEmbedding.
      await nameEmergentPaths(engine, async () => ({ name: 'Alpha Flow', whenToUse: 'alpha' }), { threshold: 1, namedBy: 'daemon' })

      // Embedding is eventual (ADR-25): the whenToUse and query vectors warm in the background, so warm
      // the index (consult, drain, consult) before asserting the gate discriminates.
      const warm = async (context: string) => {
        await engine.consult({ task_id: `w-${context}`, context, candidate_ids: ['tool:a'], history: [] })
        await engine.whenEmbeddingsIdle?.()
        return engine.consult({ task_id: context, context, candidate_ids: ['tool:a'], history: [] })
      }

      // Matching context -> gate open -> the discovered sequence guides the next step.
      const match = await warm('alpha')
      expect(match.mode).toBe('sequence')
      if (match.mode === 'sequence') expect(match.nextCapability).toBe('tool:a')

      // Off-topic context -> gate closed -> the sequence does NOT fire (normal foraging instead).
      const off = await warm('zzdisjoint')
      expect(off.mode).toBe('ranked')
    } finally {
      await engine.close()
    }
  })

  it('skips naming when the namer returns null (no provider), leaving the path a candidate', async () => {
    const dir = tmp()
    const engine = await createEngine({ storage: new BetterSqlite3Storage(join(dir, 'p.db')), embedding: new FakeEmbedding() })
    try {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha task' })
      await forageAccept(engine, 't1', 'alpha task', 'tool:a')

      const res = await nameEmergentPaths(engine, async () => null, { threshold: 1, namedBy: 'none' })
      expect(res.named).toBe(0)
      expect(res.skipped).toBe(1)
      expect((await engine.backup()).pinnedPaths).toHaveLength(0) // no half-write
    } finally {
      await engine.close()
    }
  })
})
