import { describe, it, expect } from 'vitest'
import { RankWalkAgent } from './agent.js'
import type { WorkloadTask } from './workload.js'

const task: WorkloadTask = {
  id: 't',
  context: 'c',
  expectedCapabilityClasses: [],
  oracle: 'tool:a',
  successCriteria: [],
  tokenBudget: 100,
}

describe('RankWalkAgent', () => {
  it('invokes the surfaced id at the attempt index and flags done only at the oracle', () => {
    const agent = new RankWalkAgent()
    expect(agent.step(task, ['tool:x', 'tool:a'], 0)).toEqual({ invoke: 'tool:x', done: false })
    expect(agent.step(task, ['tool:x', 'tool:a'], 1)).toEqual({ invoke: 'tool:a', done: true })
  })

  it('gives up when the attempt index is past the surfaced set', () => {
    const agent = new RankWalkAgent()
    expect(agent.step(task, ['tool:x'], 1)).toEqual({ invoke: '', done: true })
  })
})
