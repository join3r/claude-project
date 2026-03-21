import React, { useCallback, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useGitStatus } from '../hooks/useGitStatus'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import FileTree from './FileTree'
import GitStatus from './GitStatus'
import './FileBrowserPanel.css'

export default function FileBrowserPanel(): React.ReactElement | null {
  const {
    fileBrowserOpen,
    fileBrowserWidth,
    fileBrowserActiveTab,
    setFileBrowserWidth,
    setFileBrowserActiveTab,
    selectedProjectId,
    selectedTaskId,
    selectedProject,
    selectedTask,
    openOrFocusDiffTab,
    openOrFocusEditorTab
  } = useApp()
  const panelRef = useRef<HTMLDivElement | null>(null)

  const effectiveDir = selectedTask?.workspace
    ? [selectedTask.workspace.worktreePath, selectedTask.workspace.relativeProjectPath].filter(Boolean).join('/')
    : selectedProject?.directory ?? ''

  const isLocalProject = selectedProject
    && !isRemoteProject(selectedProject)
    && !isShellCommandProject(selectedProject)
    && !!selectedProject.directory
  const gitStatus = useGitStatus(effectiveDir, fileBrowserOpen && isLocalProject)

  const focusedPane = 'left' as const

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const panel = panelRef.current
      if (!panel) return

      const startX = e.clientX
      const startWidth = fileBrowserWidth

      const onMouseMove = (ev: MouseEvent): void => {
        // Panel is on the right side, so dragging left increases width
        const delta = startX - ev.clientX
        const newWidth = Math.min(400, Math.max(150, startWidth + delta))
        setFileBrowserWidth(newWidth)
      }

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
      }

      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [fileBrowserWidth, setFileBrowserWidth]
  )

  const handleFileClick = useCallback(
    (filePath: string) => {
      if (!selectedProjectId || !selectedTaskId) return
      openOrFocusEditorTab(selectedProjectId, selectedTaskId, focusedPane, filePath)
    },
    [selectedProjectId, selectedTaskId, openOrFocusEditorTab]
  )

  const handleGitFileClick = useCallback(
    (filePath: string) => {
      if (!selectedProjectId || !selectedTaskId) return
      openOrFocusDiffTab(selectedProjectId, selectedTaskId, focusedPane, filePath)
    },
    [selectedProjectId, selectedTaskId, openOrFocusDiffTab]
  )

  if (!fileBrowserOpen || !isLocalProject) return null

  return (
    <>
      <div className="filebrowser-divider" onMouseDown={handleDividerMouseDown} />
      <div
        ref={panelRef}
        className="filebrowser-panel"
        style={{ width: fileBrowserWidth, minWidth: fileBrowserWidth, maxWidth: fileBrowserWidth }}
      >
        <div className="filebrowser-tabs">
          <button
            className={`filebrowser-tab${fileBrowserActiveTab === 'files' ? ' filebrowser-tab-active' : ''}`}
            onClick={() => setFileBrowserActiveTab('files')}
          >
            Files
          </button>
          <button
            className={`filebrowser-tab${fileBrowserActiveTab === 'git' ? ' filebrowser-tab-active' : ''}`}
            onClick={() => setFileBrowserActiveTab('git')}
          >
            Git
          </button>
        </div>
        <div className="filebrowser-content">
          {fileBrowserActiveTab === 'files' ? (
            <FileTree
              projectDir={effectiveDir}
              gitStatus={gitStatus}
              onFileClick={handleFileClick}
            />
          ) : (
            <GitStatus
              gitStatus={gitStatus}
              onFileClick={handleGitFileClick}
            />
          )}
        </div>
      </div>
    </>
  )
}
