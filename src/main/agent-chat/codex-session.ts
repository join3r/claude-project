import { randomUUID } from 'crypto'
import {
  CHAT_AGENT_FEATURES,
  codexModePolicy,
  DEFAULT_CODEX_MODE,
  type ChatImage,
  type ChatItem,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatSideAnswer,
  type ChatToolItem
} from '../../shared/claude-chat'
import { spawnJsonl, withContext, type AgentChatSession, type AgentSessionOptions, type JsonlChild } from './session'
import {
  codexContextUsage,
  codexDefaultModel,
  codexHistoryRows,
  codexItemRows,
  codexModels,
  codexRateLimits,
  unwrapShellCommand
} from './codex-translate'

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Only `-c key=value` config overrides from the project's Codex args reach
 * `app-server`: the TUI's other flags (`--search`, `-a`, a prompt) mean nothing to it.
 */
export function codexConfigArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '-c' || arg === '--config') && args[i + 1] !== undefined) {
      out.push('-c', args[i + 1])
      i++
    } else if (arg.startsWith('--config=')) {
      out.push('-c', arg.slice('--config='.length))
    }
  }
  return out
}

/** The per-turn sandbox a mode stands for (`turn/start` takes the policy, not the mode). */
function sandboxPolicy(mode: string | undefined, cwd: string): Json {
  const { sandbox } = codexModePolicy(mode)
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

interface HeldRequest {
  rpcId: number | string
  prompt: ChatPrompt
  /** What the request was: decides the reply's shape. */
  type: 'command' | 'file' | 'legacy' | 'question'
  /** Question ids by question text (the card answers by text). */
  questionIds?: Record<string, string>
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

/**
 * Codex as a chat: one long-lived `codex app-server` per tab, driven over its
 * JSON-RPC stdio protocol. A thread is the conversation (the tab's `sessionId`
 * is its id, the same id the terminal tab resumes), a turn is one exchange, and
 * every item Codex reports becomes a row through `codexItemRows`. Approvals are
 * server requests held open until a window answers them, like Claude's
 * `canUseTool`.
 */
export class CodexChatSession implements AgentChatSession {
  private child: JsonlChild | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly held = new Map<string, HeldRequest>()
  private threadId: string | null = null
  private ready: Promise<void> | null = null
  private activeTurn: string | null = null
  /** A turn was asked for and hasn't reported `turn/started` yet. */
  private turnStarting = false
  /** Command output so far, by item id (deltas arrive before the item completes). */
  private readonly output = new Map<string, string>()
  /** Rows by item id, so approvals can show what they are about. */
  private readonly rows = new Map<string, ChatToolItem>()
  private model: string | undefined
  private effort: string | undefined
  private mode: string
  private ended = false
  private closedByUs = false

  constructor(private readonly options: AgentSessionOptions & { onSessionId?: (id: string) => void }) {
    this.model = options.model
    this.effort = options.effort
    this.mode = options.permissionMode ?? DEFAULT_CODEX_MODE
  }

  async start(): Promise<void> {
    const o = this.options
    o.onEvent({ t: 'process', state: 'starting' })
    o.onEvent({ t: 'meta', info: { agent: 'codex', permissionMode: this.mode, modelPicked: Boolean(this.model), ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}) } })
    this.child = spawnJsonl(o, ['app-server', ...codexConfigArgs(o.extraArgs ?? [])], {
      onRecord: (record) => this.onRecord(record),
      onExit: (error) => this.finish(error)
    })
    this.ready = this.open()
    try {
      await this.ready
    } catch (err) {
      // The manager reports a failed start; the dying process must not report it again.
      this.options.log(`codexChat start error=${err instanceof Error ? err.message : String(err)}`)
      this.ended = true
      this.child?.kill()
      throw err
    }
  }

  private async open(): Promise<void> {
    const o = this.options
    await this.request('initialize', {
      clientInfo: { name: 'devtool', title: 'DevTool', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    this.notify('initialized')
    const policy = codexModePolicy(this.mode)
    const settings = { cwd: o.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, ...(this.model ? { model: this.model } : {}) }
    let result: Json | undefined
    let resumed = false
    if (o.sessionId) {
      try {
        result = obj(await this.request('thread/resume', { threadId: o.sessionId, ...settings }))
        resumed = true
      } catch (err) {
        // A fresh tab's id names no thread yet: start one.
        o.log(`codexChat resume failed thread=${o.sessionId} error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!result) result = obj(await this.request('thread/start', settings))
    const thread = obj(result?.thread)
    const threadId = str(thread?.id)
    if (!threadId) throw new Error('Codex started no thread')
    this.threadId = threadId
    if (threadId !== o.sessionId) {
      o.onSessionId?.(threadId)
      try { o.onHook({ hook_event_name: 'SessionStart', session_id: threadId }) } catch { /* status is best-effort */ }
    }
    if (resumed) {
      const rows = codexHistoryRows(thread?.turns)
      if (rows.length > 0) o.onEvent({ t: 'restore', items: rows })
    }
    o.onEvent({ t: 'process', state: 'running' })
    o.onEvent({
      t: 'meta',
      info: {
        agent: 'codex',
        sessionId: threadId,
        cwd: str(result?.cwd) ?? o.cwd,
        applied: { model: str(result?.model), effort: str(result?.reasoningEffort) ?? null }
      }
    })
    void this.loadModels()
  }

  private async loadModels(): Promise<void> {
    try {
      const result = obj(await this.request('model/list', {}))
      const models = codexModels(result?.data)
      const fallback = codexDefaultModel(result?.data)
      this.options.onEvent({ t: 'meta', models })
      if (fallback.model) this.options.onEvent({ t: 'meta', info: { applied: { model: fallback.model, effort: fallback.effort ?? null } } })
    } catch {
      // The picker falls back to free text.
    }
  }

  // --- JSON-RPC --------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child || this.ended) return Promise.reject(new Error('Codex is not running.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.child?.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private reply(id: number | string, result: unknown): void {
    this.child?.write({ jsonrpc: '2.0', id, result })
  }

  private onRecord(record: unknown): void {
    const m = obj(record)
    if (!m) return
    const method = str(m.method)
    const id = m.id as number | string | undefined
    if (!method && id !== undefined) {
      const waiter = this.pending.get(id as number)
      if (!waiter) return
      this.pending.delete(id as number)
      const error = obj(m.error)
      if (error) waiter.reject(new Error(str(error.message) ?? 'Codex request failed'))
      else waiter.resolve(m.result)
      return
    }
    if (!method) return
    try {
      if (id !== undefined) this.onServerRequest(id, method, obj(m.params) ?? {})
      else this.onNotification(method, obj(m.params) ?? {})
    } catch (err) {
      this.options.log(`codexChat handler method=${method} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // --- Events ----------------------------------------------------------------

  private emitRows(rows: ChatItem[]): void {
    for (const row of rows) {
      if (row.kind === 'tool') this.rows.set(row.id, row)
      this.options.onEvent({ t: 'item', item: row, at: Date.now() })
    }
  }

  private hook(body: Record<string, unknown>): void {
    try { this.options.onHook(body) } catch { /* status is best-effort */ }
  }

  private onNotification(method: string, p: Json): void {
    const o = this.options
    if (p.threadId !== undefined && this.threadId && p.threadId !== this.threadId) return
    switch (method) {
      case 'turn/started': {
        this.activeTurn = str(obj(p.turn)?.id) ?? null
        this.turnStarting = false
        o.onEvent({ t: 'turn', state: 'start', at: Date.now() })
        return
      }
      case 'turn/completed': {
        const turn = obj(p.turn)
        this.activeTurn = null
        this.turnStarting = false
        this.output.clear()
        const status = str(turn?.status)
        const error = str(obj(turn?.error)?.message)
        o.onEvent({ t: 'turn', state: 'end', interrupted: status === 'interrupted', ...(status === 'failed' ? { error: error ?? 'The turn failed.' } : {}), at: Date.now() })
        this.hook({ hook_event_name: 'Stop', session_id: this.threadId })
        return
      }
      case 'item/started':
      case 'item/completed': {
        const item = obj(p.item)
        if (!item) return
        if (item.type === 'userMessage') {
          if (method === 'item/started') o.onEvent({ t: 'delivered', ...(str(item.clientId) ? { uuid: str(item.clientId) } : {}) })
          return
        }
        // An empty message starting is what its deltas will fill.
        if (method === 'item/started' && (item.type === 'agentMessage' || item.type === 'reasoning')) return
        const itemId = str(item.id)
        if (method === 'item/completed' && item.type === 'commandExecution' && itemId && !item.aggregatedOutput && this.output.has(itemId)) {
          item.aggregatedOutput = this.output.get(itemId)
        }
        const rows = codexItemRows(item)
        this.emitRows(rows)
        for (const row of rows) {
          if (row.kind !== 'tool') continue
          if (method === 'item/started') this.hook({ hook_event_name: 'PreToolUse', tool_name: row.name, tool_input: row.input, tool_use_id: row.id })
          else this.hook({ hook_event_name: row.status === 'error' ? 'PostToolUseFailure' : 'PostToolUse', tool_name: row.name, tool_input: row.input, tool_use_id: row.id })
        }
        if (itemId && method === 'item/completed') this.output.delete(itemId)
        return
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const itemId = str(p.itemId)
        const delta = str(p.delta)
        if (itemId && delta) o.onEvent({ t: 'delta', id: itemId, kind: 'text', text: delta, at: Date.now() })
        return
      }
      case 'item/reasoning/summaryTextDelta': {
        const itemId = str(p.itemId)
        const delta = str(p.delta)
        if (itemId && delta) o.onEvent({ t: 'delta', id: itemId, kind: 'thinking', text: delta, at: Date.now() })
        return
      }
      case 'item/reasoning/summaryPartAdded': {
        const itemId = str(p.itemId)
        if (itemId && this.output.has(`r:${itemId}`)) o.onEvent({ t: 'delta', id: itemId, kind: 'thinking', text: '\n\n', at: Date.now() })
        if (itemId) this.output.set(`r:${itemId}`, '')
        return
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = str(p.itemId)
        const delta = str(p.delta)
        if (!itemId || !delta) return
        const text = ((this.output.get(itemId) ?? '') + delta).slice(-20_000)
        this.output.set(itemId, text)
        const row = this.rows.get(itemId)
        if (row) this.emitRows([{ ...row, result: text }])
        return
      }
      case 'thread/tokenUsage/updated':
        o.onEvent({ t: 'meta', usage: codexContextUsage(p.tokenUsage) })
        return
      case 'account/rateLimits/updated':
        o.onEvent({ t: 'meta', usage: codexRateLimits(p.rateLimits) })
        return
      case 'error': {
        const message = str(obj(p.error)?.message)
        if (!message) return
        o.onEvent({ t: 'notice', text: p.willRetry === true ? `${message} — retrying` : message, tone: p.willRetry === true ? 'warning' : 'error' })
        return
      }
      case 'model/rerouted': {
        const to = str(p.toModel) ?? str(p.model)
        if (to) o.onEvent({ t: 'notice', text: `Codex switched to ${to}`, tone: 'muted' })
        return
      }
      case 'serverRequest/resolved': {
        // Answered or withdrawn on Codex's side (the turn ended): the card goes.
        const requestId = p.requestId as number | string | undefined
        for (const [promptId, held] of this.held) {
          if (held.rpcId !== requestId) continue
          this.held.delete(promptId)
          o.onEvent({ t: 'prompt-done', id: promptId, allowed: false })
          o.onPromptResolved(held.prompt, false)
        }
        return
      }
      default:
        return
    }
  }

  private onServerRequest(id: number | string, method: string, p: Json): void {
    const promptId = `codex-${id}`
    const itemId = str(p.itemId) ?? str(p.callId)
    let held: HeldRequest
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const raw = str(p.command) ?? (Array.isArray(p.command) ? p.command.join(' ') : '')
        held = {
          rpcId: id,
          type: method === 'execCommandApproval' ? 'legacy' : 'command',
          prompt: {
            id: promptId,
            kind: 'permission',
            toolName: 'Bash',
            ...(itemId ? { toolUseId: itemId } : {}),
            input: { command: unwrapShellCommand(raw) },
            ...(str(p.reason) ? { reason: str(p.reason) } : {})
          }
        }
        break
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        const row = itemId ? this.rows.get(itemId) : undefined
        held = {
          rpcId: id,
          type: method === 'applyPatchApproval' ? 'legacy' : 'file',
          prompt: {
            id: promptId,
            kind: 'permission',
            toolName: row?.name ?? 'Edit',
            ...(itemId ? { toolUseId: itemId } : {}),
            input: row?.input ?? {},
            ...(str(p.reason) ? { reason: str(p.reason) } : {}),
            ...(str(p.grantRoot) ? { blockedPath: str(p.grantRoot) } : {})
          }
        }
        break
      }
      case 'item/tool/requestUserInput': {
        const questions = Array.isArray(p.questions) ? p.questions.map(obj).filter((q): q is Json => !!q) : []
        const questionIds: Record<string, string> = {}
        for (const q of questions) questionIds[str(q.question) ?? ''] = str(q.id) ?? ''
        held = {
          rpcId: id,
          type: 'question',
          questionIds,
          prompt: {
            id: promptId,
            kind: 'question',
            toolName: 'AskUserQuestion',
            input: {
              questions: questions.map((q) => ({
                question: str(q.question) ?? '',
                header: str(q.header),
                multiSelect: false,
                options: Array.isArray(q.options) ? q.options.map(obj).filter(Boolean).map((option) => ({ label: str(option?.label) ?? '', description: str(option?.description) })) : []
              }))
            }
          }
        }
        break
      }
      default:
        this.child?.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `DevTool does not handle ${method}` } })
        return
    }
    this.held.set(promptId, held)
    this.options.onEvent({ t: 'prompt', prompt: held.prompt })
    if (held.prompt.kind === 'permission') {
      this.hook({ hook_event_name: 'PermissionRequest', tool_name: held.prompt.toolName, tool_input: held.prompt.input, tool_use_id: held.prompt.toolUseId })
    } else {
      this.hook({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Codex has a question' })
    }
  }

  // --- AgentChatSession --------------------------------------------------------

  send(text: string, images: ChatImage[] = [], context: string[] = []): string {
    const uuid = randomUUID()
    this.options.onEvent({ t: 'sent', uuid, text, images: images.length, at: Date.now() })
    const input: Json[] = [
      { type: 'text', text: withContext(text, context), text_elements: [] },
      ...images.map((image) => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` }))
    ]
    void this.deliver(uuid, input)
    return uuid
  }

  private async deliver(uuid: string, input: Json[]): Promise<void> {
    try {
      await this.ready
      if (!this.threadId) throw new Error('Codex has no thread.')
      if (this.activeTurn) {
        try {
          await this.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.activeTurn, clientUserMessageId: uuid })
          return
        } catch {
          // The turn ended meanwhile: this message starts the next one.
        }
      }
      const startsTurn = !this.turnStarting
      this.turnStarting = true
      if (startsTurn) this.hook({ hook_event_name: 'UserPromptSubmit', session_id: this.threadId })
      const policy = codexModePolicy(this.mode)
      await this.request('turn/start', {
        threadId: this.threadId,
        input,
        clientUserMessageId: uuid,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: sandboxPolicy(this.mode, this.options.cwd),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {})
      })
    } catch (err) {
      this.turnStarting = false
      if (this.ended) return
      const message = err instanceof Error ? err.message : String(err)
      this.options.onEvent({ t: 'notice', text: `Couldn't send to Codex: ${message}`, tone: 'error' })
      this.options.onEvent({ t: 'turn', state: 'end', at: Date.now() })
      this.hook({ hook_event_name: 'Stop', session_id: this.threadId })
    }
  }

  async interrupt(): Promise<void> {
    this.options.onEvent({ t: 'interrupting' })
    if (!this.threadId || !this.activeTurn) return
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurn })
      .catch((err) => this.options.log(`codexChat interrupt error=${String(err)}`))
  }

  askSideQuestion(): Promise<ChatSideAnswer> {
    return Promise.reject(new Error(`${CHAT_AGENT_FEATURES.codex.label} has no side questions.`))
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
    const allowed = response.behavior === 'allow'
    if (held.type === 'question') {
      const answers: Record<string, { answers: string[] }> = {}
      const given = obj(response.behavior === 'allow' ? response.updatedInput?.answers : undefined) ?? {}
      for (const [question, answer] of Object.entries(given)) {
        const questionId = held.questionIds?.[question]
        if (questionId && typeof answer === 'string') answers[questionId] = { answers: answer.split(', ').filter(Boolean) }
      }
      this.reply(held.rpcId, { answers })
    } else if (held.type === 'legacy') {
      this.reply(held.rpcId, { decision: allowed ? (response.always ? 'approved_for_session' : 'approved') : 'denied' })
    } else {
      this.reply(held.rpcId, { decision: allowed ? (response.always ? 'acceptForSession' : 'accept') : 'decline' })
    }
    this.options.onEvent({ t: 'prompt-done', id: promptId, allowed })
    this.options.onPromptResolved(held.prompt, allowed)
    return true
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model
    this.options.onEvent({ t: 'meta', info: { model, modelPicked: model !== undefined } })
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode
    this.options.onEvent({ t: 'meta', info: { permissionMode: mode } })
  }

  async setEffort(effort: string | undefined): Promise<void> {
    this.effort = effort
    this.options.onEvent({ t: 'meta', info: { effort } })
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
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason ?? 'Codex stopped.'))
    this.pending.clear()
    for (const held of this.held.values()) this.options.onPromptResolved(held.prompt, false)
    this.held.clear()
    this.options.onEvent({ t: 'process', state: 'exited', at: Date.now(), ...(reason ? { error: reason } : {}) })
    this.options.onExit(reason)
  }
}
