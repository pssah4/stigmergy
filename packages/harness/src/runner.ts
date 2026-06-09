// Deterministic workload runner (FEAT-02-03). For each variant it builds a fresh engine
// from the ablation config, registers the capability pool, and walks every task: consult
// surfaces a candidate set, the agent invokes from it, and (for a learning variant) the
// outcome is deposited so the substrate improves across tasks. Token cost is real (the
// surfaced definition sizes); success and attempts come from the deterministic stub agent.
// Given the same seed, workload and deps, two runs are bit-identical (SC-01).
import type { ClockProvider, EmbeddingPort, StoragePort, Decision } from '@agentic-stigmergy/core'
import { createEngine } from '@agentic-stigmergy/core'
import type { Workload } from './workload.js'
import type { AblationKnobs } from './ablation.js'
import { applyAblation } from './ablation.js'
import { RankWalkAgent } from './agent.js'

export interface Variant {
  name: string
  /** Ablation switches; omitted means all engine defaults. */
  knobs?: AblationKnobs
  /** Surface only the top-k ranked (treatment); omit to surface all candidates (static baseline). */
  topK?: number
  /** Deposit task outcomes so the substrate learns. Default true; a static baseline sets false. */
  learn?: boolean
}

/**
 * The path to deposit for a task: the capability trail the agent actually invoked, or
 * null when nothing was invoked (so no fabricated edge is reinforced). The engine treats
 * the deposited path as the invoked trail and rewards START->path[0], path[0]->path[1], ...
 * so it must mirror what the agent did, not a synthetic [oracle].
 */
export function depositPath(trail: readonly string[]): string[] | null {
  return trail.length > 0 ? [...trail] : null
}

export interface TaskResult {
  taskId: string
  success: boolean
  attempts: number
  firstTryCorrect: boolean
  tokenCost: number
}

export interface VariantResult {
  variant: string
  tasks: TaskResult[]
}

/** A clock the runner can advance between tasks so decay applies (FixedClock satisfies this). */
export interface AdvanceableClock extends ClockProvider {
  advance(ms: number): void
}

export interface RunnerDeps {
  makeStorage: () => Promise<StoragePort>
  makeEmbedding: () => EmbeddingPort
  /** A fresh clock per variant; advanced by taskIntervalMs between tasks. */
  makeClock: () => AdvanceableClock
  /** Wall-clock advance between tasks; lets decay bite over a workload. Default 1 hour. */
  taskIntervalMs?: number
  /** Per-invocation token overhead added on top of the surfaced definition sizes. Default 50. */
  callOverheadTokens?: number
}

const DEFAULT_TASK_INTERVAL_MS = 3_600_000
const DEFAULT_CALL_OVERHEAD = 50

function surfacedIds(d: Decision): string[] {
  if (d.mode === 'sequence') return [d.nextCapability]
  return d.ranked.map((r) => r.capabilityId)
}

/** Run one variant over the whole workload and return its per-task results. */
export async function runVariant(
  workload: Workload,
  variant: Variant,
  seed: number,
  deps: RunnerDeps,
): Promise<VariantResult> {
  if (variant.topK !== undefined && (!Number.isInteger(variant.topK) || variant.topK < 1)) {
    throw new RangeError(`variant '${variant.name}': topK must be a positive integer when set, got ${variant.topK}`)
  }
  const config = applyAblation(variant.knobs ?? {}, seed)
  const storage = await deps.makeStorage()
  const clock = deps.makeClock()
  const engine = await createEngine({ storage, embedding: deps.makeEmbedding(), clock, config })

  try {
    for (const c of workload.capabilities) {
      await engine.registerCapability({ id: c.id, type: c.type, description: c.description })
    }

    const defTokens = new Map(workload.capabilities.map((c) => [c.id, c.defTokens]))
    const allIds = workload.capabilities.map((c) => c.id)
    const callOverhead = deps.callOverheadTokens ?? DEFAULT_CALL_OVERHEAD
    const interval = deps.taskIntervalMs ?? DEFAULT_TASK_INTERVAL_MS
    const learn = variant.learn ?? true
    const agent = new RankWalkAgent()
    const tasks: TaskResult[] = []

    for (const task of workload.tasks) {
      const decision = await engine.consult({
        task_id: task.id,
        context: task.context,
        candidate_ids: allIds,
        top_k: variant.topK,
      })
      const surfaced = surfacedIds(decision)
      const promptTokens = surfaced.reduce((sum, id) => sum + (defTokens.get(id) ?? 0), 0)

      const trail: string[] = []
      let reachedOracle = false
      for (let attempt = 0; attempt < surfaced.length; attempt++) {
        const s = agent.step(task, surfaced, attempt)
        if (s.invoke === '') break
        trail.push(s.invoke)
        if (s.done) {
          reachedOracle = true
          break
        }
      }

      const attempts = trail.length
      const tokenCost = promptTokens + attempts * callOverhead
      const success = reachedOracle && tokenCost <= task.tokenBudget
      const firstTryCorrect = surfaced[0] === task.oracle

      if (learn) {
        // Deposit the ACTUAL invoked trail (never a synthetic [oracle]); skip when nothing
        // was invoked so no fabricated START->oracle edge is reinforced or penalized.
        const path = depositPath(trail)
        if (path) {
          await engine.deposit({
            task_id: task.id,
            context: task.context,
            path,
            outcome: success ? 'accepted' : 'abandoned',
            token_cost: tokenCost,
          })
        }
      }

      tasks.push({ taskId: task.id, success, attempts, firstTryCorrect, tokenCost })
      clock.advance(interval)
    }

    return { variant: variant.name, tasks }
  } finally {
    await engine.close()
  }
}

/** Run every variant over the workload (each in its own fresh engine). */
export async function runWorkload(
  workload: Workload,
  variants: Variant[],
  seed: number,
  deps: RunnerDeps,
): Promise<VariantResult[]> {
  const results: VariantResult[] = []
  for (const v of variants) results.push(await runVariant(workload, v, seed, deps))
  return results
}
