import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { defineStorageConformance } from '@stigmergy/storage-conformance'
import { BetterSqlite3Storage } from './index.js'

defineStorageConformance('better-sqlite3 (:memory:)', async () => new BetterSqlite3Storage(':memory:'))

describe('schema migration v1 -> v2 (FEAT-01-07)', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('adds the augmentation columns to an existing v1 substrate and keeps the data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sqlite-migrate-'))
    const dbPath = join(dir, 'v1.db')

    // Build a v1-shaped database: the old capabilities table (no augmentation columns), user_version 1.
    const raw = new Database(dbPath)
    raw.exec(
      `CREATE TABLE capabilities (
         id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT,
         description_embedding BLOB, first_seen TEXT, last_seen TEXT
       );
       CREATE TABLE pinned_paths (
         id TEXT PRIMARY KEY, name TEXT, description TEXT, capability_sequence TEXT,
         parameters_template TEXT, behavior TEXT, created_at TEXT, created_by TEXT
       );`,
    )
    raw.pragma('user_version = 1')
    raw
      .prepare('INSERT INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)')
      .run('tool:old', 'tool', 'old desc', 't', 't')
    raw.close()

    // Opening through the adapter runs init, which migrates v1 -> v2.
    const storage = new BetterSqlite3Storage(dbPath)
    await storage.init()
    try {
      const probe = new Database(dbPath)
      // A v1 substrate migrates all the way to the current version (every later migration runs).
      expect(probe.pragma('user_version', { simple: true })).toBe(5)
      probe.close()

      const cap = await storage.getCapability('tool:old')
      expect(cap?.description).toBe('old desc') // pre-existing data preserved
      expect(cap?.descriptionAugmented).toBeUndefined() // new column present, value null

      // The new columns are writable (round-trip an augmented capability).
      await storage.upsertCapability({
        ...cap!,
        descriptionAugmented: 'rich desc',
        augmentedBy: 'fake-model',
        augmentedAt: '2026-01-01T00:00:00.000Z',
      })
      const back = await storage.getCapability('tool:old')
      expect(back?.descriptionAugmented).toBe('rich desc')
      expect(back?.augmentedBy).toBe('fake-model')
    } finally {
      await storage.close()
    }
  })

  it('never downgrades a substrate stamped newer than USER_VERSION', async () => {
    const d2 = await mkdtemp(join(tmpdir(), 'sqlite-newer-'))
    const dbPath = join(d2, 'v3.db')
    const raw = new Database(dbPath)
    raw.exec(
      `CREATE TABLE capabilities (id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT,
         description_embedding BLOB, description_augmented TEXT, augmented_at TEXT, augmented_by TEXT,
         first_seen TEXT, last_seen TEXT);`,
    )
    raw.pragma('user_version = 99') // a future schema version
    raw.close()

    const storage = new BetterSqlite3Storage(dbPath)
    await storage.init()
    try {
      const probe = new Database(dbPath)
      expect(probe.pragma('user_version', { simple: true })).toBe(99) // a newer DB is never downgraded
      probe.close()
    } finally {
      await storage.close()
      await rm(d2, { recursive: true, force: true })
    }
  })
})

describe('schema migration v2 -> v3 (EPIC-04 FEAT-04-01)', () => {
  it('adds the inventory/whenToUse/naming columns to a v2 substrate and keeps the data', async () => {
    const d3 = await mkdtemp(join(tmpdir(), 'sqlite-migrate-v3-'))
    const dbPath = join(d3, 'v2.db')

    // Build a v2-shaped database: capabilities with the augmentation columns but no `source`,
    // pinned_paths without the whenToUse/naming columns, user_version 2.
    const raw = new Database(dbPath)
    raw.exec(
      `CREATE TABLE capabilities (
         id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT, description_embedding BLOB,
         description_augmented TEXT, augmented_at TEXT, augmented_by TEXT, first_seen TEXT, last_seen TEXT
       );
       CREATE TABLE pinned_paths (
         id TEXT PRIMARY KEY, name TEXT, description TEXT, capability_sequence TEXT,
         parameters_template TEXT, behavior TEXT, created_at TEXT, created_by TEXT
       );`,
    )
    raw.pragma('user_version = 2')
    raw
      .prepare('INSERT INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)')
      .run('tool:old', 'tool', 'old desc', 't', 't')
    raw
      .prepare('INSERT INTO pinned_paths (id,name,capability_sequence,behavior,created_at) VALUES (?,?,?,?,?)')
      .run('p:old', 'flow', '["tool:old"]', 'preferred', 't')
    raw.close()

    const storage = new BetterSqlite3Storage(dbPath)
    await storage.init() // migrates v2 -> current (v3 columns + v4 runtime_config)
    try {
      const probe = new Database(dbPath)
      expect(probe.pragma('user_version', { simple: true })).toBe(5)
      // v4 created the runtime_config table on the upgrade path
      expect(probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_config'").get()).toBeTruthy()
      probe.close()

      const cap = await storage.getCapability('tool:old')
      expect(cap?.description).toBe('old desc') // data preserved
      expect(cap?.source).toBe('observed') // NULL coerced to the default

      const pin = await storage.getPinnedPath('p:old')
      expect(pin?.name).toBe('flow')
      expect(pin?.pathSource).toBe('manual') // NULL coerced to the default
      expect(pin?.whenToUse).toBeUndefined()
    } finally {
      await storage.close()
      await rm(d3, { recursive: true, force: true })
    }
  })
})
