import { summarizeTool } from '../../shared/agent-activity'
import { RESULT_TEXT_LIMIT, type ChatCommand, type ChatItem, type ChatModelOption, type ChatToolItem, type ChatToolStatus, type ChatUsage } from '../../shared/claude-chat'

/**
 * Pi's RPC messages as chat rows. Pure and lenient, like the Codex translator.
 * Pi's built-in tools get Claude Code's names (bash → Bash, edit → MultiEdit…)
 * so the timeline's existing cards draw them; other tools keep their own names.
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

/** A Pi tool call as the Claude tool the timeline knows how to draw. */
export function piTool(name: string, rawArgs: unknown): { name: string; input: Record<string, unknown> } {
  const args = obj(rawArgs) ?? {}
  const path = str(args.path)
  switch (name) {
    case 'bash':
      return { name: 'Bash', input: { command: str(args.command) ?? '' } }
    case 'read':
      return { name: 'Read', input: { file_path: path ?? '', ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) } }
    case 'write':
      return { name: 'Write', input: { file_path: path ?? '', content: str(args.content) ?? '' } }
    case 'edit': {
      const edits = Array.isArray(args.edits)
        ? args.edits.map((e) => ({ old_string: str(obj(e)?.oldText) ?? '', new_string: str(obj(e)?.newText) ?? '' }))
        : [{ old_string: str(args.oldText) ?? '', new_string: str(args.newText) ?? '' }]
      return { name: 'MultiEdit', input: { file_path: path ?? '', edits } }
    }
    case 'grep':
      return { name: 'Grep', input: { pattern: str(args.pattern) ?? '', ...(path ? { path } : {}), ...(str(args.glob) ? { glob: str(args.glob) } : {}) } }
    case 'find':
      return { name: 'Glob', input: { pattern: str(args.pattern) ?? '', ...(path ? { path } : {}) } }
    case 'ls':
      return { name: 'Bash', input: { command: `ls ${path ?? '.'}` } }
    default:
      return { name, input: args }
  }
}

/** A tool result's text (Pi's `content` blocks; images are counted, not drawn). */
export function piResultText(result: unknown): string {
  const content = Array.isArray(obj(result)?.content) ? obj(result)?.content as unknown[] : Array.isArray(result) ? result : []
  const parts: string[] = []
  let images = 0
  for (const raw of content) {
    const block = obj(raw)
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') images++
  }
  if (images > 0) parts.push(images === 1 ? '[image not shown]' : `[${images} images not shown]`)
  return parts.join('\n')
}

export function piToolRow(id: string, name: string, args: unknown, status: ChatToolStatus, result?: string): ChatToolItem {
  const tool = piTool(name, args)
  return {
    kind: 'tool',
    id,
    name: tool.name,
    label: summarizeTool(tool.name, tool.input),
    input: tool.input,
    status,
    ...(result ? { result: truncate(result) } : {})
  }
}

function userText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const text = content.map((block) => (obj(block)?.type === 'text' ? str(obj(block)?.text) : undefined)).filter(Boolean).join('\n')
  const images = content.filter((block) => obj(block)?.type === 'image').length
  return { text, images }
}

/** An assistant message's rows: text, thinking and tool calls, plus its error when it failed. */
export function piAssistantRows(message: Json, key: string): ChatItem[] {
  const rows: ChatItem[] = []
  const content = Array.isArray(message.content) ? message.content : []
  content.forEach((raw, index) => {
    const block = obj(raw)
    if (!block) return
    const id = `${key}:${index}`
    if (block.type === 'text' && str(block.text)?.trim()) rows.push({ kind: 'text', id, text: str(block.text) ?? '' })
    else if (block.type === 'thinking' && str(block.thinking)?.trim()) rows.push({ kind: 'thinking', id, text: str(block.thinking) ?? '' })
    else if (block.type === 'toolCall') rows.push(piToolRow(str(block.id) ?? id, str(block.name) ?? 'tool', block.arguments, 'pending'))
  })
  const error = piMessageError(message)
  if (error) rows.push({ kind: 'notice', id: `${key}:error`, text: error, tone: 'error' })
  return rows
}

/** Why an assistant message failed; nothing for one that was aborted (that is an interrupt). */
export function piMessageError(message: Json): string | undefined {
  if (message.stopReason !== 'error') return undefined
  return str(message.errorMessage) ?? 'Pi stopped with an error.'
}

/** `get_messages`: the whole conversation, as rows. */
export function piHistoryRows(messages: unknown): ChatItem[] {
  if (!Array.isArray(messages)) return []
  const rows: ChatItem[] = []
  const toolRows = new Map<string, number>()
  messages.forEach((raw, index) => {
    const message = obj(raw)
    if (!message) return
    const key = `pi-h${index}`
    switch (message.role) {
      case 'user': {
        const { text, images } = userText(message.content)
        if (text || images) rows.push({ kind: 'user', id: key, text, images })
        return
      }
      case 'assistant':
        for (const row of piAssistantRows(message, key)) {
          if (row.kind === 'tool') toolRows.set(row.id, rows.length)
          rows.push(row.kind === 'tool' ? { ...row, status: 'done' } : row)
        }
        if (message.stopReason === 'aborted') rows.push({ kind: 'notice', id: `${key}:aborted`, text: 'Interrupted', tone: 'muted' })
        return
      case 'toolResult': {
        const index = toolRows.get(str(message.toolCallId) ?? '')
        const row = index === undefined ? undefined : rows[index]
        if (!row || row.kind !== 'tool' || index === undefined) return
        const result = piResultText(message)
        rows[index] = { ...row, status: message.isError === true ? 'error' : 'done', ...(result ? { result: truncate(result) } : {}) }
        return
      }
      case 'bashExecution':
        rows.push({
          kind: 'bash',
          id: key,
          command: str(message.command) ?? '',
          stdout: truncate(str(message.output) ?? ''),
          exitCode: typeof message.exitCode === 'number' ? message.exitCode : null
        })
        return
      default:
    }
  })
  return rows
}

/** The picker's value for a Pi model: `provider/id`, as `--model` takes it. */
export function piModelValue(model: unknown): string | undefined {
  const m = obj(model)
  const id = str(m?.id)
  if (!id) return undefined
  const provider = str(m?.provider)
  return provider ? `${provider}/${id}` : id
}

const BASE_THINKING = ['off', 'minimal', 'low', 'medium', 'high']

export function piModels(models: unknown): ChatModelOption[] {
  if (!Array.isArray(models)) return []
  return models.flatMap((raw) => {
    const model = obj(raw)
    const value = piModelValue(model)
    if (!model || !value) return []
    const map = obj(model.thinkingLevelMap) ?? {}
    const levels = model.reasoning === true ? [...BASE_THINKING, ...['xhigh', 'max'].filter((level) => level in map)] : []
    const provider = str(model.provider)
    return [{
      value,
      displayName: str(model.name) ?? str(model.id) ?? value,
      ...(provider ? { description: provider } : {}),
      ...(levels.length ? { supportedEffortLevels: levels } : {})
    }]
  })
}

/** `get_session_stats`: the context window and the session's cost. */
export function piUsage(stats: unknown): ChatUsage {
  const s = obj(stats)
  const context = obj(s?.contextUsage)
  return {
    ...(typeof context?.tokens === 'number' ? { contextTokens: context.tokens } : {}),
    ...(typeof context?.contextWindow === 'number' ? { contextMax: context.contextWindow } : {}),
    ...(typeof s?.cost === 'number' && s.cost > 0 ? { costUsd: s.cost } : {})
  }
}

export function piCommands(commands: unknown): ChatCommand[] {
  if (!Array.isArray(commands)) return []
  return commands.flatMap((raw) => {
    const command = obj(raw)
    const name = str(command?.name)
    return name ? [{ name, description: str(command?.description) ?? '' }] : []
  })
}
