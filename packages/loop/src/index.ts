// @agentic-stigmergy/loop: the SDK-agnostic loop facade (FEAT-02-08, ADR-03). It turns the
// raw lifecycle vocabulary into three calls a controlled loop drives:
//   beginTurn -> task_started, consult, capability_loaded for the surfaced set
//   instrument -> tools fire capability_invoked / capability_returned when called
//   end        -> response_delivered (capability_discarded is derived by the tracker
//                 from loaded-but-not-invoked, ADR-13)
// The three SDK packages are thin wrappers that map their tool shape onto this facade.

import type { ConsultInput, Decision, LifecycleEvent } from '@agentic-stigmergy/core'

/** The minimal engine surface the loop facade needs: gate, surface, report. Both the embedded
 * StigmergyEngine and the @agentic-stigmergy/client RemoteEngine satisfy it, so the same facade (and the SDK
 * integrations) work whether Stigmergy runs in-process or as an external daemon (FEAT-04-09). */
export interface LoopEngine {
  isEnabled(): Promise<boolean>
  emit(event: LifecycleEvent): Promise<void>
  consult(input: ConsultInput): Promise<Decision>
}

/** A capability the loop can expose to the model. `id` matches a registered capability. */
export interface Tool<Args extends unknown[] = unknown[], Result = unknown> {
  id: string
  run: (...args: Args) => Result | Promise<Result>
}

export interface BeginTurnInput {
  task_id: string
  /** The task context / prompt that drives consult. */
  prompt: string
  /** Restrict the candidate set to the loop's own tool ids (proactive pre-filtering, ASR #1). */
  candidate_ids?: string[]
  /** Cap the surfaced set the model sees. */
  top_k?: number
}

/** How long the facade waits on a single engine call before degrading (ADR-20, FIX-02-08-02). A
 * healthy in-process or local-daemon engine answers in well under these, so the timeout only bites
 * when Stigmergy is reachable but slow (e.g. a rate-limited remote embedding on registration/consult);
 * the host loop then proceeds as if Stigmergy were off instead of hanging. */
const DEFAULT_CONSULT_TIMEOUT_MS = 10_000
const DEFAULT_GATE_TIMEOUT_MS = 5_000
const DEFAULT_EMIT_TIMEOUT_MS = 5_000

/** Race an engine promise against a deadline. A rejection OR a timeout both resolve to `fallback`, so
 * the caller never sees a throw (FIX-02-08-01) and never waits past `ms` (FIX-02-08-02). `ms <= 0`
 * disables the timeout but keeps the reject->fallback guard. The losing promise is swallowed via
 * `.catch`, so a late rejection from the slow call never becomes an unhandled rejection. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  const guarded = p.catch(() => fallback)
  if (!(ms > 0)) return guarded
  let timer: ReturnType<typeof setTimeout> | undefined
  const onTimeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([guarded, onTimeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Emit a lifecycle event without ever letting a transport/storage failure escape into the host loop
 * (ADR-20 degrade contract): bookkeeping must never break or block what the host is doing. Used by
 * beginTurn, instrumentRun, and the TurnHandle resolution methods so a down/erroring (FIX-02-08-01) OR
 * slow/hanging (FIX-02-08-02) daemon is a no-op. The emit is bounded by `timeoutMs`: a reachable-but-slow
 * daemon must not stall a tool call or the turn resolution. Exported so integrators that hand-roll emit
 * hooks (e.g. an SDK's on_tool_start/on_tool_end, where there is no wrappable execute to pass to
 * instrumentRun) get the same degrade guarantee. */
export async function safeEmit(
  engine: LoopEngine,
  event: LifecycleEvent,
  timeoutMs = DEFAULT_EMIT_TIMEOUT_MS,
): Promise<void> {
  await withTimeout(engine.emit(event), timeoutMs, undefined)
}

export function surfacedIds(decision: Decision): string[] {
  // Shape-defensive (FIX-02-08-01): a malformed decision (e.g. a partial daemon frame that resolved
  // without rejecting) must yield an empty set, never throw into beginTurn.
  if (!decision || typeof decision !== 'object') return []
  if (decision.mode === 'sequence') return typeof decision.nextCapability === 'string' ? [decision.nextCapability] : []
  return Array.isArray(decision.ranked)
    ? decision.ranked.map((r) => r?.capabilityId).filter((id): id is string => typeof id === 'string')
    : []
}

/**
 * Order the host's full tool list by a surfaced ranking, keeping every tool (rank-all, ADR-13).
 * Tools whose key is not in `surfaced` keep their original relative order, appended after the ranked
 * ones. Empty `surfaced` -> original order (no-op).
 *
 * NOT the recommended default (ADR-26): reordering the tool block makes Stigmergy a second selector
 * that competes with the host's own retrieval (progressive disclosure) and can degrade it. The
 * recommended surfacing is silent-by-default plus a sequence-gated path hint (see pathGuidanceFor).
 * This helper stays available for hosts that explicitly want pheromone-ordering and accept the tradeoff.
 */
export function orderBySurfaced<T>(tools: readonly T[], surfaced: readonly string[], key: (t: T) => string): T[] {
  const rank = new Map(surfaced.map((id, i) => [id, i] as const))
  return tools
    .map((t, i) => ({ t, i, r: rank.get(key(t)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t)
}

/** A learned path that fits the current task, ready to inject as small per-turn guidance. */
export interface PathGuidance {
  /** The capability sequence (next step first); empty when no learned path applies. This doubles as the
   * pre-activation list (ADR-26): when non-empty, the host can activate exactly these capabilities (e.g.
   * its deferred tools) so the model has them without re-discovering, instead of reordering the tool block. */
  path: string[]
  /** A ready-to-inject guidance string; empty when no learned path applies. */
  text: string
}

/**
 * Turn a 'sequence' decision (a learned or pinned path whose whenToUse matched the task, ADR-18) into
 * an injectable guidance block. A 'ranked' or 'enforce' decision carries no single learned path, so
 * the result is empty. `describe` optionally maps a capability id to a short description. Inject the
 * text as small per-turn context (after the prompt-cache breakpoint), never into the cached tool block.
 */
export function pathGuidanceFor(decision: Decision, describe?: (id: string) => string | undefined): PathGuidance {
  // Shape-defensive (FIX-02-08-01): only a well-formed sequence decision yields guidance.
  if (!decision || decision.mode !== 'sequence' || typeof decision.nextCapability !== 'string') return { path: [], text: '' }
  const path = [decision.nextCapability, ...(Array.isArray(decision.remainingPath) ? decision.remainingPath : [])]
  const steps = path.map((id) => {
    const d = describe?.(id)
    return d ? `${id} (${d})` : id
  })
  const text = `Stigmergy learned a proven approach for this kind of task. Consider this capability sequence (you may follow it or deviate): ${steps.join(' -> ')}.`
  return { path, text }
}

/**
 * Wrap a tool executor so calling it emits capability_invoked, then capability_returned
 * (success on resolve, failure on throw, original error rethrown). The SDK adapters reuse
 * this to instrument whatever execute shape their framework exposes.
 */
export function instrumentRun<Args extends unknown[], R>(
  engine: LoopEngine,
  taskId: string,
  capabilityId: string,
  run: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    // All three emits are bookkeeping and run through safeEmit: a down/erroring daemon between
    // beginTurn and the call must never stop the host's tool from running or returning, and the tool's
    // own error is the only thing that propagates (FIX-02-08-01, extends the AUDIT F-25 guarantee).
    await safeEmit(engine, { type: 'capability_invoked', taskId, capabilityId })
    try {
      const result = await run(...args)
      await safeEmit(engine, { type: 'capability_returned', taskId, capabilityId, success: true })
      return result
    } catch (err) {
      await safeEmit(engine, { type: 'capability_returned', taskId, capabilityId, success: false })
      throw err
    }
  }
}

/** One in-flight turn. Carries the decision plus the helpers to instrument and close it. */
export class TurnHandle {
  constructor(
    private readonly engine: LoopEngine,
    readonly taskId: string,
    readonly decision: Decision,
    readonly surfaced: string[],
    /** When true (Stigmergy disabled, ADR-20), every method is a no-op: tools pass through unwrapped
     * and no lifecycle events are emitted, so a wired-but-disabled loop does nothing. */
    private readonly disabled = false,
  ) {}

  /** Whether this turn is active (Stigmergy enabled, ADR-20). When false, instrument/end/accept and the
   * SDK integrations must not emit, so a wired-but-disabled loop does nothing. */
  get enabled(): boolean {
    return !this.disabled
  }

  /** Wrap tools so calling one emits capability_invoked, then capability_returned (success/failure). */
  instrument<T extends Tool>(tools: readonly T[]): T[] {
    if (this.disabled) return [...tools] // pass through unwrapped: no capability_invoked/returned
    return tools.map(
      (t) => ({ ...t, run: instrumentRun(this.engine, this.taskId, t.id, t.run) }) as unknown as T,
    )
  }

  /** Order the host's full tool list by this turn's surfaced ranking without dropping any (rank-all).
   * The model still sees every tool; only the order reflects learned strength plus relevance, so the
   * tool block stays stable and the prompt cache stays warm. Disabled turn -> original order (no-op). */
  orderTools<T>(tools: readonly T[], key: (t: T) => string): T[] {
    if (this.disabled) return [...tools]
    return orderBySurfaced(tools, this.surfaced, key)
  }

  /** The learned path that fits this task as an injectable guidance block, or empty when none applies
   * (a 'ranked'/'enforce' decision, or a disabled turn). Inject the text as small per-turn context so
   * it never rewrites the cached tool block. `describe` optionally maps an id to a short description. */
  pathGuidance(describe?: (id: string) => string | undefined): PathGuidance {
    if (this.disabled) return { path: [], text: '' }
    return pathGuidanceFor(this.decision, describe)
  }

  /** Mark the response delivered. The tracker then arms the auto-accept timeout. */
  async end(): Promise<void> {
    if (this.disabled) return
    await safeEmit(this.engine, { type: 'response_delivered', taskId: this.taskId })
  }

  /** Resolve the turn as accepted (reinforces the path). */
  async accept(tokenCost: number): Promise<void> {
    if (this.disabled) return
    await safeEmit(this.engine, { type: 'task_accepted', taskId: this.taskId, tokenCost })
  }

  /** Continue the same turn after a revision (weaker reward on the eventual accept). */
  async iterate(newContext?: string): Promise<void> {
    if (this.disabled) return
    await safeEmit(this.engine, { type: 'task_iterated', taskId: this.taskId, newContext })
  }

  /** Resolve the turn as abandoned (negative evidence, no reinforcement). */
  async abandon(): Promise<void> {
    if (this.disabled) return
    await safeEmit(this.engine, { type: 'task_abandoned', taskId: this.taskId })
  }
}

/** Facade over a LoopEngine (embedded StigmergyEngine or a remote daemon client) for a controlled loop.
 * The optional timeouts bound how long any single engine call may block the host before the facade
 * degrades (FIX-02-08-02); leave them at the defaults unless the engine has known-slow characteristics. */
export class StigmergyLoop {
  private readonly consultTimeoutMs: number
  private readonly gateTimeoutMs: number
  constructor(
    private readonly engine: LoopEngine,
    opts: { consultTimeoutMs?: number; gateTimeoutMs?: number } = {},
  ) {
    this.consultTimeoutMs = opts.consultTimeoutMs ?? DEFAULT_CONSULT_TIMEOUT_MS
    this.gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  }

  /** Start a turn: emit task_started, consult, and emit capability_loaded for the surfaced set. */
  async beginTurn(input: BeginTurnInput): Promise<TurnHandle> {
    // Degrade contract (ADR-20): the facade must NEVER throw into (FIX-02-08-01) or block (FIX-02-08-02)
    // the host loop, for ANY injected engine. Disabled, unavailable (isEnabled rejects), OR slow
    // (isEnabled times out) -> a no-op turn whose methods all no-op, indistinguishable from a wired-but-off
    // Stigmergy. withTimeout turns both a rejection and an overrun into the fallback.
    const disabledTurn = (): TurnHandle =>
      new TurnHandle(this.engine, input.task_id, { mode: 'ranked', ranked: [] }, [], true)
    if (!(await withTimeout(this.engine.isEnabled(), this.gateTimeoutMs, false))) return disabledTurn()
    // From here every engine call is bookkeeping: task_started runs through safeEmit (bounded, swallowed);
    // a failing OR slow consult yields an empty decision so the turn still returns and the host runs its
    // full tool set unchanged; capability_loaded emits are bounded and swallowed. Nothing in this path can
    // throw into or hang the host.
    await safeEmit(this.engine, { type: 'task_started', taskId: input.task_id, context: input.prompt })
    const decision = await withTimeout(
      this.engine.consult({
        task_id: input.task_id,
        context: input.prompt,
        candidate_ids: input.candidate_ids,
        top_k: input.top_k,
      }),
      this.consultTimeoutMs,
      { mode: 'ranked', ranked: [] } as Decision,
    )
    const surfaced = surfacedIds(decision)
    for (const id of surfaced) {
      await safeEmit(this.engine, { type: 'capability_loaded', taskId: input.task_id, capabilityId: id })
    }
    return new TurnHandle(this.engine, input.task_id, decision, surfaced)
  }
}
