// Versioned workloads with content-hash anchoring (FEAT-02-03, ADR-08). The hash is
// computed over the canonical JSON of the parsed structure, so the on-disk
// serialization (JSON here; a YAML loader is a pluggable follow-on) and incidental
// whitespace or key order never change it. A report carries this hash; a mismatch at
// replay time means the workload moved and old runs are no longer directly comparable.
import { createHash } from 'node:crypto'
import type { CapabilityType } from '@agentic-stigmergy/core'

/** A capability in the workload's registry, with the token size of its definition. */
export interface WorkloadCapability {
  id: string
  type: CapabilityType
  description: string
  /** Token size of this capability's definition; drives the prompt cost when surfaced. */
  defTokens: number
}

export interface WorkloadTask {
  id: string
  /** Free-text task context, embedded by the engine during consult. */
  context: string
  /** Capability classes a correct solution touches (ADR-08, informational). */
  expectedCapabilityClasses: string[]
  /** The capability id a correct step invokes. The deterministic success oracle. */
  oracle: string
  /** Human-readable success conditions (informational; the oracle is authoritative). */
  successCriteria: string[]
  /** Per-task token ceiling; a run that exceeds it counts as failed. */
  tokenBudget: number
}

export interface Workload {
  id: string
  version: string
  description?: string
  tags?: string[]
  /** The capability registry the runner registers before the tasks run. */
  capabilities: WorkloadCapability[]
  tasks: WorkloadTask[]
}

export interface WorkloadWithHash {
  workload: Workload
  hash: string
  file?: string
}

/** Canonical JSON: object keys sorted recursively, no incidental whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k])
    return out
  }
  return value
}

/** sha256 over the canonical form, hex. Identical content yields an identical hash. */
export function workloadHash(workload: Workload): string {
  return createHash('sha256').update(canonicalize(workload)).digest('hex')
}

/** Parse a JSON workload, validate the required shape, and attach its hash. */
export function parseWorkload(raw: string, file?: string): WorkloadWithHash {
  const workload = JSON.parse(raw) as Workload
  validateWorkload(workload)
  return { workload, hash: workloadHash(workload), file }
}

const CAPABILITY_TYPES: ReadonlySet<string> = new Set(['tool', 'mcp', 'skill', 'subagent'])

function finitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function validateWorkload(w: Workload): void {
  if (!w || typeof w.id !== 'string' || w.id.length === 0) throw new Error('workload: missing id')
  // The id is interpolated into report filenames; reject path separators and '..' (CWE-22).
  if (/[/\\]/.test(w.id) || w.id.includes('..')) throw new Error(`workload: id '${w.id}' must not contain path separators or '..'`)
  if (typeof w.version !== 'string' || w.version.length === 0) throw new Error('workload: missing version')
  if (!Array.isArray(w.capabilities) || w.capabilities.length === 0) throw new Error('workload: no capabilities')
  const pool = new Set<string>()
  for (const c of w.capabilities) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) throw new Error('workload capability: missing id')
    if (pool.has(c.id)) throw new Error(`workload: duplicate capability id '${c.id}'`)
    if (!CAPABILITY_TYPES.has(c.type)) throw new Error(`workload capability ${c.id}: invalid type '${c.type}' (expected tool|mcp|skill|subagent)`)
    if (!finitePositive(c.defTokens)) throw new Error(`workload capability ${c.id}: defTokens must be a finite number > 0`)
    pool.add(c.id)
  }
  if (!Array.isArray(w.tasks) || w.tasks.length === 0) throw new Error('workload: no tasks')
  for (const t of w.tasks) {
    if (!t || typeof t.id !== 'string' || t.id.length === 0) throw new Error('workload task: missing id')
    if (typeof t.context !== 'string') throw new Error(`workload task ${t.id}: missing context`)
    if (typeof t.oracle !== 'string' || t.oracle.length === 0) throw new Error(`workload task ${t.id}: missing oracle`)
    if (!pool.has(t.oracle)) throw new Error(`workload task ${t.id}: oracle '${t.oracle}' not in capability pool`)
    if (!Array.isArray(t.expectedCapabilityClasses)) throw new Error(`workload task ${t.id}: expectedCapabilityClasses must be an array`)
    if (!Array.isArray(t.successCriteria)) throw new Error(`workload task ${t.id}: successCriteria must be an array`)
    if (!finitePositive(t.tokenBudget)) throw new Error(`workload task ${t.id}: tokenBudget must be a finite number > 0`)
  }
}
