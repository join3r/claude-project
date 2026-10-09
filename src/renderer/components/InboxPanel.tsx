import React, { useMemo, useState } from 'react'
import { AlarmClockOff, Check, Clock, Inbox as InboxIcon, SquarePen, X } from 'lucide-react'
import type { AppConfig, Project, Task } from '../../shared/types'
import { isEphemeralProject } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { RowActions, RowAction } from './ui'
import ProjectTileBadge from './ProjectTileBadge'
import { StateDot, TreeChevron } from './sidebar/SidebarParts'
import type { SidebarTaskState } from './sidebar/streamTree'
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

type Props = {
  projects: Project[]
  selectedTaskId: string | null
  onSelectTask: (projectId: string, task: Task) => void
  /** Grouped layout: a project header opens that project's home page. */
  onOpenProject?: (projectId: string) => void
  /** The project whose home page is showing (no task selected), highlighted in the grouped layout. */
  selectedProjectHomeId?: string | null
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  onSettle: (projectId: string, taskId: string) => void
  /** Snooze (opens the presets at the click) or, on a snoozed row, wake it now. */
  onSnooze: (e: React.MouseEvent, projectId: string, taskId: string) => void
  /** Archives the task, with the sidebar's confirm rules (`useCloseTask`). */
  onClose: (projectId: string, taskId: string) => void
  onNewTask: () => void
  allStatuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  activities: Record<string, AgentActivity>
  now: number
  theme: 'dark' | 'light'
  /** Settings → Sidebar: one list (default), or the open rows gathered by project. */
  layout?: AppConfig['inboxLayout']
  /** Project tiles beside project names (Settings → Show project icons). */
  showIcons?: boolean
}

type GroupKey = 'needsYou' | 'ready' | 'working' | 'settled' | 'snoozed'

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
  onSettle,
  onSnooze,
  onClose
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
  onSettle: () => void
  onSnooze: (e: React.MouseEvent) => void
  onClose: () => void
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
      <RowActions>
        <RowAction
          title={group === 'settled' ? 'Back to Inbox' : 'Done for now'}
          on={group === 'settled'}
          onClick={onSettle}
        >
          <Check size={13} />
        </RowAction>
        <RowAction title={group === 'snoozed' ? 'Wake now' : 'Snooze…'} onClick={onSnooze}>
          {group === 'snoozed' ? <AlarmClockOff size={13} /> : <Clock size={13} />}
        </RowAction>
        <RowAction danger title="Close task" onClick={onClose}>
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
        working && !selected ? 'opacity-50 hover:opacity-100' : '',
        selected ? 'bg-sel' : 'hover:bg-surface-3'
      ].join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={agent.tooltip}
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
        {!placeLine && trailing}
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

/** The grouped layout's header: the project's tile and name. Clicking it opens the project's home page. */
function ProjectHeader({ project, theme, count, showIcon, selected, onOpen }: {
  project: Project
  theme: 'dark' | 'light'
  count: number
  showIcon: boolean
  selected: boolean
  onOpen?: () => void
}): React.ReactElement {
  return (
    <div
      className={[
        'flex items-center gap-1.5 mx-1.5 mt-1.5 px-1.5 py-1 rounded-md text-xs overflow-hidden whitespace-nowrap',
        onOpen ? 'cursor-pointer transition-colors duration-(--motion-fast)' : '',
        selected ? 'bg-sel' : onOpen ? 'hover:bg-surface-3' : ''
      ].join(' ')}
      onClick={onOpen}
      title={onOpen ? `Open ${project.name}` : undefined}
      data-testid="inbox-project-header"
    >
      {showIcon && <ProjectTileBadge project={project} theme={theme} size={TILE} />}
      <span className="text-base font-semibold text-text overflow-hidden text-ellipsis min-w-0">{project.name}</span>
      <span className="text-2xs text-text-subtle">{count}</span>
    </div>
  )
}

function GroupHeader({
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
  onSettle,
  onSnooze,
  onClose,
  onNewTask,
  allStatuses,
  statusSince,
  activities,
  now,
  theme,
  layout = 'flat',
  showIcons = false
}: Props): React.ReactElement {
  // Fold state lives with the panel, as it always has for Snoozed and Done for now.
  // Ready and Working are never folded: Ready holds the replies you owe, and the
  // task you just sent a prompt to moves to Working and must stay in sight.
  const [folded, setFolded] = useState<Record<'settled' | 'snoozed', boolean>>({
    settled: true,
    snoozed: true
  })
  const toggle = (key: keyof typeof folded) => setFolded(prev => ({ ...prev, [key]: !prev[key] }))

  const partition = useMemo(
    () => partitionInbox(inboxSources(projects), allStatuses, statusSince, now),
    [projects, allStatuses, statusSince, now]
  )
  const grouped = layout === 'grouped'
  // Grouped: the open groups by project. Snoozed and Done for now stay folded sections
  // below, as in the flat list.
  const projectGroups = useMemo(
    () => (grouped
      ? groupInboxByProject([...partition.needsYou, ...partition.ready, ...partition.working])
      : []),
    [grouped, partition]
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
      onSettle={() => onSettle(entry.project.id, entry.task.id)}
      onSnooze={(e) => onSnooze(e, entry.project.id, entry.task.id)}
      onClose={() => onClose(entry.project.id, entry.task.id)}
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
      {grouped ? (<>
        {projectGroups.map(({ project, entries }) => (
          <div key={project.id} data-testid="inbox-project-group">
            <ProjectHeader
              project={project}
              theme={theme}
              count={entries.length}
              showIcon={showIcons}
              selected={selectedProjectHomeId === project.id}
              onOpen={onOpenProject ? () => onOpenProject(project.id) : undefined}
            />
            {entries.map(entry => renderRow(entry, groupOf(entry), false))}
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

      {section('Done for now', 'settled', partition.settled, 'settled')}
    </div>
  )
}
