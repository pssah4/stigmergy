// Shared StoragePort conformance suite. Every storage adapter calls
// defineStorageConformance with its own factory so all adapters prove identical
// behaviour (ADR-02: schema, SQL semantics, roundtrip; WAL is adapter-specific).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { START_NODE } from '@agentic-stigmergy/core'
import type { StoragePort, Capability, Edge, Task, PinnedPath } from '@agentic-stigmergy/core'

export { defineEngineConformance } from './engine-conformance.js'
export { defineEmbeddingConformance } from './embedding-conformance.js'

const ISO = new Date(0).toISOString()

function cap(id: string, emb?: Float32Array): Capability {
  return { id, type: 'tool', description: `desc ${id}`, descriptionEmbedding: emb, firstSeen: ISO, lastSeen: ISO }
}

function edge(from: string, to: string, pheromone = 0.5): Edge {
  return {
    fromCapability: from,
    toCapability: to,
    pheromone,
    successCount: 1,
    failureCount: 0,
    pinned: false,
    pinBehavior: null,
    pinOwner: null,
    lastUpdated: ISO,
  }
}

export function defineStorageConformance(name: string, makeStorage: () => Promise<StoragePort>): void {
  describe(`StoragePort conformance: ${name}`, () => {
    let s: StoragePort

    beforeEach(async () => {
      s = await makeStorage()
      await s.init()
    })

    afterEach(async () => {
      await s.close()
    })

    it('upserts and reads a capability', async () => {
      await s.upsertCapability(cap('tool:a'))
      const got = await s.getCapability('tool:a')
      expect(got?.id).toBe('tool:a')
      expect(got?.description).toBe('desc tool:a')
    })

    it('returns null for an unknown capability', async () => {
      expect(await s.getCapability('tool:nope')).toBeNull()
    })

    it('updates an existing capability on conflict', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertCapability({ ...cap('tool:a'), description: 'updated' })
      expect((await s.getCapability('tool:a'))?.description).toBe('updated')
    })

    it('lists capabilities excluding the system sentinel', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertCapability(cap('tool:b'))
      const ids = (await s.listCapabilities()).map((c) => c.id).sort()
      expect(ids).toEqual(['tool:a', 'tool:b'])
      expect(ids).not.toContain(START_NODE)
    })

    it('roundtrips a Float32Array embedding as BLOB', async () => {
      await s.upsertCapability(cap('tool:e', new Float32Array([0.1, -0.2, 0.3])))
      const got = await s.getCapability('tool:e')
      expect(got?.descriptionEmbedding).toBeInstanceOf(Float32Array)
      expect(Array.from(got!.descriptionEmbedding!)).toEqual([Math.fround(0.1), Math.fround(-0.2), Math.fround(0.3)])
    })

    it('upserts and reads an edge, including a START edge', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertEdge(edge(START_NODE, 'tool:a', 0.7))
      const got = await s.getEdge(START_NODE, 'tool:a')
      expect(got?.fromCapability).toBe(START_NODE)
      expect(got?.pheromone).toBeCloseTo(0.7, 6)
      expect(got?.pinned).toBe(false)
    })

    it('lists outgoing edges ordered by pheromone desc', async () => {
      for (const id of ['tool:a', 'tool:b', 'tool:c']) await s.upsertCapability(cap(id))
      await s.upsertEdge(edge('tool:a', 'tool:b', 0.2))
      await s.upsertEdge(edge('tool:a', 'tool:c', 0.8))
      const out = await s.listOutgoingEdges('tool:a')
      expect(out.map((e) => e.toCapability)).toEqual(['tool:c', 'tool:b'])
    })

    it('upserts a task with a JSON path idempotently', async () => {
      const task: Task = {
        id: 't1',
        contextText: 'ctx',
        path: ['tool:a', 'tool:b'],
        outcome: 'accepted',
        tokenCost: 123,
        createdAt: ISO,
        sourceHost: 'custom',
      }
      await s.upsertTask(task)
      await s.upsertTask(task)
    })

    it('commits writes inside a transaction', async () => {
      await s.transaction(async () => {
        await s.upsertCapability(cap('tool:tx'))
      })
      expect((await s.getCapability('tool:tx'))?.id).toBe('tool:tx')
    })

    it('rolls back a failed transaction', async () => {
      await expect(
        s.transaction(async () => {
          await s.upsertCapability(cap('tool:rb'))
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(await s.getCapability('tool:rb')).toBeNull()
    })

    it('roundtrips a pinned path and deletes it', async () => {
      const pp: PinnedPath = {
        id: 'pp1',
        name: 'Report',
        description: 'd',
        capabilitySequence: ['tool:a', 'tool:b'],
        parametersTemplate: { x: 1 },
        behavior: 'sequence',
        createdAt: ISO,
        createdBy: 'user',
      }
      await s.upsertPinnedPath(pp)
      const got = await s.getPinnedPath('pp1')
      expect(got?.capabilitySequence).toEqual(['tool:a', 'tool:b'])
      expect(got?.behavior).toBe('sequence')
      expect(got?.parametersTemplate).toEqual({ x: 1 })
      expect((await s.listPinnedPaths()).map((p) => p.id)).toContain('pp1')
      await s.deletePinnedPath('pp1')
      expect(await s.getPinnedPath('pp1')).toBeNull()
    })

    it('roundtrips runtime_config: null when absent, value after set, upsert on conflict (EPIC-04 FEAT-04-06)', async () => {
      expect(await s.getRuntimeConfig('enabled')).toBeNull() // absent by default (disabled)
      await s.setRuntimeConfig('enabled', '1')
      expect(await s.getRuntimeConfig('enabled')).toBe('1')
      await s.setRuntimeConfig('enabled', '0') // upsert on conflict
      expect(await s.getRuntimeConfig('enabled')).toBe('0')
      expect(await s.getRuntimeConfig('other')).toBeNull()
    })

    it('roundtrips the v3 columns: capability source and pinned whenToUse/naming/pathSource (EPIC-04 FEAT-04-01)', async () => {
      const emb = new Float32Array([0.1, 0.2, 0.3])
      await s.upsertCapability({ ...cap('tool:a'), source: 'declared' })
      expect((await s.getCapability('tool:a'))?.source).toBe('declared')
      await s.upsertCapability(cap('tool:b'))
      expect((await s.getCapability('tool:b'))?.source).toBe('observed') // default when unset

      const pp: PinnedPath = {
        id: 'pp-v3',
        name: 'flow',
        capabilitySequence: ['tool:a'],
        behavior: 'preferred',
        createdAt: ISO,
        whenToUse: 'use when the task is about X',
        whenToUseEmbedding: emb,
        nameEmbedding: emb,
        namedAt: ISO,
        namedBy: 'fake-model',
        pathSource: 'emergent',
      }
      await s.upsertPinnedPath(pp)
      const got = await s.getPinnedPath('pp-v3')
      expect(got?.whenToUse).toBe('use when the task is about X')
      expect(got?.pathSource).toBe('emergent')
      expect(got?.namedBy).toBe('fake-model')
      expect(got?.namedAt).toBe(ISO)
      expect(Array.from(got?.whenToUseEmbedding ?? [])).toEqual(Array.from(emb))
      expect(Array.from(got?.nameEmbedding ?? [])).toEqual(Array.from(emb))

      // a plain pinned path defaults pathSource to manual and leaves whenToUse undefined
      await s.upsertPinnedPath({ id: 'pp-plain', capabilitySequence: ['tool:a'], behavior: 'preferred', createdAt: ISO })
      const plain = await s.getPinnedPath('pp-plain')
      expect(plain?.pathSource).toBe('manual')
      expect(plain?.whenToUse).toBeUndefined()
    })

    it('reads, lists and deletes tasks', async () => {
      const task: Task = {
        id: 't1',
        contextText: 'ctx',
        path: ['tool:a'],
        outcome: 'accepted',
        tokenCost: 10,
        createdAt: ISO,
        sourceHost: 'custom',
      }
      await s.upsertTask(task)
      const got = await s.getTask('t1')
      expect(got?.path).toEqual(['tool:a'])
      expect(got?.outcome).toBe('accepted')
      expect((await s.listTasks()).map((t) => t.id)).toContain('t1')
      await s.deleteTask('t1')
      expect(await s.getTask('t1')).toBeNull()
    })

    it('lists and deletes edges', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertCapability(cap('tool:b'))
      await s.upsertEdge(edge('tool:a', 'tool:b'))
      expect((await s.listEdges()).length).toBeGreaterThanOrEqual(1)
      await s.deleteEdge('tool:a', 'tool:b')
      expect(await s.getEdge('tool:a', 'tool:b')).toBeNull()
    })

    it('reports substrate stats excluding the system sentinel', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertCapability(cap('tool:b'))
      await s.upsertEdge(edge('tool:a', 'tool:b', 0.4))
      const stats = await s.getStats()
      expect(stats.capabilities).toBe(2)
      expect(stats.edges).toBe(1)
      expect(stats.avgPheromone).toBeCloseTo(0.4, 6)
    })

    it('clears the learned substrate in bulk but keeps the capability registry', async () => {
      await s.upsertCapability(cap('tool:a'))
      await s.upsertCapability(cap('tool:b'))
      await s.upsertEdge(edge('tool:a', 'tool:b'))
      await s.upsertTask({
        id: 't1',
        contextText: 'c',
        path: ['tool:a'],
        outcome: 'accepted',
        tokenCost: 1,
        createdAt: ISO,
        sourceHost: 'h',
      })
      await s.upsertPinnedPath({ id: 'p1', capabilitySequence: ['tool:a'], behavior: 'preferred', createdAt: ISO })

      await s.clearSubstrate()

      expect(await s.listEdges()).toHaveLength(0)
      expect(await s.listTasks()).toHaveLength(0)
      expect(await s.listPinnedPaths()).toHaveLength(0)
      expect((await s.listCapabilities()).map((c) => c.id).sort()).toEqual(['tool:a', 'tool:b'])
    })

    it('supports a reentrant nested transaction without a double BEGIN', async () => {
      await s.transaction(async () => {
        await s.upsertCapability(cap('tool:n1'))
        await s.transaction(async () => {
          await s.upsertCapability(cap('tool:n2'))
        })
      })
      expect((await s.getCapability('tool:n1'))?.id).toBe('tool:n1')
      expect((await s.getCapability('tool:n2'))?.id).toBe('tool:n2')
    })
  })
}
