import React from 'react'
import { Check, MoreHorizontal, Pin } from 'lucide-react'
import type { GitDiffSummary, Project } from '../../../shared/types'
import { formatLineCount } from '../../hooks/useTaskDiffSummaries'
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
import type { InboxRename } from './deskInbox'
import { autopilotActive, autopilotLine, autopilotNeedsYou } from '../../../shared/autopilot'
import { wakeHint } from './deskSnooze'
import type { TaskBackground } from './deskInbox'

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
    if (autopilotNeedsYou(entry.task)) return { lead: 'Autopilot stopped:', text: entry.task.autopilot?.reason ?? null }
    return { lead: 'Needs you:', text: agent.line ?? activity?.lastAnswer ?? null }
  }
  if (kind === 'working') {
    const elapsed = entry.since !== null ? ` · ${formatWaitTime(now - entry.since)}` : ''
    // The desk's Done hands a conflict to the agent: say it is still landing.
    const line = entry.task.landing?.state === 'fixing' ? 'Landing · fixing conflict' : landing ?? autopilotLine(entry.task.autopilot)
    return { text: `${line ?? agent.line ?? 'Working'}${elapsed}` }
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
  entry, kind, agent, activity, background = null, diff, selected, checked = false, checking = false, pinned = false, offline = false, showTile = true, now, theme, onSelect, onCheck, onScopeProject, onContextMenu, onDone, onSnooze, onWake, onStopBackground, onHover, rename
}: {
  entry: InboxEntry
  kind: DeskRowKind
  agent: TaskActivitySummary
  activity: AgentActivity | undefined
  /** Working rows: the Background state, when the turn ended but its work still runs. */
  background?: TaskBackground | null
  /** Lines the task added and removed, shown before its age. */
  diff?: GitDiffSummary
  selected: boolean
  /** Ticked for a bulk action. */
  checked?: boolean
  /** Some row is ticked: the tile gives way to a checkbox. */
  checking?: boolean
  /** A pinned task: a pin beside its title. */
  pinned?: boolean
  /** Its project's DevTool server isn't online: the row is greyed. */
  offline?: boolean
  /** Settings → Show project icons: off leaves the project name to lead on its own. */
  showTile?: boolean
  now: number
  theme: 'dark' | 'light'
  /** A click on the row; ⌘ and ⇧ held tick rows instead of opening (the column decides). */
  onSelect: (e: React.MouseEvent) => void
  /** The checkbox that stands in for the tile while some row is ticked. */
  onCheck: () => void
  /** The tile: narrow the column to this project. */
  onScopeProject: (project: Project) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDone: () => void
  onSnooze: (e: React.MouseEvent) => void
  onWake: () => void
  /** ■ Stop on a Background row: ends the work still running. */
  onStopBackground?: () => void
  onHover: (taskId: string | null) => void
  rename?: InboxRename
}): React.ReactElement {
  const { task, project, stream } = entry
  const at = lastActivityAt(task)
  // A landing being fixed reads as the landing, not as the work around it.
  const inBackground = kind === 'working' && background !== null && !entry.task.landing
  const { lead, text } = preview(kind, entry, agent, activity, now)
  const unread = entry.unread && kind !== 'working'
  return (
    <div
      className={[
        'group relative flex gap-3 mx-2 px-3 py-2.5 rounded-[9px] items-start cursor-pointer',
        'transition-colors duration-(--motion-fast)',
        checked ? 'bg-sel' : selected ? 'bg-row-sel' : 'hover:bg-row-hover',
        offline ? 'opacity-55' : ''
      ].join(' ')}
      onClick={rename ? undefined : onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(task.id)}
      onMouseLeave={() => onHover(null)}
      title={rename ? undefined : offline ? [`${project.name}'s server is offline`, agent.tooltip].filter(Boolean).join('\n') : agent.tooltip}
      data-testid="desk-row"
      data-task-id={task.id}
      data-kind={kind}
      data-checked={checked || undefined}
    >
      {checking ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`Select ${task.name}`}
          className={[
            'shrink-0 w-6 h-6 flex items-center justify-center p-0 rounded-md cursor-pointer border',
            checked ? 'bg-accent border-accent text-accent-ink' : 'bg-transparent border-border-strong text-transparent hover:border-text-muted'
          ].join(' ')}
          onClick={(e) => { e.stopPropagation(); onCheck() }}
          data-testid="desk-row-check"
        >
          <Check size={14} strokeWidth={3} />
        </button>
      ) : showTile && (
        <button
          type="button"
          className="shrink-0 p-0 border-0 bg-transparent cursor-pointer rounded-md"
          title={`Show only ${project.name}`}
          onClick={(e) => { e.stopPropagation(); onScopeProject(project) }}
        >
          <ProjectTileBadge project={project} theme={theme} size={24} />
        </button>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex justify-between gap-2 text-xs text-text-muted">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            <strong className="font-semibold text-body">{project.name}</strong>
            {!stream.isMain && <> › <span className="font-mono">{stream.name}</span></>}
          </span>
          <span className={`shrink-0 tabular-nums flex items-center gap-1.5 ${checking ? '' : 'group-hover:invisible'}`}>
            {/* Background work: a steady dot, since the agent itself is idle. */}
            {kind === 'working' && (inBackground
              ? <span className="w-[7px] h-[7px] rounded-full bg-status-working" aria-label="background" data-testid="desk-row-background" />
              : <span className="w-[7px] h-[7px] rounded-full bg-status-working desk-pulse" aria-label="working" />)}
            {unread && <span className="w-[7px] h-[7px] rounded-full bg-answered" aria-label="unread" />}
            {diff && (diff.added > 0 || diff.deleted > 0) && (
              <span className="font-mono" title={`${diff.added} lines added, ${diff.deleted} removed${diff.files ? ` in ${diff.files === 1 ? '1 file' : `${diff.files} files`}` : ''}`} data-testid="desk-row-diff">
                <span className="text-running">+{formatLineCount(diff.added)}</span> <span className="text-crashed">−{formatLineCount(diff.deleted)}</span>
              </span>
            )}
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
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className={`text-base text-text overflow-hidden text-ellipsis whitespace-nowrap ${unread || kind === 'needsYou' ? 'font-semibold' : 'font-medium'}`} data-testid="desk-row-title">
              {task.name}
            </span>
            {pinned && <Pin size={11} className="shrink-0 self-center text-text-subtle" aria-label="pinned" />}
            {autopilotActive(task) && <AutopilotMark />}
          </span>
        )}
        {inBackground && background ? (
          // One line, so the elapsed time and Stop never wrap away; the label gives way.
          <span className="flex items-center gap-1 min-w-0 text-sm leading-[1.45] text-text-muted" data-testid="desk-row-preview">
            <span className="min-w-0 truncate">Background · {background.label}</span>
            <span className="shrink-0 tabular-nums">· {formatWaitTime(now - background.since)}</span>
            {onStopBackground && <button
              type="button"
              className="ml-auto shrink-0 px-1.5 py-px rounded-md border-0 bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-border"
              title="Stop the work running in the background"
              onClick={(e) => { e.stopPropagation(); onStopBackground() }}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid="desk-row-stop"
            >
              ■ Stop
            </button>}
          </span>
        ) : text && (
          <span className="text-sm leading-[1.45] text-text-muted line-clamp-2" data-testid="desk-row-preview">
            {lead && <span className="text-needs">{lead} </span>}
            {text}
          </span>
        )}
      </div>
      <div
        className={`absolute right-2.5 top-2 hidden ${checking ? '' : 'group-hover:flex'} gap-1 pl-2 bg-row-sel`}
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

/** The quiet "autopilot" mark: on a run still going, and on the Done row of a task Autopilot landed. */
export function AutopilotMark(): React.ReactElement {
  return (
    <span className="shrink-0 font-mono text-[10.5px] text-text-muted border border-border rounded px-1 leading-[15px]" title="Autopilot takes this task to Done by itself" data-testid="desk-autopilot-mark">
      autopilot
    </span>
  )
}
