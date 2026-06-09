import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createEngine, FakeEmbedding, FakeAugmenter } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { detectFramework } from '@stigmergy/connect'
import { run, type CliDeps } from './cli.js'
import { parseArgs, flagString } from './args.js'
import { parsePathExpression, defaultSubstratePath, isProtectedPath } from './paths.js'
import { renderTrustDiff } from './trust.js'
import { EXIT } from './exit-codes.js'
import { realDeps, confirm, main, isEntrypoint } from './bin.js'

// Stub the interactive readline prompt so the TTY branch of confirm() is testable
// without a pseudo-terminal. The non-TTY branch returns before createInterface.
const rl = vi.hoisted(() => ({ answer: 'y' }))
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: async () => rl.answer, close: () => undefined }),
}))

describe('parseArgs', () => {
  it('splits command, positionals and flags (value and boolean)', () => {
    const a = parseArgs(['pin', 'tool:a -> tool:b', '--behavior', 'enforce', '--json'], new Set(['json']))
    expect(a.command).toBe('pin')
    expect(a.positionals).toEqual(['tool:a -> tool:b'])
    expect(flagString(a.flags, 'behavior')).toBe('enforce')
    expect(a.flags.json).toBe(true)
  })

  it('supports --flag=value syntax', () => {
    const a = parseArgs(['stats', '--path=/x/y.db', '--behavior=enforce'])
    expect(flagString(a.flags, 'path')).toBe('/x/y.db')
    expect(flagString(a.flags, 'behavior')).toBe('enforce')
  })

  it('a known boolean flag does not swallow the following token', () => {
    const a = parseArgs(['stats', '--json', 'out.txt'], new Set(['json']))
    expect(a.flags.json).toBe(true)
    expect(a.positionals).toEqual(['out.txt'])
  })
})

describe('parsePathExpression', () => {
  it('splits on arrows and trims whitespace', () => {
    expect(parsePathExpression(' tool:a ->tool:b -> tool:c ')).toEqual(['tool:a', 'tool:b', 'tool:c'])
  })
  it('returns an empty list for an empty expression', () => {
    expect(parsePathExpression('   ')).toEqual([])
  })
})

describe('renderTrustDiff', () => {
  it('lists the targets, the local-only note and the default-No prompt', () => {
    const d = renderTrustDiff(['~/.stigmergy/pheromone.db'])
    expect(d).toContain('Stigmergy will write to:')
    expect(d).toContain('Network behavior: local-only by default.')
    expect(d).toContain('[y/N]')
  })
  it('frames a removal as a destructive recursive remove, not a write (FEAT-02-06)', () => {
    const d = renderTrustDiff(['/x/pheromone.db'], 'remove')
    expect(d).toContain('permanently remove')
    expect(d).not.toContain('will write to')
    expect(d).toContain('[y/N]')
  })
})

describe('defaultSubstratePath', () => {
  it('points under the home .stigmergy directory', () => {
    expect(defaultSubstratePath()).toMatch(/[/\\]\.stigmergy[/\\]pheromone\.db$/)
  })
})

function makeDeps(dir: string, confirmAnswer = true): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    makeStorage: async (path) => new BetterSqlite3Storage(path),
    makeEmbedding: () => new FakeEmbedding(),
    detectFramework: (m) => detectFramework(m as Parameters<typeof detectFramework>[0]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    confirm: async () => confirmAnswer,
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, c) => writeFile(p, c, 'utf8'),
    fileExists: async (p) => {
      try {
        await access(p)
        return true
      } catch {
        return false
      }
    },
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true })
    },
    removePath: async (p) => {
      await rm(p, { recursive: true, force: true })
    },
    cwd: dir,
  }
  return { deps, out, err }
}

async function seed(path: string): Promise<void> {
  const storage = new BetterSqlite3Storage(path)
  const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
  await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha' })
  await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta' })
  await engine.deposit({ task_id: 's1', context: 'alpha', path: ['tool:a'], outcome: 'accepted', token_cost: 500 })
  await engine.close()
}

describe('run: argument and not-found guards', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('prints help and exits 0 with no command', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-guard-'))
    const { deps, out } = makeDeps(dir)
    expect(await run([], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('Usage: stigmergy')
  })

  it('rejects reset without --confirm (exit 2)', async () => {
    const { deps } = makeDeps(dir)
    expect(await run(['reset', '--path', join(dir, 'x.db')], deps)).toBe(EXIT.ARGS)
  })

  it('returns not-found (exit 3) for a missing substrate', async () => {
    const { deps } = makeDeps(dir)
    expect(await run(['stats', '--path', join(dir, 'missing.db')], deps)).toBe(EXIT.NOT_FOUND)
  })

  it('rejects an unknown command (exit 2)', async () => {
    const { deps } = makeDeps(dir)
    expect(await run(['frobnicate'], deps)).toBe(EXIT.ARGS)
  })

  it('aborts init when the trust prompt is declined', async () => {
    const { deps, out } = makeDeps(dir, false) // confirm -> No
    const p = join(dir, 'declined.db')
    expect(await run(['init', '--path', p], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('Aborted')
    expect(await access(p).then(() => true, () => false)).toBe(false) // nothing written
  })
})

describe('run: full lifecycle on a real substrate (FEAT-01-06 SC-01..06)', () => {
  it('init, stats, pin, show, backup, reset, restore round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-life-'))
    const dbPath = join(dir, 'pheromone.db')
    const { deps, out } = makeDeps(dir)
    try {
      expect(await run(['init', '--path', dbPath], deps)).toBe(EXIT.OK)
      expect(await access(dbPath).then(() => true, () => false)).toBe(true)

      await seed(dbPath)

      out.length = 0
      expect(await run(['stats', '--path', dbPath], deps)).toBe(EXIT.OK)
      expect(out.join('\n')).toMatch(/capabilities/)

      expect(await run(['pin', 'tool:a -> tool:b', '--behavior', 'preferred', '--path', dbPath], deps)).toBe(EXIT.OK)

      out.length = 0
      expect(await run(['show', '--path', dbPath], deps)).toBe(EXIT.OK)
      expect(out.join('\n')).toMatch(/tool:a/)

      const backupFile = join(dir, 'backup.json')
      expect(await run(['backup', '--out', backupFile, '--path', dbPath], deps)).toBe(EXIT.OK)
      expect(await access(backupFile).then(() => true, () => false)).toBe(true)

      expect(await run(['reset', '--confirm', '--path', dbPath], deps)).toBe(EXIT.OK)
      out.length = 0
      await run(['stats', '--path', dbPath], deps)
      expect(out.join('\n')).toMatch(/edges: 0/)

      expect(await run(['restore', backupFile, '--path', dbPath], deps)).toBe(EXIT.OK)
      out.length = 0
      await run(['stats', '--path', dbPath], deps)
      expect(out.join('\n')).toMatch(/edges: [1-9]/) // edges restored
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a value-flag given without a value (exit 2, no silent stdout dump)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-flag-'))
    const dbPath = join(dir, 'pheromone.db')
    const { deps, out } = makeDeps(dir)
    try {
      expect(await run(['init', '--path', dbPath], deps)).toBe(EXIT.OK)
      out.length = 0
      // `backup --out` with the filename forgotten must error, not dump JSON to stdout.
      expect(await run(['backup', '--out', '--path', dbPath], deps)).toBe(EXIT.ARGS)
      expect(out.join('\n')).not.toMatch(/"version"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reinforce/weaken map argument errors to exit 2 (empty path, negative strength)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-reinf-'))
    const dbPath = join(dir, 'pheromone.db')
    const { deps } = makeDeps(dir)
    try {
      expect(await run(['init', '--path', dbPath], deps)).toBe(EXIT.OK)
      expect(await run(['reinforce', '->', '--strength', '0.5', '--path', dbPath], deps)).toBe(EXIT.ARGS)
      expect(await run(['reinforce', 'tool:a -> tool:b', '--strength', '-0.5', '--path', dbPath], deps)).toBe(EXIT.ARGS)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('connect reports the detected framework from the cwd package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-connect-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { ai: '^4.0.0' } }), 'utf8')
    const { deps, out } = makeDeps(dir)
    try {
      expect(await run(['connect'], deps)).toBe(EXIT.OK)
      expect(out.join('\n')).toMatch(/Detected framework/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Seeds a substrate with two capabilities and a tool:a -> tool:b edge plus a task.
async function seedRich(path: string): Promise<void> {
  const storage = new BetterSqlite3Storage(path)
  const engine = await createEngine({ storage, embedding: new FakeEmbedding() })
  await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'alpha search' })
  await engine.registerCapability({ id: 'tool:b', type: 'tool', description: 'beta read' })
  await engine.deposit({ task_id: 'task-1', context: 'alpha then beta', path: ['tool:a', 'tool:b'], outcome: 'accepted', token_cost: 800 })
  await engine.close()
}

describe('run: inspect and ops coverage (FEAT-01-06)', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('show --filter narrows to edges touching a capability', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-cov-'))
    const db = join(dir, 'f.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['show', '--filter', 'tool:b', '--path', db], deps)).toBe(EXIT.OK)
    const text = out.join('\n')
    expect(text).toMatch(/tool:a -> tool:b/)
    expect(text).not.toMatch(/__START__/)
  })

  it('show --task prints one task, and a missing task is exit 3', async () => {
    const db = join(dir, 't.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['show', '--task', 'task-1', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/task task-1/)
    expect(await run(['show', '--task', 'nope', '--path', db], deps)).toBe(EXIT.NOT_FOUND)
  })

  it('show on a fresh substrate reports no edges', async () => {
    const db = join(dir, 'empty.db')
    const { deps, out } = makeDeps(dir)
    expect(await run(['init', '--path', db], deps)).toBe(EXIT.OK)
    out.length = 0
    expect(await run(['show', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('(no edges)')
  })

  it('stats --json emits a parseable object; doctor reports ok', async () => {
    const db = join(dir, 'j.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['stats', '--json', '--path', db], deps)).toBe(EXIT.OK)
    const parsed = JSON.parse(out.join('\n')) as { capabilities: number; edges: number }
    expect(parsed.capabilities).toBeGreaterThanOrEqual(2)
    expect(parsed.edges).toBeGreaterThanOrEqual(1)
    out.length = 0
    expect(await run(['doctor', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/status: ok/)
  })

  it('pin then unpin removes the pin', async () => {
    const db = join(dir, 'p.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['pin', 'tool:a -> tool:b', '--behavior', 'enforce', '--name', 'flow', '--path', db], deps)).toBe(EXIT.OK)
    const pinId = (out.join('\n').match(/Pinned (\S+)/) ?? [])[1]
    expect(pinId).toBeTruthy()
    expect(await run(['unpin', pinId!, '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/Removed pin/)
  })

  it('export to --out writes a file, unknown id is exit 3, and import round-trips', async () => {
    const db = join(dir, 'x.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['pin', 'tool:a -> tool:b', '--behavior', 'preferred', '--path', db], deps)).toBe(EXIT.OK)
    const pinId = (out.join('\n').match(/Pinned (\S+)/) ?? [])[1]!
    const exportFile = join(dir, 'export.json')
    expect(await run(['export', pinId, '--out', exportFile, '--path', db], deps)).toBe(EXIT.OK)
    expect(await access(exportFile).then(() => true, () => false)).toBe(true)
    expect(await run(['export', 'missing-id', '--path', db], deps)).toBe(EXIT.NOT_FOUND)
    expect(await run(['import', exportFile, '--path', db], deps)).toBe(EXIT.OK)
  })

  it('reinforce and weaken a path succeed on known capabilities', async () => {
    const db = join(dir, 'r.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['reinforce', 'tool:a -> tool:b', '--strength', '0.5', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/Reinforced/)
    expect(await run(['weaken', 'tool:a -> tool:b', '--strength', '0.2', '--path', db], deps)).toBe(EXIT.OK)
  })

  it('link prints a hint without --migrate and copies data with --migrate', async () => {
    const db = join(dir, 'src.db')
    await seedRich(db)
    const target = join(dir, 'dest.db')
    const { deps, out } = makeDeps(dir)
    expect(await run(['link', '--to', target, '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/Use --path/)
    expect(await run(['link', '--to', target, '--migrate', '--path', db], deps)).toBe(EXIT.OK)
    expect(await access(target).then(() => true, () => false)).toBe(true)
    // the migrated substrate carries the edges
    out.length = 0
    await run(['stats', '--path', target], deps)
    expect(out.join('\n')).toMatch(/edges: [1-9]/)
  })

  it('link --migrate aborts when the trust prompt is declined', async () => {
    const db = join(dir, 'src2.db')
    await seedRich(db)
    const target = join(dir, 'dest2.db')
    const { deps, out } = makeDeps(dir, false) // confirm -> No
    expect(await run(['link', '--to', target, '--migrate', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('Aborted')
    expect(await access(target).then(() => true, () => false)).toBe(false)
  })

  it('show --capability shows the raw description and augmentation state (FEAT-01-07)', async () => {
    const db = join(dir, 'cap.db')
    const storage = new BetterSqlite3Storage(db)
    const engine = await createEngine({ storage, embedding: new FakeEmbedding(), augmenter: new FakeAugmenter({ model: 'fake-haiku' }) })
    await engine.registerCapability({ id: 'tool:rich', type: 'tool', description: 'read a file' })
    await engine.close()
    const { deps, out } = makeDeps(dir)
    expect(await run(['show', '--capability', 'tool:rich', '--path', db], deps)).toBe(EXIT.OK)
    const text = out.join('\n')
    expect(text).toMatch(/capability tool:rich/)
    expect(text).toMatch(/aug\(read a file\)/)
    expect(text).toMatch(/fake-haiku/)
    expect(await run(['show', '--capability', 'nope', '--path', db], deps)).toBe(EXIT.NOT_FOUND)
  })

  it('uninstall removes the substrate, declined keeps it, missing is a no-op (FEAT-02-06 SC-02)', async () => {
    const db = join(dir, 'uninst.db')
    await seedRich(db)
    const declined = makeDeps(dir, false) // confirm -> No
    expect(await run(['uninstall', '--path', db], declined.deps)).toBe(EXIT.OK)
    expect(await access(db).then(() => true, () => false)).toBe(true) // kept
    const { deps } = makeDeps(dir)
    expect(await run(['uninstall', '--path', db], deps)).toBe(EXIT.OK)
    expect(await access(db).then(() => true, () => false)).toBe(false) // removed
    const { deps: d2, out } = makeDeps(dir)
    expect(await run(['uninstall', '--path', db], d2)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/Nothing to remove/)
  })

  it('uninstall --purge removes the substrate and the model cache (FEAT-02-06 SC-03)', async () => {
    const db = join(dir, 'purge.db')
    const cache = join(dir, 'modelcache')
    await seedRich(db)
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'model.bin'), 'x', 'utf8')
    const { deps } = makeDeps(dir)
    expect(await run(['uninstall', '--purge', '--cache', cache, '--path', db], deps)).toBe(EXIT.OK)
    expect(await access(db).then(() => true, () => false)).toBe(false)
    expect(await access(cache).then(() => true, () => false)).toBe(false)
  })

  it('uninstall --purge removes the model cache even when the substrate is already gone (FEAT-02-06 review #1)', async () => {
    const db = join(dir, 'gone.db') // never created
    const cache = join(dir, 'orphancache')
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'm.bin'), 'x', 'utf8')
    const { deps, out } = makeDeps(dir)
    expect(await run(['uninstall', '--purge', '--cache', cache, '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).not.toMatch(/Nothing to remove/)
    expect(await access(cache).then(() => true, () => false)).toBe(false)
  })

  it('status shows substrate path, mode, cache and stats; missing is exit 3 (FEAT-02-06 SC-06)', async () => {
    const db = join(dir, 'status.db')
    const cache = join(dir, 'nocache')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['status', '--path', db, '--cache', cache], deps)).toBe(EXIT.OK)
    const text = out.join('\n')
    expect(text).toMatch(/substrate:/)
    expect(text).toMatch(/mode:\s+live/)
    expect(text).toMatch(/absent/)
    expect(text).toMatch(/capabilities/)
    out.length = 0
    expect(await run(['status', '--json', '--path', db, '--cache', cache], deps)).toBe(EXIT.OK)
    const parsed = JSON.parse(out.join('\n')) as { mode: string; modelCachePresent: boolean }
    expect(parsed.mode).toBe('live')
    expect(parsed.modelCachePresent).toBe(false)
    expect(await run(['status', '--path', join(dir, 'nope.db')], deps)).toBe(EXIT.NOT_FOUND)
  })
})

describe('bin: real-deps wiring (FEAT-01-06)', () => {
  it('confirm defaults to No in a non-interactive shell', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const tty = process.stdin.isTTY
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
      expect(await confirm('write?')).toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
      spy.mockRestore()
    }
  })

  it('confirm reads y/yes as yes and anything else as no on a TTY', async () => {
    const tty = process.stdin.isTTY
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      rl.answer = 'y'
      expect(await confirm('write?')).toBe(true)
      rl.answer = 'yes'
      expect(await confirm('write?')).toBe(true)
      rl.answer = 'n'
      expect(await confirm('write?')).toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
    }
  })

  it('realDeps drive a real better-sqlite3 lifecycle (stats, pin, export, backup)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-bin-'))
    const db = join(dir, 'pheromone.db')
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await seedRich(db)
      expect(await run(['stats', '--path', db], realDeps)).toBe(EXIT.OK)
      expect(await run(['connect'], realDeps)).toBe(EXIT.OK) // exercises realDeps.detectFramework + readFile(cwd)
      expect(await run(['pin', 'tool:a -> tool:b', '--behavior', 'preferred', '--path', db], realDeps)).toBe(EXIT.OK)
      const backupFile = join(dir, 'backup.json')
      expect(await run(['backup', '--out', backupFile, '--path', db], realDeps)).toBe(EXIT.OK)
      expect(await access(backupFile).then(() => true, () => false)).toBe(true) // realDeps.writeFile ran
      // realDeps.fileExists false-branch -> not found
      expect(await run(['stats', '--path', join(dir, 'missing.db')], realDeps)).toBe(EXIT.NOT_FOUND)
    } finally {
      outSpy.mockRestore()
      errSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('main maps the run exit code onto process.exitCode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-main-'))
    const db = join(dir, 'm.db')
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const prev = process.exitCode
    try {
      await seedRich(db)
      await main(['stats', '--path', db])
      expect(process.exitCode).toBe(EXIT.OK)
      await main(['frobnicate'])
      expect(process.exitCode).toBe(EXIT.ARGS)
    } finally {
      process.exitCode = prev
      outSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('run: code-review fixes (FEAT-01-06)', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('prints help for --help and -h as the sole argument (#3)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-rv-'))
    const { deps, out } = makeDeps(dir)
    expect(await run(['--help'], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('Usage: stigmergy')
    out.length = 0
    expect(await run(['-h'], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toContain('Usage: stigmergy')
  })

  it('supports --path=value (#15)', async () => {
    const db = join(dir, 'eq.db')
    const { deps } = makeDeps(dir)
    expect(await run(['init', `--path=${db}`], deps)).toBe(EXIT.OK)
    expect(await access(db).then(() => true, () => false)).toBe(true)
  })

  it('a stray token after a boolean flag does not corrupt --confirm (#6)', async () => {
    const db = join(dir, 'b.db')
    await seedRich(db)
    const { deps } = makeDeps(dir)
    expect(await run(['reset', '--confirm', 'stray', '--path', db], deps)).toBe(EXIT.OK)
  })

  it('init creates missing parent directories (#8)', async () => {
    const db = join(dir, 'nested', 'deep', 'pheromone.db')
    const { deps } = makeDeps(dir)
    expect(await run(['init', '--path', db], deps)).toBe(EXIT.OK)
    expect(await access(db).then(() => true, () => false)).toBe(true)
  })

  it('restore works onto a fresh path without a prior init (#1)', async () => {
    const src = join(dir, 'r-src.db')
    await seedRich(src)
    const backup = join(dir, 'r.json')
    const { deps } = makeDeps(dir)
    expect(await run(['backup', '--out', backup, '--path', src], deps)).toBe(EXIT.OK)
    const fresh = join(dir, 'freshdir', 'new.db')
    expect(await run(['restore', backup, '--path', fresh], deps)).toBe(EXIT.OK)
    const { deps: d2, out } = makeDeps(dir)
    await run(['stats', '--path', fresh], d2)
    expect(out.join('\n')).toMatch(/edges: [1-9]/)
  })

  it('a missing restore/import file is exit 3, not 1 (#9)', async () => {
    const db = join(dir, 'm.db')
    await seedRich(db)
    const { deps } = makeDeps(dir)
    expect(await run(['restore', join(dir, 'nope.json'), '--path', db], deps)).toBe(EXIT.NOT_FOUND)
    expect(await run(['import', join(dir, 'nope.json'), '--path', db], deps)).toBe(EXIT.NOT_FOUND)
  })

  it('rejects an empty --strength as an argument error (#7)', async () => {
    const db = join(dir, 's.db')
    await seedRich(db)
    const { deps } = makeDeps(dir)
    expect(await run(['reinforce', 'tool:a -> tool:b', '--strength', '', '--path', db], deps)).toBe(EXIT.ARGS)
  })

  it('reconstructs an unquoted multi-token path expression (#11)', async () => {
    const db = join(dir, 'u.db')
    await seedRich(db)
    const { deps, out } = makeDeps(dir)
    expect(await run(['reinforce', 'tool:a', '->', 'tool:b', '--strength', '0.5', '--path', db], deps)).toBe(EXIT.OK)
    expect(out.join('\n')).toMatch(/tool:a -> tool:b/)
  })

  it('reinforce rejects an unknown capability instead of creating a stub (#10)', async () => {
    const db = join(dir, 'g.db')
    await seedRich(db)
    const { deps } = makeDeps(dir)
    expect(await run(['reinforce', 'ghost:x -> ghost:y', '--strength', '0.5', '--path', db], deps)).not.toBe(EXIT.OK)
    // the typo must not have polluted the substrate
    const { deps: d2, out } = makeDeps(dir)
    await run(['show', '--path', db], d2)
    expect(out.join('\n')).not.toMatch(/ghost:/)
  })
})

describe('bin: isEntrypoint (#2)', () => {
  it('matches a symlinked argv1 by resolving its real path', () => {
    const meta = pathToFileURL('/real/dist/bin.js').href
    expect(isEntrypoint(meta, '/nm/.bin/stigmergy', () => '/real/dist/bin.js')).toBe(true)
  })
  it('returns false when argv1 resolves to a different module (test runner)', () => {
    const meta = pathToFileURL('/real/dist/bin.js').href
    expect(isEntrypoint(meta, '/usr/bin/vitest', (p) => p)).toBe(false)
  })
  it('returns false when argv1 is undefined', () => {
    expect(isEntrypoint('file:///x', undefined, (p) => p)).toBe(false)
  })
  it('falls back to the raw argv1 when realpath resolution throws', () => {
    expect(
      isEntrypoint('file:///real/dist/bin.js', '/x', () => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })
  it('realDeps.mkdirp creates nested directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-mkdirp-'))
    try {
      const nested = join(dir, 'a', 'b', 'c')
      await realDeps.mkdirp(nested)
      expect(await access(nested).then(() => true, () => false)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('uninstall roundtrip is stable and leaves no residue (FEAT-02-06 DoD)', () => {
  it('init -> seed -> uninstall --purge -> init re-creates a clean substrate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-roundtrip-'))
    const db = join(dir, 'pheromone.db')
    const cache = join(dir, 'models')
    const { deps, out } = makeDeps(dir)
    try {
      // Install plus seed learned data and a model-cache directory.
      expect(await run(['init', '--path', db], deps)).toBe(EXIT.OK)
      await seedRich(db)
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, 'model.bin'), 'x', 'utf8')
      out.length = 0
      await run(['stats', '--path', db], deps)
      expect(out.join('\n')).toMatch(/edges: [1-9]/) // substrate carries learned data

      // Uninstall --purge removes the substrate (plus WAL/SHM) and the cache: no residue.
      expect(await run(['uninstall', '--purge', '--cache', cache, '--path', db], deps)).toBe(EXIT.OK)
      for (const p of [db, `${db}-wal`, `${db}-shm`, cache]) {
        expect(await access(p).then(() => true, () => false)).toBe(false)
      }

      // Re-init at the same path produces a fresh, clean substrate (no leftover edges).
      expect(await run(['init', '--path', db], deps)).toBe(EXIT.OK)
      out.length = 0
      await run(['stats', '--path', db], deps)
      expect(out.join('\n')).toMatch(/edges: 0/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('uninstall refuses to remove protected paths (FEAT-02-06 audit L-1)', () => {
  it('isProtectedPath flags the filesystem root and the home directory, not a substrate file', () => {
    expect(isProtectedPath('/')).toBe(true)
    expect(isProtectedPath(homedir())).toBe(true)
    expect(isProtectedPath(join(homedir(), '.stigmergy', 'pheromone.db'))).toBe(false)
  })

  it('uninstall --path / is rejected (exit 2) and never calls removePath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-guard-rm-'))
    const { deps } = makeDeps(dir)
    const removeSpy = vi.fn(async () => undefined) // never touch the real filesystem
    deps.removePath = removeSpy
    try {
      expect(await run(['uninstall', '--path', '/'], deps)).toBe(EXIT.ARGS)
      expect(removeSpy).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uninstall --purge --cache <home> is rejected before any deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-guard-cache-'))
    const db = join(dir, 'x.db')
    await seedRich(db)
    const { deps } = makeDeps(dir)
    const removeSpy = vi.fn(async () => undefined)
    deps.removePath = removeSpy
    try {
      expect(await run(['uninstall', '--purge', '--cache', homedir(), '--path', db], deps)).toBe(EXIT.ARGS)
      expect(removeSpy).not.toHaveBeenCalled() // substrate is not removed either when the guard trips
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
