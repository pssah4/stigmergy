import { describe, it, expect } from 'vitest'
import { detectFramework } from '@stigmergy/connect'
import {
  buildAdapterFile,
  buildAgentPrompt,
  buildSetupPreamble,
  buildDaemonStartCommand,
  buildDaemonClientRecipe,
  buildDaemonClientAgentPrompt,
} from './connect-adapter.js'

const SUBSTRATE = '/Users/me/.stigmergy/pheromone.db'

describe('buildSetupPreamble', () => {
  it('gives the complete missing wiring: install the packages and build the engine on the shared substrate', () => {
    const preamble = buildSetupPreamble(SUBSTRATE)
    // The framework snippets assume an `engine` exists; the preamble is what actually creates it.
    expect(preamble).toContain('npm install @agentic-stigmergy/loop @agentic-stigmergy/core @stigmergy/storage-better-sqlite3')
    expect(preamble).toContain('createEngine')
    expect(preamble).toContain('BetterSqlite3Storage')
    expect(preamble).toContain('const engine =')
    // Defaults to the REAL model (same 384-dim space as the daemon/Studio), not the 64-dim test stub.
    expect(preamble).toContain('TransformersEmbedding')
    expect(preamble).not.toContain('embedding: new FakeEmbedding()')
    // It must point the loop's engine at the exact same DB the Studio reads, or nothing shows up.
    expect(preamble).toContain(SUBSTRATE)
  })

  it('falls back to the documented default path when none is given', () => {
    expect(buildSetupPreamble('')).toContain('.stigmergy/pheromone.db')
  })
})

describe('buildAdapterFile', () => {
  it('wraps a detected framework snippet into a stable adapter file', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const file = buildAdapterFile(detection, SUBSTRATE)
    expect(file.filename).toBe('stigmergy.connect.ts')
    expect(file.content).toContain('@stigmergy/integration-vercel-ai')
    expect(file.content).toContain(detection.snippet)
    expect(file.content).toMatch(/Stigmergy/) // header comment present
    expect(file.content).not.toMatch(/FEAT-|SC-\d|ADR-/) // no internal artifact IDs in user-facing output
  })

  it('includes the engine-construction preamble so the snippet is not left with an undefined engine', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const file = buildAdapterFile(detection, SUBSTRATE)
    expect(file.content).toContain('createEngine')
    expect(file.content).toContain(SUBSTRATE)
  })

  it('falls back to the facade snippet for an unknown framework', () => {
    const detection = detectFramework({ dependencies: {} })
    expect(detection.framework).toBe('unknown')
    const file = buildAdapterFile(detection, SUBSTRATE)
    expect(file.content).toContain('@agentic-stigmergy/loop')
  })
})

describe('buildAgentPrompt', () => {
  it('produces a coding-agent prompt embedding the detected snippet and the observe-only rule', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildAgentPrompt(detection, SUBSTRATE)
    expect(prompt).toContain(detection.snippet)
    expect(prompt).toMatch(/only observes/i)
    expect(prompt).toContain('vercel-ai') // names the detected framework
  })

  it('tells the agent to install the packages and build the engine on the shared substrate', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildAgentPrompt(detection, SUBSTRATE)
    expect(prompt).toContain('npm install @agentic-stigmergy/loop')
    expect(prompt).toContain('createEngine')
    expect(prompt).toContain(SUBSTRATE)
  })
})

const SOCKET = '/Users/me/.stigmergy/vo.sock'

describe('buildDaemonStartCommand (FEAT-04-09)', () => {
  it('builds the stigmergyd command with the socket env and the substrate path', () => {
    const cmd = buildDaemonStartCommand('/Users/me/.stigmergy/pheromone.db', SOCKET)
    expect(cmd).toContain('STIGMERGY_DAEMON_SOCKET')
    expect(cmd).toContain(SOCKET)
    expect(cmd).toContain('stigmergyd')
    expect(cmd).toContain('/Users/me/.stigmergy/pheromone.db')
  })
  it('falls back to documented defaults when paths are empty', () => {
    const cmd = buildDaemonStartCommand('', '')
    expect(cmd).toContain('.stigmergy/stigmergy.sock')
    expect(cmd).toContain('.stigmergy/pheromone.db')
  })
})

describe('buildDaemonClientRecipe (FEAT-04-09)', () => {
  it('installs the thin client + loop facade, connects, registers tools and drives a turn via the facade', () => {
    const recipe = buildDaemonClientRecipe(SOCKET)
    expect(recipe).toContain('npm install @agentic-stigmergy/client @agentic-stigmergy/loop')
    expect(recipe).toContain('createRemoteEngine')
    expect(recipe).toContain('socketRpcSend')
    expect(recipe).toContain('StigmergyLoop')
    expect(recipe).toContain(SOCKET)
    expect(recipe).toContain('registerCapability')
    expect(recipe).toContain('beginTurn')
    expect(recipe).toContain('turn.accept')
    // No embedded-engine packages in the daemon-client recipe (the daemon owns those).
    expect(recipe).not.toContain('BetterSqlite3Storage')
    expect(recipe).not.toContain('createEngine')
  })
  it('documents the graceful-degrade contract so the host never breaks when off or the daemon is down', () => {
    expect(buildDaemonClientRecipe(SOCKET)).toMatch(/no-op|never breaks|degrade|runs exactly as before/i)
  })
  it('hooks the real tool dispatch so pipeline/executor loops also emit invoked/returned (FIX-04-09-01)', () => {
    const recipe = buildDaemonClientRecipe(SOCKET)
    // instrument() alone is not enough when the loop runs tools through a central dispatcher: name the trap.
    expect(recipe).toMatch(/central (executor|dispatcher|pipeline)|does not call/i)
    // Show the dispatch-hook path using the exported helper, gated on the turn's active state.
    expect(recipe).toContain('instrumentRun')
    expect(recipe).toContain('turn.taskId')
    expect(recipe).toContain('turn.enabled')
    expect(recipe).toContain('capability_invoked')
  })
  it('keeps the host selection as default and does not reorder/narrow the tool block (IMP-04-10-03)', () => {
    const recipe = buildDaemonClientRecipe(SOCKET)
    expect(recipe).toMatch(/do NOT reorder or narrow|not a second selector|keep YOUR OWN/i)
    // orderTools survives only as the explicitly-not-recommended escape hatch.
    expect(recipe).toMatch(/not the recommended default/i)
  })
  it('surfaces a learned path only when matched (sequence-gated) via pathGuidance, pre-activates, and grades (IMP-04-10-03)', () => {
    const recipe = buildDaemonClientRecipe(SOCKET)
    expect(recipe).toContain('pathGuidance')
    expect(recipe).toMatch(/guidance\.path/) // the path doubles as the pre-activation list
    expect(recipe).toMatch(/pre-activate/i)
    expect(recipe).toContain('turn.abandon') // outcome grading is the safety mechanism
  })
  it('generalises to all four capability types with namespaced ids and correct per-type registration (IMP-04-10-02)', () => {
    const recipe = buildDaemonClientRecipe(SOCKET)
    expect(recipe).toMatch(/skill:/)
    expect(recipe).toMatch(/mcp:/)
    expect(recipe).toMatch(/subagent:/)
    expect(recipe).toMatch(/type: 'skill'/)
    expect(recipe).toMatch(/type: 'mcp'/)
    expect(recipe).toMatch(/type: 'subagent'/)
  })
})

describe('buildDaemonClientAgentPrompt (FEAT-04-09)', () => {
  it('produces a self-contained coding-agent prompt for the daemon-client wiring', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildDaemonClientAgentPrompt(detection, SOCKET)
    expect(prompt).toContain('@agentic-stigmergy/client')
    expect(prompt).toContain('createRemoteEngine')
    expect(prompt).toContain(SOCKET)
    expect(prompt).toMatch(/only observes|do not change/i)
    expect(prompt).toContain('vercel-ai') // names the detected framework
    expect(prompt).not.toMatch(/FEAT-|SC-\d|ADR-/) // no internal artifact IDs in user-facing output
  })
  it('tells the agent to hook the actual dispatch so trails form even for pipeline-based loops (FIX-04-09-01)', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildDaemonClientAgentPrompt(detection, SOCKET)
    // The agent must find the real tool-execution path, not assume turn.instrument's .run() wrapping fires.
    expect(prompt).toMatch(/central (executor|dispatcher|pipeline)|dispatch/i)
    expect(prompt).toContain('instrumentRun')
    expect(prompt).toContain('capability_invoked')
    expect(prompt).not.toMatch(/FEAT-|SC-\d|ADR-/) // still no internal artifact IDs
  })
  it('tells the agent NOT to reorder/narrow by default, keeping the host selection (IMP-04-10-03)', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildDaemonClientAgentPrompt(detection, SOCKET)
    expect(prompt).toMatch(/do NOT reorder or narrow|not a second tool selector|keep my own/i)
    expect(prompt).not.toMatch(/FEAT-|SC-\d|ADR-/) // still no internal artifact IDs
  })
  it('tells the agent to surface a matched path via pathGuidance (pre-activate) and to grade the turn (IMP-04-10-03)', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildDaemonClientAgentPrompt(detection, SOCKET)
    expect(prompt).toContain('pathGuidance')
    expect(prompt).toMatch(/pre-activate/i)
    expect(prompt).toMatch(/turn\.abandon\(\)/) // outcome grading
    expect(prompt).not.toMatch(/FEAT-|SC-\d|ADR-/)
  })
  it('tells the agent to wire all four capability types with stable ids and per-call degrade (IMP-04-10-02)', () => {
    const detection = detectFramework({ dependencies: { ai: '^4.0.0' } })
    const prompt = buildDaemonClientAgentPrompt(detection, SOCKET)
    expect(prompt).toMatch(/skill:/)
    expect(prompt).toMatch(/mcp:/)
    expect(prompt).toMatch(/subagent:/)
    expect(prompt).toMatch(/non-fatal|never throw|no-op/i) // per-call degrade restated across the new hooks
    expect(prompt).not.toMatch(/FEAT-|SC-\d|ADR-/)
  })
})
