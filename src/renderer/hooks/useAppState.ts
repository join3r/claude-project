import { useState, useEffect, useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
  AI_TAB_META,
  AI_TAB_TYPES,
  buildWindowViewState,
  cloneWindowViewState,
  createDefaultWindowViewState,
  createTaskViewState,
  isRemoteProject,
  reconcileTaskViewState,
  reconcileWindowViewState
} from '../../shared/types'
import type {
  Project,
  ProjectsData,
  Task,
  Tab,
  AppConfig,
  TabType,
  AiTabType,
  SshConfig,
  WorkspaceConfig,
  WindowViewState,
  TaskViewState
} from '../../shared/types'
import { applyQueuedStateUpdates, type StateUpdater } from './stateHydration'
import { moveTaskTab } from '../tabMove'

export type ProjectUpdate = Partial<Pick<Project, 'aiToolArgs'>>

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
    splitRatio: state.splitRatio
  }
}

export function useAppState() {
  const [projectsData, setProjectsData] = useState<ProjectsData>({ projects: [], folders: [], rootOrder: [] })
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [windowViewState, setWindowViewState] = useState<WindowViewState>(createDefaultWindowViewState())
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [terminalZoomDelta, setTerminalZoomDelta] = useState(0)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1.0)

  const projects = projectsData.projects
  const folders = projectsData.folders
  const rootOrder = projectsData.rootOrder

  const projectsDataRef = useRef(projectsData)
  projectsDataRef.current = projectsData
  const projectsRef = useRef(projects)
  projectsRef.current = projects
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
      window.api.loadWindowState()
    ]).then(([loadedProjectsData, loadedConfig, loadedWindowViewState]) => {
      if (cancelled) return

      const hydratedProjectsData = applyQueuedStateUpdates(loadedProjectsData, pendingProjectUpdatersRef.current)
      const hydratedConfig = applyQueuedStateUpdates(loadedConfig, pendingConfigUpdatersRef.current)
      const hydratedWindowViewState = buildWindowViewState(
        hydratedProjectsData.projects,
        hydratedConfig,
        loadedWindowViewState
      )

      pendingProjectUpdatersRef.current = []
      pendingConfigUpdatersRef.current = []
      lastSavedProjectsJsonRef.current = JSON.stringify(loadedProjectsData)
      lastSavedConfigJsonRef.current = JSON.stringify(loadedConfig)
      lastSavedWindowStateJsonRef.current = JSON.stringify(hydratedWindowViewState)
      projectsLoadedRef.current = true
      configLoadedRef.current = true
      windowStateLoadedRef.current = true

      setProjectsData(hydratedProjectsData)
      setConfig(hydratedConfig)
      setWindowViewState(hydratedWindowViewState)
    })

    void window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)

    const cleanupProjects = window.api.onProjectsUpdated((updatedProjectsData) => {
      if (cancelled) return
      lastSavedProjectsJsonRef.current = JSON.stringify(updatedProjectsData)
      setProjectsData(updatedProjectsData)
    })

    const cleanupConfig = window.api.onConfigUpdated((updatedConfig) => {
      if (cancelled) return
      lastSavedConfigJsonRef.current = JSON.stringify(updatedConfig)
      setConfig(updatedConfig)
    })

    return () => {
      cancelled = true
      cleanupProjects()
      cleanupConfig()
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
    const folderIds = new Set(folders.map(folder => folder.id))
    updateWindowViewState((prev) => {
      const next = reconcileWindowViewState(
        {
          ...prev,
          collapsedFolderIds: prev.collapsedFolderIds.filter(folderId => folderIds.has(folderId))
        },
        projects
      )
      return next
    })
  }, [folders, projects, updateWindowViewState])

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

  const persistProjects = useCallback((updater: (prev: ProjectsData) => ProjectsData) => {
    if (!projectsLoadedRef.current) {
      pendingProjectUpdatersRef.current.push(updater)
    }
    setProjectsData(prev => updater(prev))
  }, [])

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

      return {
        ...prev,
        selectedProjectId: id,
        selectedTaskId: restoredTaskId
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

  const selectTask = useCallback((id: string | null) => {
    updateWindowViewState(prev => ({ ...prev, selectedTaskId: id }))
  }, [updateWindowViewState])

  const switchToTask = useCallback((projectId: string, taskId: string) => {
    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: projectId,
      selectedTaskId: taskId
    }))

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(projectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(projectId, project.ssh!).catch(() => {})
        }
      })
    }
  }, [updateWindowViewState])

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

  const addProject = useCallback((name: string, directory: string) => {
    const project: Project = { id: uuid(), name, directory, tasks: [] }
    persistProjects(prev => ({
      ...prev,
      projects: [...prev.projects, project],
      rootOrder: [...prev.rootOrder, project.id]
    }))
    selectProject(project.id)
    return project
  }, [persistProjects, selectProject])

  const addRemoteProject = useCallback((name: string, sshConfig: SshConfig, aiToolArgs?: Partial<Record<AiTabType, string>>) => {
    const project: Project = { id: uuid(), name, directory: '', ssh: sshConfig, tasks: [], ...(aiToolArgs ? { aiToolArgs } : {}) }
    persistProjects(prev => ({
      ...prev,
      projects: [...prev.projects, project],
      rootOrder: [...prev.rootOrder, project.id]
    }))
    selectProject(project.id)
    window.api.sshConnect(project.id, sshConfig).catch(() => {})
    return project
  }, [persistProjects, selectProject])

  const addShellCommandProject = useCallback((name: string, command: string) => {
    const project: Project = { id: uuid(), name, directory: '', shellCommand: { command }, tasks: [] }
    persistProjects(prev => ({
      ...prev,
      projects: [...prev.projects, project],
      rootOrder: [...prev.rootOrder, project.id]
    }))
    selectProject(project.id)
    return project
  }, [persistProjects, selectProject])

  const getProjectDir = useCallback((project: Project): string => {
    return project.ssh ? project.ssh.remoteDir : project.directory
  }, [])

  const removeProject = useCallback((id: string) => {
    const project = projectsRef.current.find(p => p.id === id)
    if (project) {
      for (const task of project.tasks) {
        for (const tab of [...task.tabs.left, ...task.tabs.right]) {
          window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
          void window.api.scrollbackDelete(tab.id)
        }
        if (task.workspace) {
          void window.api.workspaceDelete(
            project.directory,
            task.workspace.worktreePath,
            task.workspace.branchName,
            task.workspace.baseBranch,
            true
          ).catch(() => {})
        }
      }
    }

    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.filter(project => project.id !== id),
      rootOrder: prev.rootOrder.filter(rootId => rootId !== id),
      folders: prev.folders.map(folder => ({
        ...folder,
        projectIds: folder.projectIds.filter(projectId => projectId !== id)
      }))
    }))

    updateWindowViewState(prev => ({
      ...prev,
      selectedProjectId: prev.selectedProjectId === id ? null : prev.selectedProjectId,
      selectedTaskId: prev.selectedProjectId === id ? null : prev.selectedTaskId
    }))
  }, [persistProjects, updateWindowViewState])

  const renameProject = useCallback((id: string, name: string) => {
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project => (project.id === id ? { ...project, name } : project))
    }))
  }, [persistProjects])

  const updateProject = useCallback((id: string, updates: ProjectUpdate) => {
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project => (project.id === id ? { ...project, ...updates } : project))
    }))
  }, [persistProjects])

  const addFolder = useCallback((): string => {
    const id = uuid()
    persistProjects(prev => ({
      ...prev,
      folders: [...prev.folders, { id, name: 'New Folder', projectIds: [] }],
      rootOrder: [...prev.rootOrder, id]
    }))
    return id
  }, [persistProjects])

  const removeFolder = useCallback((folderId: string) => {
    persistProjects(prev => {
      const folder = prev.folders.find(candidate => candidate.id === folderId)
      if (!folder) return prev
      const folderIndex = prev.rootOrder.indexOf(folderId)
      const newRootOrder = [...prev.rootOrder]
      newRootOrder.splice(folderIndex, 1, ...folder.projectIds)
      return {
        ...prev,
        folders: prev.folders.filter(candidate => candidate.id !== folderId),
        rootOrder: newRootOrder
      }
    })
    updateWindowViewState(prev => ({
      ...prev,
      collapsedFolderIds: prev.collapsedFolderIds.filter(id => id !== folderId)
    }))
  }, [persistProjects, updateWindowViewState])

  const renameFolder = useCallback((folderId: string, name: string) => {
    persistProjects(prev => ({
      ...prev,
      folders: prev.folders.map(folder => (folder.id === folderId ? { ...folder, name } : folder))
    }))
  }, [persistProjects])

  const moveProjectToFolder = useCallback((projectId: string, folderId: string) => {
    persistProjects(prev => ({
      ...prev,
      folders: prev.folders.map(folder => (
        folder.id === folderId
          ? { ...folder, projectIds: [...folder.projectIds.filter(id => id !== projectId), projectId] }
          : { ...folder, projectIds: folder.projectIds.filter(id => id !== projectId) }
      )),
      rootOrder: prev.rootOrder.filter(id => id !== projectId)
    }))
  }, [persistProjects])

  const moveProjectToRoot = useCallback((projectId: string, index: number) => {
    persistProjects(prev => {
      const newRootOrder = prev.rootOrder.filter(id => id !== projectId)
      newRootOrder.splice(index, 0, projectId)
      return {
        ...prev,
        folders: prev.folders.map(folder => ({
          ...folder,
          projectIds: folder.projectIds.filter(id => id !== projectId)
        })),
        rootOrder: newRootOrder
      }
    })
  }, [persistProjects])

  const reorderRootItems = useCallback((fromIndex: number, toIndex: number) => {
    persistProjects(prev => {
      const newRootOrder = [...prev.rootOrder]
      const [moved] = newRootOrder.splice(fromIndex, 1)
      newRootOrder.splice(toIndex, 0, moved)
      return { ...prev, rootOrder: newRootOrder }
    })
  }, [persistProjects])

  const reorderProjectsInFolder = useCallback((folderId: string, fromIndex: number, toIndex: number) => {
    persistProjects(prev => ({
      ...prev,
      folders: prev.folders.map(folder => {
        if (folder.id !== folderId) return folder
        const projectIds = [...folder.projectIds]
        const [moved] = projectIds.splice(fromIndex, 1)
        projectIds.splice(toIndex, 0, moved)
        return { ...folder, projectIds }
      })
    }))
  }, [persistProjects])

  const addTask = useCallback((projectId: string, name: string) => {
    const task: Task = {
      id: uuid(),
      name,
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5
    }
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId ? { ...project, tasks: [...project.tasks, task] } : project
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

  const addWorkspaceTask = useCallback((projectId: string, name: string, workspace: WorkspaceConfig) => {
    const task: Task = {
      id: uuid(),
      name,
      workspace,
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5
    }
    persistProjects(prev => ({
      ...prev,
      projects: prev.projects.map(project =>
        project.id === projectId ? { ...project, tasks: [...project.tasks, task] } : project
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
    if (task) {
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        void window.api.scrollbackDelete(tab.id)
      }
      if (task.workspace && project && !skipWorkspaceCleanup) {
        void window.api.workspaceDelete(
          project.directory,
          task.workspace.worktreePath,
          task.workspace.branchName,
          task.workspace.baseBranch,
          true
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

  const addTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', type: TabType) => {
    const isAi = (AI_TAB_TYPES as readonly string[]).includes(type)
    const title = isAi ? AI_TAB_META[type as AiTabType].label : (type === 'terminal' ? 'Terminal' : 'Browser')
    const tab: Tab = { id: uuid(), type, title }

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
    updateWindowViewState(prev => {
      const project = projectsRef.current.find(candidate => candidate.id === projectId)
      const task = project?.tasks.find(candidate => candidate.id === taskId)
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
    void window.api.scrollbackDelete(tabId)
  }, [persistProjects, updateWindowViewState, getTaskViewStateForTask])

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

  const toggleFolderCollapse = useCallback((folderId: string) => {
    updateWindowViewState(prev => ({
      ...prev,
      collapsedFolderIds: prev.collapsedFolderIds.includes(folderId)
        ? prev.collapsedFolderIds.filter(id => id !== folderId)
        : [...prev.collapsedFolderIds, folderId]
    }))
  }, [updateWindowViewState])

  const setFolderCollapsed = useCallback((folderId: string, collapsed: boolean) => {
    updateWindowViewState(prev => {
      const isCollapsed = prev.collapsedFolderIds.includes(folderId)
      if (isCollapsed === collapsed) return prev
      return {
        ...prev,
        collapsedFolderIds: collapsed
          ? [...prev.collapsedFolderIds, folderId]
          : prev.collapsedFolderIds.filter(id => id !== folderId)
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

  const selectedProjectId = windowViewState.selectedProjectId
  const selectedTaskId = windowViewState.selectedTaskId
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const selectedTask = selectedProject?.tasks.find(task => task.id === selectedTaskId) ?? null

  const effectiveTheme = config?.theme === 'system' || !config ? theme : config.theme
  const effectiveTerminalTheme = config?.terminalTheme === 'system' || !config ? theme : config.terminalTheme

  return {
    projects,
    folders,
    rootOrder,
    config,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    collapsedFolderIds: windowViewState.collapsedFolderIds,
    effectiveTheme,
    effectiveTerminalTheme,
    setSelectedProjectId: selectProject,
    setSelectedTaskId: selectTask,
    switchToTask,
    addProject,
    addRemoteProject,
    addShellCommandProject,
    getProjectDir,
    removeProject,
    renameProject,
    updateProject,
    addFolder,
    removeFolder,
    renameFolder,
    moveProjectToFolder,
    moveProjectToRoot,
    reorderRootItems,
    reorderProjectsInFolder,
    addTask,
    addWorkspaceTask,
    removeTask,
    renameTask,
    reorderTasks,
    addTab,
    removeTab,
    updateTabUrl,
    updateTabSessionId,
    setActiveTab,
    moveTab,
    getTaskViewState: getTaskViewStateForTask,
    toggleSplit,
    setSplitRatio,
    toggleFolderCollapse,
    setFolderCollapsed,
    exportWindowViewState,
    updateConfig,
    terminalZoomDelta,
    browserZoomFactor,
    zoomTerminal,
    zoomBrowser
  }
}

export type AppActions = ReturnType<typeof useAppState>
