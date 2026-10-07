import React, { useMemo, useState } from 'react'
import { AlarmClockOff, Check, ChevronRight, Clock, Inbox as InboxIcon, SquarePen, X } from 'lucide-react'
import type { AppConfig, Project, Task } from '../../shared/types'
import { isEphemeralProject } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { RowActions, RowAction } from './ui'
import ProjectTileBadge from './ProjectTileBadge'
import {
  formatRelativeAge,
  formatWaitTime,
  groupInboxByProject,
  inboxSources,
  inboxState,
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
}

type GroupKey = 'needsYou' | 'yourTurn' | 'working' | 'quiet' | 'settled' | 'snoozed'

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
  if (entry.status === 'exited') return agent.line ? `exited · ${agent.line}` : 'exited'
  if (agent.line) return agent.line
  return lastActivityAt(entry.task) > 0 ? null : 'no activity yet'
}

/**
 * Rows waiting on you get a left bar and a faint tint, so "your move" reads at a
 * glance whether or not you have already looked. Amber for a blocked agent
 * (question, permission), accent for one that finished and is waiting for your
 * reply. The bar is an inset shadow so it does not shift the row's content.
 */
function turnClass(status: TabStatusValue, yourTurn: boolean, selected: boolean): string {
  if (!yourTurn) return ''
  if (status === 'attention') {
    return `shadow-[inset_2px_0_0_var(--color-status-attention)] ${selected ? '' : 'bg-status-attention/10'}`
  }
  return `shadow-[inset_2px_0_0_var(--color-accent)] ${selected ? '' : 'bg-accent/10'}`
}

const TILE = 16

function InboxRow({
  entry,
  group,
  agent,
  selected,
  now,
  theme,
  showProject,
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
  /** Tile and project name on the first line; the grouped layout's header says it instead. */
  showProject: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSettle: () => void
  onSnooze: (e: React.MouseEvent) => void
  onClose: () => void
}): React.ReactElement {
  const { task, project, stream, unread, yourTurn } = entry
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
          title={group === 'settled' ? 'Unsettle' : 'Settle'}
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
  const indent = showProject ? 'pl-[22px]' : ''

  return (
    <div
      className={[
        'group mx-1.5 px-2 py-1.5 rounded-md cursor-pointer text-sm text-text',
        'transition-colors duration-(--motion-fast)',
        turnClass(entry.status, yourTurn, selected),
        working && !selected ? 'opacity-50 hover:opacity-100' : '',
        selected ? 'bg-sel' : 'hover:bg-surface-3'
      ].join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={agent.tooltip}
      data-testid="inbox-row"
      data-task-id={task.id}
    >
      {placeLine && (
        <div className="flex items-center gap-1.5 min-h-[18px]">
          {showProject && <ProjectTileBadge project={project} theme={theme} size={TILE} />}
          <span
            className="flex items-center gap-1 min-w-0 flex-1 text-xs text-text-muted overflow-hidden whitespace-nowrap"
            data-testid="inbox-row-place"
          >
            {showProject && (
              <span
                className="font-semibold text-text overflow-hidden text-ellipsis min-w-0 shrink-0 max-w-[60%]"
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
  )
}

/** The grouped layout's header: the project's tile and name. */
function ProjectHeader({ project, theme, count }: { project: Project; theme: 'dark' | 'light'; count: number }): React.ReactElement {
  return (
    <div
      className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-xs overflow-hidden whitespace-nowrap"
      data-testid="inbox-project-header"
    >
      <ProjectTileBadge project={project} theme={theme} size={TILE} />
      <span className="font-semibold text-text overflow-hidden text-ellipsis min-w-0">{project.name}</span>
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
        'flex items-center gap-1 px-3 pt-2 pb-1 text-2xs font-bold uppercase tracking-[0.06em] text-text-muted',
        collapsible ? 'cursor-pointer hover:text-text transition-colors duration-(--motion-fast)' : ''
      ].join(' ')}
      onClick={onToggle}
      data-testid="inbox-group-header"
    >
      {collapsible && (
        <ChevronRight
          size={11}
          className={`transition-transform duration-(--motion-fast) ${collapsed ? '' : 'rotate-90'}`}
        />
      )}
      <span>{label}</span>
      <span className="text-text-subtle font-normal">{count}</span>
    </div>
  )
}

export default function InboxPanel({
  projects,
  selectedTaskId,
  onSelectTask,
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
  layout = 'flat'
}: Props): React.ReactElement {
  // Fold state lives with the panel, as it always has for Settled and Snoozed.
  const [folded, setFolded] = useState<Record<'working' | 'quiet' | 'settled' | 'snoozed', boolean>>({
    working: true,
    quiet: false,
    settled: true,
    snoozed: true
  })
  const toggle = (key: keyof typeof folded) => setFolded(prev => ({ ...prev, [key]: !prev[key] }))

  const partition = useMemo(
    () => partitionInbox(inboxSources(projects), allStatuses, statusSince, now),
    [projects, allStatuses, statusSince, now]
  )
  const grouped = layout === 'grouped'
  // Grouped: the rows that want or might want you, by project. Working, Settled and
  // Snoozed stay folded sections below, as in the flat list.
  const projectGroups = useMemo(
    () => (grouped ? groupInboxByProject([...partition.needsYou, ...partition.yourTurn, ...partition.quiet]) : []),
    [grouped, partition]
  )

  const total = Object.values(partition).reduce((sum, entries) => sum + entries.length, 0)

  const groupOf = (entry: InboxEntry): GroupKey =>
    entry.status === 'attention' ? 'needsYou' : entry.yourTurn ? 'yourTurn' : 'quiet'

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
            <ProjectHeader project={project} theme={theme} count={entries.length} />
            {entries.map(entry => renderRow(entry, groupOf(entry), false))}
          </div>
        ))}
        {section('Working', 'working', partition.working, 'working')}
      </>) : (<>
        {section('Needs you', 'needsYou', partition.needsYou)}
        {section('Your turn', 'yourTurn', partition.yourTurn)}
        {section('Working', 'working', partition.working, 'working')}
        {section('Quiet', 'quiet', partition.quiet, 'quiet')}
      </>)}

      {section('Settled', 'settled', partition.settled, 'settled')}
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
