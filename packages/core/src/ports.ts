// Storage and embedding ports. Concrete adapters live in separate packages
// (ADR-01, ADR-12, FEAT-01-05). The core depends on these interfaces only.

import type { Capability, Edge, Task, PinnedPath, SubstrateStats } from './types.js'

export type Transaction = unknown

export interface StoragePort {
  init(): Promise<void>

  // Capabilities
  getCapability(id: string): Promise<Capability | null>
  upsertCapability(c: Capability): Promise<void>
  listCapabilities(): Promise<Capability[]>

  // Edges
  getEdge(from: string, to: string): Promise<Edge | null>
  upsertEdge(e: Edge): Promise<void>
  listOutgoingEdges(from: string): Promise<Edge[]>
  listEdges(): Promise<Edge[]>
  deleteEdge(from: string, to: string): Promise<void>

  // Tasks
  upsertTask(t: Task): Promise<void>
  getTask(id: string): Promise<Task | null>
  listTasks(): Promise<Task[]>
  deleteTask(id: string): Promise<void>

  // Pinned paths
  upsertPinnedPath(p: PinnedPath): Promise<void>
  getPinnedPath(id: string): Promise<PinnedPath | null>
  listPinnedPaths(): Promise<PinnedPath[]>
  deletePinnedPath(id: string): Promise<void>

  // Aggregate
  getStats(): Promise<SubstrateStats>

  // Runtime config (FEAT-04-06): a shared key-value store for cross-process toggles (e.g. 'enabled').
  /** Read a runtime config value, or null when the key is absent. */
  getRuntimeConfig(key: string): Promise<string | null>
  /** Upsert a runtime config value (stamps updated_at). */
  setRuntimeConfig(key: string, value: string): Promise<void>

  /** Wipe the learned substrate (edges, tasks, pinned paths) in bulk; keep the capability registry. */
  clearSubstrate(): Promise<void>

  /**
   * Run fn inside a single transaction. Reentrancy-safe: a nested transaction
   * call (while one is already open on this storage) is a passthrough, not a
   * new BEGIN (SQLite has no nestable BEGIN). See PLAN-04 critique resolution.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface EmbeddingPort {
  embed(text: string): Promise<Float32Array>
  dimension(): number
  modelHash(): string
}
