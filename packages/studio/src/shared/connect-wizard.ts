// Pure step-state for the "Connect your agent loop" onboarding wizard (FEAT-03-08, SC-05). Four
// steps: pick the loop's project folder, detect the framework, insert the snippet (optionally write
// the adapter), then verify live-green. The reducer only tracks the step progression and the gates
// for advancing; the data (framework detection, verify progress) comes from IPC and the substrate
// snapshot in the component. No React/Electron import, so the monorepo vitest covers it.

export const WIZARD_STEPS = ['project', 'detect', 'snippet', 'verify'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export interface WizardState {
  step: WizardStep
  /** The loop project directory the user picked in step 1. */
  dir: string
  /** Whether the framework detection ran for the current dir. */
  detected: boolean
  /** Whether the user pressed "start listening" in the verify step. */
  listening: boolean
}

export const initialWizardState: WizardState = { step: 'project', dir: '', detected: false, listening: false }

export function stepIndex(state: WizardState): number {
  return WIZARD_STEPS.indexOf(state.step)
}

/** Set the project directory. A new directory invalidates the previous detection. */
export function setDir(state: WizardState, dir: string): WizardState {
  if (dir === state.dir) return state
  return { ...state, dir, detected: false }
}

export function markDetected(state: WizardState): WizardState {
  return { ...state, detected: true }
}

export function startListening(state: WizardState): WizardState {
  return { ...state, listening: true }
}

/** Whether the wizard may advance from the current step. */
export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case 'project':
      return state.dir.trim() !== ''
    case 'detect':
      return state.detected
    case 'snippet':
      return true
    case 'verify':
      return false // last step
  }
}

export function next(state: WizardState): WizardState {
  if (!canAdvance(state)) return state
  const i = stepIndex(state)
  return { ...state, step: WIZARD_STEPS[i + 1]! }
}

export function back(state: WizardState): WizardState {
  const i = stepIndex(state)
  if (i === 0) return state
  return { ...state, step: WIZARD_STEPS[i - 1]! }
}
