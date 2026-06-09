import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, FakeEmbedding } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'

// Local-First regression guard (FEAT-02-06 SC-05, ADR-07).
//
// Scope, stated honestly: this proves the DEFAULT CLI stack makes no DIRECT globalThis.fetch call
// on a full register / deposit / consult cycle. That default stack is what bin.ts wires:
// FakeEmbedding (pure local hashing, no IO) and no augmenter. There is no network-capable
// component on the @stigmergy/cli dependency graph (its runtime deps are core, storage-better-
// sqlite3, connect), so a direct fetch from the cycle would be an implicit egress.
//
// What this does NOT cover (separate, opt-in seams, off by default, not on the CLI default path):
//   - @stigmergy/embedding-transformers downloads a model once via transformers.js, which captures
//     env.fetch at module load, not the live globalThis.fetch, so this stub would not intercept it.
//   - @stigmergy/llm providers egress via an INJECTED fetch (ProviderDeps.fetch), only when an
//     augmenter is configured (FEAT-01-07, default off).
// The value here is catching a NEW direct globalThis.fetch caller added to the engine/storage/CLI
// core path (e.g. a telemetry ping), which would be a real regression of the default guarantee.
describe('local-first: the default stack makes no direct globalThis.fetch call (FEAT-02-06 SC-05)', () => {
  it('a register / deposit / consult cycle on the default stack never calls globalThis.fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network blocked by SC-05 test')
    })
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const dir = await mkdtemp(join(tmpdir(), 'net-mock-'))
    try {
      const storage = new BetterSqlite3Storage(join(dir, 'n.db'))
      const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha search' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta read' })
      await engine.deposit({ task_id: 't1', context: 'alpha then beta', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 500 })
      await engine.consult({ task_id: 't2', context: 'alpha beta', candidate_ids: ['tool:a', 'tool:b'] })
      await engine.close()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
      await rm(dir, { recursive: true, force: true })
    }
  })
})
