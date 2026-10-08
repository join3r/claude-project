import type { AiStatusEvent } from './ai-status'

/**
 * What a Claude tab is doing right now, in words — the sidebar's "Bash · npm test"
 * or "Permission: Edit styles.css". The status dot (ai-status.ts) says *whether*
 * the agent needs you; this says *what* it is doing or asking.
 *
 * Built by folding Claude Code hook payloads (every hook body carries
 * `hook_event_name`) through {@link reduceAgentActivity}. Main owns the fold and
 * broadcasts the result to every window, so a task running in another window still
 * reads correctly here. Pi posts empty bodies and never gets an activity.
 *
 * Hooks after the first four run `async`, so their POSTs can land slightly out of
 * order. Every rule below is written so a late event cannot un-finish a turn:
 * tool events never start a turn, and Stop clears everything tool-shaped.
 */
export interface AgentActivity {
  /** Claude's own session title (UserPromptSubmit / SessionStart carry it). */
  title?: string
  /** First line of the prompt that started the current or last turn. */
  lastPrompt?: string
  /** First line of Claude's final reply for the last finished turn. */
  lastMessage?: string
  /** The main-thread tool call in flight. Subagent tools are only counted. */
  tool?: { id?: string; name: string; label: string; startedAt: number }
  /** Why the agent is blocked on you, when it is. */
  waiting?: {
    kind: 'permission' | 'question' | 'plan' | 'error'
    label: string
    toolUseId?: string
    since: number
  }
  subagents: number
  /**
   * Live background agents and workflows — the chat tab's `background_tasks_changed`
   * level. Outlives Stop: they keep running after the turn. Terminal tabs never set it.
   */
  background?: number
  compacting: boolean
  /** When the current turn started; undefined between turns. */
  turnStartedAt?: number
  updatedAt: number
}

export interface ActivityUpdate {
  activity: AgentActivity
  /** A status transition this event implies, beyond the four dedicated endpoints. */
  statusEvent: AiStatusEvent | null
  /** False when the body was not a Claude hook event this module knows. */
  changed: boolean
}

const TEXT_LIMIT = 160

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** First non-empty line, collapsed and truncated — sidebar rows are one line tall. */
export function firstLine(text: string | undefined, limit = TEXT_LIMIT): string | undefined {
  if (!text) return undefined
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return undefined
  const clean = line.replace(/\s+/g, ' ').replace(/^#+\s*/, '').replace(/\*\*|`/g, '')
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function basename(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1]
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A short human label for a tool call: "Editing styles.css", "Bash · npm test". */
export function summarizeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const withDetail = (verb: string, detail: string | undefined): string =>
    detail ? `${verb} ${detail}` : verb
  const tagged = (tag: string, detail: string | undefined): string =>
    detail ? `${tag} · ${detail}` : tag

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return tagged(name, firstLine(str(i.command), 80))
    case 'Read':
      return withDetail('Reading', basename(str(i.file_path)))
    case 'Edit':
    case 'MultiEdit':
      return withDetail('Editing', basename(str(i.file_path)))
    case 'Write':
      return withDetail('Writing', basename(str(i.file_path)))
    case 'NotebookEdit':
      return withDetail('Editing', basename(str(i.notebook_path)))
    case 'Grep':
      return withDetail('Searching', str(i.pattern) && `"${firstLine(str(i.pattern), 60)}"`)
    case 'Glob':
      return withDetail('Finding', firstLine(str(i.pattern), 60))
    case 'WebFetch':
      return withDetail('Fetching', hostOf(str(i.url)))
    case 'WebSearch':
      return withDetail('Searching web', str(i.query) && `"${firstLine(str(i.query), 60)}"`)
    case 'Agent':
    case 'Task':
      return tagged('Agent', firstLine(str(i.description), 60))
    case 'Skill':
      return tagged('Skill', str(i.skill) ?? str(i.name))
    case 'AskUserQuestion': {
      const questions = Array.isArray(i.questions) ? i.questions : []
      const first = questions[0] as Record<string, unknown> | undefined
      return firstLine(str(first?.question), 100) ?? 'Question for you'
    }
    case 'ExitPlanMode':
      return 'Plan ready for review'
    case 'TodoWrite':
      return 'Updating todos'
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]} · ${mcp[2]}`
  return name
}

/** Tools whose call *is* a question to you — PreToolUse fires as the dialog opens. */
const BLOCKING_TOOLS: Record<string, 'question' | 'plan'> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan'
}

export function emptyActivity(now: number): AgentActivity {
  return { subagents: 0, compacting: false, updatedAt: now }
}

/**
 * Fold one hook payload into the tab's activity. Unknown or pi-shaped bodies
 * (no `hook_event_name`) return the previous activity untouched.
 */
export function reduceAgentActivity(
  prev: AgentActivity | undefined,
  body: Record<string, unknown> | undefined,
  now: number
): ActivityUpdate {
  const base = prev ?? emptyActivity(now)
  const event = str(body?.hook_event_name)
  if (!body || !event) return { activity: base, statusEvent: null, changed: false }

  const next: AgentActivity = { ...base, updatedAt: now }
  const title = str(body.session_title)
  if (title) next.title = firstLine(title, 80)
  // Subagent hooks carry agent_id; only their lifecycle matters to the row.
  const fromSubagent = typeof body.agent_id === 'string'
  let statusEvent: AiStatusEvent | null = null

  switch (event) {
    case 'SessionStart': {
      const source = str(body.source)
      if (source === 'clear' || source === 'startup') {
        next.lastPrompt = undefined
        next.lastMessage = undefined
      }
      next.tool = undefined
      next.waiting = undefined
      next.subagents = 0
      next.compacting = false
      next.turnStartedAt = undefined
      break
    }

    case 'UserPromptSubmit':
      next.lastPrompt = firstLine(str(body.prompt)) ?? next.lastPrompt
      next.lastMessage = undefined
      next.tool = undefined
      next.waiting = undefined
      next.subagents = 0
      next.turnStartedAt = now
      break

    case 'PreToolUse': {
      if (fromSubagent) break
      const name = str(body.tool_name) ?? 'tool'
      const id = str(body.tool_use_id)
      const label = summarizeTool(name, body.tool_input)
      next.tool = { id, name, label, startedAt: now }
      const blocking = BLOCKING_TOOLS[name]
      if (blocking) {
        next.waiting = { kind: blocking, label, toolUseId: id, since: now }
        statusEvent = 'hook-needs-input'
      }
      break
    }

    case 'PermissionRequest': {
      const name = str(body.tool_name) ?? 'tool'
      // Keep a question/plan wait: its PreToolUse label is the more useful one.
      if (next.waiting?.kind === 'question' || next.waiting?.kind === 'plan') break
      next.waiting = {
        kind: 'permission',
        label: summarizeTool(name, body.tool_input),
        toolUseId: str(body.tool_use_id),
        since: now
      }
      statusEvent = 'hook-needs-input'
      break
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const id = str(body.tool_use_id)
      const name = str(body.tool_name)
      if (!fromSubagent && next.tool && (id ? next.tool.id === id : next.tool.name === name)) {
        next.tool = undefined
      }
      // Clear the wait only for the call it was about. A parallel tool finishing
      // while a permission dialog is still open must not lift the attention.
      const waiting = next.waiting
      if (waiting && waiting.kind !== 'error') {
        const matches = waiting.toolUseId && id ? waiting.toolUseId === id : !fromSubagent
        if (matches) {
          next.waiting = undefined
          statusEvent = 'hook-input-resolved'
        }
      }
      break
    }

    // DevTool's own event: a chat tab's prompt was answered in a window. Lifts the
    // wait it was about without touching the tool row, which PostToolUse clears.
    case 'DevtoolPromptResolved': {
      const id = str(body.tool_use_id)
      const waiting = next.waiting
      if (!waiting || waiting.kind === 'error') break
      if (waiting.toolUseId && id && waiting.toolUseId !== id) break
      next.waiting = undefined
      statusEvent = 'hook-input-resolved'
      break
    }

    case 'Notification': {
      const type = str(body.notification_type)
      if (type === 'permission_prompt' && !next.waiting) {
        next.waiting = {
          kind: 'permission',
          label: firstLine(str(body.message), 100) ?? 'Permission needed',
          since: now
        }
      }
      break
    }

    // DevTool's own event: the chat tab's set of live background tasks changed.
    // Going live or going quiet between turns is a status change of its own; inside
    // a turn the turn's own hooks decide.
    case 'DevtoolBackgroundTasks': {
      const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 0
      const before = base.background ?? 0
      if (count === before) return { activity: base, statusEvent: null, changed: false }
      next.background = count > 0 ? count : undefined
      if (next.turnStartedAt === undefined) {
        if (before === 0) statusEvent = 'background-started'
        else if (count === 0) statusEvent = 'background-done'
      }
      break
    }

    case 'SubagentStart':
      next.subagents = base.subagents + 1
      break

    case 'SubagentStop':
      next.subagents = Math.max(0, base.subagents - 1)
      break

    case 'PreCompact':
      next.compacting = true
      break

    case 'PostCompact':
      next.compacting = false
      break

    case 'Stop':
      next.lastMessage = firstLine(str(body.last_assistant_message)) ?? next.lastMessage
      next.tool = undefined
      next.waiting = undefined
      next.subagents = 0
      next.compacting = false
      next.turnStartedAt = undefined
      break

    case 'StopFailure': {
      const error = str(body.error) ?? 'unknown'
      next.lastMessage = firstLine(str(body.last_assistant_message)) ?? next.lastMessage
      next.tool = undefined
      next.subagents = 0
      next.compacting = false
      next.turnStartedAt = undefined
      next.waiting = { kind: 'error', label: describeStopFailure(error), since: now }
      statusEvent = 'hook-needs-input'
      break
    }

    case 'SessionEnd':
      next.tool = undefined
      next.waiting = undefined
      next.subagents = 0
      next.compacting = false
      next.turnStartedAt = undefined
      break

    default:
      return { activity: base, statusEvent: null, changed: false }
  }

  return { activity: next, statusEvent, changed: true }
}

const STOP_FAILURE_LABELS: Record<string, string> = {
  rate_limit: 'Rate limited',
  overloaded: 'API overloaded',
  authentication_failed: 'Authentication failed',
  billing_error: 'Billing error',
  server_error: 'API server error',
  max_output_tokens: 'Hit max output tokens',
  model_not_found: 'Model not found',
  invalid_request: 'Invalid request'
}

function describeStopFailure(error: string): string {
  return STOP_FAILURE_LABELS[error] ?? `Turn failed (${error.replace(/_/g, ' ')})`
}

/**
 * The one line a sidebar row shows for a tab, or undefined when there is nothing
 * better than the status word. `status` is the tab's dot status.
 */
export function describeActivity(
  activity: AgentActivity | undefined,
  status: 'working' | 'attention' | 'exited' | null
): string | undefined {
  if (!activity) return undefined
  if (status === 'attention' && activity.waiting) {
    const { kind, label } = activity.waiting
    if (kind === 'permission') return `Permission: ${label}`
    if (kind === 'plan') return 'Plan ready for review'
    return label
  }
  if (status === 'working') {
    if (activity.compacting) return 'Compacting context'
    const parts: string[] = []
    if (activity.tool) parts.push(activity.tool.label)
    if (activity.subagents > 0) parts.push(activity.subagents === 1 ? '1 agent' : `${activity.subagents} agents`)
    const background = activity.background ?? 0
    if (background > 0 && activity.turnStartedAt === undefined) {
      parts.push(background === 1 ? '1 background task' : `${background} background tasks`)
    }
    if (parts.length > 0) return parts.join(' · ')
    return activity.lastPrompt ? `Thinking · ${activity.lastPrompt}` : 'Thinking'
  }
  return activity.lastMessage ?? activity.lastPrompt
}
