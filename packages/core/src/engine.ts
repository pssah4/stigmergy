// createEngine wires Core, Storage, and Embedding into the embedded-first engine
// (ADR-12, FEAT-01-04). It implements no scoring or decay maths of its own; it
// orchestrates the tested primitives (score, decay, consult, deposit) and
// serialises consult/deposit/pinPath/reset through an async mutex so a Scheduler
// timeout never lands inside an open transaction (PLAN-04 critique resolution).

import { START_NODE } from './types.js'
import type { Capability, CapabilityType, Decision, Edge, LifecycleEvent, PinBehavior, PinnedPath, Task } from './types.js'
import type { StoragePort, EmbeddingPort } from './ports.js'
import type { ClockProvider } from './clock.js'
import { SystemClock } from './clock.js'
import type { Scheduler } from './scheduler.js'
import { RealScheduler } from './scheduler.js'
import type { SeededRng } from './rng.js'
import { mulberry32 } from './rng.js'
import { prevOf, buildCandidate, toRanking, resolvePinnedDecision, halfLifeFor } from './consult.js'
import type { Candidate } from './score.js'
import { select } from './score.js'
import { decayedPheromone, decayedCount } from './decay.js'
import { acceptanceWeight, clampEfficiency, computeDelta, clip, edgePairs } from './deposit.js'
import { cosine, isoToMs, msToIso } from './vector.js'
import { CachedFlag } from './runtime-flag.js'
import { ValidationError } from './errors.js'
import { MemoryPendingStore } from './pending-store.js'
import type { PendingStore } from './pending-store.js'
import { OutcomeTracker } from './outcome-tracker.js'
import type { ResolvedPath, EdgeRef } from './outcome-tracker.js'
import { BackgroundEmbedder } from './embedding-worker.js'
import type { EmbeddedCapability } from './embedding-worker.js'
import {
  DEFAULT_STIGMERGY_CONFIG,
  type ConsultInput,
  type DepositInput,
  type CapabilityAugmenter,
  type EngineDeps,
  type PinPathInput,
  type ReinforcePathInput,
  type RegisterCapabilityInput,
  type StigmergyConfig,
  type StigmergyEngine,
  type SubstrateBackup,
  type PathExport,
  type CapabilitySnapshot,
} from './api-types.js'

/** Generous input ceilings at the public API edge (AUDIT F-03); the host stays the trust anchor. */
const MAX_CONTEXT_CHARS = 100_000
const MAX_SEQUENCE_LEN = 1000

/** Runtime enable flag (FEAT-04-06): key in runtime_config and the TTL of the loop-side read cache. */
const ENABLED_KEY = 'enabled'
const FLAG_TTL_MS = 2000

/** Pin strength precedence: the most restrictive behavior covering an edge wins. */
const PIN_RANK: Record<PinBehavior, number> = { preferred: 1, sequence: 2, enforce: 3 }
function strongerPin(a: PinBehavior | null, b: PinBehavior): PinBehavior {
  if (a === null) return b
  return PIN_RANK[b] > PIN_RANK[a] ? b : a
}

/** Promise-chain mutex: serialises async sections without blocking the event loop. */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    return prev.then(fn).finally(release)
  }
}

class EngineImpl implements StigmergyEngine {
  private readonly storage: StoragePort
  private readonly embedding: EmbeddingPort
  private readonly augmenter?: CapabilityAugmenter
  private readonly clock: ClockProvider
  private readonly cfg: StigmergyConfig
  private readonly rng: SeededRng
  private readonly pending: PendingStore
  private readonly tracker: OutcomeTracker
  private readonly mutex = new Mutex()
  private readonly enabledCache = new CachedFlag(FLAG_TTL_MS)
  // The only owner of the EmbeddingPort: all embedding (query, capability, whenToUse) runs here off the
  // hot path (ADR-25). consult/registration read its in-memory index and enqueue; they never embed.
  private readonly embedder: BackgroundEmbedder
  private readonly recentOutcomes: boolean[] = []
  private pinCounter = 0

  /** Record a resolved task outcome for the adaptive-exploration window (FEAT-02-05). */
  private recordOutcome(success: boolean): void {
    const w = this.cfg.exploration.recentWindow
    if (w <= 0) return // window disabled; do not grow the buffer
    this.recentOutcomes.push(success)
    if (this.recentOutcomes.length > w) this.recentOutcomes.splice(0, this.recentOutcomes.length - w)
  }

  /** Recent success rate over the last recentWindow resolved tasks; undefined when none yet. */
  private recentSuccessRate(): number | undefined {
    if (this.recentOutcomes.length === 0) return undefined
    const ok = this.recentOutcomes.reduce((acc, b) => acc + (b ? 1 : 0), 0)
    return ok / this.recentOutcomes.length
  }

  constructor(deps: EngineDeps) {
    this.storage = deps.storage
    this.embedding = deps.embedding
    this.augmenter = deps.augmenter
    this.clock = deps.clock ?? new SystemClock()
    const scheduler: Scheduler = deps.scheduler ?? new RealScheduler(deps.onSchedulerError)
    this.cfg = {
      score: deps.config?.score ?? DEFAULT_STIGMERGY_CONFIG.score,
      decay: deps.config?.decay ?? DEFAULT_STIGMERGY_CONFIG.decay,
      deposit: deps.config?.deposit ?? DEFAULT_STIGMERGY_CONFIG.deposit,
      tracker: deps.config?.tracker ?? DEFAULT_STIGMERGY_CONFIG.tracker,
      exploration: deps.config?.exploration ?? DEFAULT_STIGMERGY_CONFIG.exploration,
      seed: deps.config?.seed ?? DEFAULT_STIGMERGY_CONFIG.seed,
      sourceHost: deps.config?.sourceHost ?? DEFAULT_STIGMERGY_CONFIG.sourceHost,
      maxCandidates: deps.config?.maxCandidates ?? DEFAULT_STIGMERGY_CONFIG.maxCandidates,
      whenToUseThreshold: deps.config?.whenToUseThreshold ?? DEFAULT_STIGMERGY_CONFIG.whenToUseThreshold,
    }
    this.rng = mulberry32(this.cfg.seed)
    this.pending = new MemoryPendingStore()
    // The background embedder owns the EmbeddingPort plus the augmenter; nothing else calls embed (ADR-25).
    this.embedder = new BackgroundEmbedder({
      embedding: this.embedding,
      augmenter: this.augmenter,
      onCapabilityEmbedded: (r) => this.persistCapabilityEmbedding(r),
      onError: deps.onSchedulerError ?? (() => {}),
    })
    this.tracker = new OutcomeTracker({
      store: this.pending,
      scheduler,
      clock: this.clock,
      // Topic-shift reads the background index (no live embed); a cold context yields undefined.
      embed: async (t) => this.queryVectorFor(t),
      onResolve: (r) => this.applyDeposit(r),
      // The timeout callback runs under the engine mutex so it cannot interleave consult/emit.
      lock: (fn) => this.mutex.run(fn),
      config: this.cfg.tracker,
    })
  }

  async init(): Promise<void> {
    await this.storage.init()
    await this.reconcilePinnedEdges()
    await this.warmEmbeddingIndex()
  }

  /** Heal pinned-edge drift on startup: an edge can carry a stale pinned flag with no covering pinned
   * path (observed in the field after older code paths / resets). Such an orphan renders as a red
   * "path" the panel cannot list. Mirror deletePath: unpin an orphan that has run history (keep it as a
   * learned gray edge), and delete a pure phantom (pinned but never run). A no-orphan substrate is a
   * read-only no-op, so the common start path adds no write. */
  private async reconcilePinnedEdges(): Promise<void> {
    // Cheap read-only early-out so a healthy substrate adds no write; the authoritative reads happen
    // inside the transaction (no read-then-write race), under the same mutex as deposit/pin/delete.
    if ((await this.storage.listEdges()).every((e) => !e.pinned)) return
    await this.mutex.run(() =>
      this.storage.transaction(async () => {
        const pinnedEdges = (await this.storage.listEdges()).filter((e) => e.pinned)
        if (pinnedEdges.length === 0) return
        const covered = new Set<string>()
        for (const p of await this.storage.listPinnedPaths()) {
          for (const [from, to] of edgePairs(p.capabilitySequence)) covered.add(`${from}->${to}`)
        }
        for (const e of pinnedEdges) {
          if (covered.has(`${e.fromCapability}->${e.toCapability}`)) continue
          if (e.successCount === 0 && e.failureCount === 0) {
            await this.storage.deleteEdge(e.fromCapability, e.toCapability)
          } else {
            await this.storage.upsertEdge({ ...e, pinned: false, pinBehavior: null, pinOwner: null })
          }
        }
      }),
    )
  }

  /** Prime the background index from persisted vectors so a warm start needs no re-embed, and re-enqueue
   * anything whose stored vector is absent or stamped under a different model (ADR-25). Pin whenToUse
   * texts are enqueued as queries so the gate can discriminate once they warm. */
  private async warmEmbeddingIndex(): Promise<void> {
    const model = this.embedding.modelHash()
    for (const c of await this.storage.listCapabilities()) {
      if (c.id === START_NODE) continue
      if (c.descriptionEmbedding && c.embeddingModel === model) {
        this.embedder.primeCapabilityVector(c.id, c.descriptionEmbedding, model)
      } else if ((c.descriptionAugmented ?? c.description) !== '') {
        const alreadyAugmented = c.descriptionAugmented !== undefined
        const augment = this.augmenter !== undefined && !alreadyAugmented
        this.embedder.enqueueCapability(c.id, augment ? c.description : c.descriptionAugmented ?? c.description, c.type, augment)
      }
    }
    for (const pp of await this.storage.listPinnedPaths()) {
      if (pp.whenToUse && pp.whenToUse.trim() !== '') this.embedder.enqueueQuery(pp.whenToUse)
    }
  }

  async consult(input: ConsultInput): Promise<Decision> {
    if (input.top_k !== undefined && (!Number.isFinite(input.top_k) || input.top_k < 0)) {
      throw new ValidationError('consult: top_k must be a non-negative finite number')
    }
    if (input.context.length > MAX_CONTEXT_CHARS) {
      throw new ValidationError(`consult: context exceeds ${MAX_CONTEXT_CHARS} characters`)
    }
    // Never embed on the hot path (ADR-25): read the query vector from the background index and enqueue
    // it on a miss. A cold context yields undefined this turn, so the gate opens and ranking falls back
    // to pheromone (etaFloor); the vector lands a tick later and sharpens subsequent turns.
    const q = this.queryVectorFor(input.context)
    return this.mutex.run(async () => {
      const prev = prevOf(input.history)
      const caps = input.candidate_ids
        ? (await Promise.all(input.candidate_ids.map((id) => this.storage.getCapability(id)))).filter(
            (c): c is Capability => c !== null,
          )
        : await this.storage.listCapabilities()
      const capIds = caps.map((c) => c.id)
      const outgoing = await this.storage.listOutgoingEdges(prev)
      const pins = await this.storage.listPinnedPaths()
      // whenToUse gate (ADR-18, FEAT-04-03): a sequence pin fires only when its whenToUse embedding is
      // similar enough to the task context; an empty/dim-mismatched whenToUse fires unconditionally.
      const threshold = this.cfg.whenToUseThreshold
      const gateOpen = (pp: PinnedPath): boolean => {
        if (!q) return true // query not warm yet: fire unconditionally (eventual consistency, ADR-25)
        const emb = pp.whenToUse ? this.embedder.getQueryVector(pp.whenToUse) : undefined
        if (!emb || emb.length !== q.length) {
          if (pp.whenToUse && pp.whenToUse.trim() !== '') this.embedder.enqueueQuery(pp.whenToUse)
          return true
        }
        return cosine(emb, q) >= threshold
      }
      const pin = resolvePinnedDecision(prev, capIds, pins, outgoing, gateOpen)
      if (pin?.kind === 'sequence') return pin.decision

      // Reuse the already-fetched outgoing edges instead of one getEdge per candidate (AUDIT F-05).
      const edgeByTo = new Map(outgoing.map((e) => [e.toCapability, e]))
      let target = pin?.kind === 'enforce' ? caps.filter((c) => pin.restrictTo.includes(c.id)) : caps
      // Top-N similarity prefilter (ADR-17, FEAT-04-02): when the host passes no candidate_ids and the
      // registry exceeds maxCandidates (a large discovered MCP/skill catalog), keep only the most
      // similar capabilities before scoring, so never-foraged optimistic nodes cannot flood the ranked
      // set. Below the cap target is untouched, so selection stays byte-identical.
      if (input.candidate_ids === undefined && target.length > this.cfg.maxCandidates) {
        if (q) {
          const withSim = target.map((c) => ({ c, sim: this.simFor(c, q) }))
          withSim.sort((a, b) => b.sim - a.sim)
          target = withSim.slice(0, this.cfg.maxCandidates).map((x) => x.c)
        } else {
          // No query vector yet: keep a deterministic id-ordered slice instead of similarity-ranking.
          target = [...target].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, this.cfg.maxCandidates)
        }
      }
      const sorted = [...target].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const now = this.clock.now()
      const candidates: Candidate[] = []
      for (const c of sorted) {
        const edge = edgeByTo.get(c.id) ?? null
        // Read the capability vector from the background index (matching model only), enqueue on a miss;
        // never embed here. A missing vector yields etaFloor in buildCandidate (pheromone-only this turn).
        const capEmb = this.capVecFor(c)
        candidates.push(buildCandidate(c, edge, capEmb, q, now, this.cfg.decay))
      }
      const scored = select(candidates, this.cfg.score, this.rng, this.cfg.exploration, this.recentSuccessRate())
      const limited = input.top_k !== undefined ? scored.slice(0, input.top_k) : scored
      const ranked = toRanking(limited)
      return pin?.kind === 'enforce' ? { mode: 'enforce', ranked, forceFromSet: true } : { mode: 'ranked', ranked }
    })
  }

  async emit(event: LifecycleEvent): Promise<void> {
    // Reject the reserved sentinel as a capability id at the single funnel point for all lifecycle
    // events (facade and SDK adapters route through here), so a stray id cannot pollute the graph (AUDIT F).
    if ('capabilityId' in event && event.capabilityId === START_NODE) {
      throw new ValidationError(`emit: capabilityId "${START_NODE}" is reserved`)
    }
    // Serialise event handling with consult/deposit/pinPath/reset; the tracker's deposit runs lock-free.
    await this.mutex.run(() => this.tracker.handle(event))
  }

  async deposit(input: DepositInput): Promise<void> {
    if (!Number.isFinite(input.token_cost)) {
      throw new ValidationError('deposit: token_cost must be a finite number')
    }
    if (input.path.length > MAX_SEQUENCE_LEN) {
      throw new ValidationError(`deposit: path exceeds ${MAX_SEQUENCE_LEN} steps`)
    }
    const successes: EdgeRef[] = edgePairs(input.path).map(([prev, capabilityId]) => ({ prev, capabilityId }))
    const resolution: ResolvedPath = {
      taskId: input.task_id,
      outcome: input.outcome,
      contextText: input.context,
      path: input.path,
      successes,
      failures: [],
      discarded: [],
      tokenCost: input.token_cost,
    }
    await this.mutex.run(() => this.applyDeposit(resolution))
  }

  async reinforcePath(input: ReinforcePathInput): Promise<void> {
    this.validateManualPath(input)
    return this.mutex.run(() => this.applyManualBump(input.path, Math.abs(input.strength)))
  }

  async weakenPath(input: ReinforcePathInput): Promise<void> {
    this.validateManualPath(input)
    return this.mutex.run(() => this.applyManualBump(input.path, -Math.abs(input.strength)))
  }

  private validateManualPath(input: ReinforcePathInput): void {
    if (!Array.isArray(input.path) || input.path.length === 0) throw new ValidationError('path must be a non-empty capability sequence')
    if (input.path.length > MAX_SEQUENCE_LEN) throw new ValidationError(`path exceeds ${MAX_SEQUENCE_LEN} steps`)
    if (input.path.some((c) => c === START_NODE)) throw new ValidationError(`path must not contain the reserved node "${START_NODE}"`)
    if (!Number.isFinite(input.strength) || input.strength < 0) throw new ValidationError('strength must be a finite number >= 0')
  }

  /** Add (signed) pheromone to every edge along the path; bumpEdge clips to [tauMin, tauMax]. Pinned edges keep their pinned pheromone (the delta is a no-op there). */
  private async applyManualBump(path: string[], signedStrength: number): Promise<void> {
    // Manual reinforce/weaken operate on known capabilities only; a typo must not silently
    // create stub capabilities/edges and pollute the substrate (AUDIT review #10).
    for (const id of path) {
      if (id === START_NODE) continue
      if (!(await this.storage.getCapability(id))) {
        throw new ValidationError(`reinforce/weaken: unknown capability '${id}' (register it through the loop first)`)
      }
    }
    await this.storage.transaction(async () => {
      const nowMs = this.clock.now()
      for (const [from, to] of edgePairs(path)) {
        await this.bumpEdge(from, to, nowMs, signedStrength, 0, 0)
      }
    })
  }

  async listPaths(): Promise<PinnedPath[]> {
    // Reads also take the mutex so they never observe a writer's uncommitted rows on the shared connection.
    return this.mutex.run(() => this.storage.listPinnedPaths())
  }

  async getPath(id: string): Promise<PinnedPath | null> {
    return this.mutex.run(() => this.storage.getPinnedPath(id))
  }

  async deletePath(id: string): Promise<void> {
    await this.mutex.run(() =>
      this.storage.transaction(async () => {
        const pp = await this.storage.getPinnedPath(id)
        await this.storage.deletePinnedPath(id)
        if (!pp) return
        // Re-derive each affected edge from the surviving pins: a shared edge keeps the strongest
        // remaining pin, and only unpins when no pin covers it anymore. Then purge a phantom edge that
        // existed ONLY because of this pin: pinning creates edges at tauMax (syncPinnedEdge), so a
        // hand-built path that never ran would otherwise linger as a full-strength gray trail after
        // delete. An edge is purged only when no pin still covers it AND it carries no real run history
        // (successCount and failureCount both zero); a genuinely traversed or still-pinned edge stays.
        const paths = await this.storage.listPinnedPaths()
        const nowIso = msToIso(this.clock.now())
        for (const [from, to] of edgePairs(pp.capabilitySequence)) {
          await this.syncPinnedEdge(from, to, nowIso, paths)
          const edge = await this.storage.getEdge(from, to)
          if (edge && !edge.pinned && edge.successCount === 0 && edge.failureCount === 0) {
            await this.storage.deleteEdge(from, to)
          }
        }
      }),
    )
  }

  /** Remove a single learned edge by its (from, to) pair (FIX-06-06-01). Reject an edge that a pinned
   * path covers (the user should unpin the path instead) so a delete never orphans a saved path. The
   * check is against the pinned PATHS, not the edge's raw pinned flag, so a stale orphaned pin (a red
   * edge the panel cannot list) stays deletable, matching what the graph now shows. A missing edge is a
   * no-op (storage.deleteEdge deletes by match). */
  async deleteEdge(from: string, to: string): Promise<void> {
    await this.mutex.run(() =>
      this.storage.transaction(async () => {
        const covered = (await this.storage.listPinnedPaths()).some((p) =>
          edgePairs(p.capabilitySequence).some(([f, t]) => f === from && t === to),
        )
        if (covered) {
          throw new ValidationError(`deleteEdge: ${from} -> ${to} belongs to a pinned path; unpin the path instead`)
        }
        await this.storage.deleteEdge(from, to)
      }),
    )
  }

  async pinPath(input: PinPathInput): Promise<PinnedPath> {
    if (input.capability_sequence.length > MAX_SEQUENCE_LEN) {
      throw new ValidationError(`pinPath: capability_sequence exceeds ${MAX_SEQUENCE_LEN} steps`)
    }
    // whenToUse is embedded in the background (ADR-25): consult's gate reads its vector from the query
    // index by text, so the gate fires unconditionally until that text is warm, then discriminates.
    if (input.when_to_use && input.when_to_use.trim() !== '') this.embedder.enqueueQuery(input.when_to_use)
    const whenToUseEmbedding: Float32Array | undefined = undefined
    return this.mutex.run(async () => {
      const id = input.id ?? `pin-${++this.pinCounter}`
      const behavior = input.behavior ?? 'preferred'
      const nowIso = msToIso(this.clock.now())
      const pp: PinnedPath = {
        id,
        name: input.name,
        description: input.description,
        capabilitySequence: input.capability_sequence,
        parametersTemplate: input.parameters_template,
        behavior,
        // Emergent-naming provenance (ADR-19): the daemon pins with path_source 'emergent' plus a
        // whenToUse and the model id; a hand pin leaves them undefined (read defaults to 'manual').
        whenToUse: input.when_to_use,
        whenToUseEmbedding,
        pathSource: input.path_source,
        namedBy: input.named_by,
        namedAt: input.named_by ? nowIso : undefined,
        createdAt: nowIso,
        createdBy: input.created_by,
      }
      await this.storage.transaction(async () => {
        await this.storage.upsertPinnedPath(pp)
        // Composition over not-yet-observed nodes (ADR-17, FEAT-04-02): ensure every capability in the
        // sequence exists before its pinned edges, so a path composed from the Builder palette (or a
        // hand-typed id) never trips the edge FK. ensureCapability skips START and existing rows.
        for (const capId of input.capability_sequence) await this.ensureCapability(capId, this.clock.now())
        // Derive each edge's pin from the full pin set, so it is independent of call order.
        const paths = await this.storage.listPinnedPaths()
        for (const [from, to] of edgePairs(input.capability_sequence)) {
          await this.syncPinnedEdge(from, to, nowIso, paths)
        }
      })
      return pp
    })
  }

  async registerCapability(input: RegisterCapabilityInput): Promise<Capability> {
    if (input.id === START_NODE || (input.type as string) === '__system__') {
      throw new ValidationError('registerCapability: id and type "__system__" are reserved')
    }
    const cap = await this.mutex.run(async () => {
      const nowIso = msToIso(this.clock.now())
      const existing = await this.storage.getCapability(input.id)
      // Upsert the row immediately; embedding plus augmentation (FEAT-01-07, ADR-11) run in the
      // background (ADR-25), never on a hot or registration-storm path. A changed description drops the
      // prior vector/augmentation so the worker recomputes; an unchanged one preserves them.
      const sameDescription = existing?.description === input.description
      const cap: Capability = {
        id: input.id,
        type: input.type,
        description: input.description,
        descriptionEmbedding: sameDescription ? existing?.descriptionEmbedding : undefined,
        descriptionAugmented: sameDescription ? existing?.descriptionAugmented : undefined,
        augmentedAt: sameDescription ? existing?.augmentedAt : undefined,
        augmentedBy: sameDescription ? existing?.augmentedBy : undefined,
        // Provenance (ADR-17): an explicit discovery source wins; otherwise keep what a prior
        // registration recorded; a plainly-registered capability defaults to 'observed'.
        source: input.source ?? existing?.source ?? 'observed',
        // Stamp preserved only with a preserved vector (ADR-18, FEAT-04-07); the worker re-stamps on embed.
        embeddingModel: sameDescription ? existing?.embeddingModel : undefined,
        firstSeen: existing?.firstSeen ?? nowIso,
        lastSeen: nowIso,
      }
      await this.storage.upsertCapability(cap)
      return cap
    })
    // Enqueue embedding (and augmentation) in the background unless a valid vector for the current model
    // already exists. A still-unaugmented capability with an augmenter is re-attempted on every
    // registration (retry semantics, FEAT-01-07), even when a raw embedding already exists. Non-blocking:
    // registerCapability returns now; the vector lands a tick later (ADR-25).
    const embeddingValid = !!cap.descriptionEmbedding && cap.embeddingModel === this.embedding.modelHash()
    const augmentPending = this.augmenter !== undefined && cap.descriptionAugmented === undefined
    if (!embeddingValid || augmentPending) {
      this.embedder.enqueueCapability(
        input.id,
        augmentPending ? input.description : cap.descriptionAugmented ?? input.description,
        input.type,
        augmentPending,
      )
    }
    return cap
  }

  async listCapabilities(): Promise<Capability[]> {
    return this.mutex.run(() => this.storage.listCapabilities())
  }

  async stats() {
    return this.mutex.run(() => this.storage.getStats())
  }

  async backup(): Promise<SubstrateBackup> {
    return this.mutex.run(async () => {
      const caps = await this.storage.listCapabilities()
      const edges = await this.storage.listEdges()
      const tasks = await this.storage.listTasks()
      const pinnedPaths = await this.storage.listPinnedPaths()
      return {
        version: 1,
        capabilities: caps
          .filter((c) => c.id !== START_NODE)
          .map((c) => ({ id: c.id, type: c.type as CapabilityType, description: c.description })),
        edges,
        tasks: tasks.map(({ contextEmbedding, ...rest }) => rest),
        pinnedPaths,
      }
    })
  }

  async restore(data: SubstrateBackup): Promise<void> {
    if (!data || data.version !== 1) throw new ValidationError('restore: unsupported backup version')
    if (!Array.isArray(data.capabilities) || !Array.isArray(data.edges) || !Array.isArray(data.tasks) || !Array.isArray(data.pinnedPaths)) {
      throw new ValidationError('restore: backup is missing capabilities/edges/tasks/pinnedPaths')
    }
    this.assertTransportRecords('restore', data.capabilities, data.edges)
    return this.mutex.run(() =>
      this.storage.transaction(async () => {
        await this.storage.clearSubstrate()
        const nowIso = msToIso(this.clock.now())
        for (const c of data.capabilities) await this.upsertSnapshotCapability(c, nowIso)
        for (const e of data.edges) await this.storage.upsertEdge({ ...e, pheromone: clip(e.pheromone, this.cfg.decay.tauMin, this.cfg.decay.tauMax) })
        for (const t of data.tasks) await this.storage.upsertTask({ ...t })
        for (const pp of data.pinnedPaths) await this.storage.upsertPinnedPath(pp)
      }),
    )
  }

  async exportPath(id: string): Promise<PathExport | null> {
    return this.mutex.run(async () => {
      const pinnedPath = await this.storage.getPinnedPath(id)
      if (!pinnedPath) return null
      const edges: Edge[] = []
      for (const [from, to] of edgePairs(pinnedPath.capabilitySequence)) {
        const e = await this.storage.getEdge(from, to)
        if (e) edges.push(e)
      }
      const capabilities: CapabilitySnapshot[] = []
      for (const cid of pinnedPath.capabilitySequence) {
        const c = await this.storage.getCapability(cid)
        if (c && c.id !== START_NODE) capabilities.push({ id: c.id, type: c.type as CapabilityType, description: c.description })
      }
      return { version: 1, pinnedPath, capabilities, edges }
    })
  }

  async importPath(data: PathExport): Promise<PinnedPath> {
    if (!data || data.version !== 1) throw new ValidationError('importPath: unsupported export version')
    if (!Array.isArray(data.capabilities) || !Array.isArray(data.edges) || !data.pinnedPath) {
      throw new ValidationError('importPath: export is missing capabilities/edges/pinnedPath')
    }
    this.assertTransportRecords('importPath', data.capabilities, data.edges)
    return this.mutex.run(() =>
      this.storage.transaction(async () => {
        const nowIso = msToIso(this.clock.now())
        for (const c of data.capabilities) await this.upsertSnapshotCapability(c, nowIso)
        for (const e of data.edges) await this.storage.upsertEdge({ ...e, pheromone: clip(e.pheromone, this.cfg.decay.tauMin, this.cfg.decay.tauMax) })
        await this.storage.upsertPinnedPath(data.pinnedPath)
        return data.pinnedPath
      }),
    )
  }

  // Defense-in-depth (AUDIT FEAT-01-06 L-1): a hand-crafted backup/export must not re-inject the
  // reserved sentinel id or type, or non-finite pheromone, since restore/import bypass registerCapability.
  private assertTransportRecords(label: string, caps: readonly CapabilitySnapshot[], edges: readonly Edge[]): void {
    for (const c of caps) {
      if (c.id === START_NODE || (c.type as string) === '__system__') {
        throw new ValidationError(`${label}: capability id and type "__system__" are reserved (got ${c.id})`)
      }
    }
    for (const e of edges) {
      if (!Number.isFinite(e.pheromone)) {
        throw new ValidationError(`${label}: edge pheromone must be a finite number`)
      }
    }
  }

  private async upsertSnapshotCapability(c: CapabilitySnapshot, nowIso: string): Promise<void> {
    const existing = await this.storage.getCapability(c.id)
    await this.storage.upsertCapability({
      id: c.id,
      type: c.type,
      description: c.description,
      descriptionEmbedding: existing?.descriptionEmbedding,
      // Preserve provenance and augmentation of a live capability across an import (ADR-17): import
      // merges into the substrate without clearing, so a colliding id must NOT flip a discovered
      // 'mcp'/'skill'/'declared' source back to 'observed' or drop its augmented description. On
      // restore the substrate is cleared first, so existing is null and these stay undefined (the v1
      // backup transport never carried them; source then defaults to 'observed' on read).
      source: existing?.source,
      descriptionAugmented: existing?.descriptionAugmented,
      augmentedAt: existing?.augmentedAt,
      augmentedBy: existing?.augmentedBy,
      // embeddingModel intentionally left undefined (NULL) on restore/import (ADR-18, FEAT-04-07):
      // never carry a possibly-stale stamp onto a preserved vector; consult re-embeds it safely.
      embeddingModel: undefined,
      firstSeen: existing?.firstSeen ?? nowIso,
      lastSeen: nowIso,
    })
  }

  async reset(opts: { destroy: boolean }): Promise<void> {
    if (!opts.destroy) {
      throw new ValidationError('reset requires { destroy: true } to wipe the learned substrate')
    }
    await this.mutex.run(() => this.storage.transaction(() => this.storage.clearSubstrate()))
    for (const b of this.pending.all()) this.pending.delete(b.taskId)
  }

  async getRuntimeFlag(key: string): Promise<string | null> {
    return this.mutex.run(() => this.storage.getRuntimeConfig(key))
  }

  async setRuntimeFlag(key: string, value: string): Promise<void> {
    await this.mutex.run(() => this.storage.setRuntimeConfig(key, value))
    if (key === ENABLED_KEY) this.enabledCache.invalidate() // a local write is seen immediately
  }

  async isEnabled(): Promise<boolean> {
    // TTL-cached so the loop can gate every beginTurn without a per-turn storage round-trip (ADR-20).
    return this.enabledCache.get(this.clock.now(), () =>
      this.mutex.run(() => this.storage.getRuntimeConfig(ENABLED_KEY)).then((v) => v === '1'),
    )
  }

  /** Resolve once the background embedder has drained (vectors computed and persisted). The drain hook
   * for callers that need deterministic similarity/gating after a register or a novel query (ADR-25). */
  async whenEmbeddingsIdle(): Promise<void> {
    await this.embedder.whenIdle()
  }

  async close(): Promise<void> {
    // Drain pending embeds first so their vectors persist (a short-lived seed engine must not lose them),
    // then stop the worker so no scheduled drain outlives the storage handle.
    await this.embedder.whenIdle()
    await this.embedder.stop()
    await this.storage.close()
  }

  /**
   * Deposit a resolved path inside one transaction; idempotent via the task outcome (FEAT-01-04
   * SC-04). The caller (emit or the locked timeout callback) already holds the engine mutex, so
   * deposit takes no lock of its own (re-locking would deadlock). A transition traversed N times in
   * one task deposits its reward once: quality-coupled, not frequency-coupled (ADR-13).
   */
  private async applyDeposit(r: ResolvedPath): Promise<void> {
    const deposited = await this.storage.transaction(async () => {
      const existing = await this.storage.getTask(r.taskId)
      if (existing && existing.outcome !== null) return false // already deposited

      const nowMs = this.clock.now()
      const quality = acceptanceWeight(r.outcome)
      const efficiency = clampEfficiency(
        this.cfg.deposit.baselineCost,
        r.tokenCost,
        this.cfg.deposit.eMin,
        this.cfg.deposit.eMax,
      )
      const delta = computeDelta(quality, efficiency, this.cfg.deposit.rho)
      const positive = quality > 0

      const key = (e: EdgeRef) => `${e.prev}\u0000${e.capabilityId}`
      const positives = new Map<string, EdgeRef>()
      for (const s of r.successes) positives.set(key(s), s)
      const negatives = new Map<string, EdgeRef>()
      for (const e of [...r.failures, ...r.discarded]) if (!positives.has(key(e))) negatives.set(key(e), e)

      // Host-external discovery: a capability seen only through the loop is auto-registered as a stub
      // so the edge FOREIGN KEY holds; registerCapability later enriches it (firstSeen is preserved).
      const nodes = new Set<string>()
      for (const e of [...positives.values(), ...negatives.values()]) {
        nodes.add(e.prev)
        nodes.add(e.capabilityId)
      }
      for (const id of nodes) await this.ensureObserved(id, nowMs)

      for (const s of positives.values()) {
        if (positive) await this.bumpEdge(s.prev, s.capabilityId, nowMs, delta, 1, 0)
        else await this.bumpEdge(s.prev, s.capabilityId, nowMs, 0, 0, 1)
      }
      for (const n of negatives.values()) await this.bumpEdge(n.prev, n.capabilityId, nowMs, 0, 0, 1)

      await this.storage.upsertTask({
        id: r.taskId,
        contextText: r.contextText,
        path: r.path,
        outcome: r.outcome,
        tokenCost: r.tokenCost,
        createdAt: msToIso(nowMs),
        completedAt: msToIso(nowMs),
        sourceHost: this.cfg.sourceHost,
      })
      return true
    })
    if (deposited) this.recordOutcome(r.outcome === 'accepted')
  }

  /**
   * Derive an edge's pin state from the full set of pinned paths: pinned with the strongest
   * covering behavior (enforce > sequence > preferred), or unpinned if no path covers it.
   * Call-order independent, which fixes shared-edge pinning (PLAN-04 review).
   */
  private async syncPinnedEdge(from: string, to: string, nowIso: string, paths: PinnedPath[]): Promise<void> {
    let best: PinBehavior | null = null
    for (const p of paths) {
      if (edgePairs(p.capabilitySequence).some(([f, t]) => f === from && t === to)) {
        best = strongerPin(best, p.behavior)
      }
    }
    const existing = await this.storage.getEdge(from, to)
    if (best === null) {
      if (existing?.pinned) {
        await this.storage.upsertEdge({ ...existing, pinned: false, pinBehavior: null, pinOwner: null })
      }
      return
    }
    await this.storage.upsertEdge({
      fromCapability: from,
      toCapability: to,
      pheromone: this.cfg.decay.tauMax,
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      pinned: true,
      pinBehavior: best,
      pinOwner: 'user',
      lastUpdated: nowIso,
    })
  }

  /** Read a capability's vector from the background index (matching model only); enqueue an embed on a
   * miss and return undefined, so consult never embeds (ADR-25). A persisted vector for the current model
   * is primed into the index and returned, so a warm-from-disk capability needs no re-embed. */
  private capVecFor(c: Capability): Float32Array | undefined {
    const model = this.embedding.modelHash()
    const hit = this.embedder.getCapabilityVector(c.id)
    if (hit && hit.modelHash === model) return hit.vector
    if (c.descriptionEmbedding && c.embeddingModel === model) {
      this.embedder.primeCapabilityVector(c.id, c.descriptionEmbedding, model)
      return c.descriptionEmbedding
    }
    if ((c.descriptionAugmented ?? c.description) !== '') {
      const alreadyAugmented = c.descriptionAugmented !== undefined
      const augment = this.augmenter !== undefined && !alreadyAugmented
      this.embedder.enqueueCapability(c.id, augment ? c.description : c.descriptionAugmented ?? c.description, c.type, augment)
    }
    return undefined
  }

  /** Cosine of a capability against the query, or -Infinity when its vector is not warm yet (no embed). */
  private simFor(c: Capability, q: Float32Array): number {
    const v = this.capVecFor(c)
    return v && v.length === q.length ? cosine(v, q) : Number.NEGATIVE_INFINITY
  }

  /** Read the query vector from the background index; enqueue it on a miss and return undefined (ADR-25). */
  private queryVectorFor(text: string): Float32Array | undefined {
    const v = this.embedder.getQueryVector(text)
    if (!v) this.embedder.enqueueQuery(text)
    return v
  }

  /** Persist a vector the background embedder produced, preserving the row's other fields (under the
   * mutex, so it stays consistent with consult/deposit). Also lands any augmentation the worker computed. */
  private async persistCapabilityEmbedding(r: EmbeddedCapability): Promise<void> {
    await this.mutex.run(async () => {
      const existing = await this.storage.getCapability(r.id)
      if (!existing) return // deleted or reset while the embed was in flight
      await this.storage.upsertCapability({
        ...existing,
        descriptionEmbedding: r.vector,
        embeddingModel: r.modelHash,
        descriptionAugmented: r.augmented?.description ?? existing.descriptionAugmented,
        augmentedAt: r.augmented ? msToIso(this.clock.now()) : existing.augmentedAt,
        augmentedBy: r.augmented?.model ?? existing.augmentedBy,
      })
    })
  }

  /** Upsert a stub capability for an id first seen through the loop, so the edge FK holds. */
  private async ensureCapability(id: string, nowMs: number): Promise<void> {
    if (id === START_NODE) return
    if (await this.storage.getCapability(id)) return
    const nowIso = msToIso(nowMs)
    await this.storage.upsertCapability({ id, type: 'tool', description: '', firstSeen: nowIso, lastSeen: nowIso })
  }

  /** Like ensureCapability, but for the deposit path: a capability actually run through the loop is
   * 'observed'. A new stub is created as observed; an existing capability discovered earlier as
   * 'declared'/'mcp'/'skill' flips to 'observed' (observation wins, ADR-17). Pinning does NOT flip. */
  private async ensureObserved(id: string, nowMs: number): Promise<void> {
    if (id === START_NODE) return
    const nowIso = msToIso(nowMs)
    const existing = await this.storage.getCapability(id)
    if (!existing) {
      await this.storage.upsertCapability({ id, type: 'tool', description: '', source: 'observed', firstSeen: nowIso, lastSeen: nowIso })
      return
    }
    if (existing.source && existing.source !== 'observed') {
      await this.storage.upsertCapability({ ...existing, source: 'observed', lastSeen: nowIso })
    }
  }

  /** Decay an edge to now, then apply the pheromone delta and evidence counts. */
  private async bumpEdge(
    from: string,
    to: string,
    nowMs: number,
    dPheromone: number,
    dSuccess: number,
    dFailure: number,
  ): Promise<void> {
    const { tauMin, tauMax } = this.cfg.decay
    const nowIso = msToIso(nowMs)
    const existing = await this.storage.getEdge(from, to)
    const capTo = await this.storage.getCapability(to)
    const halfLife = halfLifeFor(capTo?.type ?? 'tool', this.cfg.decay)

    if (!existing) {
      await this.storage.upsertEdge({
        fromCapability: from,
        toCapability: to,
        pheromone: clip(tauMin + dPheromone, tauMin, tauMax),
        successCount: dSuccess,
        failureCount: dFailure,
        pinned: false,
        pinBehavior: null,
        pinOwner: null,
        lastUpdated: nowIso,
      })
      return
    }

    const lastMs = isoToMs(existing.lastUpdated)
    const decTau = decayedPheromone({
      pheromone: existing.pheromone,
      lastUpdated: lastMs,
      now: nowMs,
      halfLifeMs: halfLife,
      tauMin,
      pinned: existing.pinned,
    })
    const decSucc = decayedCount(existing.successCount, lastMs, nowMs, halfLife)
    const decFail = decayedCount(existing.failureCount, lastMs, nowMs, halfLife)
    // Pinned edges keep their pheromone (no decay, bypass the cap); evidence still accrues.
    const pheromone = existing.pinned ? existing.pheromone : clip(decTau + dPheromone, tauMin, tauMax)
    await this.storage.upsertEdge({
      ...existing,
      pheromone,
      successCount: decSucc + dSuccess,
      failureCount: decFail + dFailure,
      lastUpdated: nowIso,
    })
  }

}

export async function createEngine(deps: EngineDeps): Promise<StigmergyEngine> {
  const engine = new EngineImpl(deps)
  await engine.init()
  return engine
}
