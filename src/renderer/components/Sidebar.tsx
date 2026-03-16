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
import './Sidebar.css'

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
    reorderTasks, getProjectDir
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
  const [dragState, setDragState] = useState<{
    type: 'project' | 'task'
    projectId: string
    index: number
  } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ type: 'project' | 'task'; projectId?: string; index: number } | null>(null)
  const [workspaceModalProjectId, setWorkspaceModalProjectId] = useState<string | null>(null)
  const [switcherActive, setSwitcherActive] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  const toggleFolderCollapse = useCallback((folderId: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

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
    if (folder && collapsedFolders.has(folder.id)) {
      setCollapsedFolders(prev => {
        const next = new Set(prev)
        next.delete(folder.id)
        return next
      })
    }
  }, [selectedProjectId, folders])

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
    type: 'task',
    projectId: string,
    index: number
  ) => {
    if (e.button !== 0 || editingId) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        setDragState({ type, projectId, index })
      }

      const sidebarList = document.querySelector('.sidebar-list')
      if (!sidebarList) return

      const items = sidebarList.querySelectorAll<HTMLElement>(
        `.sidebar-project:has(.sidebar-item.project-item.selected) .task-item`
      )

      let bestIndex = 0
      for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (ev.clientY > midY) bestIndex = i + 1
      }

      setDropTarget({ type, projectId, index: bestIndex })
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (dragging) {
        setDragState(prev => {
          setDropTarget(dt => {
            if (prev && dt && dt.index !== prev.index && dt.index !== prev.index + 1) {
              const toIndex = dt.index > prev.index ? dt.index - 1 : dt.index
              reorderTasks(prev.projectId, prev.index, toIndex)
            }
            return null
          })
          return null
        })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, reorderTasks])

  const renderProject = (project: Project, folderId: string | null) => (
    <div className="sidebar-project" key={project.id}>
      <div
        className={`sidebar-item project-item ${selectedProjectId === project.id ? 'selected' : ''}`}
        onClick={() => setSelectedProjectId(project.id)}
        onContextMenu={(e) => handleContextMenu(e, 'project', project.id)}
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
            {(() => {
              const projectStatus = getProjectStatus(project.tasks, allStatuses)
              return projectStatus ? <span className={`sidebar-status sidebar-status-${projectStatus}`} /> : null
            })()}
            <span className="sidebar-label">{project.name}</span>
            {isRemoteProject(project) && <span className="sidebar-ssh-badge">ssh</span>}
            {isShellCommandProject(project) && <span className="sidebar-ssh-badge">shell</span>}
            {isRemoteProject(project) && (
              <span className={`sidebar-ssh-dot sidebar-ssh-dot-${sshStatuses[project.id] || 'disconnected'}`} />
            )}
          </>
        )}
      </div>

      {selectedProjectId === project.id && (
        <div className="sidebar-tasks">
          {project.tasks.map((task, tIdx) => (
            <React.Fragment key={task.id}>
              {dropTarget?.type === 'task' && dropTarget.projectId === project.id && dropTarget.index === tIdx && (
                <div className="sidebar-drop-indicator task-drop-indicator" />
              )}
              <div
                className={`sidebar-item task-item ${selectedTaskId === task.id ? 'selected' : ''} ${dragState?.type === 'task' && dragState.index === tIdx ? 'dragging' : ''}`}
                onClick={() => handleSelectTask(task)}
                onMouseDown={(e) => handleDragMouseDown(e, 'task', project.id, tIdx)}
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
                    <TaskStatusDot task={task} allStatuses={allStatuses} />
                    <span className="sidebar-label">{task.name}</span>
                    {isWorkspaceTask(task) && <span className="sidebar-ssh-badge">ws</span>}
                  </>
                )}
              </div>
            </React.Fragment>
          ))}
          {dropTarget?.type === 'task' && dropTarget.projectId === project.id && dropTarget.index === project.tasks.length && (
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
                <div
                  className="sidebar-folder-heading"
                  onClick={() => toggleFolderCollapse(folder.id)}
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
                      {folderStatus && <span className={`sidebar-status sidebar-status-${folderStatus}`} />}
                      <span className="sidebar-folder-label">{folder.name}</span>
                    </>
                  )}
                </div>
                {!isCollapsed && folder.projectIds.map(pid => {
                  const project = projects.find(p => p.id === pid)
                  if (!project) return null
                  return renderProject(project, folder.id)
                })}
              </React.Fragment>
            )
          }

          const project = projects.find(p => p.id === itemId)
          if (!project) return null
          return <React.Fragment key={project.id}>{renderProject(project, null)}</React.Fragment>
        })}
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
