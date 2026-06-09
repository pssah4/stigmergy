// @stigmergy/integration-openai-agents: Drop-in for the OpenAI Agents SDK (FEAT-02-08, ADR-03).
// Built against the documented per-tool is_enabled predicate plus on_tool_start/end hooks. The
// filter is decentralized (one predicate per tool), so prime() must run consult once before the
// predicate is evaluated; the surfaced set is then read synchronously. Tool arguments are NOT used
// (they are unreliable in this SDK's hooks, issue #939); only the capability id is needed.
//
// Usage sketch (consumer code, with a shared RunContext):
//   const sx = createOpenAIAgentsIntegration(engine, { taskId, context: prompt, candidateIds })
//   await sx.prime()                              // before the run
//   tool({ ..., isEnabled: () => sx.isEnabled(toolName) })
//   // hooks: on_tool_start -> sx.onToolStart(name); on_tool_end -> sx.onToolEnd(name, ok)
//   await sx.end(); await sx.accept(usage.totalTokens)

import { StigmergyLoop, safeEmit, type LoopEngine, type TurnHandle, type PathGuidance } from '@agentic-stigmergy/loop'

export interface OpenAIAgentsTurnOptions {
  taskId: string
  context: string
  candidateIds?: string[]
  topK?: number
  /** Opt-in narrowing (IMP-04-09-03). Default false: every tool stays enabled (cache-safe), surface
   * via pathGuidance instead. true: isEnabled gates on the surfaced set (trades the prompt cache). */
  narrow?: boolean
  /** Optional id -> short description, used to render pathGuidance. */
  describe?: (id: string) => string | undefined
}

export interface OpenAIAgentsIntegration {
  /** Run consult plus capability_loaded once. Await before isEnabled/pathGuidance carry a result. */
  prime(): Promise<void>
  /** Per-tool predicate. Default: always true (every tool enabled, cache-safe). With narrow:true it is
   * true only when the capability is in the surfaced set (and false before prime). */
  isEnabled(capabilityId: string): boolean
  /** on_tool_start hook: emit capability_invoked. */
  onToolStart(capabilityId: string): Promise<void>
  /** on_tool_end hook: emit capability_returned (success defaults to true). */
  onToolEnd(capabilityId: string, success?: boolean): Promise<void>
  /** The learned path for this task as injectable guidance (empty when none). Inject the text as a
   * small per-turn message, never into the cached system/tools, so the prompt cache stays warm. */
  pathGuidance(): Promise<PathGuidance>
  end(): Promise<void>
  accept(tokenCost: number): Promise<void>
  iterate(newContext?: string): Promise<void>
  abandon(): Promise<void>
}

export function createOpenAIAgentsIntegration(
  engine: LoopEngine,
  opts: OpenAIAgentsTurnOptions,
): OpenAIAgentsIntegration {
  const loop = new StigmergyLoop(engine)
  let surfaced = new Set<string>()
  let turn: TurnHandle | null = null
  // Memoize the prime PROMISE so concurrent prime() calls consult exactly once (AUDIT F).
  let primePromise: Promise<void> | null = null

  const doPrime = (): Promise<void> => {
    if (!primePromise) {
      primePromise = (async () => {
        turn = await loop.beginTurn({
          task_id: opts.taskId,
          prompt: opts.context,
          candidate_ids: opts.candidateIds,
          top_k: opts.topK,
        })
        surfaced = new Set(turn.surfaced)
      })()
    }
    return primePromise
  }

  return {
    prime: doPrime,
    isEnabled(capabilityId: string): boolean {
      // Default (IMP-04-09-03): every tool enabled, no gating, so the tool set stays stable and the
      // prompt cache stays warm. Opt-in narrow gates on the surfaced set.
      return opts.narrow ? surfaced.has(capabilityId) : true
    },
    async pathGuidance(): Promise<PathGuidance> {
      await doPrime()
      return turn?.pathGuidance(opts.describe) ?? { path: [], text: '' }
    },
    // The SDK gives start/end hooks (not a wrappable execute), so emit manually -- but gate on the
    // turn so a disabled turn leaks no events (review w4pg93b97).
    async onToolStart(capabilityId: string): Promise<void> {
      if (!turn?.enabled) return
      // safeEmit, not engine.emit: a daemon that was up at prime() but rejects mid-turn must not
      // surface in the host's on_tool_start hook (FIX-02-08-01).
      await safeEmit(engine, { type: 'capability_invoked', taskId: opts.taskId, capabilityId })
    },
    async onToolEnd(capabilityId: string, success = true): Promise<void> {
      if (!turn?.enabled) return
      await safeEmit(engine, { type: 'capability_returned', taskId: opts.taskId, capabilityId, success })
    },
    // Delegate to the TurnHandle so end/accept/iterate/abandon no-op on a disabled turn (or before prime).
    async end(): Promise<void> {
      await turn?.end()
    },
    async accept(tokenCost: number): Promise<void> {
      await turn?.accept(tokenCost)
    },
    async iterate(newContext?: string): Promise<void> {
      await turn?.iterate(newContext)
    },
    async abandon(): Promise<void> {
      await turn?.abandon()
    },
  }
}
