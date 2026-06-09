import { describe, it, expect } from 'vitest'
import { defaultSettings, type StudioSettings } from './settings.js'
import { addProvider, updateProvider, removeProvider, setActiveProvider, canProbe } from './provider-settings.js'

describe('provider editing reducer (FEAT-05-03)', () => {
  it('addProvider appends, gives a stable id, and makes the first one active (SC-01)', () => {
    const s1 = addProvider(defaultSettings, 'anthropic')
    expect(s1.providerConfigs).toHaveLength(1)
    expect(s1.providerConfigs[0].id).toBe('p1')
    expect(s1.providerConfigs[0].type).toBe('anthropic')
    expect(s1.providerConfigs[0].enabled).toBe(true)
    expect(s1.activeProviderId).toBe('p1')
    // a second provider does not steal the active pointer and gets a fresh id
    const s2 = addProvider(s1, 'openai')
    expect(s2.providerConfigs.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(s2.activeProviderId).toBe('p1')
  })

  it('updateProvider patches the matching entry only', () => {
    const s = addProvider(defaultSettings, 'anthropic')
    const u = updateProvider(s, 'p1', { model: 'claude-x', apiKey: 'k' })
    expect(u.providerConfigs[0].model).toBe('claude-x')
    expect(u.providerConfigs[0].apiKey).toBe('k')
  })

  it('setActiveProvider and removeProvider maintain the active pointer (SC-01)', () => {
    let s = addProvider(defaultSettings, 'anthropic')
    s = addProvider(s, 'openai')
    s = setActiveProvider(s, 'p2')
    expect(s.activeProviderId).toBe('p2')
    // removing the active provider nulls the pointer
    s = removeProvider(s, 'p2')
    expect(s.providerConfigs.map((p) => p.id)).toEqual(['p1'])
    expect(s.activeProviderId).toBeNull()
  })

  // The embedding-model reducers were removed with IMP-05-06-02 (embedding hard-wired local); no test.
})

describe('canProbe guard (FEAT-05-03 SC-03)', () => {
  it('requires a model', () => {
    const r = canProbe({ id: 'p1', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'k', model: '' })
    expect(r.ok).toBe(false)
  })

  it('requires an API key for a remote provider but not for a local one', () => {
    expect(canProbe({ id: 'p1', type: 'anthropic', displayName: 'A', enabled: true, apiKey: '', model: 'm' }).ok).toBe(false)
    expect(canProbe({ id: 'p1', type: 'ollama', displayName: 'O', enabled: true, apiKey: '', model: 'm' }).ok).toBe(true)
    expect(canProbe({ id: 'p1', type: 'anthropic', displayName: 'A', enabled: true, apiKey: 'k', model: 'm' }).ok).toBe(true)
  })
})
