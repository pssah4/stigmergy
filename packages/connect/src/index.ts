// @stigmergy/connect: the Connect-Verify (FEAT-02-08, ADR-07). We cannot write into a host's loop
// code, so connecting must still be verifiable. detectFramework reads a package.json and proposes
// the matching integration plus a wiring snippet (SC-06). ConnectVerifier wraps an engine and
// reports live-green as soon as the first consult and the first lifecycle event arrive (SC-05).

import type { StigmergyEngine } from '@agentic-stigmergy/core'

export type Framework = 'vercel-ai' | 'langchain' | 'openai-agents' | 'unknown'

export interface FrameworkDetection {
  framework: Framework
  /** The Stigmergy integration package to install, or null for unknown. */
  integration: string | null
  /** Copy-paste wiring snippet for the detected framework. */
  snippet: string
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const SNIPPETS: Record<Exclude<Framework, 'unknown'>, string> = {
  'vercel-ai': [
    "import { createVercelIntegration } from '@stigmergy/integration-vercel-ai'",
    'const sx = createVercelIntegration(engine, { taskId, context: prompt, candidateIds: Object.keys(tools) })',
    '// Default keeps ALL tools active (cache-safe). prepareStep narrows only with { narrow: true }.',
    'await streamText({ model, messages, tools: sx.wrapTools(tools), prepareStep: sx.prepareStep })',
    'const g = await sx.pathGuidance(); if (g.text) messages.push({ role: "user", content: g.text }) // learned path, per-turn, cache-safe',
    'await sx.end(); await sx.accept(usage.totalTokens) // grade: sx.abandon() on failure, sx.iterate() on a revision',
  ].join('\n'),
  langchain: [
    "import { createLangchainIntegration } from '@stigmergy/integration-langchain'",
    'const sx = createLangchainIntegration(engine, { taskId, context: prompt, candidateIds: tools.map((t) => t.name) })',
    '// in a wrap_model_call middleware: return sx.wrapModelCall(request, handler) // passes the request through unchanged (narrow: true to filter)',
    '// wrap a tool function: sx.instrument(tool.name, tool.func)',
    'const g = await sx.pathGuidance(); if (g.text) /* inject g.text as a small per-turn message */',
    'await sx.end(); await sx.accept(usage.totalTokens) // grade: sx.abandon() on failure, sx.iterate() on a revision',
  ].join('\n'),
  'openai-agents': [
    "import { createOpenAIAgentsIntegration } from '@stigmergy/integration-openai-agents'",
    'const sx = createOpenAIAgentsIntegration(engine, { taskId, context: prompt, candidateIds })',
    'await sx.prime() // before the run',
    '// Default enables every tool (cache-safe). isEnabled gates only with { narrow: true }.',
    '// tool({ ..., isEnabled: () => sx.isEnabled(name) }); hooks -> sx.onToolStart(name) / sx.onToolEnd(name, ok)',
    'const g = await sx.pathGuidance(); if (g.text) /* inject g.text as a small per-turn message */',
    'await sx.end(); await sx.accept(usage.totalTokens) // grade: sx.abandon() on failure, sx.iterate() on a revision',
  ].join('\n'),
}

// First match wins; order is most-specific-first so a project with several does not misdetect.
const SIGNATURES: Array<{ framework: Exclude<Framework, 'unknown'>; deps: string[]; integration: string }> = [
  { framework: 'openai-agents', deps: ['@openai/agents'], integration: '@stigmergy/integration-openai-agents' },
  { framework: 'vercel-ai', deps: ['ai'], integration: '@stigmergy/integration-vercel-ai' },
  { framework: 'langchain', deps: ['langchain', '@langchain/core', '@langchain/langgraph'], integration: '@stigmergy/integration-langchain' },
]

export function detectFramework(manifest: PackageManifest): FrameworkDetection {
  const present = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  for (const sig of SIGNATURES) {
    if (sig.deps.some((d) => present.has(d))) {
      return { framework: sig.framework, integration: sig.integration, snippet: SNIPPETS[sig.framework] }
    }
  }
  return {
    framework: 'unknown',
    integration: null,
    snippet: [
      "// No supported SDK detected. Use the facade directly:",
      "import { StigmergyLoop } from '@agentic-stigmergy/loop'",
      'const loop = new StigmergyLoop(engine)',
      '// candidate_ids = ALL four explorable types with stable ids: tool name, `skill:${slug}`,',
      '// `mcp:${server}:${name}`, `subagent:${name}` (register each with its type before the first turn).',
      'const turn = await loop.beginTurn({ task_id, prompt, candidate_ids })',
      '// ADR-26: keep YOUR OWN tool selection as the default; do NOT reorder/narrow the tool block. Surface',
      '// a learned path only when one matches: if g.path is non-empty, pre-activate g.path and inject g.text.',
      'const g = turn.pathGuidance(); if (g.path.length) { /* preactivate(g.path); inject g.text as a small per-turn message */ }',
      '// instrument the REAL dispatch of EACH type (tool / skill: / mcp: / subagent:); see the daemon-client recipe.',
      'const tools = turn.instrument(myTools); /* ... */ await turn.end()',
      'await turn.accept(tokenCost) // grade: turn.abandon() on failure, turn.iterate() on a revision',
    ].join('\n'),
  }
}

export interface ConnectStatus {
  consultSeen: boolean
  eventSeen: boolean
  green: boolean
}

/**
 * Wraps an engine so the first consult and the first lifecycle event flip the verifier to green.
 * The host wires the returned engine into their loop; nothing else changes. Equivalent to the
 * hook diff-confirm: the dev sees connection confirmed instead of guessing.
 */
export class ConnectVerifier {
  private consultSeen = false
  private eventSeen = false
  private resolveGreen: (() => void) | null = null
  private readonly greenPromise: Promise<void>

  constructor(
    private readonly engine: StigmergyEngine,
    private readonly onGreen?: () => void,
  ) {
    this.greenPromise = new Promise<void>((resolve) => {
      this.resolveGreen = resolve
    })
  }

  get status(): ConnectStatus {
    return { consultSeen: this.consultSeen, eventSeen: this.eventSeen, green: this.consultSeen && this.eventSeen }
  }

  /** Resolves once both the first consult and the first event have been observed. */
  whenGreen(): Promise<void> {
    return this.greenPromise
  }

  /** A drop-in replacement engine that records the first consult and event, then delegates. */
  wrap(): StigmergyEngine {
    const verifier = this
    return new Proxy(this.engine, {
      get(target, prop, receiver) {
        if (prop === 'consult') {
          return (...args: Parameters<StigmergyEngine['consult']>) => {
            verifier.mark('consult')
            return target.consult(...args)
          }
        }
        if (prop === 'emit') {
          return (...args: Parameters<StigmergyEngine['emit']>) => {
            verifier.mark('event')
            return target.emit(...args)
          }
        }
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private mark(kind: 'consult' | 'event'): void {
    if (kind === 'consult') this.consultSeen = true
    else this.eventSeen = true
    if (this.consultSeen && this.eventSeen && this.resolveGreen) {
      const resolve = this.resolveGreen
      this.resolveGreen = null
      this.onGreen?.()
      resolve()
    }
  }
}
