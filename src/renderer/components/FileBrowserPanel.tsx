import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useGitStatus } from '../hooks/useGitStatus'
import { isRemoteProject, isShellCommandProject, type FileBrowserTab, type Project } from '../../shared/types'
import { featureAvailable, openInIdeAvailable, revealAvailable } from '../../shared/project-features'
import { findStreamOfTask, needsTaskWorktree, taskWorkspace } from '../../shared/streams'
import { joinWorkspaceDir } from '../../shared/workspace-path'
import { openWorkspaceInIde } from '../openWorkspaceInIde'
import FileTree, { type FileTreeHandle } from './FileTree'
import FilesPanelHeader from './FilesPanelHeader'
import GitStatus from './GitStatus'
import NotesList from './NotesList'
import { agentLinkPath, formatAgentLink } from '../../shared/agent-link'
import { useLinkToAgent } from '../agentLink/linkToAgent'
import { createTab } from './newTaskTabs'
import { isNotebookFile } from '../../shared/notebook'
import { dirBasename } from '../../shared/paths'
import { ensureTaskWorktree } from '../taskWorktrees'
import { desktopPlatform, useHostPlatform } from '../hostPlatform'
import type { PaneRef } from './paneFocus'

/** The project has Files and Git: a local folder this desktop can read. Notes go everywhere. */
export function hasLocalFileTabs(project: Project | null | undefined): boolean {
  return !!project
    && !isRemoteProject(project)
    && !isShellCommandProject(project)
    && featureAvailable(project, 'files')
    && !!project.directory
}

function useLocalFileTabs(): boolean {
  return hasLocalFileTabs(useApp().selectedProject)
}

/**
 * The side panel beside a project's map: Files, Git and Notes. A task shows the
 * same bodies (`FileBrowserBody`) as Bench tabs instead, so the panel stays
 * shut while one is selected.
 */
export default function FileBrowserPanel(): React.ReactElement | null {
  const {
    fileBrowserOpen,
    fileBrowserWidth,
    fileBrowserActiveTab,
    setFileBrowserWidth,
    setFileBrowserActiveTab,
    selectedProject,
    selectedTaskId
  } = useApp()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const isLocalProject = useLocalFileTabs()

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const panel = panelRef.current
      if (!panel) return

      const startX = e.clientX
      const startWidth = fileBrowserWidth

      const onMouseMove = (ev: MouseEvent): void => {
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

  if (!fileBrowserOpen || !selectedProject) return null
  // A task's Files, Git and Notes are Bench tabs: the panel serves a project's map.
  if (selectedTaskId) return null

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
        <div className="flex-1 overflow-auto flex flex-col min-h-0">
          <FileBrowserBody tab={activeTab} active />
        </div>
      </div>
    </>
  )
}

/**
 * Files (the tree), Git (status, diff, commit) or Notes for the selected task,
 * or the project when no task is selected. `active` polls git status.
 * `pane` is where a file, diff or terminal opened from here goes.
 */
export function FileBrowserBody({ tab, active, pane = 'focused' }: {
  tab: FileBrowserTab
  active: boolean
  pane?: PaneRef
}): React.ReactElement {
  const {
    selectedProjectId,
    selectedTaskId,
    selectedProject,
    selectedTask,
    config,
    openOrFocusDiffTab,
    openOrFocusEditorTab,
    addTab,
    taskForTab
  } = useApp()
  const fileTreeRef = useRef<FileTreeHandle>(null)
  const [filterQuery, setFilterQuery] = useState('')

  const selectedWorkspace = taskWorkspace(selectedProject, selectedTask?.id)
  const effectiveDir = selectedWorkspace
    ? joinWorkspaceDir(selectedWorkspace.worktreePath, selectedWorkspace.relativeProjectPath)
    : selectedProject?.directory ?? ''

  const isLocalProject = useLocalFileTabs()
  const gitStatus = useGitStatus(effectiveDir, active && isLocalProject, selectedProjectId ?? undefined)
  const linkToAgent = useLinkToAgent(selectedProjectId ?? '', selectedTaskId ?? '')
  const platform = useHostPlatform(selectedProject?.host)
  // A DevTool server's folder isn't on this computer: no Reveal in Finder; Open in
  // IDE goes over SSH (plan step 9), except on a Windows desktop.
  const canReveal = revealAvailable(selectedProject)
  const canOpenInIde = openInIdeAvailable(selectedProject, desktopPlatform())

  useEffect(() => {
    setFilterQuery('')
  }, [selectedProject?.id])

  const handleFileClick = useCallback(
    (filePath: string) => {
      if (!selectedProjectId) return
      // From the Home page (no task) the file opens in a `main` task.
      const type = isNotebookFile(filePath) ? 'notebook' : 'editor'
      const taskId = taskForTab(selectedProjectId, selectedTaskId, () => createTab(type, { filePath }), dirBasename(filePath))
      if (taskId) openOrFocusEditorTab(selectedProjectId, taskId, pane, filePath)
    },
    [selectedProjectId, selectedTaskId, openOrFocusEditorTab, taskForTab, pane]
  )

  const handleGitFileClick = useCallback(
    (filePath: string) => {
      if (!selectedProjectId) return
      const taskId = taskForTab(selectedProjectId, selectedTaskId, () => createTab('diff', { filePath }), dirBasename(filePath))
      if (taskId) openOrFocusDiffTab(selectedProjectId, taskId, pane, filePath)
    },
    [selectedProjectId, selectedTaskId, openOrFocusDiffTab, taskForTab, pane]
  )

  const handleRevealInTerminal = useCallback(async (relativeDir: string) => {
    if (!selectedProjectId) return
    let dir = effectiveDir
    // The tree shows the stream's worktree until the task has its own; a
    // terminal pinned to a folder there would stay there, so make it first.
    const stream = selectedProject && selectedTask ? findStreamOfTask(selectedProject, selectedTask.id) : undefined
    if (selectedProject && selectedTask && stream && needsTaskWorktree(selectedProject, stream, selectedTask)) {
      const result = await ensureTaskWorktree(selectedProject.id, selectedTask.id, { name: selectedTask.name, streamId: stream.id })
      if (result.status === 'failed') {
        window.alert(`Couldn't create the task's worktree:\n\n${result.error}`)
        return
      }
      if (result.status !== 'not-needed') dir = joinWorkspaceDir(result.workspace.worktreePath, result.workspace.relativeProjectPath)
    }
    const cwd = joinWorkspaceDir(dir, relativeDir || undefined)
    const taskId = taskForTab(selectedProjectId, selectedTaskId, () => createTab('terminal', { cwd }), 'Terminal')
    if (taskId) addTab(selectedProjectId, taskId, pane, 'terminal', { cwd })
  }, [addTab, effectiveDir, selectedProject, selectedProjectId, selectedTask, selectedTaskId, taskForTab, pane])

  const shown = !isLocalProject && tab !== 'notes' ? 'notes' : tab
  return (
    <>
      {shown === 'files' ? (
        <>
          <FilesPanelHeader
            filterQuery={filterQuery}
            onFilterChange={setFilterQuery}
            onNewFile={() => fileTreeRef.current?.startCreate('file')}
            onNewFolder={() => fileTreeRef.current?.startCreate('directory')}
            onCollapseAll={() => fileTreeRef.current?.collapseAll()}
          />
          <div className="flex-1 overflow-auto min-h-0">
            <FileTree
              ref={fileTreeRef}
              projectDir={effectiveDir}
              projectId={selectedProjectId ?? undefined}
              gitStatus={gitStatus}
              onFileClick={handleFileClick}
              filterQuery={filterQuery}
              onRevealInTerminal={handleRevealInTerminal}
              ideEditors={config?.externalEditors?.editors ?? []}
              onOpenInIde={canOpenInIde ? (editorId) => openWorkspaceInIde(editorId, effectiveDir, selectedProjectId ?? undefined, selectedProject?.host) : undefined}
              canReveal={canReveal}
              hostPlatform={platform}
              onLinkToAgent={selectedTaskId
                ? (relativePath, isDirectory) => {
                    linkToAgent(formatAgentLink({ path: agentLinkPath(effectiveDir, relativePath), isDirectory }))
                  }
                : undefined}
            />
          </div>
        </>
      ) : shown === 'git' ? (
        <GitStatus
          gitStatus={gitStatus}
          projectDir={effectiveDir}
          projectId={selectedProjectId ?? undefined}
          onFileClick={handleGitFileClick}
          canReveal={canReveal}
        />
      ) : (
        <NotesList />
      )}
    </>
  )
}
