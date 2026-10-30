import { refetchStreamRuns } from '../streamRuns'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useTabStatusStore } from '../context/TabStatusContext'
import { isEphemeralProject, pinnedItemKey } from '../../shared/types'
import type { Task, Project, PinnedItem, PendingWorktreeSetup } from '../../shared/types'
import DeskNewProject from './desk/DeskNewProject'
import { createProjectOnHost, listHosts } from '../hosts'
import AddServerProject, { type AddServerProjectMode } from './servers/AddServerProject'
import AddServerDialog from './servers/AddServerDialog'
import ServerNotices from './servers/ServerNotices'
import { knownSshTargets } from './servers/sshTargets'
import { useServersState } from '../serversState'
import Settings from './Settings'
import NewTaskModal from './NewTaskModal'
import NewStreamModal from './NewStreamModal'
import type { NewTaskSubmission } from './newTask'
import { useFileNewTask } from '../hooks/useFileNewTask'
import { useMissingProjectDirs } from '../hooks/useMissingProjectDirs'
import { paletteEvents, type NewTaskFormRequest } from '../palette/paletteEvents'
import type { SidebarContextMenuState } from './sidebar/SidebarContextMenu'
import { useStreamAheadPolling } from '../taskLanding'
import SidebarContextMenu from './sidebar/SidebarContextMenu'
import { useCloseTask } from './sidebar/useCloseTask'
import { useCloseStream } from './sidebar/useCloseStream'
import { openEntityDialog } from '../entityActions'
import { findTaskInProject, taskTabs } from '../../shared/streams'
import DeskColumn from './desk/DeskColumn'
import { deskEvents } from './desk/deskEvents'
import { useDeskDone } from './desk/useDeskDone'

/**
 * The window's left side: the desk's inbox column (redesign step 1) and the
 * dialogs it and the rest of the window open — Settings, New project, New
 * stream, the full New task form, the row menu, Add server and the close and
 * land questions. The menu bar's New task, New stream and ⌘P land here too.
 */
export default function Sidebar(): React.ReactElement {
  const {
    projects, tags, projectOrder,
    pinnedItems,
    selectedProjectId, selectedTaskId,
    switchToTask, selectProjectHome,
    addProject, addRemoteProject, addShellCommandProject, addServerProjects, addTag,
    addStream, renameTask,
    getProjectDir,
    config
  } = useApp()
  const tabStatusStore = useTabStatusStore()

  const handleSelectTask = useCallback((projectId: string, task: Task) => {
    switchToTask(projectId, task.id)
    // Opening the task is the acknowledgement — clear attention on every tab, not
    // just the AI ones. A terminal's attention state otherwise never resets (it
    // only clears on a "ready"-shaped line), which would pin the row in Needs you.
    for (const tab of taskTabs(task)) {
      if (tabStatusStore.getStatus(tab.id) === 'attention') {
        tabStatusStore.setStatus(tab.id, null)
      }
    }
  }, [switchToTask, tabStatusStore])

  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null)
  // The snooze presets replace the menu body rather than fly out sideways.
  const [snoozeSubmenu, setSnoozeSubmenu] = useState(false)
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    setSnoozeSubmenu(false)
  }, [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The Settings page to open on (a notice's "Update" opens Updates). */
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const [addServerOpen, setAddServerOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [serverProjectOpen, setServerProjectOpen] = useState(false)
  /** Add server's "Choose a folder…" opens Server project on that server's folder browser. */
  const [serverProjectStart, setServerProjectStart] = useState<{ serverId: string; mode: AddServerProjectMode } | null>(null)
  const serversState = useServersState()
  const pairedServers = serversState.servers
  const serverDirectories = useCallback((serverId: string): ReadonlySet<string> =>
    new Set(projects.filter(p => p.host === serverId).map(p => p.directory)), [projects])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  /** The full New task form (model, mode, images, a terminal task, any folder), and what it starts with. */
  const [newTaskForm, setNewTaskForm] = useState<NewTaskFormRequest | null>(null)
  // The project the New stream dialog is open for.
  const [newStreamProjectId, setNewStreamProjectId] = useState<string | null>(null)
  const composeIntoNewStream = useRef(false)
  const closeTaskFlow = useCloseTask()
  const closeStreamFlow = useCloseStream()
  useStreamAheadPolling(projects, selectedProjectId, selectedTaskId)
  const missingDirs = useMissingProjectDirs(projects)
  const projectsById = React.useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  // The column *keeps* ad-hoc projects: their tasks are real work, and the
  // inbox is the only place they surface.
  const inboxProjects = React.useMemo(
    () => projectOrder.map(id => projectsById.get(id)).filter((p): p is Project => !!p),
    [projectOrder, projectsById]
  )
  // Ad-hoc projects stay out of the composer's destinations — you reach one again by picking its directory.
  const orderedProjects = React.useMemo(
    () => inboxProjects.filter(p => !isEphemeralProject(p)),
    [inboxProjects]
  )
  /** Projects on a DevTool server that isn't online: greyed in the column, from the cache. */
  const offlineIds = React.useMemo(
    () => new Set(projects.filter(p => !!p.host && pairedServers.find(s => s.id === p.host)?.state !== 'online').map(p => p.id)),
    [projects, pairedServers]
  )
  // Pins whose project, stream or task is gone are left out; storage prunes them on the next save.
  const pins = React.useMemo(() => {
    const projectIds = new Set<string>()
    const taskIds = new Set<string>()
    const streams: Array<{ projectId: string; streamId: string }> = []
    for (const item of pinnedItems ?? []) {
      const project = projectsById.get(item.projectId)
      if (!project) continue
      if (item.type === 'project') projectIds.add(project.id)
      else if (item.type === 'stream') {
        if (project.streams.some(stream => stream.id === item.streamId)) streams.push({ projectId: project.id, streamId: item.streamId })
      } else if (findTaskInProject(project, item.taskId)) taskIds.add(item.taskId)
    }
    return { projectIds, taskIds, streams }
  }, [pinnedItems, projectsById])
  /** Task id → project id, for the in-place rename. */
  const inboxTaskIds = React.useMemo(() => {
    const ids = new Map<string, string>()
    for (const project of inboxProjects) for (const stream of project.streams) for (const task of stream.tasks) ids.set(task.id, project.id)
    return ids
  }, [inboxProjects])

  // A DevTool server back online may have started or lost runs while away: ask its projects again.
  const onlineServerIds = pairedServers.filter(s => s.state === 'online').map(s => s.id).join(',')
  const lastOnlineRef = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const online = new Set(onlineServerIds ? onlineServerIds.split(',') : [])
    const before = lastOnlineRef.current
    lastOnlineRef.current = online
    if (!before) return
    const back = [...online].filter(id => !before.has(id))
    if (back.length === 0) return
    refetchStreamRuns(projects.filter(p => p.host && back.includes(p.host)).map(p => p.id))
  }, [onlineServerIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const isPinned = useCallback((item: PinnedItem) => {
    const key = pinnedItemKey(item)
    return (pinnedItems ?? []).some(candidate => pinnedItemKey(candidate) === key)
  }, [pinnedItems])

  useEffect(() => {
    const dismiss = () => closeContextMenu()
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [closeContextMenu])

  // New task focuses the compose box (the full form is "New Task with Options…"); ⌘P is App's.
  useEffect(() => window.api.onMenuNewTask(() => deskEvents.focusCompose()), [])
  useEffect(() => paletteEvents.on('open-new-task', () => deskEvents.focusCompose()), [])
  useEffect(() => paletteEvents.on('open-new-task-in', (where) => deskEvents.focusCompose(where)), [])
  useEffect(() => paletteEvents.on('open-new-task-form', (request) => setNewTaskForm(request)), [])
  useEffect(() => paletteEvents.on('open-new-stream', (projectId) => { composeIntoNewStream.current = false; setNewStreamProjectId(projectId) }), [])
  useEffect(() => paletteEvents.on('open-new-stream-for-task', (projectId) => { composeIntoNewStream.current = true; setNewStreamProjectId(projectId) }), [])
  useEffect(() => paletteEvents.on('open-new-project', () => setNewProjectOpen(true)), [])
  useEffect(() => {
    return window.api.onMenuNewStream(() => {
      if (selectedProjectId) setNewStreamProjectId(selectedProjectId)
    })
  }, [selectedProjectId])
  useEffect(() => window.api.onMenuOpenSettings(() => setSettingsOpen(true)), [])
  useEffect(() => paletteEvents.on('open-settings', () => setSettingsOpen(true)), [])
  useEffect(() => paletteEvents.on('open-settings-tab', (tab) => { setSettingsTab(tab); setSettingsOpen(true) }), [])
  useEffect(() => paletteEvents.on('open-add-server', () => setAddServerOpen(true)), [])

  /**
   * Start a rename: a task is renamed on its own row; a project or stream (no
   * row in the column) gets the rename dialog.
   */
  const beginEdit = useCallback((id: string, name: string, projectId?: string) => {
    const project = projectId ? projectsById.get(projectId) : projectsById.get(id)
    if (project && !projectId) { openEntityDialog({ kind: 'rename', projectId: project.id }); return }
    if (project && project.streams.some(stream => stream.id === id)) {
      openEntityDialog({ kind: 'rename', projectId: project.id, streamId: id })
      return
    }
    setEditingId(id)
    setEditValue(name)
  }, [projectsById])

  /** A project or stream just added, to show once it is in the list: its Project map (and that stream's lane on it). */
  const [pendingHome, setPendingHome] = useState<{ projectId: string; streamId?: string } | null>(null)
  useEffect(() => {
    if (!pendingHome || !projectsById.has(pendingHome.projectId)) return
    setPendingHome(null)
    selectProjectHome(pendingHome.projectId)
    if (pendingHome.streamId) {
      const testId = `map-lane-${pendingHome.streamId}`
      window.setTimeout(() => document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: 'nearest' }), 50)
    }
  }, [pendingHome, projectsById, selectProjectHome])

  /** Where server projects just added show: the first one's Project map. */
  const revealAddedProjects = (created: readonly Project[]) => {
    if (created[0]) setPendingHome({ projectId: created[0].id })
  }

  const findTask = useCallback((projectId: string, taskId: string): Task | undefined =>
    findTaskInProject(projectsById.get(projectId), taskId)
  , [projectsById])

  const handleStreamCreated = (projectId: string, name: string, workspace?: Parameters<typeof addStream>[2], setupPending?: PendingWorktreeSetup) => {
    const stream = addStream(projectId, name, workspace)
    setNewStreamProjectId(null)
    if (workspace && setupPending) openEntityDialog({ kind: 'stream-setup', projectId, streamId: stream.id, branch: workspace.branchName, pending: setupPending })
    // From the same-folder warning: back to the prompt you were writing, now aimed at the new stream.
    if (composeIntoNewStream.current) deskEvents.focusCompose({ projectId, streamId: stream.id })
    else setPendingHome({ projectId, streamId: stream.id })
  }

  /** File what the compose box, the bar or the full form asked for (see `useFileNewTask`). */
  const fileNewTask = useFileNewTask()
  const handleComposedTask = (submission: NewTaskSubmission) => {
    fileNewTask(submission)
    // The form compose's Options… opened took compose's text with it.
    if (newTaskForm?.prompt !== undefined) deskEvents.clearCompose()
    setNewTaskForm(null)
  }

  /** The row menu's Close task (see `useCloseTask`). */
  const handleCloseTask = closeTaskFlow.closeTask
  /** ✓ Done: land without asking, conflicts to the agent (see `useDeskDone`). */
  const handleDeskDone = useDeskDone(closeTaskFlow.closeTask)
  /** The stream menu's Close stream (see `useCloseStream`). */
  const handleCloseStream = closeStreamFlow.closeStream

  const handleRenameSubmit = (projectId: string, taskId: string) => {
    if (editValue.trim()) renameTask(projectId, taskId, editValue.trim())
    setEditingId(null)
  }

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, projectId: string, taskId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'task', projectId, taskId })
  }, [])

  return (
    <>
      <DeskColumn
        projects={inboxProjects}
        composeProjects={orderedProjects}
        pinnedIds={pins.projectIds}
        pinnedTaskIds={pins.taskIds}
        pinnedStreams={pins.streams}
        offlineIds={offlineIds}
        missingDirIds={missingDirs}
        onSelectTask={(projectId, taskId) => {
          const task = findTask(projectId, taskId)
          if (task) handleSelectTask(projectId, task)
        }}
        onTaskContextMenu={handleTaskContextMenu}
        onDone={(projectId, taskId) => handleDeskDone(projectId, taskId)}
        onRemove={(projectId, taskId, confirmed) => closeTaskFlow.removeTask(projectId, taskId, confirmed)}
        onCompose={handleComposedTask}
        footer={[
          { label: '+ New project…', onClick: () => setNewProjectOpen(true) },
          { label: 'Token usage…', onClick: () => paletteEvents.emit('open-token-usage') },
          { label: 'Hosts…', onClick: () => { setSettingsTab('hosts'); setSettingsOpen(true) } },
          { label: 'Settings', onClick: () => { setSettingsTab(null); setSettingsOpen(true) } }
        ]}
        rename={editingId && inboxTaskIds.has(editingId) ? {
          taskId: editingId,
          value: editValue,
          onChange: setEditValue,
          onSubmit: () => {
            const projectId = inboxTaskIds.get(editingId)
            if (projectId) handleRenameSubmit(projectId, editingId)
            else setEditingId(null)
          },
          onCancel: () => setEditingId(null)
        } : null}
      />

      <SidebarContextMenu
        contextMenu={contextMenu}
        missingDirs={missingDirs}
        snoozeSubmenu={snoozeSubmenu}
        setSnoozeSubmenu={setSnoozeSubmenu}
        closeContextMenu={closeContextMenu}
        findTask={findTask}
        handleCloseTask={handleCloseTask}
        handleCloseStream={handleCloseStream}
        beginEdit={beginEdit}
        isPinned={isPinned}
      />

      <ServerNotices onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true) }} />

      {settingsOpen && <Settings key={settingsTab ?? 'default'} initialTab={settingsTab ?? undefined} onClose={() => { setSettingsOpen(false); setSettingsTab(null) }} />}

      {serverProjectOpen && (
        <AddServerProject
          servers={pairedServers}
          initialServerId={serverProjectStart?.serverId}
          initialMode={serverProjectStart?.mode}
          onAddServer={() => { setServerProjectOpen(false); setAddServerOpen(true) }}
          existingDirectories={serverDirectories}
          onAdd={(serverId, items) => {
            const created = addServerProjects(serverId, items)
            setServerProjectOpen(false)
            revealAddedProjects(created)
          }}
          onClose={() => setServerProjectOpen(false)}
        />
      )}

      {addServerOpen && (
        <AddServerDialog
          sshTargets={knownSshTargets(orderedProjects)}
          existingDirectories={serverDirectories}
          onAddProjects={(serverId, items) => {
            revealAddedProjects(addServerProjects(serverId, items))
          }}
          onChooseFolder={(serverId) => {
            setAddServerOpen(false)
            setServerProjectStart({ serverId, mode: 'browse' })
            setServerProjectOpen(true)
          }}
          onClose={() => setAddServerOpen(false)}
        />
      )}

      {newProjectOpen && (
        <DeskNewProject
          hosts={listHosts(orderedProjects, pairedServers, {}, config?.hosts)}
          onAddHost={() => { setNewProjectOpen(false); setSettingsTab('hosts'); setSettingsOpen(true) }}
          onCreate={(host, name, directory) => {
            const project = createProjectOnHost({ addProject, addServerProjects, addRemoteProject, addShellCommandProject }, host, name, directory)
            setNewProjectOpen(false)
            if (project) setPendingHome({ projectId: project.id })
          }}
          onCancel={() => setNewProjectOpen(false)}
        />
      )}

      {newStreamProjectId && (() => {
        const project = projectsById.get(newStreamProjectId)
        if (!project) return null
        return (
          <NewStreamModal
            project={project}
            onCreate={(name, workspace, setupPending) => handleStreamCreated(project.id, name, workspace, setupPending)}
            onClose={() => setNewStreamProjectId(null)}
          />
        )
      })()}

      {closeStreamFlow.dialog}
      {closeTaskFlow.dialog}

      {newTaskForm && config && (
        <NewTaskModal
          projects={orderedProjects}
          defaultProjectId={newTaskForm.projectId ?? selectedProjectId}
          selectedTaskId={selectedTaskId}
          defaultStreamId={newTaskForm.streamId ?? null}
          initialPrompt={newTaskForm.prompt}
          initialImages={newTaskForm.images}
          pickProjectFirst={!newTaskForm.projectId}
          getProjectDir={getProjectDir}
          config={config}
          allTags={tags}
          onEnsureTag={addTag}
          onAddProject={addProject}
          onCreate={handleComposedTask}
          onClose={() => setNewTaskForm(null)}
        />
      )}
    </>
  )
}

