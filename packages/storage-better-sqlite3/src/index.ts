// better-sqlite3 StoragePort adapter (Node). WAL plus busy_timeout per ADR-02.
// The synchronous better-sqlite3 API is wrapped behind the async StoragePort.
//
// SECURITY (AUDIT F-09, F-13): better-sqlite3 runs a native postinstall script, so the
// committed lockfile must stay integrity-pinned and `npm audit --omit=dev` belongs in CI.
// The constructor opens the host-supplied `path` verbatim (no normalize/allowlist); the host
// is the trust anchor and MUST NOT derive `path` from untrusted upstream input (path traversal /
// arbitrary-file-write by SQLite otherwise).

import Database from 'better-sqlite3'
import type { Database as BetterDb } from 'better-sqlite3'
import {
  SCHEMA_SQL,
  applyMigrations,
  START_NODE,
  rowToCapability,
  rowToEdge,
  rowToTask,
  rowToPinnedPath,
} from '@agentic-stigmergy/core'
import type {
  StoragePort,
  Capability,
  Edge,
  PinnedPath,
  Task,
  SubstrateStats,
  Transaction,
  CapRow,
  EdgeRow,
  TaskRow,
  PinnedRow,
} from '@agentic-stigmergy/core'

function embToBuf(a?: Float32Array): Buffer | null {
  if (!a) return null
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
}

export class BetterSqlite3Storage implements StoragePort {
  private readonly db: BetterDb
  private txDepth = 0

  constructor(path: string) {
    this.db = new Database(path)
  }

  async init(): Promise<void> {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA_SQL)
    const current = this.db.pragma('user_version', { simple: true }) as number
    // Migrate atomically so a crash mid-migration rolls back and the next open re-runs cleanly.
    this.db.exec('BEGIN')
    try {
      applyMigrations(
        current,
        (sql) => this.db.exec(sql),
        (v) => {
          this.db.pragma(`user_version = ${v}`)
        },
      )
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    const ts = new Date(0).toISOString()
    this.db
      .prepare('INSERT OR IGNORE INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)')
      .run(START_NODE, '__system__', 'start sentinel', ts, ts)
  }

  async getCapability(id: string): Promise<Capability | null> {
    const row = this.db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) as CapRow | undefined
    return row ? rowToCapability(row) : null
  }

  async upsertCapability(c: Capability): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO capabilities (id,type,description,description_embedding,description_augmented,augmented_at,augmented_by,source,embedding_model,first_seen,last_seen)
         VALUES (@id,@type,@description,@emb,@desc_aug,@aug_at,@aug_by,@source,@emb_model,@first_seen,@last_seen)
         ON CONFLICT(id) DO UPDATE SET
           type=@type, description=@description, description_embedding=@emb,
           description_augmented=@desc_aug, augmented_at=@aug_at, augmented_by=@aug_by,
           source=@source, embedding_model=@emb_model, first_seen=@first_seen, last_seen=@last_seen`,
      )
      .run({
        id: c.id,
        type: c.type,
        description: c.description,
        emb: embToBuf(c.descriptionEmbedding),
        desc_aug: c.descriptionAugmented ?? null,
        aug_at: c.augmentedAt ?? null,
        aug_by: c.augmentedBy ?? null,
        source: c.source ?? null,
        emb_model: c.embeddingModel ?? null,
        first_seen: c.firstSeen,
        last_seen: c.lastSeen,
      })
  }

  async listCapabilities(): Promise<Capability[]> {
    const rows = this.db
      .prepare("SELECT * FROM capabilities WHERE type != '__system__' ORDER BY id")
      .all() as CapRow[]
    return rows.map((r) => rowToCapability(r))
  }

  async getEdge(from: string, to: string): Promise<Edge | null> {
    const row = this.db
      .prepare('SELECT * FROM edges WHERE from_capability = ? AND to_capability = ?')
      .get(from, to) as EdgeRow | undefined
    return row ? rowToEdge(row) : null
  }

  async upsertEdge(e: Edge): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO edges (from_capability,to_capability,pheromone,success_count,failure_count,pinned,pin_behavior,pin_owner,last_updated)
         VALUES (@from,@to,@pheromone,@success,@failure,@pinned,@behavior,@owner,@updated)
         ON CONFLICT(from_capability,to_capability) DO UPDATE SET
           pheromone=@pheromone, success_count=@success, failure_count=@failure,
           pinned=@pinned, pin_behavior=@behavior, pin_owner=@owner, last_updated=@updated`,
      )
      .run({
        from: e.fromCapability,
        to: e.toCapability,
        pheromone: e.pheromone,
        success: e.successCount,
        failure: e.failureCount,
        pinned: e.pinned ? 1 : 0,
        behavior: e.pinBehavior,
        owner: e.pinOwner,
        updated: e.lastUpdated,
      })
  }

  async listOutgoingEdges(from: string): Promise<Edge[]> {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE from_capability = ? ORDER BY pheromone DESC')
      .all(from) as EdgeRow[]
    return rows.map((r) => rowToEdge(r))
  }

  async listEdges(): Promise<Edge[]> {
    const rows = this.db.prepare('SELECT * FROM edges').all() as EdgeRow[]
    return rows.map((r) => rowToEdge(r))
  }

  async deleteEdge(from: string, to: string): Promise<void> {
    this.db.prepare('DELETE FROM edges WHERE from_capability = ? AND to_capability = ?').run(from, to)
  }

  async upsertTask(t: Task): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id,context_text,context_embedding,path,outcome,token_cost,created_at,completed_at,source_host)
         VALUES (@id,@ctx,@emb,@path,@outcome,@cost,@created,@completed,@host)
         ON CONFLICT(id) DO UPDATE SET
           context_text=@ctx, context_embedding=@emb, path=@path, outcome=@outcome,
           token_cost=@cost, created_at=@created, completed_at=@completed, source_host=@host`,
      )
      .run({
        id: t.id,
        ctx: t.contextText,
        emb: embToBuf(t.contextEmbedding),
        path: JSON.stringify(t.path),
        outcome: t.outcome,
        cost: t.tokenCost,
        created: t.createdAt,
        completed: t.completedAt ?? null,
        host: t.sourceHost,
      })
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  async listTasks(): Promise<Task[]> {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]
    return rows.map((r) => rowToTask(r))
  }

  async deleteTask(id: string): Promise<void> {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  async upsertPinnedPath(p: PinnedPath): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pinned_paths (id,name,description,capability_sequence,parameters_template,behavior,when_to_use,when_to_use_embedding,name_embedding,named_at,named_by,path_source,created_at,created_by)
         VALUES (@id,@name,@description,@seq,@params,@behavior,@whenToUse,@whenEmb,@nameEmb,@namedAt,@namedBy,@pathSource,@created,@by)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, description=@description, capability_sequence=@seq,
           parameters_template=@params, behavior=@behavior, when_to_use=@whenToUse,
           when_to_use_embedding=@whenEmb, name_embedding=@nameEmb, named_at=@namedAt,
           named_by=@namedBy, path_source=@pathSource, created_at=@created, created_by=@by`,
      )
      .run({
        id: p.id,
        name: p.name ?? null,
        description: p.description ?? null,
        seq: JSON.stringify(p.capabilitySequence),
        params: p.parametersTemplate ? JSON.stringify(p.parametersTemplate) : null,
        behavior: p.behavior,
        whenToUse: p.whenToUse ?? null,
        whenEmb: embToBuf(p.whenToUseEmbedding),
        nameEmb: embToBuf(p.nameEmbedding),
        namedAt: p.namedAt ?? null,
        namedBy: p.namedBy ?? null,
        pathSource: p.pathSource ?? null,
        created: p.createdAt,
        by: p.createdBy ?? null,
      })
  }

  async getPinnedPath(id: string): Promise<PinnedPath | null> {
    const row = this.db.prepare('SELECT * FROM pinned_paths WHERE id = ?').get(id) as PinnedRow | undefined
    return row ? rowToPinnedPath(row) : null
  }

  async listPinnedPaths(): Promise<PinnedPath[]> {
    const rows = this.db.prepare('SELECT * FROM pinned_paths ORDER BY id').all() as PinnedRow[]
    return rows.map((r) => rowToPinnedPath(r))
  }

  async deletePinnedPath(id: string): Promise<void> {
    this.db.prepare('DELETE FROM pinned_paths WHERE id = ?').run(id)
  }

  async getStats(): Promise<SubstrateStats> {
    const caps = this.db
      .prepare("SELECT COUNT(*) AS n FROM capabilities WHERE type != '__system__'")
      .get() as { n: number }
    const edges = this.db.prepare('SELECT COUNT(*) AS n, AVG(pheromone) AS avg FROM edges').get() as {
      n: number
      avg: number | null
    }
    const tasks = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    const pinned = this.db.prepare('SELECT COUNT(*) AS n FROM pinned_paths').get() as { n: number }
    return {
      capabilities: caps.n,
      edges: edges.n,
      tasks: tasks.n,
      pinnedPaths: pinned.n,
      avgPheromone: edges.avg ?? 0,
    }
  }

  async getRuntimeConfig(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM runtime_config WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  async setRuntimeConfig(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date(0).toISOString())
  }

  async clearSubstrate(): Promise<void> {
    this.db.exec('DELETE FROM edges')
    this.db.exec('DELETE FROM tasks')
    this.db.exec('DELETE FROM pinned_paths')
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn(undefined)
    this.txDepth++
    // BEGIN IMMEDIATE declares write intent at BEGIN (ADR-19/ADR-20), removing the read-to-write
    // upgrade SQLITE_BUSY window when the loop, Studio and daemon write the same substrate. Reads
    // stay concurrent under WAL; a contended write retries within busy_timeout.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(undefined)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      // Guard the ROLLBACK so a rollback fault cannot mask the original error (AUDIT F-10).
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* keep the original error */
      }
      throw err
    } finally {
      this.txDepth--
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
