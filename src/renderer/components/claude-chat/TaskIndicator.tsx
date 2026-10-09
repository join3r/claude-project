import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, Bot, Check, CircleSlash, ListTodo, Plug, Square, SquareTerminal, Workflow, X } from 'lucide-react'
import { TASK_LINGER_MS, type ChatTask, type ChatTaskKind } from '../../../shared/claude-chat'
import { menuCls } from '../ui'
import { formatTokens } from './UsageMeter'

interface Props {
  tasks: Record<string, ChatTask>
  onStop: (taskId: string) => void
  onBackground: (toolUseId: string) => void
  /** Scroll the timeline to the tool call that started a task. */
  onJump: (toolUseId: string) => void
  /** Whether a tool call is in the timeline, so its row can be jumped to. */
  canJump: (toolUseId: string) => boolean
}

const KIND_NOUN: Record<ChatTaskKind, [string, string]> = {
  subagent: ['agent', 'agents'],
  shell: ['shell', 'shells'],
  workflow: ['workflow', 'workflows'],
  monitor: ['monitor', 'monitors'],
  mcp: ['MCP task', 'MCP tasks'],
  other: ['task', 'tasks']
}

const KIND_ORDER: ChatTaskKind[] = ['subagent', 'shell', 'workflow', 'monitor', 'mcp', 'other']

/** Tasks worth listing at `now`: running ones, and finished ones inside their linger. */
export function visibleTasks(tasks: Record<string, ChatTask>, now: number): ChatTask[] {
  return Object.values(tasks)
    .filter((task) => task.status === 'running' || (task.endedAt !== undefined && now - task.endedAt < TASK_LINGER_MS))
    .sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
      return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    })
}

/** "2 agents · 1 shell". */
export function countLabel(tasks: ChatTask[]): string {
  const counts = new Map<ChatTaskKind, number>()
  for (const task of tasks) counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1)
  return KIND_ORDER
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0
      return `${count} ${KIND_NOUN[kind][count === 1 ? 0 : 1]}`
    })
    .join(' · ')
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function KindIcon({ kind }: { kind: ChatTaskKind }): React.ReactElement {
  const props = { size: 13, className: 'shrink-0 text-text-subtle', 'aria-hidden': true }
  switch (kind) {
    case 'subagent': return <Bot {...props} />
    case 'shell': return <SquareTerminal {...props} />
    case 'workflow': return <Workflow {...props} />
    case 'monitor': return <Activity {...props} />
    case 'mcp': return <Plug {...props} />
    case 'other': return <ListTodo {...props} />
  }
}

function RunningDot(): React.ReactElement {
  return (
    <span className="w-3 h-3 flex items-center justify-center shrink-0" aria-hidden>
      <span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" />
    </span>
  )
}

function OutcomeIcon({ status }: { status: ChatTask['status'] }): React.ReactElement | null {
  switch (status) {
    case 'completed': return <Check size={12} className="shrink-0 text-success" aria-label="Completed" />
    case 'failed': return <X size={12} className="shrink-0 text-danger" aria-label="Failed" />
    case 'stopped': return <CircleSlash size={12} className="shrink-0 text-text-subtle" aria-label="Stopped" />
    case 'running': return null
  }
}

export function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex items-center justify-center size-(--ctl-h-sm) rounded-md bg-transparent border-0 cursor-pointer text-text-muted hover:text-text hover:bg-surface-3 transition-colors duration-(--motion-fast)"
    >
      {children}
    </button>
  )
}

/**
 * Stopping throws away the task's work, so it takes two clicks: the first arms
 * the button, the second (within 3s) stops.
 */
function StopButton({ description, onStop }: { description: string; onStop: () => void }): React.ReactElement {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!armed) {
      setArmed(true)
      timerRef.current = setTimeout(() => setArmed(false), 3000)
      return
    }
    setArmed(false)
    onStop()
  }

  return (
    <button
      type="button"
      aria-label={armed ? `Confirm stop ${description}` : 'Stop task'}
      title={armed ? 'Click again to stop this task' : 'Stop task'}
      onClick={handleClick}
      className={`flex items-center justify-center h-(--ctl-h-sm) rounded-md border-0 cursor-pointer transition-colors duration-(--motion-fast) ${armed
        ? 'px-1.5 bg-danger/15 text-danger text-xs font-medium'
        : 'w-(--ctl-h-sm) bg-transparent text-text-muted hover:text-danger hover:bg-danger/15'}`}
    >
      {armed ? 'Stop?' : <Square size={11} />}
    </button>
  )
}

function TaskRow({ task, now, onStop, onBackground, onJump, canJump }: { task: ChatTask; now: number } & Omit<Props, 'tasks'>): React.ReactElement {
  const running = task.status === 'running'
  const elapsed = task.startedAt !== undefined ? formatElapsed((task.endedAt ?? now) - task.startedAt) : undefined
  const meta = [
    task.agentType,
    elapsed,
    task.toolUses ? `${task.toolUses} ${task.toolUses === 1 ? 'tool' : 'tools'}` : undefined,
    task.tokens ? `${formatTokens(task.tokens)} tokens` : undefined
  ].filter(Boolean).join(' · ')
  // A shell's summary often just repeats its description.
  const summary = task.summary && task.summary !== task.description ? task.summary : undefined
  const detail = summary ?? (running && task.lastTool ? task.lastTool : undefined)
  const jumpable = task.toolUseId !== undefined && canJump(task.toolUseId)
  const title = [task.description, task.command && task.command !== task.description ? `$ ${task.command}` : undefined].filter(Boolean).join('\n')

  const body = (
    <>
      <span className="pt-0.5"><KindIcon kind={task.kind} /></span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`truncate text-sm ${running ? 'text-text' : 'text-text-muted'}`}>{task.description}</span>
          {task.background && (
            <span className="shrink-0 rounded-sm px-1 text-2xs leading-4 text-text-subtle bg-surface-3">bg</span>
          )}
        </span>
        {task.command && task.command !== task.description && (
          <span className="truncate font-mono text-xs text-text-subtle">$ {task.command}</span>
        )}
        {meta && <span className="truncate text-xs text-text-subtle tabular-nums">{meta}</span>}
        {detail && <span className="truncate text-xs text-text-muted">{detail}</span>}
      </span>
    </>
  )

  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-sel transition-colors duration-(--motion-fast)">
      {jumpable ? (
        <button
          type="button"
          title={title}
          aria-label={`Show ${task.description} in the conversation`}
          onClick={() => onJump(task.toolUseId as string)}
          className="flex-1 min-w-0 flex items-start gap-2 px-2 py-1.5 bg-transparent border-0 text-left cursor-pointer"
        >
          {body}
        </button>
      ) : (
        <div title={title} className="flex-1 min-w-0 flex items-start gap-2 px-2 py-1.5">{body}</div>
      )}
      <span className="flex items-center gap-0.5 shrink-0 pr-1 pt-1">
        {running ? (
          <>
            {!task.background && task.toolUseId && (
              <ActionButton label="Send to background" onClick={() => onBackground(task.toolUseId as string)}>
                <ArrowDownToLine size={12} />
              </ActionButton>
            )}
            <StopButton description={task.description} onStop={() => onStop(task.id)} />
          </>
        ) : (
          <span className="size-(--ctl-h-sm) flex items-center justify-center"><OutcomeIcon status={task.status} /></span>
        )}
      </span>
    </li>
  )
}

/** Closes a pill's list on a click outside it, or on Escape. */
export function usePillDismiss(open: boolean, setOpen: (open: boolean) => void, rootRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escape here closes the list; it must not also stop the turn.
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, setOpen, rootRef])
}

export const pillCls = 'h-6 px-2.5 inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-surface-2 text-xs text-text-muted shadow-pop cursor-pointer hover:text-text transition-colors duration-(--motion-fast)'

/**
 * The pill in the chat pane's top-right corner: what Claude has running beside
 * the turn (subagents, shells, workflows), and for a minute what just finished.
 * Hidden when there is nothing to show.
 */
export default function TaskIndicator({ tasks, onStop, onBackground, onJump, canJump }: Props): React.ReactElement | null {
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => visibleTasks(tasks, now), [tasks, now])
  const hasTasks = Object.keys(tasks).length > 0

  // Ticks elapsed times and ages finished rows out; idle when there is nothing.
  useEffect(() => {
    setNow(Date.now())
    if (!hasTasks) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tasks, hasTasks])

  useEffect(() => {
    if (shown.length === 0) setOpen(false)
  }, [shown.length])

  usePillDismiss(open, setOpen, rootRef)

  if (shown.length === 0) return null
  const running = shown.filter((task) => task.status === 'running')
  const failed = shown.some((task) => task.status === 'failed')
  const label = running.length > 0 ? countLabel(running) : `${countLabel(shown)} done`

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${running.length > 0 ? 'Running' : 'Finished'}: ${label}`}
        title="Tasks Claude is running"
        onClick={() => setOpen(!open)}
        className={pillCls}
      >
        {running.length > 0
          ? <RunningDot />
          : failed ? <X size={11} className="text-danger" aria-hidden /> : <Check size={11} className="text-success" aria-hidden />}
        <span className="tabular-nums whitespace-nowrap">{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Running tasks" className={`absolute top-full mt-1 right-0 z-(--z-menu) w-80 max-h-96 overflow-auto ${menuCls}`}>
          <ul className="flex flex-col gap-px m-0 p-0 list-none">
            {shown.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                onStop={onStop}
                onBackground={onBackground}
                onJump={(toolUseId) => { setOpen(false); onJump(toolUseId) }}
                canJump={canJump}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
