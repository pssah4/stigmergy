// Settings panel (FEAT-03-05). Loads the persisted settings, edits them locally, validates on every
// change (validateSettings, SC-05), and saves through the main process which persists them (SC-01)
// and re-connects the poll on a substrate-path change (SC-02). The daemon mode (SC-03/04) is shown
// as a deferred hint (ADR-12).
import { useEffect, useState, type CSSProperties } from 'react'
import {
  defaultSettings,
  validateSettings,
  mergeSettings,
  EXPLORATION_POLICIES,
  type StudioSettings,
  type ExplorationPolicy,
} from '../shared/settings.js'
import { ProviderConfigEditor } from './ProviderConfigEditor.js'
import { LoopConnect } from './LoopConnect.js'
import { LABELS } from '../shared/labels.js'
import { tokens } from '../shared/design-tokens.js'
import type { DaemonStatus } from '../shared/ipc.js'

const panelStyle: CSSProperties = {
  width: 360,
  flexShrink: 0,
  borderLeft: `1px solid ${tokens.color.border}`,
  padding: '16px 18px',
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
}
const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}
const fieldStyle: CSSProperties = { display: 'block', marginBottom: 10 }
const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '4px 6px',
  background: tokens.color.bg,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
}
const labelStyle: CSSProperties = { opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }

// VO-style settings layout (FEAT-06-04): a persistent status/daemon header, an underline tab bar that
// splits the editable settings into focused groups, and a persistent Save footer, instead of one long
// scroll. Mirrors Vault Operator's agent-settings-nav (tabs with an accent underline on the active one).
// 'connection' folds the former rail "Connect loop" destination in here (FEAT-06-08): wiring the loop is
// one-time setup, so it belongs next to provider/workspace/daemon setup, not as a top-level rail item.
type SettingsTab = 'connection' | 'providers' | 'workspace' | 'behavior'
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'providers', label: 'LLM provider' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'behavior', label: 'Behavior' },
]
const navStyle: CSSProperties = { display: 'flex', gap: 2, borderBottom: `1px solid ${tokens.color.border}`, margin: '14px 0 16px' }
function tabBtnStyle(active: boolean): CSSProperties {
  return {
    padding: '5px 12px',
    background: 'transparent',
    border: 'none',
    borderBottom: `2px solid ${active ? tokens.color.accent : 'transparent'}`,
    color: active ? tokens.color.text : tokens.color.textMuted,
    fontSize: 13,
    fontWeight: active ? 500 : 400,
    cursor: 'pointer',
    marginBottom: -1,
    borderRadius: '4px 4px 0 0',
  }
}

export function SettingsPanel({
  enabled,
  onSetEnabled,
  onRerunOnboarding,
  substratePath,
  connectedProject,
  initialTab,
}: {
  enabled: boolean
  onSetEnabled: (enabled: boolean) => void
  onRerunOnboarding: () => void
  substratePath: string
  connectedProject: string
  /** Deep-link a specific tab (e.g. the onboarding "connect" nudge opens Connection). */
  initialTab?: SettingsTab
}): JSX.Element {
  const [settings, setSettings] = useState<StudioSettings>(defaultSettings)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [daemon, setDaemon] = useState<DaemonStatus>({ running: false })
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'providers')

  // Follow an external deep-link (e.g. Welcome's connect nudge opens the Connection tab).
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    void window.studio.getSettings().then(setSettings)
  }, [])

  // Poll the daemon status so the Start/Stop control reflects reality (FEAT-04-04).
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

  const errors = validateSettings(settings)

  function update<K extends keyof StudioSettings>(key: K, value: StudioSettings[K]): void {
    setSettings((s) => ({ ...s, [key]: value }))
    setMessage(undefined)
  }

  async function save(): Promise<void> {
    const result = await window.studio.saveSettings(settings)
    setMessage(result.ok ? 'Saved. A memory-path change takes effect immediately.' : `Error: ${result.errors.join('; ')}`)
  }

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>{LABELS.navSettings.label}</h2>

      <button style={{ ...buttonStyle, marginBottom: 12 }} title="Re-open the guided first-run setup wizard" onClick={onRerunOnboarding}>
        Re-run setup wizard
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 12, background: tokens.color.bg, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}>
        <button
          onClick={() => onSetEnabled(!enabled)}
          title="Activate or deactivate Stigmergy for the connected loop"
          style={{
            padding: '4px 12px',
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: enabled ? tokens.color.success : tokens.color.surfaceRaised,
            color: enabled ? tokens.color.bg : tokens.color.text,
            cursor: 'pointer',
          }}
        >
          {enabled ? 'Stigmergy is ON' : 'Stigmergy is OFF'}
        </button>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{enabled ? 'Click to deactivate' : 'Click to activate for your loop'}</span>
      </div>

      <div style={{ padding: '8px 10px', marginBottom: 12, background: tokens.color.bg, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => {
              const action = daemon.running ? window.studio.stopDaemon() : window.studio.startDaemon()
              void action.then(() => window.studio.daemonStatus().then(setDaemon))
            }}
            title="Start or stop the naming-and-consult daemon (no terminal needed)"
            style={{
              padding: '4px 12px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              background: daemon.running ? tokens.color.success : tokens.color.surfaceRaised,
              color: daemon.running ? tokens.color.bg : tokens.color.text,
              cursor: 'pointer',
            }}
          >
            {daemon.running ? 'Daemon running' : 'Start daemon'}
          </button>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {daemon.running
              ? `pid ${daemon.pid ?? '?'}${daemon.restarts ? `, ${daemon.restarts} restart(s)` : ''}, click to stop`
              : daemon.error
                ? `stopped (${daemon.error})`
                : 'auto-names explored paths'}
          </span>
        </div>
        {daemon.recentLog && daemon.recentLog.length > 0 ? (
          // Full recent tail (already capped at 20 in the main process), so the RPC activity trace
          // (consult / emit / register) is readable when diagnosing why no edges form (IMP-04-04-01).
          <pre style={{ marginTop: 8, marginBottom: 0, maxHeight: 180, overflowY: 'auto', fontSize: 10, opacity: 0.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {daemon.recentLog.join('\n')}
          </pre>
        ) : null}
      </div>

      <nav style={navStyle}>
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} style={tabBtnStyle(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'connection' ? (
        <>
          <p style={{ opacity: 0.6, fontSize: 12, marginTop: 0 }}>{LABELS.navConnect.tooltip}</p>
          <LoopConnect substratePath={substratePath} connectedProject={connectedProject} />
        </>
      ) : null}

      {tab === 'providers' ? (
        <>
          <ProviderConfigEditor settings={settings} onChange={(next) => { setSettings(next); setMessage(undefined) }} />
          <button
            style={{ ...buttonStyle, marginBottom: 12, alignSelf: 'flex-start' }}
            title="Prefill the model fields from the connected project's .stigmergy/models.json (no secrets)"
            onClick={() => {
              void window.studio.importModels().then((imported) => {
                if (Object.keys(imported).length === 0) {
                  setMessage('No model config found in the connected project.')
                  return
                }
                setSettings((s) => mergeSettings({ ...s, ...imported }))
                setMessage('Imported model config from the connected project. Review and save.')
              })
            }}
          >
            Import models from agent
          </button>
        </>
      ) : null}

      {tab === 'workspace' ? (
        <>
          <label style={fieldStyle}>
            <span style={labelStyle} title={LABELS.substratePathField.tooltip}>{LABELS.substratePathField.label}</span>
            <input style={inputStyle} value={settings.substratePath} onChange={(e) => update('substratePath', e.target.value)} placeholder="~/.stigmergy/pheromone.db" />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle} title={LABELS.workflowRootField.tooltip}>{LABELS.workflowRootField.label}</span>
            <input style={inputStyle} value={settings.workflowRoot} onChange={(e) => update('workflowRoot', e.target.value)} placeholder="/path/to/workflows" />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle} title={LABELS.skillRootField.tooltip}>{LABELS.skillRootField.label}</span>
            <input style={inputStyle} value={settings.skillRoot} onChange={(e) => update('skillRoot', e.target.value)} placeholder="/path/to/skills" />
          </label>
        </>
      ) : null}

      {tab === 'behavior' ? (
        <>
          <label style={fieldStyle}>
            <span style={labelStyle} title={LABELS.decayHalfLife.tooltip}>{LABELS.decayHalfLife.label}</span>
            <input style={inputStyle} type="number" value={settings.decayHalfLifeHours} onChange={(e) => update('decayHalfLifeHours', Number(e.target.value))} />
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ ...fieldStyle, flex: 1 }}>
              <span style={labelStyle} title={LABELS.tauMin.tooltip}>{LABELS.tauMin.label}</span>
              <input style={inputStyle} type="number" step={0.01} value={settings.tauMin} onChange={(e) => update('tauMin', Number(e.target.value))} />
            </label>
            <label style={{ ...fieldStyle, flex: 1 }}>
              <span style={labelStyle} title={LABELS.tauMax.tooltip}>{LABELS.tauMax.label}</span>
              <input style={inputStyle} type="number" step={0.01} value={settings.tauMax} onChange={(e) => update('tauMax', Number(e.target.value))} />
            </label>
          </div>
          <label style={fieldStyle}>
            <span style={labelStyle} title={LABELS.explorationPolicy.tooltip}>{LABELS.explorationPolicy.label}</span>
            <select style={inputStyle} value={settings.explorationPolicy} onChange={(e) => update('explorationPolicy', e.target.value as ExplorationPolicy)}>
              {EXPLORATION_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }} title={LABELS.heterogeneousEvaluator.tooltip}>
            <input type="checkbox" checked={settings.heterogeneousEvaluator} onChange={(e) => update('heterogeneousEvaluator', e.target.checked)} />
            <span>{LABELS.heterogeneousEvaluator.label}</span>
          </label>
        </>
      ) : null}

      {tab !== 'connection' ? (
        <>
          {errors.length > 0 ? (
            <ul style={{ color: tokens.color.danger, fontSize: 12, margin: '0 0 10px', paddingLeft: 18 }}>
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}

          <button
            style={{ ...buttonStyle, opacity: errors.length === 0 ? 1 : 0.4, cursor: errors.length === 0 ? 'pointer' : 'not-allowed' }}
            disabled={errors.length > 0}
            onClick={() => void save()}
          >
            Save
          </button>
          {message ? <div style={{ marginTop: 10, fontSize: 12 }}>{message}</div> : null}
        </>
      ) : null}

      <hr style={{ border: 'none', borderTop: `1px solid ${tokens.color.border}`, margin: '16px 0' }} />
      <h3 style={{ fontSize: 13, opacity: 0.7 }}>Daemon mode</h3>
      <div style={{ opacity: 0.5, fontSize: 12 }}>
        Deferred (ADR-12). The MVP is single-writer-at-a-time: the Studio reads and edits embedded over WAL.
      </div>
    </aside>
  )
}
