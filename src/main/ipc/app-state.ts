import type { AppConfig, HostTabStatus, NotesRecord, ProjectsData, TabStatusValue } from '../../shared/types'
import type { AgentActivity } from '../../shared/agent-activity'
import type { RevisionStore } from '../revision-store'
import type { PaletteFrecencyStorage } from '../palette-frecency-storage'
import type { IpcRegistrar } from './registrar'
import { frecencyFile, notesRecord, projectsData, projectsSlice, revisionSave, safeId } from './schemas'
import { LOCAL_SOURCE, mergeProjectsSlice, type ProjectsSources } from '../../shared/projects-sources'
import { MAIN_OWNED_CONFIG_KEYS, sanitizeConfigUpdate } from './config-sanitize'
import { v } from './validate'

export interface AppStateDeps {
  projectsStore: RevisionStore<ProjectsData>
  notesStore: RevisionStore<NotesRecord>
  paletteFrecency: PaletteFrecencyStorage
  getAgentActivity: () => Record<string, AgentActivity>
  /** Main's status for every tab it knows, for tabs a window doesn't mount. */
  getTabStatuses: () => Record<string, HostTabStatus>
  setDirtyTabs: (clientId: string, tabIds: string[]) => void
  /** A window's status for a tab without hooks (see `TabActivityRegistry.reported`). */
  reportTabStatus: (clientId: string, tabId: string, status: TabStatusValue) => void
  /**
   * A window moved a task to another directory: end these tabs' processes and tell
   * every other window, so each restarts them in the new directory.
   */
  restartTabs: (clientId: string, tabIds: string[]) => void
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
  // A host has one source of projects, its own. A desktop's router adds its
  // servers' sources to these two (shared/projects-sources.ts).
  ipc.handle('load-projects', [], (): ProjectsSources => ({ [LOCAL_SOURCE]: deps.projectsStore.get() }))
  ipc.handle('save-projects', [safeId, revisionSave(projectsData)], (_event, source, payload) => {
    if (source !== LOCAL_SOURCE) throw new Error(`Unknown projects source: ${source}`)
    return deps.projectsStore.save(payload.baseRevision, payload.data)
  })
  // A desktop's slice of a server's projects: the projects only, merged into the
  // host's own data so its tags, order and pins (the phone's) stay.
  ipc.handle('save-projects-slice', [revisionSave(projectsSlice)], (_event, payload) =>
    deps.projectsStore.save(payload.baseRevision, mergeProjectsSlice(deps.projectsStore.peek(), payload.data.projects)))

  ipc.handle('get-agent-activity', [], () => deps.getAgentActivity())
  ipc.handle('get-tab-statuses', [], () => deps.getTabStatuses())

  // Windows publish their unsaved editors: a phone closing a task has nobody to show
  // a Save/Discard dialog to, so a dirty buffer comes back to it as a blocker.
  ipc.handle('report-dirty-tabs', [v.array(v.string())], (ctx, tabIds) => {
    deps.setDirtyTabs(ctx.clientId, tabIds)
    return undefined
  })

  ipc.handle('tabs-restart', [v.array(v.string({ max: 200 }), { max: 500 })], (ctx, tabIds) => {
    deps.restartTabs(ctx.clientId, tabIds)
    return undefined
  })

  // Codex and shell tabs have no hooks: their status is the window's PTY heuristics,
  // which main (and through it the phone) would otherwise never see.
  ipc.handle('report-tab-status', [v.string({ max: 200 }), v.nullable(v.literal('working', 'attention', 'exited'))], (ctx, tabId, status) => {
    deps.reportTabStatus(ctx.clientId, tabId, status)
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
