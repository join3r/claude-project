import React, { useMemo, useState } from 'react'
import { AlarmClockOff, Check, Clock, Cog, Inbox as InboxIcon, MoreHorizontal, Plus, Server, SquarePen, TriangleAlert, X } from 'lucide-react'
import type { AppConfig, Project, Task } from '../../shared/types'
import { isEphemeralProject } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { RowActions, RowAction } from './ui'
import ProjectTileBadge from './ProjectTileBadge'
import { StateDot, TreeChevron } from './sidebar/SidebarParts'
import { rollUpState, sidebarTaskState, type SidebarTaskState } from './sidebar/streamTree'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import { projectTasks } from '../../shared/streams'
import {
  formatRelativeAge,
  formatWaitTime,
  groupInboxByProject,
  inboxSources,
  inboxState,
  landingStatusLabel,
  lastActivityAt,
  partitionInbox,
  taskActivity,
  type InboxEntry,
  type TaskActivitySummary
} from './inbox'
import type { AgentActivity } from '../../shared/agent-activity'
import { serverName, useServersState } from '../serversState'

type Props = {
  projects: Project[]
  selectedTaskId: string | null
  onSelectTask: (projectId: string, task: Task) => void
  /** Grouped layout: a project header opens that project's home page. */
  onOpenProject?: (projectId: string) => void
  /** The project whose home page is showing (no task selected), highlighted in the grouped layout. */
  selectedProjectHomeId?: string | null
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  /** Snooze (opens the presets at the click) or, on a snoozed row, wake it now. */
  onSnooze: (e: React.MouseEvent, projectId: string, taskId: string) => void
  /** The row's ✓: closes the task, landing a worktree task first (`useCloseTask`). */
  onClose: (projectId: string, taskId: string) => void
  /** The row's ✕: removes the task and, after a confirm, its worktree's changes unlanded. */
  onRemove: (projectId: string, taskId: string) => void
  onNewTask: () => void
  /** Grouped layout: a project header's menu (right-click or its ⋯), at `at`. */
  onProjectMenu?: (at: MenuAnchor, projectId: string) => void
  /** Grouped layout: the menu of a stream named on its project's "also:" line. */
  onStreamMenu?: (at: MenuAnchor, projectId: string, streamId: string) => void
  /** Grouped layout: a project header's cog. */
  onProjectSettings?: (projectId: string) => void
  /** Grouped layout: a project header's +, a new task in that project. */
  onNewTaskIn?: (projectId: string) => void
  /** Grouped layout: what a project header shows of its streams' apps (the ▶ badge). */
  projectBadge?: (project: Project) => React.ReactNode
  allStatuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  activities: Record<string, AgentActivity>
  now: number
  theme: 'dark' | 'light'
  /** Settings → Sidebar: one list (default), or the open rows gathered by project. */
  layout?: AppConfig['inboxLayout']
  /** Project tiles beside project names (Settings → Show project icons). */
  showIcons?: boolean
  /** Pinned projects in pin order; the grouped layout puts their groups first. */
  pinnedProjectIds?: readonly string[]
  /** Shown above everything, even an empty Inbox: the running and crashed apps (`InboxApps`). */
  apps?: React.ReactNode
  /** What a row shows of its stream's app (the ▶ badge). */
  rowBadge?: (entry: InboxEntry) => React.ReactNode
  /** Projects whose folder is gone: a "folder missing" warning on their rows and header. */
  missingDirIds?: ReadonlySet<string>
  /** The "folder missing" warning's click: what the tree's badge does (Project settings). */
  onFixMissingDir?: (projectId: string) => void
  /** A DevTool server's project whose server isn't online: warned about and dimmed, like the tree. */
  isUnreachable?: (project: Project) => boolean
  /** The task being renamed in place (the row menu's Rename), with the name typed so far. */
  rename?: InboxRename | null
}

/** An Inbox row's name being edited: the input's value and what Enter, blur and Escape do. */
export interface InboxRename {
  taskId: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

type GroupKey = 'needsYou' | 'ready' | 'working' | 'snoozed'

/**
 * Third line of a row: what the task needs or is doing, or when it wakes. Blocked
 * tasks show how long they have been waiting rather than how old the last message
 * is — the wait is the thing you are triaging on. Claude tabs say what the agent
 * is actually doing or asking (agent-activity.ts). Null when there is nothing to
 * add to the age on the first line.
 */
function rowSubtitle(entry: InboxEntry, now: number, group: GroupKey, agent: TaskActivitySummary): string | null {
  const inbox = inboxState(entry.task)

  if (group === 'snoozed') {
    if (inbox.snoozeUntilAttention) return 'snoozed until it needs you'
    if (typeof inbox.snoozedUntil === 'number') {
      return `snoozed for ${formatWaitTime(inbox.snoozedUntil - now)}`
    }
    return 'snoozed'
  }

  if (entry.status === 'attention') {
    const what = agent.line ?? 'needs you'
    return entry.since !== null ? `${what} · waiting ${formatWaitTime(now - entry.since)}` : what
  }
  if (entry.status === 'working') {
    const what = agent.line ?? 'working'
    return entry.since !== null ? `${what} · ${formatWaitTime(now - entry.since)}` : what
  }
  const landing = landingStatusLabel(entry.task.landing, entry.stream.name)
  if (landing) return landing
  if (entry.status === 'exited') return agent.line ? `exited · ${agent.line}` : 'exited'
  if (agent.line) return agent.line
  return lastActivityAt(entry.task) > 0 ? null : 'no activity yet'
}

const TILE = 16

/** The tree's inline rename input. */
const renameInputCls = 'bg-field border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none w-full'

/** "folder missing" and "server offline" after a project's name: what the tree's badges say. */
function ProjectWarnings({ project, missing, unreachable, onFixMissing }: {
  project: Project
  missing: boolean
  unreachable: boolean
  onFixMissing?: () => void
}): React.ReactElement | null {
  if (!missing && !unreachable) return null
  return (
    <>
      {missing && (
        <button
          type="button"
          className="flex items-center gap-1 shrink-0 px-1 py-px rounded-sm border border-danger/40 bg-transparent text-2xs text-danger cursor-pointer hover:bg-danger/10"
          title={`Folder not found: ${project.directory}\nClick to pick its new location.`}
          data-testid="inbox-missing-dir"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onFixMissing?.() }}
        >
          <TriangleAlert size={10} aria-hidden />
          folder missing
        </button>
      )}
      {unreachable && project.host && <ServerOfflineBadge serverId={project.host} />}
    </>
  )
}

const SERVER_STATE_WORDS: Record<string, string> = {
  offline: 'server offline',
  connecting: 'connecting',
  incompatible: 'server needs an update',
  updating: 'server updating'
}

function ServerOfflineBadge({ serverId }: { serverId: string }): React.ReactElement {
  const state = useServersState()
  const kind = state.servers.find(s => s.id === serverId)?.state ?? 'offline'
  return (
    <span
      className="flex items-center gap-1 shrink-0 px-1 py-px rounded-sm border border-hair text-2xs text-text-muted font-normal"
      title={`On ${serverName(serverId, state)} (${kind})`}
      data-testid="inbox-server-offline"
    >
      <Server size={10} aria-hidden />
      {SERVER_STATE_WORDS[kind] ?? 'server offline'}
    </span>
  )
}
const NO_PINS: readonly string[] = []

/** The row's dot: the sidebar's colours for the same states. In Ready only the rows waiting on your reply get one. */
function rowState(group: GroupKey, entry: InboxEntry): SidebarTaskState {
  switch (group) {
    case 'needsYou': return 'attention'
    case 'working': return 'working'
    case 'ready': return entry.yourTurn ? 'unread' : null
    default: return null
  }
}

function InboxRow({
  entry,
  group,
  agent,
  selected,
  now,
  theme,
  showProject,
  showIcon,
  onSelect,
  onContextMenu,
  onSnooze,
  onClose,
  onRemove,
  badge,
  warnings,
  dimmed = false,
  rename
}: {
  entry: InboxEntry
  group: GroupKey
  agent: TaskActivitySummary
  selected: boolean
  now: number
  theme: 'dark' | 'light'
  /** Project name on the first line; the grouped layout's header says it instead. */
  showProject: boolean
  /** The project's tile beside its name (Settings → Show project icons). */
  showIcon: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSnooze: (e: React.MouseEvent) => void
  onClose: () => void
  onRemove: () => void
  /** The stream's app badge (▶). */
  badge?: React.ReactNode
  /** The project's warnings (folder missing, server offline), after its name. */
  warnings?: React.ReactNode
  /** The project's server isn't online. */
  dimmed?: boolean
  /** Set while this row's name is being edited in place. */
  rename?: InboxRename
}): React.ReactElement {
  const { task, project, stream, unread } = entry
  const activity = lastActivityAt(task)
  const working = group === 'working'
  const needsYou = group === 'needsYou'
  const ephemeral = isEphemeralProject(project)
  const showStream = !stream.isMain
  // Under a project header a main-stream row has no place to show: the task leads.
  const placeLine = showProject || showStream
  const subtitle = rowSubtitle(entry, now, group, agent)

  const trailing = (
    <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
      {badge}
      <RowActions>
        <RowAction title="Close task" onClick={onClose}>
          <Check size={13} />
        </RowAction>
        <RowAction title={group === 'snoozed' ? 'Wake now' : 'Snooze…'} onClick={onSnooze}>
          {group === 'snoozed' ? <AlarmClockOff size={13} /> : <Clock size={13} />}
        </RowAction>
        <RowAction danger title="Remove task" onClick={onRemove}>
          <X size={13} />
        </RowAction>
      </RowActions>
      <span className="text-2xs text-text-subtle tabular-nums pl-1" data-testid="inbox-row-age">
        {activity > 0 ? formatRelativeAge(now - activity) : ''}
      </span>
    </span>
  )

  // Lines two and three line up with the project name, past the tile.
  const indent = showProject && showIcon ? 'pl-[22px]' : ''

  return (
    <div
      className={[
        'group flex gap-2 mx-1.5 px-2 py-1.5 rounded-md cursor-pointer text-sm text-text',
        'transition-colors duration-(--motion-fast)',
        working && !selected ? 'opacity-50 hover:opacity-100' : dimmed && !selected ? 'opacity-55 hover:opacity-100' : '',
        selected ? 'bg-sel' : 'hover:bg-surface-3'
      ].join(' ')}
      onClick={rename ? undefined : onSelect}
      onContextMenu={onContextMenu}
      title={rename ? undefined : agent.tooltip}
      data-server-offline={dimmed ? 'true' : undefined}
      data-testid="inbox-row"
      data-task-id={task.id}
    >
      <span className="flex items-center h-[18px] shrink-0"><StateDot state={rowState(group, entry)} hollow /></span>
      <div className="flex-1 min-w-0">
      {placeLine && (
        <div className="flex items-center gap-1.5 min-h-[18px]">
          {showProject && showIcon && <ProjectTileBadge project={project} theme={theme} size={TILE} />}
          <span
            className="flex items-center gap-1 min-w-0 flex-1 text-xs text-text-muted overflow-hidden whitespace-nowrap"
            data-testid="inbox-row-place"
          >
            {showProject && (
              <span
                className="text-base font-semibold text-text overflow-hidden text-ellipsis min-w-0 shrink-0 max-w-[60%]"
                title={ephemeral ? project.directory : undefined}
              >
                {project.name}
              </span>
            )}
            {showProject && showStream && <span className="text-text-subtle shrink-0">›</span>}
            {showStream && <span className="overflow-hidden text-ellipsis min-w-0">{stream.name}</span>}
            {/* This task borrowed a directory rather than living in a project you added. */}
            {showProject && ephemeral && (
              <span
                className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0"
                title={project.directory}
              >dir</span>
            )}
          </span>
          {trailing}
        </div>
      )}
      <div className={`flex items-center gap-1.5 ${indent}`}>
        {rename ? (
          <input
            autoFocus
            aria-label="Task name"
            className={renameInputCls}
            value={rename.value}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => rename.onChange(e.target.value)}
            onBlur={rename.onSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename.onSubmit()
              if (e.key === 'Escape') rename.onCancel()
            }}
            data-testid="inbox-row-rename"
          />
        ) : (
        <span
          className={[
            'overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0',
            // Unread rows lift the name — the tint alone is easy to miss in a long list.
            unread ? 'font-semibold text-text' : 'text-text'
          ].join(' ')}
          data-testid="inbox-row-name"
        >
          {task.name}
        </span>
        )}
        {/* Under the project's name line, so hover actions never cover them. */}
        {showProject && warnings && <span className="flex items-center gap-1 shrink-0">{warnings}</span>}
        {!placeLine && !rename && trailing}
      </div>
      {subtitle && (
        <div
          className={[
            'text-2xs overflow-hidden text-ellipsis whitespace-nowrap',
            indent,
            needsYou ? 'text-status-attention' : 'text-text-subtle'
          ].join(' ')}
          data-testid="inbox-row-need"
        >
          {subtitle}
        </div>
      )}
      </div>
    </div>
  )
}

/** Where a button's dropdown opens: under it, at its left edge. */
function belowAnchor(e: React.MouseEvent): MenuAnchor {
  const rect = e.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

/**
 * The grouped layout's header: the project's tile and name, its rolled-up
 * state and app badge. Clicking it opens the project's home page; right-click
 * or ⋯ opens the project's menu, and hovering offers + Task and its settings.
 */
function ProjectHeader({ project, theme, count, showIcon, selected, state, badge, warnings, dimmed = false, onOpen, onMenu, onSettings, onNewTask }: {
  project: Project
  warnings?: React.ReactNode
  dimmed?: boolean
  theme: 'dark' | 'light'
  count: number
  showIcon: boolean
  selected: boolean
  state: SidebarTaskState
  badge?: React.ReactNode
  onOpen?: () => void
  onMenu?: (at: MenuAnchor) => void
  onSettings?: () => void
  onNewTask?: () => void
}): React.ReactElement {
  return (
    <div
      className={[
        'group flex items-center gap-1.5 mx-1.5 mt-1.5 px-1.5 py-1 rounded-md text-xs overflow-hidden whitespace-nowrap',
        onOpen ? 'cursor-pointer transition-colors duration-(--motion-fast)' : '',
        selected ? 'bg-sel' : onOpen ? 'hover:bg-surface-3' : '',
        dimmed ? 'opacity-55' : ''
      ].join(' ')}
      onClick={onOpen}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onMenu({ x: e.clientX, y: e.clientY }) } : undefined}
      title={onOpen ? `Open ${project.name}` : undefined}
      data-testid="inbox-project-header"
      data-project-id={project.id}
    >
      {showIcon && <ProjectTileBadge project={project} theme={theme} size={TILE} />}
      <span className="text-base font-semibold text-text overflow-hidden text-ellipsis min-w-0">{project.name}</span>
      <span className="text-2xs text-text-subtle">{count}</span>
      {warnings}
      <span className="ml-auto flex items-center gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
        {badge}
        <StateDot state={state} hideOnHover />
        <RowActions>
          {onNewTask && (
            <RowAction title={`New task in ${project.name}`} onClick={onNewTask}>
              <Plus size={13} />
            </RowAction>
          )}
          {onSettings && (
            <RowAction title="Project settings" onClick={onSettings}>
              <Cog size={13} />
            </RowAction>
          )}
          {onMenu && (
            <RowAction title="Project actions" onClick={(e) => onMenu(belowAnchor(e))}>
              <MoreHorizontal size={13} />
            </RowAction>
          )}
        </RowActions>
      </span>
    </div>
  )
}

/**
 * Below a project's rows: its open streams that have nothing in the Inbox,
 * each opening its stream menu, so an empty stream is still in reach.
 */
function QuietStreamsLine({ project, shownStreamIds, onStreamMenu }: {
  project: Project
  shownStreamIds: ReadonlySet<string>
  onStreamMenu: (at: MenuAnchor, streamId: string) => void
}): React.ReactElement | null {
  const quiet = project.streams.filter(stream => !shownStreamIds.has(stream.id))
  if (quiet.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-1 mx-1.5 pl-[22px] pr-2 pt-0.5 pb-1 text-2xs text-text-subtle" data-testid="inbox-quiet-streams">
      <span>also:</span>
      {quiet.map((stream, index) => (
        <React.Fragment key={stream.id}>
          {index > 0 && <span aria-hidden>·</span>}
          <button
            type="button"
            className="bg-transparent border-0 p-0 font-mono text-2xs text-text-subtle cursor-pointer hover:text-text hover:underline"
            title={`${stream.name}: stream actions`}
            data-stream-id={stream.id}
            onClick={(e) => onStreamMenu(belowAnchor(e), stream.id)}
            onContextMenu={(e) => { e.preventDefault(); onStreamMenu({ x: e.clientX, y: e.clientY }, stream.id) }}
          >
            {stream.name}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export function GroupHeader({
  label,
  count,
  collapsible,
  collapsed,
  onToggle
}: {
  label: string
  count: number
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
}): React.ReactElement {
  return (
    <div
      className={[
        'flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-2xs uppercase tracking-[0.08em] text-text-subtle',
        collapsible ? 'cursor-pointer hover:text-text transition-colors duration-(--motion-fast)' : ''
      ].join(' ')}
      onClick={onToggle}
      data-testid="inbox-group-header"
    >
      {collapsible && <TreeChevron open={!collapsed} />}
      <span>{label}</span>
      <span className="tracking-normal tabular-nums">{count}</span>
    </div>
  )
}

export default function InboxPanel({
  projects,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  selectedProjectHomeId = null,
  onTaskContextMenu,
  onSnooze,
  onClose,
  onRemove,
  onNewTask,
  onProjectMenu,
  onStreamMenu,
  onProjectSettings,
  onNewTaskIn,
  projectBadge,
  allStatuses,
  statusSince,
  activities,
  now,
  theme,
  layout = 'flat',
  showIcons = false,
  pinnedProjectIds = NO_PINS,
  apps,
  rowBadge,
  missingDirIds,
  onFixMissingDir,
  isUnreachable,
  rename
}: Props): React.ReactElement {
  const warningsFor = (project: Project): React.ReactNode => {
    const missing = !!missingDirIds?.has(project.id)
    const unreachable = !!isUnreachable?.(project)
    if (!missing && !unreachable) return null
    return (
      <ProjectWarnings
        project={project}
        missing={missing}
        unreachable={unreachable}
        onFixMissing={onFixMissingDir ? () => onFixMissingDir(project.id) : undefined}
      />
    )
  }
  // Fold state lives with the panel, as it always has for Snoozed.
  // Ready and Working are never folded: Ready holds the replies you owe, and the
  // task you just sent a prompt to moves to Working and must stay in sight.
  const [folded, setFolded] = useState<Record<'snoozed', boolean>>({
    snoozed: true
  })
  const toggle = (key: keyof typeof folded) => setFolded(prev => ({ ...prev, [key]: !prev[key] }))

  const partition = useMemo(
    () => partitionInbox(inboxSources(projects), allStatuses, statusSince, now),
    [projects, allStatuses, statusSince, now]
  )
  const grouped = layout === 'grouped'
  // Grouped: the open groups by project. Snoozed stays a folded section below, as
  // in the flat list.
  const projectGroups = useMemo(
    () => (grouped
      ? groupInboxByProject([...partition.needsYou, ...partition.ready, ...partition.working], pinnedProjectIds)
      : []),
    [grouped, partition, pinnedProjectIds]
  )

  const total = Object.values(partition).reduce((sum, entries) => sum + entries.length, 0)

  const groupOf = (entry: InboxEntry): GroupKey =>
    entry.status === 'attention' ? 'needsYou' : entry.status === 'working' ? 'working' : 'ready'

  const renderRow = (entry: InboxEntry, group: GroupKey, showProject = true): React.ReactElement => (
    <InboxRow
      key={entry.task.id}
      entry={entry}
      group={group}
      agent={taskActivity(entry.task, allStatuses, activities)}
      selected={selectedTaskId === entry.task.id}
      now={now}
      theme={theme}
      showProject={showProject}
      showIcon={showIcons}
      onSelect={() => onSelectTask(entry.project.id, entry.task)}
      onContextMenu={(e) => onTaskContextMenu(e, entry.project.id, entry.task.id)}
      onSnooze={(e) => onSnooze(e, entry.project.id, entry.task.id)}
      onClose={() => onClose(entry.project.id, entry.task.id)}
      onRemove={() => onRemove(entry.project.id, entry.task.id)}
      badge={rowBadge?.(entry)}
      warnings={warningsFor(entry.project)}
      dimmed={!!isUnreachable?.(entry.project)}
      rename={rename?.taskId === entry.task.id ? rename : undefined}
    />
  )

  const section = (label: string, key: GroupKey, entries: InboxEntry[], foldKey?: keyof typeof folded) => {
    if (entries.length === 0) return null
    const collapsed = foldKey ? folded[foldKey] : false
    return (
      <div data-testid={`inbox-group-${key}`}>
        <GroupHeader
          label={label}
          count={entries.length}
          collapsible={!!foldKey}
          collapsed={collapsed}
          onToggle={foldKey ? () => toggle(foldKey) : undefined}
        />
        {!collapsed && entries.map(entry => renderRow(entry, key))}
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className="sidebar-list flex-1 overflow-y-auto py-1">
        {apps}
        <div className="flex flex-col items-center gap-2 p-6 text-text-muted text-sm text-center">
          <InboxIcon size={20} />
          <span>Nothing in the inbox yet</span>
          <button
            type="button"
            onClick={onNewTask}
            className="mt-1 flex items-center gap-1 bg-transparent border-0 cursor-pointer text-xs text-text-subtle hover:text-text transition-colors duration-(--motion-fast)"
          >
            <SquarePen size={12} /> New task
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar-list flex-1 overflow-y-auto py-1">
      {apps}
      {grouped ? (<>
        {projectGroups.map(({ project, entries }) => (
          <div key={project.id} data-testid="inbox-project-group">
            <ProjectHeader
              project={project}
              theme={theme}
              count={entries.length}
              showIcon={showIcons}
              selected={selectedProjectHomeId === project.id}
              state={rollUpState(projectTasks(project).map(task => sidebarTaskState(task, allStatuses, now)))}
              badge={projectBadge?.(project)}
              warnings={warningsFor(project)}
              dimmed={!!isUnreachable?.(project)}
              onOpen={onOpenProject ? () => onOpenProject(project.id) : undefined}
              onMenu={onProjectMenu && !isEphemeralProject(project) ? (at) => onProjectMenu(at, project.id) : undefined}
              onSettings={onProjectSettings && !isEphemeralProject(project) ? () => onProjectSettings(project.id) : undefined}
              onNewTask={onNewTaskIn && !isEphemeralProject(project) ? () => onNewTaskIn(project.id) : undefined}
            />
            {entries.map(entry => renderRow(entry, groupOf(entry), false))}
            {onStreamMenu && !isEphemeralProject(project) && (
              <QuietStreamsLine
                project={project}
                shownStreamIds={new Set(entries.map(entry => entry.stream.id))}
                onStreamMenu={(at, streamId) => onStreamMenu(at, project.id, streamId)}
              />
            )}
          </div>
        ))}
      </>) : (<>
        {section('Needs you', 'needsYou', partition.needsYou)}
        {section('Ready', 'ready', partition.ready)}
        {section('Working', 'working', partition.working)}
      </>)}

      {section('Snoozed', 'snoozed', partition.snoozed, 'snoozed')}
      {partition.snoozed.length > 0 && folded.snoozed && (
        <div className="px-3 pb-2 text-2xs text-text-subtle flex items-center gap-1">
          <Clock size={10} />
          <span>{partition.snoozed.length} hidden until they wake</span>
        </div>
      )}
    </div>
  )
}
