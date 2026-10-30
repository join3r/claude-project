import type { ChatBashItem, ChatItem, ChatToolItem } from '../../../shared/claude-chat'
import { firstLine } from '../../../shared/agent-activity'

/**
 * The desk layout's conversation: one block per turn, where a turn is your message,
 * the work Claude did for it, and its answer.
 *
 * - While a turn runs, its work shows as a progress card of plain-language steps
 *   (Claude's progress notes, and one line per run of tool calls).
 * - Once it ends, the work folds to one line ("Worked 6m · read 7 files, edited 3
 *   files, built twice") and only the answer stays: the text after the last call.
 *
 * - A turn that ended with work still running in the background (a build, a
 *   subagent, a dev server) stays open until that work is done and the turn it
 *   resumes ends: Claude's answer so far shows, and the card says what still runs.
 *
 * Error and warning notices at the end of a turn stay visible under the answer.
 * A `!command` you ran is yours, not Claude's work, so it stands on its own.
 */
export type ConversationBlock =
  | { type: 'turn'; key: string; turn: Turn }
  | { type: 'bash'; key: string; item: ChatBashItem }

export interface Turn {
  user?: Extract<ChatItem, { kind: 'user' }>
  /** Everything Claude did before the answer: notes, calls, muted notices. */
  work: ChatItem[]
  /** The text after the last call. */
  answer: Extract<ChatItem, { kind: 'text' }>[]
  /** Notices after the answer (errors, "Interrupted"). */
  tail: Extract<ChatItem, { kind: 'notice' }>[]
  /** The turn in flight: the last one while the chat is busy, or while its background work runs. */
  live: boolean
  /** Live only because work it started still runs in the background; Claude itself is idle. */
  background?: boolean
  startedAt?: number
  /** When the last row arrived; with `startedAt`, how long it worked. */
  endedAt?: number
}

function hasText(item: ChatItem): boolean {
  return (item.kind !== 'text' && item.kind !== 'thinking') || item.text.trim().length > 0
}

function closeTurn(items: ChatItem[], user: Turn['user'], live: boolean): Turn {
  const visible = items.filter(hasText)
  let end = visible.length
  const tail: Turn['tail'] = []
  while (end > 0 && visible[end - 1].kind === 'notice') tail.unshift(visible[--end] as Turn['tail'][number])
  const answer: Turn['answer'] = []
  while (end > 0 && visible[end - 1].kind === 'text') answer.unshift(visible[--end] as Turn['answer'][number])
  const work = visible.slice(0, end)
  const stamps = [user, ...visible].map((item) => item?.at).filter((at): at is number => at !== undefined)
  return {
    user,
    work,
    answer,
    tail,
    live,
    startedAt: stamps.length > 0 ? Math.min(...stamps) : undefined,
    endedAt: stamps.length > 0 ? Math.max(...stamps) : undefined
  }
}

/** `background`: tasks the agent left running past its turn are still live. */
export function buildConversation(items: ChatItem[], busy: boolean, background = false): ConversationBlock[] {
  const blocks: ConversationBlock[] = []
  let user: Turn['user']
  let pending: ChatItem[] = []
  let key = 'start'
  const flush = (live: boolean): void => {
    if (!user && pending.every((item) => !hasText(item))) return
    const turn = closeTurn(pending, user, live)
    if (live && !busy) turn.background = true
    blocks.push({ type: 'turn', key, turn })
    user = undefined
    pending = []
  }
  for (const item of items) {
    if (item.kind === 'user') {
      flush(false)
      user = item
      key = item.id
    } else if (item.kind === 'bash') {
      flush(false)
      blocks.push({ type: 'bash', key: item.id, item })
      key = `after:${item.id}`
    } else {
      pending.push(item)
    }
  }
  flush(busy || background)
  // A busy chat whose last block is a `!command` or a finished turn: the turn about
  // to start has no rows yet, but the card should already say it is working.
  if (busy) {
    const last = blocks[blocks.length - 1]
    if (last?.type !== 'turn' || !last.turn.live) {
      blocks.push({ type: 'turn', key: 'live', turn: { work: [], answer: [], tail: [], live: true } })
    }
  }
  return blocks
}

export interface ProgressStep {
  key: string
  text: string
  at?: number
  /** A run of tool calls rather than a note from Claude: drawn quieter. */
  calls?: boolean
  running?: boolean
}

function isRunning(tool: ChatToolItem): boolean {
  return tool.status === 'pending' || tool.status === 'running' || tool.status === 'waiting'
}

/** The live card's steps: each progress note, and one line per run of calls between them. */
export function progressSteps(work: ChatItem[]): ProgressStep[] {
  const steps: ProgressStep[] = []
  let run: ChatToolItem[] = []
  const flush = (): void => {
    const tools = run.filter((tool) => tool.name !== 'TodoWrite')
    run = []
    if (tools.length === 0) return
    const active = [...tools].reverse().find(isRunning)
    steps.push({
      key: tools[0].id,
      text: active ? `${active.label}…` : capitalize(summarizeWork(tools)),
      at: tools[0].at,
      calls: true,
      running: Boolean(active)
    })
  }
  for (const item of work) {
    if (item.kind === 'tool') {
      run.push(item)
      continue
    }
    if (item.kind !== 'text' && item.kind !== 'thinking') continue
    const text = firstLine(item.text, 200)
    if (!text) continue
    flush()
    steps.push({ key: item.id, text, at: item.at })
  }
  flush()
  return steps
}

/** The latest todo list in the work, for the live card. */
export function latestTodos(work: ChatItem[]): ChatToolItem | undefined {
  for (let i = work.length - 1; i >= 0; i--) {
    const item = work[i]
    if (item.kind === 'tool' && item.name === 'TodoWrite') return item
  }
  return undefined
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function times(count: number): string {
  return count === 1 ? '' : count === 2 ? ' twice' : ` ${count} times`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TEST_RE = /\b((npm|pnpm|yarn|bun)( run)? test\b|vitest|jest|pytest|cargo test|go test|swift test|xcodebuild\b[^\n]*\btest\b)/
const BUILD_RE = /\b(xcodebuild|(npm|pnpm|yarn|bun) run build|vite build|cargo build|go build|swift build|make|tsc|gradlew?)\b/

/** "read 7 files, edited 3 files, built twice", lower case, for the folded line. */
export function summarizeWork(tools: ChatToolItem[]): string {
  let reads = 0
  let searches = 0
  let fetches = 0
  let builds = 0
  let tests = 0
  let commands = 0
  let agents = 0
  let other = 0
  const edited = new Set<string>()
  let edits = 0
  for (const tool of tools) {
    const name = tool.name
    if (name === 'TodoWrite') continue
    if (name === 'Read' || name === 'NotebookRead' || name === 'ReadMcpResourceTool') reads++
    else if (name === 'Grep' || name === 'Glob' || name === 'LS' || name === 'ToolSearch') searches++
    else if (name === 'WebFetch' || name === 'WebSearch') fetches++
    else if (EDIT_TOOLS.has(name)) {
      edits++
      const path = tool.input.file_path ?? tool.input.notebook_path
      if (typeof path === 'string') edited.add(path)
    } else if (name === 'Bash' || name === 'PowerShell') {
      const command = typeof tool.input.command === 'string' ? tool.input.command : ''
      if (TEST_RE.test(command)) tests++
      else if (BUILD_RE.test(command)) builds++
      else commands++
    } else if (name === 'Agent' || name === 'Task') agents++
    else other++
  }
  const parts: string[] = []
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  if (searches) parts.push(`searched ${plural(searches, 'time', 'times')}`)
  if (fetches) parts.push(`fetched ${plural(fetches, 'page', 'pages')}`)
  if (edits) parts.push(`edited ${plural(edited.size || edits, 'file', 'files')}`)
  if (builds) parts.push(`built${times(builds)}`)
  if (tests) parts.push(`ran tests${times(tests)}`)
  if (commands) parts.push(`ran ${plural(commands, 'command', 'commands')}`)
  if (agents) parts.push(`ran ${plural(agents, 'agent', 'agents')}`)
  if (other) parts.push(plural(other, 'other call', 'other calls'))
  return parts.join(', ')
}

/** "40s", "6m", "1h 5m". */
export function workedFor(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The folded line for a finished turn: "Worked 6m · read 7 files, edited 3 files". */
export function foldedLine(turn: Turn): string {
  const tools = turn.work.filter((item): item is ChatToolItem => item.kind === 'tool')
  const summary = summarizeWork(tools)
  const duration = turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt > turn.startedAt
    ? workedFor(turn.endedAt - turn.startedAt)
    : undefined
  const head = duration ? `Worked ${duration}` : 'Worked'
  if (summary) return `${head} · ${summary}`
  const notes = turn.work.filter((item) => item.kind === 'thinking' || item.kind === 'text').length
  return notes > 0 ? `${head} · thought it through` : head
}
