// Substrate-read mapping (FEAT-03-01..07). The SQL read plus row-to-view mapping the Electron main
// uses, lifted out of the Electron entry-point so it is testable without loading Electron: a test
// opens a real better-sqlite3 substrate and calls readSnapshotFromDb directly. The main process
// opens the read-only WAL connection and delegates here.
import type Database from 'better-sqlite3'
import { START_NODE } from '@agentic-stigmergy/core'
import type { ConnectionTask, SubstrateSnapshot } from './graph-model.js'

interface CapabilityRow {
  id: string
  type: string
  description: string | null
  // Optional: absent on a pre-v2 substrate read read-only (the column is added by the v2 migration).
  description_augmented?: string | null
  // Optional: absent on a pre-v3 substrate read read-only (the column is added by the v3 migration).
  source?: string | null
}
interface EdgeRow {
  from_capability: string
  to_capability: string
  pheromone: number
  pinned: number
}
interface PinnedPathRow {
  id: string
  name: string | null
  behavior: string | null
  capability_sequence: string | null
  // Optional: absent on a pre-v substrate read read-only (the column is added by a later migration).
  when_to_use?: string | null
}

/** Whether a table has a column. The Studio reads read-only and never migrates, so a substrate still
 * at an older schema version lacks the newer columns; selecting one verbatim would throw and crash the
 * poll. We probe table_info and select the column only when present (defaulting the value on the map). */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/** Whether a table exists. runtime_config only exists from schema v4 (FEAT-04-06); a read-only
 * connection to a pre-v4 substrate must not throw on it (treat as disabled). */
function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined
}

/** Parse a pinned path's capability_sequence (a JSON array) defensively; a malformed value yields []. */
export function parseSequence(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** Whether a recorded task path traversed the directed connection from -> to. The stored path is the
 * raw executed sequence (no START sentinel); a learned edge out of START corresponds to the path's
 * first step, every other edge to a consecutive pair. Mirrors edgePairs([START, ...path]). */
function pathTraverses(path: string[], from: string, to: string): boolean {
  if (from === START_NODE) return path[0] === to
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i] === from && path[i + 1] === to) return true
  }
  return false
}

/** The recent tasks whose path traversed a given learned connection (edge provenance, BL-012). Answers
 * "what was this gray step learned for" by returning each task's context and outcome, most recent first.
 * Read-only: scans the most recent tasks (capped) and filters by the path JSON, which SQL cannot match. */
export function readConnectionTasks(db: Database.Database, from: string, to: string, limit = 6): ConnectionTask[] {
  const rows = db
    .prepare('SELECT context_text, path, outcome FROM tasks ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 1000')
    .all() as Array<{ context_text: string | null; path: string | null; outcome: string | null }>
  const out: ConnectionTask[] = []
  for (const r of rows) {
    if (!pathTraverses(parseSequence(r.path), from, to)) continue
    out.push({ context: r.context_text ?? '', outcome: r.outcome ?? '' })
    if (out.length >= limit) break
  }
  return out
}

/** Read a lean, JSON-safe snapshot from an open substrate connection. The system sentinel
 * (type '__system__') is filtered out of the capabilities; START edges are kept so the map can
 * synthesize the nest node. */
export function readSnapshotFromDb(db: Database.Database): SubstrateSnapshot {
  // description_augmented only exists from schema v2, source only from v3 (FEAT-04-01); a read-only
  // connection never migrates, so a genuine pre-v2/pre-v3 substrate lacks these columns and selecting
  // one verbatim would throw and crash the poll. Select each only when present, default on the map.
  const augmentedCol = columnExists(db, 'capabilities', 'description_augmented') ? ', description_augmented' : ''
  const sourceCol = columnExists(db, 'capabilities', 'source') ? ', source' : ''
  const capRows = db
    .prepare(`SELECT id, type, description${augmentedCol}${sourceCol} FROM capabilities WHERE type != '__system__'`)
    .all() as CapabilityRow[]
  const edgeRows = db.prepare('SELECT from_capability, to_capability, pheromone, pinned FROM edges').all() as EdgeRow[]
  // when_to_use only exists from the pinned-path naming migration; a pre-v substrate read read-only
  // lacks it, so probe and select it only when present (FEAT-06-05), defaulting on the map.
  const whenToUseCol = columnExists(db, 'pinned_paths', 'when_to_use') ? ', when_to_use' : ''
  const pathRows = db.prepare(`SELECT id, name, behavior, capability_sequence${whenToUseCol} FROM pinned_paths`).all() as PinnedPathRow[]
  const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
  // Enabled state (FEAT-04-06): runtime_config row key='enabled'; absent table/row = disabled.
  const enabled =
    tableExists(db, 'runtime_config') &&
    (db.prepare("SELECT value FROM runtime_config WHERE key = 'enabled'").get() as { value: string } | undefined)?.value === '1'
  return {
    taskCount,
    enabled,
    capabilities: capRows.map((c) => ({
      id: c.id,
      type: c.type,
      description: c.description ?? '',
      descriptionAugmented: c.description_augmented ?? undefined,
      // A legacy/NULL source reads as 'observed'; the palette uses this to flag available vs used.
      source: c.source ?? 'observed',
    })),
    edges: edgeRows.map((e) => ({
      fromCapability: e.from_capability,
      toCapability: e.to_capability,
      pheromone: e.pheromone,
      pinned: e.pinned !== 0,
    })),
    pinnedPaths: pathRows.map((p) => ({
      id: p.id,
      name: p.name ?? undefined,
      behavior: p.behavior ?? 'preferred',
      capabilitySequence: parseSequence(p.capability_sequence),
      whenToUse: p.when_to_use ?? undefined,
    })),
  }
}
