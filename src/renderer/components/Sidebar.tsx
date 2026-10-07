import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince, useTabStatusStore } from '../context/TabStatusContext'
import { NEW_TASK_NAME, isEphemeralProject, isHomeTask, isRemoteProject, isShellCommandProject, pinnedItemKey, projectMatchesTagFilter } from '../../shared/types'
import type { Task, Project, PinnedItem, WorkspaceDeleteResult } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import AddShellCommandProject from './AddShellCommandProject'
import AddLocalProject from './AddLocalProject'
import ProjectSettings from './ProjectSettings'
import Settings from './Settings'
import ProjectSwitcher from './ProjectSwitcher'
import ActivityPanel from './ActivityPanel'
import InboxPanel from './InboxPanel'
import NewTaskModal from './NewTaskModal'
import type { NewTaskSubmission } from './newTask'
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
  TASK_ROW_ML,
  TASK_ROW_PL,
  ProjectIconSlot,
  SidebarTabButton,
  TaskStatusDot,
  getProjectStatus,
  headerIconCls,
  type SidebarContextMenuState
} from './sidebar/SidebarParts'
import SidebarContextMenu from './sidebar/SidebarContextMenu'
import { usePinnedDrag, useSidebarTreeDrag } from './sidebar/useSidebarDrag'
import { findStreamOfTask, findTaskInProject, projectTasks, taskTabs, taskWorkspace, workspaceReleasedBy } from '../../shared/streams'

/**
 * TEMPORARY (step 5 replaces the tree with Project › Stream › Task): the tree
 * lists every task flat, so a task outside `main` names its stream next to it.
 */
function StreamChip({ project, taskId }: { project: Project; taskId: string }): React.ReactElement | null {
  const stream = findStreamOfTask(project, taskId)
  if (!stream || stream.isMain) return null
  const task = stream.tasks.find(t => t.id === taskId)
  if (stream.tasks.length === 1 && task?.name === stream.name) return null
  return (
    <span className="text-2xs px-1 py-px rounded-sm text-text-subtle ml-1.5 shrink-0 max-w-[90px] overflow-hidden text-ellipsis whitespace-nowrap" title={`Stream: ${stream.name}`}>
      {stream.name}
    </span>
  )
}

export default function Sidebar({ switcherRequested, onSwitcherConsumed }: { switcherRequested?: boolean; onSwitcherConsumed?: () => void }): React.ReactElement {
  const {
    projects, tags, projectOrder,
    pinnedItems, togglePinnedItem, setPinnedOrder,
    selectedProjectId, selectedTaskId, selectedTagIds,
    switchToTask, selectProjectHome,
    addProject, addRemoteProject, addShellCommandProject, addTag, renameProject, updateProject,
    addTask, addWorkspaceTask, addTaskInDirectory, addPendingWorkspaceTask, removeTask, renameTask,
    reorderProjects, reorderTasks, getProjectDir,
    config, updateConfig,
    toggleTagFilter, clearTagFilters,
    expandedProjectIds, toggleProjectExpansion, setProjectExpanded,
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
    () => sortTasksByRecency(projects.flatMap(p => projectTasks(p).filter(t => !isHomeTask(t)))),
    [projects]
  )

  const inboxActive = sidebarTab === 'inbox'

  // Badge count is what makes the tab worth having: attention is visible without
  // leaving the tree. Snoozed tasks are deliberately excluded — that's the point.
  const inboxUnreadCount = React.useMemo(
    () => projects.reduce((count, project) => count + projectTasks(project).filter(
      task => !isHomeTask(task) && isUnread(task) && !isSnoozed(task, now) && !isSettled(task)
    ).length, 0),
    [projects, now]
  )

  useEffect(() => {
    // The inbox needs the clock regardless of the recency-highlight setting: wait
    // times and snooze expiry are both computed against `now`. It ticks faster than
    // the highlight's 60s because "waiting 4m" reads as stale otherwise.
    const timeHighlight = config?.taskRecencyHighlight?.enabled && config.taskRecencyHighlight.mode === 'time'
    if (!inboxActive && !timeHighlight) return
    const id = window.setInterval(() => setNow(Date.now()), inboxActive ? 15_000 : 60_000)
    return () => window.clearInterval(id)
  }, [config?.taskRecencyHighlight?.enabled, config?.taskRecencyHighlight?.mode, inboxActive])

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
  // Drop pins whose project/task no longer exists; storage prunes them on the next save.
  const resolvedPins = React.useMemo(() => {
    const resolved: { item: PinnedItem; key: string; project: Project; task?: Task }[] = []
    for (const item of pinnedItems ?? []) {
      const project = projectsById.get(item.projectId)
      if (!project) continue
      if (item.type === 'task') {
        const task = findTaskInProject(project, item.taskId)
        if (!task) continue
        resolved.push({ item, key: pinnedItemKey(item), project, task })
      } else if (item.type === 'stream') {
        // TEMPORARY (step 5 shows streams): a pinned stream shows as one row, the
        // task it was last left on.
        const stream = project.streams.find(candidate => candidate.id === item.streamId)
        const tasks = (stream?.tasks ?? []).filter(t => !isHomeTask(t))
        const task = tasks.find(t => t.id === stream?.lastTaskId) ?? tasks[0]
        if (!task) continue
        resolved.push({ item, key: pinnedItemKey(item), project, task })
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
   */
  const beginEdit = useCallback((id: string, name: string, projectId?: string) => {
    setSidebarTab('projects')
    if (projectId) setProjectExpanded(projectId, true)
    setEditingId(id)
    setEditValue(name)
  }, [setSidebarTab, setProjectExpanded])

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

  // No inline rename: the task opens on its prompt box, and the first prompt names it.
  const handleAddTask = (projectId: string) => {
    addTask(projectId, NEW_TASK_NAME)
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

  // Like + Task, it opens on the prompt box; the worktree is made when the first
  // prompt is sent, with the branch named after it.
  const handleAddWorkspace = (projectId: string) => {
    addPendingWorkspaceTask(projectId, NEW_TASK_NAME)
  }

  /**
   * File what the composer asked for. A task that starts an agent is born with the
   * agent's tab already in it; the tab picks the prompt up on its first spawn.
   */
  const handleComposedTask = ({ target, start, workspace, workspaceDraft }: NewTaskSubmission) => {
    const tab = start ? createTab(start.agent) : null
    const tabs = tab ? [tab] : []
    const name = start ? taskNameFromPrompt(start.prompt.text) : NEW_TASK_NAME
    if (tab && start) {
      setPendingPrompt(tab.id, start.prompt)
      updateConfig({
        promptBoxAgent: start.agent,
        ...(agentTakesMode(start.agent) ? { promptBoxMode: start.prompt.mode ?? '' } : {})
      })
    }
    if (target.kind === 'dir') {
      addTaskInDirectory(target.directory, name, tabs, workspace, workspaceDraft)
    } else {
      if (workspace) addWorkspaceTask(target.projectId, name, workspace, tabs)
      else if (workspaceDraft) addPendingWorkspaceTask(target.projectId, name, workspaceDraft)
      else addTask(target.projectId, name, tabs)
      // The task is selected on create; expand its project so switching back
      // to the tree doesn't hide the thing you just made.
      setProjectExpanded(target.projectId, true)
    }
    setNewTaskOpen(false)
  }

  const handleDeleteTask = async (projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!task) return
    // The worktree goes only with its stream's last task (`workspaceReleasedBy`).
    const workspace = workspaceReleasedBy(project, taskId)
    // Asked before the workspace pre-flight below: for a clean, merged workspace
    // that call already removes the worktree.
    if (!window.confirm(workspace
      ? `Delete task "${task.name}" and its workspace?\n\nThe worktree folder is removed from disk.`
      : `Delete task "${task.name}"? Its tabs close.`)) return

    if (workspace && project) {
      let keepBranch = false
      let result: WorkspaceDeleteResult
      try {
        result = await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: workspace.worktreePath,
            branchName: workspace.branchName,
            baseBranch: workspace.baseBranch
          }
        )
      } catch (err) {
        // A pre-flight that never ran is not permission to delete: ask, like 'check-failed'.
        result = { status: 'check-failed', reason: err instanceof Error ? err.message : String(err) }
      }

      if (result.status === 'uncommitted') {
        if (!window.confirm('This workspace has uncommitted changes that will be lost. Delete anyway?')) return
      } else if (result.status === 'unmerged') {
        if (!window.confirm(`Branch "${workspace.branchName}" has not been merged into "${workspace.baseBranch}". Delete workspace?`)) return
        keepBranch = !window.confirm(`Also delete the unmerged branch "${workspace.branchName}"?`)
      } else if (result.status === 'uncommitted-and-unmerged') {
        if (!window.confirm(`This workspace has uncommitted changes and branch "${workspace.branchName}" has not been merged into "${workspace.baseBranch}". Delete anyway?`)) return
        keepBranch = !window.confirm(`Also delete the unmerged branch "${workspace.branchName}"?`)
      } else if (result.status === 'check-failed') {
        const reason = result.reason || 'The safety checks did not complete.'
        if (!window.confirm(`DevTool could not verify that workspace "${workspace.branchName}" is safe to delete.\n\n${reason}\n\nDelete anyway? Uncommitted or unmerged work may be lost.`)) return
        // Merge state unknown, so keep the branch unless the user explicitly asks otherwise.
        keepBranch = !window.confirm(`Also delete the branch "${workspace.branchName}"? Its merge state could not be verified.`)
      }
      // 'invalid-worktree' is reported after step 2 instead: killing the tabs below can free
      // the worktree, and the forced pass is the one that decides whether anything is left.

      // Step 1: Kill all tabs/PTYs first so no process holds the worktree cwd
      for (const tab of taskTabs(task)) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        window.api.scrollbackDelete(tab.id)
      }

      // Step 2: Now safe to remove worktree and branch
      try {
        const forced = await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: workspace.worktreePath,
            branchName: workspace.branchName,
            baseBranch: workspace.baseBranch,
            force: true,
            keepBranch
          }
        )
        if (forced.status !== 'ok') {
          window.alert(forced.reason || `The workspace directory "${workspace.worktreePath}" could not be removed and was left on disk.`)
        }
      } catch {
        // Worktree may already be cleaned up
      }

      // Step 3: Remove task from state (skip both tab cleanup and workspace cleanup — already done)
      removeTask(projectId, taskId, true)
      return
    }

    removeTask(projectId, taskId)
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

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, projectId: string, taskId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'task', projectId, taskId })
  }, [])

  const { dragState, dropTarget, handleDragMouseDown } = useSidebarTreeDrag({
    editingId, projectOrder, treeProjectIds, reorderTasks, reorderProjects
  })

  const [expandedPinnedProjectIds, setExpandedPinnedProjectIds] = useState<string[]>([])
  const togglePinnedProjectExpansion = useCallback((projectId: string) => {
    setExpandedPinnedProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
    )
  }, [])

  const { pinDragIndex, pinDropIndex, handlePinMouseDown } = usePinnedDrag(resolvedPins, setPinnedOrder)

  /** The "+ Task  + Workspace" row closing an expanded project, in the tree or under a pin. */
  const renderAddTaskRow = (project: Project, indentCls: string = TASK_ROW_PL) => (
    <div className={`flex items-center gap-0.5 flex-wrap mx-1.5 ${indentCls} pr-2 py-0.5`}>
      <button
        className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] text-xs whitespace-nowrap shrink-0 transition-colors duration-(--motion-fast)"
        onClick={() => handleAddTask(project.id)}
      >
        <Plus size={12} className="inline mr-0.5" /> Task
      </button>
      {!isShellCommandProject(project) && (
        <button
          className="bg-transparent border-0 text-text-subtle cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] text-xs whitespace-nowrap shrink-0 transition-colors duration-(--motion-fast)"
          onClick={() => handleAddWorkspace(project.id)}
        >
          <Plus size={12} className="inline mr-0.5" /> Workspace
        </button>
      )}
    </div>
  )

  const renderProject = (project: Project) => {
    const isExpanded = expandedProjects.has(project.id)
    // Project home lives on the project row itself (it's filtered out of the
    // visible task list), so the row needs the selection rail whenever the
    // home task is active — even when the project is expanded.
    const isHomeSelected = selectedProjectId === project.id
      && projectTasks(project).some(t => t.id === selectedTaskId && isHomeTask(t))
    const isProjectSelected = selectedProjectId === project.id && (!isExpanded || isHomeSelected)
    const isProjectDragging = dragState?.type === 'project' && dragState.id === project.id
    const allTasks = projectTasks(project)
    const visibleTasks = allTasks.filter(t => !isHomeTask(t))
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
            className="bg-field border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full"
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
              {!isExpanded && (() => {
                const projectStatus = getProjectStatus(visibleTasks, allStatuses)
                if (!projectStatus) return null
                const dotClass = projectStatus === 'working'
                  ? 'bg-status-working status-pulse'
                  : projectStatus === 'attention'
                  ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
                  : 'bg-status-exited'
                return <span className={`w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden ${dotClass}`} />
              })()}
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
          {visibleTasks.map((task) => {
            const projectTaskIndex = allTasks.indexOf(task)
            const isSelected = selectedTaskId === task.id
            const opacity = !isSelected && config?.taskRecencyHighlight
              ? computeTaskRecencyOpacity(task, sortedByRecency, config.taskRecencyHighlight, now)
              : 0
            const recencyStyle = buildRecencyStyle(opacity, effectiveTheme)
            const isTaskDragging = dragState?.type === 'task' && dragState.index === projectTaskIndex
            return (
              <React.Fragment key={task.id}>
                {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === projectTaskIndex && (
                  <div className={`h-0.5 bg-accent mr-2 rounded-sm ${TASK_ROW_ML}`} />
                )}
                <div
                  className={[
                    'group flex items-center gap-2 mx-1.5 px-2.5 h-6 rounded-md text-text cursor-pointer',
                    TASK_ROW_PL,
                    'text-sm',
                    'task-item',
                    'transition-colors duration-(--motion-fast)',
                    isSelected ? 'bg-sel' : 'hover:bg-surface-3',
                    isTaskDragging ? 'opacity-40' : '',
                  ].join(' ')}
                  data-task-id={task.id}
                  data-task-index={projectTaskIndex}
                  title={editingId === task.id ? undefined : taskTooltip(task)}
                  style={recencyStyle}
                  onClick={() => handleSelectTask(project.id, task)}
                  onMouseDown={(e) => handleDragMouseDown(e, 'task', task.id, projectTaskIndex, project.id)}
                  onContextMenu={(e) => handleContextMenu(e, 'task', project.id, task.id)}
                >
                  {editingId === task.id ? (
                    <input
                      ref={editRef}
                      className="bg-field border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full"
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
                      <StreamChip project={project} taskId={task.id} />
                      {taskWorkspace(project, task.id) && <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>}
                      <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                        <TaskStatusDot task={task} allStatuses={allStatuses} />
                        <RowActions>
                          <RowAction danger title="Delete task" onClick={() => handleDeleteTask(project.id, task.id)}>
                            <X size={13} />
                          </RowAction>
                        </RowActions>
                      </span>
                    </>
                  )}
                </div>
              </React.Fragment>
            )
          })}
          {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === allTasks.length && (
            <div className={`h-0.5 bg-accent mr-2 rounded-sm ${TASK_ROW_ML}`} />
          )}
          {renderAddTaskRow(project)}
        </div>
      )}
    </div>
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
            {resolvedPins.map((pin, index) => {
              const isProjectPin = pin.item.type === 'project'
              const isSelected = isProjectPin
                ? selectedProjectId === pin.project.id
                  && projectTasks(pin.project).some(t => t.id === selectedTaskId && isHomeTask(t))
                : selectedTaskId === pin.task!.id
              const isDraggingPin = pinDragIndex === index
              const isPinExpanded = isProjectPin && expandedPinnedProjectIds.includes(pin.project.id)
              const pinnedProjectTasks = isProjectPin ? projectTasks(pin.project).filter(t => !isHomeTask(t)) : []
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
                    title={isProjectPin ? undefined : taskTooltip(pin.task!)}
                    onClick={() => {
                      if (isProjectPin) selectProjectHome(pin.project.id)
                      else handleSelectTask(pin.project.id, pin.task!)
                    }}
                    onMouseDown={(e) => handlePinMouseDown(e, pin.key, index)}
                    onContextMenu={(e) => handleContextMenu(
                      e,
                      isProjectPin ? 'project' : 'task',
                      pin.project.id,
                      isProjectPin ? undefined : pin.task!.id
                    )}
                  >
                    {isProjectPin && (
                      <button
                        className="text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer p-0 flex items-center shrink-0"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); togglePinnedProjectExpansion(pin.project.id) }}
                      >
                        <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${isPinExpanded ? 'rotate-90' : ''}`} />
                      </button>
                    )}
                    <ProjectIconSlot project={pin.project} theme={effectiveTheme} metadata={iconMetadata} />
                    {isProjectPin ? (
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">{pin.project.name}</span>
                    ) : (
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        <span className="text-text-muted">{pin.project.name}</span>
                        <span className="text-text-subtle mx-1">›</span>
                        {pin.task!.name}
                      </span>
                    )}
                    {!isProjectPin && taskWorkspace(pin.project, pin.task!.id) && (
                      <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0">ws</span>
                    )}
                    {/* Pins are the one place a hidden ad-hoc project reaches the tree. */}
                    {isEphemeralProject(pin.project) && (
                      <span
                        className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0"
                        title={pin.project.directory}
                      >dir</span>
                    )}
                    <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                      {isProjectPin ? (() => {
                        const projectStatus = getProjectStatus(pinnedProjectTasks, allStatuses)
                        if (!projectStatus) return null
                        const dotClass = projectStatus === 'working'
                          ? 'bg-status-working status-pulse'
                          : projectStatus === 'attention'
                          ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
                          : 'bg-status-exited'
                        return <span className={`w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden ${dotClass}`} />
                      })() : (
                        <TaskStatusDot task={pin.task!} allStatuses={allStatuses} />
                      )}
                      <RowActions>
                        {/* A task pin adds a sibling: the task's project is where its work lives. */}
                        <RowAction title={isProjectPin ? 'New task' : `New task in ${pin.project.name}`} onClick={() => handleAddTask(pin.project.id)}>
                          <Plus size={13} />
                        </RowAction>
                        {!isShellCommandProject(pin.project) && (
                          <RowAction title={isProjectPin ? 'New workspace' : `New workspace in ${pin.project.name}`} onClick={() => handleAddWorkspace(pin.project.id)}>
                            <GitBranch size={13} />
                          </RowAction>
                        )}
                        <RowAction title="Unpin" onClick={() => togglePinnedItem(pin.item)}>
                          <X size={13} />
                        </RowAction>
                      </RowActions>
                    </span>
                  </div>
                  {isPinExpanded && pinnedProjectTasks.map(task => {
                    const isTaskSelected = selectedTaskId === task.id
                    return (
                      <div
                        key={task.id}
                        className={[
                          'group flex items-center gap-2 mx-1.5 px-2.5 pl-[40px] h-6 rounded-md text-sm text-text cursor-pointer',
                          'transition-colors duration-(--motion-fast)',
                          isTaskSelected ? 'bg-sel' : 'hover:bg-surface-3',
                        ].join(' ')}
                        onClick={() => handleSelectTask(pin.project.id, task)}
                        onContextMenu={(e) => handleContextMenu(e, 'task', pin.project.id, task.id)}
                      >
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{task.name}</span>
                        <StreamChip project={pin.project} taskId={task.id} />
                        {taskWorkspace(pin.project, task.id) && <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>}
                        <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                          <TaskStatusDot task={task} allStatuses={allStatuses} />
                        </span>
                      </div>
                    )
                  })}
                  {isPinExpanded && renderAddTaskRow(pin.project, 'pl-[40px]')}
                </React.Fragment>
              )
            })}
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
        handleDeleteTask={handleDeleteTask}
        beginEdit={beginEdit}
        isPinned={isPinned}
        setDuplicateProjectId={setDuplicateProjectId}
        setProjectSettingsId={setProjectSettingsId}
        onAddTask={handleAddTask}
        onAddWorkspace={handleAddWorkspace}
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

      {newTaskOpen && config && (
        <NewTaskModal
          projects={orderedProjects}
          defaultProjectId={selectedProjectId}
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
