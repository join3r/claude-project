import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useTabStatusStore, type TabStatusValue } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isRemoteProject, isShellCommandProject, isWorkspaceTask } from '../../shared/types'
import type { Tab, Task, Project, Folder, WorkspaceConfig } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import CreateWorkspaceModal from './CreateWorkspaceModal'
import AddShellCommandProject from './AddShellCommandProject'
import ProjectSettings from './ProjectSettings'
import Settings from './Settings'
import ProjectSwitcher from './ProjectSwitcher'
import { getReorderInsertIndex, getTaskDropIndex } from './sidebarDrag'
import './Sidebar.css'

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
  return <span className={`sidebar-status sidebar-status-${status}`} />
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
    collapsedFolderIds, toggleFolderCollapse, setFolderCollapsed
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const tabStatusStore = useTabStatusStore()

  const handleSelectTask = useCallback((task: Task) => {
    setSelectedTaskId(task.id)
    const aiTabs = [...task.tabs.left, ...task.tabs.right]
      .filter((t) => (AI_TAB_TYPES as readonly string[]).includes(t.type))
    for (const tab of aiTabs) {
      if (tabStatusStore.getStatus(tab.id) === 'attention') {
        tabStatusStore.setStatus(tab.id, null)
      }
    }
  }, [setSelectedTaskId, tabStatusStore])

  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'project' | 'task' | 'folder'; projectId: string; taskId?: string
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const [shellCommandModalOpen, setShellCommandModalOpen] = useState(false)
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const dropTargetRef = useRef<DropTarget>(null)
  const [workspaceModalProjectId, setWorkspaceModalProjectId] = useState<string | null>(null)
  const [switcherActive, setSwitcherActive] = useState(false)
  const collapsedFolders = new Set(collapsedFolderIds)

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
    dropTargetRef.current = dropTarget
  }, [dropTarget])

  useEffect(() => {
    const dismiss = () => { setContextMenu(null); setAddMenuOpen(false) }
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [])

  useEffect(() => {
    return window.api.onMenuProjectSwitcher(() => {
      setSwitcherActive(prev => !prev)
    })
  }, [])

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
          project.directory, task.workspace.worktreePath,
          task.workspace.branchName, task.workspace.baseBranch
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
          project.directory, task.workspace.worktreePath,
          task.workspace.branchName, task.workspace.baseBranch, true, keepBranch
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

  const renderProject = (project: Project, folderId: string | null) => (
    <div className="sidebar-project" key={project.id} data-project-id={project.id}>
      <div
        className={`sidebar-item project-item ${selectedProjectId === project.id ? 'selected' : ''} ${dragState?.type === 'project' && dragState.id === project.id ? 'dragging' : ''}`}
        data-drag-type="project"
        data-drag-id={project.id}
        data-folder-id={folderId || ''}
        onClick={() => setSelectedProjectId(project.id)}
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
            className="sidebar-edit"
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
            <span className="sidebar-label">{project.name}</span>
            {isRemoteProject(project) && <span className="sidebar-ssh-badge">ssh</span>}
            {isShellCommandProject(project) && <span className="sidebar-ssh-badge">shell</span>}
            {isRemoteProject(project) && (
              <span className={`sidebar-ssh-dot sidebar-ssh-dot-${sshStatuses[project.id] || 'disconnected'}`} />
            )}
            {selectedProjectId !== project.id && (() => {
              const projectStatus = getProjectStatus(project.tasks, allStatuses)
              return projectStatus ? <span className={`sidebar-status sidebar-status-${projectStatus}`} /> : null
            })()}
          </>
        )}
      </div>

      {selectedProjectId === project.id && (
        <div className="sidebar-tasks">
          {project.tasks.map((task, tIdx) => (
            <React.Fragment key={task.id}>
              {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === tIdx && (
                <div className="sidebar-drop-indicator task-drop-indicator" />
              )}
              <div
                className={`sidebar-item task-item ${selectedTaskId === task.id ? 'selected' : ''} ${dragState?.type === 'task' && dragState.index === tIdx ? 'dragging' : ''}`}
                data-task-id={task.id}
                data-task-index={tIdx}
                onClick={() => handleSelectTask(task)}
                onMouseDown={(e) => handleDragMouseDown(e, 'task', task.id, tIdx, null, project.id)}
                onContextMenu={(e) => handleContextMenu(e, 'task', project.id, task.id)}
              >
                {editingId === task.id ? (
                  <input
                    ref={editRef}
                    className="sidebar-edit"
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
                    <span className="sidebar-label">{task.name}</span>
                    {isWorkspaceTask(task) && <span className="sidebar-ssh-badge">ws</span>}
                    <TaskStatusDot task={task} allStatuses={allStatuses} />
                  </>
                )}
              </div>
            </React.Fragment>
          ))}
          {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === project.tasks.length && (
            <div className="sidebar-drop-indicator task-drop-indicator" />
          )}
          <button
            className="sidebar-btn add-task-btn"
            onClick={() => handleAddTask(project.id)}
          >
            + Task
          </button>
          {!isShellCommandProject(project) && !isRemoteProject(project) && (
            <button
              className="sidebar-btn add-task-btn"
              onClick={() => handleAddWorkspace(project.id)}
            >
              + Workspace
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="sidebar">
      <ProjectSwitcher
        projects={projects}
        selectedProjectId={selectedProjectId}
        setSelectedProjectId={setSelectedProjectId}
        switchToTask={switchToTask}
        isActive={switcherActive}
        onActivate={() => setSwitcherActive(true)}
        onDeactivate={() => setSwitcherActive(false)}
      />

      {switcherActive ? null : (<>
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <div className="sidebar-add-wrapper">
          <button className="sidebar-btn" onClick={(e) => { e.stopPropagation(); setAddMenuOpen(!addMenuOpen) }} title="Add project">+</button>
          {addMenuOpen && (
            <div className="sidebar-add-menu">
              <button onClick={() => { setAddMenuOpen(false); handleAddProject() }}>Local project</button>
              <button onClick={() => { setAddMenuOpen(false); setRemoteModalOpen(true) }}>Remote project (SSH)</button>
              <button onClick={() => { setAddMenuOpen(false); setShellCommandModalOpen(true) }}>Custom shell</button>
              <button onClick={() => {
                setAddMenuOpen(false)
                const folderId = addFolder()
                setEditingId(folderId)
                setEditValue('New Folder')
              }}>New Folder</button>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-list">
        {rootOrder.map((itemId, rootIdx) => {
          const folder = folders.find(f => f.id === itemId)
          if (folder) {
            const isCollapsed = collapsedFolders.has(folder.id)
            const folderStatus = getFolderStatus(folder, projects, allStatuses)
            return (
              <React.Fragment key={folder.id}>
                {dropTarget?.type === 'between-root' && dropTarget.index === rootIdx && (
                  <div className="sidebar-drop-indicator" />
                )}
                <div
                  className={`sidebar-folder-heading ${
                    dropTarget?.type === 'into-folder' && dropTarget.folderId === folder.id ? 'drop-target' : ''
                  } ${dragState?.type === 'folder' && dragState.id === folder.id ? 'dragging' : ''}`}
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
                      className="sidebar-edit"
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
                      <span className="sidebar-folder-chevron">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                      <span className="sidebar-folder-label">{folder.name}</span>
                      {isCollapsed && folderStatus && <span className={`sidebar-status sidebar-status-${folderStatus}`} />}
                    </>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="sidebar-folder-children">
                    {folder.projectIds.map((pid, childIdx) => {
                      const project = projects.find(p => p.id === pid)
                      if (!project) return null
                      return (
                        <React.Fragment key={pid}>
                          {dropTarget?.type === 'between-folder-children' && dropTarget.folderId === folder.id && dropTarget.index === childIdx && (
                            <div className="sidebar-drop-indicator" />
                          )}
                          {renderProject(project, folder.id)}
                        </React.Fragment>
                      )
                    })}
                    {dropTarget?.type === 'between-folder-children' && dropTarget.folderId === folder.id && dropTarget.index === folder.projectIds.length && (
                      <div className="sidebar-drop-indicator" />
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
                <div className="sidebar-drop-indicator" />
              )}
              {renderProject(project, null)}
            </React.Fragment>
          )
        })}
        {dropTarget?.type === 'between-root' && dropTarget.index === rootOrder.length && (
          <div className="sidebar-drop-indicator" />
        )}
      </div>
      </>)}

      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          {contextMenu.type === 'folder' ? (
            <>
              <button onClick={() => {
                setEditingId(contextMenu.projectId)
                const folder = folders.find(f => f.id === contextMenu.projectId)
                setEditValue(folder?.name ?? '')
                setContextMenu(null)
              }}>Rename</button>
              <button onClick={() => {
                removeFolder(contextMenu.projectId)
                setContextMenu(null)
              }}>Delete</button>
            </>
          ) : (
            <>
              <button onClick={() => {
                const id = contextMenu.type === 'project' ? contextMenu.projectId : contextMenu.taskId!
                setEditingId(id)
                const item = contextMenu.type === 'project'
                  ? projects.find((p) => p.id === id)
                  : projects.find((p) => p.id === contextMenu.projectId)?.tasks.find((t) => t.id === id)
                setEditValue(item?.name ?? '')
                setContextMenu(null)
              }}>Rename</button>
              {contextMenu.type === 'project' && (
                <button onClick={() => {
                  setProjectSettingsId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Settings</button>
              )}
              <button onClick={() => {
                if (contextMenu.type === 'project') removeProject(contextMenu.projectId)
                else handleDeleteTask(contextMenu.projectId, contextMenu.taskId!)
                setContextMenu(null)
              }}>Delete</button>
            </>
          )}
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-btn settings-btn" onClick={() => setSettingsOpen(true)} title="Settings">&#9881;</button>
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
            onSave={(aiToolArgs) => updateProject(projectSettingsId, { aiToolArgs })}
            onClose={() => setProjectSettingsId(null)}
          />
        )
      })()}

      {workspaceModalProjectId && (() => {
        const project = projects.find(p => p.id === workspaceModalProjectId)
        if (!project) return null
        return (
          <CreateWorkspaceModal
            projectDir={getProjectDir(project)}
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
