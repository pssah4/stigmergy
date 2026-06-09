// In-flight task buffers (ADR-05). A buffer is the "ant" while it forages: the
// ordered capability uses on the path before an outcome is recorded. The store
// is storage-agnostic; the engine persists only contextText to JSONL and
// recomputes embeddings on replay (PLAN-04 buffer-persistence resolution).

/** One capability touched during a task: loaded, possibly invoked, possibly returned. */
export interface CapabilityUse {
  capabilityId: string
  /** Transition source recorded at load time (trail tip when loaded). */
  prev: string
  invoked: boolean
  /** Monotonic per-buffer order stamped when invoked, so the trail follows invocation, not load. */
  invokeSeq?: number
  /** Set on capability_returned; undefined while still open. */
  returnedSuccess?: boolean
}

export type BufferStatus = 'open' | 'frozen'

export interface PendingBuffer {
  taskId: string
  contextText: string
  status: BufferStatus
  uses: CapabilityUse[]
  /** Monotonic counter for stamping CapabilityUse.invokeSeq. */
  invokeCounter: number
  /** True once any task_iterated arrived: a later accept resolves as 'iterated'. */
  wasIterated: boolean
  /** Guards exactly-once resolution while onResolve is in flight (deposit can be slow/fail). */
  resolving?: boolean
  /** Wall-clock ms of the last response_delivered (freeze); used for topic-shift ordering. */
  deliveredAtMs?: number
  /** Scheduler handle for the auto-accept timeout, so it can be cancelled. */
  timeoutHandle?: unknown
}

/** Persistence payload: contextText only, embeddings recomputed on replay. */
export interface PendingSnapshot {
  taskId: string
  contextText: string
}

export interface PendingStore {
  open(taskId: string, contextText: string): PendingBuffer
  get(taskId: string): PendingBuffer | undefined
  all(): PendingBuffer[]
  /** Map a new task id onto an existing buffer (topic-shift iteration alias). */
  alias(aliasTaskId: string, canonicalTaskId: string): void
  /** Follow alias chains to the canonical id. */
  canonicalId(taskId: string): string
  delete(taskId: string): void
  snapshot(): PendingSnapshot[]
  restore(snaps: PendingSnapshot[]): void
}

export class MemoryPendingStore implements PendingStore {
  private buffers = new Map<string, PendingBuffer>()
  private aliases = new Map<string, string>()

  open(taskId: string, contextText: string): PendingBuffer {
    const buf: PendingBuffer = { taskId, contextText, status: 'open', uses: [], invokeCounter: 0, wasIterated: false }
    this.buffers.set(taskId, buf)
    return buf
  }

  canonicalId(taskId: string): string {
    let id = taskId
    const seen = new Set<string>()
    while (this.aliases.has(id) && !seen.has(id)) {
      seen.add(id)
      id = this.aliases.get(id)!
    }
    return id
  }

  get(taskId: string): PendingBuffer | undefined {
    return this.buffers.get(this.canonicalId(taskId))
  }

  all(): PendingBuffer[] {
    return [...this.buffers.values()]
  }

  alias(aliasTaskId: string, canonicalTaskId: string): void {
    this.aliases.set(aliasTaskId, this.canonicalId(canonicalTaskId))
  }

  delete(taskId: string): void {
    const id = this.canonicalId(taskId)
    this.buffers.delete(id)
    for (const [alias, canonical] of [...this.aliases.entries()]) {
      if (canonical === id || alias === id) this.aliases.delete(alias)
    }
  }

  snapshot(): PendingSnapshot[] {
    return this.all().map((b) => ({ taskId: b.taskId, contextText: b.contextText }))
  }

  restore(snaps: PendingSnapshot[]): void {
    for (const s of snaps) this.open(s.taskId, s.contextText)
  }
}
