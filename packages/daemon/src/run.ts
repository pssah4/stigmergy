// Daemon orchestration (ADR-19, ADR-20, FEAT-04-04). runOneTick and buildLlmNamer are pure/injectable
// and unit-tested; startDaemon is the long-running glue (acquire the role lock, open an engine, tick on
// an interval, optionally serve consult) and is manual/integration-tested. The Studio spawns the bin
// (bin.ts) and manages its lifecycle; no terminal use by the operator.
import { createEngine, type EmbeddingPort, type StigmergyEngine, type CapabilityAugmenter, type ConsultInput, type LifecycleEvent, type RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { TransformersEmbedding } from '@stigmergy/embedding-transformers'
import { buildApiHandler, makeCapabilityAugmenter, type ApiHandler, type ProviderType } from '@stigmergy/llm'
import { serveEngine } from '@agentic-stigmergy/client'
import { acquireRoleLock, type RoleLock } from './role-lock.js'
import { nameEmergentPaths, type EmergentNamer, type NameEmergentResult } from './controller.js'

const NAMER_PROMPT = (seq: readonly string[]): string =>
  `An agent loop repeatedly used this tool sequence: ${seq.join(' -> ')}. Reply with ONLY a JSON object ` +
  `{"name":"<2-4 word label>","whenToUse":"<one sentence: when to use this whole path>"}.`

function extractJson(s: string): string {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  return a >= 0 && b > a ? s.slice(a, b + 1) : s
}

/** Build an emergent namer from an LLM handler, or a no-op namer (returns null) when there is none.
 * Parsing is defensive: a non-JSON or incomplete reply yields null, so a bad response just skips. */
export function buildLlmNamer(handler: ApiHandler | null): EmergentNamer {
  if (!handler) return async () => null
  return async (seq) => {
    try {
      const parsed = JSON.parse(extractJson(await handler.classifyText(NAMER_PROMPT(seq)))) as {
        name?: unknown
        whenToUse?: unknown
      }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      const whenToUse = typeof parsed.whenToUse === 'string' ? parsed.whenToUse.trim() : ''
      return name && whenToUse ? { name, whenToUse } : null
    } catch {
      return null
    }
  }
}

export interface TickDeps {
  engine: Pick<StigmergyEngine, 'backup' | 'pinPath'> & Partial<Pick<StigmergyEngine, 'isEnabled'>>
  namer: EmergentNamer
  lock?: Pick<RoleLock, 'heartbeat'>
  threshold: number
  namedBy: string
}

/** One daemon tick: heartbeat the lock (so a healthy holder is never reclaimed), then, when Stigmergy
 * is enabled, name emergent paths. The heartbeat runs even when disabled so the lock stays fresh; the
 * naming is gated on the runtime flag (FEAT-04-09 / ADR-20) so a disabled substrate is not mutated.
 * Pure orchestration over injected parts, so it is unit-tested without a process or socket. */
export async function runOneTick(deps: TickDeps): Promise<NameEmergentResult> {
  deps.lock?.heartbeat()
  if (deps.engine.isEnabled && !(await deps.engine.isEnabled())) return { named: 0, skipped: 0 }
  return nameEmergentPaths(deps.engine, deps.namer, { threshold: deps.threshold, namedBy: deps.namedBy })
}

/** Build an LLM handler from STIGMERGY_LLM_* env, or null when unset. */
function envHandler(): ApiHandler | null {
  const type = process.env['STIGMERGY_LLM_PROVIDER']
  const model = process.env['STIGMERGY_LLM_MODEL']
  if (!type || !model) return null
  try {
    return buildApiHandler({ type: type as ProviderType, model, apiKey: process.env['STIGMERGY_LLM_API_KEY'], baseUrl: process.env['STIGMERGY_LLM_BASE_URL'] })
  } catch {
    return null
  }
}

export interface DaemonConfig {
  substratePath: string
  lockPath?: string
  /** When set, serve consult on this Unix socket path (the loop connects as a client). */
  socketPath?: string
  intervalMs?: number
  threshold?: number
}

export interface DaemonHandle {
  stop(): Promise<void>
}

export interface DaemonDeps {
  makeEmbedding: () => EmbeddingPort
  makeHandler: () => ApiHandler | null
  /** The LLM-backed augmenter for semantic indexing (FEAT-04-09): enriches a capability description
   * before it is embedded. Optional; absent means the raw description is embedded (no LLM). */
  makeAugmenter?: () => CapabilityAugmenter | undefined
}

/** Build the embedding. The embedding model is hard-wired to the local transformers model (ADR-25,
 * IMP-05-06-02): embedding runs per consult and per registration in the background, where a fast,
 * offline, rate-limit-free local model is the only sensible choice, and no fake or remote embedding is
 * reachable at runtime. STIGMERGY_EMBEDDING_MODEL overrides which local model id, STIGMERGY_EMBEDDING_LOCAL
 * points at a pre-provisioned model dir (offline, no runtime fetch); neither makes the embedding remote. */
function envEmbedding(): EmbeddingPort {
  return new TransformersEmbedding({
    modelId: process.env['STIGMERGY_EMBEDDING_MODEL'] || undefined,
    localModelPath: process.env['STIGMERGY_EMBEDDING_LOCAL'] || undefined,
  })
}

/** Build the semantic-indexing augmenter from the same STIGMERGY_LLM_* env as the namer (FEAT-04-09):
 * if an LLM is configured, capability descriptions are LLM-enriched before embedding; otherwise the
 * raw description is embedded. So the daemon uses BOTH configured models, the embedding and the LLM. */
function envAugmenter(): CapabilityAugmenter | undefined {
  const handler = envHandler()
  if (!handler) return undefined
  return makeCapabilityAugmenter(handler, { model: process.env['STIGMERGY_LLM_MODEL'] ?? '' })
}

const defaultDaemonDeps: DaemonDeps = {
  makeEmbedding: () => envEmbedding(),
  makeHandler: () => envHandler(),
  makeAugmenter: () => envAugmenter(),
}

/** How often to re-stamp the lock. Must be well below the lock's stale window (DEFAULT_STALE_MS =
 * 30s) so a healthy daemon is never judged stale between naming ticks; the naming tick itself runs far
 * less often (intervalMs, default 5 min), so the heartbeat cannot ride on it. */
const HEARTBEAT_MS = 10_000

/** Wrap the engine the daemon serves so each incoming RPC writes a one-line trace to stdout. The Studio
 * captures the daemon's stdout into its daemon log (Settings), so the operator can see whether the host
 * loop actually reaches the daemon and what it sends, the first thing to check when tools run but no new
 * edges appear. Only the served instance is wrapped; the daemon's own naming tick uses the raw engine and
 * stays silent. consult/emit/register are the learning-relevant calls; isEnabled/ping are liveness noise
 * and are not logged. An edge is only learned when capability_invoked/returned AND a resolving event
 * (task_accepted / task_iterated / task_abandoned) arrive, so the emit trace shows exactly what is
 * missing if the host instruments tool runs but never resolves the task. */
function withActivityLog(engine: StigmergyEngine): StigmergyEngine {
  const log = (line: string): void => void process.stdout.write(`[stigmergyd] ${line}\n`)
  return new Proxy(engine, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...args: never[]) => unknown
      if (prop === 'consult') {
        return (input: ConsultInput): unknown => {
          const hist = input.history
          const prev = hist && hist.length > 0 ? hist[hist.length - 1] : undefined
          log(`consult${prev ? ` after ${prev}` : ''}`)
          return (fn as (i: ConsultInput) => unknown).call(target, input)
        }
      }
      if (prop === 'emit') {
        return (event: LifecycleEvent): unknown => {
          const cap = 'capabilityId' in event ? ` ${event.capabilityId}` : ''
          log(`emit ${event.type}${cap} (task ${event.taskId})`)
          return (fn as (e: LifecycleEvent) => unknown).call(target, event)
        }
      }
      if (prop === 'registerCapability') {
        return (input: RegisterCapabilityInput): unknown => {
          log(`register ${input.id}`)
          return (fn as (i: RegisterCapabilityInput) => unknown).call(target, input)
        }
      }
      // isEnabled is the gate the loop checks every beginTurn (ADR-20): a false answer (or a client-side
      // timeout) turns the whole turn into a no-op, so capability_invoked/returned are never sent and no
      // edge is ever learned. Log its answer so "register works, but no edges" (the gate is closed) is
      // diagnosable. ping stays silent (pure liveness).
      if (prop === 'isEnabled') {
        return async (): Promise<unknown> => {
          const r = await (fn as () => Promise<unknown>).call(target)
          log(`isEnabled -> ${r}`)
          return r
        }
      }
      return (fn as { bind: (t: unknown) => unknown }).bind(target)
    },
  }) as StigmergyEngine
}

/** Start the daemon: acquire the role lock (return null if another daemon owns it), open the engine,
 * optionally serve consult, and tick on an interval. The caller stops it via the returned handle. */
export async function startDaemon(config: DaemonConfig, deps: DaemonDeps = defaultDaemonDeps): Promise<DaemonHandle | null> {
  const lockPath = config.lockPath ?? `${config.substratePath}.daemon.lock`
  const lock = acquireRoleLock(lockPath, 'daemon')
  if (!lock) return null // another daemon already serves this substrate

  // Release the lock if any setup step throws, so a half-started daemon never orphans the lock file
  // (recovery would otherwise wait out the stale TTL or the dead-pid probe).
  let engine: StigmergyEngine
  let server: ReturnType<typeof serveEngine> | undefined
  try {
    const storage = new BetterSqlite3Storage(config.substratePath)
    engine = await createEngine({ storage, embedding: deps.makeEmbedding(), augmenter: deps.makeAugmenter?.() })
    // serveEngine (not serveConsult): the daemon serves the full surface (consult plus the write side)
    // so a host can run as a pure remote client with no local engine (FEAT-04-09).
    server = config.socketPath ? serveEngine(withActivityLog(engine), config.socketPath) : undefined
  } catch (e) {
    lock.release()
    throw e
  }
  const handler = deps.makeHandler()
  const namer = buildLlmNamer(handler)
  const namedBy = handler ? 'daemon' : 'none'

  // A dedicated fast heartbeat keeps the lock fresh regardless of the (slow) naming cadence.
  const heartbeat = setInterval(() => lock.heartbeat(), HEARTBEAT_MS)
  heartbeat.unref?.()
  const interval = setInterval(() => {
    void runOneTick({ engine, namer, lock, threshold: config.threshold ?? 1, namedBy }).catch(() => {
      /* a failed tick is logged by the worker; the daemon keeps ticking */
    })
  }, config.intervalMs ?? 300_000)
  interval.unref?.()

  return {
    async stop(): Promise<void> {
      clearInterval(heartbeat)
      clearInterval(interval)
      server?.close()
      lock.release()
      await engine.close()
    },
  }
}
