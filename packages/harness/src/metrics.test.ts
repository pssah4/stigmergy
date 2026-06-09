import { describe, it, expect } from 'vitest'
import { median, percentile, aggregate } from './metrics.js'
import type { TaskResult } from './runner.js'

describe('median', () => {
  it('returns the middle value for an odd count', () => {
    expect(median([3, 1, 2])).toBe(2)
  })
  it('averages the two middle values for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('returns 0 for an empty set', () => {
    expect(median([])).toBe(0)
  })
})

describe('percentile (nearest-rank)', () => {
  it('p95 over four values is the maximum', () => {
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40)
  })
  it('p50 over a sorted set is around the middle', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20)
  })
})

describe('aggregate', () => {
  const tasks: TaskResult[] = [
    { taskId: 't1', success: true, attempts: 1, firstTryCorrect: true, tokenCost: 100 },
    { taskId: 't2', success: true, attempts: 2, firstTryCorrect: false, tokenCost: 300 },
    { taskId: 't3', success: false, attempts: 3, firstTryCorrect: false, tokenCost: 500 },
    { taskId: 't4', success: true, attempts: 1, firstTryCorrect: true, tokenCost: 700 },
  ]

  it('computes rates and distributions', () => {
    const m = aggregate(tasks)
    expect(m.taskCount).toBe(4)
    expect(m.successRate).toBe(0.75)
    expect(m.firstTryCorrectRate).toBe(0.5)
    expect(m.tokenMedian).toBe(400) // (300+500)/2
    expect(m.tokenP95).toBe(700)
    expect(m.attemptsMedian).toBe(1.5) // (1+2)/2 of sorted [1,1,2,3]
    expect(m.totalTokens).toBe(1600)
  })

  it('is safe on an empty set', () => {
    const m = aggregate([])
    expect(m.taskCount).toBe(0)
    expect(m.successRate).toBe(0)
    expect(m.totalTokens).toBe(0)
  })
})
