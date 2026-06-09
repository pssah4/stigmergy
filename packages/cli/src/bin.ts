#!/usr/bin/env node
// The installed `stigmergy` executable. Wires the concrete dependencies and maps the
// returned exit code to process.exitCode. No MVP command consults, so the engine never embeds; the
// inert embedding below satisfies the constructor without pulling the native model backend and, unlike
// a fake, throws loudly if a future consult-style command ever calls it before the real local model is
// wired here (no fakes in the production path, ADR-25/IMP-05-06-02).
// The deps and confirm() are exported so the wiring is testable without spawning a
// process; the auto-run at the bottom only fires when this file is the executed entry.
import { readFile, writeFile, access, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import type { EmbeddingPort } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { detectFramework } from '@stigmergy/connect'
import { run, type CliDeps } from './cli.js'

/** The CLI runs no consult, so it never embeds. This inert port keeps createEngine happy without a fake
 * or the native model backend; it throws if ever invoked, so adding a consult command fails loudly until
 * the real local embedding is wired (TransformersEmbedding), rather than silently faking results. */
const noEmbedding: EmbeddingPort = {
  embed() {
    throw new Error('stigmergy CLI performs no consults; wire the real local embedding before adding one')
  },
  dimension: () => 0,
  modelHash: () => 'none',
}

export async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${prompt}\n(non-interactive; defaulting to No)\n`)
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${prompt} `)).trim().toLowerCase()
  rl.close()
  return answer === 'y' || answer === 'yes'
}

export const realDeps: CliDeps = {
  makeStorage: async (path) => new BetterSqlite3Storage(path),
  makeEmbedding: () => noEmbedding,
  detectFramework: (manifest) => detectFramework(manifest as Parameters<typeof detectFramework>[0]),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  confirm,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  fileExists: async (path) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  mkdirp: async (path) => {
    // 0700: the substrate dir holds the db, the daemon lock and the consult socket; restrict it to
    // the owner so another local user cannot read the inventory or query the socket (AUDIT EPIC-04 M-1).
    await mkdir(path, { recursive: true, mode: 0o700 })
  },
  removePath: async (path) => {
    await rm(path, { recursive: true, force: true })
  },
  cwd: process.cwd(),
}

/** Run the CLI with the real deps and map the result to process.exitCode. */
export async function main(argv: readonly string[], deps: CliDeps = realDeps): Promise<void> {
  try {
    process.exitCode = await run(argv, deps)
  } catch (e: unknown) {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
}

// True when this module is the executed entry point. process.argv[1] may be a symlink
// (npm installs the bin into node_modules/.bin), while import.meta.url is the canonical
// real path; resolve the symlink before comparing, or the installed CLI never runs.
export function isEntrypoint(
  metaUrl: string,
  argv1: string | undefined,
  resolve: (p: string) => string = realpathSync,
): boolean {
  if (argv1 === undefined) return false
  let real: string
  try {
    real = resolve(argv1)
  } catch {
    real = argv1
  }
  return metaUrl === pathToFileURL(real).href
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main(process.argv.slice(2))
}
