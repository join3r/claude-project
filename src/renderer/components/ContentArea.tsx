import React, { useCallback, useEffect, useState } from 'react'
import { Folder, GitBranch, Globe, StickyNote, Columns2, SquareTerminal } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useMetaHeld } from '../hooks/useMetaHeld'
import { buildWindowTitle } from '../hooks/useAppState'
import { isRemoteProject, isRenamableTab, isShellCommandProject, type FileBrowserTab } from '../../shared/types'
import { localProjectFolder } from '../../shared/external-editors'
import TaskPanes from './TaskPanes'
import TaskHeader from './TaskHeader'
import { ProjectHome } from './ProjectHome'
import { ArchivedView } from './ArchivedView'
import { useArchivedView } from './archivedViewTarget'
import TunnelPopup from './TunnelPopup'
import UnsavedChangesModal from './UnsavedChangesModal'
import StateSyncErrorModal from './StateSyncErrorModal'
import OpenInIdeButton from './OpenInIdeButton'
import { focusedPaneOf, paneIndexOfElement, setFocusedPane, useFocusedPane } from './paneFocus'
import { zoomTargetForTabType } from './zoom'
import type { TunnelConfig, TunnelState } from '../../shared/types'

import { formatShortcutForApp } from '../../shared/shortcut-label'
import { paletteEvents } from '../palette/paletteEvents'
import { findStreamOfTask, findTaskInProject, projectTasks, taskDirectory } from '../../shared/streams'
import { showsTabBars } from '../../shared/panes'
import type { Task } from '../../shared/types'

const toolBtnCls = 'bg-transparent border-0 cursor-pointer w-[28px] h-[26px] rounded-md leading-none inline-flex items-center justify-center [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast) disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent'

/** A hairline between the toolbar's groups of buttons. */
const ToolbarSep = (): React.ReactElement => <span className="w-px h-4 bg-border mx-1 shrink-0" aria-hidden />

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
      className={`${toolBtnCls} ${active ? 'bg-sel text-text' : 'text-text-muted hover:text-text hover:bg-surface-3'}`}
      aria-pressed={active}
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
    splitTabRight,
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
    updateProject,
    connectSsh,
    config
  } = useApp()
  useMetaHeld()
  const archivedView = useArchivedView()
  const showsArchived = !!archivedView && !!selectedProject && !selectedTask && archivedView.projectId === selectedProject.id
  const selectedFocusedPane = Math.max(0, Math.min((selectedTask?.panes.length ?? 1) - 1, useFocusedPane(selectedTaskId ?? '')))
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
  const hasProjectSelection = !!selectedProjectId

  // The selected task, looked up fresh for keyboard and menu handlers.
  const currentTask = useCallback((): Task | null => {
    if (!selectedProjectId || !selectedTaskId) return null
    return findTaskInProject(projects.find(p => p.id === selectedProjectId), selectedTaskId) ?? null
  }, [projects, selectedProjectId, selectedTaskId])

  /**
   * The pane keyboard and menu actions address: the one holding DOM focus, else
   * the one this window last focused in the task.
   */
  const actionPane = useCallback((task: Task): number => {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null
    const inTask = activeEl instanceof Element && activeEl.closest<HTMLElement>(`[data-task-id="${task.id}"]`)
    const fromDom = inTask ? paneIndexOfElement(activeEl) : null
    return fromDom !== null && fromDom < task.panes.length ? fromDom : focusedPaneOf(task)
  }, [])

  /** Make pane `index` the focused one and put the keyboard in its active tab. */
  const focusPane = useCallback((task: Task, index: number) => {
    if (index < 0 || index >= task.panes.length) return
    setFocusedPane(task.id, index)
    const body = document.querySelector<HTMLElement>(`[data-tab-body="${task.panes[index].activeTabId}"]`)
    const target = body?.querySelector<HTMLElement>('.xterm-helper-textarea, textarea, input, [contenteditable="true"], webview, [tabindex]:not([tabindex="-1"])')
    target?.focus()
  }, [])

  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const handler = (e: KeyboardEvent) => {
      // On macOS use Cmd only — Ctrl+D must pass through to terminals (EOF).
      const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!primary) return
      const task = currentTask()
      if (!task || !selectedProjectId) return
      const target = e.target as HTMLElement | null
      // xterm's hidden textarea (class `xterm-helper-textarea`) is where focused
      // terminals receive keystrokes — exclude it so these still work when a
      // terminal pane (Claude Code, Codex, plain shell) is focused.
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const isXtermHelper = target?.classList.contains('xterm-helper-textarea')

      // Cmd+D: split the focused pane's tab off into a new pane to its right.
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
        if (isEditable && !isXtermHelper) return
        e.preventDefault()
        e.stopPropagation()
        const pane = task.panes[actionPane(task)]
        if (pane) splitTabRight(selectedProjectId, task.id, pane.activeTabId)
        return
      }

      // Cmd+Alt+Left/Right: focus the previous/next pane.
      if (e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (task.panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()
        const step = e.key === 'ArrowLeft' ? -1 : 1
        focusPane(task, (actionPane(task) + step + task.panes.length) % task.panes.length)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [selectedProjectId, currentTask, actionPane, focusPane, splitTabRight])

  // Cmd+1..9: that tab of the focused pane. Cmd+Shift+1..9: focus pane N.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || !selectedProjectId || !selectedTaskId) return

      const digit = e.code.match(/^Digit([1-9])$/)?.[1]
      if (!digit) return

      const task = currentTask()
      if (!task) return

      const index = parseInt(digit, 10) - 1
      if (e.shiftKey) {
        if (index >= task.panes.length) return
        e.preventDefault()
        focusPane(task, index)
        return
      }
      const tab = task.panes[actionPane(task)]?.tabs[index]
      if (tab) {
        e.preventDefault()
        setActiveTab(selectedProjectId, selectedTaskId, tab.id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedProjectId, selectedTaskId, currentTask, actionPane, focusPane, setActiveTab])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

      const task = currentTask()
      if (!task) return
      const activeTabId = task.panes[actionPane(task)]?.activeTabId
      const activeTab = activeTabId ? task.panes.flatMap(pane => pane.tabs).find(t => t.id === activeTabId) : undefined
      if (!activeTab || !isRenamableTab(activeTab) || !showsTabBars(task)) return

      e.preventDefault()
      window.dispatchEvent(new CustomEvent('request-tab-rename', { detail: { tabId: activeTab.id } }))
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentTask, actionPane])

  // Menu shortcut handlers (Cmd+W, Cmd+Shift+T, Cmd+R, Cmd+T)
  useEffect(() => {
    const getActiveTabInfo = () => {
      const task = currentTask()
      if (!task) return null
      const pane = actionPane(task)
      const activeTabId = task.panes[pane]?.activeTabId ?? null
      const activeTab = activeTabId ? task.panes[pane].tabs.find(t => t.id === activeTabId) ?? null : null
      return { task, pane, activeTabId, activeTab }
    }

    const cleanupClose = window.api.onMenuCloseTab(() => {
      const info = getActiveTabInfo()
      // The main tab has no close: the task closes from the sidebar or Inbox.
      if (selectedProjectId && info?.activeTabId && info.activeTabId !== info.task.mainTabId) {
        // May park on the unsaved-changes dialog before anything is removed.
        void removeTab(selectedProjectId, info.task.id, info.activeTabId)
      }
    })

    const cleanupReopenClosed = window.api.onMenuReopenClosedTab(() => {
      reopenClosedTab()
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
      const info = getActiveTabInfo()
      addTab(selectedProjectId, selectedTaskId, info?.pane ?? 0, 'terminal')
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
  }, [selectedProjectId, selectedTaskId, currentTask, actionPane, addTab, removeTab, reopenClosedTab, zoomTerminal, zoomBrowser, zoomEditor])

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
  const selectedStream = selectedTask ? findStreamOfTask(selectedProject, selectedTask.id) : undefined
  const windowBarTitle = buildWindowTitle(selectedProject?.name ?? null, selectedTask?.name ?? null, selectedStream)
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
        <TaskHeader
          project={selectedProject}
          task={selectedTask}
          stream={selectedStream}
          title={windowBarTitle}
          tools={(
            <>
              {isRemoteProject(selectedProject) && (
                <button
                  className={tunnelButtonClassName}
                  onClick={() => setTunnelPopupOpen(true)}
                  title="Tunnel"
                >
                  &#8596;
                </button>
              )}
              {selectedTask && (
                <>
                  <button
                    className={`${toolBtnCls} text-text-muted hover:text-text hover:bg-surface-3`}
                    onClick={() => addTab(selectedProject.id, selectedTask.id, selectedFocusedPane, 'terminal')}
                    title={`New terminal (${formatShortcutForApp('CmdOrCtrl+T')})`}
                  >
                    <SquareTerminal size={15} />
                  </button>
                  <button
                    className={`${toolBtnCls} text-text-muted hover:text-text hover:bg-surface-3`}
                    onClick={() => addTab(selectedProject.id, selectedTask.id, selectedFocusedPane, 'browser')}
                    title="New browser tab"
                  >
                    <Globe size={15} />
                  </button>
                  {showsTabBars(selectedTask) && (
                    <button
                      className={`${toolBtnCls} text-text-muted hover:text-text hover:bg-surface-3`}
                      disabled={(selectedTask.panes[selectedFocusedPane]?.tabs.length ?? 0) < 2}
                      onClick={() => {
                        const pane = selectedTask.panes[selectedFocusedPane]
                        if (pane) splitTabRight(selectedProject.id, selectedTask.id, pane.activeTabId)
                      }}
                      title={`Split right (${formatShortcutForApp('CmdOrCtrl+D')})`}
                    >
                      <Columns2 size={15} />
                    </button>
                  )}
                  <ToolbarSep />
                </>
              )}
              {hasFileBrowserTabs && (
                <>
                  {canShowLocalTabs && (
                    <FileBrowserTabButton
                      icon={<Folder size={15} />}
                      tab="files"
                      label="Files"
                      fileBrowserOpen={fileBrowserOpen}
                      fileBrowserActiveTab={fileBrowserActiveTab}
                      onActivate={handleFileBrowserActivate}
                    />
                  )}
                  {canShowLocalTabs && (
                    <FileBrowserTabButton
                      icon={<GitBranch size={15} />}
                      tab="git"
                      label="Git"
                      fileBrowserOpen={fileBrowserOpen}
                      fileBrowserActiveTab={fileBrowserActiveTab}
                      onActivate={handleFileBrowserActivate}
                    />
                  )}
                  <FileBrowserTabButton
                    icon={<StickyNote size={15} />}
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
              {selectedTask && <ToolbarSep />}
            </>
          )}
        />
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
      {/* An archived task or stream opened from a Done row shows read-only in Home's place. */}
      {showsArchived && archivedView && <ArchivedView key={`${archivedView.kind}:${archivedView.id}`} target={archivedView} />}
      {selectedProject && !selectedTask && !showsArchived && (
        <div className="flex-1 min-h-0 flex overflow-hidden" data-testid="project-home">
          <ProjectHome projectId={selectedProject.id} />
        </div>
      )}
      {projects.flatMap((project) =>
        projectTasks(project).map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
          const effectiveDir = taskDirectory(project, task)
          return (
            <div
              key={`${project.id}-${task.id}`}
              className="flex-1 min-h-0 flex-col overflow-hidden relative"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
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
              <TaskPanes project={project} task={task} visible={isVisible} projectDir={effectiveDir} />
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
