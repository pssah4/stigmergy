// App status bar (FEAT-06-08): the full-width bottom strip of the Studio shell. Always-visible app
// chrome carrying the live counts, the memory-file path, the daemon health, and any current error,
// promoted out of the old floating header / deep Settings so they are legible at a glance.
import { useEffect, useState } from 'react'
import { tokens } from '../shared/design-tokens.js'
import { friendlyError } from '../shared/friendly-error.js'
import { LABELS } from '../shared/labels.js'
import type { DaemonStatus } from '../shared/ipc.js'

export function StatusBar({
  capabilityCount,
  pathCount,
  substratePath,
  error,
  editError,
}: {
  capabilityCount: number
  pathCount: number
  substratePath: string
  /** Standing substrate/read error (mapped to a friendly message). */
  error?: string
  /** Transient, user-triggered edit-command error; shown raw in its own cell so it is never masked by
   * a standing substrate error (FEAT-06-08 review). */
  editError?: string
}): JSX.Element {
  const [daemon, setDaemon] = useState<DaemonStatus>({ running: false })
  useEffect(() => {
    let active = true
    const tick = (): void => void window.studio.daemonStatus().then((s) => active && setDaemon(s))
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const cell = { display: 'inline-flex', alignItems: 'center', gap: tokens.space[1] } as const
  return (
    <footer
      style={{
        height: tokens.layout.statusBar,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.space[3],
        padding: `0 ${tokens.space[3]}px`,
        background: tokens.color.surface,
        borderTop: `1px solid ${tokens.color.border}`,
        fontSize: tokens.font.size.sm,
        color: tokens.color.textMuted,
      }}
    >
      <span style={cell}>
        {capabilityCount} {LABELS.capabilities.label.toLowerCase()}, {pathCount} {LABELS.paths.label.toLowerCase()}
      </span>
      {substratePath ? (
        <span style={{ ...cell, flex: 1, minWidth: 0, overflow: 'hidden' }} title={substratePath}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{substratePath}</span>
        </span>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      {editError ? <span style={{ ...cell, color: tokens.color.danger }}>edit error: {editError}</span> : null}
      {error ? <span style={{ ...cell, color: tokens.color.danger }}>{friendlyError(error)}</span> : null}
      <span
        style={{ ...cell, maxWidth: 380, minWidth: 0, color: !daemon.running && daemon.error ? tokens.color.warn : undefined }}
        title={daemon.error ?? (daemon.running ? 'The daemon is running' : 'The daemon is not running')}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: daemon.running ? tokens.color.success : daemon.error ? tokens.color.warn : tokens.color.textMuted,
            boxShadow: daemon.running ? `0 0 6px ${tokens.color.success}` : undefined,
          }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {daemon.running ? 'daemon running' : daemon.error ? `daemon: ${daemon.error}` : 'daemon stopped'}
        </span>
      </span>
    </footer>
  )
}
