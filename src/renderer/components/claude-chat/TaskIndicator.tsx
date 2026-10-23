import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, Bot, Check, ChevronRight, Circle, CircleSlash, ListTodo, Plug, Square, SquareTerminal, Workflow, X } from 'lucide-react'
import { visibleTasks, type ChatTask, type ChatTaskKind, type ChatWorkflow, type ChatWorkflowAgent, type ChatWorkflowAgentState, type ChatWorkflowPhase } from '../../../shared/claude-chat'
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

interface WorkflowCounts { total: number; done: number; failed: number; running: number }

function countAgents(agents: ChatWorkflowAgent[]): WorkflowCounts {
  const counts = { total: agents.length, done: 0, failed: 0, running: 0 }
  for (const agent of agents) {
    if (agent.state === 'done' || agent.state === 'skipped') counts.done++
    else if (agent.state === 'failed') counts.failed++
    else if (agent.state === 'running') counts.running++
  }
  return counts
}

/** The phase the run is in: the latest one with agents still going, else the latest one reached. */
function currentPhase(workflow: ChatWorkflow): ChatWorkflowPhase | undefined {
  const started = workflow.phases.filter((phase) => phase.started)
  const busy = started.filter((phase) => workflow.agents.some((agent) => agent.phaseIndex === phase.index && (agent.state === 'running' || agent.state === 'queued')))
  return busy.at(-1) ?? started.at(-1)
}

/** "Phase 2 of 3 · Review" and "5 of 12 agents done · 1 failed", with a bar. */
function WorkflowSummary({ workflow, running }: { workflow: ChatWorkflow; running: boolean }): React.ReactElement | null {
  const counts = countAgents(workflow.agents)
  const phase = currentPhase(workflow)
  if (!phase && counts.total === 0) return null
  const phaseLabel = phase
    ? workflow.phases.length > 1 ? `Phase ${workflow.phases.indexOf(phase) + 1} of ${workflow.phases.length} · ${phase.title}` : phase.title
    : undefined
  const agentsLabel = counts.total > 0
    ? [`${counts.done} of ${counts.total} ${counts.total === 1 ? 'agent' : 'agents'} done`, counts.failed > 0 ? `${counts.failed} failed` : undefined].filter(Boolean).join(' · ')
    : undefined
  const pct = (n: number): string => `${counts.total > 0 ? (n / counts.total) * 100 : 0}%`
  return (
    <span className="flex flex-col gap-0.5 min-w-0 pt-0.5">
      {phaseLabel && <span className={`truncate text-xs ${running ? 'text-text-muted' : 'text-text-subtle'}`}>{phaseLabel}</span>}
      {agentsLabel && <span className="truncate text-xs text-text-subtle tabular-nums">{agentsLabel}</span>}
      {counts.total > 0 && (
        <span className="flex h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <span className="h-full bg-accent" style={{ width: pct(counts.done) }} />
          <span className="h-full bg-danger" style={{ width: pct(counts.failed) }} />
        </span>
      )}
    </span>
  )
}

function AgentStateIcon({ state }: { state: ChatWorkflowAgentState }): React.ReactElement {
  switch (state) {
    case 'running': return <RunningDot />
    case 'queued': return <Circle size={9} className="shrink-0 mx-px text-text-subtle" aria-label="Queued" />
    case 'done': return <Check size={12} className="shrink-0 text-success" aria-label="Done" />
    case 'failed': return <X size={12} className="shrink-0 text-danger" aria-label="Failed" />
    case 'skipped': return <CircleSlash size={11} className="shrink-0 text-text-subtle" aria-label="Skipped" />
  }
}

function WorkflowAgentRow({ agent, now }: { agent: ChatWorkflowAgent; now: number }): React.ReactElement {
  const running = agent.state === 'running'
  const elapsed = running && agent.startedAt !== undefined
    ? formatElapsed(now - agent.startedAt)
    : agent.durationMs !== undefined ? formatElapsed(agent.durationMs) : undefined
  const title = [agent.label, agent.attempt ? `attempt ${agent.attempt}` : undefined, agent.tokens ? `${formatTokens(agent.tokens)} tokens` : undefined, agent.lastTool].filter(Boolean).join('\n')
  return (
    <li title={title} className="flex items-start gap-1.5 py-0.5 pl-1 pr-2">
      <span className="pt-0.5 w-3 flex justify-center"><AgentStateIcon state={agent.state} /></span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`flex-1 truncate text-xs ${running ? 'text-text' : 'text-text-muted'}`}>{agent.label}</span>
          {agent.attempt && <span className="shrink-0 text-2xs text-text-subtle">try {agent.attempt}</span>}
          {elapsed && <span className="shrink-0 text-2xs text-text-subtle tabular-nums">{elapsed}</span>}
        </span>
        {running && agent.lastTool && <span className="truncate text-2xs text-text-subtle">{agent.lastTool}</span>}
      </span>
    </li>
  )
}

function WorkflowPhaseGroup({ title, detail, agents, started, now }: { title: string; detail?: string; agents: ChatWorkflowAgent[]; started: boolean; now: number }): React.ReactElement {
  const counts = countAgents(agents)
  const live = counts.running > 0 || agents.some((agent) => agent.state === 'queued')
  // Open where there is something to watch or something that went wrong.
  const [open, setOpen] = useState(live || counts.failed > 0)
  const wasLive = useRef(live)
  useEffect(() => {
    if (live && !wasLive.current) setOpen(true)
    wasLive.current = live
  }, [live])
  const status = !started
    ? <Circle size={9} className="shrink-0 mx-px text-text-subtle" aria-hidden />
    : live ? <RunningDot /> : counts.failed > 0
      ? <X size={12} className="shrink-0 text-danger" aria-hidden />
      : <Check size={12} className="shrink-0 text-success" aria-hidden />
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        disabled={agents.length === 0}
        title={detail}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className="flex items-center gap-1.5 py-0.5 pl-1 pr-2 rounded-sm bg-transparent border-0 text-left cursor-pointer disabled:cursor-default hover:bg-surface-3 disabled:hover:bg-transparent transition-colors duration-(--motion-fast)"
      >
        <span className="w-3 flex justify-center">{status}</span>
        <span className={`flex-1 truncate text-xs font-medium ${started ? 'text-text' : 'text-text-subtle'}`}>{title}</span>
        <span className="shrink-0 text-2xs text-text-subtle tabular-nums">
          {agents.length > 0 ? `${counts.done}/${counts.total}` : started ? '' : 'not started'}
        </span>
        {agents.length > 0 && (
          <ChevronRight size={11} aria-hidden className={`shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
        )}
      </button>
      {open && agents.length > 0 && (
        <ul className="flex flex-col m-0 p-0 pl-3 list-none">
          {agents.map((agent) => <WorkflowAgentRow key={agent.index} agent={agent} now={now} />)}
        </ul>
      )}
    </li>
  )
}

/** A workflow's phases, each with its agents. */
function WorkflowDetail({ workflow, now }: { workflow: ChatWorkflow; now: number }): React.ReactElement {
  const phaseIndexes = new Set(workflow.phases.map((phase) => phase.index))
  const loose = workflow.agents.filter((agent) => agent.phaseIndex === undefined || !phaseIndexes.has(agent.phaseIndex))
  return (
    <ul aria-label="Workflow phases" className="flex flex-col gap-px m-0 mb-1 ml-7 mr-1 p-0 list-none border-l border-border pl-1">
      {workflow.phases.map((phase) => (
        <WorkflowPhaseGroup
          key={`${phase.index}:${phase.title}`}
          title={phase.title}
          detail={phase.detail}
          started={phase.started}
          agents={workflow.agents.filter((agent) => agent.phaseIndex === phase.index)}
          now={now}
        />
      ))}
      {loose.length > 0 && <WorkflowPhaseGroup title={workflow.phases.length > 0 ? 'Other agents' : 'Agents'} agents={loose} started now={now} />}
    </ul>
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
  const workflow = task.workflow && (task.workflow.phases.length > 0 || task.workflow.agents.length > 0) ? task.workflow : undefined
  const [expanded, setExpanded] = useState(false)
  // A workflow's last_tool_name is just its latest agent's label: the summary below says more.
  const detail = summary ?? (running && task.lastTool && !workflow ? task.lastTool : undefined)
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
        {workflow && <WorkflowSummary workflow={workflow} running={running} />}
      </span>
    </>
  )

  return (
    <li className="flex flex-col">
      <div className="flex items-start gap-1 rounded-md hover:bg-sel transition-colors duration-(--motion-fast)">
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
          {workflow && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide phases and agents' : 'Show phases and agents'}
              title={expanded ? 'Hide phases and agents' : 'Show phases and agents'}
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="flex items-center justify-center size-(--ctl-h-sm) rounded-md bg-transparent border-0 cursor-pointer text-text-muted hover:text-text hover:bg-surface-3 transition-colors duration-(--motion-fast)"
            >
              <ChevronRight size={12} aria-hidden className={`transition-transform duration-(--motion-fast) ${expanded ? 'rotate-90' : ''}`} />
            </button>
          )}
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
      </div>
      {workflow && expanded && <WorkflowDetail workflow={workflow} now={now} />}
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
        <div role="dialog" aria-label="Running tasks" className={`absolute top-full mt-1 right-0 z-(--z-menu) w-80 max-h-[min(36rem,70vh)] overflow-auto ${menuCls}`}>
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
