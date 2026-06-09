// @stigmergy/integration-vercel-ai: Drop-in for the Vercel AI SDK (FEAT-02-08, ADR-03).
// Built against the documented pre-call layer (prepareStep -> activeTools) plus a wrapper around
// tool.execute, not against internals. Thin: it delegates to the @agentic-stigmergy/loop facade.
//
// Usage sketch (consumer code):
//   const sx = createVercelIntegration(engine, { taskId, context: prompt, candidateIds: Object.keys(tools) })
//   await streamText({ model, messages, tools: sx.wrapTools(tools), prepareStep: sx.prepareStep })
//   await sx.end(); await sx.accept(usage.totalTokens)

import { StigmergyLoop, instrumentRun, type TurnHandle, type LoopEngine, type PathGuidance } from '@agentic-stigmergy/loop'

export interface VercelTurnOptions {
  taskId: string
  /** The turn prompt/context that drives consult. */
  context: string
  /** Restrict candidates to the loop's own tool ids (proactive pre-filtering). */
  candidateIds?: string[]
  topK?: number
  /** Opt-in narrowing (IMP-04-09-03). Default false: keep ALL tools active (cache-safe) and surface
   * via pathGuidance instead. true: set activeTools to the surfaced set (trades the prompt cache). */
  narrow?: boolean
  /** Optional id -> short description, used to render pathGuidance. */
  describe?: (id: string) => string | undefined
}

/** Minimal shape of a Vercel AI SDK tool; only execute is wrapped for instrumentation. */
export interface VercelToolLike {
  execute?: (...args: unknown[]) => unknown
}

export interface PreparedStep {
  /** Vercel `activeTools`. Present only when narrow is opted in; omitted by default so every tool
   * stays active and the tool block (and prompt cache) is untouched. */
  activeTools?: string[]
}

export interface VercelIntegration {
  /** Pass as `prepareStep`. By default returns no activeTools (all tools stay active, cache-safe);
   * with narrow:true it returns activeTools = the surfaced set. */
  prepareStep(): Promise<PreparedStep>
  /** Wrap a tools record so each tool.execute emits capability_invoked/returned (key = capability id). */
  wrapTools<T extends Record<string, VercelToolLike>>(tools: T): T
  /** The learned path for this task as injectable guidance (empty when none). Inject the text as a
   * small per-turn message, never into the cached system/tools, so the prompt cache stays warm. */
  pathGuidance(): Promise<PathGuidance>
  end(): Promise<void>
  accept(tokenCost: number): Promise<void>
  iterate(newContext?: string): Promise<void>
  abandon(): Promise<void>
}

export function createVercelIntegration(engine: LoopEngine, opts: VercelTurnOptions): VercelIntegration {
  const loop = new StigmergyLoop(engine)
  // Memoize the beginTurn PROMISE (not its result) so concurrent prepareStep calls share one
  // consult and one task_started/capability_loaded burst (AUDIT F: check-then-act race).
  let turnPromise: Promise<TurnHandle> | null = null

  const ensureTurn = (): Promise<TurnHandle> => {
    if (!turnPromise) {
      turnPromise = loop.beginTurn({
        task_id: opts.taskId,
        prompt: opts.context,
        candidate_ids: opts.candidateIds,
        top_k: opts.topK,
      })
    }
    return turnPromise
  }

  return {
    async prepareStep(): Promise<PreparedStep> {
      const t = await ensureTurn()
      // Default (IMP-04-09-03): no activeTools -> all tools stay active, the tool block is untouched
      // and the prompt cache stays warm. Opt-in narrow restricts to the surfaced set.
      return opts.narrow ? { activeTools: t.surfaced } : {}
    },
    async pathGuidance(): Promise<PathGuidance> {
      return (await ensureTurn()).pathGuidance(opts.describe)
    },
    wrapTools<T extends Record<string, VercelToolLike>>(tools: T): T {
      const out: Record<string, VercelToolLike> = {}
      for (const [name, tool] of Object.entries(tools)) {
        const exec = tool.execute
        if (!exec) {
          out[name] = tool
          continue
        }
        // Gate at CALL time on the (now-known) turn: a disabled turn runs the tool without emitting,
        // so a wired-but-disabled loop leaks no lifecycle events (review w4pg93b97).
        out[name] = {
          ...tool,
          execute: async (...args: unknown[]): Promise<unknown> => {
            const t = await ensureTurn()
            return t.enabled ? instrumentRun(engine, opts.taskId, name, exec)(...args) : exec(...args)
          },
        }
      }
      return out as T
    },
    // Delegate to the TurnHandle so end/accept/iterate/abandon no-op on a disabled turn.
    async end(): Promise<void> {
      await (await ensureTurn()).end()
    },
    async accept(tokenCost: number): Promise<void> {
      await (await ensureTurn()).accept(tokenCost)
    },
    async iterate(newContext?: string): Promise<void> {
      await (await ensureTurn()).iterate(newContext)
    },
    async abandon(): Promise<void> {
      await (await ensureTurn()).abandon()
    },
  }
}
