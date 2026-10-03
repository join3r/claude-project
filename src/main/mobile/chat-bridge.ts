import type { ChatEvent, ChatPrompt, ChatPromptResponse, ChatSnapshot, ChatState } from '../../shared/claude-chat'
import {
  dismissQuestionResponse,
  planApprovalResponse,
  planFeedbackResponse,
  promptQuestions,
  questionAnswerResponse,
  canAlwaysAllow
} from '../../shared/chat-prompts'
import { chatTabConfig, type ChatTabConfigShape } from '../../shared/chat-tab-config'
import { isHomeTask, type Project, type ProjectsData, type Tab, type Task } from '../../shared/types'
import { isVisibleOnMobile } from './inbox'
import {
  chatDetail,
  diffItems,
  earlierItems,
  emptySent,
  viewSettings,
  headKey,
  mapPrompt,
  recordSent,
  toChatView,
  toolImage,
  viewStatus,
  type SentItems
} from './chat-view'
import { fitImage, ImageTooLargeError, type ImageCodec } from './chat-image'
import { AppErrorCode, CHAT_IMAGE_OP, CHAT_SETTINGS_OP, ChatLimits, ChatOp } from '../../../protocol/ts/index.ts'
import type {
  AppMessage,
  ChatAnswer,
  ChatAnswerParams,
  ChatDetailParams,
  ChatEarlierParams,
  ChatImageParams,
  ChatParams,
  ChatSendParams,
  ChatSettingsParams
} from '../../../protocol/ts/index.ts'

/**
 * The phone side of Claude chat tabs (protocol/SPEC.md §6.3, §6.4): answers `chat.*`
 * requests and streams `evt chat` diffs to the one chat each phone has open.
 *
 * It subscribes to `ClaudeChatManager` as a non-window listener, attaching a runtime
 * from the tab's stored config when the chat isn't live yet (as a window mounting the
 * tab would). Unsubscribing never stops the process: chat processes outlive windows.
 */

/** The part of `ClaudeChatManager` the bridge uses. */
export interface ChatBridgeChats {
  listen(
    tabId: string,
    config: ChatTabConfigShape,
    listener: (seq: number, event: ChatEvent, state: ChatState) => void
  ): Promise<{ snapshot: ChatSnapshot; stop: () => void }>
  snapshot(tabId: string): ChatSnapshot | null
  send(tabId: string, text: string): Promise<void>
  /** Optional so a bridge without it still serves every `chat.*` op; `task.new` uses it for `mode`. */
  setPermissionMode?(tabId: string, mode: string): Promise<void>
  /** `chat.settings`; undefined goes back to Claude's settings default. */
  setModel?(tabId: string, model: string | undefined): Promise<void>
  setEffort?(tabId: string, effort: string | undefined): Promise<void>
  interrupt(tabId: string): Promise<void>
  respond(tabId: string, promptId: string, response: ChatPromptResponse): boolean
}

export interface ChatBridgeTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ChatBridgeDeps {
  chats: ChatBridgeChats
  projects: { peek(): ProjectsData }
  timers: ChatBridgeTimers
  log(message: string): void
  /** A phone is about to send into a chat: the turn it starts is that phone's (push "done", §7.6). */
  onPhoneSend?(phoneId: string, tabId: string): void
  /** Decodes and resizes `chat.image` images (§8.9). Without it that op answers `unsupported`. */
  images?: ImageCodec
}

/**
 * One phone's live session. The bridge calls `send` for results and events; a new
 * handshake is a new `ChatPhone` (the service calls {@link ChatBridge.dropPhone} for
 * the old one), so nothing from an old session leaks into a new one.
 */
export interface ChatPhone {
  readonly id: string
  send(message: AppMessage): boolean
}

/** `evt chat` at most this often per subscription (4/s, §6.4), trailing edge included. */
export const CHAT_EVENT_INTERVAL_MS = 1000 / ChatLimits.eventsPerSecond

interface Subscription {
  tabId: string
  title: string
  /** Events arrived while `chat.open` was still loading; they go out after its result. */
  opening: boolean
  stop: () => void
  sent: SentItems
  headKey: string
  timer: unknown
  lastFlushAt: number
}

interface PhoneState {
  phone: ChatPhone
  sub: Subscription | null
  /** evt chat counters per tab for this session (§6.4: per session and tab). */
  seqs: Map<string, number>
}

interface ResolvedTab {
  project: Project
  task: Task
  tab: Tab
  config: ChatTabConfigShape
}

class OpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export class ChatBridge {
  private readonly phones = new Map<string, PhoneState>()

  constructor(private readonly deps: ChatBridgeDeps) {}

  /** Answer one `chat.*` request. The result (or error) goes out through `phone.send`. */
  request(phone: ChatPhone, id: number, op: string, params: ChatParams): void {
    const state = this.phoneState(phone)
    this.run(state, op, params)
      .then((result) => {
        if (this.phones.get(phone.id) !== state) return
        phone.send({ t: 'res', id, ok: true, result })
        // chat.open's first events wait for its result (§6.4).
        if (op === ChatOp.Open && state.sub?.opening && state.sub.tabId === params.tabId) {
          state.sub.opening = false
          this.schedule(state, state.sub)
        }
      })
      .catch((err: unknown) => {
        if (this.phones.get(phone.id) !== state) return
        const code = err instanceof OpError ? err.code : AppErrorCode.Internal
        const message = err instanceof Error ? err.message : String(err)
        if (!(err instanceof OpError)) this.deps.log(`mobile chatOp op=${op} error=${message}`)
        phone.send({ t: 'res', id, ok: false, error: { code, message } })
      })
  }

  /**
   * `task.new` (SPEC.md §8.4): start a chat tab that was just committed on its first
   * prompt, in `mode` when given, as a send from this phone (so its `done` push follows).
   */
  async startTask(phoneId: string, tabId: string, prompt: string, mode?: string): Promise<void> {
    const resolved = this.resolve(tabId)
    if (!resolved) throw new OpError(AppErrorCode.NotFound, 'No such tab')
    await this.ensureRuntime(resolved)
    if (mode) await this.deps.chats.setPermissionMode?.(tabId, mode)
    this.deps.onPhoneSend?.(phoneId, tabId)
    await this.deps.chats.send(tabId, prompt)
  }

  /** The phone's session ended: forget its subscription. */
  dropPhone(phoneId: string): void {
    const state = this.phones.get(phoneId)
    if (!state) return
    this.phones.delete(phoneId)
    this.endSubscription(state)
  }

  dropAll(): void {
    for (const phoneId of [...this.phones.keys()]) this.dropPhone(phoneId)
  }

  /** The chat this phone has open in its live session, if any. */
  openTab(phoneId: string): string | null {
    return this.phones.get(phoneId)?.sub?.tabId ?? null
  }

  /** Projects changed: a tab that was closed or hidden stops streaming. */
  projectsChanged(): void {
    for (const state of this.phones.values()) {
      if (state.sub && !this.resolve(state.sub.tabId)) this.endSubscription(state)
    }
  }

  private phoneState(phone: ChatPhone): PhoneState {
    const existing = this.phones.get(phone.id)
    if (existing && existing.phone === phone) return existing
    if (existing) this.dropPhone(phone.id)
    const state: PhoneState = { phone, sub: null, seqs: new Map() }
    this.phones.set(phone.id, state)
    return state
  }

  // ---- ops -------------------------------------------------------------------------

  private async run(state: PhoneState, op: string, params: ChatParams): Promise<unknown> {
    const resolved = this.resolve(params.tabId)
    if (!resolved) throw new OpError(AppErrorCode.NotFound, 'No such chat tab')
    switch (op) {
      case ChatOp.Open:
        return this.open(state, resolved)
      case ChatOp.Close:
        if (state.sub?.tabId === params.tabId) this.endSubscription(state)
        return {}
      case ChatOp.Earlier: {
        const { before, limit } = params as ChatEarlierParams
        const chat = await this.ensureRuntime(resolved)
        const result = earlierItems(chat, before, limit ?? ChatLimits.earlier)
        if (!result) throw new OpError(AppErrorCode.NotFound, 'No such item')
        const sub = state.sub
        if (sub && sub.tabId === params.tabId) sub.sent = recordSent(sub.sent, result.items, 'prepend')
        return result
      }
      case ChatOp.Send:
        await this.ensureRuntime(resolved)
        this.deps.onPhoneSend?.(state.phone.id, params.tabId)
        await this.deps.chats.send(params.tabId, (params as ChatSendParams).text)
        return {}
      case ChatOp.Answer: {
        const { promptId, answer } = params as ChatAnswerParams
        const chat = await this.ensureRuntime(resolved)
        const prompt = chat.pending.find((p) => p.id === promptId)
        if (!prompt) throw new OpError(AppErrorCode.Gone, 'That prompt was already answered')
        const response = promptResponse(prompt, answer)
        if (!this.deps.chats.respond(params.tabId, promptId, response)) {
          throw new OpError(AppErrorCode.Gone, 'That prompt was already answered')
        }
        return {}
      }
      case ChatOp.Interrupt:
        await this.ensureRuntime(resolved)
        await this.deps.chats.interrupt(params.tabId)
        return {}
      case ChatOp.Detail: {
        const chat = await this.ensureRuntime(resolved)
        const detail = chatDetail(chat, (params as ChatDetailParams).itemId)
        if (!detail) throw new OpError(AppErrorCode.NotFound, 'No such item')
        return detail
      }
      case CHAT_SETTINGS_OP:
        return this.applySettings(resolved, params as ChatSettingsParams)
      case CHAT_IMAGE_OP: {
        const codec = this.deps.images
        if (!codec) throw new OpError(AppErrorCode.Unsupported, 'This desktop cannot send images')
        const { itemId, index, maxSide } = params as ChatImageParams
        const image = toolImage(await this.ensureRuntime(resolved), itemId, index)
        if (!image) throw new OpError(AppErrorCode.NotFound, 'No such image')
        try {
          return fitImage(image, maxSide ?? ChatLimits.imageDefaultSide, codec)
        } catch (err) {
          if (err instanceof ImageTooLargeError) throw new OpError(AppErrorCode.Internal, err.message)
          throw err
        }
      }
      default:
        throw new OpError(AppErrorCode.Unsupported, `Unknown op ${op}`)
    }
  }

  /** `chat.settings` (SPEC.md §8.5): what the composer's pickers do, in their order. */
  private async applySettings(resolved: ResolvedTab, { tabId, mode, model, effort }: ChatSettingsParams): Promise<unknown> {
    const { chats } = this.deps
    if (!chats.setPermissionMode || !chats.setModel || !chats.setEffort) {
      throw new OpError(AppErrorCode.Unsupported, 'This desktop cannot change chat settings')
    }
    const chat = await this.ensureRuntime(resolved)
    // Only what the phone was offered; "" is the Default row.
    const offered = viewSettings(chat.info, chat.models)
    if (model && offered.models.length > 0 && !offered.models.some((m) => m.value === model)) {
      throw new OpError(AppErrorCode.BadRequest, `Unknown model ${model}`)
    }
    if (mode !== undefined) await chats.setPermissionMode(tabId, mode)
    if (model !== undefined) await chats.setModel(tabId, model || undefined)
    if (effort !== undefined) {
      // Checked against the model now running, after a model change above.
      const efforts = viewSettings(chats.snapshot(tabId)?.state.info ?? chat.info, chat.models).efforts
      if (effort && !efforts.includes(effort)) throw new OpError(AppErrorCode.BadRequest, `Unknown effort ${effort}`)
      await chats.setEffort(tabId, effort || undefined)
    }
    return {}
  }

  private async open(state: PhoneState, resolved: ResolvedTab): Promise<unknown> {
    const tabId = resolved.tab.id
    // One open chat per phone: a new open silently ends the previous subscription.
    this.endSubscription(state)
    const sub: Subscription = {
      tabId,
      title: resolved.tab.title,
      opening: true,
      stop: () => {},
      sent: emptySent(),
      headKey: '',
      timer: null,
      lastFlushAt: Number.NEGATIVE_INFINITY
    }
    state.sub = sub
    let listening: { snapshot: ChatSnapshot; stop: () => void }
    try {
      listening = await this.deps.chats.listen(tabId, resolved.config, () => {
        if (state.sub === sub && !sub.opening) this.schedule(state, sub)
      })
    } catch (err) {
      if (state.sub === sub) state.sub = null
      throw err
    }
    if (state.sub !== sub || this.phones.get(state.phone.id) !== state) {
      // Superseded (closed, another open, the session ended) while history loaded.
      listening.stop()
      throw new OpError(AppErrorCode.NotFound, 'The chat was closed')
    }
    sub.stop = listening.stop
    const chat = this.deps.chats.snapshot(tabId)?.state ?? listening.snapshot.state
    const view = toChatView(chat, { tabId, title: sub.title })
    sub.sent = recordSent(emptySent(), view.items, 'replace')
    sub.headKey = headKey(view.prompts, viewStatus(chat))
    sub.lastFlushAt = this.deps.timers.now()
    const seq = state.seqs.get(tabId) ?? 0
    return { seq, view }
  }

  /** The chat's folded state, attaching a runtime first when the tab has none (§6.3). */
  private async ensureRuntime(resolved: ResolvedTab): Promise<ChatState> {
    const tabId = resolved.tab.id
    const live = this.deps.chats.snapshot(tabId)
    if (live) return live.state
    const { snapshot, stop } = await this.deps.chats.listen(tabId, resolved.config, () => {})
    stop()
    return this.deps.chats.snapshot(tabId)?.state ?? snapshot.state
  }

  /** A chat tab a phone may see, with the config a window would attach it with. */
  private resolve(tabId: string): ResolvedTab | null {
    for (const project of this.deps.projects.peek().projects) {
      if (!isVisibleOnMobile(project)) continue
      for (const task of project.tasks ?? []) {
        if (isHomeTask(task)) continue
        const tab = [...(task.tabs?.left ?? []), ...(task.tabs?.right ?? [])].find((t) => t.id === tabId)
        if (!tab) continue
        // A chat tab without a session id has never been mounted; a window gives it one.
        if (tab.type !== 'claude-chat' || !tab.sessionId) return null
        return { project, task, tab, config: chatTabConfig(project, task, tab.sessionId) }
      }
    }
    return null
  }

  // ---- events ----------------------------------------------------------------------

  /**
   * Prompt and status changes go out at once; item-only changes are throttled to
   * {@link CHAT_EVENT_INTERVAL_MS}, trailing, so a streaming reply is ≤ 4 events/s.
   */
  private schedule(state: PhoneState, sub: Subscription): void {
    const chat = this.deps.chats.snapshot(sub.tabId)?.state
    if (!chat) return
    const head = headKey(chat.pending.map(mapPrompt), viewStatus(chat))
    if (head !== sub.headKey) {
      this.flush(state, sub)
      return
    }
    if (sub.timer !== null) return
    const wait = Math.max(0, sub.lastFlushAt + CHAT_EVENT_INTERVAL_MS - this.deps.timers.now())
    sub.timer = this.deps.timers.setTimeout(() => {
      sub.timer = null
      if (state.sub === sub) this.flush(state, sub)
    }, wait)
  }

  private flush(state: PhoneState, sub: Subscription): void {
    if (sub.timer !== null) {
      this.deps.timers.clearTimeout(sub.timer)
      sub.timer = null
    }
    const chat = this.deps.chats.snapshot(sub.tabId)?.state
    if (!chat) return
    const prompts = chat.pending.map(mapPrompt)
    const status = viewStatus(chat)
    const head = headKey(prompts, status)
    const diff = diffItems(sub.sent, chat.items)
    if (diff.upserts.length === 0 && diff.removes.length === 0 && head === sub.headKey) return
    const seq = (state.seqs.get(sub.tabId) ?? 0) + 1
    sub.lastFlushAt = this.deps.timers.now()
    const sent = state.phone.send({
      t: 'evt',
      e: 'chat',
      tabId: sub.tabId,
      seq,
      upserts: diff.upserts,
      removes: diff.removes,
      prompts,
      ...status
    })
    // Not sent (no session, or too large): the next flush diffs against the same base.
    if (!sent) return
    state.seqs.set(sub.tabId, seq)
    sub.sent = diff.next
    sub.headKey = head
  }

  private endSubscription(state: PhoneState): void {
    const sub = state.sub
    if (!sub) return
    state.sub = null
    if (sub.timer !== null) this.deps.timers.clearTimeout(sub.timer)
    sub.stop()
  }
}

/** A phone's answer → exactly what the desktop's prompt card would send (§6.3). */
export function promptResponse(prompt: ChatPrompt, answer: ChatAnswer): ChatPromptResponse {
  if (prompt.kind === 'question') {
    if (answer.behavior === 'deny') return dismissQuestionResponse()
    if (answer.behavior !== 'answers') throw new OpError(AppErrorCode.BadRequest, 'A question takes answers or deny')
    const answers: Record<string, string> = {}
    for (const q of promptQuestions(prompt.input)) {
      const value = answer.answers[q.question]
      if (typeof value !== 'string' || !value.trim()) throw new OpError(AppErrorCode.BadRequest, `No answer for "${q.question}"`)
      answers[q.question] = value
    }
    return questionAnswerResponse(prompt, answers)
  }
  if (prompt.kind === 'plan') {
    if (answer.behavior === 'approvePlan') return planApprovalResponse(prompt, false)
    if (answer.behavior === 'deny') return planFeedbackResponse(answer.message)
    throw new OpError(AppErrorCode.BadRequest, 'A plan takes approvePlan or deny')
  }
  if (answer.behavior === 'allow') {
    if (answer.always && !canAlwaysAllow(prompt)) throw new OpError(AppErrorCode.BadRequest, 'This prompt has no "Always allow"')
    return answer.always ? { behavior: 'allow', always: true } : { behavior: 'allow' }
  }
  if (answer.behavior === 'deny') return answer.message !== undefined ? { behavior: 'deny', message: answer.message } : { behavior: 'deny' }
  throw new OpError(AppErrorCode.BadRequest, 'A permission prompt takes allow or deny')
}
