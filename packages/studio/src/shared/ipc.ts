// IPC contract between the Electron main process and the React renderer (ADR-15). The main
// process polls the substrate every 2s and pushes a SubstrateSnapshot on this channel; the
// preload bridge re-exposes a typed subscription on window.studio so the renderer never touches
// Node or Electron APIs directly.

import type { FrameworkDetection } from '@stigmergy/connect'
import type { ConnectionTask, SubstrateSnapshot } from './graph-model.js'
import type { EditCommand } from './edit-commands.js'
import type { StudioSettings, ProviderConfig } from './settings.js'
import type { DiscoveryConfig, DiscoveredModel, ProviderType } from '@stigmergy/llm'
import type { ProposedName } from './path-naming.js'
import type { ImportedModels } from './agent-import.js'

export const SUBSTRATE_CHANNEL = 'substrate:update'
export const EDIT_CHANNEL = 'studio:edit'
export const DETECT_FRAMEWORK_CHANNEL = 'studio:detectFramework'
export const WRITE_ADAPTER_CHANNEL = 'studio:writeAdapter'

/** A snapshot push, plus an optional read error and the active substrate path (so the renderer's
 * header stays current after a settings-driven path switch). */
export interface SubstrateMessage {
  snapshot: SubstrateSnapshot
  error?: string
  substratePath?: string
  /** The persisted connected loop project (empty if none), so the renderer shows a stable status. */
  connectedProject?: string
}

/** Result of an edit command. ok=false carries a message the renderer can surface. */
export type EditResult = { ok: true } | { ok: false; error: string }

/** Result of writing the connect adapter file. */
export type WriteAdapterResult = { ok: true; path: string } | { ok: false; error: string }

/** Result of a substrate operation (backup/restore/export/import/reset). canceled = dialog dismissed. */
export type OpResult = { ok: true; message?: string } | { ok: false; error?: string; canceled?: boolean }

/** Result of saving settings. ok=false carries the validation errors to surface in the panel. */
export type SaveSettingsResult = { ok: true } | { ok: false; errors: string[] }

/** Result of a discovery run (FEAT-04-02): how many capabilities were registered, plus per-source errors. */
export type DiscoverResult = { ok: boolean; registered: number; skipped: number; errors: string[] }

/** Daemon lifecycle status (FEAT-04-04): the Studio is the daemon's control surface (no terminal). */
export type DaemonStatus = { running: boolean; pid?: number; error?: string; restarts?: number; recentLog?: string[] }

/** Result of a live provider connection test (FEAT-05-03): a short classifyText probe via the same
 * ApiHandler resolution as path naming. ok carries an optional sample of the model's reply. */
export type ProviderTestResult = { ok: true; sample?: string } | { ok: false; error: string }

/** Result of a model-discovery fetch (FEAT-05-06): the available models from a provider, or an error. */
export type ModelListResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string }

/** The surface the preload bridge exposes on window.studio. */
export interface StudioApi {
  /** Subscribe to substrate pushes. Returns an unsubscribe function. */
  onSubstrate(listener: (message: SubstrateMessage) => void): () => void
  /** The resolved substrate file path the main process opened. */
  substratePath(): Promise<string>
  /** Apply a write command (pin/unpin/reinforce/weaken/deleteEdge). The map refreshes on success. */
  edit(command: EditCommand): Promise<EditResult>
  /** Edge provenance (BL-012): the recent tasks whose path traversed a learned connection, so a gray
   * edge can be explained by what it was learned for. Read-only; empty when nothing traversed it. */
  connectionTasks(from: string, to: string): Promise<ConnectionTask[]>
  /** Detect the loop framework in a project directory (reads its package.json). */
  detectFramework(dir: string): Promise<FrameworkDetection>
  /** Write the connect adapter file into a project directory (after the renderer confirmed the diff). */
  writeAdapter(dir: string, detection: FrameworkDetection): Promise<WriteAdapterResult>
  /** Substrate operations (FEAT-03-04). File operations open an Electron dialog. */
  backup(): Promise<OpResult>
  restore(): Promise<OpResult>
  exportPath(pathId: string): Promise<OpResult>
  importPath(): Promise<OpResult>
  reset(): Promise<OpResult>
  /** Settings (FEAT-03-05). saveSettings validates, persists, and re-connects on a path change. */
  getSettings(): Promise<StudioSettings>
  saveSettings(settings: StudioSettings): Promise<SaveSettingsResult>
  /** Persist that a loop project is connected (FEAT-03-08), so the connection survives a restart. */
  markConnected(dir: string): Promise<OpResult>
  /** Propose a name for a path (FEAT-03-07). Uses the configured LLM provider, else a fallback id-name. */
  proposeName(sequence: string[]): Promise<ProposedName>
  /** Portable workflow export/import (FEAT-03-06/FEAT-03-08): write a pinned path as a workflow file,
   * or pin one back. An optional integration id only picks a subdirectory under the workflow root. */
  exportWorkflow(pathId: string, integrationId?: string): Promise<OpResult>
  importWorkflow(): Promise<OpResult>
  /** Enumerate available capabilities from the configured sources (host tools / MCP / SKILL.md) and
   * register them into the substrate (FEAT-04-02). The map refreshes with the new inventory. */
  discover(): Promise<DiscoverResult>
  /** Activate or deactivate Stigmergy for the connected loop (FEAT-04-06). Writes the shared flag in
   * the substrate so the loop honors it; the map refreshes with the new enabled state. */
  setEnabled(enabled: boolean): Promise<OpResult>
  /** Daemon lifecycle (FEAT-04-04): the Studio spawns/stops/queries the naming-and-consult daemon, so
   * the operator never touches a terminal. */
  startDaemon(): Promise<OpResult>
  stopDaemon(): Promise<OpResult>
  daemonStatus(): Promise<DaemonStatus>
  /** Best-effort prefill of the Studio's model settings from the connected project's
   * .stigmergy/models.json (FEAT-04-07c). Never imports secrets; the user reviews and saves. */
  importModels(): Promise<ImportedModels>
  /** Live-test a provider config (FEAT-05-03): a short classifyText probe via the same ApiHandler
   * resolution as path naming. Returns ok with an optional reply sample, or a clear error. */
  testProvider(config: ProviderConfig): Promise<ProviderTestResult>
  /** Fetch the available chat models from a provider (FEAT-05-06), for a picker instead of free text. */
  fetchModels(config: DiscoveryConfig): Promise<ModelListResult>
  // No embedding model discovery or test: the embedding is hard-wired to the local model (ADR-25,
  // IMP-05-06-02), so there is nothing to fetch or probe.
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    studio: StudioApi
  }
}
