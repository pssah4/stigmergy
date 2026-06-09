import { describe, it, expect } from 'vitest'
import { parseRunConfig } from './runconfig.js'

const valid = {
  workloadFile: 'workloads/wl-v1.json',
  seed: 7,
  variants: [
    { name: 'baseline', knobs: {}, learn: false },
    { name: 'treatment', knobs: { decay: true }, topK: 2, learn: true },
  ],
}

describe('parseRunConfig', () => {
  it('parses a valid run-config with variants and knobs', () => {
    const c = parseRunConfig(JSON.stringify(valid))
    expect(c.seed).toBe(7)
    expect(c.variants).toHaveLength(2)
    expect(c.variants[1]!.topK).toBe(2)
  })

  it('rejects a config without a workloadFile', () => {
    expect(() => parseRunConfig(JSON.stringify({ ...valid, workloadFile: '' }))).toThrow(/workloadFile/)
  })

  it('rejects a config without variants', () => {
    expect(() => parseRunConfig(JSON.stringify({ ...valid, variants: [] }))).toThrow(/no variants/)
  })

  it('rejects duplicate variant names', () => {
    const dup = { ...valid, variants: [{ name: 'x', knobs: {} }, { name: 'x', knobs: {} }] }
    expect(() => parseRunConfig(JSON.stringify(dup))).toThrow(/duplicate variant/)
  })

  it('rejects a topK below 1 (AUDIT: topK=0 vacuous run)', () => {
    const bad = { ...valid, variants: [{ name: 'x', knobs: {}, topK: 0 }] }
    expect(() => parseRunConfig(JSON.stringify(bad))).toThrow(/topK must be a positive integer/)
  })

  it('rejects non-object knobs (AUDIT: deferred crash)', () => {
    const bad = { ...valid, variants: [{ name: 'x', knobs: 'nope' }] }
    expect(() => parseRunConfig(JSON.stringify(bad))).toThrow(/knobs must be an object/)
  })

  it('rejects a variant name with a path separator or .. (CWE-22, SEC L-1)', () => {
    expect(() => parseRunConfig(JSON.stringify({ ...valid, variants: [{ name: '../evil', knobs: {} }] }))).toThrow(/path separators or/)
  })
})
