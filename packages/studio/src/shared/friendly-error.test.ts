import { describe, it, expect } from 'vitest'
import { friendlyError, isNativeRebuildError } from './friendly-error.js'

describe('friendlyError (SC-07)', () => {
  it('turns the native-module ABI mismatch into a concrete rebuild instruction', () => {
    const raw =
      "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 125."
    const msg = friendlyError(raw)
    expect(msg).toMatch(/rebuild:electron/)
    expect(msg).not.toContain('NODE_MODULE_VERSION') // the cryptic text is replaced
  })

  it('explains a missing memory file', () => {
    expect(friendlyError('Substrate not found at /home/x/.stigmergy/pheromone.db')).toMatch(/stigmergy init|Settings/)
    expect(friendlyError('unable to open database file')).toMatch(/stigmergy init|Settings/)
  })

  it('passes through an unknown error unchanged', () => {
    expect(friendlyError('some other failure')).toBe('some other failure')
  })

  it('isNativeRebuildError flags only the ABI mismatch (FEAT-05-05 onboarding gate)', () => {
    expect(isNativeRebuildError('NODE_MODULE_VERSION 141 ... requires 125')).toBe(true)
    expect(isNativeRebuildError('Substrate not found at /x')).toBe(false)
    expect(isNativeRebuildError('')).toBe(false)
  })
})
