import { useState, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import type { Project, Task, Tab, AppConfig } from '../../shared/types'

export function useAppState() {
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  // Load initial data
  useEffect(() => {
    window.api.loadProjects().then((data) => setProjects(data.projects))
    window.api.loadConfig().then(setConfig)
    window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)
  }, [])

  // Persist projects on change
  const persistProjects = useCallback((updated: Project[]) => {
    setProjects(updated)
    window.api.saveProjects({ projects: updated })
  }, [])

  // Project CRUD
  const addProject = useCallback((name: string, directory: string) => {
    const project: Project = { id: uuid(), name, directory, tasks: [] }
    persistProjects([...projects, project])
    setSelectedProjectId(project.id)
    return project
  }, [projects, persistProjects])

  const removeProject = useCallback((id: string) => {
    persistProjects(projects.filter((p) => p.id !== id))
    if (selectedProjectId === id) {
      setSelectedProjectId(null)
      setSelectedTaskId(null)
    }
  }, [projects, selectedProjectId, persistProjects])

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
      splitOpen: false
    }
    persistProjects(
      projects.map((p) =>
        p.id === projectId ? { ...p, tasks: [...p.tasks, task] } : p
      )
    )
    setSelectedTaskId(task.id)
    return task
  }, [projects, persistProjects])

  const removeTask = useCallback((projectId: string, taskId: string) => {
    persistProjects(
      projects.map((p) =>
        p.id === projectId
          ? { ...p, tasks: p.tasks.filter((t) => t.id !== taskId) }
          : p
      )
    )
    if (selectedTaskId === taskId) setSelectedTaskId(null)
  }, [projects, selectedTaskId, persistProjects])

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
  const addTab = useCallback((projectId: string, taskId: string, pane: 'left' | 'right', type: 'terminal' | 'browser') => {
    const tab: Tab = { id: uuid(), type, title: type === 'terminal' ? 'Terminal' : 'Browser' }
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

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    if (!config) return
    const newConfig = { ...config, ...updates }
    setConfig(newConfig)
    window.api.saveConfig(newConfig)
  }, [config])

  // Derived state
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null
  const selectedTask = selectedProject?.tasks.find((t) => t.id === selectedTaskId) ?? null

  const effectiveTheme = config?.theme === 'system' || !config ? theme : config.theme

  return {
    projects,
    config,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    effectiveTheme,
    setSelectedProjectId,
    setSelectedTaskId,
    addProject,
    removeProject,
    renameProject,
    addTask,
    removeTask,
    renameTask,
    addTab,
    removeTab,
    setActiveTab,
    toggleSplit,
    updateConfig
  }
}

export type AppActions = ReturnType<typeof useAppState>
