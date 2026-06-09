// First-run onboarding wizard (FEAT-05-05, ADR-23). Guides the operator step by step until Stigmergy
// is set up and running. VO-style four zones: header with progress, body per step, footer with
// Back/Skip/Next/Finish. The step progression is the pure onboarding-wizard reducer; the live
// conditions (native binding ok, active provider, embedding chosen, daemon running, enabled) are
// derived here and passed as ctx. Provider/embedding config reuses the shared ProviderConfigEditor.
import { useEffect, useState, type CSSProperties } from 'react'
import {
  initialOnboardingState,
  currentStep,
  canAdvance,
  next,
  back,
  skip,
  isSkippable,
  stepIndex,
  ONBOARDING_STEPS,
  type OnboardingCtx,
  type OnboardingStep,
} from '../shared/onboarding-wizard.js'
import { defaultSettings, resolveActiveProvider, type StudioSettings } from '../shared/settings.js'
import { ProviderConfigEditor } from './ProviderConfigEditor.js'
import { LoopConnect } from './LoopConnect.js'
import { Button, Card, MutedText } from './components.js'
import { tokens } from '../shared/design-tokens.js'
import { friendlyError, isNativeRebuildError } from '../shared/friendly-error.js'
import type { DaemonStatus } from '../shared/ipc.js'

const TITLES: Record<OnboardingStep, string> = {
  welcome: 'Welcome to Stigmergy',
  native: 'Database module',
  substrate: 'Memory file',
  provider: 'LLM provider',
  daemon: 'Start the daemon',
  connect: 'Connect your loop',
  activate: 'Activate Stigmergy',
  done: 'Done',
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(20,22,26,0.96)',
}

export function OnboardingWizard({
  substrateError,
  enabled,
  connectedProject,
  substratePath,
  onActivate,
  onComplete,
}: {
  substrateError?: string
  enabled: boolean
  connectedProject: string
  substratePath: string
  onActivate: (enabled: boolean) => void
  onComplete: () => void
}): JSX.Element {
  const [settings, setSettings] = useState<StudioSettings>(defaultSettings)
  const [wiz, setWiz] = useState(initialOnboardingState)
  const [daemon, setDaemon] = useState<DaemonStatus>({ running: false })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.studio.getSettings().then(setSettings)
  }, [])
  useEffect(() => {
    let active = true
    const tick = (): void => void window.studio.daemonStatus().then((s) => active && setDaemon(s))
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const ctx: OnboardingCtx = {
    nativeOk: !isNativeRebuildError(substrateError ?? ''),
    hasActiveProvider: resolveActiveProvider(settings) !== null,
    daemonRunning: daemon.running,
    loopConnected: connectedProject !== '',
    enabled,
  }
  const step = currentStep(wiz)
  const total = ONBOARDING_STEPS.length - 1 // exclude the terminal 'done'
  const onActivateStep = step === 'activate'

  async function persist(s: StudioSettings = settings): Promise<void> {
    await window.studio.saveSettings(s)
  }

  async function advance(): Promise<void> {
    setBusy(true)
    try {
      await persist() // persist the config so the daemon and engine see it on later steps
      setWiz((w) => next(w, ctx))
    } finally {
      setBusy(false)
    }
  }

  async function finish(): Promise<void> {
    setBusy(true)
    try {
      await persist({ ...settings, onboarding: { completed: true } })
      onComplete()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={overlayStyle}>
      <Card style={{ width: 600, maxHeight: '86%', overflowY: 'auto', padding: tokens.space[4] }}>
        <header style={{ marginBottom: tokens.space[2] }}>
          <MutedText>Step {stepIndex(wiz) + 1} of {total}</MutedText>
          <h1 style={{ fontSize: 20, margin: `${tokens.space[1]}px 0 0` }}>{TITLES[step]}</h1>
        </header>

        <div style={{ minHeight: 160, marginBottom: tokens.space[3], lineHeight: 1.6 }}>
          {step === 'welcome' ? (
            <p>
              This wizard sets Stigmergy up step by step until it is configured and running. You will check the
              database module, pick a memory file, add an LLM provider, start the daemon, and switch Stigmergy
              on. The embedding runs on a local on-device model, so there is nothing to set up for it. You can
              skip the optional steps.
            </p>
          ) : null}

          {step === 'native' ? (
            ctx.nativeOk ? (
              <p>The database module matches this app. Nothing to do here.</p>
            ) : (
              <div>
                <p style={{ color: tokens.color.danger }}>The native database module needs a rebuild before Stigmergy can run.</p>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, background: tokens.color.bg, padding: tokens.space[2], borderRadius: tokens.radius.sm }}>
                  {friendlyError(substrateError ?? 'NODE_MODULE_VERSION mismatch')}
                </pre>
                <MutedText>Run the command, then restart the app. This step unlocks once the module loads.</MutedText>
              </div>
            )
          ) : null}

          {step === 'substrate' ? (
            <label style={{ display: 'block' }}>
              <MutedText>Memory file path (empty = the default ~/.stigmergy/pheromone.db)</MutedText>
              <input
                style={{ display: 'block', width: '100%', marginTop: tokens.space[1], padding: '4px 6px', background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}
                value={settings.substratePath}
                onChange={(e) => setSettings((s) => ({ ...s, substratePath: e.target.value }))}
                placeholder="~/.stigmergy/pheromone.db"
              />
            </label>
          ) : null}

          {step === 'provider' ? (
            <div>
              <MutedText style={{ display: 'block', marginBottom: tokens.space[2] }}>
                Add a provider, set its model, test the connection, and select it as active. You can skip this and add one later.
              </MutedText>
              <ProviderConfigEditor settings={settings} onChange={setSettings} />
            </div>
          ) : null}

          {step === 'daemon' ? (
            <div>
              <p>The Studio runs the daemon for you (no terminal). It embeds, names paths, and serves consult.</p>
              <div style={{ display: 'flex', gap: tokens.space[2], alignItems: 'center' }}>
                <Button
                  variant="primary"
                  disabled={daemon.running}
                  onClick={() => void window.studio.startDaemon().then(() => window.studio.daemonStatus().then(setDaemon))}
                >
                  {daemon.running ? 'Daemon running' : 'Start daemon'}
                </Button>
                <MutedText>
                  {daemon.running ? `pid ${daemon.pid ?? '?'}` : daemon.error ? `stopped (${daemon.error})` : 'not started'}
                </MutedText>
              </div>
              <MutedText style={{ display: 'block', marginTop: tokens.space[2] }}>
                You can skip this and run embedded (lighter, no semantic surfacing).
              </MutedText>
            </div>
          ) : null}

          {step === 'connect' ? <LoopConnect substratePath={substratePath} connectedProject={connectedProject} /> : null}

          {step === 'activate' ? (
            <div>
              <p>Switch Stigmergy on for your connected loop. The loop honors this shared flag.</p>
              <Button variant={enabled ? 'default' : 'primary'} onClick={() => onActivate(!enabled)}>
                {enabled ? 'Stigmergy is ON' : 'Activate Stigmergy'}
              </Button>
            </div>
          ) : null}
        </div>

        <footer style={{ display: 'flex', gap: tokens.space[2], alignItems: 'center', borderTop: `1px solid ${tokens.color.border}`, paddingTop: tokens.space[2] }}>
          {stepIndex(wiz) > 0 ? (
            <Button variant="default" onClick={() => setWiz((w) => back(w))}>Back</Button>
          ) : null}
          <div style={{ flex: 1 }} />
          {isSkippable(wiz) ? (
            <Button variant="default" onClick={() => setWiz((w) => skip(w))}>Skip</Button>
          ) : null}
          {onActivateStep ? (
            <Button variant="primary" disabled={busy || !canAdvance(wiz, ctx)} onClick={() => void finish()}>Finish</Button>
          ) : (
            <Button variant="primary" disabled={busy || !canAdvance(wiz, ctx)} onClick={() => void advance()}>Next</Button>
          )}
        </footer>
      </Card>
    </div>
  )
}
