import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, FakeEmbedding, START_NODE } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { readSnapshotFromDb, readConnectionTasks, parseSequence } from './snapshot-mapping.js'

// Integration test for the main process' substrate read: seed a real substrate file through the
// engine, then read it back through readSnapshotFromDb (a fresh read-only connection, exactly as the
// Electron main does) and verify the row-to-view mapping. No Electron involved.

describe('readSnapshotFromDb against a real substrate', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-snapshot-'))
    dbPath = join(dir, 'pheromone.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads enabled=false by default and =true after the flag is set (EPIC-04 FEAT-04-06)', async () => {
    const storage = new BetterSqlite3Storage(dbPath)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.close()
    const db0 = new Database(dbPath, { readonly: true, fileMustExist: true })
    expect(readSnapshotFromDb(db0).enabled).toBe(false) // v4 substrate, no 'enabled' row
    db0.close()

    const storage2 = new BetterSqlite3Storage(dbPath)
    const engine2 = await createEngine({ storage: storage2, embedding: new FakeEmbedding() })
    await engine2.setRuntimeFlag('enabled', '1')
    await engine2.close()
    const db1 = new Database(dbPath, { readonly: true, fileMustExist: true })
    expect(readSnapshotFromDb(db1).enabled).toBe(true)
    db1.close()
  })

  it('maps capabilities, edges and a pinned path, and excludes the system sentinel', async () => {
    const storage = new BetterSqlite3Storage(dbPath)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    await engine.registerCapability({ id: 'mcp:b', type: 'mcp', description: 'beta' })
    await engine.pinPath({ name: 'Flow', behavior: 'enforce', capability_sequence: ['tool:a', 'mcp:b'], when_to_use: 'fixing a failing test' })
    await engine.close()

    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const snapshot = readSnapshotFromDb(db)
    db.close()

    // capabilities: the two registered, never the __system__ START sentinel
    expect(snapshot.capabilities.map((c) => c.id).sort()).toEqual(['mcp:b', 'tool:a'])
    expect(snapshot.capabilities.some((c) => c.id === START_NODE)).toBe(false)

    // FEAT-04-01 SC-06: the poll selects the new `source` column; a registered (not discovered)
    // capability has a NULL source and reads as 'observed'.
    expect(snapshot.capabilities.every((c) => c.source === 'observed')).toBe(true)

    // a pinned path produces the START->tool:a edge, mapped pinned=true
    const firstEdge = snapshot.edges.find((e) => e.fromCapability === START_NODE && e.toCapability === 'tool:a')
    expect(firstEdge?.pinned).toBe(true)
    expect(typeof firstEdge?.pheromone).toBe('number')

    // pinned path view carries id/name/behavior/sequence and the whenToUse purpose gate (FEAT-06-05)
    expect(snapshot.pinnedPaths).toHaveLength(1)
    expect(snapshot.pinnedPaths![0]).toMatchObject({ name: 'Flow', behavior: 'enforce', capabilitySequence: ['tool:a', 'mcp:b'], whenToUse: 'fixing a failing test' })

    expect(snapshot.taskCount).toBe(0)
  })

  it('readConnectionTasks returns the tasks that traversed a learned connection, and START edges (BL-012)', async () => {
    const storage = new BetterSqlite3Storage(dbPath)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
    await engine.registerCapability({ id: 'tool:c', type: 'tool', description: 'gamma' })
    // two real runs lay pheromone along START->a->b with their task contexts
    await engine.deposit({ task_id: 't1', context: 'summarise the morning digest', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
    await engine.deposit({ task_id: 't2', context: 'draft the weekly report', path: ['tool:a', 'tool:b'], outcome: 'abandoned', token_cost: 50 })
    // a different run touches a->c only
    await engine.deposit({ task_id: 't3', context: 'tag the inbox notes', path: ['tool:a', 'tool:c'], outcome: 'accepted', token_cost: 30 })
    await engine.close()

    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const ab = readConnectionTasks(db, 'tool:a', 'tool:b')
      expect(ab.map((t) => t.context).sort()).toEqual(['draft the weekly report', 'summarise the morning digest'])
      expect(ab.find((t) => t.context === 'draft the weekly report')?.outcome).toBe('abandoned')

      // the START->a edge (first step) is matched by all three runs
      expect(readConnectionTasks(db, START_NODE, 'tool:a')).toHaveLength(3)

      // a connection no task traversed yields nothing
      expect(readConnectionTasks(db, 'tool:b', 'tool:c')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('tolerates a pre-v3 substrate that has no source column (read-only path never migrates)', () => {
    // The Studio reads read-only and never migrates. A v2 substrate (written by an older loop) has
    // no `capabilities.source` column, so selecting it verbatim would throw "no such column" and crash
    // the 2s poll. readSnapshotFromDb must detect the missing column and default source to 'observed'.
    const v2 = new Database(dbPath)
    v2.exec(`
      CREATE TABLE capabilities (id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT, description_augmented TEXT);
      CREATE TABLE edges (from_capability TEXT, to_capability TEXT, pheromone REAL, pinned INTEGER);
      CREATE TABLE pinned_paths (id TEXT PRIMARY KEY, name TEXT, behavior TEXT, capability_sequence TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, context_text TEXT, outcome TEXT, token_cost INTEGER, created_at TEXT);
    `)
    v2.prepare('INSERT INTO capabilities (id,type,description) VALUES (?,?,?)').run('tool:a', 'tool', 'alpha')
    // a pinned path on the old schema lacks the when_to_use column entirely (FEAT-06-05 guard)
    v2.prepare('INSERT INTO pinned_paths (id,name,behavior,capability_sequence) VALUES (?,?,?,?)').run('pin-1', 'Old', 'preferred', '["tool:a"]')
    v2.close()

    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const snapshot = readSnapshotFromDb(db)
    db.close()

    expect(snapshot.capabilities.map((c) => c.id)).toEqual(['tool:a'])
    expect(snapshot.capabilities[0]!.source).toBe('observed')
    // the missing when_to_use column must not crash the poll; it reads as undefined
    expect(snapshot.pinnedPaths![0]).toMatchObject({ id: 'pin-1', name: 'Old' })
    expect(snapshot.pinnedPaths![0]!.whenToUse).toBeUndefined()
  })

  it('reads an empty (freshly initialised) substrate as an empty snapshot', async () => {
    const storage = new BetterSqlite3Storage(dbPath)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.close()

    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const snapshot = readSnapshotFromDb(db)
    db.close()

    expect(snapshot.capabilities).toEqual([])
    expect(snapshot.edges).toEqual([])
    expect(snapshot.pinnedPaths).toEqual([])
    expect(snapshot.taskCount).toBe(0)
  })

  it('counts a resolved task so connect-verify can detect a live loop (taskCount rises on deposit)', async () => {
    const storage = new BetterSqlite3Storage(dbPath)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
    // A task row is persisted when the task resolves (deposit), not on a bare consult; this is the
    // signal connect-verify watches (a wired loop completing a task raises taskCount and changes edges).
    await engine.deposit({ task_id: 't1', context: 'alpha', path: ['tool:a'], outcome: 'accepted', token_cost: 1000 })
    await engine.close()

    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const snapshot = readSnapshotFromDb(db)
    db.close()

    expect(snapshot.taskCount).toBe(1)
    expect(snapshot.edges.some((e) => e.toCapability === 'tool:a')).toBe(true) // deposit also changed edges
  })
})

describe('parseSequence', () => {
  it('parses a JSON array of strings', () => {
    expect(parseSequence('["tool:a","tool:b"]')).toEqual(['tool:a', 'tool:b'])
  })
  it('returns an empty array for null, malformed JSON or a non-array', () => {
    expect(parseSequence(null)).toEqual([])
    expect(parseSequence('not json')).toEqual([])
    expect(parseSequence('{"a":1}')).toEqual([])
  })
  it('filters out non-string entries', () => {
    expect(parseSequence('["tool:a", 5, null, "tool:b"]')).toEqual(['tool:a', 'tool:b'])
  })
})
