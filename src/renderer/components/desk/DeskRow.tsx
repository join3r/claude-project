import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { Project } from '../../../shared/types'
import type { AgentActivity } from '../../../shared/agent-activity'
import ProjectTileBadge from '../ProjectTileBadge'
import {
  formatRelativeAge,
  formatWaitTime,
  inboxState,
  landingStatusLabel,
  lastActivityAt,
  type InboxEntry,
  type TaskActivitySummary
} from '../inbox'
import type { InboxRename } from '../InboxPanel'
import { wakeHint } from './deskSnooze'

/** Which list a row sits in; it decides the preview line and the hover actions. */
export type DeskRowKind = 'needsYou' | 'answered' | 'waiting' | 'working' | 'snoozed'

/** The newest activity among the task's status tabs, for the preview. */
export function bestActivity(entry: InboxEntry, activities: Record<string, AgentActivity>): AgentActivity | undefined {
  let best: AgentActivity | undefined
  for (const pane of entry.task.panes) {
    for (const tab of pane.tabs) {
      const activity = activities[tab.id]
      if (activity && (!best || activity.updatedAt > best.updatedAt)) best = activity
    }
  }
  return best
}

/**
 * The two preview lines: what the agent asks (amber lead-in), what it is doing
 * and for how long, when a snooze wakes, or the start of its last answer.
 */
function preview(kind: DeskRowKind, entry: InboxEntry, agent: TaskActivitySummary, activity: AgentActivity | undefined, now: number): {
  lead?: string
  text: string | null
} {
  const landing = landingStatusLabel(entry.task.landing, entry.stream.name)
  if (kind === 'needsYou') {
    if (landing) return { lead: 'Couldn’t land:', text: landing }
    const waiting = activity?.waiting
    if (waiting?.kind === 'permission') return { lead: 'Wants to:', text: waiting.label.replace(/^Permission:\s*/, '') }
    if (waiting?.kind === 'question' || waiting?.kind === 'plan') return { lead: 'Asks:', text: activity?.lastAnswer ?? waiting.label }
    if (waiting?.kind === 'error') return { lead: 'Stopped:', text: waiting.label }
    return { lead: 'Needs you:', text: agent.line ?? activity?.lastAnswer ?? null }
  }
  if (kind === 'working') {
    const elapsed = entry.since !== null ? ` · ${formatWaitTime(now - entry.since)}` : ''
    return { text: `${landing ?? agent.line ?? 'Working'}${elapsed}` }
  }
  if (kind === 'snoozed') {
    const inbox = inboxState(entry.task)
    const wake = inbox.snoozeUntilAttention
      ? 'Snoozed until it needs you'
      : typeof inbox.snoozedUntil === 'number' ? `Wakes ${wakeHint(inbox.snoozedUntil, true)}` : 'Snoozed'
    const answer = activity?.lastAnswer ?? entry.task.inbox?.preview ?? activity?.lastMessage
    return { text: answer ? `${wake} · ${answer}` : wake }
  }
  if (landing) return { text: landing }
  const answer = activity?.lastAnswer ?? entry.task.inbox?.preview ?? activity?.lastMessage
  if (answer) return { text: answer }
  if (entry.status === 'exited') return { text: 'The agent exited.' }
  return { text: lastActivityAt(entry.task) > 0 ? null : 'Not started yet.' }
}

const actionCls = 'px-2 py-1 rounded-md border-0 bg-border text-sm text-text cursor-pointer hover:bg-border-strong whitespace-nowrap'

export default function DeskRow({
  entry, kind, agent, activity, selected, now, theme, onSelect, onScopeProject, onContextMenu, onDone, onSnooze, onWake, onHover, rename
}: {
  entry: InboxEntry
  kind: DeskRowKind
  agent: TaskActivitySummary
  activity: AgentActivity | undefined
  selected: boolean
  now: number
  theme: 'dark' | 'light'
  onSelect: () => void
  /** The tile: narrow the column to this project. */
  onScopeProject: (project: Project) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDone: () => void
  onSnooze: (e: React.MouseEvent) => void
  onWake: () => void
  onHover: (taskId: string | null) => void
  rename?: InboxRename
}): React.ReactElement {
  const { task, project, stream } = entry
  const at = lastActivityAt(task)
  const { lead, text } = preview(kind, entry, agent, activity, now)
  const unread = entry.unread && kind !== 'working'
  return (
    <div
      className={[
        'group relative flex gap-3 mx-2 px-3 py-2.5 rounded-[9px] items-start cursor-pointer',
        'transition-colors duration-(--motion-fast)',
        selected ? 'bg-[#1f2126]' : 'hover:bg-[#1a1b1f]'
      ].join(' ')}
      onClick={rename ? undefined : onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(task.id)}
      onMouseLeave={() => onHover(null)}
      title={rename ? undefined : agent.tooltip}
      data-testid="desk-row"
      data-task-id={task.id}
      data-kind={kind}
    >
      <button
        type="button"
        className="shrink-0 p-0 border-0 bg-transparent cursor-pointer rounded-md"
        title={`Show only ${project.name}`}
        onClick={(e) => { e.stopPropagation(); onScopeProject(project) }}
      >
        <ProjectTileBadge project={project} theme={theme} size={24} />
      </button>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex justify-between gap-2 text-xs text-text-muted">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            <strong className="font-semibold text-[#d6d6d8]">{project.name}</strong>
            {!stream.isMain && <> › <span className="font-mono">{stream.name}</span></>}
          </span>
          <span className="shrink-0 tabular-nums flex items-center gap-1.5 group-hover:invisible">
            {kind === 'working' && <span className="w-[7px] h-[7px] rounded-full bg-status-working desk-pulse" aria-label="working" />}
            {unread && <span className="w-[7px] h-[7px] rounded-full bg-answered" aria-label="unread" />}
            {at > 0 ? formatRelativeAge(now - at) : ''}
          </span>
        </div>
        {rename ? (
          <input
            autoFocus
            aria-label="Task name"
            className="bg-field border border-border-focus text-text text-base px-1 py-px rounded-sm outline-none w-full"
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
          />
        ) : (
          <span className={`text-base text-text overflow-hidden text-ellipsis whitespace-nowrap ${unread || kind === 'needsYou' ? 'font-semibold' : 'font-medium'}`} data-testid="desk-row-title">
            {task.name}
          </span>
        )}
        {text && (
          <span className="text-sm leading-[1.45] text-text-muted line-clamp-2" data-testid="desk-row-preview">
            {lead && <span className="text-needs">{lead} </span>}
            {text}
          </span>
        )}
      </div>
      <div
        className="absolute right-2.5 top-2 hidden group-hover:flex gap-1 pl-2 bg-[#1f2126]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className={actionCls} title="Done: land the work and close (E)" onClick={onDone} data-testid="desk-row-done">✓ Done</button>
        {kind === 'snoozed'
          ? <button type="button" className={actionCls} title="Wake now (W)" onClick={onWake}>Wake</button>
          : <button type="button" className={actionCls} title="Snooze (S)" onClick={onSnooze} data-testid="desk-row-snooze">Snooze</button>}
        <button type="button" className={actionCls} aria-label="More" onClick={(e) => onContextMenu(e)}><MoreHorizontal size={13} /></button>
      </div>
    </div>
  )
}
