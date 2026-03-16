import { useState, useEffect, useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES, isRemoteProject } from '../../shared/types'
import type { Project, Task, Tab, AppConfig, TabType, AiTabType, SshConfig, WorkspaceConfig } from '../../shared/types'
import { applyQueuedStateUpdates, resolveInitialSelection, type StateUpdater } from './stateHydration'

export type ProjectUpdate = Partial<Pick<Project, 'aiToolArgs'>>

export function useAppState() {
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [terminalZoomDelta, setTerminalZoomDelta] = useState(0)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1.0)

  // Refs for reading latest state in callbacks without stale closures
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const selectedProjectIdRef = useRef(selectedProjectId)
  selectedProjectIdRef.current = selectedProjectId
  const selectedTaskIdRef = useRef(selectedTaskId)
  selectedTaskIdRef.current = selectedTaskId
  const projectsLoadedRef = useRef(false)
  const configLoadedRef = useRef(false)
  const pendingProjectUpdatersRef = useRef<StateUpdater<Project[]>[]>([])
  const pendingConfigUpdatersRef = useRef<StateUpdater<AppConfig>[]>([])
  const lastSavedProjectsJsonRef = useRef<string | null>(null)
  const lastSavedConfigJsonRef = useRef<string | null>(null)

  // Load initial data
  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.api.loadProjects(),
      window.api.loadConfig()
    ]).then(([projectsData, loadedConfig]) => {
      if (cancelled) return

      const hydratedProjects = applyQueuedStateUpdates(projectsData.projects, pendingProjectUpdatersRef.current)
      const hydratedConfig = applyQueuedStateUpdates(loadedConfig, pendingConfigUpdatersRef.current)
      const restoredSelection = resolveInitialSelection(
        hydratedProjects,
        hydratedConfig,
        selectedProjectIdRef.current,
        selectedTaskIdRef.current
      )

      pendingProjectUpdatersRef.current = []
      pendingConfigUpdatersRef.current = []
      lastSavedProjectsJsonRef.current = JSON.stringify({ projects: projectsData.projects })
      lastSavedConfigJsonRef.current = JSON.stringify(loadedConfig)
      projectsLoadedRef.current = true
      configLoadedRef.current = true

      setProjects(hydratedProjects)
      setConfig(hydratedConfig)

      if (restoredSelection.projectId !== selectedProjectIdRef.current) {
        setSelectedProjectId(restoredSelection.projectId)
      }
      if (restoredSelection.taskId !== selectedTaskIdRef.current) {
        setSelectedTaskId(restoredSelection.taskId)
      }
    })
    window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!projectsLoadedRef.current) return

    const serialized = JSON.stringify({ projects })
    if (serialized === lastSavedProjectsJsonRef.current) return

    lastSavedProjectsJsonRef.current = serialized
    void window.api.saveProjects({ projects })
  }, [projects])

  useEffect(() => {
    if (!configLoadedRef.current || !config) return

    const serialized = JSON.stringify(config)
    if (serialized === lastSavedConfigJsonRef.current) return

    lastSavedConfigJsonRef.current = serialized
    void window.api.saveConfig(config)
  }, [config])

  // Auto-connect SSH for the restored remote project on startup.
  useEffect(() => {
    if (!selectedProjectId || projects.length === 0) return
    const project = projects.find(p => p.id === selectedProjectId)
    if (project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(selectedProjectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(selectedProjectId, project.ssh!).catch(() => {})
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length > 0 && selectedProjectId])

  const persistProjects = useCallback((updater: (prev: Project[]) => Project[]) => {
    if (!projectsLoadedRef.current) {
      pendingProjectUpdatersRef.current.push(updater)
    }
    setProjects(prev => updater(prev))
  }, [])

  const reorderProjects = useCallback((fromIndex: number, toIndex: number) => {
    persistProjects(prev => {
      const updated = [...prev]
      const [moved] = updated.splice(fromIndex, 1)
      updated.splice(toIndex, 0, moved)
      return updated
    })
  }, [persistProjects])

  const reorderTasks = useCallback((projectId: string, fromIndex: number, toIndex: number) => {
    persistProjects(prev =>
      prev.map((p) => {
        if (p.id !== projectId) return p
        const tasks = [...p.tasks]
        const [moved] = tasks.splice(fromIndex, 1)
        tasks.splice(toIndex, 0, moved)
        return { ...p, tasks }
      })
    )
  }, [persistProjects])

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, ...updates })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
  }, [])

  const selectProject = useCallback((id: string | null) => {
    setSelectedProjectId(id)
    // Restore per-project last task
    const project = id ? projectsRef.current.find(p => p.id === id) : null
    const restoredTaskId = project?.lastTaskId && project.tasks.some(t => t.id === project.lastTaskId)
      ? project.lastTaskId!
      : null
    setSelectedTaskId(restoredTaskId)
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, lastProjectId: id, lastTaskId: restoredTaskId })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
    // Auto-connect SSH for remote projects
    if (id && project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(id).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(id, project.ssh!).catch(() => {})
        }
      })
    }
  }, [])

  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id)
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, lastTaskId: id })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
    // Persist last task per project
    const projectId = selectedProjectIdRef.current
    if (projectId && id) {
      persistProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, lastTaskId: id } : p
      ))
    }
  }, [persistProjects])

  const switchToTask = useCallback((projectId: string, taskId: string) => {
    // Sync the ref before state updates so persistence logic uses the correct project
    selectedProjectIdRef.current = projectId
    setSelectedProjectId(projectId)
    setSelectedTaskId(taskId)
    const updater: StateUpdater<AppConfig> = (prev) => ({ ...prev, lastProjectId: projectId, lastTaskId: taskId })
    if (!configLoadedRef.current) {
      pendingConfigUpdatersRef.current.push(updater)
    }
    setConfig(prev => (prev ? updater(prev) : prev))
    // Auto-connect SSH for remote projects
    const project = projectsRef.current.find(p => p.id === projectId)
    if (project && isRemoteProject(project) && project.ssh) {
      window.api.sshStatus(projectId).then(status => {
        if (status !== 'connected' && status !== 'connecting') {
          window.api.sshConnect(projectId, project.ssh!).catch(() => {})
        }
      })
    }
  }, [])

  // Project CRUD
  const addProject = useCallback((name: string, directory: string) => {
    const project: Project = { id: uuid(), name, directory, tasks: [] }
    persistProjects(prev => [...prev, project])
    selectProject(project.id)
    return project
  }, [persistProjects, selectProject])

  const addRemoteProject = useCallback((name: string, sshConfig: SshConfig, aiToolArgs?: Partial<Record<AiTabType, string>>) => {
    const project: Project = { id: uuid(), name, directory: '', ssh: sshConfig, tasks: [], ...(aiToolArgs ? { aiToolArgs } : {}) }
    persistProjects(prev => [...prev, project])
    selectProject(project.id)
    window.api.sshConnect(project.id, sshConfig).catch(() => {
      // Connection failed — status change event will update UI
    })
    return project
  }, [persistProjects, selectProject])

  const addShellCommandProject = useCallback((name: string, command: string) => {
    const project: Project = { id: uuid(), name, directory: '', shellCommand: { command }, tasks: [] }
    persistProjects(prev => [...prev, project])
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
          window.api.scrollbackDelete(tab.id)
        }
        if (task.workspace) {
          window.api.workspaceDelete(
            project.directory, task.workspace.worktreePath,
            task.workspace.branchName, task.workspace.baseBranch, true
          ).catch(() => { /* Best effort cleanup */ })
        }
      }
    }
    persistProjects(prev => prev.filter((p) => p.id !== id))
    if (selectedProjectIdRef.current === id) {
      selectProject(null)
      selectTask(null)
    }
  }, [persistProjects, selectProject, selectTask])

  const renameProject = useCallback((id: string, name: string) => {
    persistProjects(prev => prev.map((p) => (p.id === id ? { ...p, name } : p)))
  }, [persistProjects])

  const updateProject = useCallback((id: string, updates: ProjectUpdate) => {
    persistProjects(prev => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)))
  }, [persistProjects])

  // Task CRUD
  const addTask = useCallback((projectId: string, name: string) => {
    const task: Task = {
      id: uuid(),
      name,
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5
    }
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId ? { ...p, tasks: [...p.tasks, task] } : p
      )
    )
    selectTask(task.id)
    return task
  }, [persistProjects, selectTask])

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
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId ? { ...p, tasks: [...p.tasks, task] } : p
      )
    )
    selectTask(task.id)
    return task
  }, [persistProjects, selectTask])

  const removeTask = useCallback((projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)
    if (task) {
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        window.api.scrollbackDelete(tab.id)
      }
      if (task.workspace && project && !skipWorkspaceCleanup) {
        window.api.workspaceDelete(
          project.directory, task.workspace.worktreePath,
          task.workspace.branchName, task.workspace.baseBranch, true
        ).catch(() => { /* Workspace may already be cleaned up */ })
      }
    }
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, tasks: p.tasks.filter((t) => t.id !== taskId) }
          : p
      )
    )
    if (selectedTaskIdRef.current === taskId) selectTask(null)
  }, [persistProjects, selectTask])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, name } : t)) }
          : p
      )
    )
  }, [persistProjects])

  // Tab management
  const addTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', type: TabType) => {
    const isAi = (AI_TAB_TYPES as readonly string[]).includes(type)
    const title = isAi ? AI_TAB_META[type as AiTabType].label : (type === 'terminal' ? 'Terminal' : 'Browser')
    const tab: Tab = { id: uuid(), type, title }
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      tabs: { ...t.tabs, [pane]: [...t.tabs[pane], tab] },
                      activeTab: { ...t.activeTab, [pane]: tab.id }
                    }
                  : t
              )
            }
          : p
      )
    )
    return tab
  }, [persistProjects])

  const removeTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) => {
                if (t.id !== taskId) return t
                const newTabs = t.tabs[pane].filter((tab) => tab.id !== tabId)
                const wasActive = t.activeTab[pane] === tabId
                return {
                  ...t,
                  tabs: { ...t.tabs, [pane]: newTabs },
                  activeTab: {
                    ...t.activeTab,
                    [pane]: wasActive ? (newTabs[newTabs.length - 1]?.id ?? null) : t.activeTab[pane]
                  }
                }
              })
            }
          : p
      )
    )
    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    window.api.scrollbackDelete(tabId)
  }, [persistProjects])

  const updateTabUrl = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, url: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      tabs: {
                        ...t.tabs,
                        [pane]: t.tabs[pane].map((tab) =>
                          tab.id === tabId ? { ...tab, url } : tab
                        )
                      }
                    }
                  : t
              )
            }
          : p
      )
    )
  }, [persistProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, sessionId: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      tabs: {
                        ...t.tabs,
                        [pane]: t.tabs[pane].map((tab) =>
                          tab.id === tabId ? { ...tab, sessionId } : tab
                        )
                      }
                    }
                  : t
              )
            }
          : p
      )
    )
  }, [persistProjects])

  const setActiveTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId
                  ? { ...t, activeTab: { ...t.activeTab, [pane]: tabId } }
                  : t
              )
            }
          : p
      )
    )
  }, [persistProjects])

  const toggleSplit = useCallback((projectId: string, taskId: string) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId ? { ...t, splitOpen: !t.splitOpen } : t
              )
            }
          : p
      )
    )
  }, [persistProjects])

  const setSplitRatio = useCallback((projectId: string, taskId: string, ratio: number) => {
    persistProjects(prev =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === taskId ? { ...t, splitRatio: ratio } : t
              )
            }
          : p
      )
    )
  }, [persistProjects])

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

  // Derived state
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null
  const selectedTask = selectedProject?.tasks.find((t) => t.id === selectedTaskId) ?? null

  const effectiveTheme = config?.theme === 'system' || !config ? theme : config.theme
  const effectiveTerminalTheme = config?.terminalTheme === 'system' || !config ? theme : config.terminalTheme

  return {
    projects,
    config,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
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
    addTask,
    addWorkspaceTask,
    removeTask,
    renameTask,
    reorderProjects,
    reorderTasks,
    addTab,
    removeTab,
    updateTabUrl,
    updateTabSessionId,
    setActiveTab,
    toggleSplit,
    setSplitRatio,
    updateConfig,
    terminalZoomDelta,
    browserZoomFactor,
    zoomTerminal,
    zoomBrowser
  }
}

export type AppActions = ReturnType<typeof useAppState>
