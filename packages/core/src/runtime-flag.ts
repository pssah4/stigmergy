// TTL cache for a runtime flag read from the substrate (ADR-20, FEAT-04-06). The loop reads the
// enable flag on every beginTurn; without a cache that is one storage round-trip per turn. CachedFlag
// keeps the last read for ttlMs so the per-turn cost is a single compare on a hit, and a setRuntimeFlag
// invalidates it so a local write is seen immediately. A separate process flipping the flag is picked
// up within one TTL window (acceptable: activation is a human action, not the hot path). Pure, so it is
// unit-tested without an engine.
export class CachedFlag {
  private cached: { value: boolean; atMs: number } | undefined

  constructor(private readonly ttlMs: number) {}

  /** Return the cached value within the TTL, else call `read`, cache it, and return it. */
  async get(nowMs: number, read: () => Promise<boolean>): Promise<boolean> {
    if (this.cached && nowMs - this.cached.atMs < this.ttlMs) return this.cached.value
    const value = await read()
    this.cached = { value, atMs: nowMs }
    return value
  }

  /** Drop the cached value so the next get re-reads (call after a local write). */
  invalidate(): void {
    this.cached = undefined
  }
}
