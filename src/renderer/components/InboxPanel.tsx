import React, { useMemo, useState } from 'react'
import { Check, ChevronRight, Clock, Inbox as InboxIcon, SquarePen } from 'lucide-react'
import type { Project, Task } from '../../shared/types'
import { isHomeTask, isWorkspaceTask } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { RowActions, RowAction } from './ui'
import {
  formatRelativeAge,
  formatWaitTime,
  inboxState,
  lastActivityAt,
  partitionInbox,
  type InboxEntry
} from './inbox'

type Props = {
  projects: Project[]
  selectedTaskId: string | null
  onSelectTask: (projectId: string, task: Task) => void
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  onSettle: (projectId: string, taskId: string) => void
  onNewTask: () => void
  allStatuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
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
  const stateClass =
    status === 'working'
      ? 'bg-status-working animate-pulse'
      : status === 'attention'
        ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
        : status === 'exited'
          ? 'bg-status-exited'
          : 'bg-accent'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateClass}`} />
}

/**
 * Second line of a row: what the task is doing, or when it wakes. Blocked tasks
 * show how long they have been waiting rather than how old the last message is —
 * the wait is the thing you are triaging on.
 */
function rowSubtitle(entry: InboxEntry, now: number, group: GroupKey): string {
  const inbox = inboxState(entry.task)

  if (group === 'snoozed') {
    if (inbox.snoozeUntilAttention) return 'snoozed until it needs you'
    if (typeof inbox.snoozedUntil === 'number') {
      return `snoozed for ${formatWaitTime(inbox.snoozedUntil - now)}`
    }
    return 'snoozed'
  }

  if (entry.status === 'attention' && entry.since !== null) {
    return `needs you · waiting ${formatWaitTime(now - entry.since)}`
  }
  if (entry.status === 'working' && entry.since !== null) {
    return `working · ${formatWaitTime(now - entry.since)}`
  }
  if (entry.status) return STATUS_LABEL[entry.status]

  const activity = lastActivityAt(entry.task)
  return activity > 0 ? `last activity ${formatRelativeAge(now - activity)} ago` : 'no activity yet'
}

type GroupKey = 'needsYou' | 'active' | 'settled' | 'snoozed'

function InboxRow({
  entry,
  group,
  selected,
  now,
  onSelect,
  onContextMenu,
  onSettle
}: {
  entry: InboxEntry
  group: GroupKey
  selected: boolean
  now: number
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSettle: () => void
}): React.ReactElement {
  const { task, project, unread } = entry
  const activity = lastActivityAt(task)

  return (
    <div
      className={[
        'group mx-1.5 px-2 py-1.5 rounded-md cursor-pointer text-sm text-text',
        'transition-colors duration-(--motion-fast)',
        selected ? 'bg-sel' : 'hover:bg-surface-3'
      ].join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-center gap-1.5">
        {unread || entry.status
          ? <StatusDot status={entry.status} />
          : <span className="w-1.5 shrink-0" />}
        <span className="font-semibold shrink-0 max-w-[55%] overflow-hidden text-ellipsis whitespace-nowrap">
          {project.name}
        </span>
        <span
          className={[
            'text-xs overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0',
            // Unread rows lift the task name out of the muted grey — the dot alone
            // is easy to miss when a project has several rows.
            unread ? 'text-text' : 'text-text-muted'
          ].join(' ')}
        >
          {task.name}
        </span>
        {isWorkspaceTask(task) && (
          <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0">ws</span>
        )}
        <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <RowActions>
            <RowAction
              title={group === 'settled' ? 'Unsettle' : 'Settle'}
              on={group === 'settled'}
              onClick={onSettle}
            >
              <Check size={13} />
            </RowAction>
          </RowActions>
          <span className="text-2xs text-text-subtle tabular-nums pl-1">
            {activity > 0 ? formatRelativeAge(now - activity) : ''}
          </span>
        </span>
      </div>
      <div className="pl-3 text-2xs text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap">
        {rowSubtitle(entry, now, group)}
      </div>
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
  onNewTask,
  allStatuses,
  statusSince,
  now
}: Props): React.ReactElement {
  const [settledCollapsed, setSettledCollapsed] = useState(true)
  const [snoozedCollapsed, setSnoozedCollapsed] = useState(true)

  const partition = useMemo(() => {
    const entries: { task: Task; project: Project }[] = []
    for (const project of projects) {
      for (const task of project.tasks) {
        if (isHomeTask(task)) continue
        entries.push({ task, project })
      }
    }
    return partitionInbox(entries, allStatuses, statusSince, now)
  }, [projects, allStatuses, statusSince, now])

  const total =
    partition.needsYou.length + partition.active.length +
    partition.settled.length + partition.snoozed.length

  const renderRow = (entry: InboxEntry, group: GroupKey): React.ReactElement => (
    <InboxRow
      key={entry.task.id}
      entry={entry}
      group={group}
      selected={selectedTaskId === entry.task.id}
      now={now}
      onSelect={() => onSelectTask(entry.project.id, entry.task)}
      onContextMenu={(e) => onTaskContextMenu(e, entry.project.id, entry.task.id)}
      onSettle={() => onSettle(entry.project.id, entry.task.id)}
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
