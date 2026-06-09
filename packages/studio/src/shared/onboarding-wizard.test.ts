import { describe, it, expect } from 'vitest'
import {
  initialOnboardingState,
  canAdvance,
  next,
  back,
  skip,
  isComplete,
  isSkippable,
  type OnboardingCtx,
} from './onboarding-wizard.js'

const NONE: OnboardingCtx = {
  nativeOk: false,
  hasActiveProvider: false,
  daemonRunning: false,
  loopConnected: false,
  enabled: false,
}
const ALL: OnboardingCtx = { nativeOk: true, hasActiveProvider: true, daemonRunning: true, loopConnected: true, enabled: true }

describe('onboarding wizard reducer (FEAT-05-05, ADR-23)', () => {
  it('starts at welcome and advances to native (SC-01)', () => {
    expect(initialOnboardingState.step).toBe('welcome')
    expect(next(initialOnboardingState, NONE).step).toBe('native')
  })

  it('gates the native step on a working native binding and never skips it (SC-03)', () => {
    const atNative = next(initialOnboardingState, NONE) // welcome -> native
    expect(canAdvance(atNative, NONE)).toBe(false)
    expect(next(atNative, NONE).step).toBe('native') // blocked
    expect(isSkippable(atNative)).toBe(false)
    expect(skip(atNative).step).toBe('native') // not skippable
    expect(next(atNative, { ...NONE, nativeOk: true }).step).toBe('substrate')
  })

  it('lets provider/daemon be skipped but not advanced past their gate (SC-02)', () => {
    // walk to provider with native ok
    let s = next(initialOnboardingState, { ...NONE, nativeOk: true }) // native
    s = next(s, { ...NONE, nativeOk: true }) // substrate
    s = next(s, { ...NONE, nativeOk: true }) // provider
    expect(s.step).toBe('provider')
    expect(isSkippable(s)).toBe(true)
    expect(next(s, NONE).step).toBe('provider') // gate not met -> blocked
    expect(skip(s).step).toBe('daemon') // skip advances anyway (no embedding step anymore, IMP-05-06-02)
    expect(next(s, { ...NONE, hasActiveProvider: true }).step).toBe('daemon') // gate met -> advances
  })

  it('gates activate on enabled and completes only at done (SC-01/SC-06)', () => {
    // jump near the end via a fully-satisfied context
    let s = initialOnboardingState
    for (let i = 0; i < 6; i++) s = next(s, ALL) // welcome->native->substrate->provider->daemon->connect->activate
    expect(s.step).toBe('activate')
    expect(canAdvance(s, { ...ALL, enabled: false })).toBe(false)
    expect(next(s, { ...ALL, enabled: false }).step).toBe('activate') // blocked until enabled
    const done = next(s, ALL)
    expect(done.step).toBe('done')
    expect(isComplete(done)).toBe(true)
    expect(isComplete(s)).toBe(false)
  })

  it('back decrements and stays at welcome', () => {
    const atNative = next(initialOnboardingState, ALL)
    expect(back(atNative).step).toBe('welcome')
    expect(back(initialOnboardingState).step).toBe('welcome')
  })
})
