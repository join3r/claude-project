import React, { useMemo, useState } from 'react'
import { Check, ChevronRight, Clock, Inbox as InboxIcon, SquarePen, X } from 'lucide-react'
import type { AppConfig, Project, Task } from '../../shared/types'
import { isEphemeralProject } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { RowActions, RowAction } from './ui'
import {
  formatRelativeAge,
  formatWaitTime,
  groupInboxByStream,
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
  /** Archives the task, with the sidebar's confirm rules (`handleCloseTask`). */
  onClose: (projectId: string, taskId: string) => void
  onNewTask: () => void
  allStatuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  activities: Record<string, AgentActivity>
  now: number
  /** Settings → Sidebar: working rows sink to the bottom of their group. */
  workingLast?: boolean
  /** Settings → Sidebar: one list (default), or the live rows gathered by stream. */
  layout?: AppConfig['inboxLayout']
}

const STATUS_LABEL: Record<NonNullable<TabStatusValue>, string> = {
  working: 'working',
  attention: 'needs you',
  exited: 'exited'
}

/**
 * `null` means unread with no live status — after a restart nothing is running, so
 * most rows land here. It gets its own neutral colour rather than borrowing the
 * attention one, otherwise "the agent finished" and "the agent is blocked" look
 * identical and the amber stops meaning anything.
 */
function StatusDot({ status }: { status: TabStatusValue }): React.ReactElement {
  // Working rows never get here: InboxRow drops the dot while the agent runs.
  const stateClass =
    status === 'attention'
      ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
      : status === 'exited'
        ? 'bg-status-exited'
        : 'bg-accent'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateClass}`} />
}

/**
 * Second line of a row: what the task is doing, or when it wakes. Blocked tasks
 * show how long they have been waiting rather than how old the last message is —
 * the wait is the thing you are triaging on. Claude tabs replace the bare status
 * word with what the agent is actually doing or asking (agent-activity.ts).
 */
function rowSubtitle(entry: InboxEntry, now: number, group: GroupKey, agent: TaskActivitySummary): string {
  const inbox = inboxState(entry.task)

  if (group === 'snoozed') {
    if (inbox.snoozeUntilAttention) return 'snoozed until it needs you'
    if (typeof inbox.snoozedUntil === 'number') {
      return `snoozed for ${formatWaitTime(inbox.snoozedUntil - now)}`
    }
    return 'snoozed'
  }

  if (entry.status === 'attention' && entry.since !== null) {
    return `${agent.line ?? 'needs you'} · waiting ${formatWaitTime(now - entry.since)}`
  }
  if (entry.status === 'working' && entry.since !== null) {
    return `${agent.line ?? 'working'} · ${formatWaitTime(now - entry.since)}`
  }
  if (entry.status === 'exited') return STATUS_LABEL.exited
  if (agent.line) return agent.line
  if (entry.status) return STATUS_LABEL[entry.status]

  const activity = lastActivityAt(entry.task)
  return activity > 0 ? `last activity ${formatRelativeAge(now - activity)} ago` : 'no activity yet'
}

type GroupKey = 'needsYou' | 'active' | 'settled' | 'snoozed'

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

function InboxRow({
  entry,
  group,
  agent,
  selected,
  now,
  showLocation,
  onSelect,
  onContextMenu,
  onSettle,
  onClose
}: {
  entry: InboxEntry
  group: GroupKey
  agent: TaskActivitySummary
  selected: boolean
  now: number
  /** The `Project · Stream` line; the grouped layout's header says it instead. */
  showLocation: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSettle: () => void
  onClose: () => void
}): React.ReactElement {
  const { task, project, stream, unread, yourTurn } = entry
  const activity = lastActivityAt(task)
  // The agent has the ball: nothing for you to do yet, so the row recedes and
  // drops its dot rather than pulsing for attention it does not need.
  const working = entry.status === 'working'
  const ephemeral = isEphemeralProject(project)

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
      <div className="flex items-center gap-1.5">
        {!working && (unread || entry.status || yourTurn)
          ? <StatusDot status={entry.status} />
          : <span className="w-1.5 shrink-0" />}
        <span
          className={[
            'overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0',
            // Unread rows lift the name out of the muted grey — the dot alone
            // is easy to miss in a long list.
            unread ? 'font-semibold text-text' : 'text-text-muted'
          ].join(' ')}
        >
          {task.name}
        </span>
        <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <RowActions>
            <RowAction
              title={group === 'settled' ? 'Unsettle' : 'Settle'}
              on={group === 'settled'}
              onClick={onSettle}
            >
              <Check size={13} />
            </RowAction>
            <RowAction danger title="Close task" onClick={onClose}>
              <X size={13} />
            </RowAction>
          </RowActions>
          <span className="text-2xs text-text-subtle tabular-nums pl-1">
            {activity > 0 ? formatRelativeAge(now - activity) : ''}
          </span>
        </span>
      </div>
      {showLocation && (
        <div
          className="pl-3 flex items-center gap-1 text-2xs text-text-muted overflow-hidden whitespace-nowrap"
          data-testid="inbox-row-location"
        >
          <span className="overflow-hidden text-ellipsis min-w-0" title={ephemeral ? project.directory : undefined}>
            {project.name}
          </span>
          <span className="text-text-subtle shrink-0">·</span>
          <span className="font-mono overflow-hidden text-ellipsis min-w-0">{stream.name}</span>
          {/* This task borrowed a directory rather than living in a project you added. */}
          {ephemeral && (
            <span
              className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0"
              title={project.directory}
            >dir</span>
          )}
        </div>
      )}
      <div className="pl-3 text-2xs text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap">
        {rowSubtitle(entry, now, group, agent)}
      </div>
    </div>
  )
}

/** The grouped layout's header: the project, then the stream. */
function StreamHeader({ project, stream }: Pick<InboxEntry, 'project' | 'stream'>): React.ReactElement {
  return (
    <div
      className="flex items-baseline gap-2 px-3 pt-2 pb-1 text-2xs text-text-muted overflow-hidden whitespace-nowrap"
      data-testid="inbox-stream-header"
    >
      <span className="font-bold uppercase tracking-[0.06em] overflow-hidden text-ellipsis min-w-0">{project.name}</span>
      <span className="ml-auto font-mono shrink-0 max-w-[50%] overflow-hidden text-ellipsis">{stream.name}</span>
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
  onClose,
  onNewTask,
  allStatuses,
  statusSince,
  activities,
  now,
  workingLast = false,
  layout = 'flat'
}: Props): React.ReactElement {
  const [settledCollapsed, setSettledCollapsed] = useState(true)
  const [snoozedCollapsed, setSnoozedCollapsed] = useState(true)

  const partition = useMemo(
    () => partitionInbox(inboxSources(projects), allStatuses, statusSince, now, { workingLast }),
    [projects, allStatuses, statusSince, now, workingLast]
  )
  const grouped = layout === 'grouped'
  const streamGroups = useMemo(
    () => (grouped ? groupInboxByStream([...partition.needsYou, ...partition.active]) : []),
    [grouped, partition]
  )

  const total =
    partition.needsYou.length + partition.active.length +
    partition.settled.length + partition.snoozed.length

  const renderRow = (entry: InboxEntry, group: GroupKey, showLocation = true): React.ReactElement => (
    <InboxRow
      key={entry.task.id}
      entry={entry}
      group={group}
      agent={taskActivity(entry.task, allStatuses, activities)}
      selected={selectedTaskId === entry.task.id}
      now={now}
      showLocation={showLocation}
      onSelect={() => onSelectTask(entry.project.id, entry.task)}
      onContextMenu={(e) => onTaskContextMenu(e, entry.project.id, entry.task.id)}
      onSettle={() => onSettle(entry.project.id, entry.task.id)}
      onClose={() => onClose(entry.project.id, entry.task.id)}
    />
  )

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
      {grouped ? (
        // Grouped: the live rows by stream; settled and snoozed stay below as in flat.
        streamGroups.map(({ project, stream, entries }) => (
          <div key={`${project.id}:${stream.id}`} data-testid="inbox-stream-group">
            <StreamHeader project={project} stream={stream} />
            {entries.map(entry => renderRow(entry, entry.status === 'attention' ? 'needsYou' : 'active', false))}
          </div>
        ))
      ) : (<>
        {partition.needsYou.length > 0 && (
          <>
            <GroupHeader label="Needs you" count={partition.needsYou.length} />
            {partition.needsYou.map(entry => renderRow(entry, 'needsYou'))}
          </>
        )}

        {partition.active.length > 0 && (
          <div className={partition.needsYou.length > 0 ? 'mt-1 pt-1 border-t border-hair' : ''}>
            {partition.active.map(entry => renderRow(entry, 'active'))}
          </div>
        )}
      </>)}

      {partition.settled.length > 0 && (
        <>
          <GroupHeader
            label="Settled"
            count={partition.settled.length}
            collapsible
            collapsed={settledCollapsed}
            onToggle={() => setSettledCollapsed(v => !v)}
          />
          {!settledCollapsed && partition.settled.map(entry => renderRow(entry, 'settled'))}
        </>
      )}

      {partition.snoozed.length > 0 && (
        <>
          <GroupHeader
            label="Snoozed"
            count={partition.snoozed.length}
            collapsible
            collapsed={snoozedCollapsed}
            onToggle={() => setSnoozedCollapsed(v => !v)}
          />
          {!snoozedCollapsed && partition.snoozed.map(entry => renderRow(entry, 'snoozed'))}
        </>
      )}

      {partition.snoozed.length > 0 && snoozedCollapsed && (
        <div className="px-3 pb-2 text-2xs text-text-subtle flex items-center gap-1">
          <Clock size={10} />
          <span>{partition.snoozed.length} hidden until they wake</span>
        </div>
      )}
    </div>
  )
}
