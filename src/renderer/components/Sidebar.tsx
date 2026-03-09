import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, type TabStatusValue } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isRemoteProject } from '../../shared/types'
import type { Tab, Task } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import Settings from './Settings'
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

function TaskStatusDot({ task, allStatuses }: { task: Task; allStatuses: Record<string, TabStatusValue> }): React.ReactElement | null {
  const status = getTaskStatus(task, allStatuses)
  if (!status) return null
  return <span className={`sidebar-status sidebar-status-${status}`} />
}

export default function Sidebar(): React.ReactElement {
  const {
    projects, selectedProjectId, selectedTaskId,
    setSelectedProjectId, setSelectedTaskId,
    addProject, addRemoteProject, removeProject, renameProject,
    addTask, removeTask, renameTask,
    reorderProjects, reorderTasks
  } = useApp()
  const allStatuses = useAllTabStatuses()

  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'project' | 'task'; projectId: string; taskId?: string
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
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

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus()
  }, [editingId])

  useEffect(() => {
    const dismiss = () => { setContextMenu(null); setAddMenuOpen(false) }
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
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

  const DRAG_THRESHOLD = 5

  const handleDragMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'project' | 'task',
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

      const items = type === 'project'
        ? sidebarList.querySelectorAll<HTMLElement>('.sidebar-project')
        : sidebarList.querySelectorAll<HTMLElement>(
            `.sidebar-project:has(.sidebar-item.project-item.selected) .task-item`
          )

      let bestIndex = 0
      for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (ev.clientY > midY) bestIndex = i + 1
      }

      setDropTarget({ type, projectId: type === 'task' ? projectId : undefined, index: bestIndex })
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
              if (prev.type === 'project') {
                reorderProjects(prev.index, toIndex)
              } else {
                reorderTasks(prev.projectId, prev.index, toIndex)
              }
            }
            return null
          })
          return null
        })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, reorderProjects, reorderTasks])

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <div className="sidebar-add-wrapper">
          <button className="sidebar-btn" onClick={(e) => { e.stopPropagation(); setAddMenuOpen(!addMenuOpen) }} title="Add project">+</button>
          {addMenuOpen && (
            <div className="sidebar-add-menu">
              <button onClick={() => { setAddMenuOpen(false); handleAddProject() }}>Local project</button>
              <button onClick={() => { setAddMenuOpen(false); setRemoteModalOpen(true) }}>Remote project (SSH)</button>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-list">
        {projects.map((project, pIdx) => (
          <React.Fragment key={project.id}>
            {dropTarget?.type === 'project' && dropTarget.index === pIdx && (
              <div className="sidebar-drop-indicator" />
            )}
          <div className="sidebar-project">
            <div
              className={`sidebar-item project-item ${selectedProjectId === project.id ? 'selected' : ''} ${dragState?.type === 'project' && dragState.index === pIdx ? 'dragging' : ''}`}
              onClick={() => setSelectedProjectId(project.id)}
              onMouseDown={(e) => handleDragMouseDown(e, 'project', project.id, pIdx)}
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
                  <span className="sidebar-label">{project.name}</span>
                  {isRemoteProject(project) && <span className="sidebar-ssh-badge">ssh</span>}
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
                    onClick={() => setSelectedTaskId(task.id)}
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
              </div>
            )}
          </div>
          </React.Fragment>
        ))}
        {dropTarget?.type === 'project' && dropTarget.index === projects.length && (
          <div className="sidebar-drop-indicator" />
        )}
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <button onClick={() => {
            const id = contextMenu.type === 'project' ? contextMenu.projectId : contextMenu.taskId!
            setEditingId(id)
            const item = contextMenu.type === 'project'
              ? projects.find((p) => p.id === id)
              : projects.find((p) => p.id === contextMenu.projectId)?.tasks.find((t) => t.id === id)
            setEditValue(item?.name ?? '')
            setContextMenu(null)
          }}>Rename</button>
          <button onClick={() => {
            if (contextMenu.type === 'project') removeProject(contextMenu.projectId)
            else removeTask(contextMenu.projectId, contextMenu.taskId!)
            setContextMenu(null)
          }}>Delete</button>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-btn settings-btn" onClick={() => setSettingsOpen(true)} title="Settings">&#9881;</button>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {remoteModalOpen && (
        <AddRemoteProject
          onAdd={(name, ssh) => {
            addRemoteProject(name, ssh)
            setRemoteModalOpen(false)
          }}
          onCancel={() => setRemoteModalOpen(false)}
        />
      )}
    </div>
  )
}
