/**
 * Electron main process for Stigmergy Studio (FEAT-03-01, ADR-15).
 *
 * Opens the pheromone substrate read-only over WAL (so a loop can keep writing while the app
 * reads), polls it every 2s, builds a lean SubstrateSnapshot and pushes it to the renderer on the
 * SUBSTRATE_CHANNEL. The renderer feeds that snapshot through the unit-tested toGraphModel before
 * handing it to Sigma. The Studio never holds a write lock for reads; WAL carries one writer plus
 * the reading app (ADR-02, ADR-15).
 *
 * Entry-point. Built by electron-vite (not part of the library tsc -b).
 */
import { app, BrowserWindow, ipcMain, session, dialog, safeStorage } from 'electron'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import { createEngine, type StigmergyEngine, type RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { detectFramework, type FrameworkDetection } from '@stigmergy/connect'
import { scanSkillDirectory, discoverMcpTools, ingestDiscovered } from '@stigmergy/discovery'
import {
  buildApiHandler,
  encryptCredentialsInPlace,
  decryptCredentialsInPlace,
  fetchModels,
  type ApiHandler,
  type ProviderType,
  type SettingsCrypter,
  type DiscoveryConfig,
} from '@stigmergy/llm'
import {
  SUBSTRATE_CHANNEL,
  type SubstrateMessage,
  type EditResult,
  type WriteAdapterResult,
  type OpResult,
  type SaveSettingsResult,
  type DaemonStatus,
  type ProviderTestResult,
  type ModelListResult,
} from '../shared/ipc.js'
import { applyEditCommand, type EditCommand } from '../shared/edit-commands.js'
import { buildAdapterFile } from '../shared/connect-adapter.js'
import {
  defaultSettings,
  mergeSettings,
  validateSettings,
  resolveActiveProvider,
  resolveActiveEmbeddingModel,
  encryptProviderConfigsInPlace,
  decryptProviderConfigsInPlace,
  cloneSettingsForPersist,
  type StudioSettings,
  type ProviderConfig,
} from '../shared/settings.js'
import { canProbe } from '../shared/provider-settings.js'
import { proposePathName, type ProposedName } from '../shared/path-naming.js'
import { toWorkflowMarkdown, parseWorkflowMarkdown } from '../shared/workflow-bridge.js'
import { resolveWorkflowDir } from '../shared/integrations.js'
import { studioEngineModels } from '../shared/studio-models.js'
import { parseAgentModels, type ImportedModels } from '../shared/agent-import.js'
import { readSnapshotFromDb, readConnectionTasks } from '../shared/snapshot-mapping.js'
import { appendLogLines, shouldRestart, restartDelayMs } from '../shared/daemon-supervisor.js'
import { resolveSubstratePath } from '../shared/substrate-path.js'
import type { ConnectionTask, SubstrateSnapshot } from '../shared/graph-model.js'

/** Resolve the substrate path from argv/env/default (see substrate-path.ts for the precedence). */
function activeDefaultPath(): string {
  return resolveSubstratePath(process.argv, process.env, homedir())
}

const POLL_MS = 2000
const dirName = dirname(fileURLToPath(import.meta.url))

/**
 * Read a snapshot from a read-only WAL connection. fileMustExist guards against creating an empty
 * DB at the wrong path; readonly guarantees the Studio never writes while a loop owns the file. The
 * row-to-view mapping lives in snapshot-mapping.ts so it is testable without loading Electron.
 */
function readSnapshot(path: string): SubstrateSnapshot {
  // busy_timeout so a concurrent writer mid-checkpoint yields SQLITE_BUSY waits, not instant errors.
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 })
  try {
    return readSnapshotFromDb(db)
  } finally {
    db.close()
  }
}

/** Edge provenance (BL-012): the recent tasks that traversed a learned connection, read read-only on a
 * fresh connection (same pattern as readSnapshot). Empty when the substrate file does not exist yet. */
function readConnectionTasksFor(from: string, to: string): ConnectionTask[] {
  if (!existsSync(activeSubstratePath)) return []
  const db = new Database(activeSubstratePath, { readonly: true, fileMustExist: true, timeout: 5000 })
  try {
    return readConnectionTasks(db, from, to)
  } finally {
    db.close()
  }
}

// The active substrate path. Starts from argv/default, then settings may override it at startup,
// and saveSettings can switch it at runtime (SC-02). Shared across windows (macOS dock re-open).
let activeSubstratePath = activeDefaultPath()
const isDev = Boolean(process.env['ELECTRON_RENDERER_URL'])

let mainWindow: BrowserWindow | null = null
let settings: StudioSettings = defaultSettings

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

// Encrypt the naming-LLM API key at rest via Electron safeStorage (ADR-11, FEAT-04-07). The in-memory
// settings hold the plaintext key (so the provider can use it); only the file on disk is encrypted.
// If safeStorage is unavailable, the key stays plaintext (documented fallback, like the CLI).
const ENC_PREFIX = 'safestorage:v1:'
const CRED_KEYS = ['namingApiKey'] as const
const electronCrypter: SettingsCrypter = {
  isEncrypted: (v) => v.startsWith(ENC_PREFIX),
  encrypt: (v) => {
    try {
      if (safeStorage.isEncryptionAvailable()) return ENC_PREFIX + safeStorage.encryptString(v).toString('base64')
    } catch {
      /* fall through to plaintext */
    }
    return v
  },
  decrypt: (v) => {
    if (!v.startsWith(ENC_PREFIX)) return v
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return '' // unreadable on this machine/keychain: drop it rather than surface ciphertext
    }
  },
}

/** Persist the in-memory settings to disk with credential fields encrypted (FEAT-04-07, FEAT-05-02).
 * providerConfigs are deep-copied before encryption so the in-memory keys stay plaintext for use. */
async function persistSettings(): Promise<void> {
  // Clone the credential-bearing nested arrays before encrypting in place, so the live in-memory
  // settings keep their plaintext keys (FIX-05-02-01). Encrypting a shared embeddingModels object in
  // place would leave the live embedding apiKey as ciphertext and the next embed would send it as the
  // bearer token (HTTP 401).
  const onDisk = cloneSettingsForPersist(settings)
  encryptCredentialsInPlace(onDisk as unknown as Record<string, unknown>, CRED_KEYS, electronCrypter)
  encryptProviderConfigsInPlace(onDisk, electronCrypter)
  const file = settingsFile()
  await writeFile(file, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 })
  // chmod explicitly: writeFile's mode applies only on creation, so an existing file keeps its old
  // mode. The naming key (encrypted, or plaintext on the safeStorage fallback) must stay owner-only
  // so another local user cannot read it (AUDIT EPIC-04 L-2).
  await chmod(file, 0o600).catch(() => {
    /* best-effort: a platform without POSIX modes (Windows) ignores this */
  })
}

/** Load persisted settings; a missing, unreadable, or invalid file falls back to the defaults so a
 * hand-edited corrupt file cannot poison the app (SC-01). */
function loadSettings(): StudioSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return defaultSettings
    const merged = mergeSettings(parsed as Partial<StudioSettings>)
    decryptCredentialsInPlace(merged as unknown as Record<string, unknown>, CRED_KEYS, electronCrypter)
    decryptProviderConfigsInPlace(merged, electronCrypter)
    return validateSettings(merged).length === 0 ? merged : defaultSettings
  } catch {
    return defaultSettings
  }
}

/** Read the substrate and push it to the renderer. Used by the poll timer and right after an edit
 * so the map reflects a write without waiting for the next 2s tick. */
function pushSnapshot(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  let message: SubstrateMessage
  try {
    message = { snapshot: readSnapshot(activeSubstratePath), substratePath: activeSubstratePath, connectedProject: settings.connectedProject }
  } catch (err) {
    message = {
      snapshot: { capabilities: [], edges: [] },
      error: err instanceof Error ? err.message : String(err),
      substratePath: activeSubstratePath,
      connectedProject: settings.connectedProject,
    }
  }
  win.webContents.send(SUBSTRATE_CHANNEL, message)
}

/** Read a loop project's package.json and propose the matching integration (ASR #1: same as the
 * CLI `stigmergy connect`). A missing or unreadable manifest yields the 'unknown' detection. */
async function detectFrameworkAt(dir: string): Promise<FrameworkDetection> {
  let manifest: Parameters<typeof detectFramework>[0] = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    // Only an object manifest is usable; a scalar/array/null package.json reports 'unknown'.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as Parameters<typeof detectFramework>[0]
    }
  } catch {
    // no readable package.json; detectFramework reports 'unknown'
  }
  return detectFramework(manifest)
}

/** Write the adapter file into the loop project after the renderer showed its diff and confirmed.
 * Refuses to overwrite an existing file so a hand-written adapter is never clobbered (the user
 * deletes it to regenerate). */
async function writeAdapter(dir: string, detection: FrameworkDetection): Promise<string> {
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`)
  // Embed the substrate the Studio actually reads, so the loop's engine writes to the same DB.
  const file = buildAdapterFile(detection, activeSubstratePath)
  const target = join(dir, file.filename)
  if (existsSync(target)) throw new Error(`${target} already exists. Remove it first to regenerate.`)
  await writeFile(target, file.content, 'utf8')
  return target
}

/** Build an ApiHandler from environment config (the same provider layer as FEAT-01-07, ADR-11), or
 * null when no provider is configured. Without a handler, naming falls back to an id-name (SC-04). */
function namingApiHandler(): ApiHandler | null {
  // The Studio's active provider wins (FEAT-04-07/FEAT-05-02: the Studio owns its naming model); fall
  // back to STIGMERGY_LLM_* env for existing/CLI setups when no UI provider is configured.
  const provider = resolveActiveProvider(settings)
  if (provider) {
    try {
      return buildApiHandler({
        type: provider.type,
        model: provider.model,
        apiKey: provider.apiKey || undefined,
        baseUrl: provider.baseUrl || undefined,
      })
    } catch {
      /* fall through to env */
    }
  }
  const type = process.env['STIGMERGY_LLM_PROVIDER']
  const model = process.env['STIGMERGY_LLM_MODEL']
  if (!type || !model) return null
  try {
    return buildApiHandler({
      type: type as ProviderType,
      model,
      apiKey: process.env['STIGMERGY_LLM_API_KEY'],
      baseUrl: process.env['STIGMERGY_LLM_BASE_URL'],
    })
  } catch {
    return null
  }
}

/**
 * Run a function against an on-demand read-write engine, then close it. Opening per operation (like
 * the CLI) keeps the Studio from holding a write lock between operations; the read poll stays on its
 * own read-only connection. The existsSync guard mirrors the read path's fileMustExist so a wrong
 * path never silently creates a ghost DB. The embedding and optional augmenter come from the Studio's
 * own model config (FEAT-04-07): the default is FakeEmbedding (light, no model), 'transformers' wires
 * a real local model so discovery-ingested capabilities are embedded and stamped with that model.
 */
async function withWriteEngine<T>(fn: (engine: StigmergyEngine) => Promise<T>): Promise<T> {
  if (!existsSync(activeSubstratePath)) throw new Error(`Substrate not found at ${activeSubstratePath}`)
  const storage = new BetterSqlite3Storage(activeSubstratePath)
  let engine: StigmergyEngine
  try {
    // createEngine runs storage.init(); if that throws (corrupt file, failed migration), the
    // already-open storage handle must still be closed, otherwise it leaks (mirrors the CLI).
    const { embedding, augmenter } = studioEngineModels(settings)
    engine = await createEngine({ storage, embedding, augmenter })
  } catch (err) {
    await storage.close()
    throw err
  }
  try {
    return await fn(engine)
  } finally {
    await engine.close()
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Daemon lifecycle (FEAT-04-04, ADR-20): the Studio spawns and manages the daemon as a child process,
// so the operator controls it entirely from the UI (no terminal). The daemon embeds + names + serves
// consult on a socket; it inherits the Studio's naming-model env so both share one model identity.
let daemonChild: ChildProcess | null = null
let daemonError: string | undefined
// Supervision state (FEAT-04-09 P1-5): restart a crashed daemon with backoff, capture its output so a
// crash is visible, and never restart one the operator stopped.
let daemonIntentionalStop = false
let daemonAttempt = 0
let daemonLog: string[] = []
let daemonRestartTimer: ReturnType<typeof setTimeout> | null = null

function daemonSocketPath(): string {
  return `${activeSubstratePath}.daemon.sock`
}

/** Public entry: an operator-initiated start. Resets the crash-restart counter and the intentional-stop
 * flag, then spawns. Crash-restarts go through spawnDaemon directly so they keep the attempt counter. */
function startDaemonProcess(): OpResult {
  if (daemonChild && daemonChild.exitCode === null) return { ok: true, message: 'Daemon already running' }
  if (!existsSync(activeSubstratePath)) return { ok: false, error: `Substrate not found at ${activeSubstratePath}` }
  daemonIntentionalStop = false
  daemonAttempt = 0
  daemonLog = []
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer)
    daemonRestartTimer = null
  }
  return spawnDaemon()
}

function spawnDaemon(): OpResult {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', STIGMERGY_DAEMON_SOCKET: daemonSocketPath() }
    // Hand the Studio's active provider to the daemon so emergent naming uses the same provider
    // (FEAT-04-07, FEAT-05-02: resolved from providerConfigs, flat fallback inside the resolver).
    const provider = resolveActiveProvider(settings)
    if (provider) {
      env['STIGMERGY_LLM_PROVIDER'] = provider.type
      env['STIGMERGY_LLM_MODEL'] = provider.model
      // Set the key from the active provider, or DELETE the inherited one: a keyless local provider
      // (ollama/lmstudio/custom with no key) must never send a stale shell-inherited API key to its
      // endpoint (which may be a different, remote provider). Same for the base URL.
      if (provider.apiKey) env['STIGMERGY_LLM_API_KEY'] = provider.apiKey
      else delete env['STIGMERGY_LLM_API_KEY']
      if (provider.baseUrl) env['STIGMERGY_LLM_BASE_URL'] = provider.baseUrl
      else delete env['STIGMERGY_LLM_BASE_URL']
    }
    // Hand the Studio's EMBEDDING model to the daemon (FEAT-04-09, FEAT-05-06). 'transformers' propagates
    // the local model; an API provider propagates provider/model/key/baseUrl. 'disabled' leaves the
    // daemon's own default (the real model) intact -- it must NOT force FakeEmbedding (review w4pg93b97).
    const embModel = resolveActiveEmbeddingModel(settings)
    if (embModel.provider === 'transformers') {
      env['STIGMERGY_EMBEDDING_PROVIDER'] = 'transformers'
      if (embModel.modelId.trim() !== '') env['STIGMERGY_EMBEDDING_MODEL'] = embModel.modelId
    } else if (embModel.provider !== 'disabled') {
      env['STIGMERGY_EMBEDDING_PROVIDER'] = embModel.provider
      if (embModel.modelId.trim() !== '') env['STIGMERGY_EMBEDDING_MODEL'] = embModel.modelId
      if (embModel.apiKey) env['STIGMERGY_EMBEDDING_API_KEY'] = embModel.apiKey
      else delete env['STIGMERGY_EMBEDDING_API_KEY']
      if (embModel.baseUrl) env['STIGMERGY_EMBEDDING_BASE_URL'] = embModel.baseUrl
      else delete env['STIGMERGY_EMBEDDING_BASE_URL']
    }
    const binPath = createRequire(import.meta.url).resolve('@stigmergy/daemon/bin')
    daemonError = undefined
    // Bind this spawn to the substrate it was started for, so a crash-restart never runs against a
    // different database the operator opened in the meantime (review w4pg93b97).
    const pathAtSpawn = activeSubstratePath
    // Pipe stdout/stderr into a rolling log so a crash is diagnosable (was 'ignore', a silent death).
    const child = spawn(process.execPath, [binPath, activeSubstratePath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const capture = (chunk: Buffer): void => {
      daemonLog = appendLogLines(daemonLog, chunk.toString())
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('error', (e) => {
      daemonError = e.message
      if (daemonChild === child) daemonChild = null
    })
    child.on('exit', (code) => {
      if (daemonChild === child) daemonChild = null
      if (code === 4) {
        // Definitive refusal, not a crash: another daemon already holds this substrate's role lock.
        daemonError = 'another Stigmergy daemon already owns this substrate -- stop it first (or it is the same one already running)'
      } else if (code === 2) {
        daemonError = 'daemon could not start: missing substrate path'
      } else if (code && code !== 0) {
        daemonError = `daemon exited with code ${code}`
      }
      // Restart only a real crash (not an operator stop, clean exit, or terminal refusal), with backoff.
      if (shouldRestart({ intentional: daemonIntentionalStop, code, attempt: daemonAttempt })) {
        const delay = restartDelayMs(daemonAttempt)
        daemonAttempt++
        daemonRestartTimer = setTimeout(() => {
          daemonRestartTimer = null
          // Do not respawn if the operator stopped it or opened a different substrate meanwhile.
          if (!daemonIntentionalStop && activeSubstratePath === pathAtSpawn) spawnDaemon()
        }, delay)
        daemonRestartTimer.unref?.()
      } else if (!daemonIntentionalStop && code && code !== 0 && code !== 4 && code !== 2) {
        daemonError = `daemon exited with code ${code} (gave up after ${daemonAttempt} restarts)`
      }
    })
    daemonChild = child
    return { ok: true, message: 'Daemon started' }
  } catch (err) {
    daemonError = errorMessage(err)
    return { ok: false, error: daemonError }
  }
}

function stopDaemonProcess(): OpResult {
  daemonIntentionalStop = true
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer)
    daemonRestartTimer = null
  }
  if (daemonChild) {
    daemonChild.kill('SIGTERM')
    daemonChild = null
  }
  return { ok: true, message: 'Daemon stopped' }
}

function daemonStatusValue(): DaemonStatus {
  return {
    running: Boolean(daemonChild && daemonChild.exitCode === null),
    pid: daemonChild?.pid,
    error: daemonError,
    restarts: daemonAttempt,
    recentLog: daemonLog.slice(-20),
  }
}

/** Push a fresh snapshot after a write; a failed refresh must not fail the operation. */
function safeRefresh(): void {
  try {
    pushSnapshot()
  } catch {
    /* the next poll will refresh */
  }
}

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }]

// dialog.show*Dialog has no overload accepting an undefined parent, so branch on the window.
function showSave(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  return mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options)
}
function showOpen(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)
}

/** Register the substrate operations (FEAT-03-04): backup/restore/export/import/reset. File
 * operations go through Electron dialogs; restore/reset are gated by the renderer's confirm. */
function registerOperationHandlers(): void {
  ipcMain.handle('studio:backup', async (): Promise<OpResult> => {
    try {
      const res = await showSave({ defaultPath: 'stigmergy-backup.json', filters: JSON_FILTER })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      const dump = await withWriteEngine((engine) => engine.backup())
      await writeFile(res.filePath, JSON.stringify(dump, null, 2), 'utf8')
      return { ok: true, message: `Backup written to ${res.filePath}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('studio:restore', async (): Promise<OpResult> => {
    try {
      const res = await showOpen({ properties: ['openFile'], filters: JSON_FILTER })
      const file = res.filePaths[0]
      if (res.canceled || !file) return { ok: false, canceled: true }
      const data = JSON.parse(await readFile(file, 'utf8'))
      await withWriteEngine((engine) => engine.restore(data))
      safeRefresh()
      return { ok: true, message: `Restored from ${file}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('studio:exportPath', async (_event, pathId: string): Promise<OpResult> => {
    try {
      const exported = await withWriteEngine((engine) => engine.exportPath(pathId))
      if (!exported) return { ok: false, error: `Unknown path: ${pathId}` }
      const res = await showSave({ defaultPath: `${pathId}.json`, filters: JSON_FILTER })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      await writeFile(res.filePath, JSON.stringify(exported, null, 2), 'utf8')
      return { ok: true, message: `Path exported to ${res.filePath}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('studio:importPath', async (): Promise<OpResult> => {
    try {
      const res = await showOpen({ properties: ['openFile'], filters: JSON_FILTER })
      const file = res.filePaths[0]
      if (res.canceled || !file) return { ok: false, canceled: true }
      const data = JSON.parse(await readFile(file, 'utf8'))
      await withWriteEngine((engine) => engine.importPath(data))
      safeRefresh()
      return { ok: true, message: `Path imported from ${file}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('studio:reset', async (): Promise<OpResult> => {
    try {
      await withWriteEngine((engine) => engine.reset({ destroy: true }))
      safeRefresh()
      return { ok: true, message: 'Substrate reset.' }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  // FEAT-03-08: generic portable-workflow export/import. A pinned path is a portable workflow; an
  // optional named integration (e.g. Vault Operator) only adds a subdirectory under the workflow root.
  const MARKDOWN_FILTER = [{ name: 'Markdown', extensions: ['md'] }]
  ipcMain.handle('studio:exportWorkflow', async (_event, pathId: string, integrationId?: string): Promise<OpResult> => {
    try {
      const path = await withWriteEngine((engine) => engine.getPath(pathId))
      if (!path) return { ok: false, error: `Unknown path: ${pathId}` }
      const md = toWorkflowMarkdown({
        name: path.name ?? path.id,
        description: path.description ?? '',
        behavior: path.behavior,
        capabilitySequence: path.capabilitySequence,
        parametersTemplate: path.parametersTemplate, // carry it so the round-trip is lossless (SC-03)
      })
      const safeName = (path.name ?? path.id).replace(/[^\w.-]+/g, '-')
      const dir = resolveWorkflowDir(settings.workflowRoot, integrationId)
      const res = await showSave({ defaultPath: dir ? join(dir, `${safeName}.md`) : `${safeName}.md`, filters: MARKDOWN_FILTER })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      await writeFile(res.filePath, md, 'utf8')
      return { ok: true, message: `Workflow exported: ${res.filePath}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('studio:importWorkflow', async (): Promise<OpResult> => {
    try {
      const res = await showOpen({ properties: ['openFile'], filters: MARKDOWN_FILTER })
      const file = res.filePaths[0]
      if (res.canceled || !file) return { ok: false, canceled: true }
      const doc = parseWorkflowMarkdown(await readFile(file, 'utf8'))
      if (!doc) return { ok: false, error: 'Not a valid workflow file (frontmatter with name, behavior, steps expected).' }
      await withWriteEngine(async (engine) => {
        // Pre-check so a missing capability yields a clear message, not a raw FK-constraint error.
        const known = new Set((await engine.listCapabilities()).map((c) => c.id))
        const missing = doc.capabilitySequence.filter((id) => !known.has(id))
        if (missing.length > 0) {
          throw new Error(`These tools are missing from the memory: ${missing.join(', ')}. Register them first.`)
        }
        return engine.pinPath({
          name: doc.name,
          description: doc.description,
          behavior: doc.behavior,
          capability_sequence: doc.capabilitySequence,
          parameters_template: doc.parametersTemplate,
        })
      })
      safeRefresh()
      return { ok: true, message: `Workflow imported: ${doc.name}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
}

/** Strict CSP for the production document. Not applied in dev: electron-vite serves the renderer
 * over http with inline scripts, eval and a websocket for HMR, which a strict policy would block. */
function applyProductionCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"],
      },
    })
  })
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    // Floor the window so the top bar (tabs + connection chip + mode/toggle cluster) never overflows; the
    // intrinsic width of that row is ~900px (FEAT-06-08 stage-3 review).
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1e2127',
    webPreferences: {
      preload: join(dirName, '../preload/index.mjs'),
      sandbox: false,
    },
  })
  mainWindow = win

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) await win.loadURL(devUrl)
  else await win.loadFile(join(dirName, '../renderer/index.html'))

  pushSnapshot()
  const timer = setInterval(pushSnapshot, POLL_MS)
  win.on('closed', () => {
    clearInterval(timer)
    if (mainWindow === win) mainWindow = null
  })
}

/** Default-on (operator request): on launch, bring Stigmergy up so the operator never has to flip the
 * Active toggle. Set enabled=true first, then start the daemon. Order matters: setRuntimeFlag opens its
 * own short-lived write engine, which must finish and close BEFORE the daemon takes the substrate's role
 * lock (two writers would collide). Guarded on the substrate existing, so a fresh install with no
 * substrate stays in onboarding. Best-effort: a failed enable never blocks the daemon start, and a failed
 * daemon start surfaces via the status bar (daemonStatus.error). */
async function autoActivateOnStartup(): Promise<void> {
  if (!existsSync(activeSubstratePath)) return
  try {
    await withWriteEngine((engine) => engine.setRuntimeFlag('enabled', '1'))
    safeRefresh()
  } catch {
    /* a substrate write failure shows up via the standing substrate error; still try the daemon */
  }
  startDaemonProcess()
}

app.whenReady().then(() => {
  // Load persisted settings; a stored substrate path overrides argv/default (SC-01/SC-02).
  settings = loadSettings()
  if (settings.substratePath) activeSubstratePath = settings.substratePath

  // Register IPC and CSP once, before any window. Re-opening via the dock must not re-register.
  ipcMain.handle('studio:connectionTasks', (_event, from: string, to: string): ConnectionTask[] => readConnectionTasksFor(from, to))
  ipcMain.handle('studio:substratePath', () => activeSubstratePath)
  ipcMain.handle('studio:getSettings', () => settings)
  ipcMain.handle('studio:saveSettings', async (_event, next: StudioSettings): Promise<SaveSettingsResult> => {
    const errors = validateSettings(next)
    if (errors.length > 0) return { ok: false, errors }
    // A non-empty path must exist; otherwise the switch would leave every read/write failing with
    // "Substrate not found" and the user locked out of an empty map (empty path = default, allowed).
    if (next.substratePath && !existsSync(next.substratePath)) {
      return { ok: false, errors: [`Substrat nicht gefunden: ${next.substratePath}`] }
    }
    settings = mergeSettings(next)
    try {
      await persistSettings()
    } catch (err) {
      return { ok: false, errors: [errorMessage(err)] }
    }
    // A path change switches the poll connection to the new substrate (SC-02).
    const desired = settings.substratePath || activeDefaultPath()
    if (desired !== activeSubstratePath) {
      activeSubstratePath = desired
      safeRefresh()
    }
    return { ok: true }
  })
  ipcMain.handle('studio:startDaemon', (): OpResult => startDaemonProcess())
  ipcMain.handle('studio:stopDaemon', (): OpResult => stopDaemonProcess())
  ipcMain.handle('studio:daemonStatus', (): DaemonStatus => daemonStatusValue())
  ipcMain.handle('studio:importModels', async (): Promise<ImportedModels> => {
    if (!settings.connectedProject) return {}
    try {
      const raw: unknown = JSON.parse(await readFile(join(settings.connectedProject, '.stigmergy', 'models.json'), 'utf8'))
      return parseAgentModels(raw)
    } catch {
      return {} // no file / unreadable: best-effort, nothing to prefill
    }
  })
  ipcMain.handle('studio:setEnabled', async (_event, enabled: boolean): Promise<OpResult> => {
    try {
      await withWriteEngine((engine) => engine.setRuntimeFlag('enabled', enabled ? '1' : '0'))
      safeRefresh() // push the new enabled state to the renderer
      return { ok: true, message: enabled ? 'Stigmergy enabled' : 'Stigmergy disabled' }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('studio:markConnected', async (_event, dir: string): Promise<OpResult> => {
    try {
      settings = mergeSettings({ ...settings, connectedProject: dir })
      await persistSettings()
      safeRefresh() // push the updated connection status to the renderer
      return { ok: true, message: `Connected: ${dir}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('studio:detectFramework', (_event, dir: string): Promise<FrameworkDetection> => detectFrameworkAt(dir))
  ipcMain.handle(
    'studio:discover',
    async (): Promise<{ ok: boolean; registered: number; skipped: number; errors: string[] }> => {
      // Enumerate available capabilities from the configured sources and register them into the
      // substrate (FEAT-04-02, ADR-17). Each source is isolated: one failing MCP server or an
      // unreadable skill folder reports its error but never aborts the whole discovery.
      const errors: string[] = []
      const inputs: RegisterCapabilityInput[] = []
      // Clarity (IMP-05-05-01): Discover only finds tools from configured sources. With none set, say
      // so plainly instead of silently registering nothing.
      const hasSkillRoot = !!settings.skillRoot && settings.skillRoot.trim() !== ''
      const hasMcp = (settings.mcpServers ?? []).length > 0
      if (!hasSkillRoot && !hasMcp) {
        return {
          ok: false,
          registered: 0,
          skipped: 0,
          errors: ['No discovery sources configured. Add an MCP server or a skill folder in Settings, or connect a loop so Stigmergy learns its tools as it runs.'],
        }
      }
      if (settings.skillRoot && settings.skillRoot.trim() !== '') {
        try {
          inputs.push(...(await scanSkillDirectory(settings.skillRoot)))
        } catch (err) {
          errors.push(`skills: ${errorMessage(err)}`)
        }
      }
      for (const server of settings.mcpServers ?? []) {
        try {
          inputs.push(...(await discoverMcpTools(server)))
        } catch (err) {
          errors.push(`mcp ${server.name}: ${errorMessage(err)}`)
        }
      }
      let registered = 0
      let skipped = 0
      try {
        const res = await withWriteEngine((engine) => ingestDiscovered(engine, inputs))
        registered = res.registered
        skipped = res.skipped
      } catch (err) {
        errors.push(`register: ${errorMessage(err)}`)
      }
      safeRefresh() // push the freshly discovered inventory to the renderer
      return { ok: errors.length === 0, registered, skipped, errors }
    },
  )
  ipcMain.handle('studio:proposeName', async (_event, sequence: string[]): Promise<ProposedName> => {
    const handler = namingApiHandler()
    if (!handler) return proposePathName(null, sequence) // no provider: immediate id-name (SC-04)
    // Hard 10s timeout (NFR): a provider whose fetch ignores the abort signal must not hang the
    // call, so race the live attempt against a timeout that aborts and resolves the fallback.
    const controller = new AbortController()
    const timeout = new Promise<ProposedName>((resolve) => {
      setTimeout(() => {
        controller.abort()
        void proposePathName(null, sequence).then(resolve)
      }, 10_000)
    })
    return Promise.race([proposePathName(handler, sequence, controller.signal), timeout])
  })
  ipcMain.handle('studio:testProvider', async (_event, config: ProviderConfig): Promise<ProviderTestResult> => {
    // Guard before any network call (FEAT-05-03 SC-03): a missing model or a remote provider without a
    // key gets a clear message, not a confusing network error.
    const guard = canProbe(config)
    if (!guard.ok) return { ok: false, error: guard.reason }
    try {
      // Same ApiHandler resolution as path naming (ASR-M8), so a green test means real readiness.
      const handler = buildApiHandler({
        type: config.type,
        model: config.model,
        apiKey: config.apiKey || undefined,
        baseUrl: config.baseUrl || undefined,
      })
      // Hard timeout: a provider whose fetch ignores the abort signal must not hang the UI.
      const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timed out after 15s')), 15_000))
      const reply = await Promise.race([handler.classifyText('Reply with the single word: ok'), timeout])
      return { ok: true, sample: reply.trim().slice(0, 120) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  // No studio:testEmbedding or studio:fetchEmbeddingModels: the embedding is hard-wired to the local
  // model (ADR-25, IMP-05-06-02), so there is no embedding provider to probe or list.
  ipcMain.handle('studio:fetchModels', async (_event, config: DiscoveryConfig): Promise<ModelListResult> => {
    try {
      return { ok: true, models: await fetchModels(config) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('studio:writeAdapter', async (_event, dir: string, detection: FrameworkDetection): Promise<WriteAdapterResult> => {
    try {
      const path = await writeAdapter(dir, detection)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('studio:edit', async (_event, command: EditCommand): Promise<EditResult> => {
    try {
      await withWriteEngine((engine) => applyEditCommand(engine, command))
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
    // The write committed. Refresh the map, but a failed refresh must not report the edit as failed.
    try {
      pushSnapshot()
    } catch {
      /* the next poll will refresh */
    }
    return { ok: true }
  })
  registerOperationHandlers()
  applyProductionCsp()
  void createWindow()
  // Default-on: activate Stigmergy (enabled + daemon) right after the window is created, so the app boots
  // active instead of waiting for the operator to flip the Active toggle (operator request 2026-06-08).
  void autoActivateOnStartup()
})

// Reap the daemon child on quit so the Studio never leaves an orphaned process behind (ADR-20).
app.on('before-quit', () => {
  // Treat quit as an intentional stop and cancel any pending crash-restart, so no daemon is respawned
  // after the app has exited (which would orphan it) (review w4pg93b97).
  daemonIntentionalStop = true
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer)
    daemonRestartTimer = null
  }
  if (daemonChild) {
    daemonChild.kill('SIGTERM')
    daemonChild = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})
