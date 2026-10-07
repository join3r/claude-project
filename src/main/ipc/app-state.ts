import { BrowserWindow } from 'electron'
import type { AppConfig, NotesRecord, ProjectsData, TabStatusValue } from '../../shared/types'
import type { AgentActivity } from '../../shared/agent-activity'
import type { RevisionStore } from '../revision-store'
import type { PaletteFrecencyStorage } from '../palette-frecency-storage'
import type { IpcRegistrar } from './registrar'
import { frecencyFile, notesRecord, projectsData, revisionSave } from './schemas'
import { MAIN_OWNED_CONFIG_KEYS, sanitizeConfigUpdate } from './config-sanitize'
import { v } from './validate'

export interface AppStateDeps {
  projectsStore: RevisionStore<ProjectsData>
  notesStore: RevisionStore<NotesRecord>
  paletteFrecency: PaletteFrecencyStorage
  getAgentActivity: () => Record<string, AgentActivity>
  setDirtyTabs: (windowId: number, tabIds: string[]) => void
  /** A window's status for a tab without hooks (see `TabActivityRegistry.reported`). */
  reportTabStatus: (windowId: number, tabId: string, status: TabStatusValue) => void
  /**
   * A window moved a task to another directory: end these tabs' processes and tell
   * every other window, so each restarts them in the new directory.
   */
  restartTabs: (windowId: number, tabIds: string[]) => void
  backupProjects: () => boolean
  getConfig: () => AppConfig
  /** Merge a validated partial config, persist it and tell every window. */
  applyConfig: (patch: Partial<AppConfig>) => void
  log: (message: string) => void
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Shared persisted state: projects, notes, config, palette frecency, and what main must know of each window. */
export function registerAppStateHandlers(ipc: IpcRegistrar, deps: AppStateDeps): void {
  ipc.handle('load-projects', [], () => deps.projectsStore.get())
  ipc.handle('save-projects', [revisionSave(projectsData)], (_event, payload) =>
    deps.projectsStore.save(payload.baseRevision, payload.data))

  ipc.handle('get-agent-activity', [], () => deps.getAgentActivity())

  // Windows publish their unsaved editors: a phone closing a task has nobody to show
  // a Save/Discard dialog to, so a dirty buffer comes back to it as a blocker.
  ipc.handle('report-dirty-tabs', [v.array(v.string())], (event, tabIds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    deps.setDirtyTabs(window.id, tabIds)
    return undefined
  })

  ipc.handle('tabs-restart', [v.array(v.string({ max: 200 }), { max: 500 })], (event, tabIds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    deps.restartTabs(window.id, tabIds)
    return undefined
  })

  // Codex and shell tabs have no hooks: their status is the window's PTY heuristics,
  // which main (and through it the phone) would otherwise never see.
  ipc.handle('report-tab-status', [v.string({ max: 200 }), v.nullable(v.literal('working', 'attention', 'exited'))], (event, tabId, status) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    deps.reportTabStatus(window.id, tabId, status)
    return undefined
  })

  ipc.handle('backup-projects-now', [], () => deps.backupProjects())

  ipc.handle('load-config', [], () => clone(deps.getConfig()))
  ipc.handle('save-config', [v.unknown], (_event, raw) => {
    const { config, droppedKeys, rejectedKeys } = sanitizeConfigUpdate(raw)
    if (droppedKeys.length > 0) deps.log(`saveConfig ignoredKeys=${droppedKeys.join(',')}`)
    // Unsaved, and not merged: the stored value (or the default loadConfig filled in) stays.
    for (const { key, reason } of rejectedKeys) deps.log(`saveConfig rejectedKey=${key} reason=${reason}`)
    for (const key of MAIN_OWNED_CONFIG_KEYS) delete config[key]
    deps.applyConfig(config)
    return undefined
  })

  ipc.handle('notes-load', [], () => deps.notesStore.get())
  ipc.handle('notes-save', [revisionSave(notesRecord)], (_event, payload) =>
    deps.notesStore.save(payload.baseRevision, payload.data))

  ipc.handle('palette-frecency:load', [], () => deps.paletteFrecency.load())
  ipc.handle('palette-frecency:save', [frecencyFile], (_event, file) => deps.paletteFrecency.save(file))
}
