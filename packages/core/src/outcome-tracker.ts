// OutcomeTracker (FEAT-01-03, ADR-05): the lifecycle state machine. It consumes
// LifecycleEvents, maintains in-flight buffers, arms the auto-accept timeout via
// the Scheduler, applies the topic-shift heuristic, and resolves each buffer
// exactly once into a ResolvedPath. It does no storage IO: the engine supplies
// onResolve to deposit the resolution inside a transaction (PLAN-04).

import { START_NODE } from './types.js'
import type { LifecycleEvent, Outcome } from './types.js'
import type { ClockProvider } from './clock.js'
import type { Scheduler } from './scheduler.js'
import type { PendingStore, PendingBuffer } from './pending-store.js'
import { cosine } from './vector.js'

/** A directed transition prev -> capabilityId, the unit of deposit. */
export interface EdgeRef {
  prev: string
  capabilityId: string
}

export interface ResolvedPath {
  taskId: string
  outcome: Outcome
  contextText: string
  /** Invoked capabilities in order, the reinforced trail. */
  path: string[]
  /** Invoked and not returned-failed: positive evidence. */
  successes: EdgeRef[]
  /** Invoked and returned with success=false: negative evidence. */
  failures: EdgeRef[]
  /** Loaded but never invoked: negative-space evidence (ADR-05). */
  discarded: EdgeRef[]
  tokenCost: number
}

export interface OutcomeTrackerConfig {
  /** Idle time after response_delivered before a buffer auto-accepts. */
  timeoutMs: number
  /** Cosine at or above which a new task continues the last frozen buffer (iteration). */
  topicShiftThreshold: number
}

export const DEFAULT_TRACKER_CONFIG: OutcomeTrackerConfig = {
  timeoutMs: 30 * 60 * 1000,
  topicShiftThreshold: 0.6,
}

// Returns undefined when the background embedder has no vector for the text yet (ADR-25); the
// topic-shift heuristic then treats the pair as a topic change (the safe default).
export type EmbedFn = (text: string) => Promise<Float32Array | undefined>
export type ResolveFn = (resolution: ResolvedPath) => Promise<void>
/** Serialises the timeout-fired resolution against the engine's other operations. */
export type LockFn = <T>(fn: () => Promise<T>) => Promise<T>

export interface OutcomeTrackerDeps {
  store: PendingStore
  scheduler: Scheduler
  clock: ClockProvider
  embed: EmbedFn
  onResolve: ResolveFn
  /** Optional mutex; wraps the Scheduler timeout callback so it never interleaves an open operation. */
  lock?: LockFn
  config?: OutcomeTrackerConfig
}

export class OutcomeTracker {
  private readonly store: PendingStore
  private readonly scheduler: Scheduler
  private readonly clock: ClockProvider
  private readonly embed: EmbedFn
  private readonly onResolve: ResolveFn
  private readonly lock: LockFn
  private readonly config: OutcomeTrackerConfig

  constructor(deps: OutcomeTrackerDeps) {
    this.store = deps.store
    this.scheduler = deps.scheduler
    this.clock = deps.clock
    this.embed = deps.embed
    this.onResolve = deps.onResolve
    this.lock = deps.lock ?? ((fn) => fn())
    this.config = deps.config ?? DEFAULT_TRACKER_CONFIG
  }

  async handle(event: LifecycleEvent): Promise<void> {
    switch (event.type) {
      case 'task_started':
        await this.onTaskStarted(event.taskId, event.context)
        return
      case 'capability_loaded':
        this.onLoaded(event.taskId, event.capabilityId)
        return
      case 'capability_invoked':
        this.onInvoked(event.taskId, event.capabilityId)
        return
      case 'capability_returned':
        this.onReturned(event.taskId, event.capabilityId, event.success)
        return
      case 'response_delivered':
        this.onDelivered(event.taskId)
        return
      case 'task_iterated':
        this.onIterated(event.taskId, event.newContext)
        return
      case 'task_accepted': {
        const buf = this.store.get(event.taskId)
        const outcome: Outcome = buf?.wasIterated ? 'iterated' : 'accepted'
        await this.resolve(event.taskId, outcome, event.tokenCost)
        return
      }
      case 'task_abandoned':
        await this.resolve(event.taskId, 'abandoned', 0)
        return
    }
  }

  private async onTaskStarted(taskId: string, context: string): Promise<void> {
    const frozen = this.store.all().filter((b) => b.status === 'frozen')
    if (frozen.length > 0) {
      const last = frozen.reduce((a, b) => ((b.deliveredAtMs ?? 0) > (a.deliveredAtMs ?? 0) ? b : a))
      const a = await this.embed(context)
      const b = await this.embed(last.contextText)
      // A missing vector (background embedder not warm yet, ADR-25) -> sim -1 -> treated as a topic
      // change, the safe default: open the new buffer and resolve the previous one.
      const sim = a && b && a.length === b.length ? cosine(a, b) : -1
      if (sim >= this.config.topicShiftThreshold) {
        // Iteration: the new id continues the previous buffer, watcher reset.
        this.store.alias(taskId, last.taskId)
        this.cancelTimeout(last)
        last.status = 'open'
        last.wasIterated = true
        return
      }
      // Topic change: open the new buffer FIRST so a failed previous-buffer deposit
      // cannot drop the freshly started task, then resolve the previous one.
      this.store.open(taskId, context)
      const outcome: Outcome = last.wasIterated ? 'iterated' : 'accepted'
      await this.resolve(last.taskId, outcome, 0)
      return
    }
    this.store.open(taskId, context)
  }

  private onLoaded(taskId: string, capabilityId: string): void {
    const buf = this.store.get(taskId)
    if (!buf) return
    // A re-load of an already-invoked capability is not a discarded alternative (no phantom self-loop).
    if (buf.uses.some((u) => u.capabilityId === capabilityId && u.invoked)) return
    const prev = this.trailTip(buf)
    const existing = buf.uses.find((u) => u.capabilityId === capabilityId && !u.invoked)
    if (existing) existing.prev = prev // double-load: last load-prev wins (ADR-05)
    else buf.uses.push({ capabilityId, prev, invoked: false })
  }

  private onInvoked(taskId: string, capabilityId: string): void {
    const buf = this.store.get(taskId)
    if (!buf) return
    const use = [...buf.uses].reverse().find((u) => u.capabilityId === capabilityId && !u.invoked)
    if (use) {
      use.invoked = true
      use.invokeSeq = buf.invokeCounter++
    } else {
      buf.uses.push({ capabilityId, prev: this.trailTip(buf), invoked: true, invokeSeq: buf.invokeCounter++ })
    }
  }

  private onReturned(taskId: string, capabilityId: string, success: boolean): void {
    const buf = this.store.get(taskId)
    if (!buf) return
    const use = [...buf.uses]
      .reverse()
      .find((u) => u.capabilityId === capabilityId && u.invoked && u.returnedSuccess === undefined)
    if (use) use.returnedSuccess = success
  }

  private onDelivered(taskId: string): void {
    const buf = this.store.get(taskId)
    if (!buf) return
    buf.status = 'frozen'
    buf.deliveredAtMs = this.clock.now()
    this.armTimeout(buf)
  }

  /** Arm (or re-arm) the auto-accept timer for a frozen buffer. */
  private armTimeout(buf: PendingBuffer): void {
    this.cancelTimeout(buf)
    const canonical = buf.taskId
    buf.timeoutHandle = this.scheduler.setTimer(this.config.timeoutMs, () =>
      // Lock so the fired timeout never interleaves a consult/emit mid-operation.
      this.lock(async () => {
        const b = this.store.get(canonical)
        if (!b) return
        const outcome: Outcome = b.wasIterated ? 'iterated' : 'accepted'
        try {
          await this.resolve(canonical, outcome, 0)
        } catch {
          // Deposit failed (e.g. transient storage error): re-arm so the auto-accept retries.
          this.armTimeout(b)
        }
      }),
    )
  }

  private onIterated(taskId: string, newContext?: string): void {
    const buf = this.store.get(taskId)
    if (!buf) return
    this.cancelTimeout(buf)
    buf.status = 'open'
    buf.wasIterated = true
    if (newContext) buf.contextText = newContext
  }

  /**
   * Resolve a buffer exactly once: build the path, deposit, then cancel the timer and delete.
   * The timer is cancelled only AFTER onResolve succeeds, so a failed (rolled-back) deposit
   * leaves the in-flight buffer AND its auto-accept timer intact for a later retry; the deposit
   * itself is idempotent (PLAN-04 critique).
   */
  private async resolve(taskId: string, outcome: Outcome, tokenCost: number): Promise<void> {
    const buf = this.store.get(taskId)
    if (!buf || buf.resolving) return // already resolved or in flight (idempotency guard, ADR-05)
    buf.resolving = true
    const resolution = this.buildResolution(buf, outcome, tokenCost)
    try {
      await this.onResolve(resolution)
    } catch (err) {
      buf.resolving = false // deposit failed: keep the buffer and its timer so a later accept/timer can retry
      throw err
    }
    this.cancelTimeout(buf)
    this.store.delete(taskId)
  }

  private buildResolution(buf: PendingBuffer, outcome: Outcome, tokenCost: number): ResolvedPath {
    const path: string[] = []
    const successes: EdgeRef[] = []
    const failures: EdgeRef[] = []
    const discarded: EdgeRef[] = []

    // The reinforced trail follows invocation order (invokeSeq), not load order.
    const invoked = buf.uses
      .filter((u) => u.invoked)
      .sort((a, b) => (a.invokeSeq ?? 0) - (b.invokeSeq ?? 0))
    let lastInvoked = START_NODE
    for (const u of invoked) {
      const prev = lastInvoked
      path.push(u.capabilityId)
      // Skip self-loop edges (a capability invoked twice in a row): they are not a real transition.
      if (prev !== u.capabilityId) {
        if (u.returnedSuccess === false) failures.push({ prev, capabilityId: u.capabilityId })
        else successes.push({ prev, capabilityId: u.capabilityId })
      }
      lastInvoked = u.capabilityId
    }

    const invokedIds = new Set(invoked.map((u) => u.capabilityId))
    for (const u of buf.uses) {
      if (u.invoked) continue
      if (invokedIds.has(u.capabilityId)) continue // re-load of an invoked capability is not discarded
      if (u.prev === u.capabilityId) continue // never emit a self-loop edge
      discarded.push({ prev: u.prev, capabilityId: u.capabilityId })
    }
    return { taskId: buf.taskId, outcome, contextText: buf.contextText, path, successes, failures, discarded, tokenCost }
  }

  private trailTip(buf: PendingBuffer): string {
    let bestSeq = -1
    let tip = START_NODE
    for (const u of buf.uses) {
      if (u.invoked && (u.invokeSeq ?? -1) > bestSeq) {
        bestSeq = u.invokeSeq ?? -1
        tip = u.capabilityId
      }
    }
    return tip
  }

  private cancelTimeout(buf: PendingBuffer): void {
    if (buf.timeoutHandle !== undefined) {
      this.scheduler.clear(buf.timeoutHandle)
      buf.timeoutHandle = undefined
    }
  }
}
