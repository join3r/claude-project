import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useTabStatusStore, type TabStatusValue } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isHomeTask, isRemoteProject, isShellCommandProject, isWorkspaceTask, projectMatchesTagFilter } from '../../shared/types'
import type { Tab, Task, Project } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import CreateWorkspaceModal from './CreateWorkspaceModal'
import AddShellCommandProject from './AddShellCommandProject'
import AddLocalProject from './AddLocalProject'
import ProjectSettings from './ProjectSettings'
import Settings from './Settings'
import ProjectSwitcher from './ProjectSwitcher'
import ActivityPanel from './ActivityPanel'
import { getReorderInsertIndex, getTaskDropIndex } from './sidebarDrag'
import { buildRecencyStyle, computeTaskRecencyOpacity, sortTasksByRecency } from './taskRecency'
import { ChevronDown, ChevronRight, Plus, Search, Settings as SettingsIcon, Plug, Terminal as TerminalIcon } from 'lucide-react'
import { paletteEvents } from '../palette/paletteEvents'
import { dashboardIconUrl, fetchDashboardIconsMetadata, type DashboardIconsMetadata } from './dashboardIcons'

type DragState = {
  type: 'project' | 'task'
  id: string
  index: number
  projectId?: string
}

type DropTarget =
  | { type: 'between-projects'; index: number }
  | { type: 'between-tasks'; projectId: string; index: number }
  | null

function getTaskStatus(task: Task, allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const aiTabIds = [...task.tabs.left, ...task.tabs.right]
    .filter((t) => (AI_TAB_TYPES as readonly string[]).includes(t.type))
    .map((t) => t.id)
  if (aiTabIds.length === 0) return null
  const statuses = aiTabIds.map((id) => allStatuses[id]).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

function getProjectStatus(tasks: Task[], allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const statuses = tasks.map((t) => getTaskStatus(t, allStatuses)).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

/** px-3 + chevron (12) + gap-2 (8) + icon slot (w-5 = 20) + 2px nest under name */
const TASK_ROW_PL = 'pl-[54px]'
const TASK_ROW_ML = 'ml-[54px]'

function getProjectInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/[\s\-_/]+/).filter(Boolean)
  if (words.length >= 2) {
    const a = words[0]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    const b = words[1]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    if (a && b) return (a + b).toUpperCase()
  }
  const letters = (words[0] ?? trimmed).replace(/[^a-zA-Z0-9]/g, '')
  if (!letters) return '?'
  return letters.slice(0, 2).toUpperCase()
}

function ProjectIconSlot({
  project,
  theme,
  metadata,
}: {
  project: Project
  theme: 'dark' | 'light'
  metadata: DashboardIconsMetadata | null
}): React.ReactElement {
  const [iconFailed, setIconFailed] = useState(false)
  const iconUrl = project.icon && !iconFailed
    ? dashboardIconUrl(project.icon, { theme, metadata: metadata ?? undefined })
    : null

  return (
    <span className="w-5 shrink-0 flex items-center justify-center">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="w-3.5 h-3.5 object-contain"
          onError={() => setIconFailed(true)}
        />
      ) : project.emoji ? (
        <span className="text-[13px] leading-none">{project.emoji}</span>
      ) : (
        <span
          className="w-3.5 h-3.5 rounded-sm bg-surface-3 text-text-muted text-[8px] font-semibold leading-none flex items-center justify-center"
          title={project.name}
        >
          {getProjectInitials(project.name)}
        </span>
      )}
    </span>
  )
}

function TaskStatusDot({ task, allStatuses }: { task: Task; allStatuses: Record<string, TabStatusValue> }): React.ReactElement | null {
  const status = getTaskStatus(task, allStatuses)
  if (!status) return null
  const dotClass = status === 'working'
    ? 'bg-status-working animate-pulse'
    : status === 'attention'
    ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
    : 'bg-status-exited'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${dotClass}`} />
}

export default function Sidebar({ switcherRequested, onSwitcherConsumed }: { switcherRequested?: boolean; onSwitcherConsumed?: () => void }): React.ReactElement {
  const {
    projects, tags, projectOrder,
    selectedProjectId, selectedTaskId, selectedTagIds,
    switchToTask, selectProjectHome,
    addProject, addRemoteProject, addShellCommandProject, addTag, removeProject, renameProject, updateProject,
    addTask, addWorkspaceTask, removeTask, renameTask,
    reorderProjects, reorderTasks, getProjectDir,
    config, updateConfig,
    toggleTagFilter,
    expandedProjectIds, toggleProjectExpansion,
    effectiveTheme
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const tabStatusStore = useTabStatusStore()

  const [now, setNow] = useState(() => Date.now())
  const sortedByRecency = React.useMemo(
    () => sortTasksByRecency(projects.flatMap(p => p.tasks.filter(t => !isHomeTask(t)))),
    [projects]
  )

  useEffect(() => {
    if (!config?.taskRecencyHighlight?.enabled) return
    if (config.taskRecencyHighlight.mode !== 'time') return
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [config?.taskRecencyHighlight?.enabled, config?.taskRecencyHighlight?.mode])

  const handleSelectTask = useCallback((projectId: string, task: Task) => {
    switchToTask(projectId, task.id)
    const aiTabs = [...task.tabs.left, ...task.tabs.right]
      .filter((t) => (AI_TAB_TYPES as readonly string[]).includes(t.type))
    for (const tab of aiTabs) {
      if (tabStatusStore.getStatus(tab.id) === 'attention') {
        tabStatusStore.setStatus(tab.id, null)
      }
    }
  }, [switchToTask, tabStatusStore])

  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'project' | 'task'; projectId: string; taskId?: string
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const [shellCommandModalOpen, setShellCommandModalOpen] = useState(false)
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})
  const [iconMetadata, setIconMetadata] = useState<DashboardIconsMetadata | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const dropTargetRef = useRef<DropTarget>(null)
  const [workspaceModalProjectId, setWorkspaceModalProjectId] = useState<string | null>(null)
  const [duplicateProjectId, setDuplicateProjectId] = useState<string | null>(null)
  const [switcherActive, setSwitcherActive] = useState(false)
  const expandedProjects = new Set(expandedProjectIds)
  const projectsById = React.useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  const visibleProjectIds = React.useMemo(() => {
    const filterActive = selectedTagIds.length > 0
    return projectOrder.filter(id => {
      const project = projectsById.get(id)
      if (!project) return false
      return filterActive ? projectMatchesTagFilter(project, selectedTagIds) : true
    })
  }, [projectOrder, projectsById, selectedTagIds])
  const sortedTags = React.useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags]
  )

  useEffect(() => {
    if (switcherRequested) {
      setSwitcherActive(true)
      onSwitcherConsumed?.()
    }
  }, [switcherRequested, onSwitcherConsumed])

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus()
  }, [editingId])

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    let cancelled = false
    fetchDashboardIconsMetadata()
      .then((m) => { if (!cancelled) setIconMetadata(m) })
      .catch(() => { /* CDN unreachable — icons fall back to slug-as-given */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    dropTargetRef.current = dropTarget
  }, [dropTarget])

  useEffect(() => {
    const dismiss = () => { setContextMenu(null); setAddMenuOpen(false) }
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [])

  useEffect(() => {
    return window.api.onMenuProjectSwitcher(() => {
      setSwitcherActive(prev => !prev)
    })
  }, [])

  useEffect(() => {
    return window.api.onMenuOpenSettings(() => {
      setSettingsOpen(true)
    })
  }, [])

  useEffect(() => {
    return paletteEvents.on('open-settings', () => setSettingsOpen(true))
  }, [])
  useEffect(() => {
    return paletteEvents.on('open-project-settings', () => {
      if (selectedProjectId) setProjectSettingsId(selectedProjectId)
    })
  }, [selectedProjectId])

  useEffect(() => {
    window.api.onSshStatusChanged((projectId: string, status: string) => {
      setSshStatuses(prev => ({ ...prev, [projectId]: status }))
    })
  }, [])

  useEffect(() => {
    projects.filter(isRemoteProject).forEach(p => {
      window.api.sshStatus(p.id).then(status => {
        setSshStatuses(prev => ({ ...prev, [p.id]: status }))
      })
    })
  }, [projects])

  const handleAddProject = async () => {
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const name = dir.split('/').pop() || 'Untitled'
    const project = addProject(name, dir)
    setEditingId(project.id)
    setEditValue(project.name)
  }

  const handleAddTask = (projectId: string) => {
    const task = addTask(projectId, 'New Task')
    setEditingId(task.id)
    setEditValue(task.name)
  }

  const handleAddWorkspace = (projectId: string) => {
    setWorkspaceModalProjectId(projectId)
  }

  const handleDeleteTask = async (projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)

    if (task?.workspace && project) {
      let keepBranch = false
      try {
        const result = await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch
          }
        )
        if (result.status === 'uncommitted') {
          if (!window.confirm('This workspace has uncommitted changes that will be lost. Delete anyway?')) return
        } else if (result.status === 'unmerged') {
          if (!window.confirm(`Branch "${task.workspace.branchName}" has not been merged into "${task.workspace.baseBranch}". Delete workspace?`)) return
          keepBranch = !window.confirm(`Also delete the unmerged branch "${task.workspace.branchName}"?`)
        } else if (result.status === 'uncommitted-and-unmerged') {
          if (!window.confirm(`This workspace has uncommitted changes and branch "${task.workspace.branchName}" has not been merged into "${task.workspace.baseBranch}". Delete anyway?`)) return
          keepBranch = !window.confirm(`Also delete the unmerged branch "${task.workspace.branchName}"?`)
        }
      } catch {
        // Pre-flight failed, proceed with deletion
      }

      // Step 1: Kill all tabs/PTYs first so no process holds the worktree cwd
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        window.api.scrollbackDelete(tab.id)
      }

      // Step 2: Now safe to remove worktree and branch
      try {
        await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch,
            force: true,
            keepBranch
          }
        )
      } catch {
        // Worktree may already be cleaned up
      }

      // Step 3: Remove task from state (skip both tab cleanup and workspace cleanup — already done)
      removeTask(projectId, taskId, true)
      return
    }

    removeTask(projectId, taskId)
  }

  const handleRenameSubmit = (type: 'project' | 'task', projectId: string, taskId?: string) => {
    if (!editValue.trim()) {
      setEditingId(null)
      return
    }
    if (type === 'project') {
      renameProject(projectId, editValue.trim())
    } else if (taskId) {
      renameTask(projectId, taskId, editValue.trim())
    }
    setEditingId(null)
  }

  const handleContextMenu = (
    e: React.MouseEvent, type: 'project' | 'task', projectId: string, taskId?: string
  ) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type, projectId, taskId })
  }

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, projectId: string, taskId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'task', projectId, taskId })
  }, [])

  const DRAG_THRESHOLD = 5

  const handleDragMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'project' | 'task',
    id: string,
    index: number,
    projectId?: string
  ) => {
    if (e.button !== 0 || editingId) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        const nextDragState: DragState = { type, id, index, projectId }
        dragStateRef.current = nextDragState
        setDragState(nextDragState)
      }

      const sidebarList = document.querySelector('.sidebar-list')
      if (!sidebarList) return

      if (type === 'task' && projectId) {
        const items = sidebarList.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-id="${projectId}"] .task-item`
        )
        const bestIndex = getTaskDropIndex(
          Array.from(items).map((item) => {
            const rect = item.getBoundingClientRect()
            return {
              id: item.dataset.taskId ?? '',
              index: Number(item.dataset.taskIndex ?? '-1'),
              top: rect.top,
              height: rect.height
            }
          }),
          ev.clientY,
          id
        )
        const nextDropTarget: DropTarget = { type: 'between-tasks', projectId, index: bestIndex }
        dropTargetRef.current = nextDropTarget
        setDropTarget(nextDropTarget)
        return
      }

      const projectItems = sidebarList.querySelectorAll<HTMLElement>('[data-drag-type="project"]')
      let newTarget: typeof dropTarget = null

      for (let i = 0; i < projectItems.length; i++) {
        const item = projectItems[i]
        const rect = item.getBoundingClientRect()
        if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue

        const itemId = item.dataset.dragId!
        const listIdx = visibleProjectIds.indexOf(itemId)
        if (listIdx < 0) break
        const midY = rect.top + rect.height / 2
        const insertIdx = ev.clientY > midY ? listIdx + 1 : listIdx
        newTarget = { type: 'between-projects', index: insertIdx }
        break
      }

      if (!newTarget) {
        newTarget = { type: 'between-projects', index: visibleProjectIds.length }
      }

      dropTargetRef.current = newTarget
      setDropTarget(newTarget)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (!dragging) return

      const currentDragState = dragStateRef.current
      const currentDropTarget = dropTargetRef.current

      if (currentDragState && currentDropTarget) {
        if (currentDragState.type === 'task' && currentDragState.projectId && currentDropTarget.type === 'between-tasks') {
          const toIndex = getReorderInsertIndex(currentDragState.index, currentDropTarget.index)
          if (toIndex !== null) {
            reorderTasks(currentDragState.projectId, currentDragState.index, toIndex)
          }
        } else if (currentDragState.type === 'project' && currentDropTarget.type === 'between-projects') {
          const fromIdx = projectOrder.indexOf(currentDragState.id)
          const orderDropIndex = currentDropTarget.index >= visibleProjectIds.length
            ? projectOrder.length
            : projectOrder.indexOf(visibleProjectIds[currentDropTarget.index] ?? '')
          if (orderDropIndex >= 0) {
            const toIdx = getReorderInsertIndex(fromIdx, orderDropIndex)
            if (toIdx !== null) {
              reorderProjects(fromIdx, toIdx)
            }
          }
        }
      }

      dragStateRef.current = null
      dropTargetRef.current = null
      setDragState(null)
      setDropTarget(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, projectOrder, visibleProjectIds, reorderTasks, reorderProjects])

  const renderProject = (project: Project) => {
    const isExpanded = expandedProjects.has(project.id)
    // Project home lives on the project row itself (it's filtered out of the
    // visible task list), so the row needs the selection rail whenever the
    // home task is active — even when the project is expanded.
    const isHomeSelected = selectedProjectId === project.id
      && project.tasks.some(t => t.id === selectedTaskId && isHomeTask(t))
    const isProjectSelected = selectedProjectId === project.id && (!isExpanded || isHomeSelected)
    const isProjectDragging = dragState?.type === 'project' && dragState.id === project.id
    const visibleTasks = project.tasks.filter(t => !isHomeTask(t))
    return (
    <div className="sidebar-project" key={project.id} data-project-id={project.id}>
      <div
        className={[
          'flex items-center gap-2 px-3 py-1.5 text-[13px] text-text cursor-pointer hover:bg-surface-2',
          // selection rail recipe
          'data-[selected=true]:relative',
          'data-[selected=true]:before:absolute data-[selected=true]:before:inset-y-0 data-[selected=true]:before:left-0',
          'data-[selected=true]:before:w-0.5 data-[selected=true]:before:bg-accent-400',
          'data-[selected=true]:bg-gradient-to-r data-[selected=true]:from-accent-600/30 data-[selected=true]:to-transparent',
          'data-[selected=true]:text-accent-50',
          '[.theme-light_&[data-selected=true]]:from-accent-200',
          '[.theme-light_&[data-selected=true]]:text-accent-700',
          isProjectDragging ? 'opacity-40' : '',
        ].join(' ')}
        data-selected={isProjectSelected ? 'true' : undefined}
        data-drag-type="project"
        data-drag-id={project.id}
        onClick={() => { selectProjectHome(project.id) }}
        onContextMenu={(e) => handleContextMenu(e, 'project', project.id)}
        onMouseDown={(e) => {
          const index = projectOrder.indexOf(project.id)
          handleDragMouseDown(e, 'project', project.id, index)
        }}
      >
        {editingId === project.id ? (
          <input
            ref={editRef}
            className="bg-surface-2 border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => handleRenameSubmit('project', project.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit('project', project.id)
              if (e.key === 'Escape') setEditingId(null)
            }}
          />
        ) : (
          <>
            <button
              className="text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer p-0 flex items-center shrink-0"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggleProjectExpansion(project.id) }}
            >{isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
            <ProjectIconSlot project={project} theme={effectiveTheme} metadata={iconMetadata} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap font-semibold">{project.name}</span>
            {isRemoteProject(project) && (
              <span className="text-[9px] px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">
                <Plug size={10} className="inline mr-0.5" />ssh
              </span>
            )}
            {isShellCommandProject(project) && (
              <span className="text-[9px] px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">
                <TerminalIcon size={10} className="inline mr-0.5" />shell
              </span>
            )}
            {isRemoteProject(project) && (() => {
              const sshStatus = sshStatuses[project.id] || 'disconnected'
              const dotClass = sshStatus === 'connected'
                ? 'bg-ssh-connected'
                : sshStatus === 'connecting'
                ? 'bg-ssh-connecting animate-pulse'
                : 'bg-ssh-disconnected'
              return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${dotClass}`} />
            })()}
            {!isExpanded && (() => {
              const projectStatus = getProjectStatus(project.tasks.filter(t => !isHomeTask(t)), allStatuses)
              if (!projectStatus) return null
              const dotClass = projectStatus === 'working'
                ? 'bg-status-working animate-pulse'
                : projectStatus === 'attention'
                ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
                : 'bg-status-exited'
              return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${dotClass}`} />
            })()}
          </>
        )}
      </div>

      {isExpanded && (
        <div className="pb-1">
          {visibleTasks.map((task) => {
            const projectTaskIndex = project.tasks.indexOf(task)
            const isSelected = selectedTaskId === task.id
            const opacity = !isSelected && config?.taskRecencyHighlight
              ? computeTaskRecencyOpacity(task, sortedByRecency, config.taskRecencyHighlight, now)
              : 0
            const recencyStyle = buildRecencyStyle(opacity, effectiveTheme)
            const isTaskDragging = dragState?.type === 'task' && dragState.index === projectTaskIndex
            return (
              <React.Fragment key={task.id}>
                {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === projectTaskIndex && (
                  <div className={`h-0.5 bg-accent-400 mr-2 rounded-sm ${TASK_ROW_ML}`} />
                )}
                <div
                  className={[
                    'flex items-center gap-2 px-3 py-1.5 text-text cursor-pointer hover:bg-surface-2',
                    TASK_ROW_PL,
                    'text-[12px]',
                    'task-item',
                    // selection rail recipe
                    'data-[selected=true]:relative',
                    'data-[selected=true]:before:absolute data-[selected=true]:before:inset-y-0 data-[selected=true]:before:left-0',
                    'data-[selected=true]:before:w-0.5 data-[selected=true]:before:bg-accent-400',
                    'data-[selected=true]:bg-gradient-to-r data-[selected=true]:from-accent-600/30 data-[selected=true]:to-transparent',
                    'data-[selected=true]:text-accent-50',
                    '[.theme-light_&[data-selected=true]]:from-accent-200',
                    '[.theme-light_&[data-selected=true]]:text-accent-700',
                    isTaskDragging ? 'opacity-40' : '',
                  ].join(' ')}
                  data-selected={isSelected ? 'true' : undefined}
                  data-task-id={task.id}
                  data-task-index={projectTaskIndex}
                  style={recencyStyle}
                  onClick={() => handleSelectTask(project.id, task)}
                  onMouseDown={(e) => handleDragMouseDown(e, 'task', task.id, projectTaskIndex, project.id)}
                  onContextMenu={(e) => handleContextMenu(e, 'task', project.id, task.id)}
                >
                  {editingId === task.id ? (
                    <input
                      ref={editRef}
                      className="bg-surface-2 border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleRenameSubmit('task', project.id, task.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit('task', project.id, task.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <>
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{task.name}</span>
                      {isWorkspaceTask(task) && <span className="text-[9px] px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>}
                      <TaskStatusDot task={task} allStatuses={allStatuses} />
                    </>
                  )}
                </div>
              </React.Fragment>
            )
          })}
          {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === project.tasks.length && (
            <div className={`h-0.5 bg-accent-400 mr-2 rounded-sm ${TASK_ROW_ML}`} />
          )}
          <div className={`flex items-center gap-0.5 flex-wrap ${TASK_ROW_PL} pr-2 py-0.5`}>
            <button
              className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] text-[11px] whitespace-nowrap shrink-0"
              onClick={() => handleAddTask(project.id)}
            >
              <Plus size={12} className="inline mr-0.5" /> Task
            </button>
            {!isShellCommandProject(project) && (
              <button
                className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] text-[11px] whitespace-nowrap shrink-0"
                onClick={() => handleAddWorkspace(project.id)}
              >
                <Plus size={12} className="inline mr-0.5" /> Workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
    )
  }

  return (
    <div className="sidebar flex flex-col w-60 min-w-[200px] bg-surface border-r border-border select-none [--recency-rgb:100,150,230] [.theme-light_&]:[--recency-rgb:230,160,80]">
      <ProjectSwitcher
        projects={projects}
        selectProjectHome={selectProjectHome}
        switchToTask={switchToTask}
        isActive={switcherActive}
        onDeactivate={() => setSwitcherActive(false)}
      />

      {switcherActive ? null : (<>
      <div className="flex items-center justify-between px-3 pt-9 pb-2 [-webkit-app-region:drag]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-subtle">Projects</span>
        <div className="relative [-webkit-app-region:no-drag]">
          <button
            className="bg-transparent border-0 text-text-subtle cursor-pointer px-2 py-1 rounded text-[13px] hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag]"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setAddMenuOpen(!addMenuOpen) }}
            title="Add project"
          ><Plus size={14} /></button>
          {addMenuOpen && (
            <div className="absolute top-full right-0 bg-surface-2 border border-border rounded-md py-1 shadow-lg z-[1000] whitespace-nowrap" onMouseDown={(e) => e.stopPropagation()}>
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => { setAddMenuOpen(false); handleAddProject() }}>Local project</button>
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => { setAddMenuOpen(false); setRemoteModalOpen(true) }}>Remote project (SSH)</button>
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => { setAddMenuOpen(false); setShellCommandModalOpen(true) }}>Custom shell</button>
            </div>
          )}
        </div>
      </div>

      <div className="px-3 pb-2 [-webkit-app-region:no-drag]">
        <button
          type="button"
          onClick={() => setSwitcherActive(true)}
          className="flex items-center gap-2 w-full h-7 px-2.5 rounded-md bg-surface-2 border border-border text-text-subtle text-[11.5px] hover:text-text-muted"
        >
          <Search size={12} />
          <span>Quick switch…</span>
          <span className="ml-auto text-[10px] opacity-70">⌘P</span>
        </button>
      </div>

      {sortedTags.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5 [-webkit-app-region:no-drag]">
          {sortedTags.map(tag => {
            const isSelected = selectedTagIds.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTagFilter(tag.id)}
                className={[
                  'px-2 py-0.5 rounded-full text-[11px] border cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-accent-500/25 border-accent-400 text-accent-50'
                    : 'bg-surface-2 border-border text-text-muted hover:text-text hover:bg-surface-3',
                ].join(' ')}
              >
                {tag.name}
              </button>
            )
          })}
        </div>
      )}

      <div className="sidebar-list flex-1 overflow-y-auto py-1">
        {visibleProjectIds.map((projectId, listIdx) => {
          const project = projectsById.get(projectId)
          if (!project) return null
          return (
            <React.Fragment key={project.id}>
              {dropTarget?.type === 'between-projects' && dropTarget.index === listIdx && (
                <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
              )}
              {renderProject(project)}
            </React.Fragment>
          )
        })}
        {dropTarget?.type === 'between-projects' && dropTarget.index === visibleProjectIds.length && (
          <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
        )}
      </div>

      {config?.activityPanel?.enabled && (
        <ActivityPanel
          projects={projects}
          selectedTaskId={selectedTaskId}
          switchToTask={switchToTask}
          onTaskContextMenu={handleTaskContextMenu}
          recencySettings={config.taskRecencyHighlight}
          now={now}
          heightPx={config.activityPanel.heightPx}
          onHeightChange={(next) => updateConfig({
            activityPanel: { ...config.activityPanel, heightPx: next }
          })}
          allStatuses={allStatuses}
          theme={effectiveTheme}
        />
      )}
      </>)}

      {contextMenu && (
        <div className="fixed bg-surface-2 border border-border rounded-md py-1 shadow-lg z-[1000]" style={{ top: contextMenu.y, left: contextMenu.x }} onMouseDown={(e) => e.stopPropagation()}>
          <>
            <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                const id = contextMenu.type === 'project' ? contextMenu.projectId : contextMenu.taskId!
                setEditingId(id)
                const item = contextMenu.type === 'project'
                  ? projects.find((p) => p.id === id)
                  : projects.find((p) => p.id === contextMenu.projectId)?.tasks.find((t) => t.id === id)
                setEditValue(item?.name ?? '')
                setContextMenu(null)
              }}>Rename</button>
              {contextMenu.type === 'project' && (
                <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                  setDuplicateProjectId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Duplicate</button>
              )}
              {contextMenu.type === 'project' && (
                <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                  setProjectSettingsId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Settings</button>
              )}
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isRemoteProject(project)) return null
                return (
                  <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                    window.api.sshConnect(project.id, project.ssh!).catch(() => {})
                    setContextMenu(null)
                  }}>Reconnect SSH</button>
                )
              })()}
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                if (contextMenu.type === 'project') removeProject(contextMenu.projectId)
                else handleDeleteTask(contextMenu.projectId, contextMenu.taskId!)
                setContextMenu(null)
              }}>Delete</button>
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project) return null
                const details: { label: string; value: string }[] = []
                if (isShellCommandProject(project)) {
                  details.push({ label: 'Command', value: project.shellCommand!.command })
                } else if (isRemoteProject(project)) {
                  details.push({ label: 'Connection', value: `${project.ssh!.username}@${project.ssh!.host}:${project.ssh!.port}` })
                  details.push({ label: 'Dir', value: project.ssh!.remoteDir })
                } else {
                  details.push({ label: 'Dir', value: project.directory })
                }
                return (
                  <div className="border-t border-border mt-1 px-4 pt-1.5 pb-1">
                    {details.map(d => (
                      <div key={d.label} className="text-text-subtle text-[11px] leading-snug overflow-hidden text-ellipsis whitespace-nowrap max-w-[260px] select-text cursor-text" title={d.value}>
                        <span className="opacity-70">{d.label}:</span> {d.value}
                      </div>
                    ))}
                  </div>
                )
              })()}
          </>
        </div>
      )}

      <div className="px-3 py-2 border-t border-border">
        <button className="bg-transparent border-0 text-text-subtle cursor-pointer px-2 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] text-base" onClick={() => setSettingsOpen(true)} title="Settings"><SettingsIcon size={16} /></button>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {remoteModalOpen && (
        <AddRemoteProject
          allTags={tags}
          onEnsureTag={addTag}
          onAdd={(name, ssh, aiToolArgs, tagIds) => {
            addRemoteProject(name, ssh, aiToolArgs, tagIds)
            setRemoteModalOpen(false)
          }}
          onCancel={() => setRemoteModalOpen(false)}
        />
      )}

      {shellCommandModalOpen && (
        <AddShellCommandProject
          allTags={tags}
          onEnsureTag={addTag}
          onAdd={(name, command, tagIds) => {
            addShellCommandProject(name, command, tagIds)
            setShellCommandModalOpen(false)
          }}
          onCancel={() => setShellCommandModalOpen(false)}
        />
      )}

      {projectSettingsId && (() => {
        const project = projects.find(p => p.id === projectSettingsId)
        if (!project) return null
        return (
          <ProjectSettings
            project={project}
            onSave={(payload) => updateProject(projectSettingsId, payload)}
            onClose={() => setProjectSettingsId(null)}
          />
        )
      })()}

      {duplicateProjectId && (() => {
        const project = projects.find(p => p.id === duplicateProjectId)
        if (!project) return null
        if (isRemoteProject(project)) {
          return (
            <AddRemoteProject
              allTags={tags}
              onEnsureTag={addTag}
              initialValues={{
                host: project.ssh!.host,
                port: project.ssh!.port,
                username: project.ssh!.username,
                keyFile: project.ssh!.keyFile,
                remoteDir: project.ssh!.remoteDir,
                aiToolArgs: project.aiToolArgs
              }}
              onAdd={(name, ssh, aiToolArgs, tagIds) => {
                addRemoteProject(name, ssh, aiToolArgs, tagIds)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        if (isShellCommandProject(project)) {
          return (
            <AddShellCommandProject
              allTags={tags}
              onEnsureTag={addTag}
              initialValues={{
                name: project.name,
                command: project.shellCommand!.command
              }}
              onAdd={(name, command, tagIds) => {
                addShellCommandProject(name, command, tagIds)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        return (
          <AddLocalProject
            allTags={tags}
            onEnsureTag={addTag}
            initialValues={{
              name: project.name,
              directory: project.directory
            }}
            onAdd={(name, directory, tagIds) => {
              addProject(name, directory, tagIds)
              setDuplicateProjectId(null)
            }}
            onCancel={() => setDuplicateProjectId(null)}
          />
        )
      })()}

      {workspaceModalProjectId && (() => {
        const project = projects.find(p => p.id === workspaceModalProjectId)
        if (!project) return null
        return (
          <CreateWorkspaceModal
            projectDir={getProjectDir(project)}
            projectId={isRemoteProject(project) ? project.id : undefined}
            sshConfig={project.ssh}
            onAdd={(name, workspace) => {
              addWorkspaceTask(workspaceModalProjectId, name, workspace)
              setWorkspaceModalProjectId(null)
            }}
            onCancel={() => setWorkspaceModalProjectId(null)}
          />
        )
      })()}
    </div>
  )
}
