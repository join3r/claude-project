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
  WindowViewState,
  TaskViewState,
  TaskInboxState,
  SidebarTab,
  FileBrowserTab
} from '../../shared/types'
import { applyQueuedStateUpdates, persistSelectionState, type StateUpdater } from './stateHydration'
import { backfillLifetimeStats, incrementLifetimeStat } from './lifetimeStats'
import { moveTaskTab } from '../tabMove'
import {
  pushRecentlyClosedTab,
  shiftRestorableClosedTab,
  type RecentlyClosedTab
} from '../recentlyClosedTabs'
import { createInteractionStampGate } from '../components/taskRecency'
import { createTab, type CreateTabOptions } from '../components/newTaskTabs'

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
  const [notes, setNotes] = useState<Record<string, ProjectNote[]>>({})
  const notesRef = useRef<Record<string, ProjectNote[]>>({})
  notesRef.current = notes
  const noteContentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateWindowViewState = useCallback((updater: (prev: WindowViewState) => WindowViewState) => {
    setWindowViewState(prev => {
      const next = updater(prev)
      return areWindowStatesEqual(prev, next) ? prev : next
    })
  }, [])

  const getTaskViewStateForTask = useCallback((task: Task): TaskViewState => {
    return reconcileTaskViewState(task, windowViewStateRef.current.taskStates[task.id])
  }, [])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.api.loadProjects(),
      window.api.loadConfig(),
      window.api.loadWindowState(),
      window.api.notesLoad()
    ]).then(([loadedProjectsData, loadedConfig, loadedWindowViewState, loadedNotes]) => {
      if (cancelled) return

      const hydratedProjectsData = applyQueuedStateUpdates(loadedProjectsData, pendingProjectUpdatersRef.current)
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

      setProjectsData(finalProjectsData)
      setConfig(hydratedConfig)
      setWindowViewState(hydratedWindowViewState)
      setNotes(loadedNotes)
    })

    void window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)

    const cleanupProjects = window.api.onProjectsUpdated((updatedProjectsData) => {
      if (cancelled) return
      const projectsWithLifetime = updatedProjectsData.projects.map(p =>
        backfillLifetimeStats(p, notesRef.current)
      )
      const final = { ...updatedProjectsData, projects: projectsWithLifetime }
      const serialized = JSON.stringify(final)
      if (serialized === lastSavedProjectsJsonRef.current) return
      lastSavedProjectsJsonRef.current = serialized
      setProjectsData(final)
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
      cleanupConfig()
    }
  }, [])

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
    void window.api.saveProjects(projectsData)
  }, [projectsData])

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

    const selection = persistSelectionState(
      projectsData,
      config,
      windowViewState.selectedProjectId,
      windowViewState.selectedTaskId
    )

    if (selection.projectsData !== projectsData) {
      setProjectsData(selection.projectsData)
    }

    if (selection.config !== config) {
      setConfig(selection.config)
    }
  }, [
    config,
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

  const persistProjects = useCallback((updater: (prev: ProjectsData) => ProjectsData) => {
    const wrapped = (prev: ProjectsData) => pruneUnusedTags(updater(prev))
    if (!projectsLoadedRef.current) {
      pendingProjectUpdatersRef.current.push(wrapped)
    }
    setProjectsData(prev => wrapped(prev))
  }, [])

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
    persistProjects(prev => ({
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
  }, [persistProjects])

  const updateTaskInbox = useCallback((
    projectId: string,
    taskId: string,
    updater: (inbox: TaskInboxState) => TaskInboxState
  ) => {
    persistProjects(prev => ({
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
  }, [persistProjects])

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
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map((project) => {
        if (project.id !== projectId) return project
        const tasks = [...project.tasks]
        const [moved] = tasks.splice(fromIndex, 1)
        tasks.splice(toIndex, 0, moved)
        return { ...project, tasks }
      })
    }))
  }, [persistProjects])

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
    persistProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: [...data.projects, project],
        projectOrder: [...data.projectOrder, project.id]
      }
    })
    selectProject(project.id)
    return project
  }, [includePendingTags, persistProjects, selectProject])

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
    persistProjects(prev => {
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
  }, [includePendingTags, persistProjects, selectProject])

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
    persistProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: [...data.projects, project],
        projectOrder: [...data.projectOrder, project.id]
      }
    })
    selectProject(project.id)
    return project
  }, [includePendingTags, persistProjects, selectProject])

  const getProjectDir = useCallback((project: Project): string => {
    return project.ssh ? project.ssh.remoteDir : project.directory
  }, [])

  const removeProject = useCallback(async (id: string) => {
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
          ).catch(() => {})
        }
      }
      if (project.ssh) {
        await window.api.sshDisconnect(id, project.ssh).catch(() => {})
      }
    }

    persistProjects(prev => ({
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
  }, [getProjectDir, persistProjects, updateWindowViewState])

  const renameProject = useCallback((id: string, name: string) => {
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project => (project.id === id ? { ...project, name } : project))
    }))
  }, [persistProjects])

  const updateProject = useCallback((id: string, updates: ProjectUpdate) => {
    persistProjects(prev => {
      const data = includePendingTags(prev, updates.tagIds)
      return {
        ...data,
        projects: data.projects.map(project => (project.id === id ? { ...project, ...updates } : project))
      }
    })
  }, [includePendingTags, persistProjects])

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
    persistProjects(prev => ({
      ...prev,
      tags: prev.tags.map(tag => (tag.id === tagId ? { ...tag, name: trimmed } : tag))
    }))
  }, [persistProjects])

  const setProjectTags = useCallback((projectId: string, tagIds: string[]) => {
    persistProjects(prev => {
      const data = includePendingTags(prev, tagIds)
      return {
        ...data,
        projects: data.projects.map(project =>
          project.id === projectId ? { ...project, tagIds } : project
        )
      }
    })
  }, [includePendingTags, persistProjects])

  const reorderProjects = useCallback((fromIndex: number, toIndex: number) => {
    persistProjects(prev => {
      const newOrder = [...prev.projectOrder]
      const [moved] = newOrder.splice(fromIndex, 1)
      newOrder.splice(toIndex, 0, moved)
      return { ...prev, projectOrder: newOrder }
    })
  }, [persistProjects])

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
    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState])

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
    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState])

  const removeTask = useCallback((projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => {
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
        ).catch(() => {})
      }
    }

    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId
          ? { ...project, tasks: project.tasks.map(task => (task.id === taskId ? { ...task, name } : task)) }
          : project
      )
    }))
  }, [persistProjects])

  const renameTab = useCallback((
    projectId: string,
    taskId: string,
    pane: 'left' | 'right',
    tabId: string,
    title: string
  ) => {
    const trimmed = title.trim()
    if (!trimmed) return
    persistProjects(prev => ({
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
  }, [persistProjects])

  const addTab = useCallback((
    projectId: string,
    taskId: string,
    pane: 'left' | 'right',
    type: TabType,
    arg?: string | AddTabOptions
  ) => {
    const options = typeof arg === 'string' ? { filePath: arg } : (arg ?? {})
    const tab = createTab(type, options)

    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState, getTaskViewStateForTask])

  const removeTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
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

    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState, getTaskViewStateForTask, rememberClosedTab])

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

    persistProjects(prev => ({
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
  }, [cleanupClosedTabHistory, persistProjects, updateWindowViewState, getTaskViewStateForTask])

  const updateTabUrl = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, url: string) => {
    persistProjects(prev => ({
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
  }, [persistProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, sessionId: string) => {
    persistProjects(prev => ({
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
  }, [persistProjects])

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

    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState, getTaskViewStateForTask])

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
    persistProjects(prev => {
      const existing = prev.pinnedItems ?? []
      const without = existing.filter(candidate => pinnedItemKey(candidate) !== key)
      return {
        ...prev,
        pinnedItems: without.length < existing.length ? without : [...existing, item]
      }
    })
  }, [persistProjects])

  const setPinnedOrder = useCallback((items: PinnedItem[]) => {
    persistProjects(prev => ({ ...prev, pinnedItems: [...items] }))
  }, [persistProjects])

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
    setNotes(prev => {
      const updated = { ...prev, [projectId]: [...(prev[projectId] ?? []), note] }
      void window.api.notesSave(updated)
      return updated
    })
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId ? incrementLifetimeStat(project, 'notesCreated') : project
      )
    }))
    return note
  }, [persistProjects])

  const renameNote = useCallback((projectId: string, noteId: string, name: string) => {
    setNotes(prev => {
      const updated = {
        ...prev,
        [projectId]: (prev[projectId] ?? []).map(n =>
          n.id === noteId ? { ...n, name, updatedAt: Date.now() } : n
        )
      }
      void window.api.notesSave(updated)
      return updated
    })
    persistProjects(prev => ({
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
  }, [persistProjects])

  const deleteNote = useCallback((projectId: string, noteId: string) => {
    setNotes(prev => {
      const updated = {
        ...prev,
        [projectId]: (prev[projectId] ?? []).filter(n => n.id !== noteId)
      }
      void window.api.notesSave(updated)
      return updated
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

    persistProjects(prev => ({
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
  }, [persistProjects, updateWindowViewState])

  const updateNoteContent = useCallback((projectId: string, noteId: string, content: string) => {
    const now = Date.now()
    setNotes(prev => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map(n =>
        n.id === noteId ? { ...n, content, updatedAt: now } : n
      )
    }))
    if (noteContentSaveTimerRef.current !== null) clearTimeout(noteContentSaveTimerRef.current)
    noteContentSaveTimerRef.current = setTimeout(() => {
      noteContentSaveTimerRef.current = null
      void window.api.notesSave(notesRef.current)
    }, 500)
  }, [])

  const openOrFocusNoteTab = useCallback((
    projectId: string,
    taskId: string,
    pane: 'left' | 'right',
    noteId: string
  ) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)
    if (!task) return

    const allTabs = [...task.tabs.left, ...task.tabs.right]
    const existingTab = allTabs.find(t => t.type === 'note' && t.noteId === noteId)
    if (existingTab) {
      const existingPane = task.tabs.left.includes(existingTab) ? 'left' : 'right'
      setActiveTab(projectId, taskId, existingPane, existingTab.id)
      return
    }

    const note = notesRef.current[projectId]?.find(n => n.id === noteId)
    if (!note) return

    addTab(projectId, taskId, pane, 'note', { noteId, noteName: note.name })
  }, [addTab, setActiveTab])

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
