// Substrate path resolution (FEAT-03-01, FIX). Pure, so the monorepo vitest covers the precedence
// without loading Electron. The --substrate=<path> flag only reaches the app when Electron is run
// directly (the packaged app); in `electron-vite dev` the flag is consumed by electron-vite's own
// CLI parser and never reaches the app, so STIGMERGY_SUBSTRATE (an env var, inherited by the spawned
// Electron) is the dev-mode way to point at a non-default substrate. Settings may still override the
// result at startup (saveSettings, SC-02). Falls back to ~/.stigmergy/pheromone.db.
import { join } from 'node:path'

const FLAG = '--substrate='

export function resolveSubstratePath(argv: readonly string[], env: NodeJS.ProcessEnv, home: string): string {
  const flag = argv.find((a) => a.startsWith(FLAG))
  if (flag) {
    const value = flag.slice(FLAG.length)
    if (value.trim() !== '') return value
  }
  const fromEnv = env['STIGMERGY_SUBSTRATE']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return join(home, '.stigmergy', 'pheromone.db')
}
