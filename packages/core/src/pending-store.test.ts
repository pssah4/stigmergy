import { describe, it, expect } from 'vitest'
import { MemoryPendingStore } from './pending-store.js'

describe('MemoryPendingStore', () => {
  it('opens and reads a buffer', () => {
    const s = new MemoryPendingStore()
    const buf = s.open('t1', 'ctx')
    expect(buf.status).toBe('open')
    expect(buf.uses).toEqual([])
    expect(buf.wasIterated).toBe(false)
    expect(s.get('t1')?.contextText).toBe('ctx')
  })

  it('returns undefined for an unknown buffer', () => {
    expect(new MemoryPendingStore().get('nope')).toBeUndefined()
  })

  it('resolves an alias to the canonical buffer', () => {
    const s = new MemoryPendingStore()
    s.open('t1', 'ctx')
    s.alias('t2', 't1')
    expect(s.canonicalId('t2')).toBe('t1')
    expect(s.get('t2')).toBe(s.get('t1'))
  })

  it('follows alias chains', () => {
    const s = new MemoryPendingStore()
    s.open('t1', 'ctx')
    s.alias('t2', 't1')
    s.alias('t3', 't2')
    expect(s.canonicalId('t3')).toBe('t1')
  })

  it('deletes the canonical buffer and its aliases', () => {
    const s = new MemoryPendingStore()
    s.open('t1', 'ctx')
    s.alias('t2', 't1')
    s.delete('t2')
    expect(s.get('t1')).toBeUndefined()
    expect(s.canonicalId('t2')).toBe('t2')
  })

  it('snapshots only contextText and restores buffers', () => {
    const s = new MemoryPendingStore()
    const buf = s.open('t1', 'remember this')
    buf.uses.push({ capabilityId: 'a', prev: '__START__', invoked: true })
    const snaps = s.snapshot()
    expect(snaps).toEqual([{ taskId: 't1', contextText: 'remember this' }])

    const restored = new MemoryPendingStore()
    restored.restore(snaps)
    const r = restored.get('t1')
    expect(r?.contextText).toBe('remember this')
    expect(r?.uses).toEqual([]) // uses are not persisted, only contextText
  })
})
