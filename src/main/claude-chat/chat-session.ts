import { randomUUID } from 'crypto'
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import { loadClaudeSdk } from './sdk'
import {
  isChatPermissionMode,
  promptKindFor,
  type ChatEvent,
  type ChatImage,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatSideAnswer,
  type ChatColdCache,
  type ChatUsage
} from '../../shared/claude-chat'

/**
 * Hook events forwarded to DevTool's status pipeline, in-process (no curl, no
 * tunnel). PermissionRequest is not among them: its callback can land after the
 * prompt was already answered, which would re-raise attention for a dialog that is
 * gone. The session reports prompts itself, from `canUseTool`, which is exact.
 */
export const FORWARDED_HOOK_EVENTS: HookEvent[] = [
  'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'
]

/**
 * The CLI skips the Stop hook when a turn is interrupted (Esc / Stop), so the tab's
 * status would stay "working" with nothing left to clear it. The turn's `result`
 * still arrives: when it does and neither Stop nor StopFailure came for that turn,
 * the session reports the Stop itself.
 */
export class TurnStopTracker {
  private open = false

  hook(event: unknown): void {
    if (event === 'UserPromptSubmit') this.open = true
    else if (event === 'Stop' || event === 'StopFailure') this.open = false
  }

  /** A turn's `result` arrived; true when its Stop is missing and must be sent for it. */
  result(): boolean {
    const missed = this.open
    this.open = false
    return missed
  }
}

/**
 * SessionStart runs before the CLI registers SDK hook callbacks, so a callback never
 * sees it. A command hook does: it echoes its input to stderr, which comes back in
 * the `hook_response` message over the protocol channel, so it works through ssh
 * with no tunnel. Stdout stays `{}`: a SessionStart hook's plain stdout would be
 * added to Claude's context.
 */
export const SESSION_START_HOOK = { type: 'command', command: "cat >&2; printf '{}'", shell: 'bash', timeout: 10 } as const

/** The input our {@link SESSION_START_HOOK} echoed, from a `hook_response` message. */
export function sessionStartInput(message: unknown): Record<string, unknown> | null {
  const m = message as { type?: unknown; subtype?: unknown; hook_event?: unknown; stderr?: unknown } | null
  if (!m || m.type !== 'system' || m.subtype !== 'hook_response' || m.hook_event !== 'SessionStart') return null
  if (typeof m.stderr !== 'string' || !m.stderr.trimStart().startsWith('{')) return null
  try {
    const input = JSON.parse(m.stderr) as Record<string, unknown>
    return input && input.hook_event_name === 'SessionStart' && typeof input.session_id === 'string' ? input : null
  } catch {
    // Some other SessionStart hook's stderr.
    return null
  }
}

/** A resume whose prompt cache the CLI thinks has expired, or null. */
export function coldCacheFrom(input: Record<string, unknown>): ChatColdCache | null {
  if (input.source !== 'resume' && input.source !== 'fork') return null
  if (input.prompt_cache_likely_expired !== true) return null
  const tokens = input.context_tokens
  if (typeof tokens !== 'number' || tokens <= 0) return null
  const cache: ChatColdCache = { contextTokens: tokens }
  if (typeof input.seconds_since_last_response === 'number') cache.idleSeconds = input.seconds_since_last_response
  if (typeof input.estimated_cache_write_usd === 'number') cache.estimatedUsd = input.estimated_cache_write_usd
  return cache
}

/**
 * The CLI leaves the Artifact tool off in SDK sessions ("sdk_default_off") unless
 * CLAUDE_CODE_ARTIFACT is set. A chat tab is someone at a keyboard, like a
 * terminal session, so turn it on. CLAUDE_CODE_ARTIFACT=0 in the env, or
 * `enableArtifact: false` in settings, still turns it off.
 */
export function chatEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return env.CLAUDE_CODE_ARTIFACT === undefined ? { ...env, CLAUDE_CODE_ARTIFACT: '1' } : env
}

/**
 * `/btw` in the SDK: shipped in the SDK's code, not yet in its types. Checked at
 * runtime so an SDK without it fails the question, not the session.
 */
interface SideQuestionQuery {
  askSideQuestion?: (question: string) => Promise<{ response: string; synthetic: boolean } | null>
}

/** A local chat's mode when no settings file sets `permissions.defaultMode`. */
const DEFAULT_CHAT_MODE = 'auto'

/**
 * `get_settings` in the SDK: shipped in its code, not yet in its types. `applied`
 * is what the next request sends, with the settings' and the model's defaults resolved.
 */
interface SettingsQuery {
  getSettings?: () => Promise<{ applied?: { model?: unknown; effort?: unknown } } | null>
}

/** Mid-turn context refreshes are at most this often; a turn's end always refreshes. */
const CONTEXT_REFRESH_MS = 20_000

/** A plan window from `/usage`'s answer, when it has a number. */
function limitWindow(raw: { utilization: number | null; resets_at: string | null } | null | undefined): ChatUsage['fiveHour'] {
  if (!raw || typeof raw.utilization !== 'number') return undefined
  return { utilization: raw.utilization, ...(raw.resets_at ? { resetsAt: raw.resets_at } : {}) }
}

/**
 * Background task types that end on their own and hand the turn back to Claude:
 * agents and workflows. A shell may be a dev server or a watcher that never ends,
 * so it must not keep the task working.
 */
const RESUMING_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow'])

/**
 * How many live background tasks hold the agent's turn open, from a
 * `background_tasks_changed` level, or null for any other message. Ambient ones
 * (watchers, skip-transcript tasks) are not activity, and shells may never end,
 * so neither counts.
 */
export function backgroundTaskCount(message: unknown): number | null {
  const m = message as { type?: unknown; subtype?: unknown; tasks?: unknown } | null
  if (!m || m.type !== 'system' || m.subtype !== 'background_tasks_changed') return null
  const tasks = Array.isArray(m.tasks) ? m.tasks : []
  return tasks.filter((task) => {
    const t = task as { ambient?: unknown; task_type?: unknown } | null
    return !!t && typeof t === 'object' && t.ambient !== true && typeof t.task_type === 'string' && RESUMING_TASK_TYPES.has(t.task_type)
  }).length
}

/** SDK messages no window draws; dropped before they cost an IPC hop. */
export function isDisplayRelevant(message: unknown): boolean {
  const m = message as { type?: string; subtype?: string; event?: { type?: string; delta?: { type?: string } } } | null
  if (!m || typeof m !== 'object') return false
  switch (m.type) {
    case 'stream_event': {
      const type = m.event?.type
      if (type === 'message_start' || type === 'content_block_start') return true
      if (type === 'content_block_delta') {
        const delta = m.event?.delta?.type
        return delta === 'text_delta' || delta === 'thinking_delta'
      }
      return false
    }
    case 'system':
      return m.subtype !== 'hook_started' && m.subtype !== 'hook_progress' && m.subtype !== 'hook_response'
        && m.subtype !== 'thinking_tokens' && m.subtype !== 'notification' && m.subtype !== 'files_persisted'
    case 'assistant':
    case 'user':
    case 'result':
    case 'conversation_reset':
      return true
    default:
      return false
  }
}

/** `--flag value` / `--flag` pairs from the project's extra Claude args, for `extraArgs`. */
export function extraArgsRecord(args: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      out[arg.slice(2)] = next
      i++
    } else {
      out[arg.slice(2)] = null
    }
  }
  return out
}

/** Flags the SDK already owns; letting a project override them would break the protocol. */
const RESERVED_FLAGS = new Set([
  'print', 'p', 'output-format', 'input-format', 'verbose', 'resume', 'r', 'continue', 'c',
  'session-id', 'permission-prompt-tool', 'include-partial-messages', 'replay-user-messages',
  'setting-sources', 'fork-session'
])

export interface ChatSessionOptions {
  cwd: string
  sessionId: string
  /** The transcript exists: continue it with `resume` rather than creating it. */
  resume: boolean
  /** `claude` to run — resolved locally, or the bare name for a remote login shell. */
  executable: string
  env: Record<string, string | undefined>
  extraArgs?: string[]
  model?: string
  permissionMode?: string
  effort?: string
  /** Remote projects spawn through ssh; local ones let the SDK spawn. */
  spawn?: (options: SpawnOptions) => SpawnedProcess
  onEvent: (event: ChatEvent) => void
  onHook: (body: Record<string, unknown>) => void
  onPromptResolved: (prompt: ChatPrompt, allowed: boolean) => void
  onExit: (error?: string) => void
  log: (message: string) => void
}

interface HeldPrompt {
  prompt: ChatPrompt
  suggestions?: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
}

/** A minimal async queue: the streaming-input `prompt` of a long-lived `query()`. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private done = false

  push(message: SDKUserMessage): void {
    if (this.done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
    } else {
      this.items.push(message)
    }
  }

  end(): void {
    this.done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      }
    }
  }
}

/**
 * One long-lived `claude` process for one chat tab, driven through the Agent SDK's
 * streaming input: messages are pushed into the input stream as they are sent —
 * mid-turn too, where Claude picks them up at its next step, as when typing into
 * the terminal UI. Permission prompts arrive as `canUseTool` calls and are held
 * open until a window answers them.
 */
export class ChatSession {
  private readonly input = new MessageQueue()
  private query: Query | null = null
  private readonly held = new Map<string, HeldPrompt>()
  private closedByUs = false
  private stderrTail = ''
  private ended = false
  private running = false
  /** Usage refresh in flight, and whether another was asked for meanwhile (and with limits). */
  private usageBusy = false
  private usageAgain: boolean | null = null
  private lastContextRefresh = 0
  /** A turn reported its cost; that running total (it includes a resumed session's past turns) wins over `/usage`'s. */
  private sawResultCost = false
  private readonly turnStop = new TurnStopTracker()

  constructor(private readonly options: ChatSessionOptions) {}

  async start(): Promise<void> {
    const sdk = await loadClaudeSdk()
    const o = this.options
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const event of FORWARDED_HOOK_EVENTS) {
      hooks[event] = [{
        hooks: [async (input) => {
          this.turnStop.hook(input.hook_event_name)
          try { o.onHook(input as unknown as Record<string, unknown>) } catch { /* status is best-effort */ }
          return {}
        }]
      }]
    }

    const extra: Record<string, string | null> = { 'replay-user-messages': null }
    for (const [key, value] of Object.entries(extraArgsRecord(o.extraArgs ?? []))) {
      if (!RESERVED_FLAGS.has(key)) extra[key] = value
    }

    const queryOptions: Options = {
      cwd: o.cwd,
      pathToClaudeCodeExecutable: o.executable,
      env: chatEnv(o.env),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      hooks,
      extraArgs: extra,
      allowDangerouslySkipPermissions: true,
      // The tab has a per-task Stop, so Stop/Esc only aborts the turn and spares
      // background agents and shells. Subagents also report a one-line summary.
      perTaskStopAffordance: true,
      agentProgressSummaries: true,
      ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
      ...(o.model ? { model: o.model } : {}),
      ...(o.permissionMode ? { permissionMode: o.permissionMode as PermissionMode } : {}),
      ...(o.effort ? { effort: o.effort as Options['effort'] } : {}),
      ...(o.spawn ? { spawnClaudeCodeProcess: o.spawn } : {}),
      // A project's own `--settings` would collide with this one; it wins, and the
      // tab loses SessionStart status and the cold-cache warning.
      ...('settings' in extra ? {} : { settings: { hooks: { SessionStart: [{ hooks: [SESSION_START_HOOK] }] } } }),
      stderr: (data: string) => { this.captureStderr(data) }
    }

    // The SDK always passes `--permission-mode`, which would override the user's own
    // `permissions.defaultMode`. Resolve it the way the CLI does (repo-committed
    // escalations filtered out) so a chat starts in the mode a terminal would, and
    // in Auto when no settings file names one. Remote settings live on the host,
    // where the CLI's default applies.
    if (!o.permissionMode && !o.spawn) {
      let mode: string | undefined
      try {
        const resolved = await sdk.resolveSettings({ cwd: o.cwd, settingSources: ['user', 'project', 'local'] })
        mode = sdk.filterEscalatingDefaultMode(resolved).permissions?.defaultMode
      } catch {
        // Unreadable settings: start in Auto all the same.
      }
      queryOptions.permissionMode = (mode ?? DEFAULT_CHAT_MODE) as PermissionMode
    }

    o.onEvent({ t: 'process', state: 'starting' })
    o.onEvent({ t: 'meta', info: { modelPicked: Boolean(o.model), ...(queryOptions.permissionMode ? { permissionMode: queryOptions.permissionMode } : {}) } })
    this.query = sdk.query({ prompt: this.input, options: queryOptions })
    void this.pump(this.query)
    void this.loadMeta(this.query)
  }

  captureStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-4000)
  }

  private async pump(query: Query): Promise<void> {
    let error: string | undefined
    try {
      for await (const message of query) {
        if ((message as { type?: string }).type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          this.markRunning()
        }
        if (isDisplayRelevant(message)) this.options.onEvent({ t: 'sdk', m: message, at: Date.now() })
        const started = sessionStartInput(message)
        if (started) this.onSessionStart(started)
        const background = backgroundTaskCount(message)
        if (background !== null) {
          try { this.options.onHook({ hook_event_name: 'DevtoolBackgroundTasks', count: background }) } catch { /* status is best-effort */ }
        }
        if ((message as { type?: string }).type === 'result' && this.turnStop.result()) {
          const sessionId = (message as { session_id?: unknown }).session_id
          try { this.options.onHook({ hook_event_name: 'Stop', session_id: sessionId }) } catch { /* status is best-effort */ }
        }
        this.noteForUsage(message as { type?: string; subtype?: string; parent_tool_use_id?: unknown; total_cost_usd?: unknown })
      }
    } catch (err) {
      if (!this.closedByUs) {
        const message = err instanceof Error ? err.message : String(err)
        const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n')
        error = tail && !message.includes(tail) ? `${message}\n${tail}` : message
        this.options.log(`chatSession error=${JSON.stringify(error)}`)
      }
    } finally {
      this.finish(error)
    }
  }

  private onSessionStart(input: Record<string, unknown>): void {
    try { this.options.onHook(input) } catch { /* status is best-effort */ }
    const cache = coldCacheFrom(input)
    if (cache) this.options.onEvent({ t: 'cold-cache', cache })
  }

  private markRunning(): void {
    if (this.running || this.ended) return
    this.running = true
    this.options.onEvent({ t: 'process', state: 'running' })
  }

  private finish(error?: string): void {
    if (this.ended) return
    this.ended = true
    for (const held of this.held.values()) {
      held.resolve({ behavior: 'deny', message: 'The session ended.' })
    }
    this.held.clear()
    this.input.end()
    this.options.onEvent({ t: 'process', state: 'exited', at: Date.now(), ...(error ? { error } : {}) })
    this.options.onExit(error)
  }

  /** Keep the composer's meter current: a turn's end, a compaction, a limit change, and now and then mid-turn. */
  private noteForUsage(m: { type?: string; subtype?: string; parent_tool_use_id?: unknown; total_cost_usd?: unknown }): void {
    if (m.type === 'result') {
      if (typeof m.total_cost_usd === 'number' && m.total_cost_usd > 0) {
        this.sawResultCost = true
        this.options.onEvent({ t: 'meta', usage: { costUsd: m.total_cost_usd } })
      }
      this.refreshUsage(true)
      // A `/model` or `/effort` sent as a message changes them too.
      this.refreshApplied()
    } else if (m.type === 'rate_limit_event') {
      this.refreshUsage(true)
    } else if (m.type === 'conversation_reset' || (m.type === 'system' && m.subtype === 'compact_boundary')) {
      this.refreshUsage(false)
    } else if (m.type === 'assistant' && !m.parent_tool_use_id && Date.now() - this.lastContextRefresh > CONTEXT_REFRESH_MS) {
      this.refreshUsage(false)
    }
  }

  /** Read `/context` (and, with `limits`, `/usage`) from the CLI. Best-effort: a failure leaves the last numbers. */
  private refreshUsage(limits: boolean): void {
    const query = this.query
    if (!query || this.ended) return
    if (this.usageBusy) {
      this.usageAgain = (this.usageAgain ?? false) || limits
      return
    }
    this.usageBusy = true
    this.lastContextRefresh = Date.now()
    void (async () => {
      const usage: ChatUsage = {}
      const context = await query.getContextUsage({ detail: 'summary' }).catch(() => null)
      if (context) {
        usage.contextTokens = context.totalTokens
        usage.contextMax = context.maxTokens
      }
      if (limits) {
        const plan = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null)
        if (plan) {
          // An experimental answer: one without `session` (an older or newer CLI) is no cost.
          const cost = (plan.session as { total_cost_usd?: number } | undefined)?.total_cost_usd
          if (!this.sawResultCost && typeof cost === 'number' && cost > 0) usage.costUsd = cost
          usage.fiveHour = limitWindow(plan.rate_limits?.five_hour)
          usage.sevenDay = limitWindow(plan.rate_limits?.seven_day)
        }
      }
      if (!this.ended && Object.keys(usage).length > 0) this.options.onEvent({ t: 'meta', usage })
    })().finally(() => {
      this.usageBusy = false
      const again = this.usageAgain
      this.usageAgain = null
      if (again !== null) this.refreshUsage(again)
    })
  }

  private async loadMeta(query: Query): Promise<void> {
    try {
      const [models, commands] = await Promise.all([
        query.supportedModels().catch(() => []),
        query.supportedCommands().catch(() => [])
      ])
      // The CLI answered its initialize handshake: it is up, even though `system:init`
      // only comes with the first turn.
      if (!this.ended) this.markRunning()
      this.refreshUsage(true)
      this.refreshApplied()
      this.options.onEvent({
        t: 'meta',
        models: models.map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel,
          displayName: m.displayName,
          description: m.description,
          supportedEffortLevels: m.supportedEffortLevels
        })),
        // Names can repeat (a user skill and a plugin one); the first row is the one /name runs.
        commands: commands
          .filter((c, index) => commands.findIndex((other) => other.name === c.name) === index)
          .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      })
    } catch {
      // Pickers fall back to free text.
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const prompt: ChatPrompt = {
      id: options.requestId || randomUUID(),
      kind: promptKindFor(toolName),
      toolName,
      toolUseId: options.toolUseID,
      input,
      suggestions: options.suggestions,
      blockedPath: options.blockedPath,
      title: options.title,
      description: options.description,
      reason: options.decisionReason,
      agentId: options.agentID
    }
    return new Promise<PermissionResult>((resolve) => {
      this.held.set(prompt.id, { prompt, suggestions: options.suggestions, resolve })
      options.signal.addEventListener('abort', () => {
        if (!this.held.delete(prompt.id)) return
        resolve({ behavior: 'deny', message: 'Cancelled.' })
        this.options.onEvent({ t: 'prompt-done', id: prompt.id, allowed: false })
        this.options.onPromptResolved(prompt, false)
      }, { once: true })
      this.options.onEvent({ t: 'prompt', prompt })
      if (prompt.kind === 'permission') {
        this.options.onHook({ hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: input, tool_use_id: options.toolUseID })
      }
    })
  }

  /** Answer a held prompt. False when it is no longer open (another window answered). */
  respond(promptId: string, response: ChatPromptResponse): boolean {
    const held = this.held.get(promptId)
    if (!held) return false
    this.held.delete(promptId)
    const { prompt } = held
    let result: PermissionResult
    if (response.behavior === 'allow') {
      // "Always" on a plan means what the terminal's plan dialog offers: leave plan
      // mode straight into accepting edits. Otherwise it applies Claude's own rules.
      const updatedPermissions: PermissionUpdate[] = !response.always
        ? []
        : prompt.kind === 'plan'
          ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
          : held.suggestions ?? []
      const mode = isChatPermissionMode(response.mode) ? response.mode : undefined
      if (mode) {
        // One mode wins: a suggestion's own setMode would fight the one asked for.
        const rules = updatedPermissions.filter((update) => update.type !== 'setMode')
        updatedPermissions.length = 0
        updatedPermissions.push(...rules, { type: 'setMode', mode, destination: 'session' })
      }
      result = {
        behavior: 'allow',
        updatedInput: response.updatedInput ?? prompt.input,
        ...(updatedPermissions.length ? { updatedPermissions } : {})
      }
      if (mode) this.options.onEvent({ t: 'meta', info: { permissionMode: mode } })
    } else {
      result = { behavior: 'deny', message: response.message?.trim() || 'The user declined this action.' }
    }
    held.resolve(result)
    const allowed = response.behavior === 'allow'
    this.options.onEvent({ t: 'prompt-done', id: promptId, allowed })
    this.options.onPromptResolved(prompt, allowed)
    return true
  }

  /**
   * Queue a user message. Returns its uuid, which the replay echo carries back.
   * `context`: text blocks that go ahead of it (the `!command`s run since the last one).
   */
  send(text: string, images: ChatImage[] = [], context: string[] = []): string {
    const uuid = randomUUID()
    const content = images.length === 0 && context.length === 0
      ? text
      : [
          ...context.map((block) => ({ type: 'text' as const, text: block })),
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.data }
          })),
          ...(text ? [{ type: 'text' as const, text }] : [])
        ]
    this.options.onEvent({ t: 'sent', uuid, text, images: images.length, at: Date.now() })
    this.input.push({
      type: 'user',
      uuid: uuid as SDKUserMessage['uuid'],
      message: { role: 'user', content },
      parent_tool_use_id: null
    })
    return uuid
  }

  async interrupt(): Promise<void> {
    this.options.onEvent({ t: 'interrupting' })
    await this.query?.interrupt().catch((err) => this.options.log(`chatInterrupt error=${String(err)}`))
  }

  /** `/btw`: answered from the conversation so far; nothing joins the transcript. */
  async askSideQuestion(question: string): Promise<ChatSideAnswer> {
    const query = this.query as (Query & SideQuestionQuery) | null
    if (!query || this.ended) throw new Error('Claude is not running.')
    if (typeof query.askSideQuestion !== 'function') throw new Error('This Agent SDK has no side questions.')
    const answer = await query.askSideQuestion(question)
    return answer ? { response: answer.response, synthetic: answer.synthetic } : { response: null }
  }

  /** Stop one running task (a subagent, a shell). Failures show in the timeline. */
  async stopTask(taskId: string): Promise<boolean> {
    const query = this.query
    if (!query || this.ended) return this.taskFailed('stop', 'Claude is not running.')
    try {
      await query.stopTask(taskId)
      return true
    } catch (err) {
      this.options.log(`chatStopTask task=${taskId} error=${String(err)}`)
      return this.taskFailed('stop', err instanceof Error ? err.message : String(err))
    }
  }

  /** Move the foreground task started by one tool call to the background. */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    const query = this.query
    if (!query || this.ended) return this.taskFailed('background', 'Claude is not running.')
    try {
      if (await query.backgroundTasks(toolUseId)) return true
      return this.taskFailed('background', 'It is no longer running in the foreground.')
    } catch (err) {
      this.options.log(`chatBackgroundTask toolUse=${toolUseId} error=${String(err)}`)
      return this.taskFailed('background', err instanceof Error ? err.message : String(err))
    }
  }

  private taskFailed(action: 'stop' | 'background', reason: string): false {
    const what = action === 'stop' ? "Couldn't stop the task" : "Couldn't send the task to the background"
    this.options.onEvent({ t: 'notice', text: `${what}: ${reason}`, tone: 'warning' })
    return false
  }

  /** Read the model and effort the CLI will use, for the footer's "Default (…)" labels. Best-effort. */
  private refreshApplied(): void {
    const query = this.query as (Query & SettingsQuery) | null
    if (!query?.getSettings || this.ended) return
    void query.getSettings().then((settings) => {
      const applied = settings?.applied
      if (!applied || this.ended) return
      this.options.onEvent({
        t: 'meta',
        info: {
          applied: {
            model: typeof applied.model === 'string' ? applied.model : undefined,
            effort: typeof applied.effort === 'string' ? applied.effort : null
          }
        }
      })
    }).catch(() => { /* an older CLI: the labels say just "Default" */ })
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query?.setModel(model)
    this.options.onEvent({ t: 'meta', info: { model, modelPicked: model !== undefined } })
    // The default effort is per model.
    this.refreshApplied()
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.query?.setPermissionMode(mode as PermissionMode)
    this.options.onEvent({ t: 'meta', info: { permissionMode: mode } })
  }

  async setEffort(effort: string | undefined): Promise<void> {
    await this.query?.applyFlagSettings({ effortLevel: (effort ?? null) as never })
    this.options.onEvent({ t: 'meta', info: { effort } })
    this.refreshApplied()
  }

  isEnded(): boolean {
    return this.ended
  }

  close(): void {
    if (this.ended) return
    this.closedByUs = true
    this.input.end()
    try { this.query?.close() } catch { /* already gone */ }
    // close() may not settle the pump if the process never started.
    this.finish()
  }
}
