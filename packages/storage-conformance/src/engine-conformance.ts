// Shared StigmergyEngine conformance suite (FEAT-01-04 SC-08). Every storage
// adapter runs it with its own factory so the embedded engine behaves
// identically on better-sqlite3 and sql.js. The engine is wired with the
// deterministic FakeEmbedding plus a VirtualScheduler so timeouts and selection
// are reproducible (ADR-05, ADR-12).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createEngine,
  FakeEmbedding,
  FakeAugmenter,
  FixedClock,
  VirtualScheduler,
  DEFAULT_SCORE_CONFIG,
  START_NODE,
} from '@agentic-stigmergy/core'
import type { StoragePort, StigmergyEngine, Capability } from '@agentic-stigmergy/core'

const T0 = 1_700_000_000_000
const ISO = new Date(T0).toISOString()

/** A second embedding model: same dimension as FakeEmbedding but a different identity and a different
 * vector (negated), so reusing a FakeEmbedding-stamped vector cross-space would flip cosine to ~-1
 * while a correct re-embed yields ~1. Used to prove the modelHash stamp guard (FEAT-04-07). */
class ShiftedEmbedding {
  private readonly fake = new FakeEmbedding()
  async embed(text: string): Promise<Float32Array> {
    const v = await this.fake.embed(text)
    return v.map((x) => -x) as Float32Array
  }
  dimension(): number {
    return this.fake.dimension()
  }
  modelHash(): string {
    return 'fake-shifted'
  }
}

export function defineEngineConformance(name: string, makeStorage: () => Promise<StoragePort>): void {
  describe(`StigmergyEngine conformance: ${name}`, () => {
    let engine: StigmergyEngine
    let storage: StoragePort
    let clock: FixedClock
    let scheduler: VirtualScheduler

    beforeEach(async () => {
      storage = await makeStorage()
      clock = new FixedClock(T0)
      scheduler = new VirtualScheduler(clock)
      engine = await createEngine({
        storage,
        embedding: new FakeEmbedding(),
        clock,
        scheduler,
        // q0 = 1 forces exploit, so ranking order is deterministic for assertions.
        config: { score: { ...DEFAULT_SCORE_CONFIG, q0: 1 }, tracker: { timeoutMs: 1000, topicShiftThreshold: 0.6 } },
      })
    })

    afterEach(async () => {
      await engine.close()
    })

    async function advance(ms: number): Promise<void> {
      clock.advance(ms)
      await scheduler.runDue(clock.now())
    }

    async function forageAccept(taskId: string, context: string, capId: string, tokenCost: number): Promise<void> {
      await engine.emit({ type: 'task_started', taskId, context })
      await engine.emit({ type: 'capability_loaded', taskId, capabilityId: capId })
      await engine.emit({ type: 'capability_invoked', taskId, capabilityId: capId })
      await engine.emit({ type: 'capability_returned', taskId, capabilityId: capId, success: true })
      await engine.emit({ type: 'response_delivered', taskId })
      await engine.emit({ type: 'task_accepted', taskId, tokenCost })
    }

    // ADR-25: embedding runs in the background, so similarity/gating/augmentation are eventually
    // consistent. consultWarm enqueues the query (and any cold capability) on the first consult, drains
    // the embedder, then consults again so the vectors are warm for a deterministic assertion.
    async function consultWarm(
      input: Parameters<StigmergyEngine['consult']>[0],
    ): Promise<Awaited<ReturnType<StigmergyEngine['consult']>>> {
      await engine.consult(input)
      await engine.whenEmbeddingsIdle?.()
      return engine.consult(input)
    }

    it('returns an empty ranked decision when the registry is empty (SC-03)', async () => {
      const d = await engine.consult({ task_id: 't', context: 'anything' })
      expect(d).toEqual({ mode: 'ranked', ranked: [] })
    })

    it('ranks registered capabilities by similarity to the context', async () => {
      await engine.registerCapability({ id: 'tool:cats', type: 'tool', description: 'cat feeding schedule' })
      await engine.registerCapability({ id: 'tool:taxes', type: 'tool', description: 'quarterly tax filing' })
      const d = await consultWarm({ task_id: 't', context: 'cat feeding schedule', top_k: 2 })
      expect(d.mode).toBe('ranked')
      if (d.mode !== 'ranked') return
      expect(d.ranked).toHaveLength(2)
      const cats = d.ranked.find((r) => r.capabilityId === 'tool:cats')!
      const taxes = d.ranked.find((r) => r.capabilityId === 'tool:taxes')!
      expect(cats.components.similarity).toBeGreaterThan(taxes.components.similarity)
      expect(d.ranked[0]!.capabilityId).toBe('tool:cats')
    })

    it('reinforces an accepted path so its pheromone rises above the floor', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await forageAccept('t1', 'alpha', 'tool:a', 500)
      const stats = await engine.stats()
      expect(stats.edges).toBe(1)
      expect(stats.tasks).toBe(1)
      expect(stats.avgPheromone).toBeGreaterThan(0.05)
    })

    it('deposits an accepted task exactly once even if the timeout also fires (SC-04)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await forageAccept('t1', 'alpha', 'tool:a', 500)
      const before = await engine.stats()
      await advance(1000) // timeout becomes due, but the buffer is already resolved
      const after = await engine.stats()
      expect(after).toEqual(before)
      expect(after.tasks).toBe(1)
    })

    it('auto-accepts a delivered task after the idle timeout', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.emit({ type: 'task_started', taskId: 't1', context: 'alpha' })
      await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: 'tool:a', success: true })
      await engine.emit({ type: 'response_delivered', taskId: 't1' })
      expect((await engine.stats()).tasks).toBe(0)
      await advance(1000)
      expect((await engine.stats()).tasks).toBe(1)
    })

    it('assigns unique pin ids and drives a sequence decision (SC-05)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      const p1 = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'sequence' })
      const p2 = await engine.pinPath({ capability_sequence: ['tool:a'], behavior: 'enforce' })
      expect(p1.id).not.toBe(p2.id)
      const d = await engine.consult({ task_id: 't', context: 'alpha beta', history: [] })
      expect(d.mode).toBe('sequence')
      if (d.mode === 'sequence') {
        expect(d.nextCapability).toBe('tool:a')
        expect(d.remainingPath).toEqual(['tool:b'])
      }
    })

    it('re-embeds a capability stored under a different model, never comparing across spaces (EPIC-04 FEAT-04-07)', async () => {
      // Engine A stamps the capability with FakeEmbedding ('fake-v1'); engine B uses a different model
      // ('fake-shifted', same dimension) on the SAME storage. A consult on B for the capability's own
      // text must re-embed (stamp mismatch) -> self-similarity ~1, not the cross-space cosine (~ -1)
      // it would get by reusing the stale vector. This proves the modelHash guard (consult.ts/engine).
      const shared = await makeStorage()
      const a = await createEngine({ storage: shared, embedding: new FakeEmbedding(), clock, scheduler })
      await a.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha context word' })
      await a.whenEmbeddingsIdle?.() // persist the fake-v1 vector so the cross-space guard has a stale stamp to reject
      const b = await createEngine({
        storage: shared,
        embedding: new ShiftedEmbedding(),
        clock: new FixedClock(T0),
        scheduler: new VirtualScheduler(new FixedClock(T0)),
        config: { score: { ...DEFAULT_SCORE_CONFIG, q0: 1 } },
      })
      // Warm under B: the first consult enqueues a re-embed (stamp mismatch) plus the query under B's
      // model; after the drain the second consult cosines both in B's space (~1), never reusing fake-v1.
      await b.consult({ task_id: 'warm', context: 'alpha context word', candidate_ids: ['tool:a'] })
      await b.whenEmbeddingsIdle?.()
      const d = await b.consult({ task_id: 't', context: 'alpha context word', candidate_ids: ['tool:a'] })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') {
        // re-embedded with B -> query and capability are both in B's space -> self-similar (~1).
        // A reuse of the fake-v1 vector against B's negated query would be ~ -1.
        expect(d.ranked[0]!.components.similarity).toBeGreaterThan(0.9)
      }
      await a.close() // closes the shared storage (b wraps the same handle)
    })

    it('is disabled by default and isEnabled flips after setRuntimeFlag (EPIC-04 FEAT-04-06)', async () => {
      expect(await engine.isEnabled()).toBe(false) // default-disabled: no runtime_config row
      expect(await engine.getRuntimeFlag('enabled')).toBeNull()
      await engine.setRuntimeFlag('enabled', '1')
      expect(await engine.getRuntimeFlag('enabled')).toBe('1')
      expect(await engine.isEnabled()).toBe(true) // cache invalidated by the local write
      await engine.setRuntimeFlag('enabled', '0')
      expect(await engine.isEnabled()).toBe(false)
    })

    it('caps the scored candidate set to maxCandidates by similarity (EPIC-04 FEAT-04-02 SC-08)', async () => {
      // A tiny maxCandidates makes the prefilter observable: a large discovered catalog cannot flood
      // consult; only the most similar capabilities are scored. With no candidate_ids and the full
      // registry above the cap, the off-topic capability is dropped before scoring.
      const s2 = await makeStorage()
      const e = await createEngine({
        storage: s2,
        embedding: new FakeEmbedding(),
        config: { maxCandidates: 2, score: { ...DEFAULT_SCORE_CONFIG, q0: 1 } },
      })
      await e.registerCapability({ id: 'tool:cat', type: 'tool', description: 'cat feeding schedule' })
      await e.registerCapability({ id: 'tool:cat2', type: 'tool', description: 'cat grooming routine' })
      await e.registerCapability({ id: 'tool:tax', type: 'tool', description: 'quarterly tax filing report' })
      // Warm so the prefilter sees similarity (cold, it would slice by id); then the off-topic tax tool drops.
      await e.consult({ task_id: 'warm', context: 'cat feeding grooming' })
      await e.whenEmbeddingsIdle?.()
      const d = await e.consult({ task_id: 't', context: 'cat feeding grooming' })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') {
        expect(d.ranked).toHaveLength(2) // capped at maxCandidates, not all three
        expect(d.ranked.map((r) => r.capabilityId)).not.toContain('tool:tax')
      }
      await e.close()
    })

    it('registers a capability with a discovery source and flips it to observed on deposit (EPIC-04 FEAT-04-02 SC-01/SC-07)', async () => {
      await engine.registerCapability({ id: 'mcp:srv:tool', type: 'mcp', description: 'a discovered tool', source: 'mcp' })
      expect((await engine.listCapabilities()).find((c) => c.id === 'mcp:srv:tool')?.source).toBe('mcp')
      // Observation wins: running it through an accepted task flips the source to 'observed'.
      await engine.deposit({ task_id: 'd1', context: 'x', path: ['mcp:srv:tool'], outcome: 'accepted', token_cost: 100 })
      expect((await engine.listCapabilities()).find((c) => c.id === 'mcp:srv:tool')?.source).toBe('observed')
    })

    it('defaults a plainly-registered capability to source observed (EPIC-04 FEAT-04-02)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      expect((await engine.listCapabilities()).find((c) => c.id === 'tool:a')?.source).toBe('observed')
    })

    it('pins a path over a not-yet-registered capability by ensuring it (EPIC-04 FEAT-04-02 SC-05)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      // tool:fresh was never registered; pinning a sequence through it must not violate the edge FK.
      const pin = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:fresh'], behavior: 'sequence' })
      expect(pin.id).toBeTruthy()
      expect((await engine.listCapabilities()).map((c) => c.id)).toContain('tool:fresh')
      // the pinned edge fired: with history at tool:a, the sequence pin surfaces tool:fresh next.
      const d = await engine.consult({ task_id: 't', context: 'alpha', history: ['tool:a'] })
      expect(d.mode).toBe('sequence')
      if (d.mode === 'sequence') expect(d.nextCapability).toBe('tool:fresh')
    })

    it('gates a sequence pin on its whenToUse, firing only when the context is on-topic (EPIC-04 FEAT-04-03)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      // a sequence pin whose whenToUse is about cats: it should fire for a cat task, not a tax task.
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'sequence', when_to_use: 'cat feeding and grooming' })

      // Warm: the whenToUse and the query are embedded in the background (ADR-25); until then the gate
      // opens unconditionally, after the drain it discriminates on the query vector.
      const onTopic = await consultWarm({ task_id: 't1', context: 'cat feeding and grooming', history: [] })
      expect(onTopic.mode).toBe('sequence') // gate open -> the pin fires

      const offTopic = await consultWarm({ task_id: 't2', context: 'quarterly tax filing report', history: [] })
      expect(offTopic.mode).toBe('ranked') // gate closed -> normal foraging, the pin does not fire
    })

    it('fires a sequence pin unconditionally when it has no whenToUse (byte-identical to before, FEAT-04-03)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'sequence' }) // no whenToUse
      const d = await engine.consult({ task_id: 't', context: 'anything at all', history: [] })
      expect(d.mode).toBe('sequence') // empty whenToUse -> always fires
    })

    it('throws on reset without destroy and wipes the substrate with destroy (SC-06)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.pinPath({ capability_sequence: ['tool:a'], behavior: 'preferred' })
      await forageAccept('t1', 'alpha', 'tool:a', 500)
      await expect(engine.reset({ destroy: false })).rejects.toThrow(/destroy/)

      await engine.reset({ destroy: true })
      const stats = await engine.stats()
      expect(stats.edges).toBe(0)
      expect(stats.tasks).toBe(0)
      expect(stats.pinnedPaths).toBe(0)
      expect(stats.capabilities).toBe(1) // the registry is kept
    })

    it('deposits a transition once even if the path revisits it (no within-task double-count)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      // cyclic trail a -> b -> a -> b inside one accepted task
      await engine.emit({ type: 'task_started', taskId: 't1', context: 'alpha beta' })
      for (const capId of ['tool:a', 'tool:b', 'tool:a', 'tool:b']) {
        await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: capId })
        await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: capId })
        await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: capId, success: true })
      }
      await engine.emit({ type: 'response_delivered', taskId: 't1' })
      // token_cost 2000 -> efficiency 0.5 -> delta 0.15; single bump 0.20, double bump 0.35
      await engine.emit({ type: 'task_accepted', taskId: 't1', tokenCost: 2000 })

      const d = await engine.consult({ task_id: 't2', context: 'beta', history: ['tool:a'], candidate_ids: ['tool:b'] })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') {
        expect(d.ranked[0]!.components.pheromone).toBeCloseTo(0.2, 5)
      }
    })

    it('returns an enforce decision when an enforce pin restricts the candidates', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.pinPath({ capability_sequence: ['tool:b'], behavior: 'enforce' })
      const d = await engine.consult({ task_id: 't', context: 'alpha beta', history: [] })
      expect(d.mode).toBe('enforce')
      if (d.mode === 'enforce') {
        expect(d.forceFromSet).toBe(true)
        expect(d.ranked.map((r) => r.capabilityId)).toEqual(['tool:b'])
      }
    })

    it('deposits an iterated task with a smaller reward than an accepted one', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await forageAccept('acc', 'alpha', 'tool:a', 1000)
      const accD = await engine.consult({ task_id: 'qa', context: 'alpha', candidate_ids: ['tool:a'] })
      const accPheromone = accD.mode === 'ranked' ? accD.ranked[0]!.components.pheromone : 0

      await engine.reset({ destroy: true }) // wipe edges, keep the registry
      await engine.emit({ type: 'task_started', taskId: 'it', context: 'alpha' })
      await engine.emit({ type: 'capability_loaded', taskId: 'it', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_invoked', taskId: 'it', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_returned', taskId: 'it', capabilityId: 'tool:a', success: true })
      await engine.emit({ type: 'response_delivered', taskId: 'it' })
      await engine.emit({ type: 'task_iterated', taskId: 'it' })
      await engine.emit({ type: 'response_delivered', taskId: 'it' })
      await engine.emit({ type: 'task_accepted', taskId: 'it', tokenCost: 1000 })
      const itD = await engine.consult({ task_id: 'qi', context: 'alpha', candidate_ids: ['tool:a'] })
      const itPheromone = itD.mode === 'ranked' ? itD.ranked[0]!.components.pheromone : 0

      expect(itPheromone).toBeLessThan(accPheromone)
    })

    it('deposits an abandoned task without raising pheromone above the floor', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.emit({ type: 'task_started', taskId: 't1', context: 'alpha' })
      await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: 'tool:a', success: true })
      await engine.emit({ type: 'response_delivered', taskId: 't1' })
      await engine.emit({ type: 'task_abandoned', taskId: 't1' })

      expect((await engine.stats()).tasks).toBe(1)
      const d = await engine.consult({ task_id: 'q', context: 'alpha', candidate_ids: ['tool:a'] })
      if (d.mode === 'ranked') expect(d.ranked[0]!.components.pheromone).toBeCloseTo(0.05, 5)
    })

    it('resolves the previous buffer as accepted on a topic change in one tick', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'cat feeding schedule' })
      await engine.emit({ type: 'task_started', taskId: 't1', context: 'cat feeding schedule' })
      await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: 'tool:a', success: true })
      await engine.emit({ type: 'response_delivered', taskId: 't1' })
      expect((await engine.stats()).tasks).toBe(0)
      // disjoint context -> topic change resolves t1 as accepted immediately
      await engine.emit({ type: 'task_started', taskId: 't2', context: 'quarterly tax filing report' })
      expect((await engine.stats()).tasks).toBe(1)
    })

    it('raises failure evidence for a loaded-but-discarded capability (FEAT-01-03 SC-07)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.emit({ type: 'task_started', taskId: 't1', context: 'alpha' })
      await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: 'tool:b' }) // never invoked -> discarded
      await engine.emit({ type: 'capability_loaded', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:a' })
      await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: 'tool:a', success: true })
      await engine.emit({ type: 'response_delivered', taskId: 't1' })
      await engine.emit({ type: 'task_accepted', taskId: 't1', tokenCost: 500 })

      expect((await engine.stats()).edges).toBe(2) // START->tool:a (success) and START->tool:b (discard)
      const d = await engine.consult({ task_id: 'q', context: 'beta', candidate_ids: ['tool:b'] })
      if (d.mode === 'ranked') expect(d.ranked[0]!.components.pheromone).toBeCloseTo(0.05, 5) // discard did not reinforce
    })

    it('deposits a known path directly via the public deposit API, idempotently', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.deposit({ task_id: 'd1', context: 'alpha', path: ['tool:a'], outcome: 'accepted', token_cost: 1000 })
      const stats = await engine.stats()
      expect(stats.tasks).toBe(1)
      expect(stats.edges).toBe(1)
      await engine.deposit({ task_id: 'd1', context: 'alpha', path: ['tool:a'], outcome: 'accepted', token_cost: 1000 })
      expect((await engine.stats()).tasks).toBe(1) // idempotent per task_id
    })

    it('lists, gets and deletes pinned paths, unpinning their edges', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      const p = await engine.pinPath({ capability_sequence: ['tool:a'], behavior: 'preferred' })
      expect((await engine.listPaths()).map((x) => x.id)).toContain(p.id)
      expect((await engine.getPath(p.id))?.behavior).toBe('preferred')
      await engine.deletePath(p.id)
      expect(await engine.getPath(p.id)).toBeNull()
      expect((await engine.stats()).pinnedPaths).toBe(0)
    })

    it('purges a hand-pinned path\'s own phantom edges on delete, but keeps edges with real run history (FEAT-06-06)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.registerCapability({ id: 'tool:c', type: 'tool', description: 'gamma' })
      // a real run lays pheromone WITH success history on START->a->b
      await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
      expect((await engine.stats()).edges).toBe(2) // START->a, a->b
      // a hand pin adds a phantom edge a->c (pin-only, never run); START->a already has history
      const p = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:c'], behavior: 'preferred' })
      expect((await engine.stats()).edges).toBe(3) // + a->c
      await engine.deletePath(p.id)
      // a->c (successCount 0, no covering pin) is removed; START->a and a->b survive because they ran
      expect((await engine.stats()).edges).toBe(2)
      expect(await engine.getPath(p.id)).toBeNull()
    })

    it('deletes a single learned edge by its (from, to) pair (FIX-06-06-01)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.deposit({ task_id: 'r1', context: 'x', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 100 })
      expect((await engine.stats()).edges).toBe(2) // START->a, a->b
      await engine.deleteEdge('tool:a', 'tool:b')
      expect((await engine.stats()).edges).toBe(1) // only START->a remains
    })

    it('refuses to delete an edge a pinned path covers (unpin the path instead) (FIX-06-06-01)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'enforce' })
      await expect(engine.deleteEdge('tool:a', 'tool:b')).rejects.toThrow(/pinned path/)
      expect((await engine.stats()).edges).toBe(2) // START->a and a->b both survive
    })

    it('is a no-op when deleting a missing edge (FIX-06-06-01)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.deleteEdge('tool:a', 'tool:nope') // never created
      expect((await engine.stats()).edges).toBe(0)
    })

    it('auto-registers an unseen capability when an outcome references it', async () => {
      // tool:new is never registered; depositing an outcome over it must not violate the FK
      await engine.deposit({ task_id: 'd1', context: 'x', path: ['tool:new'], outcome: 'accepted', token_cost: 1000 })
      const stats = await engine.stats()
      expect(stats.tasks).toBe(1)
      expect(stats.edges).toBe(1)
      expect((await engine.listCapabilities()).map((c) => c.id)).toContain('tool:new')
    })

    it('keeps a shared edge pinned when another pinned path still covers it', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      const p1 = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'enforce' })
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'enforce' })
      await engine.deletePath(p1.id)
      // edge tool:a -> tool:b is still covered by the second pin, so enforce must still fire
      const d = await engine.consult({ task_id: 't', context: 'beta', history: ['tool:a'] })
      expect(d.mode).toBe('enforce')
    })

    it('derives a shared edge pin from the set of active pins, not call order', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      // same edge pinned preferred then enforce: the stronger behavior (enforce) wins
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'preferred' })
      const pEnf = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'enforce' })
      expect((await engine.consult({ task_id: 't1', context: 'beta', history: ['tool:a'] })).mode).toBe('enforce')
      // remove the enforce pin: only the preferred pin remains, so enforce must no longer fire
      await engine.deletePath(pEnf.id)
      const d = await engine.consult({ task_id: 't2', context: 'beta', history: ['tool:a'] })
      expect(d.mode).toBe('ranked')
    })

    it('does not crash on a stored embedding whose dimension differs from the current model', async () => {
      // simulate a capability persisted by an earlier run with a different embedding model
      const stale: Capability = {
        id: 'tool:stale',
        type: 'tool',
        description: 'stale',
        descriptionEmbedding: new Float32Array([0.1, 0.2, 0.3]), // 3-dim, FakeEmbedding is 64-dim
        firstSeen: ISO,
        lastSeen: ISO,
      }
      await storage.upsertCapability(stale)
      const d = await engine.consult({ task_id: 't', context: 'stale', candidate_ids: ['tool:stale'] })
      expect(d.mode).toBe('ranked')
      if (d.mode === 'ranked') expect(d.ranked).toHaveLength(1)
    })

    it('rejects reserved capability ids and the system type (AUDIT F-03)', async () => {
      await expect(engine.registerCapability({ id: '__START__', type: 'tool', description: 'x' })).rejects.toThrow()
      await expect(
        engine.registerCapability({ id: 'tool:x', type: '__system__' as unknown as 'tool', description: 'x' }),
      ).rejects.toThrow()
    })

    it('rejects a non-finite token_cost on deposit (AUDIT F-03)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a' })
      await expect(
        engine.deposit({ task_id: 'd', context: 'a', path: ['tool:a'], outcome: 'accepted', token_cost: NaN }),
      ).rejects.toThrow()
    })

    it('rejects an oversize path on deposit (AUDIT F-03)', async () => {
      const huge = Array.from({ length: 2000 }, (_, i) => `tool:${i}`)
      await expect(
        engine.deposit({ task_id: 'd', context: 'x', path: huge, outcome: 'accepted', token_cost: 1 }),
      ).rejects.toThrow()
    })

    it('rejects a non-finite top_k on consult (AUDIT F-03)', async () => {
      await expect(engine.consult({ task_id: 't', context: 'x', top_k: Number.NaN })).rejects.toThrow()
    })

    it('rejects an event whose capabilityId is the reserved sentinel (AUDIT F-11)', async () => {
      await expect(
        engine.emit({ type: 'capability_loaded', taskId: 't', capabilityId: START_NODE }),
      ).rejects.toThrow()
    })

    it('is deterministic for a fresh engine with the same seed (FEAT-01-02)', async () => {
      const run = async () => {
        const storage = await makeStorage()
        const e = await createEngine({
          storage,
          embedding: new FakeEmbedding(),
          clock: new FixedClock(T0),
          scheduler: new VirtualScheduler(new FixedClock(T0)),
          config: { seed: 42 },
        })
        await e.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha report' })
        await e.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta summary' })
        const d = await e.consult({ task_id: 't', context: 'alpha beta report summary', top_k: 2 })
        await e.close()
        return d
      }
      expect(await run()).toEqual(await run())
    })

    it('reinforcePath raises and weakenPath lowers pheromone along the path (FEAT-01-06)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      const probe = async (task: string): Promise<number> => {
        const d = await engine.consult({ task_id: task, context: 'alpha', candidate_ids: ['tool:a'] })
        return d.mode === 'ranked' && d.ranked[0] ? d.ranked[0].components.pheromone : 0
      }
      expect(await probe('q0')).toBeCloseTo(0.05, 5) // cold edge sits at tauMin

      await engine.reinforcePath({ path: ['tool:a'], strength: 0.4 })
      const up = await probe('q1')
      expect(up).toBeGreaterThan(0.05) // 0.05 + 0.4 = 0.45

      await engine.weakenPath({ path: ['tool:a'], strength: 0.3 })
      expect(await probe('q2')).toBeLessThan(up) // 0.45 - 0.3 = 0.15
    })

    it('clips manual reinforcement to tauMax and rejects bad input (FEAT-01-06)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.reinforcePath({ path: ['tool:a'], strength: 5 }) // overshoots -> clip to tauMax 1.0
      const d = await engine.consult({ task_id: 'q', context: 'alpha', candidate_ids: ['tool:a'] })
      if (d.mode === 'ranked') expect(d.ranked[0]!.components.pheromone).toBeCloseTo(1, 5)
      await expect(engine.reinforcePath({ path: [], strength: 0.1 })).rejects.toThrow()
      await expect(engine.reinforcePath({ path: ['tool:a'], strength: Number.NaN })).rejects.toThrow()
      await expect(engine.reinforcePath({ path: [START_NODE], strength: 0.1 })).rejects.toThrow()
    })

    it('backup and restore round-trip the substrate (FEAT-01-06, SC-07)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await forageAccept('t1', 'alpha', 'tool:a', 500)
      await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'enforce' })
      const before = await engine.stats()
      const dump = await engine.backup()
      expect(dump.version).toBe(1)
      expect(dump.capabilities.some((c) => c.id === START_NODE)).toBe(false) // sentinel excluded

      await engine.reset({ destroy: true })
      expect((await engine.stats()).edges).toBe(0)

      await engine.restore(dump)
      const after = await engine.stats()
      expect(after.edges).toBe(before.edges)
      expect(after.tasks).toBe(before.tasks)
      expect(after.pinnedPaths).toBe(before.pinnedPaths)
      // the enforce pin is restored, so an enforce decision still fires
      const d = await engine.consult({ task_id: 'q', context: 'beta', history: ['tool:a'] })
      expect(d.mode).toBe('enforce')
    })

    it('exportPath and importPath round-trip a pinned path with its edges (FEAT-01-04 SC-07)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
      await forageAccept('t1', 'alpha beta', 'tool:a', 500)
      const pin = await engine.pinPath({ capability_sequence: ['tool:a', 'tool:b'], behavior: 'sequence', name: 'flow' })
      const exported = await engine.exportPath(pin.id)
      expect(exported).not.toBeNull()
      expect(exported!.version).toBe(1)
      expect(exported!.pinnedPath.capabilitySequence).toEqual(['tool:a', 'tool:b'])
      expect(exported!.edges.length).toBeGreaterThan(0)

      await engine.reset({ destroy: true })
      expect(await engine.getPath(pin.id)).toBeNull()

      const imported = await engine.importPath(exported!)
      expect(imported.id).toBe(pin.id)
      expect((await engine.getPath(pin.id))?.name).toBe('flow')
      const d = await engine.consult({ task_id: 'q', context: 'alpha beta', history: [] })
      expect(d.mode).toBe('sequence')
    })

    it('importPath into a live substrate preserves a discovered capability source (ADR-17, review wxfcn1jf7)', async () => {
      // A discovered MCP capability is never run, so its source stays 'mcp'. Importing a path that names
      // the same id must NOT flip it to 'observed' (only real observation does that) nor wipe it to NULL.
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.registerCapability({ id: 'mcp:srv:tool', type: 'mcp', description: 'remote tool', source: 'mcp' })
      const pin = await engine.pinPath({ capability_sequence: ['tool:a', 'mcp:srv:tool'], behavior: 'sequence', name: 'flow' })
      const exported = await engine.exportPath(pin.id)
      expect(exported).not.toBeNull()

      // Import WITHOUT clearing first (the live-merge path). The capability already exists as 'mcp'.
      await engine.importPath(exported!)
      const caps = await engine.listCapabilities()
      expect(caps.find((c) => c.id === 'mcp:srv:tool')?.source).toBe('mcp') // provenance preserved, not flipped
    })

    it('registerCapability stamps the embedding model and it survives the adapter round-trip (FEAT-04-07)', async () => {
      // Guards against an adapter INSERT/UPDATE silently dropping embedding_model (every vector would
      // then read as unknown-space and consult would re-embed the whole inventory on every call).
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await engine.whenEmbeddingsIdle?.() // the stamp lands when the background embed persists (ADR-25)
      const caps = await engine.listCapabilities()
      expect(caps.find((c) => c.id === 'tool:a')?.embeddingModel).toBe('fake-v1')
    })

    it('exportPath returns null for an unknown id and restore rejects a bad version', async () => {
      expect(await engine.exportPath('nope')).toBeNull()
      await expect(engine.restore({ version: 2 as 1, capabilities: [], edges: [], tasks: [], pinnedPaths: [] })).rejects.toThrow()
    })

    it('restore rejects a version-1 backup with missing array fields (FEAT-01-06)', async () => {
      // A truncated or hand-edited backup must fail with a clean ValidationError, not a raw TypeError.
      await expect(engine.restore({ version: 1 } as unknown as Awaited<ReturnType<StigmergyEngine['backup']>>)).rejects.toThrow(
        /missing/,
      )
    })

    it('restore and importPath reject records that violate substrate invariants (FEAT-01-06 L-1)', async () => {
      type Backup = Awaited<ReturnType<StigmergyEngine['backup']>>
      const base = { version: 1 as const, capabilities: [], edges: [], tasks: [], pinnedPaths: [] }
      // A hand-crafted backup must not re-inject the reserved sentinel id or the reserved type.
      await expect(
        engine.restore({ ...base, capabilities: [{ id: '__START__', type: 'tool', description: 'x' }] } as Backup),
      ).rejects.toThrow(/reserved/)
      await expect(
        engine.restore({ ...base, capabilities: [{ id: 'tool:x', type: '__system__', description: 'x' }] } as unknown as Backup),
      ).rejects.toThrow(/reserved/)
      // A non-finite pheromone must be rejected (the normal deposit path clips, this bypasses it).
      await expect(
        engine.restore({
          ...base,
          edges: [{ fromCapability: 'tool:a', toCapability: 'tool:b', pheromone: Number.POSITIVE_INFINITY }],
        } as unknown as Backup),
      ).rejects.toThrow(/finite/)
      // importPath enforces the same capability invariant.
      await expect(
        engine.importPath({
          version: 1,
          pinnedPath: { id: 'p', capabilitySequence: ['tool:x'], behavior: 'preferred', createdAt: '2026-01-01T00:00:00.000Z' },
          capabilities: [{ id: '__START__', type: 'tool', description: 'x' }],
          edges: [],
        } as unknown as Awaited<ReturnType<StigmergyEngine['exportPath']>> & object),
      ).rejects.toThrow(/reserved/)
    })

    it('restore clamps an out-of-range edge pheromone into [tauMin, tauMax] (FEAT-01-06 review #4)', async () => {
      await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await forageAccept('t1', 'alpha', 'tool:a', 500)
      const dump = await engine.backup()
      // A hand-edited backup with an out-of-range pheromone must be clamped on load, not stored verbatim.
      const crafted = { ...dump, edges: dump.edges.map((e) => ({ ...e, pheromone: 1e6 })) }
      await engine.restore(crafted)
      const after = await engine.backup()
      expect(after.edges.length).toBeGreaterThan(0)
      expect(after.edges.every((e) => e.pheromone <= 1.0)).toBe(true)
    })

    it('reinforcePath rejects an unknown capability instead of creating a stub (FEAT-01-06 review #10)', async () => {
      await expect(engine.reinforcePath({ path: ['ghost:x', 'ghost:y'], strength: 0.5 })).rejects.toThrow(/unknown/)
      const caps = await engine.listCapabilities()
      expect(caps.some((c) => c.id === 'ghost:x' || c.id === 'ghost:y')).toBe(false)
    })

    it('augments a description at registration and embeds the augmented text, once per capability (FEAT-01-07 SC-01)', async () => {
      const storage = await makeStorage()
      const aug = new FakeAugmenter({ model: 'fake-haiku' })
      const e = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter: aug })
      // Augmentation + embedding run in the background (ADR-25): register, drain, then read the row back.
      await e.registerCapability({ id: 'tool:x', type: 'tool', description: 'read a file' })
      await e.whenEmbeddingsIdle?.()
      const cap = (await e.listCapabilities()).find((c) => c.id === 'tool:x')!
      expect(cap.descriptionAugmented).toBe('aug(read a file)')
      expect(cap.augmentedBy).toBe('fake-haiku')
      expect(cap.augmentedAt).toBeTruthy()
      const augEmb = await new FakeEmbedding().embed('aug(read a file)')
      const rawEmb = await new FakeEmbedding().embed('read a file')
      expect(Array.from(cap.descriptionEmbedding ?? [])).toEqual(Array.from(augEmb))
      expect(Array.from(cap.descriptionEmbedding ?? [])).not.toEqual(Array.from(rawEmb))
      // SC-01: re-registering the same raw description must not trigger a second augment call.
      await e.registerCapability({ id: 'tool:x', type: 'tool', description: 'read a file' })
      await e.whenEmbeddingsIdle?.()
      expect(aug.calls).toBe(1)
      await e.close()
    })

    it('runs without an augmenter on the raw description (FEAT-01-07 SC-02)', async () => {
      const storage = await makeStorage()
      const e = await createEngine({ storage, embedding: new FakeEmbedding() })
      await e.registerCapability({ id: 'tool:y', type: 'tool', description: 'beta' })
      await e.whenEmbeddingsIdle?.()
      const cap = (await e.listCapabilities()).find((c) => c.id === 'tool:y')!
      expect(cap.descriptionAugmented).toBeUndefined()
      expect(cap.augmentedBy).toBeUndefined()
      const rawEmb = await new FakeEmbedding().embed('beta')
      expect(Array.from(cap.descriptionEmbedding ?? [])).toEqual(Array.from(rawEmb))
      await e.close()
    })

    it('falls back to the raw description when the augmenter fails (FEAT-01-07 SC-04)', async () => {
      const storage = await makeStorage()
      const aug = new FakeAugmenter({ fail: true })
      const e = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter: aug })
      await e.registerCapability({ id: 'tool:z', type: 'tool', description: 'gamma' })
      await e.whenEmbeddingsIdle?.()
      expect(aug.calls).toBe(1)
      const cap = (await e.listCapabilities()).find((c) => c.id === 'tool:z')!
      expect(cap.descriptionAugmented).toBeUndefined()
      const rawEmb = await new FakeEmbedding().embed('gamma')
      expect(Array.from(cap.descriptionEmbedding ?? [])).toEqual(Array.from(rawEmb))
      await e.close()
    })

    it('retries augmentation on a later registration when the first attempt failed (FEAT-01-07)', async () => {
      const storage = await makeStorage()
      const aug = new FakeAugmenter({ fail: true })
      const e = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter: aug })
      // Drain between registrations: each settled-but-unaugmented capability is retried on the next
      // registration (best-effort recovery), while a successful one is never repeated (SC-01). Without
      // the drain the two enqueues would dedupe to a single background job.
      await e.registerCapability({ id: 'tool:r', type: 'tool', description: 'delta' })
      await e.whenEmbeddingsIdle?.()
      await e.registerCapability({ id: 'tool:r', type: 'tool', description: 'delta' })
      await e.whenEmbeddingsIdle?.()
      expect(aug.calls).toBe(2)
      await e.close()
    })

    it('consult never invokes the augmenter (FEAT-01-07 SC-03)', async () => {
      const storage = await makeStorage()
      const aug = new FakeAugmenter()
      const e = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter: aug })
      await e.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
      await e.whenEmbeddingsIdle?.() // let the one registration-time augment settle
      const afterRegister = aug.calls
      await e.consult({ task_id: 't', context: 'alpha', candidate_ids: ['tool:a'] })
      await e.whenEmbeddingsIdle?.()
      expect(aug.calls).toBe(afterRegister) // consult enqueues no augmentation work of its own (SC-03)
      await e.close()
    })
  })
}
