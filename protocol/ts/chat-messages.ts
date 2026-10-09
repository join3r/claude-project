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
 * `task.new` (SPEC.md §8.4): a new task in one of a project's streams (absent: the
 * stream the project was last used in), with one claude-chat tab that starts on
 * `prompt`. It names no tab, so it has parsers of its own. (It replaced `chat.new`,
 * §8.2, which is retired.)
 */
export const TASK_NEW_OP = 'task.new'
/** The handshake feature (§8.1) a desktop lists when it answers `task.new`. */
export const TASK_NEW_FEATURE = 'task.new'
/** The permission modes `task.new` may start Claude in (§8.4). */
export const TASK_NEW_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
export type TaskNewMode = (typeof TASK_NEW_MODES)[number]

/**
 * The handshake feature (§8.1) a desktop lists when `chat.send` and `task.new`
 * take `images`: pictures sent with the message, as the desktop composer
 * attaches them.
 */
export const SEND_IMAGES_FEATURE = 'send.images'

/** A picture a phone sends with a message (§6.3, §8.4). */
export interface SentImage { mediaType: string; data: string }
export interface TaskNewParams { projectId: string; streamId?: string; prompt: string; mode?: TaskNewMode; images?: SentImage[] }
export interface TaskNewResult { taskId: string; tabId: string }

/**
 * `task.close` (SPEC.md §8.7): archive a task to its stream's Done row, as the
 * desktop sidebar's Close task does. A working agent or unsaved editor is reported
 * instead, until the phone resends with the matching flag.
 */
export const TASK_CLOSE_OP = 'task.close'
/** The handshake feature (§8.1) a desktop lists when it answers `task.close`. */
export const TASK_CLOSE_FEATURE = 'task.close'
/** Why `task.close` left a task open (§8.7), in the order the desktop checks. */
export const TASK_CLOSE_BLOCKERS = ['working', 'unsaved'] as const
export type TaskCloseBlocker = (typeof TASK_CLOSE_BLOCKERS)[number]

export interface TaskCloseParams { taskId: string; stopWorking?: boolean; discardUnsaved?: boolean }
/**
 * `landing` (version 3): a task with a worktree of its own didn't land into its
 * stream, so it stays open with that landing state (§8.7, §8.15).
 */
export type TaskCloseResult =
  | { closed: true }
  | { closed: false; blocker: TaskCloseBlocker }
  | { closed: false; landing: TaskLanding }

/**
 * A task's landing into its stream (SPEC.md §4.4 `landing`, version 3): running, or
 * stopped on a conflict or on the stream's local changes, or with the task's agent
 * asked to fix the conflict. `state` stays an open string, so a newer desktop's
 * state still parses; the phone offers no buttons for one it doesn't know.
 */
export const TASK_LANDING_STATES = ['landing', 'conflict', 'blocked', 'fixing'] as const
/** What the landing was asked for: `close` (the default), `land` (keep the task open), `update` (rebase only). */
export const TASK_LANDING_INTENTS = ['close', 'land', 'update'] as const
export type TaskLandingIntent = (typeof TASK_LANDING_INTENTS)[number]
/** Caps on the wire: the first `files`, and git's `message`. */
export const TaskLandingLimits = { files: 20, message: 1000 } as const

export interface TaskLanding {
  state: string
  intent?: TaskLandingIntent
  /** The conflicted files (`conflict`, `fixing`) or the stream's files in the way (`blocked`), the first 20. */
  files?: string[]
  /** How many there are in all; present with `files`. */
  fileCount?: number
  /** Git's reason (`blocked`), at most 1000 characters. */
  message?: string
}

/**
 * `task.land` (SPEC.md §8.15): a stopped landing's buttons. `fix-with-agent` asks the
 * task's agent to resolve the conflict, `abort` undoes the rebase (the task stays
 * open), `retry` picks the landing up again.
 */
export const TASK_LAND_OP = 'task.land'
/** The handshake feature (§8.1) a desktop lists when it answers `task.land` and sends `landing` and a task's `branch` (§4.4). */
export const TASK_LAND_FEATURE = 'task.land'
export const TASK_LAND_ACTIONS = ['fix-with-agent', 'abort', 'retry'] as const
export type TaskLandAction = (typeof TASK_LAND_ACTIONS)[number]
/** What a `task.land` came to (§8.15). */
export const TASK_LAND_STATUSES = ['landed', 'updated', 'nothing', 'aborted', 'fixing', 'conflict', 'blocked', 'working'] as const
export type TaskLandStatus = (typeof TASK_LAND_STATUSES)[number]

export interface TaskLandParams { taskId: string; action: TaskLandAction }
export interface TaskLandResult {
  status: TaskLandStatus
  /** The landing finished a close: the task moved to its stream's Done row. */
  closed?: true
  /** The task's landing now (`fixing`, `conflict`, `blocked`). */
  landing?: TaskLanding
}

/** `tab.close` (SPEC.md §8.8): close one agent or terminal tab of a task. */
export const TAB_CLOSE_OP = 'tab.close'
/** The handshake feature (§8.1) a desktop lists when it answers `tab.close`. */
export const TAB_CLOSE_FEATURE = 'tab.close'

export interface TabCloseParams { tabId: string }

/**
 * `pin.set` (SPEC.md §8.10): pin or unpin a project, a stream when `streamId` is
 * set, or a task when `taskId` is set, in the desktop sidebar's Pinned list.
 */
export const PIN_SET_OP = 'pin.set'
/** The handshake feature (§8.1) a desktop lists when it answers `pin.set` and sends `pinned`. */
export const PIN_FEATURE = 'pin'

export interface PinSetParams { projectId: string; streamId?: string; taskId?: string; pinned: boolean }

/**
 * `task.triage` (SPEC.md §8.11): the desktop inbox's Mark read, Mark unread, Settle,
 * Unsettle, Snooze and Unsnooze, for one task.
 */
export const TASK_TRIAGE_OP = 'task.triage'
/** The handshake feature (§8.1) a desktop lists when it answers `task.triage` and sends the triage fields (§4.4). */
export const TASK_TRIAGE_FEATURE = 'task.triage'
export const TASK_TRIAGE_ACTIONS = ['read', 'unread', 'settle', 'unsettle', 'snooze', 'unsnooze'] as const
export type TaskTriageAction = (typeof TASK_TRIAGE_ACTIONS)[number]

/** A `snooze` carries exactly one of `until` and `untilAttention`; the other actions carry neither. */
export interface TaskTriageParams { taskId: string; action: TaskTriageAction; until?: number; untilAttention?: true }

/**
 * `stream.new` (SPEC.md §8.12): a new stream at the end of a project's list, as the
 * desktop's New stream dialog makes it: on a new worktree (`worktree: true`, branch
 * `branch` forked from `baseBranch`) or in the project folder.
 */
export const STREAM_NEW_OP = 'stream.new'
/** The handshake feature (§8.1) a desktop lists when it answers `stream.new`. */
export const STREAM_NEW_FEATURE = 'stream.new'

/** `branch` and `baseBranch` are only kept with `worktree: true`. */
export interface StreamNewParams { projectId: string; name: string; worktree: boolean; branch?: string; baseBranch?: string }
export interface StreamNewResult { streamId: string }

/**
 * `branches.list` (SPEC.md §8.13): a project's local branches, for the New stream
 * sheet's From picker, and the one the desktop's dialog picks first.
 */
export const BRANCHES_LIST_OP = 'branches.list'
/** The handshake feature (§8.1) a desktop lists when it answers `branches.list`. */
export const BRANCHES_LIST_FEATURE = 'branches.list'

export interface BranchesListParams { projectId: string }
export interface BranchesListResult { branches: string[]; defaultBase: string }

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

/**
 * The composer's `/` menu (SPEC.md §8.14): `chat.commands` lists Claude Code's
 * commands and skills, `chat.btw` asks a side question, and `chat.permissions` /
 * `chat.permissions.update` read and edit the allow, ask and deny rules. One feature
 * covers all four.
 */
export const CHAT_COMMANDS_OP = 'chat.commands'
export const CHAT_BTW_OP = 'chat.btw'
export const CHAT_PERMISSIONS_OP = 'chat.permissions'
export const CHAT_PERMISSIONS_UPDATE_OP = 'chat.permissions.update'
/** The handshake feature (§8.1) a desktop lists when it answers the four ops above. */
export const CHAT_COMMANDS_FEATURE = 'chat.commands'

export interface ChatCommandEntry {
  name: string
  description?: string
  argumentHint?: string
  /** Only works in the terminal UI; the phone lists it greyed out. */
  terminalOnly?: true
}
export interface ChatCommandsResult { commands: ChatCommandEntry[] }

export interface ChatBtwParams { tabId: string; question: string }
export interface ChatBtwResult {
  /** Null when Claude had nothing to say (the question was cancelled). */
  response: string | null
  /** The CLI made the answer up itself (an error or refusal), not the model. */
  synthetic?: true
}

/** The settings files Claude reads permission rules from, most specific first. */
export const CHAT_PERMISSION_KINDS = ['localSettings', 'projectSettings', 'userSettings'] as const
export type ChatPermissionKind = (typeof CHAT_PERMISSION_KINDS)[number]
export const CHAT_PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny'] as const
export type ChatPermissionBehavior = (typeof CHAT_PERMISSION_BEHAVIORS)[number]
export const CHAT_PERMISSION_ACTIONS = ['add', 'remove'] as const
export type ChatPermissionAction = (typeof CHAT_PERMISSION_ACTIONS)[number]

export interface ChatPermissionSource {
  kind: ChatPermissionKind
  /** The settings file, absolute, on the desktop. */
  path: string
  exists: boolean
  allow: string[]
  ask: string[]
  deny: string[]
  /** It exists but couldn't be read; it isn't edited. */
  error?: string
}
export interface ChatPermissionsResult { sources: ChatPermissionSource[] }
export interface ChatPermissionsUpdateParams {
  tabId: string
  kind: ChatPermissionKind
  behavior: ChatPermissionBehavior
  rule: string
  action: ChatPermissionAction
}

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
  imageData: 3_000_000,
  /** `chat.send` / `task.new` images: how many, and their base64 `data` in total, so the req fits one message (§6.1). */
  sentImages: 4,
  sentImageData: 3_000_000,
  /** `chat.btw` question (§8.14). */
  btwQuestion: 20_000,
  /** `chat.permissions.update` rule (§8.14). */
  permissionRule: 2000
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
export interface ChatSendParams { tabId: string; text: string; images?: SentImage[] }
export interface ChatDetailParams { tabId: string; itemId: string }

export type ChatAnswer =
  | { behavior: 'allow'; always?: true }
  | { behavior: 'deny'; message?: string }
  /** Question prompts: question text → the chosen label(s), multi-select joined with ", ". */
  | { behavior: 'answers'; answers: Record<string, string> }
  | { behavior: 'approvePlan' }

export interface ChatAnswerParams { tabId: string; promptId: string; answer: ChatAnswer }

export type ChatParams =
  | ChatTabParams
  | ChatEarlierParams
  | ChatSendParams
  | ChatDetailParams
  | ChatAnswerParams
  | ChatSettingsParams
  | ChatImageParams
  | ChatBtwParams
  | ChatPermissionsUpdateParams

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
      const images = sentImages(o)
      return images ? { tabId, text, images } : { tabId, text }
    }
    case ChatOp.Answer:
      return { tabId, promptId: str(o, 'promptId'), answer: parseAnswer(o.answer) }
    case ChatOp.Detail:
      return { tabId, itemId: str(o, 'itemId') }
  }
}

/**
 * `task.new` params (the desktop's side). Throws ProtocolError — `bad-request` — on
 * a missing `projectId`, a blank prompt or one over {@link ChatLimits.send}
 * characters, a `mode` outside {@link TASK_NEW_MODES}, or `images` that aren't
 * {@link CHAT_IMAGE_TYPES} or go over {@link ChatLimits.sentImages} /
 * {@link ChatLimits.sentImageData}.
 */
export function parseTaskNewParams(params: unknown): TaskNewParams {
  const o = obj(params, 'params')
  const projectId = str(o, 'projectId')
  const prompt = str(o, 'prompt')
  if (prompt.length > ChatLimits.send) fail(`prompt over ${ChatLimits.send} characters`)
  if (!prompt.trim()) fail('prompt is empty')
  const out: TaskNewParams = { projectId, prompt }
  const streamId = optStr(o, 'streamId')
  if (streamId !== undefined) out.streamId = streamId
  const mode = optStr(o, 'mode')
  if (mode !== undefined) {
    if (!(TASK_NEW_MODES as readonly string[]).includes(mode)) fail(`unknown mode ${mode}`)
    out.mode = mode as TaskNewMode
  }
  const images = sentImages(o)
  if (images) out.images = images
  return out
}

/**
 * `images` of `chat.send` and `task.new`: undefined when absent or empty. Throws on
 * a type outside {@link CHAT_IMAGE_TYPES}, empty `data`, or more than the limits.
 */
function sentImages(o: Obj): SentImage[] | undefined {
  if (absent(o, 'images')) return undefined
  const images = arr(o, 'images').map((value) => {
    const image = obj(value, 'image')
    const mediaType = str(image, 'mediaType')
    if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(mediaType)) fail(`unknown mediaType ${mediaType}`)
    const data = str(image, 'data')
    if (!data) fail('image data is empty')
    return { mediaType, data }
  })
  if (images.length > ChatLimits.sentImages) fail(`more than ${ChatLimits.sentImages} images`)
  if (images.reduce((sum, image) => sum + image.data.length, 0) > ChatLimits.sentImageData) {
    fail(`images over ${ChatLimits.sentImageData} characters`)
  }
  return images.length > 0 ? images : undefined
}

/** `task.close` params (the desktop's side). Throws ProtocolError — `bad-request` — on a missing `taskId`. */
export function parseTaskCloseParams(params: unknown): TaskCloseParams {
  const o = obj(params, 'params')
  const out: TaskCloseParams = { taskId: str(o, 'taskId') }
  if (flag(o, 'stopWorking')) out.stopWorking = true
  if (flag(o, 'discardUnsaved')) out.discardUnsaved = true
  return out
}

/**
 * `task.close` result (the phone's side). A blocker outside {@link TASK_CLOSE_BLOCKERS}
 * throws. `closed: false` with a `landing` is a task that didn't land (version 3).
 */
export function parseTaskCloseResult(value: unknown): TaskCloseResult {
  const o = obj(value, 'result')
  if (bool(o, 'closed')) return { closed: true }
  if (!absent(o, 'landing')) return { closed: false, landing: parseTaskLanding(o.landing) }
  const blocker = str(o, 'blocker')
  if (!(TASK_CLOSE_BLOCKERS as readonly string[]).includes(blocker)) fail(`unknown blocker ${blocker}`)
  return { closed: false, blocker: blocker as TaskCloseBlocker }
}

/** `tab.close` params (the desktop's side). */
export function parseTabCloseParams(params: unknown): TabCloseParams {
  return { tabId: str(obj(params, 'params'), 'tabId') }
}

/** `pin.set` params (the desktop's side). Throws ProtocolError — `bad-request` — on a missing `projectId` or `pinned`. */
export function parsePinSetParams(params: unknown): PinSetParams {
  const o = obj(params, 'params')
  const out: PinSetParams = { projectId: str(o, 'projectId'), pinned: bool(o, 'pinned') }
  const streamId = optStr(o, 'streamId')
  if (streamId !== undefined) out.streamId = streamId
  const taskId = optStr(o, 'taskId')
  if (taskId !== undefined) out.taskId = taskId
  return out
}

/**
 * `task.triage` params (the desktop's side). Throws ProtocolError — `bad-request` — on a
 * missing `taskId`, an unknown `action`, or a `snooze` without exactly one of `until`
 * and `untilAttention: true`. Other actions drop both.
 */
export function parseTaskTriageParams(params: unknown): TaskTriageParams {
  const o = obj(params, 'params')
  const taskId = str(o, 'taskId')
  const action = str(o, 'action')
  if (!(TASK_TRIAGE_ACTIONS as readonly string[]).includes(action)) fail(`unknown action ${action}`)
  const out: TaskTriageParams = { taskId, action: action as TaskTriageAction }
  if (action !== 'snooze') return out
  const until = optInt(o, 'until')
  const untilAttention = flag(o, 'untilAttention')
  if ((until !== undefined) === untilAttention) fail('snooze needs exactly one of until and untilAttention')
  if (until !== undefined) out.until = until
  else out.untilAttention = true
  return out
}

/**
 * A task's `landing` (§4.4, version 3), on a wire task or in a `task.close` /
 * `task.land` result. `state` is kept as sent (an open string); an unknown `intent`
 * is dropped (it reads as `close`).
 */
export function parseTaskLanding(value: unknown): TaskLanding {
  const o = obj(value, 'landing')
  const landing: TaskLanding = { state: str(o, 'state') }
  const intent = optStr(o, 'intent')
  if (intent !== undefined && (TASK_LANDING_INTENTS as readonly string[]).includes(intent)) landing.intent = intent as TaskLandingIntent
  if (!absent(o, 'files')) {
    const files = strings(o, 'files')
    if (files.length > 0) landing.files = files
  }
  const fileCount = optInt(o, 'fileCount')
  if (fileCount !== undefined) landing.fileCount = fileCount
  const message = optStr(o, 'message')
  if (message !== undefined) landing.message = message
  return landing
}

/** `task.land` params (the desktop's side). Throws ProtocolError — `bad-request` — on a missing `taskId` or an unknown `action`. */
export function parseTaskLandParams(params: unknown): TaskLandParams {
  const o = obj(params, 'params')
  return { taskId: str(o, 'taskId'), action: oneOf(o, 'action', TASK_LAND_ACTIONS) }
}

/** `task.land` result (the phone's side). A status outside {@link TASK_LAND_STATUSES} throws. */
export function parseTaskLandResult(value: unknown): TaskLandResult {
  const o = obj(value, 'result')
  const result: TaskLandResult = { status: oneOf(o, 'status', TASK_LAND_STATUSES) }
  if (flag(o, 'closed')) result.closed = true
  if (!absent(o, 'landing')) result.landing = parseTaskLanding(o.landing)
  return result
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

/** `chat.commands` and `chat.permissions` params (the desktop's side): just `tabId`. */
export function parseChatCommandsParams(params: unknown): ChatTabParams {
  return { tabId: str(obj(params, 'params'), 'tabId') }
}

export const parseChatPermissionsParams = parseChatCommandsParams

/** `chat.commands` result (the phone's side). `terminalOnly` other than `true` is absent. */
export function parseChatCommandsResult(value: unknown): ChatCommandsResult {
  const o = obj(value, 'result')
  return {
    commands: arr(o, 'commands').map((raw) => {
      const c = obj(raw, 'command')
      const command: ChatCommandEntry = { name: str(c, 'name') }
      const description = optStr(c, 'description')
      if (description !== undefined) command.description = description
      const argumentHint = optStr(c, 'argumentHint')
      if (argumentHint !== undefined) command.argumentHint = argumentHint
      if (flag(c, 'terminalOnly')) command.terminalOnly = true
      return command
    })
  }
}

/**
 * `chat.btw` params (the desktop's side). Throws ProtocolError — `bad-request` — on a
 * missing `tabId`, or a blank question or one over {@link ChatLimits.btwQuestion} characters.
 */
export function parseChatBtwParams(params: unknown): ChatBtwParams {
  const o = obj(params, 'params')
  const tabId = str(o, 'tabId')
  const question = str(o, 'question')
  if (question.length > ChatLimits.btwQuestion) fail(`question over ${ChatLimits.btwQuestion} characters`)
  if (!question.trim()) fail('question is empty')
  return { tabId, question }
}

/** `chat.btw` result (the phone's side). `response` is a string or `null`; absent reads as `null`. */
export function parseChatBtwResult(value: unknown): ChatBtwResult {
  const o = obj(value, 'result')
  const result: ChatBtwResult = { response: optStr(o, 'response') ?? null }
  if (flag(o, 'synthetic')) result.synthetic = true
  return result
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[]): T {
  const value = str(o, key)
  if (!(allowed as readonly string[]).includes(value)) fail(`unknown ${key} ${value}`)
  return value as T
}

/**
 * `chat.permissions.update` params (the desktop's side). Throws ProtocolError —
 * `bad-request` — on a missing `tabId`, an unknown `kind`, `behavior` or `action`, or
 * a blank rule or one over {@link ChatLimits.permissionRule} characters.
 */
export function parseChatPermissionsUpdateParams(params: unknown): ChatPermissionsUpdateParams {
  const o = obj(params, 'params')
  const tabId = str(o, 'tabId')
  const kind = oneOf(o, 'kind', CHAT_PERMISSION_KINDS)
  const behavior = oneOf(o, 'behavior', CHAT_PERMISSION_BEHAVIORS)
  const rule = str(o, 'rule')
  if (rule.length > ChatLimits.permissionRule) fail(`rule over ${ChatLimits.permissionRule} characters`)
  if (!rule.trim()) fail('rule is empty')
  return { tabId, kind, behavior, rule, action: oneOf(o, 'action', CHAT_PERMISSION_ACTIONS) }
}

/**
 * `chat.permissions` and `chat.permissions.update` result (the phone's side). A source
 * of a kind this build doesn't know is skipped.
 */
export function parseChatPermissionsResult(value: unknown): ChatPermissionsResult {
  const o = obj(value, 'result')
  const sources: ChatPermissionSource[] = []
  for (const raw of arr(o, 'sources')) {
    const s = obj(raw, 'source')
    const kind = str(s, 'kind')
    if (!(CHAT_PERMISSION_KINDS as readonly string[]).includes(kind)) continue
    const source: ChatPermissionSource = {
      kind: kind as ChatPermissionKind,
      path: str(s, 'path'),
      exists: bool(s, 'exists'),
      allow: strings(s, 'allow'),
      ask: strings(s, 'ask'),
      deny: strings(s, 'deny')
    }
    const error = optStr(s, 'error')
    if (error !== undefined) source.error = error
    sources.push(source)
  }
  return { sources }
}

/** `task.new` result (the phone's side). */
export function parseTaskNewResult(value: unknown): TaskNewResult {
  const o = obj(value, 'result')
  return { taskId: str(o, 'taskId'), tabId: str(o, 'tabId') }
}

/**
 * `stream.new` params (the desktop's side). Throws ProtocolError — `bad-request` — on a
 * missing `projectId`, a blank `name`, a `worktree` that isn't a boolean, or a blank
 * `branch` or `baseBranch` with `worktree: true`. `name` and `branch` come back
 * trimmed; without a worktree `branch` and `baseBranch` are dropped.
 */
export function parseStreamNewParams(params: unknown): StreamNewParams {
  const o = obj(params, 'params')
  const projectId = str(o, 'projectId')
  const name = str(o, 'name').trim()
  if (!name) fail('name is empty')
  const worktree = bool(o, 'worktree')
  const out: StreamNewParams = { projectId, name, worktree }
  if (!worktree) return out
  const branch = optStr(o, 'branch')?.trim()
  if (branch !== undefined) {
    if (!branch) fail('branch is empty')
    out.branch = branch
  }
  const baseBranch = optStr(o, 'baseBranch')
  if (baseBranch !== undefined) {
    if (!baseBranch.trim()) fail('baseBranch is empty')
    out.baseBranch = baseBranch
  }
  return out
}

/** `stream.new` result (the phone's side). */
export function parseStreamNewResult(value: unknown): StreamNewResult {
  return { streamId: str(obj(value, 'result'), 'streamId') }
}

/** `branches.list` params (the desktop's side). Throws ProtocolError on a missing `projectId`. */
export function parseBranchesListParams(params: unknown): BranchesListParams {
  return { projectId: str(obj(params, 'params'), 'projectId') }
}

/** `branches.list` result (the phone's side). A branch that isn't a string throws. */
export function parseBranchesListResult(value: unknown): BranchesListResult {
  const o = obj(value, 'result')
  const branches = arr(o, 'branches').map((branch) => {
    if (typeof branch !== 'string') fail('branches must be strings')
    return branch
  })
  return { branches, defaultBase: str(o, 'defaultBase') }
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
