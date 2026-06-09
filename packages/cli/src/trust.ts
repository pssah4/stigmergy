// Trust-architecture confirmation before any filesystem-changing command (FEAT-01-06
// SC-02, FEAT-02-06, ADR-07). The diff is shown, the default answer is No, the user opts in.
// The action distinguishes a write (init/restore/link) from a destructive recursive removal
// (uninstall), so the prompt never mislabels a delete as a write.

export type TrustAction = 'write' | 'remove'

export function renderTrustDiff(targets: readonly string[], action: TrustAction = 'write'): string {
  const lines =
    action === 'remove'
      ? ['Stigmergy will permanently remove (recursive):', ...targets.map((t) => `  ${t}`), '']
      : ['Stigmergy will write to:', ...targets.map((t) => `  ${t}`), '', 'Network behavior: local-only by default.']
  lines.push('Continue? [y/N]')
  return lines.join('\n')
}
