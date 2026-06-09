import { describe, it, expect } from 'vitest'
import { rowToCapability, rowToEdge, rowToTask, rowToPinnedPath } from './row-mappers.js'
import type { CapRow, EdgeRow, TaskRow, PinnedRow } from './row-mappers.js'

const capBase: CapRow = {
  id: 'tool:a',
  type: 'tool',
  description: 'd',
  description_embedding: null,
  first_seen: '',
  last_seen: '',
}
const edgeBase: EdgeRow = {
  from_capability: '__START__',
  to_capability: 'tool:a',
  pheromone: 0.5,
  success_count: 1,
  failure_count: 0,
  pinned: 0,
  pin_behavior: null,
  pin_owner: null,
  last_updated: '',
}
const taskBase: TaskRow = {
  id: 't1',
  context_text: 'c',
  context_embedding: null,
  path: '["tool:a"]',
  outcome: 'accepted',
  token_cost: 1,
  created_at: '',
  completed_at: null,
  source_host: 'h',
}
const pinnedBase: PinnedRow = {
  id: 'p1',
  name: null,
  description: null,
  capability_sequence: '["tool:a"]',
  parameters_template: null,
  behavior: 'sequence',
  created_at: '',
  created_by: null,
}

describe('row-mappers robustness (audit F-01 / F-04)', () => {
  it('returns [] for a malformed JSON path instead of throwing', () => {
    expect(rowToTask({ ...taskBase, path: '{not json' }).path).toEqual([])
  })

  it('returns [] when the parsed path is not an array of strings', () => {
    expect(rowToTask({ ...taskBase, path: JSON.stringify({ a: 1 }) }).path).toEqual([])
    expect(rowToTask({ ...taskBase, path: JSON.stringify([1, 2]) }).path).toEqual([])
  })

  it('coerces an out-of-enum outcome to null', () => {
    expect(rowToTask({ ...taskBase, outcome: 'bogus' }).outcome).toBeNull()
  })

  it('returns [] for a malformed capability_sequence and the fallback behavior', () => {
    const p = rowToPinnedPath({ ...pinnedBase, capability_sequence: '{bad', behavior: 'bogus' })
    expect(p.capabilitySequence).toEqual([])
    expect(p.behavior).toBe('preferred')
  })

  it('returns undefined for a malformed parameters_template', () => {
    expect(rowToPinnedPath({ ...pinnedBase, parameters_template: '{bad' }).parametersTemplate).toBeUndefined()
  })

  it('coerces an out-of-enum pin behavior on an edge to null', () => {
    expect(rowToEdge({ ...edgeBase, pin_behavior: 'bogus', pinned: 1 }).pinBehavior).toBeNull()
  })

  it('coerces an out-of-enum capability type to tool', () => {
    expect(rowToCapability({ ...capBase, type: 'bogus' }).type).toBe('tool')
  })
})

describe('row-mappers v3 columns (EPIC-04 FEAT-04-01)', () => {
  it('maps embedding_model (the stamp), undefined when null (EPIC-04 FEAT-04-07)', () => {
    expect(rowToCapability(capBase).embeddingModel).toBeUndefined()
    expect(rowToCapability({ ...capBase, embedding_model: 'minilm@1' }).embeddingModel).toBe('minilm@1')
  })

  it('coerces capability source: null -> observed, known passes through, unknown -> observed', () => {
    expect(rowToCapability(capBase).source).toBe('observed')
    expect(rowToCapability({ ...capBase, source: null }).source).toBe('observed')
    expect(rowToCapability({ ...capBase, source: 'declared' }).source).toBe('declared')
    expect(rowToCapability({ ...capBase, source: 'mcp' }).source).toBe('mcp')
    expect(rowToCapability({ ...capBase, source: 'skill' }).source).toBe('skill')
    expect(rowToCapability({ ...capBase, source: 'bogus' }).source).toBe('observed')
  })

  it('coerces pinned path_source: null -> manual, emergent passes through, unknown -> manual', () => {
    expect(rowToPinnedPath(pinnedBase).pathSource).toBe('manual')
    expect(rowToPinnedPath({ ...pinnedBase, path_source: null }).pathSource).toBe('manual')
    expect(rowToPinnedPath({ ...pinnedBase, path_source: 'emergent' }).pathSource).toBe('emergent')
    expect(rowToPinnedPath({ ...pinnedBase, path_source: 'bogus' }).pathSource).toBe('manual')
  })

  it('maps whenToUse and naming provenance, undefined when null', () => {
    const p = rowToPinnedPath({ ...pinnedBase, when_to_use: 'use for X', named_at: 'ts', named_by: 'model' })
    expect(p.whenToUse).toBe('use for X')
    expect(p.namedAt).toBe('ts')
    expect(p.namedBy).toBe('model')
    const bare = rowToPinnedPath(pinnedBase)
    expect(bare.whenToUse).toBeUndefined()
    expect(bare.namedAt).toBeUndefined()
    expect(bare.namedBy).toBeUndefined()
  })

  it('decodes the when_to_use and name embedding blobs', () => {
    const f = new Float32Array([0.1, 0.2, 0.3])
    const blob = new Uint8Array(f.buffer.slice(0))
    const p = rowToPinnedPath({ ...pinnedBase, when_to_use_embedding: blob, name_embedding: blob })
    expect(Array.from(p.whenToUseEmbedding ?? [])).toEqual(Array.from(f))
    expect(Array.from(p.nameEmbedding ?? [])).toEqual(Array.from(f))
    expect(rowToPinnedPath(pinnedBase).whenToUseEmbedding).toBeUndefined()
  })
})
