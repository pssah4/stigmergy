import { describe, it, expect } from 'vitest'
import { initialWizardState, setDir, markDetected, startListening, canAdvance, next, back, WIZARD_STEPS } from './connect-wizard.js'

describe('connect-wizard reducer (SC-05)', () => {
  it('starts on the project step and cannot advance without a directory', () => {
    expect(initialWizardState.step).toBe('project')
    expect(canAdvance(initialWizardState)).toBe(false)
  })

  it('advances project -> detect once a directory is set', () => {
    const withDir = setDir(initialWizardState, '/loop')
    expect(canAdvance(withDir)).toBe(true)
    expect(next(withDir).step).toBe('detect')
  })

  it('detect step needs a detection before advancing', () => {
    let s = next(setDir(initialWizardState, '/loop')) // on detect
    expect(canAdvance(s)).toBe(false)
    s = markDetected(s)
    expect(canAdvance(s)).toBe(true)
    expect(next(s).step).toBe('snippet')
  })

  it('snippet always advances to verify, and verify is terminal', () => {
    let s = next(markDetected(next(setDir(initialWizardState, '/loop')))) // on snippet
    expect(s.step).toBe('snippet')
    expect(canAdvance(s)).toBe(true)
    s = next(s)
    expect(s.step).toBe('verify')
    expect(canAdvance(s)).toBe(false)
    expect(next(s).step).toBe('verify') // terminal, no further advance
  })

  it('changing the directory invalidates a prior detection', () => {
    const detected = markDetected(setDir(initialWizardState, '/loop'))
    expect(detected.detected).toBe(true)
    expect(setDir(detected, '/other').detected).toBe(false)
    expect(setDir(detected, '/loop').detected).toBe(true) // same dir keeps it
  })

  it('back walks one step and never before the first', () => {
    const onDetect = next(setDir(initialWizardState, '/loop'))
    expect(back(onDetect).step).toBe('project')
    expect(back(initialWizardState).step).toBe('project')
  })

  it('startListening flags the verify step without changing the step', () => {
    const s = startListening({ ...initialWizardState, step: 'verify' })
    expect(s.listening).toBe(true)
    expect(s.step).toBe('verify')
  })

  it('exposes the four steps in order', () => {
    expect(WIZARD_STEPS).toEqual(['project', 'detect', 'snippet', 'verify'])
  })
})
