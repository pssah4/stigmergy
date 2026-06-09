// Single-writer role lock for the daemon (ADR-19, ADR-20, FEAT-04-04). A lock file next to the
// substrate ensures only one daemon serves a given substrate. Acquisition is atomic via O_EXCL
// (write flag 'wx'); an existing lock is reclaimed only when stale (its holder is dead on this host
// or its heartbeat is older than staleMs). Liveness is trustworthy only on the same host, so a
// cross-host lock falls back to the TTL. Clock, pid, host and the liveness probe are injectable so
// the logic is deterministic in tests (no real processes needed). This is NOT a per-transaction
// advisory lock (that is BEGIN IMMEDIATE plus busy_timeout in the storage adapter); it is a singleton
// guard for the daemon role.
import { writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { hostname } from 'node:os'

export interface LockRecord {
  role: string
  pid: number
  host: string
  updatedAt: number
}

export interface RoleLockOptions {
  /** A lock whose heartbeat is older than this is considered stale and reclaimable. */
  staleMs?: number
  nowMs?: () => number
  pid?: number
  host?: string
  /** Whether a holder pid is alive. Same-host only; cross-host returns true (fall back to TTL). */
  isAlive?: (pid: number, host: string) => boolean
}

export interface RoleLock {
  readonly path: string
  /** Re-stamp updatedAt so a healthy holder is never judged stale. */
  heartbeat(): void
  /** Remove the lock file (best-effort). */
  release(): void
}

const DEFAULT_STALE_MS = 30_000

function localIsAlive(pid: number, host: string): boolean {
  if (host !== hostname()) return true // cross-host: cannot probe, trust the TTL instead
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = the process exists but is not ours (still alive); ESRCH = no such process (dead).
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Acquire the role lock, or return null when a live holder already owns it. */
export function acquireRoleLock(path: string, role: string, opts: RoleLockOptions = {}): RoleLock | null {
  const nowMs = opts.nowMs ?? ((): number => Date.now())
  const pid = opts.pid ?? process.pid
  const host = opts.host ?? hostname()
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const isAlive = opts.isAlive ?? localIsAlive

  const record: LockRecord = { role, pid, host, updatedAt: nowMs() }
  const tryCreate = (): boolean => {
    record.updatedAt = nowMs()
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx' }) // wx = O_EXCL: fails if it exists
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw e
    }
  }

  if (tryCreate()) return makeHandle(path, record, nowMs)

  // It exists: reclaim only if stale.
  let existing: LockRecord | null = null
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as LockRecord
  } catch {
    existing = null // unreadable/corrupt lock counts as stale
  }
  const stale = !existing || nowMs() - existing.updatedAt >= staleMs || !isAlive(existing.pid, existing.host)
  if (!stale) return null

  // Reclaim atomically: rename the stale file aside instead of an unconditional unlink. rename moves
  // the single source `path`, so when two acquirers both see the same stale record only one rename
  // succeeds (the other gets ENOENT, since the source is already gone) and only one of them removes the
  // record. An unconditional unlink would let a slow acquirer delete a freshly-created lock, defeating
  // the O_EXCL guarantee. The winner then races a brand-new acquirer on tryCreate (wx), so at most one
  // handle is ever returned.
  const stolen = `${path}.stale.${pid}.${nowMs()}`
  try {
    renameSync(path, stolen)
  } catch {
    // Lost the steal (another acquirer already renamed/removed it). The slot may be free now; the
    // O_EXCL create below still arbitrates a single winner, otherwise we back off.
    return tryCreate() ? makeHandle(path, record, nowMs) : null
  }
  try {
    unlinkSync(stolen)
  } catch {
    /* the stolen copy is ours; failing to clean it up is harmless */
  }
  return tryCreate() ? makeHandle(path, record, nowMs) : null
}

function makeHandle(path: string, record: LockRecord, nowMs: () => number): RoleLock {
  return {
    path,
    heartbeat(): void {
      record.updatedAt = nowMs()
      try {
        writeFileSync(path, JSON.stringify(record))
      } catch {
        /* best-effort: a failed heartbeat just risks a premature stale reclaim */
      }
    },
    release(): void {
      try {
        unlinkSync(path)
      } catch {
        /* already gone */
      }
    },
  }
}
