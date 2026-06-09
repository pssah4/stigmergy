// Pure step-state for the first-run onboarding wizard (FEAT-05-05, ADR-23). The wizard guides the
// operator until Stigmergy is set up and running. This reducer only tracks the step progression and
// the per-step gate/skip rules; the live data (native binding ok, active provider, daemon running,
// enabled flag) is derived in the component and passed as ctx. No React/Electron import, so the
// monorepo vitest covers it.

export const ONBOARDING_STEPS = ['welcome', 'native', 'substrate', 'provider', 'daemon', 'connect', 'activate', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** Live conditions the component derives from settings, daemon status, and the substrate error. */
export interface OnboardingCtx {
  /** The native database binding matches the desktop runtime (no rebuild needed). */
  nativeOk: boolean
  /** An active, enabled provider with a model is configured. */
  hasActiveProvider: boolean
  /** The Studio-managed daemon is running. */
  daemonRunning: boolean
  /** A loop project has been connected (IMP-05-05-01). */
  loopConnected: boolean
  /** Stigmergy is switched on for the connected loop. */
  enabled: boolean
}

export interface OnboardingState {
  step: OnboardingStep
}

export const initialOnboardingState: OnboardingState = { step: 'welcome' }

/** Per-step gate (whether Next is allowed) and whether the step may be skipped despite an unmet gate. */
const STEP_RULES: Record<OnboardingStep, { gate: (c: OnboardingCtx) => boolean; skippable: boolean }> = {
  welcome: { gate: () => true, skippable: false },
  native: { gate: (c) => c.nativeOk, skippable: false },
  substrate: { gate: () => true, skippable: false },
  provider: { gate: (c) => c.hasActiveProvider, skippable: true },
  daemon: { gate: (c) => c.daemonRunning, skippable: true },
  connect: { gate: (c) => c.loopConnected, skippable: true },
  activate: { gate: (c) => c.enabled, skippable: false },
  done: { gate: () => false, skippable: false },
}

export function stepIndex(state: OnboardingState): number {
  return ONBOARDING_STEPS.indexOf(state.step)
}

export function currentStep(state: OnboardingState): OnboardingStep {
  return state.step
}

/** Whether the current step may be skipped (advances despite an unmet gate). */
export function isSkippable(state: OnboardingState): boolean {
  return STEP_RULES[state.step].skippable
}

/** Whether Next is allowed from the current step (its gate is met). 'done' is terminal. */
export function canAdvance(state: OnboardingState, ctx: OnboardingCtx): boolean {
  return STEP_RULES[state.step].gate(ctx)
}

/** Advance to the next step only when the gate is met. Never skips a gate. */
export function next(state: OnboardingState, ctx: OnboardingCtx): OnboardingState {
  if (state.step === 'done' || !canAdvance(state, ctx)) return state
  return { step: ONBOARDING_STEPS[stepIndex(state) + 1]! }
}

/** Skip a skippable step despite an unmet gate. A non-skippable step is unchanged. */
export function skip(state: OnboardingState): OnboardingState {
  if (!STEP_RULES[state.step].skippable) return state
  return { step: ONBOARDING_STEPS[stepIndex(state) + 1]! }
}

export function back(state: OnboardingState): OnboardingState {
  const i = stepIndex(state)
  if (i === 0) return state
  return { step: ONBOARDING_STEPS[i - 1]! }
}

export function isComplete(state: OnboardingState): boolean {
  return state.step === 'done'
}
