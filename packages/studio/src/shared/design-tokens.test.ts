import { describe, it, expect } from 'vitest'
import {
  tokens,
  surfaceStyle,
  cardStyle,
  buttonStyle,
  inputStyle,
  badgeStyle,
  mutedTextStyle,
  transition,
} from './design-tokens.js'

describe('design tokens (FEAT-05-01, ADR-21)', () => {
  it('exposes string color values and a strictly increasing spacing scale (SC-01)', () => {
    for (const v of Object.values(tokens.color)) expect(typeof v).toBe('string')
    for (let i = 1; i < tokens.space.length; i++) {
      expect(tokens.space[i]).toBeGreaterThan(tokens.space[i - 1])
    }
  })

  it('carries NO model-tier vocabulary anywhere (SC-04)', () => {
    expect(JSON.stringify(tokens).toLowerCase()).not.toContain('tier')
  })
})

describe('style factories (FEAT-05-01 SC-02)', () => {
  it('buttonStyle distinguishes variants and the disabled state', () => {
    const primary = buttonStyle('primary')
    const def = buttonStyle('default')
    expect(primary.background).not.toBe(def.background)
    const disabled = buttonStyle('default', 'disabled')
    expect(disabled.cursor).toBe('not-allowed')
    expect(Number(disabled.opacity)).toBeLessThan(1)
  })

  it('inputStyle marks the border in the error state', () => {
    expect(inputStyle('error').borderColor).toBe(tokens.color.danger)
    expect(inputStyle('default').borderColor).toBe(tokens.color.border)
  })

  it('surface, card, badge and muted-text factories return token-derived styles', () => {
    expect(surfaceStyle().background).toBe(tokens.color.bg)
    expect(cardStyle().background).toBe(tokens.color.surface)
    expect(badgeStyle().borderRadius).toBe(tokens.radius.sm)
    expect(mutedTextStyle().color).toBe(tokens.color.textMuted)
  })
})

describe('elevation, motion and interaction tokens (FEAT-06-08)', () => {
  it('exposes string shadow, easing and focusRing values plus numeric durations', () => {
    for (const v of Object.values(tokens.shadow)) expect(typeof v).toBe('string')
    for (const v of Object.values(tokens.easing)) expect(typeof v).toBe('string')
    expect(typeof tokens.focusRing).toBe('string')
    for (const v of Object.values(tokens.duration)) expect(typeof v).toBe('number')
    expect(tokens.layout.panelWidth).toBeGreaterThan(0)
  })

  it('still carries NO model-tier vocabulary after the token additions (SC-04)', () => {
    expect(JSON.stringify(tokens).toLowerCase()).not.toContain('tier')
  })

  it('transition() builds a comma-joined property/duration/easing string', () => {
    expect(transition(['background'], 120, 'ease')).toBe('background 120ms ease')
    expect(transition(['background', 'color'])).toContain(',')
    expect(transition(['box-shadow'])).toContain('ms')
  })

  it('buttonStyle distinguishes hover, active and focus from default', () => {
    const def = buttonStyle('default', 'default')
    expect(buttonStyle('default', 'hover').background).not.toBe(def.background)
    expect(buttonStyle('default', 'active').transform).toBe('scale(0.98)')
    expect(buttonStyle('default', 'focus').boxShadow).toBe(tokens.focusRing)
    expect(def.transition).toContain('ms')
  })

  it('inputStyle marks the focus state with the accent border and focus ring', () => {
    const focus = inputStyle('focus')
    expect(focus.borderColor).toBe(tokens.color.accent)
    expect(focus.boxShadow).toBe(tokens.focusRing)
  })
})
