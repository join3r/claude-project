import { randomUUID } from 'crypto'
import {
  CHAT_AGENT_FEATURES,
  type ChatImage,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatSideAnswer,
  type ChatToolItem
} from '../../shared/claude-chat'
import { spawnJsonl, withContext, type AgentChatSession, type AgentSessionOptions, type JsonlChild } from './session'
import { piAssistantRows, piCommands, piHistoryRows, piMessageError, piModels, piModelValue, piResultText, piToolRow, piUsage } from './pi-translate'

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Flags the chat owns; the project's Pi args may not override them. */
const RESERVED_FLAGS = new Set(['--mode', '--session-id', '--session', '--no-session', '--print', '-p', '--continue', '-c', '--resume', '-r'])
const RESERVED_WITH_VALUE = new Set(['--mode', '--session-id', '--session'])

/** The project's Pi args without the ones that would break RPC mode or pick another session. */
export function piExtraArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flag = arg.split('=')[0]
    if (RESERVED_FLAGS.has(flag)) {
      if (RESERVED_WITH_VALUE.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

interface HeldDialog {
  prompt: ChatPrompt
  method: 'confirm' | 'select'
}

interface Pending {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

/**
 * Pi as a chat: one `pi --mode rpc` per tab, on the tab's own session id (the
 * one the terminal tab passes as `--session-id`). Pi asks no permissions, so the
 * only cards are an extension's own confirm/select dialogs.
 */
export class PiChatSession implements AgentChatSession {
  private child: JsonlChild | null = null
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private readonly held = new Map<string, HeldDialog>()
  private readonly rows = new Map<string, ChatToolItem>()
  /** The assistant message streaming now: its rows are keyed by it. */
  private messageKey: string | null = null
  private messageCount = 0
  /** The agent is running (from our prompt until `agent_settled`): new messages steer. */
  private streaming = false
  /** The last assistant message was aborted: the turn ends as an interrupt. */
  private aborted = false
  private ended = false
  private closedByUs = false

  constructor(private readonly options: AgentSessionOptions) {}

  async start(): Promise<void> {
    const o = this.options
    o.onEvent({ t: 'process', state: 'starting' })
    o.onEvent({ t: 'meta', info: { agent: 'pi', modelPicked: Boolean(o.model), ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) } })
    this.child = spawnJsonl(o, ['--mode', 'rpc', '--session-id', o.sessionId, ...piExtraArgs(o.extraArgs ?? [])], {
      onRecord: (record) => this.onRecord(record),
      onExit: (error) => this.finish(error)
    })
    try {
      const messages = obj(await this.request({ type: 'get_messages' }))?.messages
      const rows = piHistoryRows(messages)
      if (rows.length > 0) o.onEvent({ t: 'restore', items: rows })
      if (o.model) await this.applyModel(o.model)
      if (o.effort) await this.request({ type: 'set_thinking_level', level: o.effort })
    } catch (err) {
      o.log(`piChat start error=${err instanceof Error ? err.message : String(err)}`)
      this.ended = true
      this.child.kill()
      throw err
    }
    o.onEvent({ t: 'process', state: 'running' })
    o.onEvent({ t: 'meta', info: { agent: 'pi', sessionId: o.sessionId, cwd: o.cwd } })
    void this.loadMeta()
  }

  private async loadMeta(): Promise<void> {
    await Promise.all([
      this.refreshApplied(),
      this.request({ type: 'get_available_models' }).then((data) => {
        this.options.onEvent({ t: 'meta', models: piModels(obj(data)?.models) })
      }).catch(() => { /* free-text picker */ }),
      this.request({ type: 'get_commands' }).then((data) => {
        this.options.onEvent({ t: 'meta', commands: piCommands(obj(data)?.commands) })
      }).catch(() => { /* no / menu */ }),
      this.refreshUsage()
    ])
  }

  /** The model and thinking level Pi uses now, for the composer's "Default (…)". */
  private async refreshApplied(): Promise<void> {
    try {
      const state = obj(await this.request({ type: 'get_state' }))
      this.options.onEvent({ t: 'meta', info: { applied: { model: piModelValue(state?.model), effort: str(state?.thinkingLevel) ?? null } } })
    } catch {
      // The labels say just "Default".
    }
  }

  private async refreshUsage(): Promise<void> {
    try {
      this.options.onEvent({ t: 'meta', usage: piUsage(await this.request({ type: 'get_session_stats' })) })
    } catch {
      // The meter stays as it was.
    }
  }

  private request(command: Json): Promise<unknown> {
    const child = this.child
    if (!child || this.ended) return Promise.reject(new Error('Pi is not running.'))
    const id = `r${this.nextId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.write({ ...command, id })
    })
  }

  private hook(body: Record<string, unknown>): void {
    try { this.options.onHook(body) } catch { /* status is best-effort */ }
  }

  private emitTool(row: ChatToolItem): void {
    this.rows.set(row.id, row)
    this.options.onEvent({ t: 'item', item: row, at: Date.now() })
  }

  private onRecord(record: unknown): void {
    const m = obj(record)
    if (!m) return
    try {
      this.onMessage(m)
    } catch (err) {
      this.options.log(`piChat handler type=${str(m.type)} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private onMessage(m: Json): void {
    const o = this.options
    switch (m.type) {
      case 'response': {
        const id = str(m.id)
        const waiter = id ? this.pending.get(id) : undefined
        if (!id || !waiter) return
        this.pending.delete(id)
        if (m.success === false) waiter.reject(new Error(str(m.error) ?? `Pi refused ${str(m.command) ?? 'the command'}`))
        else waiter.resolve(m.data)
        return
      }
      case 'agent_start':
        this.streaming = true
        this.aborted = false
        o.onEvent({ t: 'turn', state: 'start', at: Date.now() })
        return
      case 'agent_settled':
        this.streaming = false
        o.onEvent({ t: 'turn', state: 'end', interrupted: this.aborted, at: Date.now() })
        this.aborted = false
        this.hook({ hook_event_name: 'Stop', session_id: o.sessionId })
        void this.refreshUsage()
        return
      case 'message_start': {
        const message = obj(m.message)
        if (message?.role === 'user') o.onEvent({ t: 'delivered' })
        else if (message?.role === 'assistant') this.messageKey = `pi-${typeof message.timestamp === 'number' ? message.timestamp : ''}-${this.messageCount++}`
        return
      }
      case 'message_update': {
        const event = obj(m.assistantMessageEvent)
        const key = this.messageKey
        if (!event || !key) return
        const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0
        if (event.type === 'text_delta' && str(event.delta)) {
          o.onEvent({ t: 'delta', id: `${key}:${index}`, kind: 'text', text: str(event.delta) ?? '', at: Date.now() })
        } else if (event.type === 'thinking_delta' && str(event.delta)) {
          o.onEvent({ t: 'delta', id: `${key}:${index}`, kind: 'thinking', text: str(event.delta) ?? '', at: Date.now() })
        } else if (event.type === 'toolcall_end') {
          const call = obj(event.toolCall)
          const id = str(call?.id)
          if (call && id && !this.rows.has(id)) this.emitTool(piToolRow(id, str(call.name) ?? 'tool', call.arguments, 'pending'))
        }
        return
      }
      case 'message_end': {
        const message = obj(m.message)
        const key = this.messageKey
        if (message?.role !== 'assistant' || !key) return
        this.messageKey = null
        if (message.stopReason === 'aborted') this.aborted = true
        for (const row of piAssistantRows(message, key)) {
          if (row.kind === 'tool') {
            if (!this.rows.has(row.id)) this.emitTool(row)
          } else {
            o.onEvent({ t: 'item', item: row, at: Date.now() })
          }
        }
        if (piMessageError(message)) this.hook({ hook_event_name: 'StopFailure', error: piMessageError(message) })
        return
      }
      case 'tool_execution_start': {
        const id = str(m.toolCallId)
        if (!id) return
        const row = piToolRow(id, str(m.toolName) ?? 'tool', m.args, 'running')
        this.emitTool(row)
        this.hook({ hook_event_name: 'PreToolUse', tool_name: row.name, tool_input: row.input, tool_use_id: id })
        return
      }
      case 'tool_execution_update': {
        const id = str(m.toolCallId)
        const row = id ? this.rows.get(id) : undefined
        if (!row) return
        this.emitTool({ ...row, status: 'running', result: piResultText(m.partialResult).slice(-20_000) })
        return
      }
      case 'tool_execution_end': {
        const id = str(m.toolCallId)
        if (!id) return
        const row = this.rows.get(id) ?? piToolRow(id, str(m.toolName) ?? 'tool', m.args, 'running')
        const result = piResultText(m.result)
        const failed = m.isError === true
        this.emitTool({ ...row, status: failed ? 'error' : 'done', ...(result ? { result: result.slice(0, 20_000) } : {}) })
        this.hook({ hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: row.name, tool_input: row.input, tool_use_id: id })
        return
      }
      case 'auto_retry_start': {
        const attempt = typeof m.attempt === 'number' ? m.attempt : undefined
        const max = typeof m.maxAttempts === 'number' ? m.maxAttempts : undefined
        const reason = str(m.errorMessage)?.split('\n')[0]
        o.onEvent({ t: 'notice', text: `Retrying${attempt && max ? ` (${attempt}/${max})` : ''}${reason ? `: ${reason}` : ''}`, tone: 'warning' })
        return
      }
      case 'auto_retry_end':
        if (m.success === false && str(m.finalError)) o.onEvent({ t: 'notice', text: str(m.finalError) ?? '', tone: 'error' })
        return
      case 'compaction_end':
        if (str(m.errorMessage)) o.onEvent({ t: 'notice', text: `Compaction failed: ${str(m.errorMessage)}`, tone: 'error' })
        else if (obj(m.result)) o.onEvent({ t: 'notice', text: 'Context compacted', tone: 'muted' })
        return
      case 'extension_error':
        o.onEvent({ t: 'notice', text: `Pi extension error: ${str(m.error) ?? 'unknown'}`, tone: 'warning' })
        return
      case 'extension_ui_request':
        this.onDialog(m)
        return
      default:
    }
  }

  /** An extension's dialog: confirm and select become cards; the rest can't be drawn here and are dismissed. */
  private onDialog(m: Json): void {
    const id = str(m.id)
    const method = str(m.method)
    if (!id || !method) return
    if (method === 'notify') {
      const text = str(m.message)
      if (text) this.options.onEvent({ t: 'notice', text, tone: m.notifyType === 'error' ? 'error' : m.notifyType === 'warning' ? 'warning' : 'muted' })
      return
    }
    if (method !== 'confirm' && method !== 'select') {
      // input/editor dialogs need a text field the card doesn't have; status/widget/title calls want no answer.
      if (method === 'input' || method === 'editor') {
        this.child?.write({ type: 'extension_ui_response', id, cancelled: true })
        this.options.onEvent({ t: 'notice', text: `A Pi extension asked for text input (${str(m.title) ?? method}); answer it in a Pi terminal tab.`, tone: 'warning' })
      }
      return
    }
    const promptId = `pi-${id}`
    const title = str(m.title) ?? 'Pi'
    const prompt: ChatPrompt = method === 'confirm'
      ? { id: promptId, kind: 'permission', toolName: 'Pi', input: {}, title, ...(str(m.message) ? { description: str(m.message) } : {}) }
      : {
          id: promptId,
          kind: 'question',
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: title, multiSelect: false, options: (Array.isArray(m.options) ? m.options : []).map((option) => ({ label: String(option) })) }] }
        }
    this.held.set(promptId, { prompt, method })
    this.options.onEvent({ t: 'prompt', prompt })
    this.hook({ hook_event_name: 'Notification', notification_type: method === 'confirm' ? 'permission_prompt' : 'elicitation_dialog', message: title })
  }

  send(text: string, images: ChatImage[] = [], context: string[] = []): string {
    const uuid = randomUUID()
    this.options.onEvent({ t: 'sent', uuid, text, images: images.length, at: Date.now() })
    const steering = this.streaming
    if (!steering) {
      this.streaming = true
      this.hook({ hook_event_name: 'UserPromptSubmit', session_id: this.options.sessionId })
    }
    const message = withContext(text, context)
    this.request({
      type: 'prompt',
      message,
      ...(images.length ? { images: images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType })) } : {}),
      ...(steering ? { streamingBehavior: 'steer' } : {})
    }).catch((err: unknown) => {
      if (this.ended) return
      this.options.onEvent({ t: 'notice', text: `Couldn't send to Pi: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
      if (!steering) {
        this.streaming = false
        this.options.onEvent({ t: 'turn', state: 'end', at: Date.now() })
        this.hook({ hook_event_name: 'Stop', session_id: this.options.sessionId })
      }
    })
    return uuid
  }

  async interrupt(): Promise<void> {
    this.options.onEvent({ t: 'interrupting' })
    await this.request({ type: 'abort' }).catch((err) => this.options.log(`piChat abort error=${String(err)}`))
  }

  askSideQuestion(): Promise<ChatSideAnswer> {
    return Promise.reject(new Error(`${CHAT_AGENT_FEATURES.pi.label} has no side questions.`))
  }

  async stopTask(): Promise<boolean> {
    return false
  }

  async backgroundTask(): Promise<boolean> {
    return false
  }

  respond(promptId: string, response: ChatPromptResponse): boolean {
    const held = this.held.get(promptId)
    if (!held) return false
    this.held.delete(promptId)
    const id = promptId.slice('pi-'.length)
    const allowed = response.behavior === 'allow'
    if (held.method === 'confirm') {
      this.child?.write({ type: 'extension_ui_response', id, confirmed: allowed })
    } else {
      const answers = obj(response.behavior === 'allow' ? response.updatedInput?.answers : undefined)
      const value = answers ? Object.values(answers).find((a): a is string => typeof a === 'string') : undefined
      this.child?.write(value ? { type: 'extension_ui_response', id, value } : { type: 'extension_ui_response', id, cancelled: true })
    }
    this.options.onEvent({ t: 'prompt-done', id: promptId, allowed })
    this.options.onPromptResolved(held.prompt, allowed)
    return true
  }

  private async applyModel(model: string): Promise<void> {
    const slash = model.indexOf('/')
    await this.request(slash > 0 ? { type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : { type: 'set_model', modelId: model })
  }

  async setModel(model: string | undefined): Promise<void> {
    // Pi has no "back to the default": picking Default keeps the current model.
    if (model) {
      try {
        await this.applyModel(model)
      } catch (err) {
        this.options.onEvent({ t: 'notice', text: `Couldn't switch model: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
        return
      }
    }
    this.options.onEvent({ t: 'meta', info: { model, modelPicked: model !== undefined } })
    void this.refreshApplied()
    void this.refreshUsage()
  }

  async setPermissionMode(): Promise<void> {
    // Pi has no permission modes.
  }

  async setEffort(effort: string | undefined): Promise<void> {
    if (effort) {
      try {
        await this.request({ type: 'set_thinking_level', level: effort })
      } catch (err) {
        this.options.onEvent({ t: 'notice', text: `Couldn't set thinking: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
        return
      }
    }
    this.options.onEvent({ t: 'meta', info: { effort } })
    void this.refreshApplied()
  }

  isEnded(): boolean {
    return this.ended
  }

  close(): void {
    if (this.ended) return
    this.closedByUs = true
    this.child?.kill()
    this.finish()
  }

  private finish(error?: string): void {
    if (this.ended) return
    this.ended = true
    const reason = this.closedByUs ? undefined : error
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason ?? 'Pi stopped.'))
    this.pending.clear()
    for (const held of this.held.values()) this.options.onPromptResolved(held.prompt, false)
    this.held.clear()
    this.options.onEvent({ t: 'process', state: 'exited', at: Date.now(), ...(reason ? { error: reason } : {}) })
    this.options.onExit(reason)
  }
}
