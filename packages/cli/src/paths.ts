// Substrate path resolution and the compact path-expression syntax (FEAT-01-06).
import { homedir } from 'node:os'
import { join, resolve, parse } from 'node:path'

/** Default substrate location: ~/.stigmergy/pheromone.db (platform homedir). */
export function defaultSubstratePath(): string {
  return join(homedir(), '.stigmergy', 'pheromone.db')
}

/** Default embedding-model cache location: ~/.stigmergy/models (removed by `uninstall --purge`). */
export function defaultCachePath(): string {
  return join(homedir(), '.stigmergy', 'models')
}

/** True if a path resolves to the filesystem root or the home directory (FEAT-02-06 audit L-1).
 * uninstall refuses to recursively remove these, so a --path/--cache typo cannot wipe the disk
 * or the home directory even if the operator confirms the prompt. */
export function isProtectedPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === parse(resolved).root || resolved === resolve(homedir())
}

/** Parse `tool:a -> tool:b -> tool:c` into ['tool:a','tool:b','tool:c']. Whitespace is ignored. */
export function parsePathExpression(expr: string): string[] {
  const parts = expr
    .split('->')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts
}
