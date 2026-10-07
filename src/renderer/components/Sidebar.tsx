import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince, useTabStatusStore } from '../context/TabStatusContext'
import { NEW_TASK_NAME, isEphemeralProject, isRemoteProject, isShellCommandProject, pinnedItemKey, projectMatchesTagFilter } from '../../shared/types'
import type { Task, Project, PinnedItem, Stream } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import AddShellCommandProject from './AddShellCommandProject'
import AddLocalProject from './AddLocalProject'
import ProjectSettings from './ProjectSettings'
import Settings from './Settings'
import ProjectSwitcher from './ProjectSwitcher'
import ActivityPanel from './ActivityPanel'
import InboxPanel from './InboxPanel'
import NewTaskModal from './NewTaskModal'
import NewStreamModal from './NewStreamModal'
import { terminalTaskName, type NewTaskSubmission } from './newTask'
import { setPendingCommand } from './terminalStartup'
import { createTab } from './newTaskTabs'
import { agentTakesMode, setPendingPrompt, taskNameFromPrompt } from './promptBox'
import { buildRecencyStyle, computeTaskRecencyOpacity, sortTasksByRecency } from './taskRecency'
import { isSettled, isSnoozed, isUnread, taskActivity } from './inbox'
import { useAllAgentActivity } from '../agentActivity'
import { useResizeHandle } from '../hooks/useResizeHandle'
import { ChevronRight, Filter, GitBranch, Plus, Search, Settings as SettingsIcon, Plug, SquarePen, Terminal as TerminalIcon, X, Cog } from 'lucide-react'
import { RowActions, RowAction, menuCls, menuItemCls } from './ui'
import { paletteEvents } from '../palette/paletteEvents'
import { fetchDashboardIconsMetadata, type DashboardIconsMetadata } from './dashboardIcons'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import {
  STREAM_ROW_PL,
  TASK_ROW_ML,
  TASK_ROW_PL,
  ProjectIconSlot,
  SidebarTabButton,
  StateDot,
  headerIconCls,
  type SidebarContextMenuState
} from './sidebar/SidebarParts'
import SidebarContextMenu from './sidebar/SidebarContextMenu'
import { usePinnedDrag, useSidebarTreeDrag } from './sidebar/useSidebarDrag'
import { confirmWorktreeRemoval, forceRemoveWorktree } from './sidebar/workspaceRemoval'
import { streamCloseQuestion, taskCloseQuestion } from './sidebar/closeRules'
import { useWorktreeChoice } from './sidebar/WorktreeChoiceDialog'
import {
  extraTabCount,
  formatActivityAge,
  isQuietStream,
  isStreamExpanded,
  rollUpState,
  sidebarTaskState,
  type SidebarTaskState
} from './sidebar/streamTree'
import { currentStreamId, findStreamOfTask, findTaskInProject, projectTasks, runsInTaskDir, taskTabs } from '../../shared/streams'

/** A pin resolved against the data: its project, and the stream or task it names. */
type ResolvedPin = { item: PinnedItem; key: string; project: Project; stream?: Stream; task?: Task }

/** Where a stream's rows are drawn: the tree drags and drops, the pinned list doesn't. */
type StreamPlace = 'tree' | 'pin'

const inputCls = 'bg-field border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full'

export default function Sidebar({ switcherRequested, onSwitcherConsumed }: { switcherRequested?: boolean; onSwitcherConsumed?: () => void }): React.ReactElement {
  const {
    projects, tags, projectOrder,
    pinnedItems, togglePinnedItem, setPinnedOrder,
    selectedProjectId, selectedTaskId, selectedTagIds,
    switchToTask, selectProjectHome,
    addProject, addRemoteProject, addShellCommandProject, addTag, renameProject, updateProject,
    addTask, addTaskInDirectory, addStream, removeTask, renameTask,
    moveTask, removeStream, renameStream,
    reorderProjects, getProjectDir,
    config, updateConfig,
    toggleTagFilter, clearTagFilters,
    expandedProjectIds, toggleProjectExpansion, setProjectExpanded,
    streamExpansion, setStreamExpanded,
    effectiveTheme,
    sidebarWidth, setSidebarWidth,
    sidebarProjectsCollapsed, toggleSidebarProjectsCollapsed,
    sidebarTab, setSidebarTab,
    settleTask, unsettleTask
  } = useApp()
  const resizeHandle = useResizeHandle({ width: sidebarWidth, onWidthChange: setSidebarWidth, edge: 'right' })
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const tabStatusStore = useTabStatusStore()
  const agentActivities = useAllAgentActivity()
  // Tree rows are one line tall, so what the agent is doing lives in the tooltip.
  const taskTooltip = (task: Task): string | undefined => {
    const { line, tooltip } = taskActivity(task, allStatuses, agentActivities)
    return [line, tooltip].filter(Boolean).join('\n') || undefined
  }

  const [now, setNow] = useState(() => Date.now())
  const sortedByRecency = React.useMemo(
    () => sortTasksByRecency(projects.flatMap(p => projectTasks(p))),
    [projects]
  )

  const inboxActive = sidebarTab === 'inbox'

  // Badge count is what makes the tab worth having: attention is visible without
  // leaving the tree. Snoozed tasks are deliberately excluded — that's the point.
  const inboxUnreadCount = React.useMemo(
    () => projects.reduce((count, project) => count + projectTasks(project).filter(
      task => isUnread(task) && !isSnoozed(task, now) && !isSettled(task)
    ).length, 0),
    [projects, now]
  )

  useEffect(() => {
    // The inbox's wait times, snooze expiry and the tree's "4m" activity ages all
    // read `now`. The inbox ticks faster because "waiting 4m" reads as stale otherwise.
    const id = window.setInterval(() => setNow(Date.now()), inboxActive ? 15_000 : 60_000)
    return () => window.clearInterval(id)
  }, [inboxActive])

  const stateOf = useCallback(
    (task: Task): SidebarTaskState => sidebarTaskState(task, allStatuses, now),
    [allStatuses, now]
  )
  const autoCollapse = config?.autoCollapseQuietStreams ?? true
  const isStreamOpen = useCallback((stream: Stream): boolean => isStreamExpanded({
    override: streamExpansion[stream.id],
    autoCollapse,
    quiet: isQuietStream(stream, stateOf),
    holdsSelection: stream.tasks.some(task => task.id === selectedTaskId)
  }), [streamExpansion, autoCollapse, stateOf, selectedTaskId])

  const handleSelectTask = useCallback((projectId: string, task: Task) => {
    switchToTask(projectId, task.id)
    // Opening the task is the acknowledgement — clear attention on every tab, not
    // just the AI ones. A terminal's attention state otherwise never resets (it
    // only clears on a "ready"-shaped line), which would pin the row in Needs you.
    const tabs = taskTabs(task)
    for (const tab of tabs) {
      if (tabStatusStore.getStatus(tab.id) === 'attention') {
        tabStatusStore.setStatus(tab.id, null)
      }
    }
  }, [switchToTask, tabStatusStore])

  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null)
  // The snooze presets replace the menu body rather than fly out sideways — a
  // nested flyout would run off the edge of a 240px sidebar.
  const [snoozeSubmenu, setSnoozeSubmenu] = useState(false)
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    setSnoozeSubmenu(false)
  }, [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const [shellCommandModalOpen, setShellCommandModalOpen] = useState(false)
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})
  const [iconMetadata, setIconMetadata] = useState<DashboardIconsMetadata | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  // The project the New stream dialog is open for.
  const [newStreamProjectId, setNewStreamProjectId] = useState<string | null>(null)
  const worktreeChoice = useWorktreeChoice()
  const [duplicateProjectId, setDuplicateProjectId] = useState<string | null>(null)
  const [switcherActive, setSwitcherActive] = useState(false)
  const expandedProjects = new Set(expandedProjectIds)
  const projectsById = React.useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  const visibleProjectIds = React.useMemo(() => {
    const filterActive = selectedTagIds.length > 0
    return projectOrder.filter(id => {
      const project = projectsById.get(id)
      if (!project) return false
      return filterActive ? projectMatchesTagFilter(project, selectedTagIds) : true
    })
  }, [projectOrder, projectsById, selectedTagIds])
  // The inbox honours the same tag filter as the tree, so the chips row means the
  // same thing in both tabs. Unlike the tree it *keeps* ad-hoc projects: their
  // tasks are real work, and the inbox is the only place they surface.
  const inboxProjects = React.useMemo(
    () => visibleProjectIds.map(id => projectsById.get(id)).filter((p): p is Project => !!p),
    [visibleProjectIds, projectsById]
  )
  // The tree is the list of projects you chose to have; the hidden ones a task
  // borrowed a directory through don't belong in it.
  const treeProjectIds = React.useMemo(
    () => visibleProjectIds.filter(id => {
      const project = projectsById.get(id)
      return !!project && !isEphemeralProject(project)
    }),
    [visibleProjectIds, projectsById]
  )
  // The composer deliberately ignores the tag filter: filtering the destination
  // list would make projects you can see in the tree un-creatable-in from here.
  // Ad-hoc projects stay out — you reach one again by picking its directory.
  const orderedProjects = React.useMemo(
    () => projectOrder
      .map(id => projectsById.get(id))
      .filter((p): p is Project => !!p && !isEphemeralProject(p)),
    [projectOrder, projectsById]
  )
  const sortedTags = React.useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags]
  )
  // Drop pins whose project/stream/task no longer exists; storage prunes them on the next save.
  const resolvedPins = React.useMemo(() => {
    const resolved: ResolvedPin[] = []
    for (const item of pinnedItems ?? []) {
      const project = projectsById.get(item.projectId)
      if (!project) continue
      if (item.type === 'task') {
        const task = findTaskInProject(project, item.taskId)
        if (!task) continue
        resolved.push({ item, key: pinnedItemKey(item), project, task })
      } else if (item.type === 'stream') {
        const stream = project.streams.find(candidate => candidate.id === item.streamId)
        if (!stream) continue
        resolved.push({ item, key: pinnedItemKey(item), project, stream })
      } else {
        resolved.push({ item, key: pinnedItemKey(item), project })
      }
    }
    return resolved
  }, [pinnedItems, projectsById])
  const isPinned = useCallback((item: PinnedItem) => {
    const key = pinnedItemKey(item)
    return (pinnedItems ?? []).some(candidate => pinnedItemKey(candidate) === key)
  }, [pinnedItems])

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
    let cancelled = false
    fetchDashboardIconsMetadata()
      .then((m) => { if (!cancelled) setIconMetadata(m) })
      .catch(() => { /* CDN unreachable — icons fall back to slug-as-given */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const dismiss = () => { closeContextMenu(); setAddMenuOpen(false); setFilterMenuOpen(false) }
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [closeContextMenu])

  useEffect(() => {
    return window.api.onMenuProjectSwitcher(() => {
      setSwitcherActive(prev => !prev)
    })
  }, [])

  useEffect(() => {
    return window.api.onMenuNewTask(() => {
      setNewTaskOpen(true)
    })
  }, [])

  useEffect(() => {
    return window.api.onMenuNewStream(() => {
      if (selectedProjectId) setNewStreamProjectId(selectedProjectId)
    })
  }, [selectedProjectId])

  useEffect(() => {
    return window.api.onMenuOpenSettings(() => {
      setSettingsOpen(true)
    })
  }, [])

  useEffect(() => {
    return paletteEvents.on('open-settings', () => setSettingsOpen(true))
  }, [])
  useEffect(() => {
    return paletteEvents.on('open-project-settings', () => {
      if (selectedProjectId) setProjectSettingsId(selectedProjectId)
    })
  }, [selectedProjectId])

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

  /**
   * The inline rename input and the "+ Task" affordances only exist in the project
   * tree, so anything that starts an edit has to bring the tree back first —
   * otherwise the inbox swallows it and the action looks like it did nothing.
   * A stream or task being renamed is opened so its row is on screen.
   */
  const beginEdit = useCallback((id: string, name: string, projectId?: string, streamId?: string) => {
    setSidebarTab('projects')
    if (projectId) setProjectExpanded(projectId, true)
    if (streamId) setStreamExpanded(streamId, true)
    setEditingId(id)
    setEditValue(name)
  }, [setSidebarTab, setProjectExpanded, setStreamExpanded])

  const handleAddProject = async () => {
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const name = dir.split('/').pop() || 'Untitled'
    const project = addProject(name, dir)
    // A fresh project has no tasks, so it is invisible in the inbox; expanded in
    // the tree it at least offers "+ Task".
    setProjectExpanded(project.id, true)
    beginEdit(project.id, project.name)
  }

  /**
   * An empty task in `streamId`, or in the project's current stream (the one this
   * window is in, else the one last worked in, else `main`). No inline rename:
   * the task opens on its prompt box, and the first prompt names it.
   */
  const handleAddTask = (projectId: string, streamId?: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    const target = streamId ?? currentStreamId(project, selectedTaskId)
    addTask(projectId, NEW_TASK_NAME, [], target)
    setProjectExpanded(projectId, true)
    if (target) setStreamExpanded(target, true)
  }

  const findTask = useCallback((projectId: string, taskId: string): Task | undefined =>
    findTaskInProject(projects.find(p => p.id === projectId), taskId)
  , [projects])

  /** The row's one-click gesture: settle if it isn't, put it back if it is. */
  const handleToggleSettled = useCallback((projectId: string, taskId: string) => {
    const task = findTask(projectId, taskId)
    if (!task) return
    if (isSettled(task)) unsettleTask(projectId, taskId)
    else settleTask(projectId, taskId)
  }, [findTask, settleTask, unsettleTask])

  const handleNewStream = (projectId: string) => {
    setNewStreamProjectId(projectId)
  }

  const handleStreamCreated = (projectId: string, name: string, workspace?: Parameters<typeof addStream>[2]) => {
    const stream = addStream(projectId, name, workspace)
    setNewStreamProjectId(null)
    setSidebarTab('projects')
    setProjectExpanded(projectId, true)
    setStreamExpanded(stream.id, true)
  }

  /**
   * File what the composer asked for. A task that starts an agent is born with the
   * agent's tab already in it; the tab picks the prompt up on its first spawn.
   */
  const handleComposedTask = ({ target, streamId, start, terminal }: NewTaskSubmission) => {
    let tabs: ReturnType<typeof createTab>[] = []
    let name = NEW_TASK_NAME
    if (terminal) {
      const tab = createTab('terminal')
      if (terminal.command) setPendingCommand(tab.id, terminal.command)
      tabs = [tab]
      name = terminalTaskName(terminal.command)
    } else if (start) {
      const tab = createTab(start.agent)
      setPendingPrompt(tab.id, start.prompt)
      updateConfig({
        promptBoxAgent: start.agent,
        ...(agentTakesMode(start.agent) ? { promptBoxMode: start.prompt.mode ?? '' } : {})
      })
      tabs = [tab]
      name = taskNameFromPrompt(start.prompt.text)
    }
    if (target.kind === 'dir') {
      addTaskInDirectory(target.directory, name, tabs)
    } else {
      addTask(target.projectId, name, tabs, streamId)
      // The task is selected on create; expand its project and stream so switching
      // back to the tree doesn't hide the thing you just made.
      setProjectExpanded(target.projectId, true)
      if (streamId) setStreamExpanded(streamId, true)
    }
    setNewTaskOpen(false)
  }

  const statusOf = useCallback((tabId: string) => tabStatusStore.getStatus(tabId), [tabStatusStore])

  /**
   * Run the stream-level worktree pre-flight, then `close` (which ends the tabs),
   * then the forced removal. Resolves false when cancelled.
   */
  const closeWithWorktree = async (
    project: Project,
    stream: Stream,
    close: () => Promise<boolean>
  ): Promise<boolean> => {
    const workspace = stream.workspace
    if (!workspace) return close()
    const answer = await confirmWorktreeRemoval(project, stream.name, workspace, worktreeChoice.ask)
    if (!answer) return false
    if (!await close()) return false
    if (!answer.done) await forceRemoveWorktree(project, workspace, answer.keepBranch)
    return true
  }

  /**
   * Hover ✕ on a task row: the task closes (step 7 turns it into archive). Asks
   * only when its agent is working (unsaved editors ask in `removeTask`). Its
   * stream stays, even emptied.
   */
  const handleCloseTask = async (projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return
    const question = taskCloseQuestion(task, statusOf)
    if (question && !window.confirm(question)) return
    // The last task of a hidden ad-hoc project takes the project with it, and any
    // worktree stream it still has: that gets the stream's pre-flight first.
    const retiring = isEphemeralProject(project) && projectTasks(project).every(candidate => candidate.id === taskId)
    const worktrees = retiring ? project.streams.filter(stream => stream.workspace) : []
    if (worktrees.length === 0) {
      void removeTask(projectId, taskId)
      return
    }
    const answers = []
    for (const stream of worktrees) {
      const answer = await confirmWorktreeRemoval(project, stream.name, stream.workspace!, worktreeChoice.ask)
      if (!answer) return
      answers.push({ stream, answer })
    }
    if (!await removeTask(projectId, taskId)) return
    for (const { stream, answer } of answers) {
      if (!answer.done) await forceRemoveWorktree(project, stream.workspace!, answer.keepBranch)
    }
  }

  /**
   * Hover ✕ on a stream row (never `main`): its tasks close and the stream goes
   * (step 7: archive). Asks when a task is working (unsaved editors ask in
   * `removeStream`); a worktree runs the pre-flight: clean and merged goes
   * quietly, anything else asks keep branch / discard / cancel.
   */
  const handleCloseStream = async (projectId: string, streamId: string) => {
    const project = projects.find(p => p.id === projectId)
    const stream = project?.streams.find(candidate => candidate.id === streamId)
    if (!project || !stream || stream.isMain) return
    const question = streamCloseQuestion(stream, statusOf)
    if (question && !window.confirm(question)) return
    // Tabs close before the forced removal, so no process holds the worktree.
    await closeWithWorktree(project, stream, () => removeStream(projectId, streamId, true))
  }

  /**
   * A task dropped into a place in the tree. Into a stream with another folder,
   * it asks first: the task's agent and terminals start again over there.
   */
  const handleMoveTask = useCallback((projectId: string, taskId: string, toStreamId: string, toIndex: number) => {
    const project = projects.find(p => p.id === projectId)
    const from = project?.streams.find(stream => stream.tasks.some(task => task.id === taskId))
    const to = project?.streams.find(stream => stream.id === toStreamId)
    const task = findTaskInProject(project, taskId)
    if (!project || !from || !to || !task) return
    const folder = (stream: Stream) => stream.workspace?.worktreePath ?? null
    const restart = from !== to && folder(from) !== folder(to)
    if (restart) {
      const where = to.workspace ? `the ${to.workspace.branchName} worktree` : 'the project folder'
      const lines = [`Move "${task.name}" to ${to.name}?`, `It will work in ${where}.`]
      if (taskTabs(task).some(runsInTaskDir)) lines.push('Its agent and terminals restart there.')
      if (!window.confirm(lines.join('\n\n'))) return
    }
    void moveTask(projectId, taskId, toStreamId, toIndex, { restart })
  }, [projects, moveTask])

  const handleRenameSubmit = (type: 'project' | 'stream' | 'task', projectId: string, id?: string) => {
    if (!editValue.trim()) {
      setEditingId(null)
      return
    }
    if (type === 'project') {
      renameProject(projectId, editValue.trim())
    } else if (type === 'stream' && id) {
      renameStream(projectId, id, editValue.trim())
    } else if (id) {
      renameTask(projectId, id, editValue.trim())
    }
    setEditingId(null)
  }

  const handleContextMenu = (
    e: React.MouseEvent, type: 'project' | 'stream' | 'task', projectId: string, id?: string
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type,
      projectId,
      ...(type === 'stream' ? { streamId: id } : type === 'task' ? { taskId: id } : {})
    })
  }

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, projectId: string, taskId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'task', projectId, taskId })
  }, [])

  const { dragState, dropTarget, handleDragMouseDown } = useSidebarTreeDrag({
    editingId, projectOrder, treeProjectIds, moveTask: handleMoveTask, reorderProjects
  })

  const [expandedPinnedProjectIds, setExpandedPinnedProjectIds] = useState<string[]>([])
  const togglePinnedProjectExpansion = useCallback((projectId: string) => {
    setExpandedPinnedProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
    )
  }, [])
  // A pinned stream shows its tasks; its chevron folds them in the pinned list only.
  const [collapsedPinnedStreamKeys, setCollapsedPinnedStreamKeys] = useState<string[]>([])
  const togglePinnedStream = useCallback((key: string) => {
    setCollapsedPinnedStreamKeys(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))
  }, [])

  const { pinDragIndex, pinDropIndex, handlePinMouseDown } = usePinnedDrag(resolvedPins, setPinnedOrder)

  /** The "+ Task  + Stream" row closing an expanded project, in the tree or under a pin. */
  const renderAddTaskRow = (project: Project, indentCls: string = STREAM_ROW_PL) => (
    <div className={`flex items-center gap-0.5 flex-wrap mx-1.5 ${indentCls} pr-2 py-0.5`}>
      <button
        className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] text-xs whitespace-nowrap shrink-0 transition-colors duration-(--motion-fast)"
        onClick={() => handleAddTask(project.id)}
      >
        <Plus size={12} className="inline mr-0.5" /> Task
      </button>
      <button
        className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] text-xs whitespace-nowrap shrink-0 transition-colors duration-(--motion-fast)"
        onClick={() => handleNewStream(project.id)}
      >
        <Plus size={12} className="inline mr-0.5" /> Stream
      </button>
    </div>
  )

  const dropLine = <div className={`h-0.5 bg-accent mr-2 rounded-sm ${TASK_ROW_ML}`} />

  /**
   * One task row: state dot, name, `+N` extra tabs, last activity (hover swaps
   * it for ✕). In the tree it is also a drag handle.
   */
  const renderTaskRow = (project: Project, stream: Stream, task: Task, index: number, place: StreamPlace) => {
    const isSelected = selectedTaskId === task.id
    const opacity = !isSelected && config?.taskRecencyHighlight
      ? computeTaskRecencyOpacity(task, sortedByRecency, config.taskRecencyHighlight, now)
      : 0
    const recencyStyle = buildRecencyStyle(opacity, effectiveTheme)
    const inTree = place === 'tree'
    const isTaskDragging = inTree && dragState?.type === 'task' && dragState.id === task.id
    const state = stateOf(task)
    const extra = extraTabCount(task)
    const age = state === 'working' ? 'working' : formatActivityAge(task, now)
    return (
      <div
        key={task.id}
        className={[
          'group flex items-center gap-2 mx-1.5 px-2.5 h-6 rounded-md text-sm text-text cursor-pointer',
          TASK_ROW_PL,
          inTree ? 'task-item' : '',
          'transition-colors duration-(--motion-fast)',
          isSelected ? 'bg-sel' : 'hover:bg-surface-3',
          isTaskDragging ? 'opacity-40' : '',
        ].join(' ')}
        {...(inTree ? { 'data-tree-row': 'task' } : {})}
        data-task-id={task.id}
        data-stream-id={stream.id}
        data-task-index={index}
        title={editingId === task.id ? undefined : taskTooltip(task)}
        style={recencyStyle}
        onClick={() => handleSelectTask(project.id, task)}
        onMouseDown={inTree ? (e) => handleDragMouseDown(e, 'task', task.id, index, project.id, stream.id) : undefined}
        onContextMenu={(e) => handleContextMenu(e, 'task', project.id, task.id)}
      >
        <StateDot state={state} hollow />
        {editingId === task.id ? (
          <input
            ref={editRef}
            className={inputCls}
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
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{task.name}</span>
            {extra > 0 && (
              <span className="text-2xs font-mono text-text-subtle shrink-0" title={extra === 1 ? '1 more tab' : `${extra} more tabs`}>+{extra}</span>
            )}
            <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
              {age && <span className="text-xs text-text-subtle tabular-nums group-hover:hidden">{age}</span>}
              <RowActions>
                <RowAction danger title="Close task" onClick={() => void handleCloseTask(project.id, task.id)}>
                  <X size={13} />
                </RowAction>
              </RowActions>
            </span>
          </>
        )}
      </div>
    )
  }

  /** A stream's tasks, with the tree's drop line between them while a task is dragged. */
  const renderStreamTasks = (project: Project, stream: Stream, place: StreamPlace) => {
    const slot = place === 'tree' && dropTarget?.type === 'task-slot'
      && dropTarget.projectId === project.id && dropTarget.streamId === stream.id && !dropTarget.onStreamRow
      ? dropTarget
      : null
    return (
      <>
        {stream.tasks.map((task, index) => (
          <React.Fragment key={task.id}>
            {slot?.index === index && dropLine}
            {renderTaskRow(project, stream, task, index, place)}
          </React.Fragment>
        ))}
        {slot?.index === stream.tasks.length && dropLine}
        {/* Step 7: the stream's collapsed "Done (N)" row (archived tasks) goes here. */}
      </>
    )
  }

  /**
   * A stream row (name, `⎇ branch` for a worktree, rolled-up state, task count
   * when folded) and, when open, its tasks. The chevron or a click on the row
   * opens and closes it.
   */
  const renderStream = (project: Project, stream: Stream) => {
    const open = isStreamOpen(stream)
    const rolled = rollUpState(stream.tasks.map(stateOf))
    const isDropTarget = dropTarget?.type === 'task-slot' && dropTarget.projectId === project.id
      && dropTarget.streamId === stream.id && dropTarget.onStreamRow
    const removable = !stream.isMain
    return (
      <React.Fragment key={stream.id}>
        <div
          className={[
            'group flex items-center gap-2 mx-1.5 px-2.5 h-6 rounded-md text-sm text-text cursor-pointer',
            STREAM_ROW_PL,
            'transition-colors duration-(--motion-fast)',
            isDropTarget ? 'bg-sel shadow-focus' : 'hover:bg-surface-3',
          ].join(' ')}
          data-tree-row="stream"
          data-stream-id={stream.id}
          data-task-count={stream.tasks.length}
          title={stream.workspace ? `${stream.name} · ${stream.workspace.branchName}` : stream.name}
          onClick={() => { if (editingId !== stream.id) setStreamExpanded(stream.id, !open) }}
          onContextMenu={(e) => handleContextMenu(e, 'stream', project.id, stream.id)}
        >
          <ChevronRight size={12} className={`shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
          {editingId === stream.id ? (
            <input
              ref={editRef}
              className={inputCls}
              value={editValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => handleRenameSubmit('stream', project.id, stream.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit('stream', project.id, stream.id)
                if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-text-muted">{stream.name}</span>
              {stream.workspace && (
                <span className="text-2xs font-mono text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap min-w-0">⎇ {stream.workspace.branchName}</span>
              )}
              <span className="ml-auto flex items-center gap-1.5 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                <StateDot state={rolled} hideOnHover />
                {!open && (
                  <span className="text-xs text-text-subtle tabular-nums group-hover:hidden">{stream.tasks.length}</span>
                )}
                <RowActions>
                  <RowAction title={`New task in ${stream.name}`} onClick={() => handleAddTask(project.id, stream.id)}>
                    <Plus size={13} />
                  </RowAction>
                  {removable && (
                    <RowAction danger title="Close stream" onClick={() => void handleCloseStream(project.id, stream.id)}>
                      <X size={13} />
                    </RowAction>
                  )}
                </RowActions>
              </span>
            </>
          )}
        </div>
        {open && renderStreamTasks(project, stream, 'tree')}
      </React.Fragment>
    )
  }

  const renderProject = (project: Project) => {
    const isExpanded = expandedProjects.has(project.id)
    // Project Home lives on the project row itself, so the row needs the
    // selection rail whenever Home is showing — even when the project is expanded.
    const isHomeSelected = selectedProjectId === project.id
      && !projectTasks(project).some(t => t.id === selectedTaskId)
    const isProjectSelected = selectedProjectId === project.id && (!isExpanded || isHomeSelected)
    const isProjectDragging = dragState?.type === 'project' && dragState.id === project.id
    return (
    <div className="sidebar-project" key={project.id} data-project-id={project.id}>
      <div
        className={[
          'group flex items-center gap-2 mx-1.5 px-2.5 h-7 rounded-md text-base text-text cursor-pointer',
          'transition-colors duration-(--motion-fast)',
          isProjectSelected ? 'bg-sel' : 'hover:bg-surface-3',
          isProjectDragging ? 'opacity-40' : '',
        ].join(' ')}
        data-drag-type="project"
        data-drag-id={project.id}
        onClick={() => { selectProjectHome(project.id) }}
        onContextMenu={(e) => handleContextMenu(e, 'project', project.id)}
        onMouseDown={(e) => {
          const index = projectOrder.indexOf(project.id)
          handleDragMouseDown(e, 'project', project.id, index)
        }}
      >
        {editingId === project.id ? (
          <input
            ref={editRef}
            className={inputCls}
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
            <button
              className="text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer p-0 flex items-center shrink-0"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggleProjectExpansion(project.id) }}
            >
              <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${isExpanded ? 'rotate-90' : ''}`} />
            </button>
            <ProjectIconSlot project={project} theme={effectiveTheme} metadata={iconMetadata} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">{project.name}</span>
            {isRemoteProject(project) && (
              <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">
                <Plug size={10} className="inline mr-0.5" />ssh
              </span>
            )}
            {isShellCommandProject(project) && (
              <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">
                <TerminalIcon size={10} className="inline mr-0.5" />shell
              </span>
            )}
            {isRemoteProject(project) && (() => {
              const sshStatus = sshStatuses[project.id] || 'disconnected'
              const dotClass = sshStatus === 'connected'
                ? 'bg-ssh-connected'
                : sshStatus === 'connecting'
                ? 'bg-ssh-connecting status-pulse'
                : 'bg-ssh-disconnected'
              return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${dotClass}`} />
            })()}
            <span className="ml-auto flex items-center gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
              {!isExpanded && <StateDot state={rollUpState(projectTasks(project).map(stateOf))} hideOnHover />}
              <RowActions>
                <RowAction title="New task" onClick={() => handleAddTask(project.id)}>
                  <Plus size={13} />
                </RowAction>
                <RowAction title="Project settings" onClick={() => setProjectSettingsId(project.id)}>
                  <Cog size={13} />
                </RowAction>
              </RowActions>
            </span>
          </>
        )}
      </div>

      {isExpanded && (
        <div className="pb-1">
          {project.streams.map(stream => renderStream(project, stream))}
          {/* Step 7: the project's "Done" group (archived streams) goes here. */}
          {renderAddTaskRow(project)}
        </div>
      )}
    </div>
    )
  }

  /** A pinned project unfolded: its streams, read-only (no drag), like the tree. */
  const renderPinnedProjectStreams = (project: Project) => project.streams.map(stream => {
    const open = isStreamOpen(stream)
    const rolled = rollUpState(stream.tasks.map(stateOf))
    return (
      <React.Fragment key={stream.id}>
        <div
          className={`group flex items-center gap-2 mx-1.5 px-2.5 ${STREAM_ROW_PL} h-6 rounded-md text-sm text-text cursor-pointer hover:bg-surface-3 transition-colors duration-(--motion-fast)`}
          onClick={() => setStreamExpanded(stream.id, !open)}
          onContextMenu={(e) => handleContextMenu(e, 'stream', project.id, stream.id)}
        >
          <ChevronRight size={12} className={`shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-text-muted">{stream.name}</span>
          {stream.workspace && (
            <span className="text-2xs font-mono text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap min-w-0">⎇ {stream.workspace.branchName}</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
            <StateDot state={rolled} hideOnHover />
            {!open && <span className="text-xs text-text-subtle tabular-nums group-hover:hidden">{stream.tasks.length}</span>}
            <RowActions>
              <RowAction title={`New task in ${stream.name}`} onClick={() => handleAddTask(project.id, stream.id)}>
                <Plus size={13} />
              </RowAction>
            </RowActions>
          </span>
        </div>
        {open && renderStreamTasks(project, stream, 'pin')}
      </React.Fragment>
    )
  })

  const renderPin = (pin: ResolvedPin, index: number) => {
    const { item, project, stream, task } = pin
    const isProjectPin = item.type === 'project'
    const isSelected = task
      ? selectedTaskId === task.id
      : stream
        ? false
        : selectedProjectId === project.id && !projectTasks(project).some(t => t.id === selectedTaskId)
    const isDraggingPin = pinDragIndex === index
    const isOpen = isProjectPin
      ? expandedPinnedProjectIds.includes(project.id)
      : !!stream && !collapsedPinnedStreamKeys.includes(pin.key)
    const rolled = task
      ? stateOf(task)
      : rollUpState((stream ? stream.tasks : projectTasks(project)).map(stateOf))
    const extra = task ? extraTabCount(task) : 0
    const toggleOpen = () => {
      if (isProjectPin) togglePinnedProjectExpansion(project.id)
      else togglePinnedStream(pin.key)
    }
    return (
      <React.Fragment key={pin.key}>
        {pinDropIndex === index && <div className="h-0.5 bg-accent mx-2 rounded-sm" />}
        <div
          className={[
            'group flex items-center gap-2 mx-1.5 px-2.5 h-6 rounded-md text-sm text-text cursor-pointer',
            'transition-colors duration-(--motion-fast)',
            isSelected ? 'bg-sel' : 'hover:bg-surface-3',
            isDraggingPin ? 'opacity-40' : '',
          ].join(' ')}
          data-pin-key={pin.key}
          data-pin-index={index}
          title={task ? taskTooltip(task) : stream?.workspace ? `${stream.name} · ${stream.workspace.branchName}` : undefined}
          onClick={() => {
            if (task) handleSelectTask(project.id, task)
            else if (stream) toggleOpen()
            else selectProjectHome(project.id)
          }}
          onMouseDown={(e) => handlePinMouseDown(e, pin.key, index)}
          onContextMenu={(e) => handleContextMenu(
            e,
            item.type,
            project.id,
            task ? task.id : stream ? stream.id : undefined
          )}
        >
          {task ? (
            <span className="w-3 shrink-0" />
          ) : (
            <button
              className="text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer p-0 flex items-center shrink-0"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggleOpen() }}
            >
              <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${isOpen ? 'rotate-90' : ''}`} />
            </button>
          )}
          <ProjectIconSlot project={project} theme={effectiveTheme} metadata={iconMetadata} />
          {isProjectPin ? (
            <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">{project.name}</span>
          ) : (
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              <span className="text-text-muted">{project.name}</span>
              <span className="text-text-subtle mx-1">›</span>
              {task ? task.name : <span className="font-mono">{stream!.name}</span>}
            </span>
          )}
          {extra > 0 && <span className="text-2xs font-mono text-text-subtle shrink-0">+{extra}</span>}
          {/* Pins are the one place a hidden ad-hoc project reaches the tree. */}
          {isEphemeralProject(project) && (
            <span
              className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0"
              title={project.directory}
            >dir</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
            <StateDot state={rolled} hideOnHover />
            {stream && !isOpen && (
              <span className="text-xs text-text-subtle tabular-nums group-hover:hidden">{stream.tasks.length}</span>
            )}
            <RowActions>
              {/* A task pin adds a sibling in its stream; a stream pin, a task in it. */}
              {(() => {
                const pinStream = stream ?? (task ? findStreamOfTask(project, task.id) : undefined)
                return (
                  <RowAction
                    title={pinStream ? `New task in ${pinStream.name}` : 'New task'}
                    onClick={() => handleAddTask(project.id, pinStream?.id)}
                  >
                    <Plus size={13} />
                  </RowAction>
                )
              })()}
              {isProjectPin && (
                <RowAction title="New stream" onClick={() => handleNewStream(project.id)}>
                  <GitBranch size={13} />
                </RowAction>
              )}
              <RowAction title="Unpin" onClick={() => togglePinnedItem(item)}>
                <X size={13} />
              </RowAction>
            </RowActions>
          </span>
        </div>
        {isProjectPin && isOpen && (
          <>
            {renderPinnedProjectStreams(project)}
            {renderAddTaskRow(project)}
          </>
        )}
        {stream && isOpen && renderStreamTasks(project, stream, 'pin')}
      </React.Fragment>
    )
  }

  return (
    <div
      className="sidebar relative flex flex-col bg-surface border-r-[0.5px] border-border select-none [--recency-rgb:199,146,87] [.theme-light_&]:[--recency-rgb:154,98,48]"
      style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
    >
      <ProjectSwitcher
        projects={projects}
        selectProjectHome={selectProjectHome}
        switchToTask={switchToTask}
        isActive={switcherActive}
        onDeactivate={() => setSwitcherActive(false)}
      />

      {switcherActive ? null : (<>
      <div className="h-9 shrink-0 [-webkit-app-region:drag]" />

      {resolvedPins.length > 0 && (
        <div className="pb-1 [-webkit-app-region:no-drag]">
          <div className="px-3 pb-1 text-2xs font-bold uppercase tracking-[0.06em] text-text-muted">Pinned</div>
          <div className="sidebar-pinned-list">
            {resolvedPins.map(renderPin)}
            {pinDropIndex === resolvedPins.length && <div className="h-0.5 bg-accent mx-2 rounded-sm" />}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-3 pt-1 pb-2 [-webkit-app-region:drag]">
        <div className="flex items-center gap-1.5 min-w-0 [-webkit-app-region:no-drag]" onMouseDown={(e) => e.stopPropagation()}>
          <SidebarTabButton
            label="Projects"
            active={sidebarTab === 'projects'}
            onClick={() => setSidebarTab('projects')}
          />
          <SidebarTabButton
            label="Inbox"
            active={inboxActive}
            badge={inboxUnreadCount}
            onClick={() => setSidebarTab('inbox')}
          />
          <button
            className="flex items-center bg-transparent border-0 p-0 cursor-pointer text-text-subtle hover:text-text transition-colors duration-(--motion-fast)"
            onClick={toggleSidebarProjectsCollapsed}
            title={sidebarProjectsCollapsed ? 'Show list' : 'Hide list'}
          >
            <ChevronRight
              size={11}
              className={`transition-transform duration-(--motion-fast) ${sidebarProjectsCollapsed ? '' : 'rotate-90'}`}
            />
          </button>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 [-webkit-app-region:no-drag]" onMouseDown={(e) => e.stopPropagation()}>
          {inboxActive && (
            <button
              className={headerIconCls}
              onClick={() => setNewTaskOpen(true)}
              title="New task"
            ><SquarePen size={14} /></button>
          )}
          <button
            className={headerIconCls}
            onClick={() => setSwitcherActive(true)}
            title={`Quick switch (${formatShortcutForApp('CmdOrCtrl+P')})`}
          ><Search size={14} /></button>
          {sortedTags.length > 0 && (
            <div className="relative">
              <button
                className={`${headerIconCls} ${selectedTagIds.length > 0 ? 'text-accent' : ''}`}
                onClick={(e) => { e.stopPropagation(); setFilterMenuOpen(!filterMenuOpen); setAddMenuOpen(false) }}
                title={selectedTagIds.length > 0 ? `Filtered by ${selectedTagIds.length} tag(s)` : 'Filter by tag'}
              >
                <Filter size={14} />
                {selectedTagIds.length > 0 && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
                )}
              </button>
              {filterMenuOpen && (
                <div
                  className={`absolute top-full right-0 mt-1 z-(--z-menu) w-[200px] ${menuCls}`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="flex flex-wrap gap-1 p-1">
                    {sortedTags.map(tag => {
                      const isSelected = selectedTagIds.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTagFilter(tag.id)}
                          className={[
                            'px-2 py-0.5 rounded-full text-xs border cursor-pointer transition-colors duration-(--motion-fast)',
                            isSelected
                              ? 'bg-sel border-transparent text-text'
                              : 'bg-field border-border text-text-muted hover:text-text hover:bg-surface-3',
                          ].join(' ')}
                        >
                          {tag.name}
                        </button>
                      )
                    })}
                  </div>
                  {selectedTagIds.length > 0 && (
                    <div className="border-t border-hair mt-1 pt-1">
                      <button className={menuItemCls} onClick={() => clearTagFilters()}>Clear filter</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="relative">
            <button
              className={headerIconCls}
              onClick={(e) => { e.stopPropagation(); setAddMenuOpen(!addMenuOpen); setFilterMenuOpen(false) }}
              title="Add"
            ><Plus size={14} /></button>
            {addMenuOpen && (
              <div className={`absolute top-full right-0 mt-1 z-(--z-menu) whitespace-nowrap ${menuCls}`} onMouseDown={(e) => e.stopPropagation()}>
                <button className={menuItemCls} onClick={() => { setAddMenuOpen(false); setNewTaskOpen(true) }}>New task</button>
                <div className="border-t border-hair mt-1 pt-1">
                  <button className={menuItemCls} onClick={() => { setAddMenuOpen(false); handleAddProject() }}>Local project</button>
                  <button className={menuItemCls} onClick={() => { setAddMenuOpen(false); setRemoteModalOpen(true) }}>Remote project (SSH)</button>
                  <button className={menuItemCls} onClick={() => { setAddMenuOpen(false); setShellCommandModalOpen(true) }}>Custom shell</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {sidebarProjectsCollapsed ? (
        <div className="flex-1" />
      ) : (<>
      {inboxActive ? (
        <InboxPanel
          projects={inboxProjects}
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
          onTaskContextMenu={handleTaskContextMenu}
          onSettle={handleToggleSettled}
          onNewTask={() => setNewTaskOpen(true)}
          allStatuses={allStatuses}
          statusSince={statusSince}
          activities={agentActivities}
          now={now}
          workingLast={config?.inboxWorkingLast ?? false}
        />
      ) : (
      <div className="sidebar-list flex-1 overflow-y-auto py-1">
        {treeProjectIds.map((projectId, listIdx) => {
          const project = projectsById.get(projectId)
          if (!project) return null
          return (
            <React.Fragment key={project.id}>
              {dropTarget?.type === 'between-projects' && dropTarget.index === listIdx && (
                <div className="h-0.5 bg-accent mx-2 rounded-sm" />
              )}
              {renderProject(project)}
            </React.Fragment>
          )
        })}
        {dropTarget?.type === 'between-projects' && dropTarget.index === treeProjectIds.length && (
          <div className="h-0.5 bg-accent mx-2 rounded-sm" />
        )}
      </div>
      )}
      </>)}

      {config?.activityPanel?.enabled && (
        <ActivityPanel
          projects={projects}
          selectedTaskId={selectedTaskId}
          switchToTask={switchToTask}
          onTaskContextMenu={handleTaskContextMenu}
          recencySettings={config.taskRecencyHighlight}
          now={now}
          heightPx={config.activityPanel.heightPx}
          onHeightChange={(next) => updateConfig({
            activityPanel: { ...config.activityPanel, heightPx: next }
          })}
          allStatuses={allStatuses}
          theme={effectiveTheme}
        />
      )}
      </>)}

      <SidebarContextMenu
        contextMenu={contextMenu}
        snoozeSubmenu={snoozeSubmenu}
        setSnoozeSubmenu={setSnoozeSubmenu}
        closeContextMenu={closeContextMenu}
        setContextMenu={setContextMenu}
        findTask={findTask}
        handleToggleSettled={handleToggleSettled}
        handleCloseTask={handleCloseTask}
        handleCloseStream={handleCloseStream}
        beginEdit={beginEdit}
        isPinned={isPinned}
        setDuplicateProjectId={setDuplicateProjectId}
        setProjectSettingsId={setProjectSettingsId}
        onAddTask={handleAddTask}
        onNewStream={handleNewStream}
      />

      <div className="px-3 py-2 border-t border-hair">
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] text-base transition-colors duration-(--motion-fast)" onClick={() => setSettingsOpen(true)} title="Settings"><SettingsIcon size={16} /></button>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {remoteModalOpen && (
        <AddRemoteProject
          allTags={tags}
          onEnsureTag={addTag}
          onAdd={(name, ssh, aiToolArgs, tagIds) => {
            addRemoteProject(name, ssh, aiToolArgs, tagIds)
            setRemoteModalOpen(false)
          }}
          onCancel={() => setRemoteModalOpen(false)}
        />
      )}

      {shellCommandModalOpen && (
        <AddShellCommandProject
          allTags={tags}
          onEnsureTag={addTag}
          onAdd={(name, command, tagIds) => {
            addShellCommandProject(name, command, tagIds)
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
            onSave={(payload) => updateProject(projectSettingsId, payload)}
            onClose={() => setProjectSettingsId(null)}
          />
        )
      })()}

      {duplicateProjectId && (() => {
        const project = projects.find(p => p.id === duplicateProjectId)
        if (!project) return null
        if (isRemoteProject(project)) {
          return (
            <AddRemoteProject
              allTags={tags}
              onEnsureTag={addTag}
              initialValues={{
                host: project.ssh!.host,
                port: project.ssh!.port,
                username: project.ssh!.username,
                keyFile: project.ssh!.keyFile,
                remoteDir: project.ssh!.remoteDir,
                aiToolArgs: project.aiToolArgs
              }}
              onAdd={(name, ssh, aiToolArgs, tagIds) => {
                addRemoteProject(name, ssh, aiToolArgs, tagIds)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        if (isShellCommandProject(project)) {
          return (
            <AddShellCommandProject
              allTags={tags}
              onEnsureTag={addTag}
              initialValues={{
                name: project.name,
                command: project.shellCommand!.command
              }}
              onAdd={(name, command, tagIds) => {
                addShellCommandProject(name, command, tagIds)
                setDuplicateProjectId(null)
              }}
              onCancel={() => setDuplicateProjectId(null)}
            />
          )
        }
        return (
          <AddLocalProject
            allTags={tags}
            onEnsureTag={addTag}
            initialValues={{
              name: project.name,
              directory: project.directory
            }}
            onAdd={(name, directory, tagIds) => {
              addProject(name, directory, tagIds)
              setDuplicateProjectId(null)
            }}
            onCancel={() => setDuplicateProjectId(null)}
          />
        )
      })()}

      {newStreamProjectId && (() => {
        const project = projects.find(p => p.id === newStreamProjectId)
        if (!project) return null
        return (
          <NewStreamModal
            project={project}
            onCreate={(name, workspace) => handleStreamCreated(project.id, name, workspace)}
            onClose={() => setNewStreamProjectId(null)}
          />
        )
      })()}

      {worktreeChoice.dialog}

      {newTaskOpen && config && (
        <NewTaskModal
          projects={orderedProjects}
          defaultProjectId={selectedProjectId}
          selectedTaskId={selectedTaskId}
          getProjectDir={getProjectDir}
          config={config}
          allTags={tags}
          onEnsureTag={addTag}
          onAddProject={addProject}
          onCreate={handleComposedTask}
          onClose={() => setNewTaskOpen(false)}
        />
      )}

      <div
        className="absolute right-0 top-0 bottom-0 w-[3px] cursor-col-resize hover:bg-accent active:bg-accent transition-colors duration-(--motion-fast) [-webkit-app-region:no-drag]"
        onMouseDown={resizeHandle.onMouseDown}
      />
    </div>
  )
}
