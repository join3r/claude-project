import { useState, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES, isRemoteProject } from '../../shared/types'
import type { Project, Task, Tab, AppConfig, TabType, AiTabType, SshConfig } from '../../shared/types'

export function useAppState() {
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

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

  // Persist projects on change
  const persistProjects = useCallback((updated: Project[]) => {
    setProjects(updated)
    window.api.saveProjects({ projects: updated })
  }, [])

  const reorderProjects = useCallback((fromIndex: number, toIndex: number) => {
    const updated = [...projects]
    const [moved] = updated.splice(fromIndex, 1)
    updated.splice(toIndex, 0, moved)
    persistProjects(updated)
  }, [projects, persistProjects])

  const reorderTasks = useCallback((projectId: string, fromIndex: number, toIndex: number) => {
    persistProjects(
      projects.map((p) => {
        if (p.id !== projectId) return p
        const tasks = [...p.tasks]
        const [moved] = tasks.splice(fromIndex, 1)
        tasks.splice(toIndex, 0, moved)
        return { ...p, tasks }
      })
    )
  }, [projects, persistProjects])

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    if (!config) return
    const newConfig = { ...config, ...updates }
    setConfig(newConfig)
    window.api.saveConfig(newConfig)
  }, [config])

  const selectProject = useCallback((id: string | null) => {
    setSelectedProjectId(id)
    if (config) {
      const newConfig = { ...config, lastProjectId: id, lastTaskId: null }
      setConfig(newConfig)
      window.api.saveConfig(newConfig)
    }
    // Auto-connect SSH for remote projects
    if (id) {
      const project = projects.find(p => p.id === id)
      if (project && isRemoteProject(project) && project.ssh) {
        window.api.sshStatus(id).then(status => {
          if (status !== 'connected' && status !== 'connecting') {
            window.api.sshConnect(id, project.ssh!).catch(() => {})
          }
        })
      }
    }
  }, [config, projects])

  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id)
    if (config) {
      const newConfig = { ...config, lastTaskId: id }
      setConfig(newConfig)
      window.api.saveConfig(newConfig)
    }
  }, [config])

  // Project CRUD
  const addProject = useCallback((name: string, directory: string) => {
    const project: Project = { id: uuid(), name, directory, tasks: [] }
    persistProjects([...projects, project])
    selectProject(project.id)
    return project
  }, [projects, persistProjects, selectProject])

  const addRemoteProject = useCallback((name: string, sshConfig: SshConfig) => {
    const project: Project = { id: uuid(), name, directory: '', ssh: sshConfig, tasks: [] }
    persistProjects([...projects, project])
    selectProject(project.id)
    window.api.sshConnect(project.id, sshConfig).catch(() => {
      // Connection failed — status change event will update UI
    })
    return project
  }, [projects, persistProjects, selectProject])

  const addShellCommandProject = useCallback((name: string, command: string) => {
    const project: Project = { id: uuid(), name, directory: '', shellCommand: { command }, tasks: [] }
    persistProjects([...projects, project])
    selectProject(project.id)
    return project
  }, [projects, persistProjects, selectProject])

  const getProjectDir = useCallback((project: Project): string => {
    return project.ssh ? project.ssh.remoteDir : project.directory
  }, [])

  const removeProject = useCallback((id: string) => {
    const project = projects.find(p => p.id === id)
    if (project) {
      for (const task of project.tasks) {
        for (const tab of [...task.tabs.left, ...task.tabs.right]) {
          window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
          window.api.scrollbackDelete(tab.id)
        }
      }
    }
    persistProjects(projects.filter((p) => p.id !== id))
    if (selectedProjectId === id) {
      selectProject(null)
      selectTask(null)
    }
  }, [projects, selectedProjectId, persistProjects, selectProject, selectTask])

  const renameProject = useCallback((id: string, name: string) => {
    persistProjects(projects.map((p) => (p.id === id ? { ...p, name } : p)))
  }, [projects, persistProjects])

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
    persistProjects(
      projects.map((p) =>
        p.id === projectId ? { ...p, tasks: [...p.tasks, task] } : p
      )
    )
    selectTask(task.id)
    return task
  }, [projects, persistProjects, selectTask])

  const removeTask = useCallback((projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)
    if (task) {
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        window.api.scrollbackDelete(tab.id)
      }
    }
    persistProjects(
      projects.map((p) =>
        p.id === projectId
          ? { ...p, tasks: p.tasks.filter((t) => t.id !== taskId) }
          : p
      )
    )
    if (selectedTaskId === taskId) selectTask(null)
  }, [projects, selectedTaskId, persistProjects, selectTask])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    persistProjects(
      projects.map((p) =>
        p.id === projectId
          ? { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, name } : t)) }
          : p
      )
    )
  }, [projects, persistProjects])

  // Tab management
  const addTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', type: TabType) => {
    const isAi = (AI_TAB_TYPES as readonly string[]).includes(type)
    const title = isAi ? AI_TAB_META[type as AiTabType].label : (type === 'terminal' ? 'Terminal' : 'Browser')
    const tab: Tab = { id: uuid(), type, title }
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

  const removeTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string, sessionId: string) => {
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

  const setActiveTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', tabId: string) => {
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

  const toggleSplit = useCallback((projectId: string, taskId: string) => {
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

  const setSplitRatio = useCallback((projectId: string, taskId: string, ratio: number) => {
    persistProjects(
      projects.map((p) =>
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
  }, [projects, persistProjects])

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
    addTask,
    removeTask,
    renameTask,
    reorderProjects,
    reorderTasks,
    addTab,
    removeTab,
    updateTabSessionId,
    setActiveTab,
    toggleSplit,
    setSplitRatio,
    updateConfig
  }
}

export type AppActions = ReturnType<typeof useAppState>
