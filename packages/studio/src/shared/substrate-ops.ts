// Pure helpers for the substrate operations panel (FEAT-03-04). computeStats derives the live stats
// shown in the panel from the snapshot the main process already pushes (SC-01); isResetConfirmation
// gates the destructive reset behind typing the exact word DELETE (SC-06). No React/Electron import,
// so the monorepo vitest covers them. The actual backup/restore/export/import/reset run through the
// engine in the main process.
import type { SubstrateSnapshot } from './graph-model.js'

export interface StatsView {
  capabilities: number
  edges: number
  tasks: number
  pinnedPaths: number
  avgPheromone: number
}

export function computeStats(snapshot: SubstrateSnapshot): StatsView {
  const edges = snapshot.edges
  const avgPheromone = edges.length === 0 ? 0 : edges.reduce((sum, e) => sum + e.pheromone, 0) / edges.length
  return {
    capabilities: snapshot.capabilities.length,
    edges: edges.length,
    tasks: snapshot.taskCount ?? 0,
    pinnedPaths: snapshot.pinnedPaths?.length ?? 0,
    avgPheromone,
  }
}

/** The reset confirmation: only the exact word DELETE counts (no case-fold, no surrounding space). */
export function isResetConfirmation(typed: string): boolean {
  return typed === 'DELETE'
}
