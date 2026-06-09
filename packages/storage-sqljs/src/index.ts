// sql.js (WASM) StoragePort adapter (sandbox, in-memory, single-owner). The
// same conformance suite as the better-sqlite3 adapter runs against this, which
// proves schema, SQL semantics, and roundtrip equivalence (ADR-02).

import initSqlJs from 'sql.js'
import type { Database as SqlDb, SqlJsStatic, BindParams } from 'sql.js'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const require = createRequire(import.meta.url)
    const file = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
    const wasmBinary = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    sqlJsPromise = initSqlJs({ wasmBinary })
  }
  return sqlJsPromise
}

function embToBlob(a?: Float32Array): Uint8Array | null {
  if (!a) return null
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength))
}

export class SqlJsStorage implements StoragePort {
  private txDepth = 0

  constructor(private readonly db: SqlDb) {}

  async init(): Promise<void> {
    this.db.run('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA_SQL)
    const res = this.db.exec('PRAGMA user_version')
    const row0 = res[0]?.values[0]
    const current = row0 ? Number(row0[0] ?? 0) : 0
    // Migrate atomically so a crash mid-migration rolls back and the next open re-runs cleanly.
    this.db.run('BEGIN')
    try {
      applyMigrations(
        current,
        (sql) => this.db.exec(sql),
        (v) => {
          this.db.run(`PRAGMA user_version = ${v}`)
        },
      )
      this.db.run('COMMIT')
    } catch (e) {
      this.db.run('ROLLBACK')
      throw e
    }
    const ts = new Date(0).toISOString()
    this.db.run('INSERT OR IGNORE INTO capabilities (id,type,description,first_seen,last_seen) VALUES (?,?,?,?,?)', [
      START_NODE,
      '__system__',
      'start sentinel',
      ts,
      ts,
    ])
  }

  async getCapability(id: string): Promise<Capability | null> {
    const row = this.one<CapRow>('SELECT * FROM capabilities WHERE id = ?', [id])
    return row ? rowToCapability(row) : null
  }

  async upsertCapability(c: Capability): Promise<void> {
    this.db.run(
      `INSERT INTO capabilities (id,type,description,description_embedding,description_augmented,augmented_at,augmented_by,source,embedding_model,first_seen,last_seen)
       VALUES (:id,:type,:description,:emb,:desc_aug,:aug_at,:aug_by,:source,:emb_model,:first_seen,:last_seen)
       ON CONFLICT(id) DO UPDATE SET
         type=:type, description=:description, description_embedding=:emb,
         description_augmented=:desc_aug, augmented_at=:aug_at, augmented_by=:aug_by,
         source=:source, embedding_model=:emb_model, first_seen=:first_seen, last_seen=:last_seen`,
      {
        ':id': c.id,
        ':type': c.type,
        ':description': c.description,
        ':emb': embToBlob(c.descriptionEmbedding),
        ':desc_aug': c.descriptionAugmented ?? null,
        ':aug_at': c.augmentedAt ?? null,
        ':aug_by': c.augmentedBy ?? null,
        ':source': c.source ?? null,
        ':emb_model': c.embeddingModel ?? null,
        ':first_seen': c.firstSeen,
        ':last_seen': c.lastSeen,
      } as BindParams,
    )
  }

  async listCapabilities(): Promise<Capability[]> {
    return this.all<CapRow>("SELECT * FROM capabilities WHERE type != '__system__' ORDER BY id").map((r) =>
      rowToCapability(r),
    )
  }

  async getEdge(from: string, to: string): Promise<Edge | null> {
    const row = this.one<EdgeRow>('SELECT * FROM edges WHERE from_capability = ? AND to_capability = ?', [from, to])
    return row ? rowToEdge(row) : null
  }

  async upsertEdge(e: Edge): Promise<void> {
    this.db.run(
      `INSERT INTO edges (from_capability,to_capability,pheromone,success_count,failure_count,pinned,pin_behavior,pin_owner,last_updated)
       VALUES (:from,:to,:pheromone,:success,:failure,:pinned,:behavior,:owner,:updated)
       ON CONFLICT(from_capability,to_capability) DO UPDATE SET
         pheromone=:pheromone, success_count=:success, failure_count=:failure,
         pinned=:pinned, pin_behavior=:behavior, pin_owner=:owner, last_updated=:updated`,
      {
        ':from': e.fromCapability,
        ':to': e.toCapability,
        ':pheromone': e.pheromone,
        ':success': e.successCount,
        ':failure': e.failureCount,
        ':pinned': e.pinned ? 1 : 0,
        ':behavior': e.pinBehavior,
        ':owner': e.pinOwner,
        ':updated': e.lastUpdated,
      } as BindParams,
    )
  }

  async listOutgoingEdges(from: string): Promise<Edge[]> {
    return this.all<EdgeRow>('SELECT * FROM edges WHERE from_capability = ? ORDER BY pheromone DESC', [from]).map((r) =>
      rowToEdge(r),
    )
  }

  async listEdges(): Promise<Edge[]> {
    return this.all<EdgeRow>('SELECT * FROM edges').map((r) => rowToEdge(r))
  }

  async deleteEdge(from: string, to: string): Promise<void> {
    this.db.run('DELETE FROM edges WHERE from_capability = ? AND to_capability = ?', [from, to])
  }

  async upsertTask(t: Task): Promise<void> {
    this.db.run(
      `INSERT INTO tasks (id,context_text,context_embedding,path,outcome,token_cost,created_at,completed_at,source_host)
       VALUES (:id,:ctx,:emb,:path,:outcome,:cost,:created,:completed,:host)
       ON CONFLICT(id) DO UPDATE SET
         context_text=:ctx, context_embedding=:emb, path=:path, outcome=:outcome,
         token_cost=:cost, created_at=:created, completed_at=:completed, source_host=:host`,
      {
        ':id': t.id,
        ':ctx': t.contextText,
        ':emb': embToBlob(t.contextEmbedding),
        ':path': JSON.stringify(t.path),
        ':outcome': t.outcome,
        ':cost': t.tokenCost,
        ':created': t.createdAt,
        ':completed': t.completedAt ?? null,
        ':host': t.sourceHost,
      } as BindParams,
    )
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.one<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id])
    return row ? rowToTask(row) : null
  }

  async listTasks(): Promise<Task[]> {
    return this.all<TaskRow>('SELECT * FROM tasks ORDER BY created_at').map((r) => rowToTask(r))
  }

  async deleteTask(id: string): Promise<void> {
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  async upsertPinnedPath(p: PinnedPath): Promise<void> {
    this.db.run(
      `INSERT INTO pinned_paths (id,name,description,capability_sequence,parameters_template,behavior,when_to_use,when_to_use_embedding,name_embedding,named_at,named_by,path_source,created_at,created_by)
       VALUES (:id,:name,:description,:seq,:params,:behavior,:whenToUse,:whenEmb,:nameEmb,:namedAt,:namedBy,:pathSource,:created,:by)
       ON CONFLICT(id) DO UPDATE SET
         name=:name, description=:description, capability_sequence=:seq,
         parameters_template=:params, behavior=:behavior, when_to_use=:whenToUse,
         when_to_use_embedding=:whenEmb, name_embedding=:nameEmb, named_at=:namedAt,
         named_by=:namedBy, path_source=:pathSource, created_at=:created, created_by=:by`,
      {
        ':id': p.id,
        ':name': p.name ?? null,
        ':description': p.description ?? null,
        ':seq': JSON.stringify(p.capabilitySequence),
        ':params': p.parametersTemplate ? JSON.stringify(p.parametersTemplate) : null,
        ':behavior': p.behavior,
        ':whenToUse': p.whenToUse ?? null,
        ':whenEmb': embToBlob(p.whenToUseEmbedding),
        ':nameEmb': embToBlob(p.nameEmbedding),
        ':namedAt': p.namedAt ?? null,
        ':namedBy': p.namedBy ?? null,
        ':pathSource': p.pathSource ?? null,
        ':created': p.createdAt,
        ':by': p.createdBy ?? null,
      } as BindParams,
    )
  }

  async getPinnedPath(id: string): Promise<PinnedPath | null> {
    const row = this.one<PinnedRow>('SELECT * FROM pinned_paths WHERE id = ?', [id])
    return row ? rowToPinnedPath(row) : null
  }

  async listPinnedPaths(): Promise<PinnedPath[]> {
    return this.all<PinnedRow>('SELECT * FROM pinned_paths ORDER BY id').map((r) => rowToPinnedPath(r))
  }

  async deletePinnedPath(id: string): Promise<void> {
    this.db.run('DELETE FROM pinned_paths WHERE id = ?', [id])
  }

  async getStats(): Promise<SubstrateStats> {
    const caps = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM capabilities WHERE type != '__system__'", [])
    const edges = this.one<{ n: number; avg: number | null }>('SELECT COUNT(*) AS n, AVG(pheromone) AS avg FROM edges', [])
    const tasks = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM tasks', [])
    const pinned = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM pinned_paths', [])
    return {
      capabilities: caps?.n ?? 0,
      edges: edges?.n ?? 0,
      tasks: tasks?.n ?? 0,
      pinnedPaths: pinned?.n ?? 0,
      avgPheromone: edges?.avg ?? 0,
    }
  }

  async getRuntimeConfig(key: string): Promise<string | null> {
    const row = this.one<{ value: string }>('SELECT value FROM runtime_config WHERE key = ?', [key])
    return row ? row.value : null
  }

  async setRuntimeConfig(key: string, value: string): Promise<void> {
    this.db.run(
      `INSERT INTO runtime_config (key, value, updated_at) VALUES (:key, :value, :updated)
       ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = :updated`,
      { ':key': key, ':value': value, ':updated': new Date(0).toISOString() } as BindParams,
    )
  }

  async clearSubstrate(): Promise<void> {
    this.db.run('DELETE FROM edges')
    this.db.run('DELETE FROM tasks')
    this.db.run('DELETE FROM pinned_paths')
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn(undefined)
    this.txDepth++
    this.db.run('BEGIN')
    try {
      const result = await fn(undefined)
      this.db.run('COMMIT')
      return result
    } catch (err) {
      // Guard the ROLLBACK so a rollback fault cannot mask the original error (AUDIT F-10).
      try {
        this.db.run('ROLLBACK')
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

  private one<T>(sql: string, params: BindParams): T | null {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      if (!stmt.step()) return null
      return stmt.getAsObject() as unknown as T
    } finally {
      stmt.free()
    }
  }

  private all<T>(sql: string, params?: BindParams): T[] {
    const stmt = this.db.prepare(sql)
    const out: T[] = []
    try {
      if (params) stmt.bind(params)
      while (stmt.step()) out.push(stmt.getAsObject() as unknown as T)
    } finally {
      stmt.free()
    }
    return out
  }

}

export async function createSqlJsStorage(): Promise<SqlJsStorage> {
  const SQL = await loadSqlJs()
  return new SqlJsStorage(new SQL.Database())
}
