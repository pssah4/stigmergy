// Minimal subcommand plus flag parser (FEAT-01-06). No external dependency: the surface
// is a single subcommand, positional arguments, `--flag value`, `--flag=value`, and boolean
// `--flag`. Known boolean flags (passed by the caller) never consume the following token.

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: readonly string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const [command = '', ...rest] = argv
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        // --key=value
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const key = body
      if (booleanFlags.has(key)) {
        // A known switch never swallows the next token.
        flags[key] = true
        continue
      }
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(token)
    }
  }
  return { command, positionals, flags }
}

/** Read a flag as a string, or undefined if absent or boolean. */
export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}
