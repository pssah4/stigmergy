import { describe, it, expect } from 'vitest'
import { USER_VERSION, MIGRATIONS, SCHEMA_SQL, applyMigrations } from './schema.js'

// FEAT-04-01: one unified v3 migration introduces every new column (capabilities.source plus the
// pinned_paths whenToUse/naming columns) in a single step, so no two features collide on user_version.

describe('schema v3 (EPIC-04 FEAT-04-01)', () => {
  it('is at the current user_version', () => {
    expect(USER_VERSION).toBe(5)
  })

  it('has exactly one v3 migration that adds all new columns', () => {
    const v3 = MIGRATIONS.filter((m) => m.to === 3)
    expect(v3).toHaveLength(1)
    const sql = v3[0]!.sql
    expect(sql).toContain('ALTER TABLE capabilities ADD COLUMN source')
    for (const col of ['when_to_use', 'when_to_use_embedding', 'named_at', 'named_by', 'name_embedding', 'path_source']) {
      expect(sql).toContain(`ALTER TABLE pinned_paths ADD COLUMN ${col}`)
    }
  })

  it('has exactly one v4 migration that creates the runtime_config table (EPIC-04 FEAT-04-06)', () => {
    const v4 = MIGRATIONS.filter((m) => m.to === 4)
    expect(v4).toHaveLength(1)
    expect(v4[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS runtime_config')
  })

  it('has exactly one v5 migration that adds the embedding_model column (EPIC-04 FEAT-04-07)', () => {
    const v5 = MIGRATIONS.filter((m) => m.to === 5)
    expect(v5).toHaveLength(1)
    expect(v5[0]!.sql).toContain('ALTER TABLE capabilities ADD COLUMN embedding_model')
  })

  it('fresh schema declares the v3 columns, the runtime_config table and embedding_model', () => {
    expect(SCHEMA_SQL).toMatch(/source TEXT/)
    expect(SCHEMA_SQL).toMatch(/when_to_use TEXT/)
    expect(SCHEMA_SQL).toMatch(/name_embedding BLOB/)
    expect(SCHEMA_SQL).toMatch(/path_source TEXT/)
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS runtime_config/)
    expect(SCHEMA_SQL).toMatch(/embedding_model TEXT/)
  })

  it('migrates a v4 database forward by running only the v5 migration, then stamps 5', () => {
    const execd: string[] = []
    let stamped = -1
    applyMigrations(
      4,
      (sql) => execd.push(sql),
      (v) => {
        stamped = v
      },
    )
    expect(execd).toHaveLength(1)
    expect(execd[0]).toContain('embedding_model')
    expect(stamped).toBe(5)
  })

  it('runs the v2..v5 migrations for a v1 database', () => {
    const execd: string[] = []
    applyMigrations(
      1,
      (sql) => execd.push(sql),
      () => {},
    )
    expect(execd).toHaveLength(4)
  })

  it('stamps a fresh database (current 0) to the current version without running migrations', () => {
    const execd: string[] = []
    let stamped = -1
    applyMigrations(
      0,
      (sql) => execd.push(sql),
      (v) => {
        stamped = v
      },
    )
    expect(execd).toHaveLength(0)
    expect(stamped).toBe(5)
  })

  it('is a no-op for a database already at the current version', () => {
    const execd: string[] = []
    let stamped = -1
    applyMigrations(
      5,
      (sql) => execd.push(sql),
      (v) => {
        stamped = v
      },
    )
    expect(execd).toHaveLength(0)
    expect(stamped).toBe(-1)
  })
})
