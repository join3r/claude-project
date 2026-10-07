import { useState, useEffect, useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  buildWindowViewState,
  createDefaultWindowViewState,
  pruneUnusedTags,
  reconcileTaskViewState
} from '../../../shared/types'
import type { AppConfig, NotesRecord, Project, ProjectsData, Task, TaskViewState, WindowViewState } from '../../../shared/types'
import { applyQueuedStateUpdates, type StateUpdater } from '../stateHydration'
import { RevisionSyncClient } from '../revisionSync'
import { backfillLifetimeStats } from '../lifetimeStats'
import { areWindowStatesEqual } from './viewState'

/** How long typing has to pause before a note's content is written. */
const NOTE_CONTENT_SAVE_DEBOUNCE_MS = 500

export type MutateProjects = (updater: (prev: ProjectsData) => ProjectsData) => void
export type MutateNotes = (
  updater: (prev: NotesRecord) => NotesRecord,
  options?: { key?: string; defer?: boolean }
) => void
export type UpdateWindowViewState = (updater: (prev: WindowViewState) => WindowViewState) => void

/**
 * The shared foundation every domain hook builds on: the three pieces of state
 * (projects, notes, window view) plus config, the refs that mirror them for
 * callbacks, and the single write path into each.
 */
export interface AppStateCore {
  projectsData: ProjectsData
  config: AppConfig | null
  setConfig: Dispatch<SetStateAction<AppConfig | null>>
  windowViewState: WindowViewState
  notes: NotesRecord

  projectsDataRef: MutableRefObject<ProjectsData>
  projectsRef: MutableRefObject<Project[]>
  windowViewStateRef: MutableRefObject<WindowViewState>
  /** Written *ahead* of the state it mirrors; see `mutateNotes`. */
  notesRef: MutableRefObject<NotesRecord>

  projectsLoadedRef: MutableRefObject<boolean>
  configLoadedRef: MutableRefObject<boolean>
  windowStateLoadedRef: MutableRefObject<boolean>
  lastSavedProjectsJsonRef: MutableRefObject<string | null>
  lastSavedConfigJsonRef: MutableRefObject<string | null>
  lastSavedWindowStateJsonRef: MutableRefObject<string | null>
  projectsSync: RevisionSyncClient<ProjectsData>

  mutateProjects: MutateProjects
  mutateNotes: MutateNotes
  updateWindowViewState: UpdateWindowViewState
  getTaskViewStateForTask: (task: Task) => TaskViewState
  updateConfig: (updates: Partial<AppConfig>) => void

  stateSyncError: string | null
  dismissStateSyncError: () => void
}

/**
 * Owns loading, cross-window broadcasts and the mutation wrappers. The save
 * effects live in `usePersistence` so they keep their place after the other
 * mount-time effects.
 */
export function useAppStateCore(): AppStateCore {
  const [projectsData, setProjectsData] = useState<ProjectsData>({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [windowViewState, setWindowViewState] = useState<WindowViewState>(createDefaultWindowViewState())

  const projectsDataRef = useRef(projectsData)
  projectsDataRef.current = projectsData
  const projectsRef = useRef(projectsData.projects)
  projectsRef.current = projectsData.projects
  const windowViewStateRef = useRef(windowViewState)
  windowViewStateRef.current = windowViewState
  const projectsLoadedRef = useRef(false)
  const configLoadedRef = useRef(false)
  const windowStateLoadedRef = useRef(false)
  const pendingProjectUpdatersRef = useRef<StateUpdater<ProjectsData>[]>([])
  const pendingConfigUpdatersRef = useRef<StateUpdater<AppConfig>[]>([])
  const lastSavedProjectsJsonRef = useRef<string | null>(null)
  const lastSavedConfigJsonRef = useRef<string | null>(null)
  const lastSavedWindowStateJsonRef = useRef<string | null>(null)
  const [notes, setNotes] = useState<NotesRecord>({})
  // Unlike the other refs here this one is *written ahead* of the state it mirrors:
  // note mutations compute their next value from it so that several edits in one
  // turn compose, and so the value handed to the save is never a render behind.
  const notesRef = useRef<NotesRecord>({})
  const noteContentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Set when this window has permanently failed to persist something. It means the
   * state on screen is main's, not the user's — so it has to be visible, not logged.
   */
  const [stateSyncError, setStateSyncError] = useState<string | null>(null)
  const dismissStateSyncError = useCallback(() => setStateSyncError(null), [])

  const projectsSyncRef = useRef<RevisionSyncClient<ProjectsData> | null>(null)
  if (!projectsSyncRef.current) {
    projectsSyncRef.current = new RevisionSyncClient<ProjectsData>({
      save: (payload) => window.api.saveProjects(payload),
      onRebase: (data) => {
        // The client is already re-sending this exact payload, so mark it saved to
        // keep the save effect from queueing a redundant trailing write.
        lastSavedProjectsJsonRef.current = JSON.stringify(data)
        projectsDataRef.current = data
        setProjectsData(data)
      },
      onError: setStateSyncError
    })
  }
  const projectsSync = projectsSyncRef.current

  const notesSyncRef = useRef<RevisionSyncClient<NotesRecord> | null>(null)
  if (!notesSyncRef.current) {
    notesSyncRef.current = new RevisionSyncClient<NotesRecord>({
      save: (payload) => window.api.notesSave(payload),
      onRebase: (data) => {
        notesRef.current = data
        setNotes(data)
      },
      onError: setStateSyncError
    })
  }
  const notesSync = notesSyncRef.current

  /**
   * The single write path for projects/tasks/tabs state. Every mutation is recorded
   * as an updater before it is applied, which is what lets a save rejected by main's
   * compare-and-swap be replayed onto the canonical state instead of lost. A mutation
   * that skips this wrapper and calls `setProjectsData` directly reinstates the
   * lost-update bug for that one action, silently and untestably.
   */
  const mutateProjects = useCallback((updater: (prev: ProjectsData) => ProjectsData) => {
    const wrapped = (prev: ProjectsData) => pruneUnusedTags(updater(prev))
    if (!projectsLoadedRef.current) {
      // No revision to quote yet; these are rebased onto the loaded snapshot instead.
      pendingProjectUpdatersRef.current.push(wrapped)
    } else {
      projectsSync.enqueue(wrapped)
    }
    setProjectsData(prev => wrapped(prev))
  }, [projectsSync])

  /**
   * The same wrapper for notes. `defer` is the debounced content edit: the mutation is
   * queued for replay immediately — a broadcast landing mid-keystroke must not wipe
   * what is being typed — while the write itself waits for the typing to stop.
   */
  const mutateNotes = useCallback((
    updater: (prev: NotesRecord) => NotesRecord,
    options?: { key?: string; defer?: boolean }
  ) => {
    notesSync.enqueue(updater, options?.key)
    const next = updater(notesRef.current)
    notesRef.current = next
    setNotes(next)

    if (noteContentSaveTimerRef.current !== null) {
      clearTimeout(noteContentSaveTimerRef.current)
      noteContentSaveTimerRef.current = null
    }
    if (options?.defer) {
      noteContentSaveTimerRef.current = setTimeout(() => {
        noteContentSaveTimerRef.current = null
        notesSync.requestSave(notesRef.current)
      }, NOTE_CONTENT_SAVE_DEBOUNCE_MS)
      return
    }
    notesSync.requestSave(next)
  }, [notesSync])

  const updateWindowViewState = useCallback((updater: (prev: WindowViewState) => WindowViewState) => {
    setWindowViewState(prev => {
      const next = updater(prev)
      return areWindowStatesEqual(prev, next) ? prev : next
    })
  }, [])

  const getTaskViewStateForTask = useCallback((task: Task): TaskViewState => {
    return reconcileTaskViewState(task, windowViewStateRef.current.taskStates[task.id])
  }, [])

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, ...updates })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
  }, [])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.api.loadProjects(),
      window.api.loadConfig(),
      window.api.loadWindowState(),
      window.api.notesLoad()
    ]).then(([loadedProjects, loadedConfig, loadedWindowViewState, loadedNotesEnvelope]) => {
      if (cancelled) return

      projectsSync.hydrate(loadedProjects.revision)
      notesSync.hydrate(loadedNotesEnvelope.revision)
      const loadedNotes = notesSync.replay(loadedNotesEnvelope.data)

      const hydratedProjectsData = applyQueuedStateUpdates(loadedProjects.data, pendingProjectUpdatersRef.current)
      const hydratedConfig = applyQueuedStateUpdates(loadedConfig, pendingConfigUpdatersRef.current)

      const projectsWithLifetime = hydratedProjectsData.projects.map(p =>
        backfillLifetimeStats(p, loadedNotes)
      )
      const finalProjectsData = { ...hydratedProjectsData, projects: projectsWithLifetime }

      const hydratedWindowViewState = buildWindowViewState(
        projectsWithLifetime,
        hydratedConfig,
        loadedWindowViewState,
        finalProjectsData.tags
      )

      pendingProjectUpdatersRef.current = []
      pendingConfigUpdatersRef.current = []
      lastSavedProjectsJsonRef.current = JSON.stringify(finalProjectsData)
      lastSavedConfigJsonRef.current = JSON.stringify(loadedConfig)
      lastSavedWindowStateJsonRef.current = JSON.stringify(hydratedWindowViewState)
      projectsLoadedRef.current = true
      configLoadedRef.current = true
      windowStateLoadedRef.current = true

      projectsDataRef.current = finalProjectsData
      notesRef.current = loadedNotes
      setProjectsData(finalProjectsData)
      setConfig(hydratedConfig)
      setWindowViewState(hydratedWindowViewState)
      setNotes(loadedNotes)
      // Note mutations made before the load returned were replayed onto the loaded
      // record above but have never been persisted.
      if (notesSync.hasPending()) notesSync.requestSave(loadedNotes)
    })

    // Canonical state, not a mutation: it is adopted rather than pushed through
    // `mutateProjects`. Anything of ours that main has not acknowledged yet is
    // replayed on top so another window's save cannot swallow it.
    const cleanupProjects = window.api.onProjectsUpdated((envelope) => {
      if (cancelled) return
      const projectsWithLifetime = envelope.data.projects.map(p =>
        backfillLifetimeStats(p, notesRef.current)
      )
      const canonical = { ...envelope.data, projects: projectsWithLifetime }
      // Compare the inner data: the revision alone would make every broadcast — our
      // own save echoing back included — look like news.
      if (JSON.stringify(canonical) === lastSavedProjectsJsonRef.current) {
        // Mid-save the acknowledgement carries the authoritative revision; adopting
        // one from an echo would let a stale base slip past the compare-and-swap.
        if (!projectsSync.isSaving()) projectsSync.hydrate(envelope.revision)
        return
      }
      const next = projectsSync.applyBroadcast(envelope.revision, canonical)
      if (next === null) return
      // Marking it saved keeps the save effect from re-sending state we were just
      // handed — so anything replayed on top has to be sent explicitly here.
      lastSavedProjectsJsonRef.current = JSON.stringify(next)
      projectsDataRef.current = next
      setProjectsData(next)
      if (projectsSync.hasPending()) projectsSync.requestSave(next)
    })

    const cleanupNotes = window.api.onNotesUpdated((envelope) => {
      if (cancelled) return
      const next = notesSync.applyBroadcast(envelope.revision, envelope.data)
      if (next === null) return
      notesRef.current = next
      setNotes(next)
    })

    const cleanupConfig = window.api.onConfigUpdated((updatedConfig) => {
      if (cancelled) return
      const serialized = JSON.stringify(updatedConfig)
      if (serialized === lastSavedConfigJsonRef.current) return
      lastSavedConfigJsonRef.current = serialized
      setConfig(updatedConfig)
    })

    return () => {
      cancelled = true
      cleanupProjects()
      cleanupNotes()
      cleanupConfig()
    }
  }, [])

  return {
    projectsData,
    config,
    setConfig,
    windowViewState,
    notes,
    projectsDataRef,
    projectsRef,
    windowViewStateRef,
    notesRef,
    projectsLoadedRef,
    configLoadedRef,
    windowStateLoadedRef,
    lastSavedProjectsJsonRef,
    lastSavedConfigJsonRef,
    lastSavedWindowStateJsonRef,
    projectsSync,
    mutateProjects,
    mutateNotes,
    updateWindowViewState,
    getTaskViewStateForTask,
    updateConfig,
    stateSyncError,
    dismissStateSyncError
  }
}

/** Writes each piece of state back to main whenever it differs from what was last saved. */
export function usePersistence(core: AppStateCore): void {
  const {
    projectsData, config, windowViewState, projectsSync,
    projectsLoadedRef, configLoadedRef, windowStateLoadedRef,
    lastSavedProjectsJsonRef, lastSavedConfigJsonRef, lastSavedWindowStateJsonRef
  } = core

  useEffect(() => {
    if (!projectsLoadedRef.current) return

    const serialized = JSON.stringify(projectsData)
    if (serialized === lastSavedProjectsJsonRef.current) return

    lastSavedProjectsJsonRef.current = serialized
    projectsSync.requestSave(projectsData)
  }, [projectsData, projectsSync])

  useEffect(() => {
    if (!configLoadedRef.current || !config) return

    const serialized = JSON.stringify(config)
    if (serialized === lastSavedConfigJsonRef.current) return

    lastSavedConfigJsonRef.current = serialized
    void window.api.saveConfig(config)
  }, [config])

  useEffect(() => {
    if (!windowStateLoadedRef.current) return

    const serialized = JSON.stringify(windowViewState)
    if (serialized === lastSavedWindowStateJsonRef.current) return

    lastSavedWindowStateJsonRef.current = serialized
    void window.api.saveWindowState(windowViewState)
  }, [windowViewState])
}
