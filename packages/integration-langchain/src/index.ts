// @stigmergy/integration-langchain: Drop-in for LangChain 1.0 / LangGraph (FEAT-02-08, ADR-03).
// Built against the documented middleware layer (wrap_model_call with request.override(tools=ranked))
// plus tool instrumentation, not against internals. Thin: it delegates to the @agentic-stigmergy/loop facade.
//
// Usage sketch (consumer code):
//   const sx = createLangchainIntegration(engine, { taskId, context: prompt, candidateIds: tools.map(t => t.name) })
//   // inside a middleware: return sx.wrapModelCall(request, handler)
//   // wrap a tool's func: const run = sx.instrument(tool.name, tool.func)
//   await sx.end(); await sx.accept(usage.totalTokens)

import { StigmergyLoop, instrumentRun, type TurnHandle, type LoopEngine, type PathGuidance } from '@agentic-stigmergy/loop'

export interface LangchainTurnOptions {
  taskId: string
  context: string
  candidateIds?: string[]
  topK?: number
  /** Opt-in narrowing (ADR-26). Default false: pass the request through UNCHANGED (LangChain's own tool
   * selection stands; surface a learned path via pathGuidance). true: drop the request's tools to the
   * surfaced set (trades the cache and competes with your own retrieval). */
  narrow?: boolean
  /** Optional id -> short description, used to render pathGuidance. */
  describe?: (id: string) => string | undefined
}

/** Minimal shape of a LangChain tool; only the name is read to rank/filter the request. */
export interface LangchainToolLike {
  name?: string
}

export interface LangchainIntegration {
  /**
   * Use inside a `wrap_model_call` middleware: consults, then by default calls the handler with the
   * request UNCHANGED (ADR-26: Stigmergy does not reorder or filter the tool block by default; surface a
   * learned path via pathGuidance instead). With narrow:true the tools are dropped to the surfaced set.
   * If candidateIds was not given, the request's own tool names are used as the candidate set.
   */
  wrapModelCall<Req extends { tools?: readonly LangchainToolLike[] }, Res>(
    request: Req,
    handler: (req: Req) => Promise<Res>,
  ): Promise<Res>
  /** Wrap a tool function so calls emit capability_invoked/returned. */
  instrument<Args extends unknown[], R>(capabilityId: string, run: (...args: Args) => R | Promise<R>): (...args: Args) => Promise<R>
  /** The learned path for this task as injectable guidance (empty when none). Inject the text as a
   * small per-turn message, never into the cached system/tools, so the prompt cache stays warm. */
  pathGuidance(): Promise<PathGuidance>
  end(): Promise<void>
  accept(tokenCost: number): Promise<void>
  iterate(newContext?: string): Promise<void>
  abandon(): Promise<void>
}

export function createLangchainIntegration(engine: LoopEngine, opts: LangchainTurnOptions): LangchainIntegration {
  const loop = new StigmergyLoop(engine)
  // Memoize the beginTurn PROMISE so concurrent wrapModelCall invocations share one consult (AUDIT F).
  let turnPromise: Promise<TurnHandle> | null = null

  const ensureTurn = (candidateFallback?: string[]): Promise<TurnHandle> => {
    if (!turnPromise) {
      turnPromise = loop.beginTurn({
        task_id: opts.taskId,
        prompt: opts.context,
        candidate_ids: opts.candidateIds ?? candidateFallback,
        top_k: opts.topK,
      })
    }
    return turnPromise
  }

  return {
    async wrapModelCall<Req extends { tools?: readonly LangchainToolLike[] }, Res>(
      request: Req,
      handler: (req: Req) => Promise<Res>,
    ): Promise<Res> {
      const names = (request.tools ?? []).map((t) => t.name).filter((n): n is string => typeof n === 'string')
      const t = await ensureTurn(names)
      // ADR-26: Stigmergy is recall, not a second selector. By default pass the request through UNCHANGED
      // (LangChain's own tool selection stands; surface a learned path via pathGuidance instead). narrow:true
      // is an explicit opt-in that drops the tools to the surfaced set (trades the prompt cache and competes
      // with your own retrieval); it fails open when nothing was surfaced or the request carries no tools.
      if (!opts.narrow || t.surfaced.length === 0 || !request.tools || request.tools.length === 0) return handler(request)
      const surfaced = new Set(t.surfaced)
      const filtered = request.tools.filter((tool) => typeof tool.name === 'string' && surfaced.has(tool.name))
      return handler({ ...request, tools: filtered })
    },
    instrument<Args extends unknown[], R>(capabilityId: string, run: (...args: Args) => R | Promise<R>) {
      // Gate at call time on the turn: a disabled turn runs the tool without emitting (review w4pg93b97).
      return async (...args: Args): Promise<R> => {
        const t = await ensureTurn()
        return t.enabled ? instrumentRun(engine, opts.taskId, capabilityId, run)(...args) : Promise.resolve(run(...args))
      }
    },
    async pathGuidance(): Promise<PathGuidance> {
      return (await ensureTurn()).pathGuidance(opts.describe)
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
