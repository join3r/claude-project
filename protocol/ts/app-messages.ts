import { b64uDecode, utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { BRANCHES_LIST_OP, CHAT_BTW_OP, CHAT_COMMANDS_OP, CHAT_IMAGE_OP, CHAT_PERMISSIONS_OP, CHAT_PERMISSIONS_UPDATE_OP, CHAT_SETTINGS_OP, ChatOp, PIN_SET_OP, STREAM_NEW_OP, TAB_CLOSE_OP, TASK_CLOSE_OP, TASK_LAND_OP, TASK_NEW_OP, TASK_TRIAGE_OP, parseChatViewEvent, parseTaskLanding } from './chat-messages.ts'
import type { ChatViewEvent, TaskLanding } from './chat-messages.ts'
import { PushOp } from './push.ts'

/**
 * The phone ↔ desktop channel above Noise (SPEC.md §4.3, §4.4). All of it is UTF-8
 * JSON. Parsers are tolerant in the ways the spec asks for: unknown fields are dropped,
 * unknown message types come back as `null` (ignore them), and a newer desktop's extra
 * tab types or statuses don't break an older phone.
 */

/**
 * The version this build speaks (N) and the oldest it still accepts. Version 2 (streams,
 * SPEC.md §9) is a hard cutover: neither side accepts 1, so an older peer gets
 * `incompatible` and is told which side to update. Version 3 (task worktrees, §11)
 * only adds, so 2 is still accepted: a desktop answers a version 2 phone the old way.
 */
export const PROTOCOL_VERSION = 3
export const MIN_PROTOCOL_VERSION = 2

export type PairKind = 'pair' | 'resume'
export type HandshakeResult = 'ok' | 'pending' | 'rejected' | 'incompatible' | 'unknown-device'

export interface VersionInfo {
  v: number
  min: number
}

/** Noise message 1 payload (phone → desktop). */
export interface PhoneHello extends VersionInfo {
  app: string
  features: string[]
  kind: PairKind
  /** b64u pairProof; present exactly when `kind` is `pair`. */
  proof?: string
  deviceName: string
  /** b64u phone Ed25519 public key. */
  ed: string
}

/** Noise message 2 payload (desktop → phone). */
export interface DesktopHello extends VersionInfo {
  app: string
  features: string[]
  desktopName: string
  result: HandshakeResult
}

export type InboxTabStatus = 'working' | 'attention' | 'exited' | 'idle'

/** The tab types a desktop sends; kept open (`string`) on the type so newer ones parse. */
export const INBOX_TAB_TYPES = ['claude-chat', 'claude', 'codex', 'pi', 'terminal'] as const

export interface InboxTab {
  id: string
  type: string
  title: string
  status: InboxTabStatus
  since?: number
  activity?: string
  /** What an agent tab's conversation is about: its session title, else the last prompt. */
  topic?: string
}

export interface InboxTask {
  id: string
  name: string
  /** The stream holding the task, and its name, for the `Project · Stream` line (§4.4). */
  streamId: string
  streamName: string
  /** The task's one status: the strongest of its main tab and agent tabs (§4.4). */
  status: InboxTabStatus
  /** When `status` began. */
  since?: number
  /** Short label of what the agent is doing, from the tab that sets `status`. */
  activity?: string
  lastInteractedAt?: number
  attentionAt?: number
  /** The task's last event (a hook notification or stop, a bell, an exit), for "last activity" (§4.4). */
  eventAt?: number
  /** Present while the desktop counts the task unread (§4.4). */
  unread?: true
  /** Present while the task is settled (§4.4). */
  settledAt?: number
  /** Present while a timed snooze hasn't passed at `generatedAt` (§4.4). */
  snoozedUntil?: number
  /** Present while the task is snoozed until it needs the user (§4.4). */
  snoozeUntilAttention?: true
  /** The task's own worktree branch, once it has one (version 3, §4.4). */
  branch?: string
  /** Present while the task is landing into its stream or stopped doing so (version 3, §4.4). */
  landing?: TaskLanding
  tabs: InboxTab[]
}

/** A line of work in a project (§4.4); archived streams are never sent. */
export interface InboxStream {
  id: string
  name: string
  /** The project's default stream (project folder, can't be closed). */
  main?: true
  /** Present on a worktree stream: the branch its worktree is on. */
  branch?: string
}

export interface InboxProject {
  id: string
  name: string
  emoji?: string
  remote: boolean
  /** The project's open streams in sidebar order, `main` first, empty ones included. */
  streams: InboxStream[]
  /** The stream the project was last used in (the phone's default for New task). */
  lastStreamId?: string
  /** Every open task, stream by stream. */
  tasks: InboxTask[]
}

/**
 * One entry of the desktop's Pinned list (§4.4): a project, a stream when
 * `streamId` is set, or a task when `taskId` is set (with its `streamId`).
 */
export interface InboxPin {
  projectId: string
  streamId?: string
  taskId?: string
}

export interface Inbox {
  desktop: { id: string; name: string }
  generatedAt: number
  projects: InboxProject[]
  /** The desktop sidebar's Pinned list, in its order; absent when nothing is pinned (§4.4). */
  pinned?: InboxPin[]
}

export interface ReqMessage {
  t: 'req'
  id: number
  /** Kept as a string: an unknown op must still be answered with `unsupported`. */
  op: string
  /** Op-specific raw JSON (§6.3); absent when the req carries none. Validate with e.g. `parseChatParams`. */
  params?: unknown
}

export interface ResOkMessage {
  t: 'res'
  id: number
  ok: true
  /** Op-specific; for `inbox.get` run it through `parseInbox`. */
  result: unknown
}

export interface ResErrMessage {
  t: 'res'
  id: number
  ok: false
  error: { code: string; message: string }
}

export interface InboxEvent {
  t: 'evt'
  e: 'inbox'
  seq: number
  inbox: Inbox
}

export type PairingStatus = 'accepted' | 'rejected' | 'revoked'

export interface PairingEvent {
  t: 'evt'
  e: 'pairing'
  status: PairingStatus
}

export type ResMessage = ResOkMessage | ResErrMessage
export type EvtMessage = InboxEvent | PairingEvent | ChatViewEvent
export type AppMessage = ReqMessage | ResMessage | EvtMessage

export const AppOp = {
  InboxGet: 'inbox.get',
  ChatOpen: ChatOp.Open,
  ChatClose: ChatOp.Close,
  ChatEarlier: ChatOp.Earlier,
  ChatSend: ChatOp.Send,
  ChatAnswer: ChatOp.Answer,
  ChatInterrupt: ChatOp.Interrupt,
  ChatDetail: ChatOp.Detail,
  TaskNew: TASK_NEW_OP,
  TaskClose: TASK_CLOSE_OP,
  TabClose: TAB_CLOSE_OP,
  PinSet: PIN_SET_OP,
  TaskTriage: TASK_TRIAGE_OP,
  TaskLand: TASK_LAND_OP,
  StreamNew: STREAM_NEW_OP,
  BranchesList: BRANCHES_LIST_OP,
  ChatSettings: CHAT_SETTINGS_OP,
  ChatImage: CHAT_IMAGE_OP,
  ChatCommands: CHAT_COMMANDS_OP,
  ChatBtw: CHAT_BTW_OP,
  ChatPermissions: CHAT_PERMISSIONS_OP,
  ChatPermissionsUpdate: CHAT_PERMISSIONS_UPDATE_OP,
  PushRegister: PushOp.Register,
  PushUnregister: PushOp.Unregister
} as const

/** `res.error.code` values (M1 + §6.3). Unknown codes from a newer peer are still strings. */
export const AppErrorCode = {
  Unsupported: 'unsupported',
  BadRequest: 'bad-request',
  NotAuthorized: 'not-authorized',
  Internal: 'internal',
  /** Unknown tab or item, a hidden project's tab, or a tab that isn't claude-chat. */
  NotFound: 'not-found',
  /** The prompt was already answered (or never existed). */
  Gone: 'gone'
} as const

const PAIR_KINDS: readonly string[] = ['pair', 'resume']
const RESULTS: readonly string[] = ['ok', 'pending', 'rejected', 'incompatible', 'unknown-device']
const STATUSES: readonly string[] = ['working', 'attention', 'exited', 'idle']
const PAIRING_STATUSES: readonly string[] = ['accepted', 'rejected', 'revoked']

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function obj(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`)
  return value as Obj
}

function arr(o: Obj, key: string): unknown[] {
  const value = o[key]
  if (!Array.isArray(value)) fail(`${key} must be an array`)
  return value
}

function str(o: Obj, key: string): string {
  const value = o[key]
  if (typeof value !== 'string') fail(`${key} must be a string`)
  return value
}

function int(o: Obj, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative integer`)
  return value
}

/** Optional fields: absent and `null` both mean "not set". */
function optInt(o: Obj, key: string): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : int(o, key)
}

function optStr(o: Obj, key: string): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key)
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly string[]): T {
  const value = str(o, key)
  if (!allowed.includes(value)) fail(`${key} has an unknown value`)
  return value as T
}

function b64u32(o: Obj, key: string): string {
  const value = str(o, key)
  let length: number
  try {
    length = b64uDecode(value).length
  } catch {
    fail(`${key} must be base64url`)
  }
  if (length !== 32) fail(`${key} must be 32 bytes`)
  return value
}

/** Accepts the raw JSON text or its UTF-8 bytes (what comes out of Noise). */
function parseJson(input: string | Uint8Array): Obj {
  const text = typeof input === 'string' ? input : utf8Decode(input)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ProtocolError('payload is not JSON', { cause: err })
  }
  return obj(value, 'payload')
}

function features(o: Obj): string[] {
  if (o.features === undefined) return []
  return arr(o, 'features').filter((f): f is string => typeof f === 'string')
}

function versionOf(o: Obj): VersionInfo {
  const v = int(o, 'v')
  const min = int(o, 'min')
  if (v < 1 || min < 1 || min > v) fail('invalid protocol version range')
  return { v, min }
}

/**
 * Just `{ v, min }` from a handshake payload. The desktop negotiates on this before
 * `parsePhoneHello`, so a phone speaking a future shape still gets a clean `incompatible`.
 */
export function parseHelloVersion(input: string | Uint8Array): VersionInfo {
  return versionOf(parseJson(input))
}

export function parsePhoneHello(input: string | Uint8Array): PhoneHello {
  const o = parseJson(input)
  const hello: PhoneHello = {
    ...versionOf(o),
    app: str(o, 'app'),
    features: features(o),
    kind: oneOf<PairKind>(o, 'kind', PAIR_KINDS),
    deviceName: str(o, 'deviceName'),
    ed: b64u32(o, 'ed')
  }
  if (hello.kind === 'pair') hello.proof = b64u32(o, 'proof')
  return hello
}

/** An unknown `result` throws: the phone can only treat it as a failed handshake anyway. */
export function parseDesktopHello(input: string | Uint8Array): DesktopHello {
  const o = parseJson(input)
  return {
    ...versionOf(o),
    app: str(o, 'app'),
    features: features(o),
    desktopName: str(o, 'desktopName'),
    result: oneOf<HandshakeResult>(o, 'result', RESULTS)
  }
}

function parseTab(value: unknown): InboxTab {
  const o = obj(value, 'tab')
  const tab: InboxTab = {
    id: str(o, 'id'),
    type: str(o, 'type'),
    title: str(o, 'title'),
    status: parseStatus(o)
  }
  const since = optInt(o, 'since')
  if (since !== undefined) tab.since = since
  const activity = optStr(o, 'activity')
  if (activity !== undefined) tab.activity = activity
  const topic = optStr(o, 'topic')
  if (topic !== undefined) tab.topic = topic
  return tab
}

function parseStatus(o: Obj): InboxTabStatus {
  const status = str(o, 'status')
  // A status this build doesn't know is shown as idle rather than dropping the row.
  return STATUSES.includes(status) ? (status as InboxTabStatus) : 'idle'
}

function parseTask(value: unknown): InboxTask {
  const o = obj(value, 'task')
  const task: InboxTask = {
    id: str(o, 'id'),
    name: str(o, 'name'),
    streamId: str(o, 'streamId'),
    streamName: str(o, 'streamName'),
    status: parseStatus(o),
    tabs: arr(o, 'tabs').map(parseTab)
  }
  const since = optInt(o, 'since')
  if (since !== undefined) task.since = since
  const activity = optStr(o, 'activity')
  if (activity !== undefined) task.activity = activity
  const lastInteractedAt = optInt(o, 'lastInteractedAt')
  if (lastInteractedAt !== undefined) task.lastInteractedAt = lastInteractedAt
  const attentionAt = optInt(o, 'attentionAt')
  if (attentionAt !== undefined) task.attentionAt = attentionAt
  const eventAt = optInt(o, 'eventAt')
  if (eventAt !== undefined) task.eventAt = eventAt
  if (o.unread === true) task.unread = true
  const settledAt = optInt(o, 'settledAt')
  if (settledAt !== undefined) task.settledAt = settledAt
  const snoozedUntil = optInt(o, 'snoozedUntil')
  if (snoozedUntil !== undefined) task.snoozedUntil = snoozedUntil
  if (o.snoozeUntilAttention === true) task.snoozeUntilAttention = true
  const branch = optStr(o, 'branch')
  if (branch !== undefined) task.branch = branch
  if (o.landing !== undefined && o.landing !== null) task.landing = parseTaskLanding(o.landing)
  return task
}

function parseStream(value: unknown): InboxStream {
  const o = obj(value, 'stream')
  const stream: InboxStream = { id: str(o, 'id'), name: str(o, 'name') }
  if (o.main === true) stream.main = true
  const branch = optStr(o, 'branch')
  if (branch !== undefined) stream.branch = branch
  return stream
}

function parseProject(value: unknown): InboxProject {
  const o = obj(value, 'project')
  const project: InboxProject = {
    id: str(o, 'id'),
    name: str(o, 'name'),
    remote: o.remote === true,
    streams: arr(o, 'streams').map(parseStream),
    tasks: arr(o, 'tasks').map(parseTask)
  }
  const emoji = optStr(o, 'emoji')
  if (emoji !== undefined) project.emoji = emoji
  const lastStreamId = optStr(o, 'lastStreamId')
  if (lastStreamId !== undefined) project.lastStreamId = lastStreamId
  return project
}

function parsePin(value: unknown): InboxPin {
  const o = obj(value, 'pin')
  const pin: InboxPin = { projectId: str(o, 'projectId') }
  const streamId = optStr(o, 'streamId')
  if (streamId !== undefined) pin.streamId = streamId
  const taskId = optStr(o, 'taskId')
  if (taskId !== undefined) pin.taskId = taskId
  return pin
}

/** Validates an `Inbox` value (already-parsed JSON, e.g. `res.result` or `evt.inbox`). */
export function parseInbox(value: unknown): Inbox {
  const o = obj(value, 'inbox')
  const desktop = obj(o.desktop, 'desktop')
  const inbox: Inbox = {
    desktop: { id: str(desktop, 'id'), name: str(desktop, 'name') },
    generatedAt: int(o, 'generatedAt'),
    projects: arr(o, 'projects').map(parseProject)
  }
  if (o.pinned !== undefined && o.pinned !== null) {
    const pinned = arr(o, 'pinned').map(parsePin)
    if (pinned.length > 0) inbox.pinned = pinned
  }
  return inbox
}

/**
 * Parses one decrypted transport message. Returns `null` for a message this build
 * doesn't know (unknown `t`, or `evt` with an unknown `e`), which the caller ignores.
 * A `req` with an unknown `op` parses normally; answer it with `unsupported`.
 * Throws ProtocolError when a known message is malformed.
 */
export function parseAppMessage(input: string | Uint8Array): AppMessage | null {
  const o = parseJson(input)
  switch (o.t) {
    case 'req': {
      const req: ReqMessage = { t: 'req', id: int(o, 'id'), op: str(o, 'op') }
      if (o.params !== undefined && o.params !== null) req.params = o.params
      return req
    }
    case 'res': {
      const id = int(o, 'id')
      if (o.ok === true) return { t: 'res', id, ok: true, result: o.result ?? null }
      if (o.ok === false) {
        const error = obj(o.error, 'error')
        return { t: 'res', id, ok: false, error: { code: str(error, 'code'), message: optStr(error, 'message') ?? '' } }
      }
      return fail('ok must be a boolean')
    }
    case 'evt':
      switch (o.e) {
        case 'inbox':
          return { t: 'evt', e: 'inbox', seq: int(o, 'seq'), inbox: parseInbox(o.inbox) }
        case 'pairing':
          return { t: 'evt', e: 'pairing', status: oneOf<PairingStatus>(o, 'status', PAIRING_STATUSES) }
        case 'chat':
          return parseChatViewEvent(o)
        default:
          return null
      }
    default:
      return null
  }
}

/** Handshake payloads and app messages all go out as compact UTF-8 JSON. */
export function encodeJson(value: PhoneHello | DesktopHello | AppMessage): Uint8Array {
  return utf8Encode(JSON.stringify(value))
}

export type VersionNegotiation =
  | { ok: true; version: number }
  /** `update` names the side that is too old ("Update DevTool" vs "Update the app"). */
  | { ok: false; update: 'local' | 'remote' }

/** §4.3: chosen = min(v); incompatible when chosen < max(min). */
export function negotiateVersion(local: VersionInfo, remote: VersionInfo): VersionNegotiation {
  const version = Math.min(local.v, remote.v)
  if (version >= Math.max(local.min, remote.min)) return { ok: true, version }
  return { ok: false, update: local.v < remote.min ? 'local' : 'remote' }
}
