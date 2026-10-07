import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, GitBranch, StickyNote, PanelRightOpen, PanelRightClose } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useMetaHeld } from '../hooks/useMetaHeld'
import { useGitStatus } from '../hooks/useGitStatus'
import { buildWindowTitle } from '../hooks/useAppState'
import { isRemoteProject, isRenamableTab, isShellCommandProject, type FileBrowserTab } from '../../shared/types'
import { localProjectFolder } from '../../shared/external-editors'
import Pane from './Pane'
import { ProjectHome } from './ProjectHome'
import TunnelPopup from './TunnelPopup'
import UnsavedChangesModal from './UnsavedChangesModal'
import StateSyncErrorModal from './StateSyncErrorModal'
import OpenInIdeButton from './OpenInIdeButton'
import { getPaneFromValue, resolvePaneForMenuAction, type PaneSide } from './paneFocus'
import { zoomTargetForTabType } from './zoom'
import type { TabDragState, TabDropTarget } from './tabDrag'
import type { TunnelConfig, TunnelState } from '../../shared/types'

import { joinWorkspaceDir } from '../../shared/workspace-path'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import { paletteEvents } from '../palette/paletteEvents'
import { findTaskInProject, paneTabs, projectTasks, taskWorkspace } from '../../shared/streams'

function FileBrowserTabButton({
  icon,
  tab,
  label,
  fileBrowserOpen,
  fileBrowserActiveTab,
  onActivate
}: {
  icon: React.ReactNode
  tab: FileBrowserTab
  label: string
  fileBrowserOpen: boolean
  fileBrowserActiveTab: FileBrowserTab
  onActivate: (tab: FileBrowserTab) => void
}): React.ReactElement {
  const active = fileBrowserOpen && fileBrowserActiveTab === tab
  return (
    <button
      className={`bg-transparent border-0 cursor-pointer w-[30px] h-6 rounded-md leading-none inline-flex items-center justify-center hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast) ${active ? 'text-accent' : 'text-text-muted hover:text-text'}`}
      onClick={() => onActivate(tab)}
      title={active ? `Close ${label}` : `Open ${label}`}
    >
      {icon}
    </button>
  )
}

export default function ContentArea(): React.ReactElement {
  const {
    projects,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    toggleSplit,
    setSplitRatio,
    getProjectDir,
    setActiveTab,
    addTab,
    removeTab,
    reopenClosedTab,
    fileBrowserOpen,
    fileBrowserActiveTab,
    setFileBrowserOpen,
    setFileBrowserActiveTab,
    zoomTerminal,
    zoomBrowser,
    zoomEditor,
    getTaskViewState,
    updateProject,
    connectSsh,
    config
  } = useApp()
  useMetaHeld()
  const panesRef = useRef<HTMLDivElement | null>(null)
  const focusedPaneRef = useRef<{ projectId: string | null; taskId: string | null; pane: PaneSide }>({
    projectId: null,
    taskId: null,
    pane: 'left'
  })
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})
  const [tunnelStates, setTunnelStates] = useState<Record<string, TunnelState>>({})
  const [tunnelPopupOpen, setTunnelPopupOpen] = useState(false)
  const [openInIdeError, setOpenInIdeError] = useState<string | null>(null)
  const [agentLinkNotice, setAgentLinkNotice] = useState<string | null>(null)

  // Ctrl+L found nothing to link to (no agent tab) or could not save first.
  useEffect(() => {
    let timer: number | undefined
    const off = paletteEvents.on('agent-link-notice', (message) => {
      setAgentLinkNotice(message)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setAgentLinkNotice(null), 4000)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    window.api.onSshStatusChanged((projectId: string, status: string) => {
      setSshStatuses(prev => ({ ...prev, [projectId]: status }))
    })
  }, [])

  useEffect(() => {
    window.api.onSshTunnelStatusChanged((projectId: string, state: TunnelState) => {
      setTunnelStates(prev => ({ ...prev, [projectId]: state }))
    })
  }, [])

  useEffect(() => {
    projects.filter(isRemoteProject).forEach(p => {
      window.api.sshStatus(p.id).then(status => {
        setSshStatuses(prev => ({ ...prev, [p.id]: status }))
      })
      window.api.sshTunnelStatus(p.id).then(state => {
        setTunnelStates(prev => ({ ...prev, [p.id]: state }))
      })
    })
  }, [projects])
  const isDragging = dragRatio !== null

  const hasProjectSelection = !!selectedProjectId

  const rememberFocusedPane = useCallback((pane: PaneSide) => {
    focusedPaneRef.current = {
      projectId: selectedProjectId,
      taskId: selectedTaskId,
      pane
    }
  }, [selectedProjectId, selectedTaskId])

  useEffect(() => {
    setTabDragState(null)
    setTabDropTarget(null)
  }, [selectedProjectId, selectedTaskId])

  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const handler = (e: KeyboardEvent) => {
      // On macOS use Cmd only — Ctrl+D must pass through to terminals (EOF).
      const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!primary || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'd') return
      if (!selectedProjectId || !selectedTaskId) return
      const target = e.target as HTMLElement | null
      // xterm's hidden textarea (class `xterm-helper-textarea`) is where focused
      // terminals receive keystrokes — exclude it so Cmd+D still toggles split
      // when a terminal pane (Claude Code, Codex, plain shell) is focused.
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const isXtermHelper = target?.classList.contains('xterm-helper-textarea')
      if (isEditable && !isXtermHelper) return
      e.preventDefault()
      e.stopPropagation()
      toggleSplit(selectedProjectId, selectedTaskId)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [selectedProjectId, selectedTaskId, toggleSplit])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || !selectedProjectId || !selectedTaskId) return

      const digit = e.code.match(/^Digit([1-9])$/)?.[1]
      if (!digit) return

      const project = projects.find(p => p.id === selectedProjectId)
      const task = findTaskInProject(project, selectedTaskId)
      if (!task) return

      const index = parseInt(digit, 10) - 1
      const pane: 'left' | 'right' = e.shiftKey ? 'right' : 'left'
      const tabs = paneTabs(task, pane)
      const tab = tabs[index]

      if (tab) {
        e.preventDefault()
        setActiveTab(selectedProjectId, selectedTaskId, pane, tab.id)
        rememberFocusedPane(pane)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [projects, selectedProjectId, selectedTaskId, setActiveTab, rememberFocusedPane, getTaskViewState])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return
      if (!selectedProjectId || !selectedTaskId) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

      const project = projects.find(p => p.id === selectedProjectId)
      const task = findTaskInProject(project, selectedTaskId)
      if (!task) return
      const taskView = getTaskViewState(task)

      const activeEl = typeof document !== 'undefined' ? document.activeElement : null
      const paneFromDom = activeEl instanceof Element
        ? activeEl.closest<HTMLElement>('[data-pane]')?.dataset.pane
        : undefined
      const pane: 'left' | 'right' = paneFromDom === 'right' ? 'right' : 'left'

      const activeTabId = taskView.activeTab[pane]
      if (!activeTabId) return
      const activeTab = paneTabs(task, pane).find(t => t.id === activeTabId)
      if (!activeTab || !isRenamableTab(activeTab)) return

      e.preventDefault()
      window.dispatchEvent(new CustomEvent('request-tab-rename', { detail: { tabId: activeTabId } }))
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [projects, selectedProjectId, selectedTaskId, getTaskViewState])

  // Menu shortcut handlers (Cmd+W, Cmd+Shift+T, Cmd+R, Cmd+T)
  useEffect(() => {
    const getActivePaneFromDom = (): PaneSide | null => {
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null
      const paneElement = typeof Element !== 'undefined' && activeElement instanceof Element
        ? activeElement.closest<HTMLElement>('[data-pane]')
        : null
      return getPaneFromValue(paneElement?.dataset.pane)
    }

    const getRememberedPane = (): PaneSide | null => {
      const fallbackPane = focusedPaneRef.current
      if (fallbackPane.projectId === selectedProjectId && fallbackPane.taskId === selectedTaskId) {
        return fallbackPane.pane
      }
      return null
    }

    const getActiveTabInfo = () => {
      if (!selectedProjectId || !selectedTaskId) return null
      const project = projects.find(p => p.id === selectedProjectId)
      const task = findTaskInProject(project, selectedTaskId)
      if (!task) return null
      const taskView = getTaskViewState(task)
      const pane = resolvePaneForMenuAction(taskView.splitOpen, getActivePaneFromDom(), getRememberedPane())
      const activeTabId = taskView.activeTab[pane]
      const activeTab = activeTabId ? paneTabs(task, pane).find(t => t.id === activeTabId) : null
      return { project, task, pane, activeTabId, activeTab }
    }

    const cleanupClose = window.api.onMenuCloseTab(() => {
      const info = getActiveTabInfo()
      if (selectedProjectId && selectedTaskId && info?.activeTabId) {
        // May park on the unsaved-changes dialog before anything is removed.
        void removeTab(selectedProjectId, selectedTaskId, info.pane, info.activeTabId)
      }
    })

    const cleanupReopenClosed = window.api.onMenuReopenClosedTab(() => {
      const restoredPane = reopenClosedTab()
      if (restoredPane) {
        rememberFocusedPane(restoredPane)
      }
    })

    const cleanupReload = window.api.onMenuReloadTab(() => {
      const info = getActiveTabInfo()
      if (info?.activeTab?.type === 'browser' && info.activeTabId) {
        window.dispatchEvent(new CustomEvent('reload-browser-tab', { detail: { tabId: info.activeTabId } }))
        return
      }
      if ((info?.activeTab?.type === 'diff' || info?.activeTab?.type === 'editor' || info?.activeTab?.type === 'notebook') && info.activeTabId) {
        window.dispatchEvent(new CustomEvent('reload-file-tab', { detail: { tabId: info.activeTabId } }))
      }
    })

    const cleanupNewTerminal = window.api.onMenuNewTerminal(() => {
      if (!selectedProjectId || !selectedTaskId) return
      const pane = getActiveTabInfo()?.pane ?? 'left'
      addTab(selectedProjectId, selectedTaskId, pane, 'terminal')
      rememberFocusedPane(pane)
    })

    const handleZoom = (direction: 'in' | 'out' | 'reset') => {
      const target = zoomTargetForTabType(getActiveTabInfo()?.activeTab?.type)
      if (target === 'browser') zoomBrowser(direction)
      else if (target === 'editor') zoomEditor(direction)
      else zoomTerminal(direction)
    }

    const cleanupZoomIn = window.api.onMenuZoomIn(() => handleZoom('in'))
    const cleanupZoomOut = window.api.onMenuZoomOut(() => handleZoom('out'))
    const cleanupZoomReset = window.api.onMenuZoomReset(() => handleZoom('reset'))

    return () => {
      cleanupClose()
      cleanupReopenClosed()
      cleanupReload()
      cleanupNewTerminal()
      cleanupZoomIn()
      cleanupZoomOut()
      cleanupZoomReset()
    }
  }, [projects, selectedProjectId, selectedTaskId, addTab, removeTab, reopenClosedTab, zoomTerminal, zoomBrowser, zoomEditor, rememberFocusedPane, getTaskViewState])

  const handleDividerMouseDown = useCallback(
    (projectId: string, taskId: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      const container = panesRef.current
      if (!container) return

      const computeRatio = (clientX: number): number => {
        const rect = container.getBoundingClientRect()
        return Math.min(0.85, Math.max(0.15, (clientX - rect.left) / rect.width))
      }

      const onMouseMove = (ev: MouseEvent): void => {
        setDragRatio(computeRatio(ev.clientX))
      }

      const onMouseUp = (ev: MouseEvent): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        const finalRatio = computeRatio(ev.clientX)
        setDragRatio(null)
        setSplitRatio(projectId, taskId, finalRatio)
      }

      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [setSplitRatio]
  )

  const handleTunnelSave = useCallback(async (tunnel: TunnelConfig) => {
    if (!selectedProjectId || !selectedProject?.ssh) return
    updateProject(selectedProjectId, { tunnel })
    if (sshStatuses[selectedProjectId] === 'connected') {
      await window.api.sshSetTunnel(selectedProjectId, selectedProject.ssh, tunnel)
      return
    }
    setTunnelStates(prev => ({ ...prev, [selectedProjectId]: { status: 'inactive' } }))
  }, [selectedProject, selectedProjectId, sshStatuses, updateProject])

  const handleTunnelClear = useCallback(async () => {
    if (!selectedProjectId || !selectedProject?.ssh) return
    updateProject(selectedProjectId, { tunnel: undefined })
    if (sshStatuses[selectedProjectId] === 'connected') {
      await window.api.sshSetTunnel(selectedProjectId, selectedProject.ssh, null)
      return
    }
    setTunnelStates(prev => ({ ...prev, [selectedProjectId]: { status: 'inactive' } }))
  }, [selectedProject, selectedProjectId, sshStatuses, updateProject])

  const selectedTunnelState = selectedProjectId ? tunnelStates[selectedProjectId] : undefined
  const selectedTaskView = selectedTask ? getTaskViewState(selectedTask) : null
  const windowBarTitle = buildWindowTitle(selectedProject?.name ?? null, selectedTask?.name ?? null)
  const selectedWorkspace = taskWorkspace(selectedProject, selectedTask?.id)
  const selectedProjectDir = selectedWorkspace
    ? joinWorkspaceDir(selectedWorkspace.worktreePath, selectedWorkspace.relativeProjectPath)
    : selectedProject?.directory ?? ''
  const canShowLocalTabs = !!selectedProject
    && !isRemoteProject(selectedProject)
    && !isShellCommandProject(selectedProject)
    && !!selectedProject.directory
  // Notes are always available (including remote / shell-command projects); the
  // Files/Git tabs are local-only.
  const hasFileBrowserTabs = !!selectedProject
  const handleFileBrowserActivate = useCallback((tab: FileBrowserTab) => {
    if (fileBrowserOpen && fileBrowserActiveTab === tab) {
      setFileBrowserOpen(false)
      return
    }
    setFileBrowserActiveTab(tab)
    if (!fileBrowserOpen) setFileBrowserOpen(true)
  }, [fileBrowserOpen, fileBrowserActiveTab, setFileBrowserOpen, setFileBrowserActiveTab])
  const shouldShowGitSummary = !!selectedProject
    && !isRemoteProject(selectedProject)
    && !isShellCommandProject(selectedProject)
    && !!selectedProjectDir
  const gitStatus = useGitStatus(selectedProjectDir, shouldShowGitSummary)
  const gitSummary = gitStatus?.summary ?? null
  const hasGitSummary = !!gitSummary && (gitSummary.added > 0 || gitSummary.deleted > 0)
  const baseTunnelClasses = 'bg-transparent border-0 text-text-muted cursor-pointer w-[30px] h-6 rounded-md text-md leading-none inline-flex items-center justify-center hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'
  const tunnelButtonClassName = selectedProject && isRemoteProject(selectedProject)
    ? [
        baseTunnelClasses,
        selectedTunnelState?.status === 'error'
          ? 'text-danger'
          : selectedProject.tunnel && selectedTunnelState?.status === 'active'
            ? 'text-accent'
            : ''
      ].filter(Boolean).join(' ')
    : baseTunnelClasses

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {selectedProject && (
        <div className="content-toolbar flex items-center justify-between gap-1.5 px-2 py-0.5 bg-surface-2 border-b-[0.5px] border-border [-webkit-app-region:drag]">
          <div className="flex items-center gap-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-muted" title={windowBarTitle}>
            <span className="text-text font-medium">{selectedProject.name}</span>
            {selectedTask && (
              <>
                <span className="text-text-muted"> / </span>
                <span className="text-text-muted">{selectedTask.name}</span>
              </>
            )}
            {hasGitSummary && gitSummary && (
              <span
                className="inline-flex items-center gap-1.5 ml-1.5 [font-variant-numeric:tabular-nums]"
                title={`${gitSummary.added} added, ${gitSummary.deleted} removed`}
              >
                {gitSummary.added > 0 && (
                  <span className="text-success">+{gitSummary.added}</span>
                )}
                {gitSummary.deleted > 0 && (
                  <span className="text-danger">-{gitSummary.deleted}</span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
          {isRemoteProject(selectedProject) && (
            <button
              className={tunnelButtonClassName}
              onClick={() => setTunnelPopupOpen(true)}
              title="Tunnel"
            >
              &#8596;
            </button>
          )}
          {hasFileBrowserTabs && (
            <>
              {canShowLocalTabs && (
                <FileBrowserTabButton
                  icon={<Folder size={14} />}
                  tab="files"
                  label="Files"
                  fileBrowserOpen={fileBrowserOpen}
                  fileBrowserActiveTab={fileBrowserActiveTab}
                  onActivate={handleFileBrowserActivate}
                />
              )}
              {canShowLocalTabs && (
                <FileBrowserTabButton
                  icon={<GitBranch size={14} />}
                  tab="git"
                  label="Git"
                  fileBrowserOpen={fileBrowserOpen}
                  fileBrowserActiveTab={fileBrowserActiveTab}
                  onActivate={handleFileBrowserActivate}
                />
              )}
              <FileBrowserTabButton
                icon={<StickyNote size={14} />}
                tab="notes"
                label="Notes"
                fileBrowserOpen={fileBrowserOpen}
                fileBrowserActiveTab={fileBrowserActiveTab}
                onActivate={handleFileBrowserActivate}
              />
            </>
          )}
          {canShowLocalTabs && (
            <OpenInIdeButton
              editors={config?.externalEditors?.editors ?? []}
              defaultId={config?.externalEditors?.defaultId ?? null}
              folder={localProjectFolder(selectedProject, selectedTask)}
              onError={setOpenInIdeError}
            />
          )}
          {selectedTask && (
            <button
              className={`bg-transparent border-0 cursor-pointer w-[30px] h-6 rounded-md leading-none inline-flex items-center justify-center hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast) ${selectedTaskView?.splitOpen ? 'text-accent' : 'text-text-muted hover:text-text'}`}
              onClick={() => toggleSplit(selectedProject.id, selectedTask.id)}
              title={selectedTaskView?.splitOpen
                ? `Close right pane (${formatShortcutForApp('CmdOrCtrl+D')})`
                : `Open right pane (${formatShortcutForApp('CmdOrCtrl+D')})`}
            >
              {selectedTaskView?.splitOpen
                ? <PanelRightClose size={15} />
                : <PanelRightOpen size={15} />}
            </button>
          )}
          </div>
        </div>
      )}
      {openInIdeError && (
        <div role="alert" className="px-2 py-1 text-sm text-danger bg-surface-2 border-b-[0.5px] border-border">
          {openInIdeError}
        </div>
      )}
      {agentLinkNotice && (
        <div role="status" className="px-2 py-1 text-sm text-text-muted bg-surface-2 border-b-[0.5px] border-border">
          {agentLinkNotice}
        </div>
      )}

      {!hasProjectSelection && (
        <div className="flex-1 flex items-center justify-center text-text-muted text-md">Select or create a task to get started</div>
      )}
      {/* A project with no task selected shows its Home page (clicking the project name lands here). */}
      {selectedProject && !selectedTask && (
        <div className="flex-1 min-h-0 flex overflow-hidden" data-testid="project-home">
          <ProjectHome projectId={selectedProject.id} />
        </div>
      )}
      {projects.flatMap((project) =>
        projectTasks(project).map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
          const taskView = getTaskViewState(task)
          const isSplitOpen = taskView.splitOpen
          const ratio = dragRatio ?? taskView.splitRatio ?? 0.5
          const workspace = taskWorkspace(project, task.id)
          const effectiveDir = workspace
            ? joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath)
            : getProjectDir(project)
          return (
            <div
              key={`${project.id}-${task.id}`}
              className="flex-1 flex-col overflow-hidden relative"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <div className="flex-1 flex overflow-hidden relative" ref={isVisible ? panesRef : undefined}>
                {isDragging && <div className="absolute inset-0 z-10 cursor-col-resize" />}
                {isRemoteProject(project) && sshStatuses[project.id] !== 'connected' && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-(--z-overlay)">
                    <div className="flex flex-col items-center gap-3 text-text text-md">
                      <span className="text-[32px] text-danger">&#9888;</span>
                      <span>SSH connection lost</span>
                      <button
                        className="inline-flex items-center justify-center h-(--ctl-h) px-4 rounded-md border-0 cursor-pointer text-base font-medium text-accent-ink shadow-btn bg-gradient-to-b from-[color-mix(in_srgb,var(--color-accent)_86%,white)] to-accent hover:brightness-105 disabled:opacity-50"
                        onClick={() => {
                          if (project.ssh) {
                            connectSsh(project.id, project.ssh).catch(() => {})
                          }
                        }}
                      >
                        {sshStatuses[project.id] === 'connecting' ? 'Connecting...' : 'Reconnect'}
                      </button>
                    </div>
                  </div>
                )}
                <Pane
                  tabs={paneTabs(task, 'left')}
                  activeTabId={taskView.activeTab.left}
                  taskVisible={isVisible}
                  pane="left"
                  projectId={project.id}
                  taskId={task.id}
                  projectDir={effectiveDir}
                  sshConfig={project.ssh}
                  shellCommand={project.shellCommand}
                  aiToolArgs={project.aiToolArgs}
                  promptBox={task.panes.length === 0 ? { project, taskName: task.name, workspaceDraft: task.workspaceDraft } : undefined}
                  style={isSplitOpen ? { flex: 'none', width: `calc(${ratio * 100}% - 1.5px)` } : undefined}
                  onPaneFocus={rememberFocusedPane}
                  tabDragState={tabDragState}
                  tabDropTarget={tabDropTarget}
                  onTabDragStateChange={setTabDragState}
                  onTabDropTargetChange={setTabDropTarget}
                  onTabDragComplete={rememberFocusedPane}
                />
                {isSplitOpen && (
                  <>
                    <div
                      className="w-[3px] shrink-0 bg-border cursor-col-resize hover:bg-accent active:bg-accent transition-colors duration-(--motion-fast)"
                      onMouseDown={handleDividerMouseDown(project.id, task.id)}
                    />
                    <Pane
                      tabs={paneTabs(task, 'right')}
                      activeTabId={taskView.activeTab.right}
                      taskVisible={isVisible}
                      pane="right"
                      projectId={project.id}
                      taskId={task.id}
                      projectDir={effectiveDir}
                      sshConfig={project.ssh}
                      shellCommand={project.shellCommand}
                      aiToolArgs={project.aiToolArgs}
                      style={{ flex: 'none', width: `calc(${(1 - ratio) * 100}% - 1.5px)` }}
                      onPaneFocus={rememberFocusedPane}
                      tabDragState={tabDragState}
                      tabDropTarget={tabDropTarget}
                      onTabDragStateChange={setTabDragState}
                      onTabDropTargetChange={setTabDropTarget}
                      onTabDragComplete={rememberFocusedPane}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })
      )}
      {tunnelPopupOpen && selectedProject && isRemoteProject(selectedProject) && (
        <TunnelPopup
          project={selectedProject}
          tunnelState={selectedTunnelState}
          onSave={handleTunnelSave}
          onClear={handleTunnelClear}
          onClose={() => setTunnelPopupOpen(false)}
        />
      )}
      {/* App-wide, but hosted here for the same reason TunnelPopup is: this is
          the surface the tabs it protects live on. */}
      <UnsavedChangesModal />
      <StateSyncErrorModal />
    </div>
  )
}
