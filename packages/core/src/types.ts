// Core data model for the Stigmergy engine. See ADR-04 (Pfad-Graph, Score),
// ADR-09 (Pin-Modi), FEAT-01-01 (Schema).

export type CapabilityType = 'tool' | 'mcp' | 'skill' | 'subagent'

/**
 * How a capability entered the substrate (ADR-17). 'observed' is the default (seen through a loop
 * run or explicitly registered before this dimension existed); 'declared' / 'mcp' / 'skill' mark a
 * capability discovered and registered before it ever ran, so the Builder can show it as available.
 * Observation wins: a 'declared' capability that later runs flips to 'observed' on deposit.
 */
export type CapabilitySource = 'observed' | 'declared' | 'mcp' | 'skill'

/** Reserved synthetic node for the first transition of a task (ADR-04). */
export const START_NODE = '__START__'

export interface Capability {
  id: string
  type: CapabilityType | '__system__'
  description: string
  descriptionEmbedding?: Float32Array
  /** LLM-augmented description (FEAT-01-07). When set, descriptionEmbedding is computed from this. */
  descriptionAugmented?: string
  /** ISO timestamp of the augmentation. */
  augmentedAt?: string
  /** Model id that produced the augmentation (provenance, prompt-stability). */
  augmentedBy?: string
  /** Provenance of the capability (ADR-17). Reads default to 'observed' for legacy rows. */
  source?: CapabilitySource
  /** modelHash of the model that produced descriptionEmbedding (ADR-18, FEAT-04-07). consult reuses
   * the stored vector only on a match; a mismatch (or undefined on a legacy row) forces a re-embed. */
  embeddingModel?: string
  firstSeen: string
  lastSeen: string
}

export type PinBehavior = 'preferred' | 'enforce' | 'sequence'
export type PinOwner = 'user' | 'system'

/** How a pinned path came to exist (ADR-19): hand-pinned by the operator, or auto-named by the
 * emergent-naming daemon from a strongly reinforced trail. Reads default to 'manual' for legacy rows. */
export type PathSource = 'manual' | 'emergent'

export interface Edge {
  fromCapability: string
  toCapability: string
  /** Current value in [tauMin, tauMax], lazy decayed (ADR-06). */
  pheromone: number
  /** Decayed evidence for Thompson selection (ADR-04). */
  successCount: number
  /** Decayed evidence, includes loaded-but-discarded (ADR-05). */
  failureCount: number
  pinned: boolean
  pinBehavior: PinBehavior | null
  pinOwner: PinOwner | null
  lastUpdated: string
}

export type Outcome = 'accepted' | 'iterated' | 'abandoned'

export interface Task {
  id: string
  contextText: string
  contextEmbedding?: Float32Array
  /** Ordered capability sequence, the task-to-path mapping. */
  path: string[]
  outcome: Outcome | null
  tokenCost: number
  createdAt: string
  completedAt?: string
  sourceHost: string
}

export interface PinnedPath {
  id: string
  name?: string
  description?: string
  capabilitySequence: string[]
  parametersTemplate?: Record<string, unknown>
  behavior: PinBehavior
  /** Plain-language "when to use this whole path" (ADR-18). Gates sequence/preferred firing when set. */
  whenToUse?: string
  /** Embedding of whenToUse, computed once at pinPath; consult cosines it against the task context. */
  whenToUseEmbedding?: Float32Array
  /** Embedding of the path name (ADR-19, used by the emergent-naming daemon). */
  nameEmbedding?: Float32Array
  /** ISO timestamp of an emergent auto-naming pass (ADR-19). */
  namedAt?: string
  /** Model id that produced the emergent name (ADR-19, provenance). */
  namedBy?: string
  /** Whether the path was hand-pinned or auto-named (ADR-19). Reads default to 'manual'. */
  pathSource?: PathSource
  createdAt: string
  createdBy?: string
}

export interface CapabilityRanking {
  capabilityId: string
  score: number
  components: { pheromone: number; similarity: number; thompson: number }
}

export type Decision =
  | { mode: 'ranked'; ranked: CapabilityRanking[] }
  | { mode: 'enforce'; ranked: CapabilityRanking[]; forceFromSet: true }
  | {
      mode: 'sequence'
      nextCapability: string
      parameters: Record<string, unknown>
      remainingPath: string[]
    }

export type LifecycleEvent =
  | { type: 'task_started'; taskId: string; context: string }
  | { type: 'capability_loaded'; taskId: string; capabilityId: string }
  | { type: 'capability_invoked'; taskId: string; capabilityId: string }
  | { type: 'capability_returned'; taskId: string; capabilityId: string; success: boolean }
  | { type: 'response_delivered'; taskId: string }
  | { type: 'task_iterated'; taskId: string; newContext?: string }
  | { type: 'task_accepted'; taskId: string; tokenCost: number }
  | { type: 'task_abandoned'; taskId: string }

export interface ScoreConfig {
  /** Pheromone exponent. */
  alpha: number
  /** Similarity exponent. */
  beta: number
  /** Lower bound for the similarity term, symmetric to tauMin. */
  etaFloor: number
  /** Probability of exploiting (ranking by score) instead of sampling. */
  q0: number
}

export interface DecayConfig {
  halfLifeMsByType: Record<string, number>
  defaultHalfLifeMs: number
  tauMin: number
  tauMax: number
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = { alpha: 1, beta: 2, etaFloor: 0.05, q0: 0.7 }

/** Selection policy over scored candidates (ADR-13, FEAT-02-05). */
export type ExplorationPolicy = 'thompson' | 'ucb' | 'adaptive-epsilon'

export interface ExplorationConfig {
  /** Default 'thompson' = the shipped Thompson plus q0 behavior, byte-identical. */
  policy: ExplorationPolicy
  /** UCB exploration weight c (policy 'ucb' only). */
  ucbC: number
  /** adaptive-epsilon: base exploration probability. */
  epsilonBase: number
  /** adaptive-epsilon: success rate the rate steers toward. */
  epsilonTarget: number
  /** adaptive-epsilon: gain k applied to (target - recentSuccess). */
  epsilonGain: number
  /** adaptive-epsilon: lower and upper bounds on the effective epsilon. */
  epsilonMin: number
  epsilonMax: number
  /** Number of recent resolved tasks the engine averages into recentSuccess. */
  recentWindow: number
  /** Max fraction in [0, 1] of a consult's surfaced set drawn from the explore path. 1 = no cap. */
  explorationBudget: number
}

export const DEFAULT_EXPLORATION_CONFIG: ExplorationConfig = {
  policy: 'thompson',
  ucbC: 1.4,
  epsilonBase: 0.2,
  epsilonTarget: 0.8,
  epsilonGain: 0.5,
  epsilonMin: 0,
  epsilonMax: 0.9,
  recentWindow: 20,
  explorationBudget: 1,
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeMsByType: {},
  defaultHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
  tauMin: 0.05,
  tauMax: 1.0,
}

export interface SubstrateStats {
  capabilities: number
  edges: number
  tasks: number
  pinnedPaths: number
  avgPheromone: number
}
