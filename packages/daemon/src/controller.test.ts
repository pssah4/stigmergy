import { describe, it, expect } from 'vitest'
import { START_NODE, type PinPathInput, type StigmergyEngine } from '@agentic-stigmergy/core'
import { nameEmergentPaths, type EmergentNamer } from './controller.js'

/** A minimal fake engine: backup returns crafted edges/pins, pinPath records the inputs. */
function fakeEngine(edges: Array<{ from: string; to: string; success: number; pinned?: boolean }>, pinnedSequences: string[][] = []) {
  const pins: PinPathInput[] = []
  const engine = {
    backup: async () => ({
      version: 1,
      capabilities: [],
      tasks: [],
      edges: edges.map((e) => ({
        fromCapability: e.from,
        toCapability: e.to,
        pheromone: 0.5,
        successCount: e.success,
        failureCount: 0,
        pinned: e.pinned ?? false,
        pinBehavior: null,
        pinOwner: null,
        lastUpdated: '',
      })),
      pinnedPaths: pinnedSequences.map((seq, i) => ({ id: `p${i}`, capabilitySequence: seq, behavior: 'preferred', createdAt: '' })),
    }),
    pinPath: async (input: PinPathInput) => {
      pins.push(input)
      return { id: 'pin', capabilitySequence: input.capability_sequence, behavior: 'preferred', createdAt: '' }
    },
  } as unknown as Pick<StigmergyEngine, 'backup' | 'pinPath'>
  return { engine, pins }
}

const namer: EmergentNamer = async (seq) => ({ name: `flow ${seq.join('-')}`, whenToUse: `use for ${seq.join(' then ')}` })

describe('nameEmergentPaths (EPIC-04 FEAT-04-04)', () => {
  it('names an emergent candidate and pins it with emergent provenance', async () => {
    const { engine, pins } = fakeEngine([{ from: START_NODE, to: 'a', success: 5 }])
    const res = await nameEmergentPaths(engine, namer, { threshold: 3, namedBy: 'fake-model' })
    expect(res).toEqual({ named: 1, skipped: 0 })
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({
      capability_sequence: ['a'],
      behavior: 'sequence', // gate-able: the daemon's whenToUse only fires for sequence pins (ADR-18)
      name: 'flow a',
      when_to_use: 'use for a',
      path_source: 'emergent',
      named_by: 'fake-model',
    })
  })

  it('skips a candidate when the namer returns null (no provider), with no pin', async () => {
    const { engine, pins } = fakeEngine([{ from: START_NODE, to: 'a', success: 5 }])
    const res = await nameEmergentPaths(engine, async () => null, { threshold: 3, namedBy: 'm' })
    expect(res).toEqual({ named: 0, skipped: 1 })
    expect(pins).toHaveLength(0) // no half-write
  })

  it('does not re-propose a sequence that is already a pinned path', async () => {
    const { engine, pins } = fakeEngine([{ from: START_NODE, to: 'a', success: 5 }], [['a']])
    const res = await nameEmergentPaths(engine, namer, { threshold: 3, namedBy: 'm' })
    expect(res).toEqual({ named: 0, skipped: 0 })
    expect(pins).toHaveLength(0)
  })
})
