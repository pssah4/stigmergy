import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveSubstratePath } from './substrate-path.js'

const HOME = '/home/op'
const DEFAULT = join(HOME, '.stigmergy', 'pheromone.db')

describe('resolveSubstratePath', () => {
  it('prefers the --substrate flag (packaged app, Electron run directly)', () => {
    expect(resolveSubstratePath(['electron', '--substrate=/a/b.db'], {}, HOME)).toBe('/a/b.db')
  })

  it('falls back to STIGMERGY_SUBSTRATE when there is no flag (dev mode)', () => {
    expect(resolveSubstratePath(['electron'], { STIGMERGY_SUBSTRATE: '/env/c.db' }, HOME)).toBe('/env/c.db')
  })

  it('prefers the flag over the env var when both are present', () => {
    expect(resolveSubstratePath(['--substrate=/a/b.db'], { STIGMERGY_SUBSTRATE: '/env/c.db' }, HOME)).toBe('/a/b.db')
  })

  it('ignores an empty flag value and an empty env var', () => {
    expect(resolveSubstratePath(['--substrate='], {}, HOME)).toBe(DEFAULT)
    expect(resolveSubstratePath([], { STIGMERGY_SUBSTRATE: '   ' }, HOME)).toBe(DEFAULT)
  })

  it('does not treat the space form (--substrate /path) as a flag value', () => {
    // Only the --substrate=<path> form is a flag; a separate token is not, so this falls through.
    expect(resolveSubstratePath(['--substrate', '/a/b.db'], {}, HOME)).toBe(DEFAULT)
    expect(resolveSubstratePath(['--substrate', '/a/b.db'], { STIGMERGY_SUBSTRATE: '/env/c.db' }, HOME)).toBe('/env/c.db')
  })

  it('defaults to ~/.stigmergy/pheromone.db with neither flag nor env', () => {
    expect(resolveSubstratePath([], {}, HOME)).toBe(DEFAULT)
  })
})
