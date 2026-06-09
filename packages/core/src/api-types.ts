// Public engine surface (FEAT-01-04). Input objects are snake_case (the shape a
// host constructs); core domain types (Decision, LifecycleEvent, Capability)
// stay camelCase per types.ts (PLAN-04 naming resolution).

import type {
  Capability,
  CapabilitySource,
  CapabilityType,
  Decision,
  LifecycleEvent,
  Outcome,
  Edge,
  PinBehavior,
  PathSource,
  PinnedPath,
  Task,
  ScoreConfig,
  DecayConfig,
  ExplorationConfig,
  SubstrateStats,
} from './types.js'
import { DEFAULT_SCORE_CONFIG, DEFAULT_DECAY_CONFIG, DEFAULT_EXPLORATION_CONFIG } from './types.js'
import type { StoragePort, EmbeddingPort } from './ports.js'
import type { ClockProvider } from './clock.js'
import type { Scheduler } from './scheduler.js'
import type { OutcomeTrackerConfig } from './outcome-tracker.js'
import { DEFAULT_TRACKER_CONFIG } from './outcome-tracker.js'

export interface ConsultInput {
  task_id: string
  context: string
  /** Capabilities already on the path; prev = last element, else START_NODE. */
  history?: string[]
  /** Restrict scoring to these ids; default is the whole registry. */
  candidate_ids?: string[]
  top_k?: number
}

export interface RegisterCapabilityInput {
  id: string
  type: CapabilityType
  description: string
  /** Provenance (ADR-17). Discovery sets 'declared' | 'mcp' | 'skill'; omitted means 'observed'. */
  source?: CapabilitySource
}

/** Deposit a known path outcome directly, without emitting the per-step lifecycle. */
export interface DepositInput {
  task_id: string
  context: string
  /** Invoked capability trail; reward applies to START->path[0], path[0]->path[1], ... */
  path: string[]
  outcome: Outcome
  token_cost: number
}

export interface PinPathInput {
  /** Optional; the engine assigns a unique id when absent. */
  id?: string
  name?: string
  description?: string
  capability_sequence: string[]
  parameters_template?: Record<string, unknown>
  /** Default 'preferred'. */
  behavior?: PinBehavior
  created_by?: string
  /** Plain-language "when to use this path" (ADR-18); the emergent-naming daemon fills it (ADR-19). */
  when_to_use?: string
  /** Provenance (ADR-19): 'manual' (hand-pinned) or 'emergent' (auto-named). Default 'manual'. */
  path_source?: PathSource
  /** Model id that produced an emergent name (ADR-19, provenance). */
  named_by?: string
}

/** Manual pheromone adjustment along a path (FEAT-01-06). */
export interface ReinforcePathInput {
  /** Capability trail; the bump applies to START->path[0], path[0]->path[1], ... */
  path: string[]
  /** Non-negative pheromone delta per edge before clip to [tauMin, tauMax]. */
  strength: number
}

/** A capability inside a transport payload, without the recomputable embedding (FEAT-01-06, SC-07). */
export interface CapabilitySnapshot {
  id: string
  type: CapabilityType
  description: string
}

/** A task inside a transport payload, without the recomputable context embedding. */
export type TaskSnapshot = Omit<Task, 'contextEmbedding'>

/** Portable export of one pinned path plus the edges and capabilities along it. */
export interface PathExport {
  version: 1
  pinnedPath: PinnedPath
  capabilities: CapabilitySnapshot[]
  edges: Edge[]
}

/** Full substrate dump for backup/restore (FEAT-01-06, SC-07). Edges and pinned paths are
 *  JSON-clean rows; capabilities and tasks drop their Float32Array embeddings (recomputed on use). */
export interface SubstrateBackup {
  version: 1
  capabilities: CapabilitySnapshot[]
  edges: Edge[]
  tasks: TaskSnapshot[]
  pinnedPaths: PinnedPath[]
}

export interface DepositConfig {
  /** Learning rate applied to quality x efficiency. */
  rho: number
  /** Token-cost reference for efficiency = baselineCost / tokenCost. */
  baselineCost: number
  eMin: number
  eMax: number
}

export const DEFAULT_DEPOSIT_CONFIG: DepositConfig = { rho: 0.3, baselineCost: 1000, eMin: 0.5, eMax: 2 }

export interface StigmergyConfig {
  score: ScoreConfig
  decay: DecayConfig
  deposit: DepositConfig
  tracker: OutcomeTrackerConfig
  exploration: ExplorationConfig
  /** Seed for the selection RNG; a fresh engine with the same seed is deterministic. */
  seed: number
  sourceHost: string
  /** Cap on the candidate set consult scores when the host passes no candidate_ids (ADR-17). A large
   * discovered catalog (MCP/skills) is prefiltered to the top maxCandidates by similarity before
   * scoring, so it cannot flood the ranked set with never-foraged optimistic nodes. Below the cap the
   * set is unchanged (byte-identical selection). candidate_ids, the host's explicit restriction, is
   * never prefiltered. */
  maxCandidates: number
  /** Cosine threshold for a pinned path's whenToUse gate (ADR-18, FEAT-04-03). A 'sequence' pin with a
   * whenToUse fires only when cosine(whenToUse, task context) >= this; an empty whenToUse fires
   * unconditionally (today's behavior). Model-dependent; configurable. */
  whenToUseThreshold: number
}

export const DEFAULT_STIGMERGY_CONFIG: StigmergyConfig = {
  score: DEFAULT_SCORE_CONFIG,
  decay: DEFAULT_DECAY_CONFIG,
  deposit: DEFAULT_DEPOSIT_CONFIG,
  tracker: DEFAULT_TRACKER_CONFIG,
  exploration: DEFAULT_EXPLORATION_CONFIG,
  seed: 0x5eed,
  sourceHost: 'custom',
  maxCandidates: 256,
  whenToUseThreshold: 0.25,
}

/** Optional semantic-augmentation seam (FEAT-01-07, ADR-11). The engine calls this at capability
 * registration (a setup path, never the consult hot-path). A null return or a thrown error means:
 * keep the raw description. A successful augmentation is recorded and never repeated for the same
 * raw description (SC-01); a failed one is not cached, so it retries on the next registration with
 * the same description (best-effort recovery when a provider was briefly down). The concrete
 * implementation lives in @stigmergy/llm over ApiHandler.classifyText; the core only sees this
 * dependency-injection type, so no provider code is pulled into the core or sandbox bundle
 * (ADR-01/ADR-12). */
export interface CapabilityAugmenter {
  augment(input: { id: string; type: string; description: string }): Promise<{ description: string; model: string } | null>
}

export interface EngineDeps {
  storage: StoragePort
  embedding: EmbeddingPort
  clock?: ClockProvider
  scheduler?: Scheduler
  /** Sink for a rejected auto-accept timeout callback (otherwise it would be an unhandled rejection). */
  onSchedulerError?: (err: unknown) => void
  /** Optional semantic-augmentation seam (FEAT-01-07). Default off: without it, descriptions stay raw. */
  augmenter?: CapabilityAugmenter
  config?: Partial<StigmergyConfig>
}

export interface StigmergyEngine {
  /** Surface a ranked (or pin-driven) Decision for the next transition. */
  consult(input: ConsultInput): Promise<Decision>
  /** Feed a lifecycle event into the OutcomeTracker (deposits on resolution). */
  emit(event: LifecycleEvent): Promise<void>
  /** Deposit a known path outcome directly (idempotent per task_id). */
  deposit(input: DepositInput): Promise<void>
  /** Pin a capability sequence; assigns a unique id and pins the edges. */
  pinPath(input: PinPathInput): Promise<PinnedPath>
  /** Manually add pheromone along a path (clip to [tauMin, tauMax]). Pinned edges hold their pinned pheromone; the delta is a no-op there. */
  reinforcePath(input: ReinforcePathInput): Promise<void>
  /** Manually remove pheromone along a path (clip to [tauMin, tauMax]). Pinned edges hold their pinned pheromone; the delta is a no-op there. */
  weakenPath(input: ReinforcePathInput): Promise<void>
  listPaths(): Promise<PinnedPath[]>
  getPath(id: string): Promise<PinnedPath | null>
  /** Remove a pinned path and unpin its edges (learned pheromone is kept). */
  deletePath(id: string): Promise<void>
  /** Remove a single learned edge by its (from, to) pair. Rejects an edge that a pinned path covers
   * (unpin the path instead) so a delete never orphans a saved path; a no-op on a missing edge. */
  deleteEdge(from: string, to: string): Promise<void>
  registerCapability(input: RegisterCapabilityInput): Promise<Capability>
  listCapabilities(): Promise<Capability[]>
  stats(): Promise<SubstrateStats>
  /** Full substrate dump for backup (FEAT-01-06, SC-07). */
  backup(): Promise<SubstrateBackup>
  /** Replace the learned substrate from a backup: clears edges/tasks/pins, then re-loads rows and
   * re-applies the backup's capabilities. The capability registry is additive (upsert); capabilities
   * present but absent from the backup are kept, not deleted. Edge pheromone is clamped to [tauMin, tauMax]. */
  restore(data: SubstrateBackup): Promise<void>
  /** Export one pinned path plus its edges and capabilities; null when the id is unknown. */
  exportPath(id: string): Promise<PathExport | null>
  /** Import a path export: upsert its capabilities, edges and the pinned path. */
  importPath(data: PathExport): Promise<PinnedPath>
  /** Wipe the learned substrate (edges, tasks, pins, buffers). Throws without { destroy: true }. */
  reset(opts: { destroy: boolean }): Promise<void>
  /** Read a runtime flag value, or null when absent (FEAT-04-06). */
  getRuntimeFlag(key: string): Promise<string | null>
  /** Set a runtime flag value (FEAT-04-06); invalidates the local isEnabled cache. */
  setRuntimeFlag(key: string, value: string): Promise<void>
  /** Whether Stigmergy is enabled (runtime_config 'enabled' === '1'); default false. TTL-cached so the
   * loop can call it on every beginTurn without a per-turn storage round-trip (ADR-20). */
  isEnabled(): Promise<boolean>
  /** Resolve once the background embedder has drained all pending work (ADR-25). Optional: the embedded
   * engine implements it; a remote client does not (its worker lives in the daemon). Mainly a test and
   * pre-warm hook for deterministic similarity/gating after a register or a first-seen query. */
  whenEmbeddingsIdle?(): Promise<void>
  close(): Promise<void>
}
