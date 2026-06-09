import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { defineStorageConformance } from '@stigmergy/storage-conformance'
import { createSqlJsStorage, SqlJsStorage } from './index.js'

defineStorageConformance('sql.js (in-memory)', () => createSqlJsStorage())

describe('schema migration v1 -> v2 (FEAT-01-07)', () => {
  it('adds the augmentation columns to an existing v1 sql.js substrate and keeps the data', async () => {
    const req = createRequire(import.meta.url)
    const file = readFileSync(req.resolve('sql.js/dist/sql-wasm.wasm'))
    const wasmBinary = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    const SQL = await initSqlJs({ wasmBinary })

    // Build a v1-shaped in-memory DB: old capabilities table (no augmentation columns), user_version 1.
    const db = new SQL.Database()
    db.run(
      `CREATE TABLE capabilities (
         id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT,
         description_embedding BLOB, first_seen TEXT, last_seen TEXT
       );
       CREATE TABLE pinned_paths (
         id TEXT PRIMARY KEY, name TEXT, description TEXT, capability_sequence TEXT,
         parameters_template TEXT, behavior TEXT, created_at TEXT, created_by TEXT
       );`,
    )
    db.run('PRAGMA user_version = 1')
    db.run('INSERT INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)', [
      'tool:old',
      'tool',
      'old desc',
      't',
      't',
    ])

    const storage = new SqlJsStorage(db)
    await storage.init() // migrates v1 -> v2

    const versionRow = db.exec('PRAGMA user_version')[0]?.values[0]
    // A v1 substrate migrates all the way to the current version (every later migration runs).
    expect(Number(versionRow?.[0])).toBe(5)

    const cap = await storage.getCapability('tool:old')
    expect(cap?.description).toBe('old desc')
    expect(cap?.descriptionAugmented).toBeUndefined()

    await storage.upsertCapability({
      ...cap!,
      descriptionAugmented: 'rich desc',
      augmentedBy: 'fake-model',
      augmentedAt: '2026-01-01T00:00:00.000Z',
    })
    const back = await storage.getCapability('tool:old')
    expect(back?.descriptionAugmented).toBe('rich desc')
    await storage.close()
  })
})

describe('schema migration v2 -> v3 (EPIC-04 FEAT-04-01)', () => {
  it('adds the inventory/whenToUse/naming columns to a v2 sql.js substrate and keeps the data', async () => {
    const req = createRequire(import.meta.url)
    const file = readFileSync(req.resolve('sql.js/dist/sql-wasm.wasm'))
    const wasmBinary = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    const SQL = await initSqlJs({ wasmBinary })

    // Build a v2-shaped in-memory DB: capabilities with augmentation columns but no `source`,
    // pinned_paths without the whenToUse/naming columns, user_version 2.
    const db = new SQL.Database()
    db.run(
      `CREATE TABLE capabilities (
         id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT, description_embedding BLOB,
         description_augmented TEXT, augmented_at TEXT, augmented_by TEXT, first_seen TEXT, last_seen TEXT
       );
       CREATE TABLE pinned_paths (
         id TEXT PRIMARY KEY, name TEXT, description TEXT, capability_sequence TEXT,
         parameters_template TEXT, behavior TEXT, created_at TEXT, created_by TEXT
       );`,
    )
    db.run('PRAGMA user_version = 2')
    db.run('INSERT INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)', [
      'tool:old',
      'tool',
      'old desc',
      't',
      't',
    ])
    db.run('INSERT INTO pinned_paths (id,name,capability_sequence,behavior,created_at) VALUES (?,?,?,?,?)', [
      'p:old',
      'flow',
      '["tool:old"]',
      'preferred',
      't',
    ])

    const storage = new SqlJsStorage(db)
    await storage.init() // migrates v2 -> current (v3 columns + v4 runtime_config)

    const versionRow = db.exec('PRAGMA user_version')[0]?.values[0]
    expect(Number(versionRow?.[0])).toBe(5)
    // v4 created the runtime_config table on the upgrade path
    expect(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_config'")[0]?.values.length).toBe(1)

    const cap = await storage.getCapability('tool:old')
    expect(cap?.description).toBe('old desc')
    expect(cap?.source).toBe('observed') // NULL coerced to the default

    const pin = await storage.getPinnedPath('p:old')
    expect(pin?.name).toBe('flow')
    expect(pin?.pathSource).toBe('manual')
    expect(pin?.whenToUse).toBeUndefined()
    await storage.close()
  })
})
