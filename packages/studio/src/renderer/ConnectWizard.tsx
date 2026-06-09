// Guided "Connect your agent loop" wizard (FEAT-03-08, SC-05). Four steps driven by the pure
// connect-wizard reducer: pick the loop project folder, detect the framework, insert the snippet
// (optionally write the adapter file with a diff confirm), then verify live-green by watching the
// substrate. Replaces the old ad-hoc ConnectPanel. Plain English; the wizard teaches the model
// (a dev wires the loop once; Stigmergy only observes).
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { FrameworkDetection } from '@stigmergy/connect'
import type { SubstrateSnapshot } from '../shared/graph-model.js'
import { probeActivity, compareActivity, type ActivityProbe } from '../shared/connect-verify.js'
import {
  buildAdapterFile,
  buildAgentPrompt,
  buildSetupPreamble,
  buildDaemonStartCommand,
  buildDaemonClientRecipe,
  buildDaemonClientAgentPrompt,
} from '../shared/connect-adapter.js'
import {
  initialWizardState,
  setDir,
  markDetected,
  startListening,
  canAdvance,
  next as nextStep,
  back as backStep,
  stepIndex,
  WIZARD_STEPS,
  type WizardState,
} from '../shared/connect-wizard.js'
import { tokens } from '../shared/design-tokens.js'

const panelStyle: CSSProperties = {
  width: 360,
  flexShrink: 0,
  borderLeft: `1px solid ${tokens.color.border}`,
  padding: '16px 18px',
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
}
const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surfaceRaised,
  color: tokens.color.text,
  cursor: 'pointer',
}
const codeStyle: CSSProperties = {
  background: tokens.color.bg,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  padding: '8px 10px',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: '6px 0',
}
const STEP_TITLES = ['1. Project', '2. Framework', '3. Snippet', '4. Verify']

export function ConnectWizard({ snapshot, substratePath }: { snapshot: SubstrateSnapshot; substratePath: string }): JSX.Element {
  const [state, setState] = useState<WizardState>(initialWizardState)
  const [detection, setDetection] = useState<FrameworkDetection | null>(null)
  const [adapterPreview, setAdapterPreview] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<ActivityProbe | null>(null)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [snippetMode, setSnippetMode] = useState<'self' | 'agent'>('self')
  // Deployment model: 'daemon' = Stigmergy runs as an external daemon and the loop is a thin client
  // (works for any loop incl. sandboxed hosts like Obsidian; the recommended default). 'embedded' =
  // the loop builds its own engine in-process (Node hosts only).
  const [deployMode, setDeployMode] = useState<'daemon' | 'embedded'>('daemon')
  // Default the daemon socket to the path the Studio-managed daemon actually binds
  // (`<substrate>.daemon.sock`), so the generated recipe matches the "Start daemon" button without the
  // operator reconciling paths. The operator can still override it (e.g. a manually-started daemon).
  const [socketPath, setSocketPath] = useState('~/.stigmergy/stigmergy.sock')
  const [socketEdited, setSocketEdited] = useState(false)
  useEffect(() => {
    if (!socketEdited) setSocketPath(substratePath ? `${substratePath}.daemon.sock` : '~/.stigmergy/stigmergy.sock')
  }, [substratePath, socketEdited])
  const [savedProject, setSavedProject] = useState('')
  const [connected, setConnected] = useState(false)

  function copy(text: string): void {
    void navigator.clipboard?.writeText(text)
    setMessage('Copied to clipboard.')
  }

  // On open, pre-fill the project from the persisted connection so a returning user need not re-enter it.
  useEffect(() => {
    void window.studio.getSettings().then((s) => {
      if (s.connectedProject) {
        setSavedProject(s.connectedProject)
        setState((st) => setDir(st, s.connectedProject))
      }
    })
  }, [])

  // The full copy-paste recipe: the engine construction the framework snippet leaves out, then the
  // snippet itself. Pointed at the substrate the Studio reads, so the loop writes where we look.
  const recipe = useMemo(
    () =>
      deployMode === 'daemon'
        ? buildDaemonClientRecipe(socketPath)
        : detection
          ? `${buildSetupPreamble(substratePath)}\n${detection.snippet}`
          : '',
    [deployMode, socketPath, detection, substratePath],
  )

  // The coding-agent prompt for the chosen deployment model.
  const agentPrompt = useMemo(
    () =>
      !detection
        ? ''
        : deployMode === 'daemon'
          ? buildDaemonClientAgentPrompt(detection, socketPath)
          : buildAgentPrompt(detection, substratePath),
    [deployMode, socketPath, detection, substratePath],
  )

  const daemonStartCommand = useMemo(() => buildDaemonStartCommand(substratePath, socketPath), [substratePath, socketPath])

  const progress = useMemo(
    () => (baseline ? compareActivity(baseline, probeActivity(snapshot)) : null),
    [baseline, snapshot],
  )

  // Persist the project as soon as the user reaches the verify step, so the connection survives a
  // restart even before the loop has run once. Green is a separate, later "live" upgrade.
  useEffect(() => {
    if (state.step === 'verify' && state.dir.trim() !== '' && savedProject !== state.dir) {
      setSavedProject(state.dir)
      void window.studio.markConnected(state.dir)
    }
  }, [state.step, state.dir, savedProject])

  // Once real activity arrives, confirm the loop is live.
  useEffect(() => {
    if (progress?.green && !connected && state.dir.trim() !== '') {
      setConnected(true)
      setMessage('Connected. Stigmergy is now learning from this loop.')
    }
  }, [progress?.green, connected, state.dir])

  async function detect(): Promise<void> {
    setMessage(undefined)
    const result = await window.studio.detectFramework(state.dir)
    setDetection(result)
    setState((s) => markDetected(s))
    setAdapterPreview(null)
  }

  async function writeAdapter(): Promise<void> {
    if (!detection) return
    const result = await window.studio.writeAdapter(state.dir, detection)
    setMessage(result.ok ? `Wrote ${result.path}` : `Error: ${result.error}`)
    if (result.ok) setAdapterPreview(null)
  }

  const idx = stepIndex(state)

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Connect your agent loop</h2>
      {savedProject ? (
        <div style={{ fontSize: 12, marginBottom: 10, color: tokens.color.success, wordBreak: 'break-word' }}>● Connected: {savedProject}</div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, fontSize: 11, opacity: 0.7, marginBottom: 12, flexWrap: 'wrap' }}>
        {STEP_TITLES.map((t, i) => (
          <span key={t} style={{ color: i === idx ? tokens.color.accent : tokens.color.text, fontWeight: i === idx ? 700 : 400 }}>
            {t}
          </span>
        ))}
      </div>

      {state.step === 'project' ? (
        <div>
          <p style={{ opacity: 0.7, fontSize: 12 }}>
            Where is your agent loop's code? Pick the folder that contains its package.json (the one you run
            npm install in). This is not a URL.
          </p>
          <input
            value={state.dir}
            onChange={(e) => setState((s) => setDir(s, e.target.value))}
            placeholder="/path/to/your/loop-project"
            style={{ display: 'block', width: '100%', padding: '4px 6px', background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: 4 }}
          />
        </div>
      ) : state.step === 'detect' ? (
        <div>
          <button style={buttonStyle} onClick={() => void detect()} disabled={state.dir.trim() === ''}>
            Detect framework
          </button>
          {detection ? (
            <div style={{ marginTop: 10 }}>
              <div>
                Framework: <strong>{detection.framework}</strong>
              </div>
              <div style={{ opacity: 0.6, fontSize: 11 }}>Integration: {detection.integration ?? '(facade)'}</div>
            </div>
          ) : (
            <p style={{ opacity: 0.6, fontSize: 12 }}>Reads your package.json to propose the right wiring.</p>
          )}
        </div>
      ) : state.step === 'snippet' ? (
        <div>
          <p style={{ opacity: 0.7, fontSize: 12 }}>Wire your loop. Stigmergy only observes; it cannot edit your loop.</p>

          {/* Deployment model: daemon client (recommended, any loop incl. sandboxed) vs embedded (Node). */}
          <div style={{ opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>How Stigmergy runs</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button
              style={{ ...buttonStyle, background: deployMode === 'daemon' ? tokens.color.success : tokens.color.surfaceRaised, color: deployMode === 'daemon' ? tokens.color.bg : tokens.color.text }}
              onClick={() => setDeployMode('daemon')}
            >
              Daemon (recommended)
            </button>
            <button
              style={{ ...buttonStyle, background: deployMode === 'embedded' ? tokens.color.accent : tokens.color.surfaceRaised, color: deployMode === 'embedded' ? tokens.color.bg : tokens.color.text }}
              onClick={() => setDeployMode('embedded')}
            >
              Embedded (Node loop)
            </button>
          </div>

          {deployMode === 'daemon' ? (
            <div style={{ marginBottom: 10 }}>
              <p style={{ opacity: 0.7, fontSize: 12 }}>
                Stigmergy runs as a separate daemon (it owns the model and the database); your loop is a thin client over
                a local socket. Works for any loop, including sandboxed hosts. Start the daemon once, then wire the client.
              </p>
              <label style={{ display: 'block', marginBottom: 6 }}>
                <span style={{ opacity: 0.55, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Daemon socket path</span>
                <input
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '4px 6px', background: tokens.color.bg, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: 4 }}
                  value={socketPath}
                  onChange={(e) => {
                    setSocketEdited(true)
                    setSocketPath(e.target.value)
                  }}
                  placeholder="~/.stigmergy/stigmergy.sock"
                />
              </label>
              <div style={{ opacity: 0.55, fontSize: 11 }}>Start the daemon (run once, separate terminal):</div>
              <pre style={codeStyle}>{daemonStartCommand}</pre>
              <button style={buttonStyle} onClick={() => copy(daemonStartCommand)}>
                Copy start command
              </button>
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button
              style={{ ...buttonStyle, background: snippetMode === 'self' ? tokens.color.accent : tokens.color.surfaceRaised, color: snippetMode === 'self' ? tokens.color.bg : tokens.color.text }}
              onClick={() => setSnippetMode('self')}
            >
              I'll add it myself
            </button>
            <button
              style={{ ...buttonStyle, background: snippetMode === 'agent' ? tokens.color.accent : tokens.color.surfaceRaised, color: snippetMode === 'agent' ? tokens.color.bg : tokens.color.text }}
              onClick={() => setSnippetMode('agent')}
            >
              Prompt my coding agent
            </button>
          </div>

          {snippetMode === 'self' ? (
            <div>
              <p style={{ opacity: 0.7, fontSize: 12 }}>
                {deployMode === 'daemon'
                  ? 'Install the thin client, connect to the daemon socket, register your tools once, then per turn report the task and ask which tools to surface. Phase 1 keeps all tools and just learns.'
                  : 'Install the packages, build one engine on the path below (the database this Studio reads), then add the calls inside your loop: consult before the model step, wrap your tools, end/accept after the run.'}
              </p>
              <pre style={codeStyle}>{recipe}</pre>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button style={buttonStyle} onClick={() => copy(recipe)}>
                  Copy snippet
                </button>
                {deployMode === 'embedded' ? (
                  <button style={buttonStyle} onClick={() => detection && setAdapterPreview(buildAdapterFile(detection, substratePath).content)}>
                    Write stigmergy.connect.ts
                  </button>
                ) : null}
              </div>
              {adapterPreview ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ opacity: 0.55, fontSize: 11 }}>New file stigmergy.connect.ts:</div>
                  <pre style={codeStyle}>{adapterPreview}</pre>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={buttonStyle} onClick={() => void writeAdapter()}>
                      Write (confirm)
                    </button>
                    <button style={buttonStyle} onClick={() => setAdapterPreview(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div>
              <p style={{ opacity: 0.7, fontSize: 12 }}>
                Paste this into your coding agent (Claude Code, Cursor, ...). It wires Stigmergy in at the right places.
              </p>
              <pre style={codeStyle}>{agentPrompt}</pre>
              <button style={buttonStyle} onClick={() => agentPrompt && copy(agentPrompt)}>
                Copy prompt
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <p style={{ opacity: 0.7, fontSize: 12 }}>
            Now run your agent loop once (your normal command) and send it one real task. The first trail
            appears here.
          </p>
          <button style={buttonStyle} onClick={() => setState((s) => startListening(s))} disabled={state.listening}>
            {state.listening ? 'Listening ...' : 'Start listening'}
          </button>
          {progress ? (
            <div style={{ marginTop: 10 }}>
              Status:{' '}
              <span style={{ color: progress.green ? tokens.color.success : tokens.color.warn }}>
                {progress.green ? 'connected' : 'waiting for your loop'}
              </span>
              <div style={{ opacity: 0.6, fontSize: 11 }}>
                consult {progress.consultSeen ? 'ok' : '-'}, event {progress.eventSeen ? 'ok' : '-'}
              </div>
              {!progress.green && state.listening ? (
                <div style={{ opacity: 0.55, fontSize: 11, marginTop: 8 }}>
                  Nothing yet? Make sure the packages from step 3 are installed in your loop and the engine points at
                  this exact path: {substratePath || '~/.stigmergy/pheromone.db'}. If your loop logs "not installed -- no-op",
                  the install is missing.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {message ? <div style={{ marginTop: 10, fontSize: 12 }}>{message}</div> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button style={{ ...buttonStyle, opacity: idx === 0 ? 0.4 : 1 }} disabled={idx === 0} onClick={() => setState((s) => backStep(s))}>
          Back
        </button>
        <button
          style={{ ...buttonStyle, opacity: canAdvance(state) ? 1 : 0.4, cursor: canAdvance(state) ? 'pointer' : 'not-allowed' }}
          disabled={!canAdvance(state)}
          onClick={() => setState((s) => nextStep(s))}
        >
          Next
        </button>
      </div>

      <hr style={{ border: 'none', borderTop: `1px solid ${tokens.color.border}`, margin: '16px 0' }} />
      <div style={{ opacity: 0.4, fontSize: 11 }}>
        Stigmergy only observes; it cannot edit your loop. Coding hosts (Claude Code, Codex): coming later.
      </div>
    </aside>
  )
}
