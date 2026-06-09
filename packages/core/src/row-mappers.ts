// Shared SQL-row to domain mappers. Both storage adapters persist the same
// snake_case columns; only the BLOB carrier differs (Node Buffer vs sql.js
// Uint8Array). Buffer is a Uint8Array subclass, so one decode covers both and
// the adapters share these mappers instead of duplicating them (ADR-02).

import type {
  Capability,
  CapabilitySource,
  CapabilityType,
  Edge,
  Outcome,
  PathSource,
  PinBehavior,
  PinOwner,
  PinnedPath,
  Task,
} from './types.js'

export interface CapRow {
  id: string
  type: string
  description: string | null
  description_embedding: Uint8Array | null
  description_augmented?: string | null
  augmented_at?: string | null
  augmented_by?: string | null
  source?: string | null
  embedding_model?: string | null
  first_seen: string | null
  last_seen: string | null
}

export interface EdgeRow {
  from_capability: string
  to_capability: string
  pheromone: number
  success_count: number
  failure_count: number
  pinned: number
  pin_behavior: string | null
  pin_owner: string | null
  last_updated: string
}

export interface TaskRow {
  id: string
  context_text: string | null
  context_embedding: Uint8Array | null
  path: string | null
  outcome: string | null
  token_cost: number | null
  created_at: string | null
  completed_at: string | null
  source_host: string | null
}

export interface PinnedRow {
  id: string
  name: string | null
  description: string | null
  capability_sequence: string | null
  parameters_template: string | null
  behavior: string | null
  when_to_use?: string | null
  when_to_use_embedding?: Uint8Array | null
  name_embedding?: Uint8Array | null
  named_at?: string | null
  named_by?: string | null
  path_source?: string | null
  created_at: string | null
  created_by: string | null
}

/** Decode an embedding BLOB. Buffer (better-sqlite3) is a Uint8Array, so this covers both adapters. */
export function decodeEmbedding(v: unknown): Float32Array | undefined {
  if (!(v instanceof Uint8Array)) return undefined
  return new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

// Guarded parsing and enum coercion: a corrupt, hand-edited, or imported substrate row must not
// throw out of a list/consult or smuggle an out-of-enum value into the engine (AUDIT F-01 / F-04).

function safeStringArray(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function safeObject(s: string | null): Record<string, unknown> | undefined {
  if (!s) return undefined
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const OUTCOMES = new Set<string>(['accepted', 'iterated', 'abandoned'])
const PIN_BEHAVIORS = new Set<string>(['preferred', 'enforce', 'sequence'])
const CAP_TYPES = new Set<string>(['tool', 'mcp', 'skill', 'subagent', '__system__'])
const CAP_SOURCES = new Set<string>(['observed', 'declared', 'mcp', 'skill'])
const PATH_SOURCES = new Set<string>(['manual', 'emergent'])

function coerceOutcome(v: string | null): Outcome | null {
  return v && OUTCOMES.has(v) ? (v as Outcome) : null
}

function coercePinBehavior(v: string | null, fallback: PinBehavior | null): PinBehavior | null {
  return v && PIN_BEHAVIORS.has(v) ? (v as PinBehavior) : fallback
}

function coerceType(v: string): CapabilityType | '__system__' {
  return CAP_TYPES.has(v) ? (v as CapabilityType | '__system__') : 'tool'
}

// A NULL source is a pre-v3 (legacy) row: every such row was created by a run or explicit
// registration, so it reads as 'observed'. An out-of-enum value coerces to the same safe default.
function coerceSource(v: string | null | undefined): CapabilitySource {
  return v && CAP_SOURCES.has(v) ? (v as CapabilitySource) : 'observed'
}

function coercePathSource(v: string | null | undefined): PathSource {
  return v && PATH_SOURCES.has(v) ? (v as PathSource) : 'manual'
}

export function rowToCapability(r: CapRow): Capability {
  return {
    id: r.id,
    type: coerceType(r.type),
    description: r.description ?? '',
    descriptionEmbedding: decodeEmbedding(r.description_embedding),
    descriptionAugmented: r.description_augmented ?? undefined,
    augmentedAt: r.augmented_at ?? undefined,
    augmentedBy: r.augmented_by ?? undefined,
    source: coerceSource(r.source),
    embeddingModel: r.embedding_model ?? undefined,
    firstSeen: r.first_seen ?? '',
    lastSeen: r.last_seen ?? '',
  }
}

export function rowToEdge(r: EdgeRow): Edge {
  return {
    fromCapability: r.from_capability,
    toCapability: r.to_capability,
    pheromone: r.pheromone,
    successCount: r.success_count,
    failureCount: r.failure_count,
    pinned: r.pinned === 1,
    pinBehavior: coercePinBehavior(r.pin_behavior, null),
    pinOwner: (r.pin_owner as PinOwner | null) ?? null,
    lastUpdated: r.last_updated,
  }
}

export function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    contextText: r.context_text ?? '',
    contextEmbedding: decodeEmbedding(r.context_embedding),
    path: safeStringArray(r.path),
    outcome: coerceOutcome(r.outcome),
    tokenCost: r.token_cost ?? 0,
    createdAt: r.created_at ?? '',
    completedAt: r.completed_at ?? undefined,
    sourceHost: r.source_host ?? '',
  }
}

export function rowToPinnedPath(r: PinnedRow): PinnedPath {
  return {
    id: r.id,
    name: r.name ?? undefined,
    description: r.description ?? undefined,
    capabilitySequence: safeStringArray(r.capability_sequence),
    parametersTemplate: safeObject(r.parameters_template),
    behavior: coercePinBehavior(r.behavior, 'preferred') ?? 'preferred',
    whenToUse: r.when_to_use ?? undefined,
    whenToUseEmbedding: decodeEmbedding(r.when_to_use_embedding),
    nameEmbedding: decodeEmbedding(r.name_embedding),
    namedAt: r.named_at ?? undefined,
    namedBy: r.named_by ?? undefined,
    pathSource: coercePathSource(r.path_source),
    createdAt: r.created_at ?? '',
    createdBy: r.created_by ?? undefined,
  }
}
