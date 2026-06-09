import { describe, it, expect } from 'vitest'
import { OutcomeTracker } from './outcome-tracker.js'
import type { ResolvedPath, OutcomeTrackerConfig } from './outcome-tracker.js'
import { MemoryPendingStore } from './pending-store.js'
import { VirtualScheduler } from './scheduler.js'
import { FixedClock } from './clock.js'
import { FakeEmbedding } from './test-helpers/fake-embedding.js'
import { START_NODE } from './types.js'

function setup(config?: OutcomeTrackerConfig) {
  const clock = new FixedClock(1000)
  const scheduler = new VirtualScheduler(clock)
  const store = new MemoryPendingStore()
  const fake = new FakeEmbedding()
  const resolved: ResolvedPath[] = []
  const tracker = new OutcomeTracker({
    store,
    scheduler,
    clock,
    embed: (t) => fake.embed(t),
    onResolve: async (r) => {
      resolved.push(r)
    },
    config: config ?? { timeoutMs: 1000, topicShiftThreshold: 0.6 },
  })
  return { tracker, resolved, clock, scheduler, store }
}

describe('OutcomeTracker', () => {
  it('resolves a happy path once, with the invoked trail and prev links', async () => {
    const { tracker, resolved } = setup()
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'b', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 50 })

    expect(resolved).toHaveLength(1)
    const r = resolved[0]!
    expect(r.outcome).toBe('accepted')
    expect(r.path).toEqual(['a', 'b'])
    expect(r.successes).toEqual([
      { prev: START_NODE, capabilityId: 'a' },
      { prev: 'a', capabilityId: 'b' },
    ])
    expect(r.failures).toEqual([])
    expect(r.discarded).toEqual([])
    expect(r.tokenCost).toBe(50)
  })

  it('records a loaded-but-never-invoked capability as discarded', async () => {
    const { tracker, resolved } = setup()
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 })

    const r = resolved[0]!
    expect(r.path).toEqual(['a'])
    expect(r.discarded).toEqual([{ prev: START_NODE, capabilityId: 'b' }])
  })

  it('records a returned-failure as a negative edge', async () => {
    const { tracker, resolved } = setup()
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: false })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 5 })

    const r = resolved[0]!
    expect(r.failures).toEqual([{ prev: START_NODE, capabilityId: 'a' }])
    expect(r.successes).toEqual([])
    expect(r.path).toEqual(['a'])
  })

  it('auto-accepts after the idle timeout', async () => {
    const { tracker, resolved, clock, scheduler } = setup({ timeoutMs: 1000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    expect(resolved).toHaveLength(0)

    clock.advance(1000)
    await scheduler.runDue(clock.now())
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.outcome).toBe('accepted')
  })

  it('deposits exactly once when an explicit accept races the timeout', async () => {
    const { tracker, resolved, clock, scheduler } = setup({ timeoutMs: 1000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 20 })
    // timeout becomes due, but the buffer is already resolved and deleted
    clock.advance(1000)
    await scheduler.runDue(clock.now())
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.tokenCost).toBe(20)
  })

  it('resolves as iterated when an explicit task_iterated preceded accept', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_iterated', taskId: 't1' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'b', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 30 })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.outcome).toBe('iterated')
    expect(resolved[0]!.path).toEqual(['a', 'b'])
  })

  it('aliases a similar follow-up onto the previous buffer (iteration)', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'alpha beta gamma' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    // identical context -> cosine 1 >= threshold -> alias, no resolution yet
    await tracker.handle({ type: 'task_started', taskId: 't2', context: 'alpha beta gamma' })
    expect(resolved).toHaveLength(0)

    await tracker.handle({ type: 'capability_loaded', taskId: 't2', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't2', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_returned', taskId: 't2', capabilityId: 'b', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't2' })
    await tracker.handle({ type: 'task_accepted', taskId: 't2', tokenCost: 40 })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.taskId).toBe('t1') // canonical buffer
    expect(resolved[0]!.outcome).toBe('iterated')
    expect(resolved[0]!.path).toEqual(['a', 'b'])
  })

  it('closes the previous buffer as accepted on a topic change', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'report quarterly revenue numbers' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    // disjoint context -> cosine ~0 < threshold -> resolve t1 accepted, open t2
    await tracker.handle({ type: 'task_started', taskId: 't2', context: 'schedule team lunch friday' })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.taskId).toBe('t1')
    expect(resolved[0]!.outcome).toBe('accepted')
    expect(resolved[0]!.path).toEqual(['a'])

    await tracker.handle({ type: 'capability_loaded', taskId: 't2', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't2', capabilityId: 'b' })
    await tracker.handle({ type: 'response_delivered', taskId: 't2' })
    await tracker.handle({ type: 'task_accepted', taskId: 't2', tokenCost: 15 })
    expect(resolved).toHaveLength(2)
    expect(resolved[1]!.taskId).toBe('t2')
  })

  it('reconstructs the trail in invocation order, not load order', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'b' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 })

    const r = resolved[0]!
    expect(r.path).toEqual(['b', 'a'])
    expect(r.successes).toEqual([
      { prev: START_NODE, capabilityId: 'b' },
      { prev: 'b', capabilityId: 'a' },
    ])
    expect(r.discarded).toEqual([])
  })

  it('does not record a re-loaded already-invoked capability as discarded (no self-loop)', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_returned', taskId: 't1', capabilityId: 'a', success: true })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 })

    const r = resolved[0]!
    expect(r.discarded).toEqual([])
    expect(r.path).toEqual(['a'])
  })

  it('resolves an abandoned task with zero positive weight', async () => {
    const { tracker, resolved } = setup()
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'do x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_abandoned', taskId: 't1' })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.outcome).toBe('abandoned')
    expect(resolved[0]!.tokenCost).toBe(0)
  })

  it('does not emit a self-loop edge when a capability is invoked twice in a row', async () => {
    const { tracker, resolved } = setup({ timeoutMs: 100000, topicShiftThreshold: 0.6 })
    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 })

    const r = resolved[0]!
    expect(r.successes.every((s) => s.prev !== s.capabilityId)).toBe(true)
    expect(r.failures.every((f) => f.prev !== f.capabilityId)).toBe(true)
    expect(r.discarded).toEqual([])
  })

  it('opens the new buffer even when the topic-shift resolution of the previous buffer fails', async () => {
    const clock = new FixedClock(1000)
    const scheduler = new VirtualScheduler(clock)
    const store = new MemoryPendingStore()
    const fake = new FakeEmbedding()
    const tracker = new OutcomeTracker({
      store,
      scheduler,
      clock,
      embed: (t) => fake.embed(t),
      onResolve: async () => {
        throw new Error('storage down')
      },
      config: { timeoutMs: 100000, topicShiftThreshold: 0.6 },
    })

    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'alpha beta gamma' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })
    // disjoint context -> topic change resolves t1 (which throws), but t2 must still be tracked
    await expect(
      tracker.handle({ type: 'task_started', taskId: 't2', context: 'zeta eta theta iota' }),
    ).rejects.toThrow('storage down')
    expect(store.get('t2')).toBeDefined()
  })

  it('re-arms the auto-accept timer when the timeout-fired deposit fails, so it retries', async () => {
    const clock = new FixedClock(1000)
    const scheduler = new VirtualScheduler(clock)
    const store = new MemoryPendingStore()
    const fake = new FakeEmbedding()
    const resolved: ResolvedPath[] = []
    let calls = 0
    const tracker = new OutcomeTracker({
      store,
      scheduler,
      clock,
      embed: (t) => fake.embed(t),
      onResolve: async (r) => {
        calls++
        if (calls === 1) throw new Error('storage down')
        resolved.push(r)
      },
      config: { timeoutMs: 1000, topicShiftThreshold: 0.6 },
    })

    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })

    clock.advance(1000)
    await scheduler.runDue(clock.now()) // first fire: deposit throws, timer re-arms
    expect(resolved).toHaveLength(0)
    expect(store.get('t1')).toBeDefined()

    clock.advance(1000)
    await scheduler.runDue(clock.now()) // second fire: deposit succeeds
    expect(resolved).toHaveLength(1)
    expect(store.get('t1')).toBeUndefined()
  })

  it('keeps the buffer for retry when onResolve fails, then resolves exactly once', async () => {
    const clock = new FixedClock(1000)
    const scheduler = new VirtualScheduler(clock)
    const store = new MemoryPendingStore()
    const fake = new FakeEmbedding()
    const resolved: ResolvedPath[] = []
    let calls = 0
    const tracker = new OutcomeTracker({
      store,
      scheduler,
      clock,
      embed: (t) => fake.embed(t),
      onResolve: async (r) => {
        calls++
        if (calls === 1) throw new Error('storage down')
        resolved.push(r)
      },
      config: { timeoutMs: 100000, topicShiftThreshold: 0.6 },
    })

    await tracker.handle({ type: 'task_started', taskId: 't1', context: 'x' })
    await tracker.handle({ type: 'capability_loaded', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'capability_invoked', taskId: 't1', capabilityId: 'a' })
    await tracker.handle({ type: 'response_delivered', taskId: 't1' })

    await expect(tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 })).rejects.toThrow('storage down')
    expect(store.get('t1')).toBeDefined() // buffer kept after a failed deposit

    await tracker.handle({ type: 'task_accepted', taskId: 't1', tokenCost: 10 }) // retry succeeds
    expect(resolved).toHaveLength(1)
    expect(store.get('t1')).toBeUndefined() // deleted only after onResolve succeeded
  })
})
