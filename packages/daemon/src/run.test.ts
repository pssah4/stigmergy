import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { START_NODE, FakeEmbedding, type StigmergyEngine } from '@agentic-stigmergy/core'
import type { ApiHandler } from '@stigmergy/llm'
import { buildLlmNamer, runOneTick, startDaemon } from './run.js'

describe('buildLlmNamer (EPIC-04 FEAT-04-04)', () => {
  it('returns a no-op namer (null) when there is no handler', async () => {
    expect(await buildLlmNamer(null)(['tool:a'])).toBeNull()
  })

  it('parses a JSON name + whenToUse out of the handler reply (tolerating surrounding text)', async () => {
    const handler: ApiHandler = { classifyText: async () => 'sure: {"name":"Cat Flow","whenToUse":"use for cat tasks"} done' }
    expect(await buildLlmNamer(handler)(['tool:a'])).toEqual({ name: 'Cat Flow', whenToUse: 'use for cat tasks' })
  })

  it('returns null on an unparseable or incomplete reply', async () => {
    expect(await buildLlmNamer({ classifyText: async () => 'no json' })(['a'])).toBeNull()
    expect(await buildLlmNamer({ classifyText: async () => '{"name":"x"}' })(['a'])).toBeNull() // missing whenToUse
  })
})

describe('runOneTick (EPIC-04 FEAT-04-04)', () => {
  it('heartbeats the lock and names emergent paths', async () => {
    let beats = 0
    const pins: unknown[] = []
    const engine = {
      backup: async () => ({
        version: 1,
        capabilities: [],
        tasks: [],
        edges: [
          { fromCapability: START_NODE, toCapability: 'a', pheromone: 0.5, successCount: 5, failureCount: 0, pinned: false, pinBehavior: null, pinOwner: null, lastUpdated: '' },
        ],
        pinnedPaths: [],
      }),
      pinPath: async (i: unknown) => {
        pins.push(i)
        return {} as never
      },
    } as unknown as Pick<StigmergyEngine, 'backup' | 'pinPath'>

    const res = await runOneTick({
      engine,
      namer: async (s) => ({ name: s.join(), whenToUse: 'w' }),
      lock: { heartbeat: () => void beats++ },
      threshold: 3,
      namedBy: 'daemon',
    })
    expect(beats).toBe(1) // the lock was heartbeated
    expect(res.named).toBe(1)
    expect(pins).toHaveLength(1)
  })

  it('heartbeats but skips naming when Stigmergy is disabled (FEAT-04-09 gating)', async () => {
    let beats = 0
    let backupCalls = 0
    const engine = {
      isEnabled: async () => false,
      backup: async () => {
        backupCalls++
        return { version: 1, capabilities: [], tasks: [], edges: [], pinnedPaths: [] }
      },
      pinPath: async () => ({}) as never,
    } as unknown as Pick<StigmergyEngine, 'backup' | 'pinPath' | 'isEnabled'>

    const res = await runOneTick({
      engine,
      namer: async () => ({ name: 'x', whenToUse: 'w' }),
      lock: { heartbeat: () => void beats++ },
      threshold: 1,
      namedBy: 'daemon',
    })
    expect(beats).toBe(1) // still heartbeats so the lock stays fresh
    expect(res).toEqual({ named: 0, skipped: 0 })
    expect(backupCalls).toBe(0) // disabled -> never reads/mutates the substrate
  })
})

describe('startDaemon lock lifecycle (EPIC-04 FEAT-04-04, pre-merge review wxfcn1jf7)', () => {
  it('releases the role lock when engine setup throws (no orphaned lock)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-leak-'))
    const substratePath = join(dir, 'pheromone.db')
    const lockPath = join(dir, 'daemon.lock')
    try {
      await expect(
        startDaemon(
          { substratePath, lockPath },
          {
            makeEmbedding: () => {
              throw new Error('boom')
            },
            makeHandler: () => null,
          },
        ),
      ).rejects.toThrow('boom')
      expect(existsSync(lockPath)).toBe(false) // setup failed -> lock released, not orphaned
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('holds the lock while running and releases it on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-life-'))
    const substratePath = join(dir, 'pheromone.db')
    const lockPath = join(dir, 'daemon.lock')
    try {
      const handle = await startDaemon(
        { substratePath, lockPath, intervalMs: 1_000_000 },
        { makeEmbedding: () => new FakeEmbedding(), makeHandler: () => null },
      )
      expect(handle).not.toBeNull()
      expect(existsSync(lockPath)).toBe(true)
      await handle!.stop()
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
