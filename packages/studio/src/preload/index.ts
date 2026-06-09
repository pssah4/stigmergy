/**
 * Preload bridge for Stigmergy Studio (FEAT-03-01, ADR-15).
 *
 * Runs in the isolated preload context and exposes a small, typed window.studio API via
 * contextBridge. The renderer subscribes to substrate pushes and asks for the substrate path
 * through this bridge, so it never touches ipcRenderer, Node, or Electron directly.
 *
 * Entry-point. Built by electron-vite.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { FrameworkDetection } from '@stigmergy/connect'
import {
  SUBSTRATE_CHANNEL,
  EDIT_CHANNEL,
  DETECT_FRAMEWORK_CHANNEL,
  WRITE_ADAPTER_CHANNEL,
  type StudioApi,
  type SubstrateMessage,
  type EditResult,
  type WriteAdapterResult,
  type OpResult,
  type SaveSettingsResult,
  type DiscoverResult,
  type DaemonStatus,
  type ProviderTestResult,
  type ModelListResult,
} from '../shared/ipc.js'
import type { EditCommand } from '../shared/edit-commands.js'
import type { StudioSettings, ProviderConfig } from '../shared/settings.js'
import type { DiscoveryConfig, ProviderType } from '@stigmergy/llm'
import type { ProposedName } from '../shared/path-naming.js'
import type { ImportedModels } from '../shared/agent-import.js'
import type { ConnectionTask } from '../shared/graph-model.js'

const api: StudioApi = {
  onSubstrate(listener) {
    const handler = (_event: IpcRendererEvent, message: SubstrateMessage): void => listener(message)
    ipcRenderer.on(SUBSTRATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(SUBSTRATE_CHANNEL, handler)
  },
  substratePath() {
    return ipcRenderer.invoke('studio:substratePath') as Promise<string>
  },
  edit(command: EditCommand) {
    return ipcRenderer.invoke(EDIT_CHANNEL, command) as Promise<EditResult>
  },
  connectionTasks(from: string, to: string) {
    return ipcRenderer.invoke('studio:connectionTasks', from, to) as Promise<ConnectionTask[]>
  },
  detectFramework(dir: string) {
    return ipcRenderer.invoke(DETECT_FRAMEWORK_CHANNEL, dir) as Promise<FrameworkDetection>
  },
  writeAdapter(dir: string, detection: FrameworkDetection) {
    return ipcRenderer.invoke(WRITE_ADAPTER_CHANNEL, dir, detection) as Promise<WriteAdapterResult>
  },
  backup() {
    return ipcRenderer.invoke('studio:backup') as Promise<OpResult>
  },
  restore() {
    return ipcRenderer.invoke('studio:restore') as Promise<OpResult>
  },
  exportPath(pathId: string) {
    return ipcRenderer.invoke('studio:exportPath', pathId) as Promise<OpResult>
  },
  importPath() {
    return ipcRenderer.invoke('studio:importPath') as Promise<OpResult>
  },
  reset() {
    return ipcRenderer.invoke('studio:reset') as Promise<OpResult>
  },
  getSettings() {
    return ipcRenderer.invoke('studio:getSettings') as Promise<StudioSettings>
  },
  saveSettings(settings: StudioSettings) {
    return ipcRenderer.invoke('studio:saveSettings', settings) as Promise<SaveSettingsResult>
  },
  markConnected(dir: string) {
    return ipcRenderer.invoke('studio:markConnected', dir) as Promise<OpResult>
  },
  proposeName(sequence: string[]) {
    return ipcRenderer.invoke('studio:proposeName', sequence) as Promise<ProposedName>
  },
  exportWorkflow(pathId: string, integrationId?: string) {
    return ipcRenderer.invoke('studio:exportWorkflow', pathId, integrationId) as Promise<OpResult>
  },
  importWorkflow() {
    return ipcRenderer.invoke('studio:importWorkflow') as Promise<OpResult>
  },
  discover() {
    return ipcRenderer.invoke('studio:discover') as Promise<DiscoverResult>
  },
  setEnabled(enabled: boolean) {
    return ipcRenderer.invoke('studio:setEnabled', enabled) as Promise<OpResult>
  },
  startDaemon() {
    return ipcRenderer.invoke('studio:startDaemon') as Promise<OpResult>
  },
  stopDaemon() {
    return ipcRenderer.invoke('studio:stopDaemon') as Promise<OpResult>
  },
  daemonStatus() {
    return ipcRenderer.invoke('studio:daemonStatus') as Promise<DaemonStatus>
  },
  importModels() {
    return ipcRenderer.invoke('studio:importModels') as Promise<ImportedModels>
  },
  testProvider(config: ProviderConfig) {
    return ipcRenderer.invoke('studio:testProvider', config) as Promise<ProviderTestResult>
  },
  fetchModels(config: DiscoveryConfig) {
    return ipcRenderer.invoke('studio:fetchModels', config) as Promise<ModelListResult>
  },
}

contextBridge.exposeInMainWorld('studio', api)
