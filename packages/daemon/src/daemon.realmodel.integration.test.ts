// Real-model end-to-end smoke (FEAT-04-09 SC-05, FEAT-04-04). NO FAKES: a daemon with the real
// transformers.js/onnxruntime-node model (Xenova/all-MiniLM-L6-v2) serves the full engine surface over
// a Unix socket; a pure remote client registers capabilities, emits a turn, and consults over the wire
// and gets a semantically-ranked decision. Env-gated like the embedding conformance test, because it
// loads the real model (cached locally). Run with: STIGMERGY_EMBEDDING_IT=1 npm test.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteEngine, socketRpcSend } from '@agentic-stigmergy/client'
import { startDaemon, type DaemonHandle } from './run.js'

const RUN = process.env['STIGMERGY_EMBEDDING_IT'] === '1'

async function waitForSocket(path: string): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 5))
}

;(RUN ? describe : describe.skip)('daemon real-model end-to-end over the socket (no fakes, FEAT-04-09 SC-05)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('serves a real semantically-ranked consult to a pure remote client (real onnx model)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-real-'))
    dirs.push(dir)
    const substratePath = join(dir, 'pheromone.db')
    const socketPath = join(dir, 'd.sock')
    let handle: DaemonHandle | null = null
    try {
      // No deps override -> the daemon uses the REAL embedding (envEmbedding default: transformers).
      handle = await startDaemon({ substratePath, socketPath, lockPath: join(dir, 'd.lock'), intervalMs: 1_000_000 })
      expect(handle).not.toBeNull()
      await waitForSocket(socketPath)

      // Generous timeout: the first register triggers the model load + embed.
      const remote = createRemoteEngine(socketRpcSend(socketPath, 120_000))
      await remote.registerCapability({ id: 'tool:cats', type: 'tool', description: 'cat feeding schedule and pet care reminders' })
      await remote.registerCapability({ id: 'tool:taxes', type: 'tool', description: 'quarterly tax filing and accounting paperwork' })

      const d = await remote.consult({ task_id: 't', context: 'how do I feed my cat today', candidate_ids: ['tool:cats', 'tool:taxes'], top_k: 2 })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') {
        const cats = d.ranked.find((r) => r.capabilityId === 'tool:cats')
        const taxes = d.ranked.find((r) => r.capabilityId === 'tool:taxes')
        expect(cats).toBeDefined()
        expect(taxes).toBeDefined()
        // Real semantic similarity: the cat-feeding tool ranks above the tax-filing tool for a cat task.
        expect(cats!.components.similarity).toBeGreaterThan(taxes!.components.similarity)
        expect(d.ranked[0]!.capabilityId).toBe('tool:cats')
      }
    } finally {
      await handle?.stop()
    }
  }, 180_000)
})
