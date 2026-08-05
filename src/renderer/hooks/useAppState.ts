import { useState, useEffect, useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
  buildWindowViewState,
  cloneWindowViewState,
  createDefaultWindowViewState,
  createHomeTask,
  createTaskViewState,
  ensureHomeTasks,
  isHomeTab,
  isHomeTask,
  isRemoteProject,
  pinnedItemKey,
  pruneUnusedTags,
  reconcileTaskViewState,
  reconcileWindowViewState
} from '../../shared/types'
import type {
  NotesRecord,
  PinnedItem,
  Project,
  ProjectNote,
  ProjectsData,
  Tag,
  Task,
  Tab,
  AppConfig,
  TabType,
  AiTabType,
  SshConfig,
  WorkspaceConfig,
  WorkspaceDeleteResult,
  WindowViewState,
  TaskViewState,
  TaskInboxState,
  SidebarTab,
  FileBrowserTab
} from '../../shared/types'
import { applyQueuedStateUpdates, persistSelectionState, type StateUpdater } from './stateHydration'
import { RevisionSyncClient } from './revisionSync'
import { resolveLandingTaskId } from './taskNavigation'
import { backfillLifetimeStats, incrementLifetimeStat } from './lifetimeStats'
import { moveTaskTab } from '../tabMove'
import {
  pushRecentlyClosedTab,
  shiftRestorableClosedTab,
  type RecentlyClosedTab
} from '../recentlyClosedTabs'
import { createInteractionStampGate } from '../components/taskRecency'
import { createTab, type CreateTabOptions } from '../components/newTaskTabs'
import { useDirtyBufferStore, type DirtyBuffer } from '../context/DirtyBufferContext'

export type ProjectUpdate = Partial<Pick<Project, 'directory' | 'aiToolArgs' | 'tunnel' | 'emoji' | 'icon' | 'tagIds'>>
type AddTabOptions = CreateTabOptions

export function buildWindowTitle(projectName: string | null, taskName: string | null, taskIsHome?: boolean): string {
  if (projectName && taskName && !taskIsHome) {
    return `${projectName} / ${taskName}`
  }
  if (projectName) {
    return projectName
  }
  return 'DevTool'
}

/**
 * These deletions are fire-and-forget and nobody is standing in front of a dialog for them,
 * but a refusal still must not vanish: 'invalid-worktree' means main deliberately left a
 * directory on disk rather than recursively deleting something it could not identify.
 */
function reportRefusedWorkspaceDelete(result: WorkspaceDeleteResult): void {
  if (result.status === 'ok') return
  console.warn(`Workspace not removed (${result.status}): ${result.reason ?? 'no reason given'}`)
}

/** What the unsaved-changes dialog is currently asking about. */
export interface DirtyClosePrompt {
  /** Every unsaved file the pending removal would take, by path. */
  files: string[]
  /** A Save is in flight; the buttons are held until it lands or fails. */
  saving: boolean
  /** Why the last Save did not land. The removal stays un-done while this is set. */
  error: string | null
}

export type DirtyCloseChoice = 'save' | 'discard' | 'cancel'

/** Nothing was dirty, so the removal goes ahead without a dialog ever existing. */
const PROCEED: Promise<'proceed'> = Promise.resolve('proceed')

/** How long typing has to pause before a note's content is written. */
const NOTE_CONTENT_SAVE_DEBOUNCE_MS = 500

function tabIdsOfTask(task: Task): string[] {
  return [...task.tabs.left, ...task.tabs.right].map(tab => tab.id)
}

function areWindowStatesEqual(a: WindowViewState, b: WindowViewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function cloneTaskState(state: TaskViewState): TaskViewState {
  return {
    activeTab: {
      left: state.activeTab.left,
      right: state.activeTab.right
    },
    splitOpen: state.splitOpen,
    splitRatio: state.splitRatio,
    ...(state.fileBrowserOpen !== undefined ? { fileBrowserOpen: state.fileBrowserOpen } : {}),
    ...(state.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: state.fileBrowserActiveTab } : {})
  }
}

export function useAppState() {
  const [projectsData, setProjectsData] = useState<ProjectsData>({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [windowViewState, setWindowViewState] = useState<WindowViewState>(createDefaultWindowViewState())
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [windowFocused, setWindowFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()))
  const [terminalZoomDelta, setTerminalZoomDelta] = useState(0)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1.0)

  const projects = projectsData.projects
  const tags = projectsData.tags
  const projectOrder = projectsData.projectOrder

  const projectsDataRef = useRef(projectsData)
  projectsDataRef.current = projectsData
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const pendingTagsRef = useRef<Map<string, Tag>>(new Map())
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
  const interactionGateRef = useRef(createInteractionStampGate())
  const recentlyClosedTabsRef = useRef<RecentlyClosedTab[]>([])
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
        // keep the save effect below from queueing a redundant trailing write.
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

  const dirtyBuffers = useDirtyBufferStore()
  const [dirtyPrompt, setDirtyPrompt] = useState<DirtyClosePrompt | null>(null)
  // The buffers themselves never enter state: they carry live closures over the
  // editors, and the dialog only ever needs their paths to render.
  const dirtyPromptBuffersRef = useRef<DirtyBuffer[]>([])
  const dirtyPromptResolveRef = useRef<((outcome: 'proceed' | 'cancel') => void) | null>(null)

  /**
   * The one gate every removal path goes through. Clean tabs never see a dialog
   * — the promise is already resolved — so ⌘W on a terminal costs nothing.
   */
  const confirmDiscardDirty = useCallback((tabIds: string[]): Promise<'proceed' | 'cancel'> => {
    const dirty = dirtyBuffers.getDirtyTabs(tabIds)
    if (dirty.length === 0) return PROCEED
    // A second removal while the dialog is up would strand the first caller's
    // promise; the modal blocks the UI, so this only guards the odd programmatic
    // caller (idle cleanup) racing the user.
    if (dirtyPromptResolveRef.current) return Promise.resolve('cancel')

    return new Promise<'proceed' | 'cancel'>(resolve => {
      dirtyPromptResolveRef.current = resolve
      dirtyPromptBuffersRef.current = dirty
      setDirtyPrompt({ files: dirty.map(buffer => buffer.filePath), saving: false, error: null })
    })
  }, [dirtyBuffers])

  const settleDirtyPrompt = useCallback((outcome: 'proceed' | 'cancel') => {
    const resolve = dirtyPromptResolveRef.current
    dirtyPromptResolveRef.current = null
    dirtyPromptBuffersRef.current = []
    setDirtyPrompt(null)
    resolve?.(outcome)
  }, [])

  const resolveDirtyPrompt = useCallback(async (choice: DirtyCloseChoice): Promise<void> => {
    if (!dirtyPromptResolveRef.current) return
    if (choice === 'cancel') {
      settleDirtyPrompt('cancel')
      return
    }
    if (choice === 'discard') {
      settleDirtyPrompt('proceed')
      return
    }

    setDirtyPrompt(prev => (prev ? { ...prev, saving: true, error: null } : prev))
    for (const buffer of dirtyPromptBuffersRef.current) {
      try {
        await buffer.save()
      } catch (err) {
        // Nothing is removed on the strength of a write that did not land. The
        // dialog stays up with the reason so the user can retry, discard, or
        // back out — and the rejection dies here rather than reaching the
        // unhandled-rejection crash screen in src/renderer/main.tsx.
        const message = err instanceof Error ? err.message : String(err)
        setDirtyPrompt(prev => (prev
          ? { ...prev, saving: false, error: message ? `Save failed: ${message}` : 'Save failed.' }
          : prev))
        return
      }
    }
    settleDirtyPrompt('proceed')
  }, [settleDirtyPrompt])

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
      const { projects: migratedProjects } = ensureHomeTasks(projectsWithLifetime)
      const finalProjectsData = { ...hydratedProjectsData, projects: migratedProjects }

      const hydratedWindowViewState = buildWindowViewState(
        migratedProjects,
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

    void window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)

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

  /**
   * Publish this window's unsaved editors to main. Idle cleanup runs there with
   * nobody in front of a Save/Discard dialog, so a dirty buffer has to be a
   * safeguard rather than a prompt — and main cannot see one on its own.
   */
  useEffect(() => {
    let lastReported = ''
    const report = () => {
      const tabIds = dirtyBuffers.getDirtyTabs().map(buffer => buffer.tabId).sort()
      const serialized = JSON.stringify(tabIds)
      if (serialized === lastReported) return
      lastReported = serialized
      void window.api.reportDirtyTabs(tabIds).catch(() => {})
    }
    report()
    return dirtyBuffers.subscribe(report)
  }, [dirtyBuffers])

  /**
   * Main deleted a task by itself (idle cleanup). The state change arrives as a
   * normal projects broadcast; this is the part of `removeTask` that is local to
   * a window — the xterm instances and per-tab status entries hanging off the
   * tabs, and this window's own view state.
   */
  useEffect(() => {
    return window.api.onTasksRemoved(({ taskId, tabIds }) => {
      for (const tabId of tabIds) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      }
      // Disposing a live xterm writes its buffer back synchronously, which would
      // put back the scrollback file main just deleted.
      for (const tabId of tabIds) {
        void window.api.scrollbackDelete(tabId)
      }
      updateWindowViewState(prev => {
        if (!(taskId in prev.taskStates) && prev.selectedTaskId !== taskId) return prev
        const taskStates = { ...prev.taskStates }
        delete taskStates[taskId]
        return {
          ...prev,
          selectedTaskId: prev.selectedTaskId === taskId ? null : prev.selectedTaskId,
          taskStates
        }
      })
    })
  }, [updateWindowViewState])

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true)
    const handleBlur = () => setWindowFocused(false)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

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

  useEffect(() => {
    const tagIds = new Set(tags.map(tag => tag.id))
    updateWindowViewState((prev) => {
      const filtered = prev.selectedTagIds.filter(id => tagIds.has(id))
      if (filtered.length === prev.selectedTagIds.length) return prev
      return reconcileWindowViewState(
        { ...prev, selectedTagIds: filtered },
        projects,
        tagIds
      )
    })
  }, [tags, projects, updateWindowViewState])

  useEffect(() => {
    if (!projectsLoadedRef.current || !configLoadedRef.current || !config) return
    if (!windowFocused) return

    const selectedProjectId = windowViewState.selectedProjectId
    const selectedTaskId = windowViewState.selectedTaskId
    const selection = persistSelectionState(projectsData, config, selectedProjectId, selectedTaskId)

    // Stamping the project's `lastTaskId` is a real mutation of shared state, so it
    // goes through the wrapper like any other — recomputed against `prev` so that a
    // conflict replay stamps the right project rather than a stale snapshot of it.
    if (selection.projectsData !== projectsData) {
      mutateProjects(prev => persistSelectionState(prev, config, selectedProjectId, selectedTaskId).projectsData)
    }

    if (selection.config !== config) {
      setConfig(selection.config)
    }
  }, [
    config,
    mutateProjects,
    projectsData,
    windowFocused,
    windowViewState.selectedProjectId,
    windowViewState.selectedTaskId
  ])

  useEffect(() => {
    const selectedProjectId = windowViewState.selectedProjectId
    if (!selectedProjectId || projects.length === 0) return
    const project = projects.find(p => p.id === selectedProjectId)
    if (project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(selectedProjectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(selectedProjectId, project.ssh!).catch(() => {})
        }
      })
    }
  }, [projects, windowViewState.selectedProjectId])

  const lastSyncedSidebarTaskIdRef = useRef<string | null>(null)
  useEffect(() => {
    const taskId = windowViewState.selectedTaskId
    if (!taskId) {
      lastSyncedSidebarTaskIdRef.current = null
      return
    }
    if (lastSyncedSidebarTaskIdRef.current === taskId) return
    const project = projects.find(p => p.tasks.some(t => t.id === taskId))
    const task = project?.tasks.find(t => t.id === taskId) ?? null
    if (!task) return
    lastSyncedSidebarTaskIdRef.current = taskId

    const saved = windowViewState.taskStates[taskId]
    const isHome = task.system === 'home'
    const nextOpen = saved?.fileBrowserOpen !== undefined
      ? saved.fileBrowserOpen
      : isHome
        ? true
        : windowViewState.fileBrowserOpen
    const nextTab: FileBrowserTab = saved?.fileBrowserActiveTab !== undefined
      ? saved.fileBrowserActiveTab
      : isHome
        ? 'notes'
        : windowViewState.fileBrowserActiveTab

    if (nextOpen === windowViewState.fileBrowserOpen && nextTab === windowViewState.fileBrowserActiveTab) return
    updateWindowViewState(prev => ({
      ...prev,
      fileBrowserOpen: nextOpen,
      fileBrowserActiveTab: nextTab
    }))
  }, [projects, windowViewState.selectedTaskId, windowViewState.taskStates, windowViewState.fileBrowserOpen, windowViewState.fileBrowserActiveTab, updateWindowViewState])

  const includePendingTags = useCallback((data: ProjectsData, tagIds?: readonly string[]): ProjectsData => {
    if (!tagIds?.length) return data
    const existingTagIds = new Set(data.tags.map(tag => tag.id))
    const pendingTags = tagIds
      .map(tagId => pendingTagsRef.current.get(tagId))
      .filter((tag): tag is Tag => !!tag && !existingTagIds.has(tag.id))
    if (pendingTags.length === 0) return data
    return { ...data, tags: [...data.tags, ...pendingTags] }
  }, [])

  const markTaskInteracted = useCallback((projectId: string, taskId: string) => {
    const now = Date.now()
    if (!interactionGateRef.current(taskId, now)) return
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id !== projectId ? project : {
          ...project,
          tasks: project.tasks.map(task =>
            task.id === taskId ? { ...task, lastInteractedAt: now } : task
          )
        }
      )
    }))
  }, [mutateProjects])

  const updateTaskInbox = useCallback((
    projectId: string,
    taskId: string,
    updater: (inbox: TaskInboxState) => TaskInboxState
  ) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id !== projectId ? project : {
          ...project,
          tasks: project.tasks.map(task =>
            task.id === taskId ? { ...task, inbox: updater(task.inbox ?? {}) } : task
          )
        }
      )
    }))
  }, [mutateProjects])

  /**
   * Stamps a meaningful event on a task: a hook notification/stop, a terminal bell, a
   * PTY exit. 'attention' additionally records the moment something started waiting on
   * the user, which is what "snooze until it needs me" wakes on.
   *
   * Also resolves triage state that the event supersedes: a settle is undone (settle
   * means "done for now", not "muted"), and an attention-snooze is woken.
   */
  const markTaskEvent = useCallback((
    projectId: string,
    taskId: string,
    kind: 'event' | 'attention' = 'event'
  ) => {
    const now = Date.now()
    // An event in the task you are currently looking at is read on arrival —
    // otherwise the row you are staring at goes bold and stays that way.
    const watching = windowViewStateRef.current.selectedTaskId === taskId
    updateTaskInbox(projectId, taskId, inbox => {
      const next: TaskInboxState = { ...inbox, eventAt: now }
      if (kind === 'attention') next.attentionAt = now
      if (watching) next.visitedAt = now
      if (typeof next.settledAt === 'number') delete next.settledAt
      if (kind === 'attention' && next.snoozeUntilAttention) {
        delete next.snoozeUntilAttention
        delete next.snoozedAt
      }
      return next
    })
  }, [updateTaskInbox])

  const markTaskVisited = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inbox => {
      const next: TaskInboxState = { ...inbox, visitedAt: Date.now() }
      delete next.forcedUnread
      return next
    })
  }, [updateTaskInbox])

  const markTaskUnread = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inbox => ({ ...inbox, forcedUnread: true }))
  }, [updateTaskInbox])

  const settleTask = useCallback((projectId: string, taskId: string) => {
    const now = Date.now()
    updateTaskInbox(projectId, taskId, inbox => {
      // Settling is also an acknowledgement, so it clears unread and any snooze.
      const next: TaskInboxState = { ...inbox, settledAt: now, visitedAt: now }
      delete next.forcedUnread
      delete next.snoozedUntil
      delete next.snoozeUntilAttention
      delete next.snoozedAt
      return next
    })
  }, [updateTaskInbox])

  const unsettleTask = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inbox => {
      const next = { ...inbox }
      delete next.settledAt
      return next
    })
  }, [updateTaskInbox])

  const snoozeTask = useCallback((
    projectId: string,
    taskId: string,
    options: { until?: number; untilAttention?: boolean }
  ) => {
    const now = Date.now()
    updateTaskInbox(projectId, taskId, inbox => {
      const next: TaskInboxState = { ...inbox, snoozedAt: now, visitedAt: now }
      delete next.forcedUnread
      delete next.settledAt
      if (options.untilAttention) {
        next.snoozeUntilAttention = true
        delete next.snoozedUntil
      } else {
        next.snoozedUntil = options.until
        delete next.snoozeUntilAttention
      }
      return next
    })
  }, [updateTaskInbox])

  const unsnoozeTask = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inbox => {
      const next = { ...inbox }
      delete next.snoozedUntil
      delete next.snoozeUntilAttention
      delete next.snoozedAt
      return next
    })
  }, [updateTaskInbox])

  const cleanupClosedTabHistory = useCallback((entries: RecentlyClosedTab[]) => {
    for (const entry of entries) {
      void window.api.scrollbackDelete(entry.tab.id)
    }
  }, [])

  const rememberClosedTab = useCallback((entry: RecentlyClosedTab) => {
    const next = pushRecentlyClosedTab(recentlyClosedTabsRef.current, entry)
    recentlyClosedTabsRef.current = next.history
    cleanupClosedTabHistory(next.evicted)
  }, [cleanupClosedTabHistory])

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, ...updates })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
  }, [])

  const selectProject = useCallback((id: string | null) => {
    updateWindowViewState(prev => {
      if (!id) {
        return { ...prev, selectedProjectId: null, selectedTaskId: null }
      }

      const project = projectsRef.current.find(candidate => candidate.id === id) ?? null
      const restoredTaskId = project?.lastTaskId && project.tasks.some(task => task.id === project.lastTaskId)
        ? project.lastTaskId
        : null

      const expandedProjectIds = prev.expandedProjectIds.includes(id)
        ? prev.expandedProjectIds
        : [...prev.expandedProjectIds, id]

      return {
        ...prev,
        selectedProjectId: id,
        selectedTaskId: restoredTaskId,
        expandedProjectIds
      }
    })

    const project = id ? projectsRef.current.find(candidate => candidate.id === id) ?? null : null
    if (id && project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(id).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(id, project.ssh!).catch(() => {})
        }
      })
    }
  }, [updateWindowViewState])

  const selectProjectHome = useCallback((projectId: string) => {
    const project = projectsRef.current.find(p => p.id === projectId) ?? null
    const homeTask = project?.tasks.find(t => t.system === 'home') ?? null
    if (!project || !homeTask) {
      selectProject(projectId)
      return
    }
    const homeTab = homeTask.tabs.left.find(t => t.system === 'home') ?? null
    updateWindowViewState(prev => {
      const expandedProjectIds = prev.expandedProjectIds.includes(projectId)
        ? prev.expandedProjectIds
        : [...prev.expandedProjectIds, projectId]
      const prevTaskState = prev.taskStates[homeTask.id] ?? createTaskViewState(homeTask)
      return {
        ...prev,
        selectedProjectId: projectId,
        selectedTaskId: homeTask.id,
        expandedProjectIds,
        taskStates: {
          ...prev.taskStates,
          [homeTask.id]: {
            ...prevTaskState,
            activeTab: {
              ...prevTaskState.activeTab,
              left: homeTab?.id ?? prevTaskState.activeTab.left
            }
          }
        }
      }
    })
    if (isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(projectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(projectId, project.ssh!).catch(() => {})
        }
      })
    }
  }, [selectProject, updateWindowViewState])

  const selectTask = useCallback((id: string | null) => {
    updateWindowViewState(prev => ({ ...prev, selectedTaskId: id }))
  }, [updateWindowViewState])

  const switchToTask = useCallback((projectId: string, taskId: string) => {
    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: projectId,
      selectedTaskId: taskId,
      expandedProjectIds: prev.expandedProjectIds.includes(projectId)
        ? prev.expandedProjectIds
        : [...prev.expandedProjectIds, projectId]
    }))

    markTaskVisited(projectId, taskId)

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(projectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(projectId, project.ssh!).catch(() => {})
        }
      })
    }
  }, [updateWindowViewState, markTaskVisited])

  const reorderTasks = useCallback((projectId: string, fromIndex: number, toIndex: number) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map((project) => {
        if (project.id !== projectId) return project
        const tasks = [...project.tasks]
        const [moved] = tasks.splice(fromIndex, 1)
        tasks.splice(toIndex, 0, moved)
        return { ...project, tasks }
      })
    }))
  }, [mutateProjects])

  const addProject = useCallback((name: string, directory: string, tagIds?: string[]) => {
    const id = uuid()
    const { task: homeTask } = createHomeTask(id)
    const project: Project = {
      id,
      name,
      directory,
      tasks: [homeTask],
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: [...data.projects, project],
        projectOrder: [...data.projectOrder, project.id]
      }
    })
    selectProject(project.id)
    return project
  }, [includePendingTags, mutateProjects, selectProject])

  const addRemoteProject = useCallback((
    name: string,
    sshConfig: SshConfig,
    aiToolArgs?: Partial<Record<AiTabType, string>>,
    tagIds?: string[]
  ) => {
    const id = uuid()
    const { task: homeTask } = createHomeTask(id)
    const project: Project = {
      id,
      name,
      directory: '',
      ssh: sshConfig,
      tasks: [homeTask],
      ...(aiToolArgs ? { aiToolArgs } : {}),
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: [...data.projects, project],
        projectOrder: [...data.projectOrder, project.id]
      }
    })
    selectProject(project.id)
    window.api.sshConnect(project.id, sshConfig).catch(() => {})
    return project
  }, [includePendingTags, mutateProjects, selectProject])

  const addShellCommandProject = useCallback((name: string, command: string, tagIds?: string[]) => {
    const id = uuid()
    const { task: homeTask } = createHomeTask(id)
    const project: Project = {
      id,
      name,
      directory: '',
      shellCommand: { command },
      tasks: [homeTask],
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: [...data.projects, project],
        projectOrder: [...data.projectOrder, project.id]
      }
    })
    selectProject(project.id)
    return project
  }, [includePendingTags, mutateProjects, selectProject])

  const getProjectDir = useCallback((project: Project): string => {
    return project.ssh ? project.ssh.remoteDir : project.directory
  }, [])

  const removeProject = useCallback(async (id: string) => {
    const doomed = projectsRef.current.find(p => p.id === id)
    // One dialog for the whole project, asked before anything is torn down.
    if (doomed) {
      const tabIds = doomed.tasks.flatMap(tabIdsOfTask)
      if (await confirmDiscardDirty(tabIds) === 'cancel') return
    }

    const project = projectsRef.current.find(p => p.id === id)
    if (project) {
      for (const task of project.tasks) {
        for (const tab of [...task.tabs.left, ...task.tabs.right]) {
          window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
          void window.api.scrollbackDelete(tab.id)
        }
        if (task.workspace) {
          await window.api.workspaceDelete(
            {
              projectDir: getProjectDir(project),
              projectId: project.ssh ? id : undefined,
              sshConfig: project.ssh,
              worktreePath: task.workspace.worktreePath,
              branchName: task.workspace.branchName,
              baseBranch: task.workspace.baseBranch,
              force: true
            }
          ).then(reportRefusedWorkspaceDelete).catch(() => {})
        }
      }
      if (project.ssh) {
        await window.api.sshDisconnect(id, project.ssh).catch(() => {})
      }
    }

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.filter(project => project.id !== id),
      projectOrder: prev.projectOrder.filter(rootId => rootId !== id)
    }))

    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: prev.selectedProjectId === id ? null : prev.selectedProjectId,
      selectedTaskId: prev.selectedProjectId === id ? null : prev.selectedTaskId,
      expandedProjectIds: prev.expandedProjectIds.filter(pid => pid !== id)
    }))
  }, [confirmDiscardDirty, getProjectDir, mutateProjects, updateWindowViewState])

  const renameProject = useCallback((id: string, name: string) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project => (project.id === id ? { ...project, name } : project))
    }))
  }, [mutateProjects])

  const updateProject = useCallback((id: string, updates: ProjectUpdate) => {
    mutateProjects(prev => {
      const data = includePendingTags(prev, updates.tagIds)
      return {
        ...data,
        projects: data.projects.map(project => (project.id === id ? { ...project, ...updates } : project))
      }
    })
  }, [includePendingTags, mutateProjects])

  const findOrCreateTagId = useCallback((data: ProjectsData, name: string): { data: ProjectsData; tagId: string } => {
    const trimmed = name.trim()
    if (!trimmed) return { data, tagId: '' }
    const existing = data.tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return { data, tagId: existing.id }
    const tagId = uuid()
    const tag: Tag = { id: tagId, name: trimmed }
    return { data: { ...data, tags: [...data.tags, tag] }, tagId }
  }, [])

  const addTag = useCallback((name: string): string => {
    const trimmed = name.trim()
    if (!trimmed) return ''
    const existing = projectsDataRef.current.tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return existing.id
    const pending = [...pendingTagsRef.current.values()].find(t => t.name.toLowerCase() === trimmed.toLowerCase())
    if (pending) return pending.id
    const tag: Tag = { id: uuid(), name: trimmed }
    pendingTagsRef.current.set(tag.id, tag)
    return tag.id
  }, [])

  const renameTag = useCallback((tagId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    mutateProjects(prev => ({
      ...prev,
      tags: prev.tags.map(tag => (tag.id === tagId ? { ...tag, name: trimmed } : tag))
    }))
  }, [mutateProjects])

  const setProjectTags = useCallback((projectId: string, tagIds: string[]) => {
    mutateProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: data.projects.map(project =>
          project.id === projectId ? { ...project, tagIds } : project
        )
      }
    })
  }, [includePendingTags, mutateProjects])

  const reorderProjects = useCallback((fromIndex: number, toIndex: number) => {
    mutateProjects(prev => {
      const newOrder = [...prev.projectOrder]
      const [moved] = newOrder.splice(fromIndex, 1)
      newOrder.splice(toIndex, 0, moved)
      return { ...prev, projectOrder: newOrder }
    })
  }, [mutateProjects])

  // `initialTabs` exists so a task can be born with its tabs: calling `addTab` right
  // after this would read a `projectsRef` that hasn't seen the task yet and clobber
  // the view state written below.
  const addTask = useCallback((projectId: string, name: string, initialTabs: Tab[] = []) => {
    const task: Task = {
      id: uuid(),
      name,
      tabs: { left: initialTabs, right: [] },
      activeTab: { left: initialTabs[initialTabs.length - 1]?.id ?? null, right: null },
      splitOpen: false,
      splitRatio: 0.5,
      // Creating a task is an interaction: without the stamp a brand-new task has
      // no activity at all and sinks to the bottom of the inbox's active group.
      lastInteractedAt: Date.now()
    }
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? incrementLifetimeStat({ ...project, tasks: [...project.tasks, task] }, 'tasksCreated')
          : project
      )
    }))
    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: projectId,
      selectedTaskId: task.id,
      taskStates: {
        ...prev.taskStates,
        [task.id]: createTaskViewState(task)
      }
    }))
    return task
  }, [mutateProjects, updateWindowViewState])

  const addWorkspaceTask = useCallback((
    projectId: string,
    name: string,
    workspace: WorkspaceConfig,
    initialTabs: Tab[] = []
  ) => {
    const task: Task = {
      id: uuid(),
      name,
      workspace,
      tabs: { left: initialTabs, right: [] },
      activeTab: { left: initialTabs[initialTabs.length - 1]?.id ?? null, right: null },
      splitOpen: false,
      splitRatio: 0.5,
      lastInteractedAt: Date.now()
    }
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? incrementLifetimeStat({ ...project, tasks: [...project.tasks, task] }, 'tasksCreated')
          : project
      )
    }))
    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: projectId,
      selectedTaskId: task.id,
      taskStates: {
        ...prev.taskStates,
        [task.id]: createTaskViewState(task)
      }
    }))
    return task
  }, [mutateProjects, updateWindowViewState])

  const removeTask = useCallback(async (projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => {
    const doomed = projectsRef.current
      .find(candidate => candidate.id === projectId)?.tasks
      .find(candidate => candidate.id === taskId)
    if (doomed && isHomeTask(doomed)) return
    // One dialog for every unsaved editor under the task, not one per tab.
    if (doomed && await confirmDiscardDirty(tabIdsOfTask(doomed)) === 'cancel') return

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (task && isHomeTask(task)) return
    if (task) {
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        void window.api.scrollbackDelete(tab.id)
      }
      if (task.workspace && project && !skipWorkspaceCleanup) {
        void window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: project.ssh ? projectId : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch,
            force: true
          }
        ).then(reportRefusedWorkspaceDelete).catch(() => {})
      }
    }

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? { ...project, tasks: project.tasks.filter(task => task.id !== taskId) }
          : project
      )
    }))

    updateWindowViewState(prev => {
      const taskStates = { ...prev.taskStates }
      delete taskStates[taskId]
      return {
        ...prev,
        selectedTaskId: prev.selectedTaskId === taskId ? null : prev.selectedTaskId,
        taskStates
      }
    })
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? { ...project, tasks: project.tasks.map(task => (task.id === taskId ? { ...task, name } : task)) }
          : project
      )
    }))
  }, [mutateProjects])

  const renameTab = useCallback((
    projectId: string,
    taskId: string,
    pane: 'left' | 'right',
    tabId: string,
    title: string
  ) => {
    const trimmed = title.trim()
    if (!trimmed) return
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      tabs: {
                        ...task.tabs,
                        [pane]: task.tabs[pane].map(tab =>
                          tab.id === tabId && tab.title !== trimmed
                            ? { ...tab, title: trimmed }
                            : tab
                        )
                      }
                    }
                  : task
              )
            }
          : project
      )
    }))
  }, [mutateProjects])

  const addTab = useCallback((
    projectId: string,
    taskId: string,
    pane: 'left' | 'right',
    type: TabType,
    arg?: string | AddTabOptions
  ) => {
    const options = typeof arg === 'string' ? { filePath: arg } : (arg ?? {})
    const tab = createTab(type, options)

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      tabs: { ...task.tabs, [pane]: [...task.tabs[pane], tab] }
                    }
                  : task
              )
            }
          : project
      )
    }))

    updateWindowViewState(prev => {
      const project = projectsRef.current.find(candidate => candidate.id === projectId)
      const task = project?.tasks.find(candidate => candidate.id === taskId)
      const currentState = task ? getTaskViewStateForTask(task) : createTaskViewState({
        id: taskId,
        name: '',
        tabs: { left: [], right: [] },
        activeTab: { left: null, right: null },
        splitOpen: false,
        splitRatio: 0.5
      })
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            activeTab: {
              ...currentState.activeTab,
              [pane]: tab.id
            }
          }
        }
      }
    })

    return tab
  }, [mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const removeTab = useCallback(async (projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    if (await confirmDiscardDirty([tabId]) === 'cancel') return

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    const tabIndex = task?.tabs[pane].findIndex(tab => tab.id === tabId) ?? -1
    const removedTab = tabIndex >= 0 ? task?.tabs[pane][tabIndex] ?? null : null
    if (removedTab && isHomeTab(removedTab)) return

    if (removedTab && tabIndex >= 0) {
      rememberClosedTab({
        projectId,
        taskId,
        pane,
        index: tabIndex,
        tab: removedTab
      })
    }

    updateWindowViewState(prev => {
      if (!task) return prev

      const currentState = getTaskViewStateForTask(task)
      const nextTabs = task.tabs[pane].filter(tab => tab.id !== tabId)
      const wasActive = currentState.activeTab[pane] === tabId

      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            activeTab: {
              ...currentState.activeTab,
              [pane]: wasActive ? (nextTabs[nextTabs.length - 1]?.id ?? null) : currentState.activeTab[pane]
            }
          }
        }
      }
    })

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task => {
                if (task.id !== taskId) return task
                return {
                  ...task,
                  tabs: {
                    ...task.tabs,
                    [pane]: task.tabs[pane].filter(tab => tab.id !== tabId)
                  }
                }
              })
            }
          : project
      )
    }))

    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState, getTaskViewStateForTask, rememberClosedTab])

  const reopenClosedTab = useCallback((): 'left' | 'right' | null => {
    const next = shiftRestorableClosedTab(recentlyClosedTabsRef.current, projectsRef.current)
    recentlyClosedTabsRef.current = next.history
    cleanupClosedTabHistory(next.stale)

    if (!next.entry) return null

    const { projectId, taskId, pane, index, tab } = next.entry
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (!project || !task) {
      cleanupClosedTabHistory([next.entry])
      return null
    }

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task => {
                if (task.id !== taskId) return task
                if (task.tabs[pane].some(existingTab => existingTab.id === tab.id)) return task

                const nextTabs = [...task.tabs[pane]]
                nextTabs.splice(Math.min(Math.max(index, 0), nextTabs.length), 0, tab)

                return {
                  ...task,
                  tabs: {
                    ...task.tabs,
                    [pane]: nextTabs
                  }
                }
              })
            }
          : project
      )
    }))

    updateWindowViewState(prev => {
      const currentState = getTaskViewStateForTask(task)
      return {
        ...prev,
        selectedProjectId: projectId,
        selectedTaskId: taskId,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            activeTab: {
              ...currentState.activeTab,
              [pane]: tab.id
            }
          }
        }
      }
    })

    if (isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(projectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(projectId, project.ssh!).catch(() => {})
        }
      })
    }

    return pane
  }, [cleanupClosedTabHistory, mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const updateTabUrl = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, url: string) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      tabs: {
                        ...task.tabs,
                        [pane]: task.tabs[pane].map(tab => (tab.id === tabId ? { ...tab, url } : tab))
                      }
                    }
                  : task
              )
            }
          : project
      )
    }))
  }, [mutateProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, sessionId: string) => {
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      tabs: {
                        ...task.tabs,
                        [pane]: task.tabs[pane].map(tab => (tab.id === tabId ? { ...tab, sessionId } : tab))
                      }
                    }
                  : task
              )
            }
          : project
      )
    }))
  }, [mutateProjects])

  const setActiveTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            activeTab: {
              ...currentState.activeTab,
              [pane]: tabId
            }
          }
        }
      }
    })
  }, [updateWindowViewState])

  const moveTab = useCallback((projectId: string, taskId: string, fromPane: 'left' | 'right', tabId: string, toPane: 'left' | 'right', toIndex: number) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (!task) return

    const currentState = getTaskViewStateForTask(task)
    const next = moveTaskTab({
      tabs: task.tabs,
      taskState: currentState,
      fromPane,
      tabId,
      toPane,
      toIndex
    })

    if (!next.moved) return

    updateWindowViewState(prev => ({
      ...prev,
      taskStates: {
        ...prev.taskStates,
        [taskId]: cloneTaskState(next.taskState)
      }
    }))

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      tabs: next.tabs
                    }
                  : task
              )
            }
          : project
      )
    }))
  }, [mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const toggleSplit = useCallback((projectId: string, taskId: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            splitOpen: !currentState.splitOpen
          }
        }
      }
    })
  }, [updateWindowViewState])

  const setSplitRatio = useCallback((projectId: string, taskId: string, ratio: number) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            splitRatio: ratio
          }
        }
      }
    })
  }, [updateWindowViewState])

  const toggleTagFilter = useCallback((tagId: string) => {
    updateWindowViewState(prev => ({
      ...prev,
      selectedTagIds: prev.selectedTagIds.includes(tagId)
        ? prev.selectedTagIds.filter(id => id !== tagId)
        : [...prev.selectedTagIds, tagId]
    }))
  }, [updateWindowViewState])

  const clearTagFilters = useCallback(() => {
    updateWindowViewState(prev => (
      prev.selectedTagIds.length === 0 ? prev : { ...prev, selectedTagIds: [] }
    ))
  }, [updateWindowViewState])

  const toggleProjectExpansion = useCallback((projectId: string) => {
    updateWindowViewState(prev => ({
      ...prev,
      expandedProjectIds: prev.expandedProjectIds.includes(projectId)
        ? prev.expandedProjectIds.filter(id => id !== projectId)
        : [...prev.expandedProjectIds, projectId]
    }))
  }, [updateWindowViewState])

  const setProjectExpanded = useCallback((projectId: string, expanded: boolean) => {
    updateWindowViewState(prev => {
      const isExpanded = prev.expandedProjectIds.includes(projectId)
      if (isExpanded === expanded) return prev
      return {
        ...prev,
        expandedProjectIds: expanded
          ? [...prev.expandedProjectIds, projectId]
          : prev.expandedProjectIds.filter(id => id !== projectId)
      }
    })
  }, [updateWindowViewState])

  const exportWindowViewState = useCallback(() => cloneWindowViewState(windowViewStateRef.current), [])

  const zoomTerminal = useCallback((direction: 'in' | 'out' | 'reset') => {
    setTerminalZoomDelta(prev => {
      if (direction === 'reset') return 0
      const step = direction === 'in' ? 2 : -2
      const next = prev + step
      const effective = (config?.fontSize ?? 14) + next
      if (effective < 6 || effective > 48) return prev
      return next
    })
  }, [config?.fontSize])

  const zoomBrowser = useCallback((direction: 'in' | 'out' | 'reset') => {
    setBrowserZoomFactor(prev => {
      if (direction === 'reset') return 1.0
      const step = direction === 'in' ? 0.1 : -0.1
      const next = Math.round((prev + step) * 10) / 10
      if (next < 0.3 || next > 3.0) return prev
      return next
    })
  }, [])

  const writeSidebarToCurrentTask = useCallback((
    prev: WindowViewState,
    patch: { fileBrowserOpen?: boolean; fileBrowserActiveTab?: FileBrowserTab }
  ): WindowViewState => {
    const taskId = prev.selectedTaskId
    const project = taskId ? projectsRef.current.find(p => p.tasks.some(t => t.id === taskId)) : null
    const task = project && taskId ? project.tasks.find(t => t.id === taskId) ?? null : null
    const next: WindowViewState = {
      ...prev,
      ...(patch.fileBrowserOpen !== undefined ? { fileBrowserOpen: patch.fileBrowserOpen } : {}),
      ...(patch.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: patch.fileBrowserActiveTab } : {})
    }
    if (!taskId || !task) return next
    const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
    next.taskStates = {
      ...prev.taskStates,
      [taskId]: {
        ...cloneTaskState(currentState),
        ...(patch.fileBrowserOpen !== undefined ? { fileBrowserOpen: patch.fileBrowserOpen } : {}),
        ...(patch.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: patch.fileBrowserActiveTab } : {})
      }
    }
    return next
  }, [])

  const toggleFileBrowser = useCallback(() => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserOpen: !prev.fileBrowserOpen }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const togglePinnedItem = useCallback((item: PinnedItem) => {
    const key = pinnedItemKey(item)
    mutateProjects(prev => {
      const existing = prev.pinnedItems ?? []
      const without = existing.filter(candidate => pinnedItemKey(candidate) !== key)
      return {
        ...prev,
        pinnedItems: without.length < existing.length ? without : [...existing, item]
      }
    })
  }, [mutateProjects])

  const setPinnedOrder = useCallback((items: PinnedItem[]) => {
    mutateProjects(prev => ({ ...prev, pinnedItems: [...items] }))
  }, [mutateProjects])

  const setFileBrowserWidth = useCallback((width: number) => {
    updateWindowViewState(prev => ({ ...prev, fileBrowserWidth: Math.min(400, Math.max(150, width)) }))
  }, [updateWindowViewState])

  const setSidebarWidth = useCallback((width: number) => {
    updateWindowViewState(prev => ({ ...prev, sidebarWidth: Math.min(420, Math.max(180, width)) }))
  }, [updateWindowViewState])

  const toggleSidebarProjectsCollapsed = useCallback(() => {
    updateWindowViewState(prev => ({ ...prev, sidebarProjectsCollapsed: !prev.sidebarProjectsCollapsed }))
  }, [updateWindowViewState])

  const setSidebarTab = useCallback((tab: SidebarTab) => {
    updateWindowViewState(prev => ({ ...prev, sidebarTab: tab }))
  }, [updateWindowViewState])

  const setFileBrowserOpen = useCallback((open: boolean) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserOpen: open }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const setFileBrowserActiveTab = useCallback((tab: FileBrowserTab) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserActiveTab: tab }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const openOrFocusDiffTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', filePath: string) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)
    if (!task) return

    const existingTab = [...task.tabs.left, ...task.tabs.right].find(
      t => t.type === 'diff' && t.filePath === filePath
    )
    if (existingTab) {
      const existingPane = task.tabs.left.includes(existingTab) ? 'left' : 'right'
      setActiveTab(projectId, taskId, existingPane, existingTab.id)
      return
    }

    addTab(projectId, taskId, pane, 'diff', filePath)
  }, [addTab, setActiveTab])

  const openOrFocusEditorTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', filePath: string) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)
    if (!task) return

    const existingTab = [...task.tabs.left, ...task.tabs.right].find(
      t => t.type === 'editor' && t.filePath === filePath
    )
    if (existingTab) {
      const existingPane = task.tabs.left.includes(existingTab) ? 'left' : 'right'
      setActiveTab(projectId, taskId, existingPane, existingTab.id)
      return
    }

    addTab(projectId, taskId, pane, 'editor', filePath)
  }, [addTab, setActiveTab])

  const createNote = useCallback((projectId: string, name: string): ProjectNote => {
    const note: ProjectNote = {
      id: uuid(),
      name,
      content: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    mutateNotes(prev => {
      const existing = prev[projectId] ?? []
      // A replay of this create must not add the note a second time.
      if (existing.some(n => n.id === note.id)) return prev
      return { ...prev, [projectId]: [...existing, note] }
    })
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId ? incrementLifetimeStat(project, 'notesCreated') : project
      )
    }))
    return note
  }, [mutateNotes, mutateProjects])

  const renameNote = useCallback((projectId: string, noteId: string, name: string) => {
    const renamedAt = Date.now()
    mutateNotes(prev => {
      const existing = prev[projectId]
      // Renaming a note another window deleted is dropped, not a resurrection.
      if (!existing?.some(n => n.id === noteId)) return prev
      return {
        ...prev,
        [projectId]: existing.map(n => (n.id === noteId ? { ...n, name, updatedAt: renamedAt } : n))
      }
    })
    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id !== projectId ? project : {
          ...project,
          tasks: project.tasks.map(task => ({
            ...task,
            tabs: {
              left: task.tabs.left.map(tab =>
                tab.type === 'note' && tab.noteId === noteId ? { ...tab, title: name } : tab
              ),
              right: task.tabs.right.map(tab =>
                tab.type === 'note' && tab.noteId === noteId ? { ...tab, title: name } : tab
              )
            }
          }))
        }
      )
    }))
  }, [mutateProjects])

  const deleteNote = useCallback((projectId: string, noteId: string) => {
    mutateNotes(prev => {
      const existing = prev[projectId]
      if (!existing?.some(n => n.id === noteId)) return prev
      return { ...prev, [projectId]: existing.filter(n => n.id !== noteId) }
    })

    const project = projectsRef.current.find(p => p.id === projectId)
    const removedTabIds: string[] = []
    if (project) {
      for (const task of project.tasks) {
        for (const tab of [...task.tabs.left, ...task.tabs.right]) {
          if (tab.type === 'note' && tab.noteId === noteId) {
            removedTabIds.push(tab.id)
          }
        }
      }
    }
    if (removedTabIds.length === 0) return

    updateWindowViewState(prev => {
      if (!project) return prev
      const nextTaskStates = { ...prev.taskStates }
      for (const task of project.tasks) {
        const currentState = reconcileTaskViewState(task, prev.taskStates[task.id])
        const nextActiveTab = { ...currentState.activeTab }
        let changed = false
        for (const pane of ['left', 'right'] as const) {
          const activeId = currentState.activeTab[pane]
          const activeTab = task.tabs[pane].find(tab => tab.id === activeId)
          if (activeTab && activeTab.type === 'note' && activeTab.noteId === noteId) {
            const remaining = task.tabs[pane].filter(
              tab => !(tab.type === 'note' && tab.noteId === noteId)
            )
            nextActiveTab[pane] = remaining[remaining.length - 1]?.id ?? null
            changed = true
          }
        }
        if (changed) {
          nextTaskStates[task.id] = {
            ...cloneTaskState(currentState),
            activeTab: nextActiveTab
          }
        }
      }
      return { ...prev, taskStates: nextTaskStates }
    })

    mutateProjects(prev => ({
      ...prev,
      projects: prev.projects.map(p =>
        p.id !== projectId ? p : {
          ...p,
          tasks: p.tasks.map(task => ({
            ...task,
            tabs: {
              left: task.tabs.left.filter(tab => !(tab.type === 'note' && tab.noteId === noteId)),
              right: task.tabs.right.filter(tab => !(tab.type === 'note' && tab.noteId === noteId))
            }
          }))
        }
      )
    }))

    for (const tabId of removedTabIds) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    }
  }, [mutateNotes, mutateProjects, updateWindowViewState])

  const updateNoteContent = useCallback((projectId: string, noteId: string, content: string) => {
    const now = Date.now()
    mutateNotes(
      prev => {
        const existing = prev[projectId]
        // The documented policy for a replay onto state where another window deleted
        // this note: the deletion wins and the edit is dropped. Resurrecting the note
        // would undo a deliberate delete with a keystroke nobody aimed at it.
        if (!existing?.some(n => n.id === noteId)) return prev
        return {
          ...prev,
          [projectId]: existing.map(n => (n.id === noteId ? { ...n, content, updatedAt: now } : n))
        }
      },
      // One coalesced entry per note: every keystroke replaces the last, so a replay
      // writes the newest text once instead of every intermediate value in order.
      { key: `note-content:${projectId}:${noteId}`, defer: true }
    )
  }, [mutateNotes])

  const openOrFocusNoteTab = useCallback((
    projectId: string,
    taskId: string | null,
    pane: 'left' | 'right',
    noteId: string
  ) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    if (!project) return

    // `taskId` may be missing, stale, or belong to a different project (the
    // palette can surface notes from any project). Fall back to the project's
    // own landing task instead of silently doing nothing.
    const targetTaskId = resolveLandingTaskId(project, taskId)
    const task = targetTaskId ? project.tasks.find(t => t.id === targetTaskId) : null
    if (!task || !targetTaskId) return

    const view = windowViewStateRef.current
    if (view.selectedProjectId !== projectId || view.selectedTaskId !== targetTaskId) {
      switchToTask(projectId, targetTaskId)
    }

    const allTabs = [...task.tabs.left, ...task.tabs.right]
    const existingTab = allTabs.find(t => t.type === 'note' && t.noteId === noteId)
    if (existingTab) {
      const existingPane = task.tabs.left.includes(existingTab) ? 'left' : 'right'
      setActiveTab(projectId, targetTaskId, existingPane, existingTab.id)
      return
    }

    const note = notesRef.current[projectId]?.find(n => n.id === noteId)
    if (!note) return

    addTab(projectId, targetTaskId, pane, 'note', { noteId, noteName: note.name })
  }, [addTab, setActiveTab, switchToTask])

  const selectedProjectId = windowViewState.selectedProjectId
  const selectedTaskId = windowViewState.selectedTaskId
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const selectedTask = selectedProject?.tasks.find(task => task.id === selectedTaskId) ?? null

  const effectiveTheme = config?.theme === 'system' || !config ? theme : config.theme
  const effectiveTerminalTheme = config?.terminalTheme === 'system' || !config ? theme : config.terminalTheme

  useEffect(() => {
    document.title = buildWindowTitle(
      selectedProject?.name ?? null,
      selectedTask?.name ?? null,
      selectedTask?.system === 'home'
    )
  }, [selectedProject?.name, selectedTask?.name, selectedTask?.system])

  return {
    projects,
    tags,
    projectOrder,
    pinnedItems: projectsData.pinnedItems,
    togglePinnedItem,
    setPinnedOrder,
    config,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    selectedTagIds: windowViewState.selectedTagIds,
    expandedProjectIds: windowViewState.expandedProjectIds,
    effectiveTheme,
    effectiveTerminalTheme,
    setSelectedProjectId: selectProject,
    selectProjectHome,
    setSelectedTaskId: selectTask,
    switchToTask,
    markTaskInteracted,
    markTaskEvent,
    markTaskVisited,
    markTaskUnread,
    settleTask,
    unsettleTask,
    snoozeTask,
    unsnoozeTask,
    addProject,
    addRemoteProject,
    addShellCommandProject,
    getProjectDir,
    removeProject,
    renameProject,
    updateProject,
    addTag,
    renameTag,
    setProjectTags,
    findOrCreateTagId,
    toggleTagFilter,
    clearTagFilters,
    reorderProjects,
    addTask,
    addWorkspaceTask,
    removeTask,
    renameTask,
    reorderTasks,
    addTab,
    removeTab,
    renameTab,
    dirtyPrompt,
    resolveDirtyPrompt,
    confirmDiscardDirty,
    stateSyncError,
    dismissStateSyncError,
    reopenClosedTab,
    updateTabUrl,
    updateTabSessionId,
    setActiveTab,
    moveTab,
    getTaskViewState: getTaskViewStateForTask,
    toggleSplit,
    setSplitRatio,
    toggleProjectExpansion,
    setProjectExpanded,
    exportWindowViewState,
    updateConfig,
    terminalZoomDelta,
    browserZoomFactor,
    zoomTerminal,
    zoomBrowser,
    fileBrowserOpen: windowViewState.fileBrowserOpen,
    fileBrowserWidth: windowViewState.fileBrowserWidth,
    fileBrowserActiveTab: windowViewState.fileBrowserActiveTab,
    toggleFileBrowser,
    setFileBrowserOpen,
    setFileBrowserWidth,
    sidebarWidth: windowViewState.sidebarWidth,
    setSidebarWidth,
    sidebarProjectsCollapsed: windowViewState.sidebarProjectsCollapsed,
    toggleSidebarProjectsCollapsed,
    sidebarTab: windowViewState.sidebarTab,
    setSidebarTab,
    setFileBrowserActiveTab,
    openOrFocusDiffTab,
    openOrFocusEditorTab,
    notes,
    createNote,
    renameNote,
    deleteNote,
    updateNoteContent,
    openOrFocusNoteTab
  }
}

export type AppActions = ReturnType<typeof useAppState>
