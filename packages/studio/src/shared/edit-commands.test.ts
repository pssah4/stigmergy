import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEngine, FakeEmbedding, START_NODE, type StigmergyEngine, type StoragePort } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { validateEditCommand, applyEditCommand } from './edit-commands.js'

// SC-03/04/05 as integration tests: the edit-commands dispatcher runs against a real better-sqlite3
// engine, so a pin actually persists, an unpin actually drops the pin, and reinforce/weaken move
// the pheromone. No Electron involved (the dispatcher is Electron-free).

describe('edit-commands against a real better-sqlite3 engine', () => {
  let storage: StoragePort
  let engine: StigmergyEngine

  beforeEach(async () => {
    storage = new BetterSqlite3Storage(':memory:')
    engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
  })

  afterEach(async () => {
    await engine.close()
  })

  it('persists a pin with name and behavior, and pins the path edges (SC-03)', async () => {
    const pinned = await applyEditCommand(engine, {
      kind: 'pin',
      name: 'My Flow',
      behavior: 'enforce',
      capabilitySequence: ['tool:a', 'tool:b'],
    })
    expect(pinned?.behavior).toBe('enforce')
    expect(pinned?.name).toBe('My Flow')

    const paths = await engine.listPaths()
    expect(paths).toHaveLength(1)
    expect(paths[0]!.capabilitySequence).toEqual(['tool:a', 'tool:b'])

    const firstEdge = await storage.getEdge(START_NODE, 'tool:a')
    expect(firstEdge?.pinned).toBe(true)
  })

  it('deletes a hand-pinned path: the pin and its phantom edges go, a run-backed edge survives (SC-04, FEAT-06-06)', async () => {
    // A hand-pinned path with no run history: its edges exist only because of the pin (tauMax, no runs).
    const phantom = await applyEditCommand(engine, {
      kind: 'pin',
      behavior: 'preferred',
      capabilitySequence: ['tool:a', 'tool:b'],
    })
    expect((await storage.getEdge(START_NODE, 'tool:a'))?.pinned).toBe(true)

    await applyEditCommand(engine, { kind: 'unpin', pathId: phantom!.id })

    expect(await engine.listPaths()).toHaveLength(0)
    // The phantom edge is removed, so the deleted path leaves no full-strength gray ghost trail.
    expect(await storage.getEdge(START_NODE, 'tool:a')).toBeNull()

    // An edge with real run history survives a delete; only its pinned flag is dropped.
    await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
    const real = await applyEditCommand(engine, { kind: 'pin', behavior: 'preferred', capabilitySequence: ['tool:a', 'tool:b'] })
    await applyEditCommand(engine, { kind: 'unpin', pathId: real!.id })
    const kept = await storage.getEdge(START_NODE, 'tool:a')
    expect(kept).not.toBeNull()
    expect(kept?.pinned).toBe(false)
  })

  it('reinforce raises and weaken lowers the edge pheromone (SC-05)', async () => {
    // A real run lays down edges with history whose pheromone can move (and which survive a delete).
    await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })

    const before = (await storage.getEdge(START_NODE, 'tool:a'))!.pheromone
    await applyEditCommand(engine, { kind: 'weaken', path: ['tool:a', 'tool:b'], strength: 0.3 })
    const afterWeaken = (await storage.getEdge(START_NODE, 'tool:a'))!.pheromone
    expect(afterWeaken).toBeLessThan(before)

    await applyEditCommand(engine, { kind: 'reinforce', path: ['tool:a', 'tool:b'], strength: 0.3 })
    const afterReinforce = (await storage.getEdge(START_NODE, 'tool:a'))!.pheromone
    expect(afterReinforce).toBeGreaterThan(afterWeaken)
  })

  it('reconciles an orphaned pinned edge on a fresh engine init (FEAT-06-07)', async () => {
    // Give a->b real run history, then pin a path so its edges are pinned.
    await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
    const p = await applyEditCommand(engine, { kind: 'pin', behavior: 'sequence', capabilitySequence: ['tool:a', 'tool:b'] })
    // Simulate the field drift: drop the pinned-path record directly, leaving the edges pinned with no
    // covering path (a red trail the panel cannot list).
    await storage.deletePinnedPath(p!.id)
    expect((await storage.getEdge(START_NODE, 'tool:a'))?.pinned).toBe(true)

    // A fresh engine on the same storage reconciles on init: the orphan has run history, so it is
    // unpinned (kept as a learned gray edge), not deleted.
    await createEngine({ storage, embedding: new FakeEmbedding() })
    const after = await storage.getEdge(START_NODE, 'tool:a')
    expect(after).not.toBeNull()
    expect(after?.pinned).toBe(false)
  })

  it('reconcile deletes a phantom orphaned edge (pinned but never run) on fresh init (FEAT-06-07)', async () => {
    // A hand-pinned path with NO prior run: its edges are pure phantoms (tauMax, zero counts).
    const p = await applyEditCommand(engine, { kind: 'pin', behavior: 'sequence', capabilitySequence: ['tool:a', 'tool:b'] })
    expect((await storage.getEdge(START_NODE, 'tool:a'))?.pinned).toBe(true)
    // Drift: drop the pinned-path record, leaving the phantom edges pinned with no covering path.
    await storage.deletePinnedPath(p!.id)
    // A fresh engine on the same storage reconciles: a phantom orphan (no history) is removed entirely.
    await createEngine({ storage, embedding: new FakeEmbedding() })
    expect(await storage.getEdge(START_NODE, 'tool:a')).toBeNull()
    expect(await storage.getEdge('tool:a', 'tool:b')).toBeNull()
  })

  it('deletes a single learned edge by pair (FIX-06-06-01)', async () => {
    await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
    expect(await storage.getEdge('tool:a', 'tool:b')).not.toBeNull()
    await applyEditCommand(engine, { kind: 'deleteEdge', from: 'tool:a', to: 'tool:b' })
    expect(await storage.getEdge('tool:a', 'tool:b')).toBeNull()
  })

  it('refuses to delete an edge a pinned path covers (FIX-06-06-01)', async () => {
    await applyEditCommand(engine, { kind: 'pin', behavior: 'enforce', capabilitySequence: ['tool:a', 'tool:b'] })
    await expect(applyEditCommand(engine, { kind: 'deleteEdge', from: 'tool:a', to: 'tool:b' })).rejects.toThrow(/pinned path/)
    expect(await storage.getEdge('tool:a', 'tool:b')).not.toBeNull()
  })

  it('rejects an invalid command before touching the substrate', async () => {
    await expect(applyEditCommand(engine, { kind: 'pin', behavior: 'preferred', capabilitySequence: [] })).rejects.toThrow(
      /at least one capability/,
    )
    expect(await engine.listPaths()).toHaveLength(0)
  })
})

describe('validateEditCommand', () => {
  it('accepts a well-formed command', () => {
    expect(validateEditCommand({ kind: 'pin', behavior: 'sequence', capabilitySequence: ['tool:a'] })).toBeNull()
    expect(validateEditCommand({ kind: 'reinforce', path: ['tool:a'], strength: 0.2 })).toBeNull()
    expect(validateEditCommand({ kind: 'unpin', pathId: 'p1' })).toBeNull()
    expect(validateEditCommand({ kind: 'deleteEdge', from: 'tool:a', to: 'tool:b' })).toBeNull()
  })

  it('validates deleteEdge: non-empty, distinct endpoints (FIX-06-06-01)', () => {
    expect(validateEditCommand({ kind: 'deleteEdge', from: '  ', to: 'tool:b' })).toMatch(/endpoint/)
    expect(validateEditCommand({ kind: 'deleteEdge', from: 'tool:a', to: '' })).toMatch(/endpoint/)
    expect(validateEditCommand({ kind: 'deleteEdge', from: 'tool:a', to: 'tool:a' })).toMatch(/same/)
  })

  it('rejects the start sentinel as a path step (FEAT-06-06)', () => {
    expect(validateEditCommand({ kind: 'pin', behavior: 'preferred', capabilitySequence: [START_NODE, 'tool:a'] })).toMatch(/start node/)
  })

  it('rejects empty sequences, unknown behaviors, empty ids and non-positive strengths', () => {
    expect(validateEditCommand({ kind: 'pin', behavior: 'preferred', capabilitySequence: [] })).toMatch(/at least one/)
    // @ts-expect-error deliberately invalid behavior
    expect(validateEditCommand({ kind: 'pin', behavior: 'nope', capabilitySequence: ['tool:a'] })).toMatch(/Unknown pin behavior/)
    expect(validateEditCommand({ kind: 'unpin', pathId: '   ' })).toMatch(/path id/)
    expect(validateEditCommand({ kind: 'weaken', path: ['tool:a'], strength: 0 })).toMatch(/greater than zero/)
    expect(validateEditCommand({ kind: 'reinforce', path: [], strength: 1 })).toMatch(/non-empty path/)
  })
})
