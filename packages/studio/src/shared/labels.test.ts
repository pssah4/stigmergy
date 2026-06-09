import { describe, it, expect } from 'vitest'
import { LABELS, JARGON_KEYS, tip, type LabelKey } from './labels.js'

describe('labels (SC-03)', () => {
  it('every label is a non-empty plain-language string', () => {
    for (const [key, value] of Object.entries(LABELS)) {
      expect(value.label, key).toBeTruthy()
      expect(value.label.trim().length, key).toBeGreaterThan(0)
    }
  })

  it('every jargon-renaming key carries a non-empty tooltip (the technical term stays discoverable)', () => {
    for (const key of JARGON_KEYS) {
      expect(LABELS[key].tooltip, key).toBeTruthy()
      expect((LABELS[key].tooltip ?? '').trim().length, key).toBeGreaterThan(0)
      expect(tip(key)).toBe(LABELS[key].tooltip)
    }
  })

  it('does not lead any label with raw jargon (it may appear in the tooltip)', () => {
    // 'Pheromone' is intentionally kept as a label (user choice: keep the ant-trail metaphor).
    const banned = ['Substrate', 'Capability', 'Edit mode', 'Sharing', 'Pinned', 'Vault Operator']
    for (const [key, value] of Object.entries(LABELS)) {
      for (const term of banned) {
        expect(value.label, `${key} leads with jargon "${term}"`).not.toBe(term)
      }
    }
  })

  it('tip returns undefined for a label without a tooltip', () => {
    expect(tip('navSettings' as LabelKey)).toBeUndefined()
  })
})
