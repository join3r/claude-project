import { ProtocolError } from './errors.ts'

/**
 * M2 chat (SPEC.md §6.2–§6.4): the chat view model the phone renders, the `chat.*`
 * ops' params and results, and the `evt chat` diff. Parsers are tolerant the same way
 * as M1's: unknown fields are dropped, `null` optional fields are absent, and an item
 * or prompt of a kind this build doesn't know comes back as `kind: 'unknown'` (shown
 * as "Needs a newer app") instead of failing the whole message.
 */

export const ChatOp = {
  Open: 'chat.open',
  Close: 'chat.close',
  Earlier: 'chat.earlier',
  Send: 'chat.send',
  Answer: 'chat.answer',
  Interrupt: 'chat.interrupt',
  Detail: 'chat.detail'
} as const
export type ChatOpName = (typeof ChatOp)[keyof typeof ChatOp]
export const CHAT_OPS: readonly string[] = Object.values(ChatOp)

/**
 * `chat.new` (SPEC.md §8.2). Kept out of {@link ChatOp}: it names a task, not a
 * chat tab, so it doesn't go through {@link parseChatParams}.
 */
export const CHAT_NEW_OP = 'chat.new'
/** The handshake feature (§8.1) a desktop lists when it answers `chat.new`. */
export const CHAT_NEW_FEATURE = 'chat.new'

export interface ChatNewParams { taskId: string }
export interface ChatNewResult { tabId: string }

/**
 * `task.new` (SPEC.md §8.4): a new task in a project, with one claude-chat tab that
 * starts on `prompt`. Like `chat.new` it names no tab, so it has parsers of its own.
 */
export const TASK_NEW_OP = 'task.new'
/** The handshake feature (§8.1) a desktop lists when it answers `task.new`. */
export const TASK_NEW_FEATURE = 'task.new'
/** The permission modes `task.new` may start Claude in (§8.4). */
export const TASK_NEW_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
export type TaskNewMode = (typeof TASK_NEW_MODES)[number]

export interface TaskNewParams { projectId: string; prompt: string; mode?: TaskNewMode; workspace?: boolean }
export interface TaskNewResult { taskId: string; tabId: string }

/** The handshake feature (§8.1) a desktop lists when `task.new` takes `workspace: true` (§8.6). */
export const TASK_WORKSPACE_FEATURE = 'task.workspace'

/**
 * `task.close` (SPEC.md §8.7): delete a task, and its worktree when it is a
 * workspace. Work that would be lost is reported instead, until the phone resends
 * with the matching `discard*` flag.
 */
export const TASK_CLOSE_OP = 'task.close'
/** The handshake feature (§8.1) a desktop lists when it answers `task.close`. */
export const TASK_CLOSE_FEATURE = 'task.close'
/** Why `task.close` left a task open (§8.7). */
export const TASK_CLOSE_BLOCKERS = ['unsaved', 'uncommitted', 'unmerged', 'uncommitted-and-unmerged', 'check-failed'] as const
export type TaskCloseBlocker = (typeof TASK_CLOSE_BLOCKERS)[number]

export interface TaskCloseParams { taskId: string; discardUnsaved?: boolean; discardWorkspace?: boolean; keepBranch?: boolean }
export type TaskCloseResult =
  | { closed: true; warning?: string }
  | { closed: false; blocker: TaskCloseBlocker; branch?: string; baseBranch?: string; message?: string }

/** `tab.close` (SPEC.md §8.8): close one agent or terminal tab of a task. */
export const TAB_CLOSE_OP = 'tab.close'
/** The handshake feature (§8.1) a desktop lists when it answers `tab.close`. */
export const TAB_CLOSE_FEATURE = 'tab.close'

export interface TabCloseParams { tabId: string }

/**
 * `pin.set` (SPEC.md §8.10): pin or unpin a project, or a task when `taskId` is
 * set, in the desktop sidebar's Pinned list.
 */
export const PIN_SET_OP = 'pin.set'
/** The handshake feature (§8.1) a desktop lists when it answers `pin.set` and sends `pinned`. */
export const PIN_FEATURE = 'pin'

export interface PinSetParams { projectId: string; taskId?: string; pinned: boolean }

/**
 * `chat.settings` (SPEC.md §8.5): change an open chat's permission mode, model or
 * effort, as the desktop composer's pickers do. An absent field stays as it is; an
 * empty `model` or `effort` goes back to Claude's settings default.
 */
export const CHAT_SETTINGS_OP = 'chat.settings'
/** The handshake feature (§8.1) a desktop lists when it answers `chat.settings`. */
export const CHAT_SETTINGS_FEATURE = 'chat.settings'

export interface ChatSettingsParams { tabId: string; mode?: TaskNewMode; model?: string; effort?: string }

/**
 * `chat.image` (SPEC.md §8.9): one image a tool result carried (a Read of a PNG, a
 * browser screenshot), downscaled by the desktop to fit `maxSide` and one message.
 */
export const CHAT_IMAGE_OP = 'chat.image'
/** The handshake feature (§8.1) a desktop lists when it answers `chat.image` and counts `tool.images`. */
export const CHAT_IMAGE_FEATURE = 'chat.image'
/** The image types `chat.image` answers with. */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface ChatImageParams { tabId: string; itemId: string; index: number; maxSide?: number }
export interface ChatImageResult { mediaType: string; data: string }

/** Caps from §6.2–§6.4. */
export const ChatLimits = {
  /** `text.markdown` / `user.text` in the view; longer ones end in "…" and come through `chat.detail`. */
  text: 16000,
  /** `thinking.preview`. */
  thinkingPreview: 300,
  /** `permission.detail`. */
  permissionDetail: 4000,
  /** `chat.detail` input / result, each. */
  detail: 200000,
  /** `chat.send` text. */
  send: 32000,
  /** Items `chat.open` returns. */
  window: 60,
  /** Largest (and default) `chat.earlier` limit. */
  earlier: 100,
  /** `evt chat` per subscription per second. */
  eventsPerSecond: 4,
  /** `tool.images`: images kept per tool result. */
  toolImages: 4,
  /** `chat.image` `maxSide` bounds and default, in pixels. */
  imageMinSide: 64,
  imageMaxSide: 4096,
  imageDefaultSide: 2048,
  /** `chat.image` base64 `data`, so the result fits one message (§6.1). */
  imageData: 3_000_000
} as const

export type ChatViewToolStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'denied'
export type ChatViewTone = 'muted' | 'warning' | 'error'
export type ChatViewProcess = 'idle' | 'starting' | 'running' | 'exited'

export interface ChatViewUserItem { kind: 'user'; id: string; text: string; images?: number; queued?: true; failed?: true }
export interface ChatViewTextItem { kind: 'text'; id: string; markdown: string; streaming?: true }
export interface ChatViewThinkingItem { kind: 'thinking'; id: string; preview: string; streaming?: true }
export interface ChatViewToolItem {
  kind: 'tool'
  id: string
  name: string
  summary: string
  status: ChatViewToolStatus
  hasDetail: boolean
  childCount?: number
  lastChild?: string
  /** Images the result carried, 1–4; fetched one at a time with `chat.image`. */
  images?: number
}
export interface ChatViewNoticeItem { kind: 'notice'; id: string; text: string; tone: ChatViewTone }
/** An item kind from a newer desktop: keep its place, show "Needs a newer app". */
export interface ChatViewUnknownItem { kind: 'unknown'; id: string; unknownKind: string }

export type ChatViewItem =
  | ChatViewUserItem
  | ChatViewTextItem
  | ChatViewThinkingItem
  | ChatViewToolItem
  | ChatViewNoticeItem
  | ChatViewUnknownItem

export interface ChatViewQuestionOption { label: string; description?: string }
export interface ChatViewQuestion { question: string; header?: string; multiSelect: boolean; options: ChatViewQuestionOption[] }

export interface ChatViewPermissionPrompt {
  kind: 'permission'
  id: string
  toolName: string
  title: string
  summary: string
  detail?: string
  canAlwaysAllow: boolean
  agent?: true
}
export interface ChatViewQuestionPrompt { kind: 'question'; id: string; questions: ChatViewQuestion[] }
export interface ChatViewPlanPrompt { kind: 'plan'; id: string; markdown: string }
export interface ChatViewUnknownPrompt { kind: 'unknown'; id: string; unknownKind: string }

export type ChatViewPrompt = ChatViewPermissionPrompt | ChatViewQuestionPrompt | ChatViewPlanPrompt | ChatViewUnknownPrompt

/** One row of the model picker. */
export interface ChatViewModelOption { value: string; label: string; description?: string }

/** The composer's model and effort pickers (§6.2). */
export interface ChatViewSettings {
  /** The model picked in this chat (a `models` value); absent = Claude's settings default. */
  model?: string
  /** What the session runs, by name ("Opus 5.5"), once known. */
  modelName?: string
  /** Pickable models, without a "Default" row: the phone adds that. */
  models: ChatViewModelOption[]
  /** The effort picked in this chat; absent = the default. */
  effort?: string
  /** The effort the default resolves to, once known. */
  defaultEffort?: string
  /** The effort levels the current model takes. */
  efforts: string[]
}

/** One plan rate-limit window. */
export interface ChatViewLimitWindow {
  /** Percent used, 0–100. */
  used: number
  /** Unix ms. */
  resetsAt?: number
}

/** The composer's meter (§6.2); each part appears once the desktop has read it. */
export interface ChatViewUsage {
  contextTokens?: number
  contextMax?: number
  /** Session cost at API list prices, in US cents. */
  costCents?: number
  /** claude.ai plan windows; absent for API-key sessions. */
  fiveHour?: ChatViewLimitWindow
  sevenDay?: ChatViewLimitWindow
}

/** The session-level fields `ChatView` and `evt chat` share. */
export interface ChatViewStatus {
  busy: boolean
  turnStartedAt?: number
  process: ChatViewProcess
  processError?: string
  permissionMode?: string
  model?: string
  settings?: ChatViewSettings
  usage?: ChatViewUsage
}

export interface ChatView extends ChatViewStatus {
  tabId: string
  title: string
  /** Oldest → newest; the last {@link ChatLimits.window} items at `chat.open`. */
  items: ChatViewItem[]
  hasEarlier: boolean
  prompts: ChatViewPrompt[]
}

export interface ChatViewEvent extends ChatViewStatus {
  t: 'evt'
  e: 'chat'
  tabId: string
  seq: number
  upserts: ChatViewItem[]
  removes: string[]
  /** Always the full open-prompt list. */
  prompts: ChatViewPrompt[]
}

// ---- ops ------------------------------------------------------------------------

export interface ChatTabParams { tabId: string }
export interface ChatEarlierParams { tabId: string; before: string; limit?: number }
export interface ChatSendParams { tabId: string; text: string }
export interface ChatDetailParams { tabId: string; itemId: string }

export type ChatAnswer =
  | { behavior: 'allow'; always?: true }
  | { behavior: 'deny'; message?: string }
  /** Question prompts: question text → the chosen label(s), multi-select joined with ", ". */
  | { behavior: 'answers'; answers: Record<string, string> }
  | { behavior: 'approvePlan' }

export interface ChatAnswerParams { tabId: string; promptId: string; answer: ChatAnswer }

export type ChatParams = ChatTabParams | ChatEarlierParams | ChatSendParams | ChatDetailParams | ChatAnswerParams | ChatSettingsParams | ChatImageParams

export interface ChatOpenResult { seq: number; view: ChatView }
export interface ChatEarlierResult { items: ChatViewItem[]; hasEarlier: boolean }
export type ChatDetailResult =
  | { kind: 'tool'; input: string; result?: string }
  | { kind: 'text'; markdown: string }
/** chat.close / send / answer / interrupt. */
export type ChatEmptyResult = Record<string, never>
export type ChatResult = ChatOpenResult | ChatEarlierResult | ChatDetailResult | ChatEmptyResult

// ---- parsing ----------------------------------------------------------------------

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function obj(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`)
  return value as Obj
}

function absent(o: Obj, key: string): boolean {
  return o[key] === undefined || o[key] === null
}

function str(o: Obj, key: string): string {
  const value = o[key]
  if (typeof value !== 'string') fail(`${key} must be a string`)
  return value
}

function optStr(o: Obj, key: string): string | undefined {
  return absent(o, key) ? undefined : str(o, key)
}

function int(o: Obj, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative integer`)
  return value
}

function optInt(o: Obj, key: string): number | undefined {
  return absent(o, key) ? undefined : int(o, key)
}

function bool(o: Obj, key: string): boolean {
  const value = o[key]
  if (typeof value !== 'boolean') fail(`${key} must be a boolean`)
  return value
}

/** Flags that are either `true` or absent on the wire; anything else counts as absent. */
function flag(o: Obj, key: string): boolean {
  return o[key] === true
}

function arr(o: Obj, key: string): unknown[] {
  const value = o[key]
  if (!Array.isArray(value)) fail(`${key} must be an array`)
  return value
}

/** An open enum: a value this build doesn't know becomes `fallback`. */
function soft<T extends string>(o: Obj, key: string, allowed: readonly string[], fallback: T): T {
  const value = str(o, key)
  return (allowed.includes(value) ? value : fallback) as T
}

const TOOL_STATUSES: readonly string[] = ['pending', 'running', 'waiting', 'done', 'error', 'denied']
const TONES: readonly string[] = ['muted', 'warning', 'error']
const PROCESSES: readonly string[] = ['idle', 'starting', 'running', 'exited']

/**
 * One transcript item. Unknown kinds come back as `{ kind: 'unknown', id, unknownKind }`;
 * a known kind with a wrong-typed field throws. An unknown tool `status` reads as
 * `pending`, an unknown notice `tone` as `muted`.
 */
export function parseChatViewItem(value: unknown): ChatViewItem {
  const o = obj(value, 'item')
  const kind = str(o, 'kind')
  const id = str(o, 'id')
  switch (kind) {
    case 'user': {
      const item: ChatViewUserItem = { kind, id, text: str(o, 'text') }
      const images = optInt(o, 'images')
      if (images !== undefined && images > 0) item.images = images
      if (flag(o, 'queued')) item.queued = true
      if (flag(o, 'failed')) item.failed = true
      return item
    }
    case 'text': {
      const item: ChatViewTextItem = { kind, id, markdown: str(o, 'markdown') }
      if (flag(o, 'streaming')) item.streaming = true
      return item
    }
    case 'thinking': {
      const item: ChatViewThinkingItem = { kind, id, preview: str(o, 'preview') }
      if (flag(o, 'streaming')) item.streaming = true
      return item
    }
    case 'tool': {
      const item: ChatViewToolItem = {
        kind,
        id,
        name: str(o, 'name'),
        summary: str(o, 'summary'),
        status: soft<ChatViewToolStatus>(o, 'status', TOOL_STATUSES, 'pending'),
        hasDetail: bool(o, 'hasDetail')
      }
      const childCount = optInt(o, 'childCount')
      if (childCount !== undefined) item.childCount = childCount
      const lastChild = optStr(o, 'lastChild')
      if (lastChild !== undefined) item.lastChild = lastChild
      const images = optInt(o, 'images')
      if (images !== undefined && images > 0) item.images = images
      return item
    }
    case 'notice':
      return { kind, id, text: str(o, 'text'), tone: soft<ChatViewTone>(o, 'tone', TONES, 'muted') }
    default:
      return { kind: 'unknown', id, unknownKind: kind }
  }
}

function parseQuestion(value: unknown): ChatViewQuestion {
  const o = obj(value, 'question')
  const question: ChatViewQuestion = {
    question: str(o, 'question'),
    multiSelect: o.multiSelect === true,
    options: arr(o, 'options').map((raw) => {
      const opt = obj(raw, 'option')
      const option: ChatViewQuestionOption = { label: str(opt, 'label') }
      const description = optStr(opt, 'description')
      if (description !== undefined) option.description = description
      return option
    })
  }
  const header = optStr(o, 'header')
  if (header !== undefined) question.header = header
  return question
}

/** One open prompt. Unknown kinds come back as `{ kind: 'unknown', id, unknownKind }`. */
export function parseChatViewPrompt(value: unknown): ChatViewPrompt {
  const o = obj(value, 'prompt')
  const kind = str(o, 'kind')
  const id = str(o, 'id')
  switch (kind) {
    case 'permission': {
      const prompt: ChatViewPermissionPrompt = {
        kind,
        id,
        toolName: str(o, 'toolName'),
        title: str(o, 'title'),
        summary: str(o, 'summary'),
        canAlwaysAllow: o.canAlwaysAllow === true
      }
      const detail = optStr(o, 'detail')
      if (detail !== undefined) prompt.detail = detail
      if (flag(o, 'agent')) prompt.agent = true
      return prompt
    }
    case 'question':
      return { kind, id, questions: arr(o, 'questions').map(parseQuestion) }
    case 'plan':
      return { kind, id, markdown: str(o, 'markdown') }
    default:
      return { kind: 'unknown', id, unknownKind: kind }
  }
}

function strings(o: Obj, key: string): string[] {
  return arr(o, key).map((value) => {
    if (typeof value !== 'string') fail(`${key} must hold strings`)
    return value
  })
}

/** Keys in a fixed order, as {@link withStatus} does. */
function parseSettings(value: unknown): ChatViewSettings {
  const o = obj(value, 'settings')
  const model = optStr(o, 'model')
  const modelName = optStr(o, 'modelName')
  const effort = optStr(o, 'effort')
  const defaultEffort = optStr(o, 'defaultEffort')
  return {
    ...(model !== undefined ? { model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    models: arr(o, 'models').map((raw) => {
      const m = obj(raw, 'model')
      const description = optStr(m, 'description')
      return { value: str(m, 'value'), label: str(m, 'label'), ...(description !== undefined ? { description } : {}) }
    }),
    ...(effort !== undefined ? { effort } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    efforts: strings(o, 'efforts')
  }
}

function parseLimitWindow(value: unknown): ChatViewLimitWindow {
  const o = obj(value, 'limit')
  const window: ChatViewLimitWindow = { used: int(o, 'used') }
  const resetsAt = optInt(o, 'resetsAt')
  if (resetsAt !== undefined) window.resetsAt = resetsAt
  return window
}

function parseUsage(value: unknown): ChatViewUsage {
  const o = obj(value, 'usage')
  const usage: ChatViewUsage = {}
  for (const key of ['contextTokens', 'contextMax', 'costCents'] as const) {
    const v = optInt(o, key)
    if (v !== undefined) usage[key] = v
  }
  if (!absent(o, 'fiveHour')) usage.fiveHour = parseLimitWindow(o.fiveHour)
  if (!absent(o, 'sevenDay')) usage.sevenDay = parseLimitWindow(o.sevenDay)
  return usage
}

function parseStatus(o: Obj): ChatViewStatus {
  const status: ChatViewStatus = { busy: bool(o, 'busy'), process: soft<ChatViewProcess>(o, 'process', PROCESSES, 'idle') }
  const turnStartedAt = optInt(o, 'turnStartedAt')
  if (turnStartedAt !== undefined) status.turnStartedAt = turnStartedAt
  const processError = optStr(o, 'processError')
  if (processError !== undefined) status.processError = processError
  const permissionMode = optStr(o, 'permissionMode')
  if (permissionMode !== undefined) status.permissionMode = permissionMode
  const model = optStr(o, 'model')
  if (model !== undefined) status.model = model
  if (!absent(o, 'settings')) status.settings = parseSettings(o.settings)
  if (!absent(o, 'usage')) status.usage = parseUsage(o.usage)
  return status
}

/** Keys in a fixed order so parsed values compare equal as JSON text too. */
function withStatus<T extends object>(head: T, status: ChatViewStatus): T & ChatViewStatus {
  return {
    ...head,
    busy: status.busy,
    ...(status.turnStartedAt !== undefined ? { turnStartedAt: status.turnStartedAt } : {}),
    process: status.process,
    ...(status.processError !== undefined ? { processError: status.processError } : {}),
    ...(status.permissionMode !== undefined ? { permissionMode: status.permissionMode } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.settings !== undefined ? { settings: status.settings } : {}),
    ...(status.usage !== undefined ? { usage: status.usage } : {})
  }
}

export function parseChatView(value: unknown): ChatView {
  const o = obj(value, 'view')
  const status = parseStatus(o)
  const view = withStatus({ tabId: str(o, 'tabId'), title: str(o, 'title') }, status)
  return {
    ...view,
    items: arr(o, 'items').map(parseChatViewItem),
    hasEarlier: bool(o, 'hasEarlier'),
    prompts: arr(o, 'prompts').map(parseChatViewPrompt)
  }
}

/** The body of `{ t:'evt', e:'chat', … }` (already-parsed JSON). */
export function parseChatViewEvent(value: unknown): ChatViewEvent {
  const o = obj(value, 'event')
  const status = parseStatus(o)
  const head = withStatus({ t: 'evt' as const, e: 'chat' as const, tabId: str(o, 'tabId'), seq: int(o, 'seq') }, status)
  return {
    ...head,
    upserts: arr(o, 'upserts').map(parseChatViewItem),
    removes: arr(o, 'removes').map((id) => {
      if (typeof id !== 'string') fail('removes must hold strings')
      return id
    }),
    prompts: arr(o, 'prompts').map(parseChatViewPrompt)
  }
}

function parseAnswer(value: unknown): ChatAnswer {
  const o = obj(value, 'answer')
  switch (o.behavior) {
    case 'allow':
      return o.always === true ? { behavior: 'allow', always: true } : { behavior: 'allow' }
    case 'deny': {
      const message = optStr(o, 'message')
      return message !== undefined ? { behavior: 'deny', message } : { behavior: 'deny' }
    }
    case 'answers': {
      const raw = obj(o.answers, 'answers')
      const answers: Record<string, string> = {}
      for (const [question, answer] of Object.entries(raw)) {
        if (typeof answer !== 'string') fail('answers must map questions to strings')
        answers[question] = answer
      }
      return { behavior: 'answers', answers }
    }
    case 'approvePlan':
      return { behavior: 'approvePlan' }
    default:
      return fail('answer.behavior has an unknown value')
  }
}

/**
 * The `params` of a `chat.*` req (the desktop's side). Throws ProtocolError — answer
 * `bad-request` — when they are missing or malformed, including a `chat.send` text
 * over {@link ChatLimits.send} characters. `chat.earlier`'s `limit` is clamped to
 * {@link ChatLimits.earlier}. Returns null for an op that isn't a chat op.
 */
export function parseChatParams(op: string, params: unknown): ChatParams | null {
  if (!CHAT_OPS.includes(op)) return null
  const o = obj(params, 'params')
  const tabId = str(o, 'tabId')
  switch (op as ChatOpName) {
    case ChatOp.Open:
    case ChatOp.Close:
    case ChatOp.Interrupt:
      return { tabId }
    case ChatOp.Earlier: {
      const before = str(o, 'before')
      const limit = optInt(o, 'limit')
      if (limit === 0) fail('limit must be positive')
      return limit === undefined ? { tabId, before } : { tabId, before, limit: Math.min(limit, ChatLimits.earlier) }
    }
    case ChatOp.Send: {
      const text = str(o, 'text')
      if (text.length > ChatLimits.send) fail(`text over ${ChatLimits.send} characters`)
      if (!text.trim()) fail('text is empty')
      return { tabId, text }
    }
    case ChatOp.Answer:
      return { tabId, promptId: str(o, 'promptId'), answer: parseAnswer(o.answer) }
    case ChatOp.Detail:
      return { tabId, itemId: str(o, 'itemId') }
  }
}

/** `chat.new` params (the desktop's side). Throws ProtocolError on a missing `taskId`. */
export function parseChatNewParams(params: unknown): ChatNewParams {
  return { taskId: str(obj(params, 'params'), 'taskId') }
}

/**
 * `task.new` params (the desktop's side). Throws ProtocolError — `bad-request` — on
 * a missing `projectId`, a blank prompt or one over {@link ChatLimits.send}
 * characters, or a `mode` outside {@link TASK_NEW_MODES}.
 */
export function parseTaskNewParams(params: unknown): TaskNewParams {
  const o = obj(params, 'params')
  const projectId = str(o, 'projectId')
  const prompt = str(o, 'prompt')
  if (prompt.length > ChatLimits.send) fail(`prompt over ${ChatLimits.send} characters`)
  if (!prompt.trim()) fail('prompt is empty')
  const out: TaskNewParams = { projectId, prompt }
  const mode = optStr(o, 'mode')
  if (mode !== undefined) {
    if (!(TASK_NEW_MODES as readonly string[]).includes(mode)) fail(`unknown mode ${mode}`)
    out.mode = mode as TaskNewMode
  }
  if (flag(o, 'workspace')) out.workspace = true
  return out
}

/** `task.close` params (the desktop's side). Throws ProtocolError — `bad-request` — on a missing `taskId`. */
export function parseTaskCloseParams(params: unknown): TaskCloseParams {
  const o = obj(params, 'params')
  const out: TaskCloseParams = { taskId: str(o, 'taskId') }
  if (flag(o, 'discardUnsaved')) out.discardUnsaved = true
  if (flag(o, 'discardWorkspace')) out.discardWorkspace = true
  if (flag(o, 'keepBranch')) out.keepBranch = true
  return out
}

/**
 * `task.close` result (the phone's side). A blocker this build doesn't know reads as
 * `check-failed`, which the phone words generically.
 */
export function parseTaskCloseResult(value: unknown): TaskCloseResult {
  const o = obj(value, 'result')
  if (bool(o, 'closed')) {
    const warning = optStr(o, 'warning')
    return warning === undefined ? { closed: true } : { closed: true, warning }
  }
  const out: TaskCloseResult = { closed: false, blocker: soft<TaskCloseBlocker>(o, 'blocker', TASK_CLOSE_BLOCKERS, 'check-failed') }
  const branch = optStr(o, 'branch')
  if (branch !== undefined) out.branch = branch
  const baseBranch = optStr(o, 'baseBranch')
  if (baseBranch !== undefined) out.baseBranch = baseBranch
  const message = optStr(o, 'message')
  if (message !== undefined) out.message = message
  return out
}

/** `tab.close` params (the desktop's side). */
export function parseTabCloseParams(params: unknown): TabCloseParams {
  return { tabId: str(obj(params, 'params'), 'tabId') }
}

/** `pin.set` params (the desktop's side). Throws ProtocolError — `bad-request` — on a missing `projectId` or `pinned`. */
export function parsePinSetParams(params: unknown): PinSetParams {
  const o = obj(params, 'params')
  const out: PinSetParams = { projectId: str(o, 'projectId'), pinned: bool(o, 'pinned') }
  const taskId = optStr(o, 'taskId')
  if (taskId !== undefined) out.taskId = taskId
  return out
}

/**
 * `chat.settings` params (the desktop's side). Throws ProtocolError — `bad-request` —
 * on a missing `tabId`, no field to change, or a `mode` outside {@link TASK_NEW_MODES}.
 */
export function parseChatSettingsParams(params: unknown): ChatSettingsParams {
  const o = obj(params, 'params')
  const out: ChatSettingsParams = { tabId: str(o, 'tabId') }
  const mode = optStr(o, 'mode')
  if (mode !== undefined) {
    if (!(TASK_NEW_MODES as readonly string[]).includes(mode)) fail(`unknown mode ${mode}`)
    out.mode = mode as TaskNewMode
  }
  const model = optStr(o, 'model')
  if (model !== undefined) out.model = model
  const effort = optStr(o, 'effort')
  if (effort !== undefined) out.effort = effort
  if (out.mode === undefined && out.model === undefined && out.effort === undefined) fail('nothing to change')
  return out
}

/**
 * `chat.image` params (the desktop's side). Throws ProtocolError — `bad-request` — on
 * a missing `tabId`, `itemId` or `index`. `maxSide` is clamped to
 * {@link ChatLimits.imageMinSide}…{@link ChatLimits.imageMaxSide}.
 */
export function parseChatImageParams(params: unknown): ChatImageParams {
  const o = obj(params, 'params')
  const out: ChatImageParams = { tabId: str(o, 'tabId'), itemId: str(o, 'itemId'), index: int(o, 'index') }
  const maxSide = optInt(o, 'maxSide')
  if (maxSide !== undefined) out.maxSide = Math.min(ChatLimits.imageMaxSide, Math.max(ChatLimits.imageMinSide, maxSide))
  return out
}

/** `chat.image` result (the phone's side). A `mediaType` outside {@link CHAT_IMAGE_TYPES} or empty `data` throws. */
export function parseChatImageResult(value: unknown): ChatImageResult {
  const o = obj(value, 'result')
  const mediaType = str(o, 'mediaType')
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(mediaType)) fail(`unknown mediaType ${mediaType}`)
  const data = str(o, 'data')
  if (!data) fail('data is empty')
  return { mediaType, data }
}

/** `task.new` result (the phone's side). */
export function parseTaskNewResult(value: unknown): TaskNewResult {
  const o = obj(value, 'result')
  return { taskId: str(o, 'taskId'), tabId: str(o, 'tabId') }
}

/** `chat.new` result (the phone's side). */
export function parseChatNewResult(value: unknown): ChatNewResult {
  return { tabId: str(obj(value, 'result'), 'tabId') }
}

export function parseChatOpenResult(value: unknown): ChatOpenResult {
  const o = obj(value, 'result')
  return { seq: int(o, 'seq'), view: parseChatView(o.view) }
}

export function parseChatEarlierResult(value: unknown): ChatEarlierResult {
  const o = obj(value, 'result')
  return { items: arr(o, 'items').map(parseChatViewItem), hasEarlier: bool(o, 'hasEarlier') }
}

export function parseChatDetailResult(value: unknown): ChatDetailResult {
  const o = obj(value, 'result')
  switch (o.kind) {
    case 'tool': {
      const input = str(o, 'input')
      const result = optStr(o, 'result')
      return result !== undefined ? { kind: 'tool', input, result } : { kind: 'tool', input }
    }
    case 'text':
      return { kind: 'text', markdown: str(o, 'markdown') }
    default:
      return fail('detail kind has an unknown value')
  }
}

/**
 * A `res.result` for a chat op (the phone's side). `chat.close`, `send`, `answer` and
 * `interrupt` answer `{}`; anything they carry is ignored. Returns null for a non-chat op.
 */
export function parseChatResult(op: string, value: unknown): ChatResult | null {
  switch (op) {
    case ChatOp.Open:
      return parseChatOpenResult(value)
    case ChatOp.Earlier:
      return parseChatEarlierResult(value)
    case ChatOp.Detail:
      return parseChatDetailResult(value)
    case ChatOp.Close:
    case ChatOp.Send:
    case ChatOp.Answer:
    case ChatOp.Interrupt:
      obj(value, 'result')
      return {}
    default:
      return null
  }
}

/** Cuts `text` to `limit` characters, ending in "…" when it had to (§6.2). */
export function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  // Don't split a surrogate pair.
  let end = limit - 1
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return { text: `${text.slice(0, end)}…`, truncated: true }
}
