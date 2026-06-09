import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { acquireRoleLock, type LockRecord } from './role-lock.js'

describe('acquireRoleLock (EPIC-04 FEAT-04-04, ADR-19)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-lock-'))
    path = join(dir, 'daemon.lock')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const alive = (): boolean => true
  const dead = (): boolean => false

  it('acquires a fresh lock and writes the record', () => {
    const lock = acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })
    expect(lock).not.toBeNull()
    expect(existsSync(path)).toBe(true)
    const rec = JSON.parse(readFileSync(path, 'utf8')) as LockRecord
    expect(rec).toMatchObject({ role: 'daemon', pid: 1, host: 'h' })
  })

  it('refuses a second acquirer while a live holder owns it', () => {
    expect(acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })).not.toBeNull()
    const second = acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 1500, isAlive: alive })
    expect(second).toBeNull() // a live holder is never stolen
  })

  it('re-acquires after the holder releases', () => {
    const first = acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })!
    first.release()
    expect(existsSync(path)).toBe(false)
    expect(acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 2000, isAlive: alive })).not.toBeNull()
  })

  it('reclaims a stale lock whose heartbeat is older than staleMs', () => {
    acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })
    // a new acquirer far in the future sees the heartbeat as stale and reclaims
    const reclaimed = acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 1000 + 60_000, staleMs: 30_000, isAlive: alive })
    expect(reclaimed).not.toBeNull()
    expect((JSON.parse(readFileSync(path, 'utf8')) as LockRecord).pid).toBe(2)
  })

  it('reclaims a lock whose holder pid is dead (same host)', () => {
    acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })
    const reclaimed = acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 1500, staleMs: 30_000, isAlive: dead })
    expect(reclaimed).not.toBeNull()
    expect((JSON.parse(readFileSync(path, 'utf8')) as LockRecord).pid).toBe(2)
  })

  it('keeps a live holder after a heartbeat pushes its timestamp forward', () => {
    const held = acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })!
    held.heartbeat() // re-stamp (with the same nowMs here, but proves the file is rewritten)
    const second = acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 1500, staleMs: 30_000, isAlive: alive })
    expect(second).toBeNull()
  })

  // Hardening (pre-merge review wxfcn1jf7): reclaim renames the stale file aside (atomic single-winner)
  // instead of an unconditional unlink. The renamed copy must be cleaned up, leaving only the lock file.
  it('leaves no .stale leftover after reclaiming a stale lock', () => {
    acquireRoleLock(path, 'daemon', { pid: 1, host: 'h', nowMs: () => 1000, isAlive: alive })
    const reclaimed = acquireRoleLock(path, 'daemon', { pid: 2, host: 'h', nowMs: () => 1000 + 60_000, staleMs: 30_000, isAlive: alive })
    expect(reclaimed).not.toBeNull()
    const leftovers = readdirSync(dir).filter((f) => f !== basename(path))
    expect(leftovers).toEqual([]) // only daemon.lock remains; the .stale.* copy was removed
  })
})
