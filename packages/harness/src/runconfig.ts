// Declarative run-config (FEAT-02-03 SC-04): ablation switches live in a file, not in
// code. A run-config names the workload file, the seed, and the variants to run; the
// CLI loads it and drives the sweep. Parsing is pure and validated so a malformed config
// fails fast with a clear message.
import type { Variant } from './runner.js'

export interface RunConfigFile {
  /** Path to the workload JSON, relative to the run-config or absolute. */
  workloadFile: string
  seed: number
  variants: Variant[]
  /** Wall-clock advance between tasks (ms); forwarded to the runner. */
  taskIntervalMs?: number
  callOverheadTokens?: number
}

export function parseRunConfig(raw: string): RunConfigFile {
  const c = JSON.parse(raw) as RunConfigFile
  if (typeof c.workloadFile !== 'string' || c.workloadFile.length === 0) throw new Error('run-config: missing workloadFile')
  if (typeof c.seed !== 'number' || !Number.isFinite(c.seed)) throw new Error('run-config: missing or non-numeric seed')
  if (!Array.isArray(c.variants) || c.variants.length === 0) throw new Error('run-config: no variants')
  const names = new Set<string>()
  for (const v of c.variants) {
    if (!v || typeof v.name !== 'string' || v.name.length === 0) throw new Error('run-config: variant missing name')
    // The name is interpolated into report filenames; reject path separators and '..' (CWE-22).
    if (/[/\\]/.test(v.name) || v.name.includes('..')) throw new Error(`run-config: variant name '${v.name}' must not contain path separators or '..'`)
    if (names.has(v.name)) throw new Error(`run-config: duplicate variant name '${v.name}'`)
    names.add(v.name)
    if (v.topK !== undefined && (!Number.isInteger(v.topK) || v.topK < 1)) {
      throw new Error(`run-config: variant '${v.name}' topK must be a positive integer when set`)
    }
    if (v.knobs !== undefined && (typeof v.knobs !== 'object' || v.knobs === null || Array.isArray(v.knobs))) {
      throw new Error(`run-config: variant '${v.name}' knobs must be an object`)
    }
  }
  return c
}
