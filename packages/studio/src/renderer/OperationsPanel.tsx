// Memory operations panel (FEAT-03-04, relabelled + decoupled in FEAT-03-08). Numbers, backup,
// restore, portable workflow export/import (generic, no Vault Operator branding), and a guarded
// reset. Labels from labels.ts; reset requires typing DELETE.
import { useState, type CSSProperties } from 'react'
import type { SubstrateSnapshot } from '../shared/graph-model.js'
import type { OpResult } from '../shared/ipc.js'
import { computeStats, isResetConfirmation } from '../shared/substrate-ops.js'
import { LABELS } from '../shared/labels.js'
import { tokens } from '../shared/design-tokens.js'

const panelStyle: CSSProperties = {
  width: 340,
  flexShrink: 0,
  borderLeft: `1px solid ${tokens.color.border}`,
  padding: '16px 18px',
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
}
const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}
const sectionStyle: CSSProperties = { marginBottom: 18, borderBottom: `1px solid ${tokens.color.border}`, paddingBottom: 14 }
const headingStyle: CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7, marginTop: 0 }

export function OperationsPanel({ snapshot }: { snapshot: SubstrateSnapshot }): JSX.Element {
  const stats = computeStats(snapshot)
  const pinnedPaths = snapshot.pinnedPaths ?? []
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [resetInput, setResetInput] = useState('')

  function report(result: OpResult): void {
    if (result.ok) setMessage(result.message ?? 'Done.')
    else if (result.canceled) setMessage('Cancelled.')
    else setMessage(`Error: ${result.error ?? 'unknown'}`)
  }

  async function run(op: () => Promise<OpResult>): Promise<void> {
    setMessage(undefined)
    report(await op())
  }

  const resetArmed = isResetConfirmation(resetInput)

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: 15, marginTop: 0 }} title={LABELS.navSubstrate.tooltip}>
        {LABELS.navSubstrate.label}
      </h2>
      <p style={{ opacity: 0.6, fontSize: 12, marginTop: 0 }}>
        Memory is the whole learned substrate: every tool, every learned transition and its strength, in one local file. Back it up, restore, or reset it here. Your individual pinned workflows are the <strong>Saved paths</strong> on the Graph tab, a small, deliberate subset of this memory.
      </p>

      <section style={sectionStyle}>
        <h3 style={headingStyle}>{LABELS.stats.label}</h3>
        <div title={LABELS.capabilities.tooltip}>{LABELS.capabilities.label}: {stats.capabilities}</div>
        <div title={LABELS.paths.tooltip}>{LABELS.paths.label}: {stats.edges}</div>
        <div title={LABELS.tasks.tooltip}>{LABELS.tasks.label}: {stats.tasks}</div>
        <div>{LABELS.pinnedPathsCount.label}: {stats.pinnedPaths}</div>
        <div>{LABELS.avgStrength.label}: {stats.avgPheromone.toFixed(3)}</div>
      </section>

      <section style={sectionStyle}>
        <h3 style={headingStyle}>Backup</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={buttonStyle} onClick={() => void run(() => window.studio.backup())}>
            {LABELS.backup.label}
          </button>
          <button
            style={buttonStyle}
            onClick={() => {
              if (confirm('Restore overwrites the current memory. Continue?')) void run(() => window.studio.restore())
            }}
          >
            {LABELS.restore.label}
          </button>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={headingStyle}>Workflows</h3>
        {pinnedPaths.length === 0 ? (
          <div style={{ opacity: 0.5 }}>No saved paths to export.</div>
        ) : (
          pinnedPaths.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4, alignItems: 'baseline' }}>
              <span style={{ wordBreak: 'break-word', flex: 1 }}>{p.name || p.id}</span>
              <button style={buttonStyle} onClick={() => void run(() => window.studio.exportWorkflow(p.id))}>
                {LABELS.exportWorkflow.label}
              </button>
            </div>
          ))
        )}
        <button style={{ ...buttonStyle, marginTop: 8 }} onClick={() => void run(() => window.studio.importWorkflow())}>
          {LABELS.importWorkflow.label}
        </button>
      </section>

      <section style={{ marginBottom: 12 }}>
        <h3 style={headingStyle} title={LABELS.reset.tooltip}>
          {LABELS.reset.label}
        </h3>
        <p style={{ opacity: 0.6, fontSize: 12 }}>Resets everything learned. Type DELETE to confirm.</p>
        <input
          value={resetInput}
          onChange={(e) => setResetInput(e.target.value)}
          placeholder="DELETE"
          style={{ width: 120, padding: '4px 6px', background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm, marginRight: 8 }}
        />
        <button
          style={{
            ...buttonStyle,
            background: resetArmed ? tokens.color.danger : tokens.color.surfaceRaised,
            color: resetArmed ? tokens.color.bg : tokens.color.text,
            opacity: resetArmed ? 1 : 0.5,
            cursor: resetArmed ? 'pointer' : 'not-allowed',
          }}
          disabled={!resetArmed}
          onClick={() => {
            void run(() => window.studio.reset())
            setResetInput('')
          }}
        >
          {LABELS.reset.label}
        </button>
      </section>

      {message ? <div style={{ fontSize: 12 }}>{message}</div> : null}
    </aside>
  )
}
