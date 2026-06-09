// Reusable LLM-provider editor (FEAT-05-03, FEAT-05-05). Renders the provider cards (detail form,
// connection test, model discovery, active selection) over the FEAT-05-02 config model. Used by both the
// SettingsPanel and the OnboardingWizard, so the editing UI lives in one place. All edits go through the
// pure provider-settings reducer; the live test and model discovery go through IPC. NO model tiers.
// The embedding model is hard-wired to the local model (ADR-25, IMP-05-06-02), so there is no embedding
// picker here: only the LLM provider (path naming, capability augmentation) is configurable.
import { useState, type CSSProperties } from 'react'
import { PROVIDER_TYPES, type ProviderConfig, type StudioSettings } from '../shared/settings.js'
import { addProvider, updateProvider, removeProvider, setActiveProvider, canProbe } from '../shared/provider-settings.js'
import { Button, Card, Badge, MutedText } from './components.js'
import { tokens } from '../shared/design-tokens.js'
import type { ProviderTestResult } from '../shared/ipc.js'
import type { ProviderType, DiscoveredModel } from '@stigmergy/llm'

const fieldStyle: CSSProperties = { display: 'block', marginBottom: 10 }
const labelStyle: CSSProperties = { opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }
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
const autoSelect: CSSProperties = { ...inputStyle, width: 'auto', marginTop: 0 }

type FetchState = 'loading' | string | undefined

export function ProviderConfigEditor({
  settings,
  onChange,
}: {
  settings: StudioSettings
  onChange: (next: StudioSettings) => void
}): JSX.Element {
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult | { testing: true }>>({})
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({})
  const [fetchState, setFetchState] = useState<Record<string, FetchState>>({})
  const [newProviderType, setNewProviderType] = useState<ProviderType>('anthropic')

  async function runTest(p: ProviderConfig): Promise<void> {
    const guard = canProbe(p)
    if (!guard.ok) {
      setTestResults((r) => ({ ...r, [p.id]: { ok: false, error: guard.reason } }))
      return
    }
    setTestResults((r) => ({ ...r, [p.id]: { testing: true } }))
    const result = await window.studio.testProvider(p)
    setTestResults((r) => ({ ...r, [p.id]: result }))
  }

  async function fetchFor(p: ProviderConfig): Promise<void> {
    setFetchState((s) => ({ ...s, [p.id]: 'loading' }))
    const r = await window.studio.fetchModels({ type: p.type, apiKey: p.apiKey || undefined, baseUrl: p.baseUrl || undefined })
    if (r.ok) {
      setDiscovered((d) => ({ ...d, [p.id]: r.models }))
      setFetchState((s) => ({ ...s, [p.id]: undefined }))
    } else {
      setFetchState((s) => ({ ...s, [p.id]: r.error }))
    }
  }

  return (
    <div>
      <h3 style={{ fontSize: 13, marginBottom: 6 }}>LLM providers</h3>
      <MutedText style={{ display: 'block', marginBottom: 8 }}>
        Used for path naming and capability augmentation. The active provider drives naming and the daemon.
        The embedding runs on a local on-device model, so there is nothing to configure for it.
      </MutedText>
      {settings.providerConfigs.map((p) => {
        const result = testResults[p.id]
        const models = discovered[p.id]
        const fs = fetchState[p.id]
        return (
          <Card key={p.id} style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input
                type="radio"
                name="active-provider"
                checked={settings.activeProviderId === p.id}
                onChange={() => onChange(setActiveProvider(settings, p.id))}
              />
              <strong style={{ flex: 1 }}>{p.displayName || p.type}</strong>
              <Badge>{p.type}</Badge>
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Display name</span>
              <input style={inputStyle} value={p.displayName} onChange={(e) => onChange(updateProvider(settings, p.id, { displayName: e.target.value }))} placeholder={p.type} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Model</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <input style={{ ...inputStyle, flex: 1, marginTop: 0 }} value={p.model} onChange={(e) => onChange(updateProvider(settings, p.id, { model: e.target.value }))} placeholder="claude-haiku-4-5" />
                <Button variant="default" onClick={() => void fetchFor(p)}>{fs === 'loading' ? 'Fetching...' : 'Fetch models'}</Button>
              </div>
            </label>
            {models && models.length > 0 ? (
              <select style={{ ...inputStyle, marginBottom: 8 }} value="" onChange={(e) => e.target.value && onChange(updateProvider(settings, p.id, { model: e.target.value }))}>
                <option value="" disabled>{`Pick from ${models.length} fetched models`}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            ) : null}
            {typeof fs === 'string' && fs !== 'loading' ? <MutedText style={{ display: 'block', color: tokens.color.danger }}>{fs}</MutedText> : null}
            <label style={fieldStyle}>
              <span style={labelStyle}>API key</span>
              <input type="password" style={inputStyle} value={p.apiKey} onChange={(e) => onChange(updateProvider(settings, p.id, { apiKey: e.target.value }))} placeholder="sk-..." />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Base URL (optional)</span>
              <input style={inputStyle} value={p.baseUrl ?? ''} onChange={(e) => onChange(updateProvider(settings, p.id, { baseUrl: e.target.value }))} placeholder="http://localhost:11434" />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={p.enabled} onChange={(e) => onChange(updateProvider(settings, p.id, { enabled: e.target.checked }))} />
              <span>Enabled</span>
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button variant="default" onClick={() => void runTest(p)}>Test connection</Button>
              <Button variant="default" onClick={() => onChange(removeProvider(settings, p.id))}>Remove</Button>
              {result ? (
                'testing' in result ? (
                  <MutedText>Testing...</MutedText>
                ) : result.ok ? (
                  <span style={{ color: tokens.color.success, fontSize: 12 }}>OK{result.sample ? `: ${result.sample}` : ''}</span>
                ) : (
                  <span style={{ color: tokens.color.danger, fontSize: 12 }}>{result.error}</span>
                )
              ) : null}
            </div>
          </Card>
        )
      })}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
        <select style={autoSelect} value={newProviderType} onChange={(e) => setNewProviderType(e.target.value as ProviderType)}>
          {PROVIDER_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <Button variant="primary" onClick={() => onChange(addProvider(settings, newProviderType))}>Add provider</Button>
      </div>
    </div>
  )
}
