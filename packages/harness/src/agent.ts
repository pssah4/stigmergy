// The agent the runner drives over a task (FEAT-02-03). In Scope A the harness ships
// a deterministic stub so runs are reproducible (SC-01); the real-workload path
// (SC-02) injects an LLM-backed agent through the same interface.
import type { WorkloadTask } from './workload.js'

export interface AgentStep {
  /** Capability id the agent invokes this attempt, or '' to give up. */
  invoke: string
  /** Whether the agent considers the task solved after this invocation. */
  done: boolean
}

export interface Agent {
  /** Decide the next invocation given the surfaced candidate ids in engine-ranked order. */
  step(task: WorkloadTask, surfaced: readonly string[], attempt: number): AgentStep
}

/**
 * Deterministic stub: walks the surfaced set in the order the engine returned it and
 * invokes each in turn until it reaches the task oracle. It models a model that trusts
 * the surfaced ranking. Success is reaching the oracle; exhausting the set gives up.
 * No randomness, so the run is fully reproducible.
 */
export class RankWalkAgent implements Agent {
  step(task: WorkloadTask, surfaced: readonly string[], attempt: number): AgentStep {
    const c = surfaced[attempt]
    if (c === undefined) return { invoke: '', done: true }
    return { invoke: c, done: c === task.oracle }
  }
}
