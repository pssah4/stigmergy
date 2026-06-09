// BackgroundEmbedder (ADR-25, IMP-04-09-04): the only owner of the EmbeddingPort plus the optional
// augmenter. consult and registration never embed on the hot path; they read the in-memory index and
// enqueue work here, which drains off the hot path (a microtask by default, injectable for tests). A
// missing vector on consult heals to etaFloor (pheromone-only ranking), so guidance is eventually
// consistent: the query and new capability vectors land a tick later and strengthen subsequent turns.

import type { EmbeddingPort } from './ports.js'
import type { CapabilityAugmenter } from './api-types.js'

/** Upper bound for the query-vector LRU (mirrors the engine's prior QUERY_CACHE_MAX). */
const DEFAULT_QUERY_CACHE_MAX = 256

/** A capability vector plus the model it was computed under, so a model switch can invalidate it. */
export interface CapabilityVector {
  vector: Float32Array
  modelHash: string
}

/** The result handed to onCapabilityEmbedded so the engine can persist the vector (under its mutex). */
export interface EmbeddedCapability {
  id: string
  vector: Float32Array
  modelHash: string
  /** The text actually embedded: the augmented description when the augmenter produced one, else raw. */
  text: string
  augmented?: { description: string; model: string }
}

export interface BackgroundEmbedderDeps {
  embedding: EmbeddingPort
  /** Optional semantic augmentation (FEAT-01-07); runs in the background, never on the hot path. */
  augmenter?: CapabilityAugmenter
  /** Persist a freshly embedded capability (the engine takes its mutex inside this callback). */
  onCapabilityEmbedded?: (result: EmbeddedCapability) => Promise<void>
  /** Sink for a failed embed/persist so a single failure never poisons the queue or throws. */
  onError?: (err: unknown) => void
  /** Schedule a drain tick off the hot path. Default queueMicrotask; injectable for tests. */
  schedule?: (fn: () => void) => void
  maxQueryVectors?: number
}

interface CapJob {
  id: string
  description: string
  type: string
  /** When true (and an augmenter is present), augment the description before embedding (FEAT-01-07). */
  augment: boolean
}

export class BackgroundEmbedder {
  private readonly embedding: EmbeddingPort
  private readonly augmenter?: CapabilityAugmenter
  private readonly onCapabilityEmbedded?: (r: EmbeddedCapability) => Promise<void>
  private readonly onError: (err: unknown) => void
  private readonly schedule: (fn: () => void) => void
  private readonly maxQueryVectors: number

  // Queues dedupe by key (capability id / query text), so a burst of identical enqueues embeds once.
  private readonly capQueue = new Map<string, CapJob>()
  private readonly queryQueue = new Set<string>()
  private readonly capIndex = new Map<string, CapabilityVector>()
  private readonly queryIndex = new Map<string, Float32Array>()
  private readonly idleWaiters: Array<() => void> = []
  private draining = false
  private stopped = false

  constructor(deps: BackgroundEmbedderDeps) {
    this.embedding = deps.embedding
    this.augmenter = deps.augmenter
    this.onCapabilityEmbedded = deps.onCapabilityEmbedded
    this.onError = deps.onError ?? (() => {})
    this.schedule = deps.schedule ?? ((fn) => queueMicrotask(fn))
    this.maxQueryVectors = deps.maxQueryVectors ?? DEFAULT_QUERY_CACHE_MAX
  }

  /** Synchronous read for the consult hot path; undefined until the background drain has embedded it. */
  getCapabilityVector(id: string): CapabilityVector | undefined {
    return this.capIndex.get(id)
  }

  /** Synchronous read for the consult hot path; undefined until the background drain has embedded it. */
  getQueryVector(text: string): Float32Array | undefined {
    const hit = this.queryIndex.get(text)
    if (hit) {
      this.queryIndex.delete(text) // LRU refresh, not FIFO
      this.queryIndex.set(text, hit)
    }
    return hit
  }

  /** Seed the index from a persisted vector at engine init, so a warm start needs no re-embed. */
  primeCapabilityVector(id: string, vector: Float32Array, modelHash: string): void {
    this.capIndex.set(id, { vector, modelHash })
  }

  enqueueCapability(id: string, description: string, type: string, augment = true): void {
    if (this.stopped) return
    this.capQueue.set(id, { id, description, type, augment })
    this.scheduleDrain()
  }

  enqueueQuery(text: string): void {
    if (this.stopped) return
    if (this.queryIndex.has(text) || this.queryQueue.has(text)) return
    this.queryQueue.add(text)
    this.scheduleDrain()
  }

  /** Resolve once the queues are empty and no drain is in flight. Test/lifecycle hook. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** Stop draining and drop pending work. Idempotent; safe to call in the daemon's handle.stop. */
  async stop(): Promise<void> {
    this.stopped = true
    this.capQueue.clear()
    this.queryQueue.clear()
    this.flushIdle()
  }

  private isIdle(): boolean {
    return !this.draining && this.capQueue.size === 0 && this.queryQueue.size === 0
  }

  private flushIdle(): void {
    if (!this.isIdle()) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private scheduleDrain(): void {
    if (this.draining || this.stopped) return
    this.draining = true
    this.schedule(() => void this.drain())
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const cap = this.capQueue.entries().next()
        if (!cap.done) {
          const [id, job] = cap.value
          this.capQueue.delete(id)
          await this.embedCapability(job)
          continue
        }
        const q = this.queryQueue.values().next()
        if (!q.done) {
          const text = q.value
          this.queryQueue.delete(text)
          await this.embedQuery(text)
          continue
        }
        break
      }
    } finally {
      this.draining = false
      this.flushIdle()
    }
  }

  private async embedCapability(job: CapJob): Promise<void> {
    try {
      let text = job.description
      let augmented: { description: string; model: string } | undefined
      if (job.augment && this.augmenter) {
        const r = await this.augmenter.augment({ id: job.id, type: job.type, description: job.description })
        if (r) {
          text = r.description
          augmented = r
        }
      }
      const vector = await this.embedding.embed(text)
      const modelHash = this.embedding.modelHash()
      this.capIndex.set(job.id, { vector, modelHash })
      if (this.onCapabilityEmbedded) await this.onCapabilityEmbedded({ id: job.id, vector, modelHash, text, augmented })
    } catch (err) {
      this.onError(err)
    }
  }

  private async embedQuery(text: string): Promise<void> {
    try {
      const v = await this.embedding.embed(text)
      this.queryIndex.set(text, v)
      if (this.queryIndex.size > this.maxQueryVectors) {
        const oldest = this.queryIndex.keys().next().value
        if (oldest !== undefined) this.queryIndex.delete(oldest)
      }
    } catch (err) {
      this.onError(err)
    }
  }
}
