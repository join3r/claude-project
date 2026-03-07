import React, { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import './Sidebar.css'

export default function Sidebar(): React.ReactElement {
  const {
    projects, selectedProjectId, selectedTaskId,
    setSelectedProjectId, setSelectedTaskId,
    addProject, removeProject, renameProject,
    addTask, removeTask, renameTask
  } = useApp()

  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'project' | 'task'; projectId: string; taskId?: string
  } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus()
  }, [editingId])

  useEffect(() => {
    const dismiss = () => setContextMenu(null)
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [])

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

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <button className="sidebar-btn" onClick={handleAddProject} title="Add project">+</button>
      </div>

      <div className="sidebar-list">
        {projects.map((project) => (
          <div key={project.id} className="sidebar-project">
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
                <span className="sidebar-label">{project.name}</span>
              )}
            </div>

            {selectedProjectId === project.id && (
              <div className="sidebar-tasks">
                {project.tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`sidebar-item task-item ${selectedTaskId === task.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTaskId(task.id)}
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
                      <span className="sidebar-label">{task.name}</span>
                    )}
                  </div>
                ))}
                <button
                  className="sidebar-btn add-task-btn"
                  onClick={() => handleAddTask(project.id)}
                >
                  + Task
                </button>
              </div>
            )}
          </div>
        ))}
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
        <button className="sidebar-btn settings-btn" title="Settings">&#9881;</button>
      </div>
    </div>
  )
}
