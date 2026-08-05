import React, { useCallback, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useGitStatus } from '../hooks/useGitStatus'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import FileTree from './FileTree'
import GitStatus from './GitStatus'
import NotesList from './NotesList'

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

  const isLocalProject = !!selectedProject
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

  if (!fileBrowserOpen || !selectedProject) return null

  const activeTab = !isLocalProject && fileBrowserActiveTab !== 'notes' ? 'notes' : fileBrowserActiveTab

  return (
    <>
      <div className="w-[3px] shrink-0 bg-border cursor-col-resize hover:bg-accent active:bg-accent transition-colors duration-(--motion-fast)" onMouseDown={handleDividerMouseDown} />
      <div
        ref={panelRef}
        className="flex flex-col h-full bg-surface border-l-[0.5px] border-border"
        style={{ width: fileBrowserWidth, minWidth: fileBrowserWidth, maxWidth: fileBrowserWidth }}
      >
        <div className="flex flex-row gap-1 px-2 pt-1 border-b border-hair">
          {isLocalProject && (
            <>
              <button
                className={`bg-transparent border-0 cursor-pointer px-2 pt-1 pb-1.5 text-sm border-b-2 leading-none hover:text-text transition-colors duration-(--motion-fast) ${activeTab === 'files' ? 'text-text border-accent' : 'text-text-muted border-transparent'}`}
                onClick={() => setFileBrowserActiveTab('files')}
              >
                Files
              </button>
              <button
                className={`bg-transparent border-0 cursor-pointer px-2 pt-1 pb-1.5 text-sm border-b-2 leading-none hover:text-text transition-colors duration-(--motion-fast) ${activeTab === 'git' ? 'text-text border-accent' : 'text-text-muted border-transparent'}`}
                onClick={() => setFileBrowserActiveTab('git')}
              >
                Git
              </button>
            </>
          )}
          <button
            className={`bg-transparent border-0 cursor-pointer px-2 pt-1 pb-1.5 text-sm border-b-2 leading-none hover:text-text transition-colors duration-(--motion-fast) ${activeTab === 'notes' ? 'text-text border-accent' : 'text-text-muted border-transparent'}`}
            onClick={() => setFileBrowserActiveTab('notes')}
          >
            Notes
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {activeTab === 'files' ? (
            <FileTree
              projectDir={effectiveDir}
              gitStatus={gitStatus}
              onFileClick={handleFileClick}
            />
          ) : activeTab === 'git' ? (
            <GitStatus
              gitStatus={gitStatus}
              projectDir={effectiveDir}
              onFileClick={handleGitFileClick}
            />
          ) : (
            <NotesList />
          )}
        </div>
      </div>
    </>
  )
}
