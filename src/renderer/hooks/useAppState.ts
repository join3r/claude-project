import { useState, useEffect, useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES, isRemoteProject } from '../../shared/types'
import type { Project, Task, Tab, AppConfig, TabType, AiTabType, SshConfig, WorkspaceConfig } from '../../shared/types'

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

  // Load initial data
  useEffect(() => {
    Promise.all([
      window.api.loadProjects(),
      window.api.loadConfig()
    ]).then(([projectsData, loadedConfig]) => {
      setProjects(projectsData.projects)
      setConfig(loadedConfig)

      if (loadedConfig.lastProjectId) {
        const project = projectsData.projects.find((p) => p.id === loadedConfig.lastProjectId)
        if (project) {
          setSelectedProjectId(loadedConfig.lastProjectId)
          if (loadedConfig.lastTaskId) {
            const task = project.tasks.find((t) => t.id === loadedConfig.lastTaskId)
            if (task) setSelectedTaskId(loadedConfig.lastTaskId)
          }
        }
      }
    })
    window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)
  }, [])

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

  // Persist projects using functional updater to avoid stale closures
  const persistProjects = useCallback((updater: (prev: Project[]) => Project[]) => {
    setProjects(prev => {
      const updated = updater(prev)
      window.api.saveProjects({ projects: updated })
      return updated
    })
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
    setConfig(prev => {
      if (!prev) return prev
      const newConfig = { ...prev, ...updates }
      window.api.saveConfig(newConfig)
      return newConfig
    })
  }, [])

  const selectProject = useCallback((id: string | null) => {
    setSelectedProjectId(id)
    setConfig(prev => {
      if (!prev) return prev
      const newConfig = { ...prev, lastProjectId: id, lastTaskId: null }
      window.api.saveConfig(newConfig)
      return newConfig
    })
    // Auto-connect SSH for remote projects
    if (id) {
      const project = projectsRef.current.find(p => p.id === id)
      if (project && isRemoteProject(project) && project.ssh) {
        window.api.sshStatus(id).then(status => {
          if (status !== 'connected' && status !== 'connecting') {
            window.api.sshConnect(id, project.ssh!).catch(() => {})
          }
        })
      }
    }
  }, [])

  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id)
    setConfig(prev => {
      if (!prev) return prev
      const newConfig = { ...prev, lastTaskId: id }
      window.api.saveConfig(newConfig)
      return newConfig
    })
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
