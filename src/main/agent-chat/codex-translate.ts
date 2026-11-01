import { summarizeTool } from '../../shared/agent-activity'
import { RESULT_TEXT_LIMIT, type ChatItem, type ChatLimitWindow, type ChatModelOption, type ChatToolItem, type ChatToolStatus, type ChatUsage } from '../../shared/claude-chat'

/**
 * `codex app-server` thread items as chat rows. Pure, and lenient on purpose: the
 * protocol belongs to whichever `codex` is installed, so a field that is missing
 * or renamed degrades a row instead of breaking the tab.
 *
 * Tool rows reuse Claude Code's tool names (Bash, MultiEdit, Write, WebSearch) so
 * the timeline's existing cards draw them.
 */

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(text: string): string {
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}\n… (${text.length - RESULT_TEXT_LIMIT} more characters)` : text
}

/** Exactly `sh`, `bash` or `zsh`, bare or in a system bin dir, with `-c` / `-lc`: nothing else counts as the wrapper. */
const SHELL_WRAP_RE = /^(?:\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/
const SINGLE_QUOTED_RE = /^'(?:[^']|'\\'')*'$/
const DOUBLE_QUOTED_RE = /^"(?:[^"\\]|\\[\s\S])*"$/

/**
 * The command a model wrote, without the login-shell wrapper Codex runs it in
 * (`/bin/zsh -lc "printf 'hi' > a.txt"` → `printf 'hi' > a.txt`). Approval cards
 * show this, so anything short of an exact wrapper around one quoted argument
 * stays as it is: a lookalike program or a second argument must stay visible.
 */
export function unwrapShellCommand(command: string): string {
  const match = SHELL_WRAP_RE.exec(command.trim())
  if (!match) return command
  const inner = match[1].trim()
  if (SINGLE_QUOTED_RE.test(inner)) return inner.slice(1, -1).replace(/'\\''/g, "'")
  if (DOUBLE_QUOTED_RE.test(inner)) return inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  return /^[^\s'"\\;&|<>()$`]+$/.test(inner) ? inner : command
}

/** One `old_string → new_string` pair per hunk of a unified diff (headers skipped). */
export function unifiedDiffEdits(diff: string): { old_string: string; new_string: string }[] {
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  const edits: { old_string: string; new_string: string }[] = []
  let before: string[] = []
  let after: string[] = []
  let inHunk = false
  const flush = (): void => {
    if (before.length > 0 || after.length > 0) edits.push({ old_string: before.join('\n'), new_string: after.join('\n') })
    before = []
    after = []
  }
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush()
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith('-')) before.push(line.slice(1))
    else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      before.push(text)
      after.push(text)
    }
  }
  flush()
  return edits
}

/** A new file's content: its diff without the `+` on every line, when it is a diff at all. */
function addedContent(diff: string): string {
  const edits = unifiedDiffEdits(diff)
  if (edits.length > 0) return edits.map((edit) => edit.new_string).join('\n')
  const lines = diff.split('\n')
  return lines.every((line) => line === '' || line.startsWith('+')) ? lines.map((line) => line.slice(1)).join('\n') : diff
}

export function codexStatus(status: unknown): ChatToolStatus {
  switch (status) {
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'declined': return 'denied'
    default: return 'running'
  }
}

function tool(id: string, name: string, input: Record<string, unknown>, status: ChatToolStatus, result?: string): ChatToolItem {
  return {
    kind: 'tool',
    id,
    name,
    label: summarizeTool(name, input),
    input,
    status,
    ...(result ? { result: truncate(result) } : {})
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const b = obj(block)
    if (!b) return ''
    if (typeof b.text === 'string') return b.text
    return ''
  }).filter(Boolean).join('\n')
}

/** The rows a file change stands for: one per file, the first keeping the item's id (approvals name it). */
export function fileChangeRows(id: string, changes: unknown, status: ChatToolStatus): ChatToolItem[] {
  const list = Array.isArray(changes) ? changes : []
  return list.map((raw, index) => {
    const change = obj(raw) ?? {}
    const path = str(change.path) ?? ''
    const diff = str(change.diff) ?? ''
    const kind = str(obj(change.kind)?.type)
    const rowId = index === 0 ? id : `${id}:${index}`
    if (kind === 'add') return tool(rowId, 'Write', { file_path: path, content: addedContent(diff) }, status)
    if (kind === 'delete') return tool(rowId, 'MultiEdit', { file_path: path, edits: [{ old_string: addedContent(diff.replace(/^-/gm, '+')), new_string: '' }] }, status)
    return tool(rowId, 'MultiEdit', { file_path: path, edits: unifiedDiffEdits(diff) }, status)
  })
}

/** A thread item as zero or more rows. */
export function codexItemRows(raw: unknown): ChatItem[] {
  const item = obj(raw)
  const id = str(item?.id)
  if (!item || !id) return []
  switch (item.type) {
    case 'userMessage': {
      const content = Array.isArray(item.content) ? item.content : []
      const text = content.map((block) => str(obj(block)?.text)).filter(Boolean).join('\n')
      const images = content.filter((block) => {
        const type = obj(block)?.type
        return type === 'image' || type === 'localImage'
      }).length
      return [{ kind: 'user', id, text, images }]
    }
    case 'agentMessage': {
      const text = str(item.text) ?? ''
      return text ? [{ kind: 'text', id, text }] : []
    }
    case 'plan': {
      const text = str(item.text) ?? ''
      return text ? [{ kind: 'text', id, text }] : []
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string') : []
      const content = Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === 'string') : []
      const text = (summary.length > 0 ? summary : content).join('\n\n').trim()
      return text ? [{ kind: 'thinking', id, text }] : []
    }
    case 'commandExecution': {
      const command = unwrapShellCommand(str(item.command) ?? '')
      const output = str(item.aggregatedOutput) ?? ''
      const exit = typeof item.exitCode === 'number' && item.exitCode !== 0 ? `\n(exit ${item.exitCode})` : ''
      return [tool(id, 'Bash', { command }, codexStatus(item.status), output || exit ? `${output}${exit}`.trim() : undefined)]
    }
    case 'fileChange':
      return fileChangeRows(id, item.changes, codexStatus(item.status))
    case 'mcpToolCall': {
      const name = `mcp__${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}`
      const error = str(obj(item.error)?.message)
      const result = error ?? textOf(obj(item.result)?.content)
      const status = item.status === 'failed' ? 'error' : codexStatus(item.status)
      return [tool(id, name, obj(item.arguments) ?? {}, status, result)]
    }
    case 'dynamicToolCall': {
      const result = Array.isArray(item.contentItems) ? item.contentItems.map((c) => str(obj(c)?.text)).filter(Boolean).join('\n') : ''
      const status = item.success === false ? 'error' : codexStatus(item.status)
      return [tool(id, str(item.tool) ?? 'tool', obj(item.arguments) ?? {}, status, result)]
    }
    case 'webSearch': {
      const query = str(item.query) ?? str(obj(item.action)?.query) ?? ''
      return [tool(id, 'WebSearch', { query }, 'done')]
    }
    case 'imageView':
      return [tool(id, 'Read', { file_path: str(item.path) ?? '' }, 'done')]
    case 'collabAgentToolCall': {
      const prompt = str(item.prompt) ?? ''
      return [tool(id, 'Agent', { description: str(item.tool) ?? 'agent', prompt }, codexStatus(item.status))]
    }
    case 'contextCompaction':
      return [{ kind: 'notice', id, text: 'Context compacted', tone: 'muted' }]
    case 'enteredReviewMode':
      return [{ kind: 'notice', id, text: 'Review started', tone: 'muted' }]
    case 'exitedReviewMode': {
      const review = str(item.review) ?? ''
      return review ? [{ kind: 'text', id, text: review }] : []
    }
    default:
      return []
  }
}

/** A resumed thread's turns, oldest first, as rows. */
export function codexHistoryRows(turns: unknown): ChatItem[] {
  if (!Array.isArray(turns)) return []
  const rows: ChatItem[] = []
  for (const raw of turns) {
    const turn = obj(raw)
    if (!turn) continue
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const item of items) rows.push(...codexItemRows(item))
    const error = str(obj(turn.error)?.message)
    if (turn.status === 'interrupted') rows.push({ kind: 'notice', id: `${str(turn.id) ?? rows.length}:end`, text: 'Interrupted', tone: 'muted' })
    else if (turn.status === 'failed' && error) rows.push({ kind: 'notice', id: `${str(turn.id) ?? rows.length}:end`, text: error, tone: 'error' })
  }
  return rows
}

export function codexModels(data: unknown): ChatModelOption[] {
  if (!Array.isArray(data)) return []
  return data.flatMap((raw) => {
    const model = obj(raw)
    const value = str(model?.id) ?? str(model?.model)
    if (!model || !value || model.hidden === true) return []
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((e) => str(obj(e)?.reasoningEffort)).filter((e): e is string => !!e)
      : []
    return [{
      value,
      displayName: str(model.displayName) ?? value,
      ...(str(model.description) ? { description: str(model.description) } : {}),
      ...(efforts.length ? { supportedEffortLevels: efforts } : {})
    }]
  })
}

/** The catalog's default model and its default effort, for "Default (…)". */
export function codexDefaultModel(data: unknown): { model?: string; effort?: string } {
  if (!Array.isArray(data)) return {}
  const model = data.map(obj).find((m) => m?.isDefault === true)
  return model ? { model: str(model.id), effort: str(model.defaultReasoningEffort) } : {}
}

/** `thread/tokenUsage/updated`: how full the context is now (the last request's tokens). */
export function codexContextUsage(tokenUsage: unknown): ChatUsage {
  const usage = obj(tokenUsage)
  const last = obj(usage?.last)
  const window = usage?.modelContextWindow
  const tokens = typeof last?.inputTokens === 'number' ? last.inputTokens + (typeof last.outputTokens === 'number' ? last.outputTokens : 0) : undefined
  return {
    ...(tokens !== undefined ? { contextTokens: tokens } : {}),
    ...(typeof window === 'number' ? { contextMax: window } : {})
  }
}

function limitWindow(raw: unknown): ChatLimitWindow | undefined {
  const window = obj(raw)
  if (!window || typeof window.usedPercent !== 'number') return undefined
  const resetsAt = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : undefined
  return { utilization: window.usedPercent, ...(resetsAt ? { resetsAt } : {}) }
}

/**
 * `account/rateLimits/updated`: the ChatGPT plan's windows. Codex names them
 * primary/secondary; their length says which is the 5-hour one and which the weekly.
 */
export function codexRateLimits(rateLimits: unknown): ChatUsage {
  const limits = obj(rateLimits)
  const usage: ChatUsage = {}
  for (const key of ['primary', 'secondary'] as const) {
    const raw = obj(limits?.[key])
    const window = limitWindow(raw)
    if (!raw || !window) continue
    const minutes = typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : undefined
    if (minutes !== undefined && minutes <= 24 * 60) usage.fiveHour = window
    else usage.sevenDay = window
  }
  return usage
}
