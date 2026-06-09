import { describe, it, expect } from 'vitest'
import { workloadHash, parseWorkload, type Workload } from './workload.js'

const w: Workload = {
  id: 'wl-test',
  version: '1.0',
  capabilities: [{ id: 'tool:a', type: 'tool', description: 'alpha', defTokens: 100 }],
  tasks: [
    {
      id: 't1',
      context: 'do x',
      expectedCapabilityClasses: ['read'],
      oracle: 'tool:a',
      successCriteria: ['ok'],
      tokenBudget: 1000,
    },
  ],
}

describe('workloadHash', () => {
  it('is stable for identical content', () => {
    expect(workloadHash(w)).toBe(workloadHash(structuredClone(w)))
  })

  it('ignores object key order (canonical form)', () => {
    const reordered = { tasks: w.tasks, capabilities: w.capabilities, version: '1.0', id: 'wl-test' } as Workload
    expect(workloadHash(reordered)).toBe(workloadHash(w))
  })

  it('changes when task content changes', () => {
    const changed = structuredClone(w)
    changed.tasks[0]!.context = 'do y'
    expect(workloadHash(changed)).not.toBe(workloadHash(w))
  })
})

describe('parseWorkload', () => {
  it('parses, hashes, and carries the file path', () => {
    const res = parseWorkload(JSON.stringify(w), 'wl.json')
    expect(res.hash).toBe(workloadHash(w))
    expect(res.file).toBe('wl.json')
    expect(res.workload.tasks).toHaveLength(1)
  })

  it('rejects a workload without capabilities', () => {
    expect(() => parseWorkload(JSON.stringify({ id: 'x', version: '1', capabilities: [], tasks: [] }))).toThrow(/no capabilities/)
  })

  it('rejects a workload without tasks', () => {
    const pool = [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }]
    expect(() => parseWorkload(JSON.stringify({ id: 'x', version: '1', capabilities: pool, tasks: [] }))).toThrow(/no tasks/)
  })

  it('rejects a task without an oracle', () => {
    const pool = [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }]
    const bad = { id: 'x', version: '1', capabilities: pool, tasks: [{ id: 't', context: 'c', expectedCapabilityClasses: [], oracle: '', successCriteria: [], tokenBudget: 100 }] }
    expect(() => parseWorkload(JSON.stringify(bad))).toThrow(/oracle/)
  })

  it('rejects a task whose oracle is not in the capability pool', () => {
    const pool = [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }]
    const bad = { id: 'x', version: '1', capabilities: pool, tasks: [{ id: 't', context: 'c', expectedCapabilityClasses: [], oracle: 'tool:missing', successCriteria: [], tokenBudget: 100 }] }
    expect(() => parseWorkload(JSON.stringify(bad))).toThrow(/not in capability pool/)
  })
})

describe('parseWorkload hardened validation (AUDIT)', () => {
  const task = { id: 't', context: 'c', expectedCapabilityClasses: [], oracle: 'tool:a', successCriteria: [], tokenBudget: 100 }

  it('rejects a duplicate capability id', () => {
    const pool = [
      { id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 },
      { id: 'tool:a', type: 'skill', description: 'b', defTokens: 99 },
    ]
    expect(() => parseWorkload(JSON.stringify({ id: 'x', version: '1', capabilities: pool, tasks: [task] }))).toThrow(/duplicate capability id/)
  })

  it('rejects an invalid capability type', () => {
    const pool = [{ id: 'tool:a', type: 'banana', description: 'a', defTokens: 10 }]
    expect(() => parseWorkload(JSON.stringify({ id: 'x', version: '1', capabilities: pool, tasks: [task] }))).toThrow(/invalid type/)
  })

  it('rejects a non-finite defTokens (1e999 parses to Infinity)', () => {
    const raw = '{"id":"x","version":"1","capabilities":[{"id":"tool:a","type":"tool","description":"a","defTokens":1e999}],"tasks":[{"id":"t","context":"c","expectedCapabilityClasses":[],"oracle":"tool:a","successCriteria":[],"tokenBudget":100}]}'
    expect(() => parseWorkload(raw)).toThrow(/defTokens must be a finite number/)
  })

  it('rejects a non-finite tokenBudget', () => {
    const raw = '{"id":"x","version":"1","capabilities":[{"id":"tool:a","type":"tool","description":"a","defTokens":10}],"tasks":[{"id":"t","context":"c","expectedCapabilityClasses":[],"oracle":"tool:a","successCriteria":[],"tokenBudget":1e999}]}'
    expect(() => parseWorkload(raw)).toThrow(/tokenBudget must be a finite number/)
  })

  it('rejects a non-array expectedCapabilityClasses', () => {
    const pool = [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }]
    const bad = { id: 'x', version: '1', capabilities: pool, tasks: [{ ...task, expectedCapabilityClasses: 'nope' }] }
    expect(() => parseWorkload(JSON.stringify(bad))).toThrow(/expectedCapabilityClasses must be an array/)
  })

  it('rejects an id with a path separator or .. (CWE-22, SEC L-1)', () => {
    const pool = [{ id: 'tool:a', type: 'tool', description: 'a', defTokens: 10 }]
    expect(() => parseWorkload(JSON.stringify({ id: '../escape', version: '1', capabilities: pool, tasks: [task] }))).toThrow(/path separators or/)
    expect(() => parseWorkload(JSON.stringify({ id: 'a/b', version: '1', capabilities: pool, tasks: [task] }))).toThrow(/path separators or/)
  })
})
