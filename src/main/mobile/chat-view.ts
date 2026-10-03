import { firstLine, summarizeTool } from '../../shared/agent-activity'
import { editPairs, diffLines } from '../../shared/chat-diff'
import { canAlwaysAllow, planText, promptQuestions } from '../../shared/chat-prompts'
import { CHAT_EFFORT_LEVELS, findModelOption } from '../../shared/claude-chat'
import type { ChatImage, ChatItem, ChatLimitWindow, ChatModelOption, ChatPrompt, ChatSessionInfo, ChatState, ChatUsage } from '../../shared/claude-chat'
import { ChatLimits, capText } from '../../../protocol/ts/index.ts'
import type {
  ChatDetailResult,
  ChatEarlierResult,
  ChatView,
  ChatViewItem,
  ChatViewPrompt,
  ChatViewLimitWindow,
  ChatViewQuestion,
  ChatViewSettings,
  ChatViewStatus,
  ChatViewUsage
} from '../../../protocol/ts/index.ts'

/**
 * `ChatState` → the phone's chat view model (protocol/SPEC.md §6.2), and the diff
 * between two of them (§6.4). Pure: the bridge (chat-bridge.ts) owns subscriptions,
 * throttling and sending.
 */

export interface ChatViewTab {
  tabId: string
  title: string
}

export function mapItem(item: ChatItem): ChatViewItem {
  switch (item.kind) {
    case 'user': {
      const out: ChatViewItem = { kind: 'user', id: item.id, text: capText(item.text, ChatLimits.text).text }
      if (item.images > 0) out.images = item.images
      if (item.queued) out.queued = true
      if (item.failed) out.failed = true
      return out
    }
    case 'text': {
      const out: ChatViewItem = { kind: 'text', id: item.id, markdown: capText(item.text, ChatLimits.text).text }
      if (item.streaming) out.streaming = true
      return out
    }
    case 'thinking': {
      const out: ChatViewItem = { kind: 'thinking', id: item.id, preview: capText(item.text, ChatLimits.thinkingPreview).text }
      if (item.streaming) out.streaming = true
      return out
    }
    case 'tool': {
      const out: ChatViewItem = {
        kind: 'tool',
        id: item.id,
        name: item.name,
        summary: item.label,
        status: item.status,
        hasDetail: Object.keys(item.input).length > 0 || item.result !== undefined
      }
      if (item.childCount !== undefined) out.childCount = item.childCount
      if (item.lastChild !== undefined) out.lastChild = item.lastChild
      if (item.images && item.images.length > 0) out.images = Math.min(item.images.length, ChatLimits.toolImages)
      return out
    }
    case 'notice':
      return { kind: 'notice', id: item.id, text: item.text, tone: item.tone }
    case 'bash':
      // The phone has no bash rows; a `!command` reads as the Bash call it is.
      return {
        kind: 'tool',
        id: item.id,
        name: 'Bash',
        summary: `! ${firstLine(item.command, 80) ?? ''}`,
        status: item.running ? 'running' : item.exitCode === 0 || item.exitCode === undefined ? 'done' : 'error',
        hasDetail: true
      }
  }
}

/** Unified-diff-ish lines for an edit, as the desktop card draws them. */
function editDetail(toolName: string, input: Record<string, unknown>): string | null {
  const pairs = editPairs(toolName, input)
  if (!pairs) return null
  const lines: string[] = []
  if (typeof input.file_path === 'string') lines.push(input.file_path)
  for (const pair of pairs) {
    if (lines.length > 0) lines.push('')
    for (const line of diffLines(pair.before, pair.after)) {
      lines.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`)
    }
  }
  return lines.join('\n')
}

/** What the desktop's PermissionCard shows under its title, as one text block. */
function permissionDetail(prompt: ChatPrompt, summary: string): string | undefined {
  const input = prompt.input
  let main: string | null
  if ((prompt.toolName === 'Bash' || prompt.toolName === 'PowerShell') && typeof input.command === 'string') {
    main = input.command
  } else {
    main = editDetail(prompt.toolName, input)
    if (main === null && Object.keys(input).length > 0) main = JSON.stringify(input, null, 2)
  }
  const parts = [
    main,
    prompt.description && prompt.description !== summary ? prompt.description : null,
    prompt.reason ?? null,
    prompt.blockedPath ? `Outside the project: ${prompt.blockedPath}` : null
  ].filter((part): part is string => !!part)
  if (parts.length === 0) return undefined
  return capText(parts.join('\n\n'), ChatLimits.permissionDetail).text
}

export function mapPrompt(prompt: ChatPrompt): ChatViewPrompt {
  if (prompt.kind === 'question') {
    const questions: ChatViewQuestion[] = promptQuestions(prompt.input).map((q) => ({
      question: q.question,
      ...(q.header !== undefined ? { header: q.header } : {}),
      multiSelect: q.multiSelect,
      options: q.options.map((o) => (o.description !== undefined ? { label: o.label, description: o.description } : { label: o.label }))
    }))
    return { kind: 'question', id: prompt.id, questions }
  }
  if (prompt.kind === 'plan') return { kind: 'plan', id: prompt.id, markdown: planText(prompt.input) }
  const summary = summarizeTool(prompt.toolName, prompt.input)
  const out: ChatViewPrompt = {
    kind: 'permission',
    id: prompt.id,
    toolName: prompt.toolName,
    title: prompt.title ?? `Allow ${prompt.toolName}?`,
    summary,
    canAlwaysAllow: canAlwaysAllow(prompt)
  }
  const detail = permissionDetail(prompt, summary)
  if (detail !== undefined) out.detail = detail
  if (prompt.agentId) out.agent = true
  return out
}

export function viewStatus(state: ChatState): ChatViewStatus {
  const status: ChatViewStatus = { busy: state.busy, process: state.process }
  if (state.turnStartedAt !== undefined) status.turnStartedAt = state.turnStartedAt
  if (state.processError !== undefined) status.processError = state.processError
  if (state.info.permissionMode !== undefined) status.permissionMode = state.info.permissionMode
  if (state.info.model !== undefined) status.model = state.info.model
  status.settings = viewSettings(state.info, state.models)
  const usage = viewUsage(state.usage)
  if (usage) status.usage = usage
  return status
}

/** The composer's model and effort pickers, labelled as the desktop's are (Composer.tsx). */
export function viewSettings(info: ChatSessionInfo, models: ChatModelOption[]): ChatViewSettings {
  // The CLI's own "Default" row resolves to a real model; the phone adds a Default row naming it.
  const pickable = models.filter((m) => m.value !== 'default')
  const running = info.modelPicked ? info.model : info.applied?.model ?? info.model
  const current = findModelOption(pickable, info.applied?.model ?? info.model)
  // `info.model` turns into the wire id once the session reports it: send the row's value.
  const model = info.modelPicked && info.model ? findModelOption(pickable, info.model)?.value ?? info.model : undefined
  const modelName = running ? findModelOption(pickable, running)?.displayName ?? running.replace(/^claude-/, '') : undefined
  // `applied.effort` is null when no effort is sent (a model without effort levels).
  const defaultEffort = info.effort ? undefined : info.applied?.effort ?? undefined
  // Keys in the order the protocol's parser gives them.
  return {
    ...(model !== undefined ? { model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    models: pickable.map((m) => ({ value: m.value, label: m.displayName, ...(m.description ? { description: m.description } : {}) })),
    ...(info.effort ? { effort: info.effort } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    efforts: current?.supportedEffortLevels?.length ? current.supportedEffortLevels : CHAT_EFFORT_LEVELS
  }
}

function limitWindow(window: ChatLimitWindow | undefined): ChatViewLimitWindow | undefined {
  if (!window || !Number.isFinite(window.utilization)) return undefined
  const out: ChatViewLimitWindow = { used: Math.round(Math.min(100, Math.max(0, window.utilization))) }
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  if (Number.isFinite(resetsAt) && resetsAt >= 0) out.resetsAt = resetsAt
  return out
}

function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/** The composer's meter; undefined until any part of it is known. */
export function viewUsage(usage: ChatUsage): ChatViewUsage | undefined {
  const out: ChatViewUsage = {}
  const contextTokens = count(usage.contextTokens)
  if (contextTokens !== undefined) out.contextTokens = contextTokens
  const contextMax = count(usage.contextMax)
  if (contextMax !== undefined) out.contextMax = contextMax
  const costCents = count(usage.costUsd !== undefined ? usage.costUsd * 100 : undefined)
  if (costCents !== undefined) out.costCents = costCents
  const fiveHour = limitWindow(usage.fiveHour)
  if (fiveHour) out.fiveHour = fiveHour
  const sevenDay = limitWindow(usage.sevenDay)
  if (sevenDay) out.sevenDay = sevenDay
  return Object.keys(out).length > 0 ? out : undefined
}

/** The whole view, windowed to the last `window` items (§6.4). */
export function toChatView(state: ChatState, tab: ChatViewTab, window: number = ChatLimits.window): ChatView {
  const start = Math.max(0, state.items.length - window)
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...viewStatus(state),
    items: state.items.slice(start).map(mapItem),
    hasEarlier: start > 0,
    prompts: state.pending.map(mapPrompt)
  }
}

/** Up to `limit` items right before `before`; null when `before` isn't in the chat. */
export function earlierItems(state: ChatState, before: string, limit: number = ChatLimits.earlier): ChatEarlierResult | null {
  const index = state.items.findIndex((item) => item.id === before)
  if (index < 0) return null
  const start = Math.max(0, index - limit)
  return { items: state.items.slice(start, index).map(mapItem), hasEarlier: start > 0 }
}

/** `chat.detail`: null when the item doesn't exist. */
export function chatDetail(state: ChatState, itemId: string): ChatDetailResult | null {
  const item = state.items.find((i) => i.id === itemId)
  if (!item) return null
  if (item.kind === 'tool') {
    const input = capText(JSON.stringify(item.input, null, 2), ChatLimits.detail).text
    return item.result !== undefined
      ? { kind: 'tool', input, result: capText(item.result, ChatLimits.detail).text }
      : { kind: 'tool', input }
  }
  if (item.kind === 'bash') {
    const output = [item.stdout, item.stderr].filter(Boolean).join('\n')
    return { kind: 'tool', input: capText(item.command, ChatLimits.detail).text, result: capText(output, ChatLimits.detail).text }
  }
  return { kind: 'text', markdown: capText(item.text, ChatLimits.detail).text }
}

/** `chat.image` (§8.9): image `index` of tool item `itemId`, or null when there is none. */
export function toolImage(state: ChatState, itemId: string, index: number): ChatImage | null {
  const item = state.items.find((i) => i.id === itemId)
  if (item?.kind !== 'tool' || index >= ChatLimits.toolImages) return null
  return item.images?.[index] ?? null
}

/** Equal keys mean the phone already has this exact item. */
export function itemKey(item: ChatViewItem): string {
  return JSON.stringify(item)
}

/** Equal keys mean the phone already has these prompts and status. */
export function headKey(prompts: ChatViewPrompt[], status: ChatViewStatus): string {
  return JSON.stringify([prompts, status])
}

/** What one subscription has sent: the ids in order (oldest first) and their content keys. */
export interface SentItems {
  order: string[]
  keys: Map<string, string>
}

export function emptySent(): SentItems {
  return { order: [], keys: new Map() }
}

export interface ItemDiff {
  upserts: ChatViewItem[]
  removes: string[]
  /** The ids and keys the phone has after applying this diff. */
  next: SentItems
}

/**
 * The upserts and removes that turn what the phone has (`sent`) into the current
 * items. Only items from the phone's oldest one onward are considered (§6.4: the
 * window only grows through `chat.earlier`), plus everything newer.
 *
 * When the items were extended in place — the usual case, new ones only appended —
 * only changed and new items are upserted. When the list was replaced instead
 * (`/clear`, a reset), every sent id is removed and the latest window upserted,
 * so the phone never ends up with items out of order.
 */
export function diffItems(sent: SentItems, items: ChatItem[], window: number = ChatLimits.window): ItemDiff {
  const oldest = sent.order[0]
  const from = oldest === undefined ? -1 : items.findIndex((item) => item.id === oldest)
  if (from < 0) {
    // Nothing sent yet, or the phone's oldest item is gone: start a fresh window.
    const fresh = items.slice(Math.max(0, items.length - window)).map(mapItem)
    const next = emptySent()
    for (const item of fresh) {
      next.order.push(item.id)
      next.keys.set(item.id, itemKey(item))
    }
    return { upserts: fresh, removes: [...sent.order], next }
  }
  const current = items.slice(from)
  // In place when the sent ids are still a prefix-in-order of the current list.
  let inPlace = current.length >= sent.order.length
  for (let i = 0; inPlace && i < sent.order.length; i++) {
    if (current[i].id !== sent.order[i]) inPlace = false
  }
  if (!inPlace) {
    const fresh = items.slice(Math.max(0, items.length - window)).map(mapItem)
    const next = emptySent()
    for (const item of fresh) {
      next.order.push(item.id)
      next.keys.set(item.id, itemKey(item))
    }
    return { upserts: fresh, removes: [...sent.order], next }
  }
  const upserts: ChatViewItem[] = []
  const next: SentItems = { order: [...sent.order], keys: new Map(sent.keys) }
  current.forEach((raw, index) => {
    const item = mapItem(raw)
    const key = itemKey(item)
    if (index >= sent.order.length) {
      next.order.push(item.id)
      next.keys.set(item.id, key)
      upserts.push(item)
    } else if (sent.keys.get(item.id) !== key) {
      next.keys.set(item.id, key)
      upserts.push(item)
    }
  })
  return { upserts, removes: [], next }
}

/** Record items the phone just received through `chat.open` or `chat.earlier`. */
export function recordSent(sent: SentItems, items: ChatViewItem[], position: 'replace' | 'prepend'): SentItems {
  const next: SentItems = position === 'replace' ? emptySent() : { order: [...sent.order], keys: new Map(sent.keys) }
  const ids = items.map((item) => item.id)
  next.order = position === 'replace' ? ids : [...ids.filter((id) => !next.keys.has(id)), ...next.order]
  for (const item of items) next.keys.set(item.id, itemKey(item))
  return next
}
