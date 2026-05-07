import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useTabStatusStore, type TabStatusValue } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isRemoteProject, isShellCommandProject, isWorkspaceTask } from '../../shared/types'
import type { Tab, Task, Project, Folder } from '../../shared/types'
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
  type: 'project' | 'task' | 'folder'
  id: string
  sourceFolderId: string | null
  index: number
  projectId?: string
}

type DropTarget =
  | { type: 'into-folder'; folderId: string }
  | { type: 'between-root'; index: number }
  | { type: 'between-folder-children'; folderId: string; index: number }
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

function getFolderStatus(folder: { projectIds: string[] }, projects: { id: string; tasks: Task[] }[], allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const folderProjects = folder.projectIds
    .map(pid => projects.find(p => p.id === pid))
    .filter(Boolean) as { tasks: Task[] }[]
  const statuses = folderProjects.map(p => getProjectStatus(p.tasks, allStatuses)).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
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
    projects, folders, rootOrder,
    selectedProjectId, selectedTaskId,
    setSelectedProjectId, setSelectedTaskId, switchToTask,
    addProject, addRemoteProject, addShellCommandProject, removeProject, renameProject, updateProject,
    addTask, addWorkspaceTask, removeTask, renameTask,
    addFolder, removeFolder, renameFolder,
    moveProjectToFolder, moveProjectToRoot,
    reorderRootItems, reorderProjectsInFolder,
    reorderTasks, getProjectDir,
    config, updateConfig,
    collapsedFolderIds, toggleFolderCollapse, setFolderCollapsed,
    expandedProjectIds, toggleProjectExpansion,
    effectiveTheme
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const tabStatusStore = useTabStatusStore()

  const [now, setNow] = useState(() => Date.now())
  const sortedByRecency = React.useMemo(
    () => sortTasksByRecency(projects.flatMap(p => p.tasks)),
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
    x: number; y: number; type: 'project' | 'task' | 'folder'; projectId: string; taskId?: string
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
  const collapsedFolders = new Set(collapsedFolderIds)
  const expandedProjects = new Set(expandedProjectIds)

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

  useEffect(() => {
    if (!selectedProjectId) return
    const folder = folders.find(f => f.projectIds.includes(selectedProjectId))
    if (folder) {
      setFolderCollapsed(folder.id, false)
    }
  }, [selectedProjectId, folders, setFolderCollapsed])

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

  const handleRenameSubmit = (type: 'project' | 'task' | 'folder', projectId: string, taskId?: string) => {
    if (!editValue.trim()) {
      setEditingId(null)
      return
    }
    if (type === 'folder') {
      renameFolder(projectId, editValue.trim())
    } else if (type === 'project') {
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
    type: 'project' | 'task' | 'folder',
    id: string,
    index: number,
    sourceFolderId: string | null = null,
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
        const nextDragState: DragState = { type, id, sourceFolderId, index, projectId }
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

      // Project or folder dragging
      const allItems = sidebarList.querySelectorAll<HTMLElement>('[data-drag-type]')
      let newTarget: typeof dropTarget = null

      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i]
        const rect = item.getBoundingClientRect()
        if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue

        const itemType = item.dataset.dragType
        const itemId = item.dataset.dragId!
        const itemFolderId = item.dataset.folderId || null

        if (itemType === 'folder-heading') {
          const quarter = rect.height * 0.25
          if (ev.clientY < rect.top + quarter) {
            const rootIdx = rootOrder.indexOf(itemId)
            newTarget = { type: 'between-root', index: rootIdx }
          } else if (ev.clientY > rect.bottom - quarter) {
            const rootIdx = rootOrder.indexOf(itemId)
            newTarget = { type: 'between-root', index: rootIdx + 1 }
          } else {
            if (type === 'project') {
              newTarget = { type: 'into-folder', folderId: itemId }
            }
          }
        } else if (itemType === 'project') {
          const midY = rect.top + rect.height / 2
          if (itemFolderId) {
            const folder = folders.find(f => f.id === itemFolderId)
            if (folder) {
              const idxInFolder = folder.projectIds.indexOf(itemId)
              const insertIdx = ev.clientY > midY ? idxInFolder + 1 : idxInFolder
              newTarget = { type: 'between-folder-children', folderId: itemFolderId, index: insertIdx }
            }
          } else {
            const rootIdx = rootOrder.indexOf(itemId)
            const insertIdx = ev.clientY > midY ? rootIdx + 1 : rootIdx
            newTarget = { type: 'between-root', index: insertIdx }
          }
        }
        break
      }

      if (!newTarget) {
        newTarget = { type: 'between-root', index: rootOrder.length }
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
        } else if (currentDragState.type === 'project') {
          if (currentDropTarget.type === 'into-folder') {
            if (currentDragState.sourceFolderId !== currentDropTarget.folderId) {
              moveProjectToFolder(currentDragState.id, currentDropTarget.folderId)
            }
          } else if (currentDropTarget.type === 'between-root') {
            if (currentDragState.sourceFolderId) {
              moveProjectToRoot(currentDragState.id, currentDropTarget.index)
            } else {
              const fromIdx = rootOrder.indexOf(currentDragState.id)
              const toIdx = getReorderInsertIndex(fromIdx, currentDropTarget.index)
              if (toIdx !== null) {
                reorderRootItems(fromIdx, toIdx)
              }
            }
          } else if (currentDropTarget.type === 'between-folder-children') {
            if (currentDragState.sourceFolderId === currentDropTarget.folderId) {
              const folder = folders.find(f => f.id === currentDropTarget.folderId)
              if (folder) {
                const fromIdx = folder.projectIds.indexOf(currentDragState.id)
                const toIdx = getReorderInsertIndex(fromIdx, currentDropTarget.index)
                if (toIdx !== null) {
                  reorderProjectsInFolder(currentDropTarget.folderId, fromIdx, toIdx)
                }
              }
            } else {
              moveProjectToFolder(currentDragState.id, currentDropTarget.folderId)
            }
          }
        } else if (currentDragState.type === 'folder' && currentDropTarget.type === 'between-root') {
          const fromIdx = rootOrder.indexOf(currentDragState.id)
          const toIdx = getReorderInsertIndex(fromIdx, currentDropTarget.index)
          if (toIdx !== null) {
            reorderRootItems(fromIdx, toIdx)
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
  }, [editingId, rootOrder, folders, reorderTasks, moveProjectToFolder, moveProjectToRoot, reorderRootItems, reorderProjectsInFolder])

  const renderProject = (project: Project, folderId: string | null) => {
    const isExpanded = expandedProjects.has(project.id)
    const isProjectSelected = selectedProjectId === project.id && !isExpanded
    const isProjectDragging = dragState?.type === 'project' && dragState.id === project.id
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
        data-folder-id={folderId || ''}
        onClick={() => { setSelectedProjectId(project.id); setSelectedTaskId(null) }}
        onContextMenu={(e) => handleContextMenu(e, 'project', project.id)}
        onMouseDown={(e) => {
          const folder = folderId ? folders.find(f => f.id === folderId) : null
          const index = folder
            ? folder.projectIds.indexOf(project.id)
            : rootOrder.indexOf(project.id)
          handleDragMouseDown(e, 'project', project.id, index, folderId)
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
            {(() => {
              const iconUrl = project.icon
                ? dashboardIconUrl(project.icon, { theme: effectiveTheme, metadata: iconMetadata ?? undefined })
                : null
              if (iconUrl) {
                return (
                  <img
                    src={iconUrl}
                    alt=""
                    className="w-3.5 h-3.5 object-contain mr-1.5 shrink-0"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                )
              }
              if (project.emoji) {
                return <span className="text-[13px] leading-none mr-1.5">{project.emoji}</span>
              }
              return null
            })()}
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
              const projectStatus = getProjectStatus(project.tasks, allStatuses)
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
          {project.tasks.map((task, tIdx) => {
            const isSelected = selectedTaskId === task.id
            const opacity = !isSelected && config?.taskRecencyHighlight
              ? computeTaskRecencyOpacity(task, sortedByRecency, config.taskRecencyHighlight, now)
              : 0
            const recencyStyle = buildRecencyStyle(opacity, effectiveTheme)
            const isTaskDragging = dragState?.type === 'task' && dragState.index === tIdx
            return (
              <React.Fragment key={task.id}>
                {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === tIdx && (
                  <div className="h-0.5 bg-accent-400 mr-2 rounded-sm ml-6" />
                )}
                <div
                  className={[
                    'flex items-center gap-2 px-3 py-1.5 text-text cursor-pointer hover:bg-surface-2',
                    'pl-[34px] text-[12px]',
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
                  data-task-index={tIdx}
                  style={recencyStyle}
                  onClick={() => handleSelectTask(project.id, task)}
                  onMouseDown={(e) => handleDragMouseDown(e, 'task', task.id, tIdx, null, project.id)}
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
            <div className="h-0.5 bg-accent-400 mr-2 rounded-sm ml-6" />
          )}
          <button
            className="bg-transparent border-0 text-text-subtle cursor-pointer px-2 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] ml-[34px] text-[11px]"
            onClick={() => handleAddTask(project.id)}
          >
            <Plus size={14} className="inline mr-0.5" /> Task
          </button>
          {!isShellCommandProject(project) && (
            <button
              className="bg-transparent border-0 text-text-subtle cursor-pointer px-2 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] ml-[34px] text-[11px]"
              onClick={() => handleAddWorkspace(project.id)}
            >
              <Plus size={14} className="inline mr-0.5" /> Workspace
            </button>
          )}
        </div>
      )}
    </div>
    )
  }

  return (
    <div className="sidebar flex flex-col w-60 min-w-[200px] bg-surface border-r border-border select-none [--recency-rgb:100,150,230] [.theme-light_&]:[--recency-rgb:230,160,80]">
      <ProjectSwitcher
        projects={projects}
        setSelectedProjectId={setSelectedProjectId}
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
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                setAddMenuOpen(false)
                const folderId = addFolder()
                setEditingId(folderId)
                setEditValue('New Folder')
              }}>New Folder</button>
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

      <div className="sidebar-list flex-1 overflow-y-auto py-1">
        {rootOrder.map((itemId, rootIdx) => {
          const folder = folders.find(f => f.id === itemId)
          if (folder) {
            const isCollapsed = collapsedFolders.has(folder.id)
            const folderStatus = getFolderStatus(folder, projects, allStatuses)
            const isFolderDropTarget = dropTarget?.type === 'into-folder' && dropTarget.folderId === folder.id
            const isFolderDragging = dragState?.type === 'folder' && dragState.id === folder.id
            return (
              <React.Fragment key={folder.id}>
                {dropTarget?.type === 'between-root' && dropTarget.index === rootIdx && (
                  <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
                )}
                <div
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-[10px] font-semibold uppercase tracking-[0.15em] text-text-subtle mt-2 first:mt-0 hover:bg-surface-2',
                    isFolderDropTarget
                      ? 'bg-accent-600/20 outline outline-1 outline-dashed outline-border-focus -outline-offset-1'
                      : '',
                    isFolderDragging ? 'opacity-40' : '',
                  ].join(' ')}
                  data-drag-type="folder-heading"
                  data-drag-id={folder.id}
                  onClick={() => toggleFolderCollapse(folder.id)}
                  onMouseDown={(e) => handleDragMouseDown(e, 'folder', folder.id, rootOrder.indexOf(folder.id))}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setContextMenu({ x: e.clientX, y: e.clientY, type: 'folder', projectId: folder.id })
                  }}
                >
                  {editingId === folder.id ? (
                    <input
                      ref={editRef}
                      className="bg-surface-2 border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleRenameSubmit('folder', folder.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit('folder', folder.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <>
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">{folder.name}</span>
                      {isCollapsed && folderStatus && (() => {
                        const dotClass = folderStatus === 'working'
                          ? 'bg-status-working animate-pulse'
                          : folderStatus === 'attention'
                          ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
                          : 'bg-status-exited'
                        return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${dotClass}`} />
                      })()}
                    </>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="border-l border-border ml-4">
                    {folder.projectIds.map((pid, childIdx) => {
                      const project = projects.find(p => p.id === pid)
                      if (!project) return null
                      return (
                        <React.Fragment key={pid}>
                          {dropTarget?.type === 'between-folder-children' && dropTarget.folderId === folder.id && dropTarget.index === childIdx && (
                            <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
                          )}
                          {renderProject(project, folder.id)}
                        </React.Fragment>
                      )
                    })}
                    {dropTarget?.type === 'between-folder-children' && dropTarget.folderId === folder.id && dropTarget.index === folder.projectIds.length && (
                      <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
                    )}
                  </div>
                )}
              </React.Fragment>
            )
          }

          const project = projects.find(p => p.id === itemId)
          if (!project) return null
          return (
            <React.Fragment key={project.id}>
              {dropTarget?.type === 'between-root' && dropTarget.index === rootIdx && (
                <div className="h-0.5 bg-accent-400 mx-2 rounded-sm" />
              )}
              {renderProject(project, null)}
            </React.Fragment>
          )
        })}
        {dropTarget?.type === 'between-root' && dropTarget.index === rootOrder.length && (
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
          {contextMenu.type === 'folder' ? (
            <>
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                setEditingId(contextMenu.projectId)
                const folder = folders.find(f => f.id === contextMenu.projectId)
                setEditValue(folder?.name ?? '')
                setContextMenu(null)
              }}>Rename</button>
              <button className="block w-full px-4 py-1.5 bg-transparent border-0 text-text text-[13px] text-left cursor-pointer hover:bg-surface-3" onClick={() => {
                removeFolder(contextMenu.projectId)
                setContextMenu(null)
              }}>Delete</button>
            </>
          ) : (
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
          )}
        </div>
      )}

      <div className="px-3 py-2 border-t border-border">
        <button className="bg-transparent border-0 text-text-subtle cursor-pointer px-2 py-1 rounded hover:bg-surface-2 hover:text-text [-webkit-app-region:no-drag] text-base" onClick={() => setSettingsOpen(true)} title="Settings"><SettingsIcon size={16} /></button>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {remoteModalOpen && (
        <AddRemoteProject
          onAdd={(name, ssh, aiToolArgs) => {
            addRemoteProject(name, ssh, aiToolArgs)
            setRemoteModalOpen(false)
          }}
          onCancel={() => setRemoteModalOpen(false)}
        />
      )}

      {shellCommandModalOpen && (
        <AddShellCommandProject
          onAdd={(name, command) => {
            addShellCommandProject(name, command)
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
              initialValues={{
                host: project.ssh!.host,
                port: project.ssh!.port,
                username: project.ssh!.username,
                keyFile: project.ssh!.keyFile,
                remoteDir: project.ssh!.remoteDir,
                aiToolArgs: project.aiToolArgs
              }}
              onAdd={(name, ssh, aiToolArgs) => {
                addRemoteProject(name, ssh, aiToolArgs)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        if (isShellCommandProject(project)) {
          return (
            <AddShellCommandProject
              initialValues={{
                name: project.name,
                command: project.shellCommand!.command
              }}
              onAdd={(name, command) => {
                addShellCommandProject(name, command)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        return (
          <AddLocalProject
            initialValues={{
              name: project.name,
              directory: project.directory
            }}
            onAdd={(name, directory) => {
              addProject(name, directory)
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
