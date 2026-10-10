import type { ChatItem, ChatToolItem } from '../../../shared/claude-chat'

/**
 * How the timeline is laid out from the reducer's items: empty thinking/text
 * blocks vanish (Claude often streams a thinking block with its text withheld),
 * and tool calls fold so they cost as little height as possible:
 *
 * - Thinking that does carry text is a progress update (Claude Code asks for
 *   `display: "updates"`, which returns a short note and withholds the rest),
 *   so it stands between the calls like a reply does rather than folding away.
 *
 * - A run of tool calls that has finished, with something after it (Claude's
 *   reply, your next message, or the turn simply ended), folds into one row.
 *   Its images stay visible on that row.
 * - While a run is still going, each call shows — except look-around tools
 *   (reads, searches, fetches), which fold even then, so a turn that read
 *   twelve files costs one line.
 *
 * A todo list and a call waiting on you always stand alone.
 */
export type TimelineRow =
  | { type: 'item'; key: string; item: ChatItem }
  | { type: 'group'; key: string; tools: ChatToolItem[] }

const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])

function isQuiet(tool: ChatToolItem): boolean {
  return QUIET_TOOLS.has(tool.name) && tool.status !== 'error'
}

function isFoldable(item: ChatItem): item is ChatToolItem {
  return item.kind === 'tool' && item.name !== 'TodoWrite' && item.status !== 'waiting'
}

function isFinished(tool: ChatToolItem): boolean {
  return tool.status !== 'pending' && tool.status !== 'running' && tool.status !== 'waiting'
}

function isVisible(item: ChatItem): boolean {
  if (item.kind === 'text' || item.kind === 'thinking') return item.text.trim().length > 0
  return true
}

function pushTools(rows: TimelineRow[], tools: ChatToolItem[]): void {
  if (tools.length === 0) return
  if (tools.length === 1) rows.push({ type: 'item', key: tools[0].id, item: tools[0] })
  else rows.push({ type: 'group', key: `g:${tools[0].id}`, tools })
}

/** A run still in progress: calls one by one, look-around runs folded. */
function pushActive(rows: TimelineRow[], run: ChatToolItem[]): void {
  let quiet: ChatToolItem[] = []
  for (const tool of run) {
    if (isQuiet(tool)) {
      quiet.push(tool)
      continue
    }
    pushTools(rows, quiet)
    quiet = []
    rows.push({ type: 'item', key: tool.id, item: tool })
  }
  pushTools(rows, quiet)
}

/** `busy`: a turn is in flight, so a run at the very end may still grow. */
export function buildTimeline(items: ChatItem[], busy = false): TimelineRow[] {
  const rows: TimelineRow[] = []
  let run: ChatToolItem[] = []
  const flush = (settled: boolean): void => {
    if (settled && run.every(isFinished)) pushTools(rows, run)
    else pushActive(rows, run)
    run = []
  }
  for (const item of items) {
    if (!isVisible(item)) continue
    if (isFoldable(item)) {
      run.push(item)
      continue
    }
    if (run.length > 0) flush(true)
    rows.push({ type: 'item', key: item.id, item })
  }
  if (run.length > 0) flush(!busy)
  return rows
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** "Read 3 files · edited 2 files · ran 4 commands" for a folded run. */
export function summarizeGroup(tools: ChatToolItem[]): string {
  let reads = 0
  let searches = 0
  let fetches = 0
  let commands = 0
  let agents = 0
  let other = 0
  const edited = new Set<string>()
  let edits = 0
  for (const tool of tools) {
    if (tool.name === 'Read' || tool.name === 'NotebookRead' || tool.name === 'ReadMcpResourceTool') reads++
    else if (tool.name === 'Grep' || tool.name === 'Glob' || tool.name === 'LS' || tool.name === 'ToolSearch') searches++
    else if (tool.name === 'WebFetch' || tool.name === 'WebSearch') fetches++
    else if (EDIT_TOOLS.has(tool.name)) {
      edits++
      const path = tool.input.file_path ?? tool.input.notebook_path
      if (typeof path === 'string') edited.add(path)
    } else if (tool.name === 'Bash' || tool.name === 'PowerShell') commands++
    else if (tool.name === 'Agent' || tool.name === 'Task') agents++
    else other++
  }
  const parts: string[] = []
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  if (searches) parts.push(`searched ${plural(searches, 'time', 'times')}`)
  if (fetches) parts.push(`fetched ${plural(fetches, 'page', 'pages')}`)
  if (edits) parts.push(`edited ${plural(edited.size || edits, 'file', 'files')}`)
  if (commands) parts.push(`ran ${plural(commands, 'command', 'commands')}`)
  if (agents) parts.push(`ran ${plural(agents, 'agent', 'agents')}`)
  if (other) parts.push(plural(other, 'other call', 'other calls'))
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
