// CLI command dispatch (FEAT-01-06). run() is pure over injected deps (storage factory,
// embedding, framework detection, IO, confirm, fs) so it is testable without touching the
// real filesystem or terminal; bin.ts wires the concrete deps. Mutations go through the
// engine; read-only inspect (show, doctor) reads the storage directly (the CLI owns it).
import { dirname } from 'node:path'
import { createEngine } from '@agentic-stigmergy/core'
import type { StoragePort, EmbeddingPort, StigmergyEngine, PinBehavior, Edge, SubstrateStats, Capability } from '@agentic-stigmergy/core'
import type { FrameworkDetection } from '@stigmergy/connect'
import { parseArgs, flagString } from './args.js'
import { EXIT, CliError, type ExitCode } from './exit-codes.js'
import { defaultSubstratePath, defaultCachePath, isProtectedPath, parsePathExpression } from './paths.js'
import { renderTrustDiff } from './trust.js'

export interface CliDeps {
  makeStorage(path: string): Promise<StoragePort>
  makeEmbedding(): EmbeddingPort
  detectFramework(manifest: unknown): FrameworkDetection
  out(line: string): void
  err(line: string): void
  confirm(prompt: string): Promise<boolean>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  mkdirp(path: string): Promise<void>
  /** Remove a file or directory recursively; a no-op if it does not exist (reversibility, FEAT-02-06). */
  removePath(path: string): Promise<void>
  cwd: string
}

const PIN_BEHAVIORS: ReadonlySet<string> = new Set(['preferred', 'enforce', 'sequence'])

// Flags that are switches (no value). Every other --flag expects a value; a value-flag
// given last or before another --flag would otherwise be silently coerced to boolean true
// (e.g. a forgotten filename in `backup --out`), so run() rejects that as an argument error.
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json', 'help', 'confirm', 'migrate', 'purge'])

const HELP = `stigmergy - operate and inspect a Stigmergy substrate

Usage: stigmergy <command> [options]

  init [--path <p>] [--shared <p>]   Create a substrate (SQLite file plus schema).
  connect                            Detect the loop framework and print a wiring snippet.
  show [--filter <cap>] [--task <id>] [--capability <id>]  Show top learned paths, a task, or a capability (raw plus augmented).
  stats                              Substrate statistics.
  pin <a -> b -> c> --behavior <preferred|enforce|sequence> [--name <n>]   Pin a path.
  unpin <pin-id>                     Remove a pin (also drops its unrun, uncovered edges).
  delete <pin-id>                    Delete a pinned path (alias of unpin).
  reinforce <a -> b> --strength <0..1>   Manually raise pheromone along a path (pinned edges keep their pinned value).
  weaken <a -> b> --strength <0..1>      Manually lower pheromone along a path (pinned edges keep their pinned value).
  export <pin-id> [--out <file>]     Export a pinned path as JSON.
  import <file>                      Import a path JSON.
  backup [--out <file>]              Full substrate dump as JSON.
  restore <file>                     Replace the learned substrate (edges/tasks/pins) and re-load capabilities from a backup.
  reset --confirm                    Wipe the substrate (--confirm is mandatory).
  doctor                             Health check (path, stats).
  status                             Show substrate path, mode, cache and stats (inspect; opens the substrate, never deletes).
  uninstall [--purge] [--cache <d>]  Remove the substrate; --purge also deletes the model cache (own confirm).
  link --to <path> [--migrate]       Point at a new substrate path; --migrate copies data.

Global: --path <p> substrate path (default ${defaultSubstratePath()}), --json machine output, --help.`

function substratePath(flags: Record<string, string | boolean>): string {
  return flagString(flags, 'path') ?? defaultSubstratePath()
}

async function withSubstrate<T>(
  path: string,
  deps: CliDeps,
  requireExists: boolean,
  fn: (engine: StigmergyEngine, storage: StoragePort) => Promise<T>,
): Promise<T> {
  if (requireExists && !(await deps.fileExists(path))) {
    throw new CliError(`substrate not found at ${path} (run 'stigmergy init' first)`, EXIT.NOT_FOUND)
  }
  if (!requireExists) {
    // Creating a substrate: ensure the parent directory exists, since the SQLite
    // driver cannot open a file inside a missing directory (e.g. first-run ~/.stigmergy/).
    await deps.mkdirp(dirname(path))
  }
  const storage = await deps.makeStorage(path)
  let engine: StigmergyEngine
  try {
    // createEngine runs storage.init(); if that throws (corrupt/incompatible file) the
    // already-open storage handle must still be closed, otherwise it leaks.
    engine = await createEngine({ storage, embedding: deps.makeEmbedding() })
  } catch (e) {
    await storage.close()
    throw e
  }
  try {
    return await fn(engine, storage)
  } finally {
    await engine.close()
  }
}

function emit(deps: CliDeps, json: boolean, human: string, data: unknown): void {
  deps.out(json ? JSON.stringify(data, null, 2) : human)
}

/** Run one CLI invocation. Returns the process exit code; never throws. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<ExitCode> {
  const { command, positionals, flags } = parseArgs(argv, BOOLEAN_FLAGS)
  const json = flags.json === true

  if (command === '' || command === 'help' || command === '--help' || command === '-h' || flags.help === true) {
    deps.out(HELP)
    return EXIT.OK
  }

  try {
    for (const [key, value] of Object.entries(flags)) {
      if (value === true && !BOOLEAN_FLAGS.has(key)) {
        throw new CliError(`--${key} requires a value`, EXIT.ARGS)
      }
    }
    return await dispatch(command, positionals, flags, json, deps)
  } catch (e) {
    if (e instanceof CliError) {
      deps.err(`error: ${e.message}`)
      return e.code
    }
    deps.err(`error: ${e instanceof Error ? e.message : String(e)}`)
    return EXIT.GENERIC
  }
}

async function dispatch(
  command: string,
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
  deps: CliDeps,
): Promise<ExitCode> {
  const path = substratePath(flags)

  switch (command) {
    case 'init': {
      const shared = flagString(flags, 'shared')
      const target = shared ?? path
      const diff = renderTrustDiff([target, `${target.replace(/[^/\\]*$/, '')}(embedding model on first use)`])
      if (!(await deps.confirm(diff))) {
        deps.out('Aborted.')
        return EXIT.OK
      }
      await withSubstrate(target, deps, false, async () => {})
      emit(deps, json, `Initialised substrate at ${target}${shared ? ' (shared; concurrent access is daemon-mediated in a later phase)' : ''}`, { initialised: target, shared: Boolean(shared) })
      return EXIT.OK
    }

    case 'stats': {
      const stats = await withSubstrate(path, deps, true, (engine) => engine.stats())
      emit(deps, json, formatStats(stats), stats)
      return EXIT.OK
    }

    case 'show':
      return showCommand(path, flags, json, deps)

    case 'pin': {
      // Join positionals so an unquoted "a -> b" (split by the shell into tokens) is reconstructed.
      const expr = positionals.join(' ')
      if (positionals.length === 0) throw new CliError('pin requires a path expression, e.g. "tool:a -> tool:b"', EXIT.ARGS)
      const behavior = flagString(flags, 'behavior') ?? 'preferred'
      if (!PIN_BEHAVIORS.has(behavior)) throw new CliError(`invalid --behavior '${behavior}' (preferred|enforce|sequence)`, EXIT.ARGS)
      const sequence = parsePathExpression(expr)
      if (sequence.length === 0) throw new CliError('path expression resolved to no capabilities', EXIT.ARGS)
      const pin = await withSubstrate(path, deps, true, (engine) =>
        engine.pinPath({ capability_sequence: sequence, behavior: behavior as PinBehavior, name: flagString(flags, 'name') }),
      )
      emit(deps, json, `Pinned ${pin.id} (${behavior}): ${sequence.join(' -> ')}`, pin)
      return EXIT.OK
    }

    case 'unpin':
    case 'delete': {
      const id = positionals[0]
      if (!id) throw new CliError(`${command} requires a pin id`, EXIT.ARGS)
      await withSubstrate(path, deps, true, (engine) => engine.deletePath(id))
      emit(deps, json, `Removed pin ${id}`, { deleted: id })
      return EXIT.OK
    }

    case 'reinforce':
    case 'weaken': {
      // Join positionals so an unquoted "a -> b" (split by the shell into tokens) is reconstructed.
      const expr = positionals.join(' ')
      if (positionals.length === 0) throw new CliError(`${command} requires a path expression`, EXIT.ARGS)
      const strengthRaw = flagString(flags, 'strength')
      const strength = Number(strengthRaw)
      if (strengthRaw === undefined || strengthRaw.trim() === '' || !Number.isFinite(strength) || strength < 0) {
        throw new CliError(`${command} requires --strength <number >= 0>`, EXIT.ARGS)
      }
      const seq = parsePathExpression(expr)
      if (seq.length === 0) throw new CliError('path expression resolved to no capabilities', EXIT.ARGS)
      await withSubstrate(path, deps, true, (engine) =>
        command === 'reinforce' ? engine.reinforcePath({ path: seq, strength }) : engine.weakenPath({ path: seq, strength }),
      )
      emit(deps, json, `${command === 'reinforce' ? 'Reinforced' : 'Weakened'} ${seq.join(' -> ')} by ${strength}`, { command, path: seq, strength })
      return EXIT.OK
    }

    case 'export': {
      const id = positionals[0]
      if (!id) throw new CliError('export requires a pin id', EXIT.ARGS)
      const exported = await withSubstrate(path, deps, true, (engine) => engine.exportPath(id))
      if (!exported) throw new CliError(`pinned path '${id}' not found`, EXIT.NOT_FOUND)
      const out = flagString(flags, 'out')
      const payload = JSON.stringify(exported, null, 2)
      if (out) {
        await deps.writeFile(out, payload)
        emit(deps, json, `Exported ${id} to ${out}`, { exported: id, file: out })
      } else {
        deps.out(payload)
      }
      return EXIT.OK
    }

    case 'import': {
      const file = positionals[0]
      if (!file) throw new CliError('import requires a file path', EXIT.ARGS)
      if (!(await deps.fileExists(file))) throw new CliError(`import file not found: ${file}`, EXIT.NOT_FOUND)
      const data = JSON.parse(await deps.readFile(file)) as Parameters<StigmergyEngine['importPath']>[0]
      const pin = await withSubstrate(path, deps, false, (engine) => engine.importPath(data))
      emit(deps, json, `Imported pinned path ${pin.id}`, pin)
      return EXIT.OK
    }

    case 'backup': {
      const dump = await withSubstrate(path, deps, true, (engine) => engine.backup())
      const out = flagString(flags, 'out')
      const payload = JSON.stringify(dump, null, 2)
      if (out) {
        await deps.writeFile(out, payload)
        emit(deps, json, `Backed up to ${out}`, { file: out, capabilities: dump.capabilities.length, edges: dump.edges.length })
      } else {
        deps.out(payload)
      }
      return EXIT.OK
    }

    case 'restore': {
      const file = positionals[0]
      if (!file) throw new CliError('restore requires a backup file', EXIT.ARGS)
      if (!(await deps.fileExists(file))) throw new CliError(`restore file not found: ${file}`, EXIT.NOT_FOUND)
      if (!(await deps.confirm(renderTrustDiff([`${path} (replaced from ${file})`])))) {
        deps.out('Aborted.')
        return EXIT.OK
      }
      const data = JSON.parse(await deps.readFile(file)) as Parameters<StigmergyEngine['restore']>[0]
      // requireExists=false: restore replaces/creates the substrate, so it works onto a fresh path.
      await withSubstrate(path, deps, false, (engine) => engine.restore(data))
      emit(deps, json, `Restored substrate at ${path} from ${file}`, { restored: path, from: file })
      return EXIT.OK
    }

    case 'reset': {
      if (flags.confirm !== true) throw new CliError('reset requires --confirm to wipe the substrate', EXIT.ARGS)
      await withSubstrate(path, deps, true, (engine) => engine.reset({ destroy: true }))
      emit(deps, json, `Substrate wiped at ${path}`, { reset: path })
      return EXIT.OK
    }

    case 'doctor': {
      const stats = await withSubstrate(path, deps, true, (engine) => engine.stats())
      emit(deps, json, `doctor: substrate ${path}\n${formatStats(stats)}\nstatus: ok`, { path, stats, status: 'ok' })
      return EXIT.OK
    }

    case 'status': {
      // Trust inspection (FEAT-02-06 SC-06): path, mode, cache, stats. Read-only in intent; like
      // doctor it opens the substrate (a normal SQLite open creates WAL sidecars), it never deletes.
      const cache = flagString(flags, 'cache') ?? defaultCachePath()
      const cacheExists = await deps.fileExists(cache)
      const mode = 'live' // dry-run is a follow-up slice (SC-04)
      const stats = await withSubstrate(path, deps, true, (engine) => engine.stats())
      const human = [
        `substrate: ${path}`,
        `mode:      ${mode}`,
        `model cache: ${cache} (${cacheExists ? 'present' : 'absent'})`,
        formatStats(stats),
      ].join('\n')
      emit(deps, json, human, { substrate: path, mode, modelCache: cache, modelCachePresent: cacheExists, stats })
      return EXIT.OK
    }

    case 'uninstall': {
      // Reversibility (FEAT-02-06 SC-02/03). connect is read-only in the MVP, so there are no
      // written adapter files to remove; uninstall removes the substrate (DB plus WAL/SHM siblings),
      // and --purge additionally removes the model cache with its own confirm. The substrate and the
      // cache are handled independently so `--purge` still cleans the cache when the DB is already gone.
      const purge = flags.purge === true
      const cache = flagString(flags, 'cache') ?? defaultCachePath()
      // Defense-in-depth (audit L-1): never recursively remove the filesystem root or the home
      // directory, even on confirm; a --path/--cache typo must not wipe the disk.
      if (isProtectedPath(path)) throw new CliError(`refusing to remove ${path}: filesystem root or home directory`, EXIT.ARGS)
      if (purge && isProtectedPath(cache)) throw new CliError(`refusing to remove ${cache}: filesystem root or home directory`, EXIT.ARGS)
      const substrateTargets: string[] = []
      for (const p of [path, `${path}-wal`, `${path}-shm`]) {
        if (await deps.fileExists(p)) substrateTargets.push(p)
      }
      const cacheTarget = purge && (await deps.fileExists(cache)) ? cache : undefined
      if (substrateTargets.length === 0 && !cacheTarget) {
        emit(deps, json, `Nothing to remove: no substrate at ${path}${purge ? ` or cache at ${cache}` : ''}`, { removed: [], path })
        return EXIT.OK
      }
      const removed: string[] = []
      if (substrateTargets.length > 0) {
        if (!(await deps.confirm(renderTrustDiff(substrateTargets, 'remove')))) {
          deps.out('Aborted.')
          return EXIT.OK
        }
        for (const t of substrateTargets) await deps.removePath(t)
        removed.push(...substrateTargets)
      }
      if (cacheTarget) {
        if (await deps.confirm(renderTrustDiff([cacheTarget], 'remove'))) {
          await deps.removePath(cacheTarget)
          removed.push(cacheTarget)
        } else {
          deps.out('Model cache kept.')
        }
      }
      emit(deps, json, `Removed: ${removed.join(', ')}`, { removed, path })
      return EXIT.OK
    }

    case 'connect': {
      let manifest: unknown = {}
      try {
        manifest = JSON.parse(await deps.readFile(`${deps.cwd}/package.json`))
      } catch {
        // no package.json; detectFramework will report 'unknown'
      }
      const detection = deps.detectFramework(manifest)
      emit(deps, json, `Detected framework: ${detection.framework}\nIntegration: ${detection.integration ?? '(none)'}\n\n${detection.snippet}`, detection)
      return EXIT.OK
    }

    case 'link': {
      const to = flagString(flags, 'to')
      if (!to) throw new CliError('link requires --to <path>', EXIT.ARGS)
      if (flags.migrate === true) {
        if (!(await deps.confirm(renderTrustDiff([`${to} (migrated from ${path})`])))) {
          deps.out('Aborted.')
          return EXIT.OK
        }
        const dump = await withSubstrate(path, deps, true, (engine) => engine.backup())
        await withSubstrate(to, deps, false, (engine) => engine.restore(dump))
        emit(deps, json, `Migrated substrate from ${path} to ${to}. Use --path ${to} for future commands.`, { from: path, to, migrated: true })
      } else {
        emit(deps, json, `Use --path ${to} to operate on that substrate. Add --migrate to copy data from ${path}.`, { to, migrated: false })
      }
      return EXIT.OK
    }

    default:
      throw new CliError(`unknown command '${command}' (try 'stigmergy --help')`, EXIT.ARGS)
  }
}

async function showCommand(
  path: string,
  flags: Record<string, string | boolean>,
  json: boolean,
  deps: CliDeps,
): Promise<ExitCode> {
  const taskId = flagString(flags, 'task')
  const filter = flagString(flags, 'filter')
  const capabilityId = flagString(flags, 'capability')
  return withSubstrate(path, deps, true, async (_engine, storage) => {
    if (capabilityId) {
      const cap = await storage.getCapability(capabilityId)
      if (!cap) throw new CliError(`capability '${capabilityId}' not found`, EXIT.NOT_FOUND)
      emit(deps, json, formatCapability(cap), cap)
      return EXIT.OK
    }
    if (taskId) {
      const task = await storage.getTask(taskId)
      if (!task) throw new CliError(`task '${taskId}' not found`, EXIT.NOT_FOUND)
      emit(deps, json, `task ${task.id}: ${task.outcome ?? 'pending'} path=${task.path.join(' -> ')} tokens=${task.tokenCost}`, task)
      return EXIT.OK
    }
    let edges = await storage.listEdges()
    if (filter) edges = edges.filter((e) => e.fromCapability === filter || e.toCapability === filter)
    const top = [...edges].sort((a, b) => b.pheromone - a.pheromone).slice(0, 20)
    emit(deps, json, formatEdges(top), { edges: top })
    return EXIT.OK
  })
}

function formatCapability(c: Capability): string {
  const lines = [`capability ${c.id} (${c.type})`, `  description: ${c.description}`]
  if (c.descriptionAugmented) {
    lines.push(`  augmented:   ${c.descriptionAugmented}`)
    lines.push(`  augmented by ${c.augmentedBy ?? '(unknown)'} at ${c.augmentedAt ?? '(unknown)'}`)
  } else {
    lines.push('  augmented:   (none; raw description in use)')
  }
  return lines.join('\n')
}

function formatStats(stats: SubstrateStats): string {
  return Object.entries(stats)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`)
    .join('\n')
}

function formatEdges(edges: Edge[]): string {
  if (edges.length === 0) return '(no edges)'
  return edges
    .map((e) => `  ${e.fromCapability} -> ${e.toCapability}  ph=${e.pheromone.toFixed(4)}${e.pinned ? ' [pinned]' : ''}`)
    .join('\n')
}
