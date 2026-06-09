import { describe, it, expect } from 'vitest'
import { BUILTIN_INTEGRATIONS, findIntegration, resolveWorkflowDir } from './integrations.js'

describe('integration registry (SC-02)', () => {
  it('carries Vault Operator as one optional named integration, not a baked-in default', () => {
    const vo = findIntegration('vault-operator')
    expect(vo?.name).toBe('Vault Operator')
    expect(vo?.subdir).toBe('.vault-operator/workflows')
    expect(vo?.hint?.snippet).toContain('@stigmergy')
    // It is one entry among (future) many, not privileged.
    expect(BUILTIN_INTEGRATIONS.some((i) => i.id === 'vault-operator')).toBe(true)
  })

  it('findIntegration returns undefined for an unknown or missing id', () => {
    expect(findIntegration('nope')).toBeUndefined()
    expect(findIntegration(undefined)).toBeUndefined()
  })
})

describe('resolveWorkflowDir', () => {
  it('returns the workflow root itself when no integration is chosen (generic export)', () => {
    expect(resolveWorkflowDir('/w', undefined)).toBe('/w')
  })

  it('appends the integration subdir when one is chosen', () => {
    expect(resolveWorkflowDir('/w', 'vault-operator')).toBe('/w/.vault-operator/workflows')
    expect(resolveWorkflowDir('/w/', 'vault-operator')).toBe('/w/.vault-operator/workflows') // trailing slash trimmed
  })

  it('falls back to the root for an unknown integration', () => {
    expect(resolveWorkflowDir('/w', 'nope')).toBe('/w')
  })

  it('returns empty for an empty root, so the caller lets the user pick a directory', () => {
    expect(resolveWorkflowDir('', 'vault-operator')).toBe('')
    expect(resolveWorkflowDir('   ', undefined)).toBe('')
  })
})
