import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince, useTabStatusStore, type TabStatusValue } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isHomeTask, isRemoteProject, isShellCommandProject, isWorkspaceTask, pinnedItemKey, projectMatchesTagFilter } from '../../shared/types'
import type { Task, Project, PinnedItem } from '../../shared/types'
import AddRemoteProject from './AddRemoteProject'
import CreateWorkspaceModal from './CreateWorkspaceModal'
import AddShellCommandProject from './AddShellCommandProject'
import AddLocalProject from './AddLocalProject'
import ProjectSettings from './ProjectSettings'
import Settings from './Settings'
import ProjectSwitcher from './ProjectSwitcher'
import ActivityPanel from './ActivityPanel'
import InboxPanel from './InboxPanel'
import NewTaskModal from './NewTaskModal'
import { getReorderInsertIndex, getTaskDropIndex } from './sidebarDrag'
import { buildRecencyStyle, computeTaskRecencyOpacity, sortTasksByRecency } from './taskRecency'
import { isSettled, isSnoozed, isUnread, snoozePresets } from './inbox'
import { newTaskInitialTabs } from './newTaskTabs'
import { useResizeHandle } from '../hooks/useResizeHandle'
import { useMenuPosition } from '../hooks/useMenuPosition'
import { ChevronRight, Filter, Plus, Search, Settings as SettingsIcon, Plug, SquarePen, Terminal as TerminalIcon, X, Cog } from 'lucide-react'
import { RowActions, RowAction } from './ui'
import { paletteEvents } from '../palette/paletteEvents'
import { dashboardIconUrl, fetchDashboardIconsMetadata, type DashboardIconsMetadata } from './dashboardIcons'

type DragState = {
  type: 'project' | 'task'
  id: string
  index: number
  projectId?: string
}

type DropTarget =
  | { type: 'between-projects'; index: number }
  | { type: 'between-tasks'; projectId: string; index: number }
  | null

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

function getProjectStatus(tasks: Task[], allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const statuses = tasks.map((t) => getTaskStatus(t, allStatuses)).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

/** Rows carry mx-1.5 (6px); project name starts 64px from the sidebar edge:
    6 (mx) + 10 (px-2.5) + 12 (chevron) + 8 (gap) + 20 (icon) + 8 (gap).
    Task rows indent to it with pl (inside mx), drop indicators with ml (no mx). */
const TASK_ROW_PL = 'pl-[58px]'
const TASK_ROW_ML = 'ml-[64px]'

/** Stem ctx-menu row */
const menuItemCls = 'block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel'
const menuCls = 'bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop'

/** Icon buttons in the sidebar header strip (search / filter / add). */
const headerIconCls = 'relative flex items-center bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

function getProjectInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/[\s\-_/]+/).filter(Boolean)
  if (words.length >= 2) {
    const a = words[0]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    const b = words[1]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    if (a && b) return (a + b).toUpperCase()
  }
  const letters = (words[0] ?? trimmed).replace(/[^a-zA-Z0-9]/g, '')
  if (!letters) return '?'
  return letters.slice(0, 2).toUpperCase()
}

function ProjectIconSlot({
  project,
  theme,
  metadata,
}: {
  project: Project
  theme: 'dark' | 'light'
  metadata: DashboardIconsMetadata | null
}): React.ReactElement {
  const [iconFailed, setIconFailed] = useState(false)
  const iconUrl = project.icon && !iconFailed
    ? dashboardIconUrl(project.icon, { theme, metadata: metadata ?? undefined })
    : null

  return (
    <span className="w-5 shrink-0 flex items-center justify-center">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="w-3.5 h-3.5 object-contain"
          onError={() => setIconFailed(true)}
        />
      ) : project.emoji ? (
        <span className="text-base leading-none">{project.emoji}</span>
      ) : (
        <span
          className="w-3.5 h-3.5 rounded-sm bg-surface-3 text-text-muted text-[8px] font-semibold leading-none flex items-center justify-center"
          title={project.name}
        >
          {getProjectInitials(project.name)}
        </span>
      )}
    </span>
  )
}

/** One half of the Projects | Inbox segmented control in the sidebar header. */
function SidebarTabButton({
  label,
  active,
  badge,
  onClick
}: {
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer',
        'text-2xs font-bold uppercase tracking-[0.06em]',
        'transition-colors duration-(--motion-fast)',
        active ? 'text-text' : 'text-text-subtle hover:text-text-muted'
      ].join(' ')}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="px-1 rounded-full bg-status-attention text-2xs font-bold text-accent-ink leading-[1.4] tabular-nums">
          {badge}
        </span>
      )}
    </button>
  )
}

function TaskStatusDot({ task, allStatuses }: { task: Task; allStatuses: Record<string, TabStatusValue> }): React.ReactElement | null {
  const status = getTaskStatus(task, allStatuses)
  if (!status) return null
  const dotClass = status === 'working'
    ? 'bg-status-working animate-pulse'
    : status === 'attention'
    ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
    : 'bg-status-exited'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden ${dotClass}`} />
}

export default function Sidebar({ switcherRequested, onSwitcherConsumed }: { switcherRequested?: boolean; onSwitcherConsumed?: () => void }): React.ReactElement {
  const {
    projects, tags, projectOrder,
    pinnedItems, togglePinnedItem, setPinnedOrder,
    selectedProjectId, selectedTaskId, selectedTagIds,
    switchToTask, selectProjectHome,
    addProject, addRemoteProject, addShellCommandProject, addTag, removeProject, renameProject, updateProject,
    addTask, addWorkspaceTask, removeTask, renameTask,
    reorderProjects, reorderTasks, getProjectDir,
    config, updateConfig,
    toggleTagFilter, clearTagFilters,
    expandedProjectIds, toggleProjectExpansion, setProjectExpanded,
    effectiveTheme,
    sidebarWidth, setSidebarWidth,
    sidebarProjectsCollapsed, toggleSidebarProjectsCollapsed,
    sidebarTab, setSidebarTab,
    settleTask, unsettleTask, snoozeTask, unsnoozeTask, markTaskUnread, markTaskVisited
  } = useApp()
  const resizeHandle = useResizeHandle({ width: sidebarWidth, onWidthChange: setSidebarWidth, edge: 'right' })
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const tabStatusStore = useTabStatusStore()

  const [now, setNow] = useState(() => Date.now())
  const sortedByRecency = React.useMemo(
    () => sortTasksByRecency(projects.flatMap(p => p.tasks.filter(t => !isHomeTask(t)))),
    [projects]
  )

  const inboxActive = sidebarTab === 'inbox'

  // Badge count is what makes the tab worth having: attention is visible without
  // leaving the tree. Snoozed tasks are deliberately excluded — that's the point.
  const inboxUnreadCount = React.useMemo(
    () => projects.reduce((count, project) => count + project.tasks.filter(
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

  // Tabs the composer seeds a new task with. Passed into the create call rather
  // than opened afterwards, so the task and its tab land in one state write.
  const composerInitialTabs = useCallback(
    () => (config ? newTaskInitialTabs(config.newTaskAutoOpen, config) : []),
    [config]
  )

  const handleSelectTask = useCallback((projectId: string, task: Task) => {
    switchToTask(projectId, task.id)
    // Opening the task is the acknowledgement — clear attention on every tab, not
    // just the AI ones. A terminal's attention state otherwise never resets (it
    // only clears on a "ready"-shaped line), which would pin the row in Needs you.
    const tabs = [...task.tabs.left, ...task.tabs.right]
    for (const tab of tabs) {
      if (tabStatusStore.getStatus(tab.id) === 'attention') {
        tabStatusStore.setStatus(tab.id, null)
      }
    }
  }, [switchToTask, tabStatusStore])

  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'project' | 'task'; projectId: string; taskId?: string
  } | null>(null)
  // The snooze presets replace the menu body rather than fly out sideways — a
  // nested flyout would run off the edge of a 240px sidebar.
  const [snoozeSubmenu, setSnoozeSubmenu] = useState(false)
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    setSnoozeSubmenu(false)
  }, [])
  // Keeps the popup inside the window — a right-click near the bottom of the
  // sidebar would otherwise render items below the edge, unreachable.
  const contextMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
  const snoozeMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
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
  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const dropTargetRef = useRef<DropTarget>(null)
  const [workspaceModalProjectId, setWorkspaceModalProjectId] = useState<string | null>(null)
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
  // same thing in both tabs.
  const inboxProjects = React.useMemo(
    () => visibleProjectIds.map(id => projectsById.get(id)).filter((p): p is Project => !!p),
    [visibleProjectIds, projectsById]
  )
  // The composer deliberately ignores the tag filter: filtering the destination
  // list would make projects you can see in the tree un-creatable-in from here.
  const orderedProjects = React.useMemo(
    () => projectOrder.map(id => projectsById.get(id)).filter((p): p is Project => !!p),
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
        const task = project.tasks.find(t => t.id === item.taskId)
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
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    let cancelled = false
    fetchDashboardIconsMetadata()
      .then((m) => { if (!cancelled) setIconMetadata(m) })
      .catch(() => { /* CDN unreachable — icons fall back to slug-as-given */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    dropTargetRef.current = dropTarget
  }, [dropTarget])

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

  const handleAddTask = (projectId: string) => {
    const task = addTask(projectId, 'New Task')
    beginEdit(task.id, task.name, projectId)
  }

  const findTask = useCallback((projectId: string, taskId: string): Task | undefined =>
    projects.find(p => p.id === projectId)?.tasks.find(t => t.id === taskId)
  , [projects])

  /** The row's one-click gesture: settle if it isn't, put it back if it is. */
  const handleToggleSettled = useCallback((projectId: string, taskId: string) => {
    const task = findTask(projectId, taskId)
    if (!task) return
    if (isSettled(task)) unsettleTask(projectId, taskId)
    else settleTask(projectId, taskId)
  }, [findTask, settleTask, unsettleTask])

  const handleAddWorkspace = (projectId: string) => {
    setWorkspaceModalProjectId(projectId)
  }

  const handleDeleteTask = async (projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = project?.tasks.find(t => t.id === taskId)

    if (task?.workspace && project) {
      let keepBranch = false
      try {
        const result = await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch
          }
        )
        if (result.status === 'uncommitted') {
          if (!window.confirm('This workspace has uncommitted changes that will be lost. Delete anyway?')) return
        } else if (result.status === 'unmerged') {
          if (!window.confirm(`Branch "${task.workspace.branchName}" has not been merged into "${task.workspace.baseBranch}". Delete workspace?`)) return
          keepBranch = !window.confirm(`Also delete the unmerged branch "${task.workspace.branchName}"?`)
        } else if (result.status === 'uncommitted-and-unmerged') {
          if (!window.confirm(`This workspace has uncommitted changes and branch "${task.workspace.branchName}" has not been merged into "${task.workspace.baseBranch}". Delete anyway?`)) return
          keepBranch = !window.confirm(`Also delete the unmerged branch "${task.workspace.branchName}"?`)
        }
      } catch {
        // Pre-flight failed, proceed with deletion
      }

      // Step 1: Kill all tabs/PTYs first so no process holds the worktree cwd
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        window.api.scrollbackDelete(tab.id)
      }

      // Step 2: Now safe to remove worktree and branch
      try {
        await window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: isRemoteProject(project) ? project.id : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch,
            force: true,
            keepBranch
          }
        )
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

  const DRAG_THRESHOLD = 5

  const handleDragMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'project' | 'task',
    id: string,
    index: number,
    projectId?: string
  ) => {
    if (e.button !== 0 || editingId) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        const nextDragState: DragState = { type, id, index, projectId }
        dragStateRef.current = nextDragState
        setDragState(nextDragState)
      }

      const sidebarList = document.querySelector('.sidebar-list')
      if (!sidebarList) return

      if (type === 'task' && projectId) {
        const items = sidebarList.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-id="${projectId}"] .task-item`
        )
        const bestIndex = getTaskDropIndex(
          Array.from(items).map((item) => {
            const rect = item.getBoundingClientRect()
            return {
              id: item.dataset.taskId ?? '',
              index: Number(item.dataset.taskIndex ?? '-1'),
              top: rect.top,
              height: rect.height
            }
          }),
          ev.clientY,
          id
        )
        const nextDropTarget: DropTarget = { type: 'between-tasks', projectId, index: bestIndex }
        dropTargetRef.current = nextDropTarget
        setDropTarget(nextDropTarget)
        return
      }

      const projectItems = sidebarList.querySelectorAll<HTMLElement>('[data-drag-type="project"]')
      let newTarget: typeof dropTarget = null

      for (let i = 0; i < projectItems.length; i++) {
        const item = projectItems[i]
        const rect = item.getBoundingClientRect()
        if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue

        const itemId = item.dataset.dragId!
        const listIdx = visibleProjectIds.indexOf(itemId)
        if (listIdx < 0) break
        const midY = rect.top + rect.height / 2
        const insertIdx = ev.clientY > midY ? listIdx + 1 : listIdx
        newTarget = { type: 'between-projects', index: insertIdx }
        break
      }

      if (!newTarget) {
        newTarget = { type: 'between-projects', index: visibleProjectIds.length }
      }

      dropTargetRef.current = newTarget
      setDropTarget(newTarget)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (!dragging) return

      const currentDragState = dragStateRef.current
      const currentDropTarget = dropTargetRef.current

      if (currentDragState && currentDropTarget) {
        if (currentDragState.type === 'task' && currentDragState.projectId && currentDropTarget.type === 'between-tasks') {
          const toIndex = getReorderInsertIndex(currentDragState.index, currentDropTarget.index)
          if (toIndex !== null) {
            reorderTasks(currentDragState.projectId, currentDragState.index, toIndex)
          }
        } else if (currentDragState.type === 'project' && currentDropTarget.type === 'between-projects') {
          const fromIdx = projectOrder.indexOf(currentDragState.id)
          const orderDropIndex = currentDropTarget.index >= visibleProjectIds.length
            ? projectOrder.length
            : projectOrder.indexOf(visibleProjectIds[currentDropTarget.index] ?? '')
          if (orderDropIndex >= 0) {
            const toIdx = getReorderInsertIndex(fromIdx, orderDropIndex)
            if (toIdx !== null) {
              reorderProjects(fromIdx, toIdx)
            }
          }
        }
      }

      dragStateRef.current = null
      dropTargetRef.current = null
      setDragState(null)
      setDropTarget(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, projectOrder, visibleProjectIds, reorderTasks, reorderProjects])

  const [pinDragIndex, setPinDragIndex] = useState<number | null>(null)
  const [pinDropIndex, setPinDropIndex] = useState<number | null>(null)
  const pinDropIndexRef = useRef<number | null>(null)
  const [expandedPinnedProjectIds, setExpandedPinnedProjectIds] = useState<string[]>([])
  const togglePinnedProjectExpansion = useCallback((projectId: string) => {
    setExpandedPinnedProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
    )
  }, [])

  const handlePinMouseDown = useCallback((e: React.MouseEvent, key: string, index: number) => {
    if (e.button !== 0) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        setPinDragIndex(index)
      }
      const list = document.querySelector('.sidebar-pinned-list')
      if (!list) return
      const items = list.querySelectorAll<HTMLElement>('[data-pin-key]')
      const bestIndex = getTaskDropIndex(
        Array.from(items).map((item) => {
          const rect = item.getBoundingClientRect()
          return {
            id: item.dataset.pinKey ?? '',
            index: Number(item.dataset.pinIndex ?? '-1'),
            top: rect.top,
            height: rect.height
          }
        }),
        ev.clientY,
        key
      )
      pinDropIndexRef.current = bestIndex
      setPinDropIndex(bestIndex)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        const dropIndex = pinDropIndexRef.current
        if (dropIndex !== null) {
          const toIndex = getReorderInsertIndex(index, dropIndex)
          if (toIndex !== null) {
            const next = resolvedPins.map(pin => pin.item)
            const [moved] = next.splice(index, 1)
            next.splice(toIndex, 0, moved)
            setPinnedOrder(next)
          }
        }
      }
      pinDropIndexRef.current = null
      setPinDragIndex(null)
      setPinDropIndex(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [resolvedPins, setPinnedOrder])

  const renderProject = (project: Project) => {
    const isExpanded = expandedProjects.has(project.id)
    // Project home lives on the project row itself (it's filtered out of the
    // visible task list), so the row needs the selection rail whenever the
    // home task is active — even when the project is expanded.
    const isHomeSelected = selectedProjectId === project.id
      && project.tasks.some(t => t.id === selectedTaskId && isHomeTask(t))
    const isProjectSelected = selectedProjectId === project.id && (!isExpanded || isHomeSelected)
    const isProjectDragging = dragState?.type === 'project' && dragState.id === project.id
    const visibleTasks = project.tasks.filter(t => !isHomeTask(t))
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
                ? 'bg-ssh-connecting animate-pulse'
                : 'bg-ssh-disconnected'
              return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${dotClass}`} />
            })()}
            <span className="ml-auto flex items-center gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
              {!isExpanded && (() => {
                const projectStatus = getProjectStatus(project.tasks.filter(t => !isHomeTask(t)), allStatuses)
                if (!projectStatus) return null
                const dotClass = projectStatus === 'working'
                  ? 'bg-status-working animate-pulse'
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
            const projectTaskIndex = project.tasks.indexOf(task)
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
                      {isWorkspaceTask(task) && <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>}
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
          {dropTarget?.type === 'between-tasks' && dropTarget.projectId === project.id && dropTarget.index === project.tasks.length && (
            <div className={`h-0.5 bg-accent mr-2 rounded-sm ${TASK_ROW_ML}`} />
          )}
          <div className={`flex items-center gap-0.5 flex-wrap mx-1.5 ${TASK_ROW_PL} pr-2 py-0.5`}>
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
                  && pin.project.tasks.some(t => t.id === selectedTaskId && isHomeTask(t))
                : selectedTaskId === pin.task!.id
              const isDraggingPin = pinDragIndex === index
              const isPinExpanded = isProjectPin && expandedPinnedProjectIds.includes(pin.project.id)
              const pinnedProjectTasks = isProjectPin ? pin.project.tasks.filter(t => !isHomeTask(t)) : []
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
                    {!isProjectPin && isWorkspaceTask(pin.task!) && (
                      <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0">ws</span>
                    )}
                    <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                      {isProjectPin ? (() => {
                        const projectStatus = getProjectStatus(pin.project.tasks.filter(t => !isHomeTask(t)), allStatuses)
                        if (!projectStatus) return null
                        const dotClass = projectStatus === 'working'
                          ? 'bg-status-working animate-pulse'
                          : projectStatus === 'attention'
                          ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
                          : 'bg-status-exited'
                        return <span className={`w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden ${dotClass}`} />
                      })() : (
                        <TaskStatusDot task={pin.task!} allStatuses={allStatuses} />
                      )}
                      <RowActions>
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
                        {isWorkspaceTask(task) && <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>}
                        <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                          <TaskStatusDot task={task} allStatuses={allStatuses} />
                        </span>
                      </div>
                    )
                  })}
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
            title="Quick switch (⌘P)"
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
          now={now}
        />
      ) : (
      <div className="sidebar-list flex-1 overflow-y-auto py-1">
        {visibleProjectIds.map((projectId, listIdx) => {
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
        {dropTarget?.type === 'between-projects' && dropTarget.index === visibleProjectIds.length && (
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

      {contextMenu && snoozeSubmenu && contextMenu.type === 'task' && (
        <div ref={snoozeMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={snoozeMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          {snoozePresets(Date.now()).map(preset => (
            <button
              key={preset.id}
              className={`${menuItemCls} flex items-center gap-6 justify-between`}
              onClick={() => {
                snoozeTask(contextMenu.projectId, contextMenu.taskId!, {
                  until: preset.until,
                  untilAttention: preset.untilAttention
                })
                closeContextMenu()
              }}
            >
              <span>{preset.label}</span>
              {preset.hint && <span className="text-text-subtle text-xs tabular-nums">{preset.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {contextMenu && !snoozeSubmenu && (
        <div ref={contextMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={contextMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          <>
            {contextMenu.type === 'task' && (() => {
              const task = findTask(contextMenu.projectId, contextMenu.taskId!)
              if (!task) return null
              const settled = isSettled(task)
              const snoozed = isSnoozed(task, Date.now())
              return (
                <div className="border-b border-hair pb-1 mb-1">
                  <button className={menuItemCls} onClick={() => {
                    handleToggleSettled(contextMenu.projectId, contextMenu.taskId!)
                    closeContextMenu()
                  }}>{settled ? 'Unsettle' : 'Settle'}</button>
                  {snoozed ? (
                    <button className={menuItemCls} onClick={() => {
                      unsnoozeTask(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Wake now</button>
                  ) : (
                    <button
                      className={`${menuItemCls} flex items-center gap-6 justify-between`}
                      onClick={() => setSnoozeSubmenu(true)}
                    >
                      <span>Snooze</span>
                      <ChevronRight size={11} className="text-text-subtle" />
                    </button>
                  )}
                  {isUnread(task) ? (
                    <button className={menuItemCls} onClick={() => {
                      markTaskVisited(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark read</button>
                  ) : (
                    <button className={menuItemCls} onClick={() => {
                      markTaskUnread(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark unread</button>
                  )}
                </div>
              )
            })()}
            <button className={menuItemCls} onClick={() => {
                const id = contextMenu.type === 'project' ? contextMenu.projectId : contextMenu.taskId!
                const item = contextMenu.type === 'project'
                  ? projects.find((p) => p.id === id)
                  : projects.find((p) => p.id === contextMenu.projectId)?.tasks.find((t) => t.id === id)
                beginEdit(id, item?.name ?? '', contextMenu.type === 'task' ? contextMenu.projectId : undefined)
                setContextMenu(null)
              }}>Rename</button>
              {(() => {
                const item: PinnedItem = contextMenu.type === 'project'
                  ? { type: 'project', projectId: contextMenu.projectId }
                  : { type: 'task', projectId: contextMenu.projectId, taskId: contextMenu.taskId! }
                const pinned = isPinned(item)
                const noun = contextMenu.type === 'project' ? 'project' : 'task'
                return (
                  <button className={menuItemCls} onClick={() => {
                    togglePinnedItem(item)
                    setContextMenu(null)
                  }}>{pinned ? `Unpin ${noun}` : `Pin ${noun}`}</button>
                )
              })()}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setDuplicateProjectId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Duplicate</button>
              )}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setProjectSettingsId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Settings</button>
              )}
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isRemoteProject(project)) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    window.api.sshConnect(project.id, project.ssh!).catch(() => {})
                    setContextMenu(null)
                  }}>Reconnect SSH</button>
                )
              })()}
              <button className={`${menuItemCls} text-danger`} onClick={() => {
                if (contextMenu.type === 'project') removeProject(contextMenu.projectId)
                else handleDeleteTask(contextMenu.projectId, contextMenu.taskId!)
                setContextMenu(null)
              }}>Delete</button>
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project) return null
                const details: { label: string; value: string }[] = []
                if (isShellCommandProject(project)) {
                  details.push({ label: 'Command', value: project.shellCommand!.command })
                } else if (isRemoteProject(project)) {
                  details.push({ label: 'Connection', value: `${project.ssh!.username}@${project.ssh!.host}:${project.ssh!.port}` })
                  details.push({ label: 'Dir', value: project.ssh!.remoteDir })
                } else {
                  details.push({ label: 'Dir', value: project.directory })
                }
                return (
                  <div className="border-t border-hair mt-1 px-2.5 pt-1.5 pb-1">
                    {details.map(d => (
                      <div key={d.label} className="text-text-subtle text-xs leading-snug overflow-hidden text-ellipsis whitespace-nowrap max-w-[260px] select-text cursor-text" title={d.value}>
                        <span className="opacity-70">{d.label}:</span> {d.value}
                      </div>
                    ))}
                  </div>
                )
              })()}
          </>
        </div>
      )}

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

      {newTaskOpen && (
        <NewTaskModal
          projects={orderedProjects}
          defaultProjectId={selectedProjectId}
          getProjectDir={getProjectDir}
          onCreate={(projectId, name) => {
            addTask(projectId, name, composerInitialTabs())
            // The task is selected on create; expand its project so switching back
            // to the tree doesn't hide the thing you just made.
            setProjectExpanded(projectId, true)
            setNewTaskOpen(false)
          }}
          onCreateWorkspace={(projectId, name, workspace) => {
            addWorkspaceTask(projectId, name, workspace, composerInitialTabs())
            setProjectExpanded(projectId, true)
            setNewTaskOpen(false)
          }}
          onClose={() => setNewTaskOpen(false)}
        />
      )}

      {workspaceModalProjectId && (() => {
        const project = projects.find(p => p.id === workspaceModalProjectId)
        if (!project) return null
        return (
          <CreateWorkspaceModal
            projectDir={getProjectDir(project)}
            projectId={isRemoteProject(project) ? project.id : undefined}
            sshConfig={project.ssh}
            onAdd={(name, workspace) => {
              addWorkspaceTask(workspaceModalProjectId, name, workspace)
              setWorkspaceModalProjectId(null)
            }}
            onCancel={() => setWorkspaceModalProjectId(null)}
          />
        )
      })()}

      <div
        className="absolute right-0 top-0 bottom-0 w-[3px] cursor-col-resize hover:bg-accent active:bg-accent transition-colors duration-(--motion-fast) [-webkit-app-region:no-drag]"
        onMouseDown={resizeHandle.onMouseDown}
      />
    </div>
  )
}
