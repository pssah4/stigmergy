// Shared "connect your loop" panel (IMP-05-05-02). The intuitive, non-dev path: point at the loop
// project folder, then copy the generated coding-agent prompt (and the daemon start command) into your
// coding agent (Claude Code, Cursor, ...), which does the wiring. Used by BOTH the onboarding wizard's
// connect step and the rail "Connect Loop" view, so the experience is identical. Reuses the FEAT-04-10
// connect-adapter builders; no deploy/snippet-mode toggles.
import { useState, type CSSProperties } from 'react'
import { Button, MutedText } from './components.js'
import { tokens } from '../shared/design-tokens.js'
import { buildDaemonClientAgentPrompt, buildDaemonStartCommand } from '../shared/connect-adapter.js'
import type { FrameworkDetection } from '@stigmergy/connect'

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: tokens.space[1],
  padding: '4px 6px',
  background: tokens.color.bg,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
}
const preStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 11,
  background: tokens.color.bg,
  padding: tokens.space[2],
  borderRadius: tokens.radius.sm,
}

export function LoopConnect({ substratePath, connectedProject }: { substratePath: string; connectedProject: string }): JSX.Element {
  const [dir, setDir] = useState(connectedProject || '')
  const [detection, setDetection] = useState<FrameworkDetection | null>(null)
  const [busy, setBusy] = useState(false)

  const socketPath = substratePath ? `${substratePath}.daemon.sock` : ''
  const agentPrompt = detection ? buildDaemonClientAgentPrompt(detection, socketPath) : ''
  const startCmd = buildDaemonStartCommand(substratePath, socketPath)

  async function generate(): Promise<void> {
    if (dir.trim() === '') return
    setBusy(true)
    try {
      const det = await window.studio.detectFramework(dir.trim())
      setDetection(det)
      await window.studio.markConnected(dir.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ lineHeight: 1.6 }}>
      <p style={{ marginTop: 0 }}>
        Wire Stigmergy into your agent loop. You do not need to write code: point at your loop project,
        then paste the generated prompt into your coding agent (Claude Code, Cursor, ...). It does the wiring.
      </p>
      <label style={{ display: 'block', marginBottom: tokens.space[2] }}>
        <MutedText>Your loop project folder</MutedText>
        <input style={inputStyle} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/your/agent-loop" />
      </label>
      <Button variant="primary" disabled={busy || dir.trim() === ''} onClick={() => void generate()}>
        {busy ? 'Generating...' : 'Generate setup'}
      </Button>
      {connectedProject ? (
        <MutedText style={{ display: 'block', marginTop: tokens.space[1], color: tokens.color.success }}>Connected: {connectedProject}</MutedText>
      ) : null}
      {detection ? (
        <div style={{ marginTop: tokens.space[2] }}>
          <MutedText style={{ display: 'block' }}>1. Start the daemon (Studio does this for you); it listens on:</MutedText>
          <pre style={preStyle}>{startCmd}</pre>
          <div style={{ display: 'flex', gap: tokens.space[2], alignItems: 'center' }}>
            <MutedText style={{ flex: 1 }}>2. Paste this into your coding agent to wire the loop:</MutedText>
            <Button variant="default" onClick={() => void navigator.clipboard?.writeText(agentPrompt)}>Copy prompt</Button>
          </div>
          <pre style={{ ...preStyle, maxHeight: 220, overflowY: 'auto' }}>{agentPrompt}</pre>
          <MutedText style={{ display: 'block' }}>Once your loop runs one task, the map fills.</MutedText>
        </div>
      ) : null}
    </div>
  )
}
