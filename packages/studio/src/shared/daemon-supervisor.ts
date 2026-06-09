// Daemon supervision policy (FEAT-04-09 P1-5). Pure decisions the Studio main process uses to keep a
// spawned daemon alive: when to respawn after an exit, how long to back off, and a rolling log tail so
// the operator can see why it died (the daemon's stdout/stderr is otherwise discarded). No Electron or
// process import, so the monorepo vitest covers the policy; the actual spawn/pipe wiring lives in main.

export interface RestartPolicy {
  /** Max consecutive crash-restarts before giving up (and surfacing the error). */
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 10_000 }

/** Exponential backoff for the 0-based restart attempt, capped at maxDelayMs. */
export function restartDelayMs(attempt: number, policy: RestartPolicy = DEFAULT_RESTART_POLICY): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt)
  return Math.min(exp, policy.maxDelayMs)
}

/** Exit codes the daemon uses for a definitive refusal, NOT a transient crash: 2 = bad arguments,
 * 4 = another daemon already owns this substrate (the role lock). Restarting cannot fix either, so a
 * supervisor must not retry them (that just spams "another daemon owns this substrate"). */
export const TERMINAL_EXIT_CODES: readonly number[] = [2, 4]

/** Whether to respawn the daemon after it exits: never when the operator stopped it, never on a clean
 * exit (code 0), never on a terminal/refusal code (a restart cannot help), and otherwise only while
 * crash-restart retries remain. */
export function shouldRestart(opts: { intentional: boolean; code: number | null; attempt: number; policy?: RestartPolicy }): boolean {
  const policy = opts.policy ?? DEFAULT_RESTART_POLICY
  if (opts.intentional) return false
  if (opts.code === 0) return false
  if (opts.code !== null && TERMINAL_EXIT_CODES.includes(opts.code)) return false
  return opts.attempt < policy.maxRetries
}

/** Append daemon output to a rolling buffer capped at `max` lines (blank lines dropped); the tail is
 * what the operator sees in the daemon status. */
export function appendLogLines(buffer: readonly string[], chunk: string, max = 200): string[] {
  const lines = chunk.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return [...buffer]
  const next = [...buffer, ...lines]
  return next.length > max ? next.slice(next.length - max) : next
}
