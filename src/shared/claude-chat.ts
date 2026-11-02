import { firstLine, summarizeTool } from './agent-activity'

/**
 * The Claude chat tab's model: what main streams to the windows and how both
 * sides fold it into a timeline.
 *
 * Main owns one `claude` process per chat tab (driven through the Agent SDK) and
 * keeps the folded {@link ChatState}. A window attaching gets that state as a
 * snapshot, then applies every later {@link ChatEvent} through the same
 * {@link reduceChat}, so all windows — and a window that attaches late — draw the
 * same thing. History restored from Claude's transcript goes through the same
 * reducer too, which is what keeps a resumed chat identical to a live one.
 *
 * SDK messages are treated as untyped JSON here on purpose: this file runs in the
 * renderer, the wire format belongs to whichever `claude` binary is installed, and
 * a field that is missing or renamed must degrade a row, not crash the tab.
 */

export type ChatToolStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'denied'

export interface ChatToolItem {
  kind: 'tool'
  id: string
  name: string
  label: string
  input: Record<string, unknown>
  status: ChatToolStatus
  result?: string
  /** Images the result carried (a Read of a screenshot, an MCP browser screenshot). */
  images?: ChatImage[]
  /** Subagent (Agent/Task tool) progress: how many tool calls it made, and the latest. */
  childCount?: number
  lastChild?: string
  /** An Artifact publish: the page it went to. */
  artifact?: { url: string; title?: string }
  /** When the row first appeared (live only; history rows have none). */
  at?: number
}

/** Every row may carry `at`: when it first appeared (live only; history rows have none). */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: number; queued?: boolean; failed?: boolean; at?: number }
  | { kind: 'text'; id: string; text: string; streaming?: boolean; at?: number }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean; at?: number }
  | ChatToolItem
  | { kind: 'notice'; id: string; text: string; tone: 'muted' | 'warning' | 'error'; at?: number }
  | ChatBashItem

/**
 * A `!command` you ran yourself (the CLI's bash mode): run by DevTool, not by
 * Claude, and handed to Claude with your next message.
 */
export interface ChatBashItem {
  kind: 'bash'
  id: string
  command: string
  running?: boolean
  stdout?: string
  stderr?: string
  /** Null when it was killed or never ran. */
  exitCode?: number | null
  /** Waiting to go out with your next message; false once Claude has it. */
  pendingContext?: boolean
  at?: number
}

export type ChatPromptKind = 'permission' | 'question' | 'plan'

/** A `canUseTool` call main is holding open until someone in a window answers it. */
export interface ChatPrompt {
  id: string
  kind: ChatPromptKind
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** Claude's own "don't ask again" rules for this call (PermissionUpdate[]). */
  suggestions?: unknown[]
  blockedPath?: string
  /** Claude's own wording for the prompt, when it gives one. */
  title?: string
  description?: string
  reason?: string
  /** Set when a subagent, not the main thread, is asking. */
  agentId?: string
}

export type ChatProcessState = 'idle' | 'starting' | 'running' | 'exited'

export type ChatTaskKind = 'subagent' | 'shell' | 'workflow' | 'monitor' | 'mcp' | 'other'
export type ChatTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * Work Claude has running beside the turn: a subagent, a shell (Bash, backgrounded
 * or not), a workflow, a monitor. Folded from the SDK's `task_*` edges, with
 * `background_tasks_changed` as the authority on which background ones still run.
 */
export interface ChatTask {
  id: string
  /** The Agent/Bash tool call that started it, when there is one. */
  toolUseId?: string
  kind: ChatTaskKind
  /** The CLI's own task_type (`local_agent`, `local_bash`, …). */
  taskType?: string
  description: string
  /** Shells: the command line. */
  command?: string
  /** Subagents: the agent type (`Explore`, `general-purpose`, …). */
  agentType?: string
  /** Running in the background rather than blocking its tool call. */
  background: boolean
  /** Started by a subagent's own tool call: part of that agent's work, not listed on its own. */
  nested?: boolean
  status: ChatTaskStatus
  startedAt?: number
  endedAt?: number
  toolUses?: number
  tokens?: number
  lastTool?: string
  summary?: string
  /** Workflows: their phases and agents, from `task_progress.workflow_progress`. */
  workflow?: ChatWorkflow
}

export type ChatWorkflowAgentState = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface ChatWorkflowAgent {
  /** The run's own 1-based agent number. */
  index: number
  label: string
  phaseIndex?: number
  state: ChatWorkflowAgentState
  startedAt?: number
  durationMs?: number
  tokens?: number
  toolCalls?: number
  /** What it is doing: the last tool's one-line summary, or its name. */
  lastTool?: string
  /** Above 1 when the script retried it. */
  attempt?: number
}

export interface ChatWorkflowPhase {
  /** 1-based, as the script's `phase()` calls number them. */
  index: number
  title: string
  detail?: string
  /** Reached by the run: a declared phase stays false until it starts. */
  started: boolean
}

export interface ChatWorkflow {
  phases: ChatWorkflowPhase[]
  agents: ChatWorkflowAgent[]
}

/** How long a finished task stays listed with its outcome. */
export const TASK_LINGER_MS = 60_000

/** Tasks worth listing at `now`: running ones, and finished ones inside their linger. */
export function visibleTasks(tasks: Record<string, ChatTask>, now: number): ChatTask[] {
  return Object.values(tasks)
    .filter((task) => task.status === 'running' || (task.endedAt !== undefined && now - task.endedAt < TASK_LINGER_MS))
    .sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
      return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    })
}

export interface ChatModelOption {
  value: string
  /** The wire id an alias resolves to ('haiku' → 'claude-haiku-4-5'), to match `system:init`'s model. */
  resolvedModel?: string
  displayName: string
  description?: string
  supportedEffortLevels?: string[]
}

export interface ChatCommand {
  name: string
  description: string
  argumentHint?: string
}

/** Which coding agent drives a chat tab. */
export type ChatAgent = 'claude' | 'codex' | 'pi'

export interface ChatSessionInfo {
  /** Absent means Claude: older snapshots and the Claude session never set it. */
  agent?: ChatAgent
  sessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  /** The model was picked in this tab; otherwise `model` is whatever the settings default resolved to. */
  modelPicked?: boolean
  /** What the CLI sends next (`get_settings`'s `applied`): the defaults resolved, once read. */
  applied?: { model?: string; effort?: string | null }
  cwd?: string
  claudeVersion?: string
  /** The claude.ai login the plan windows belong to; absent for API-key and cloud-provider sessions. */
  account?: ChatAccount
}

/** A claude.ai login, as the CLI's `accountInfo` names it. */
export interface ChatAccount {
  email: string
  /** `max`, `pro`, `team`… as the CLI reports it. */
  plan?: string
}

/** One plan rate-limit window: percent used (0–100) and when it resets. */
export interface ChatLimitWindow {
  utilization: number
  resetsAt?: string
}

/** What the composer's meter shows; each part appears once main has read it. */
export interface ChatUsage {
  /** Tokens in context now, and the model's window (as `/context` counts them). */
  contextTokens?: number
  contextMax?: number
  /** Session cost at API list prices — an estimate, whatever the account pays. */
  costUsd?: number
  /** claude.ai plan windows; absent for API-key and cloud-provider sessions. */
  fiveHour?: ChatLimitWindow
  sevenDay?: ChatLimitWindow
}

/**
 * A resumed session whose prompt cache has likely expired: the first send writes
 * the whole context back into the cache. Numbers are the CLI's own estimate.
 */
export interface ChatColdCache {
  /** Tokens the first request re-sends. */
  contextTokens: number
  /** Seconds since the transcript's last assistant response. */
  idleSeconds?: number
  /** Cost of that cache write at the session model's rate, response excluded. */
  estimatedUsd?: number
}

export interface ChatState {
  items: ChatItem[]
  pending: ChatPrompt[]
  /** A turn is in flight (sent, or Claude is streaming, until `result`). */
  busy: boolean
  turnStartedAt?: number
  compacting: boolean
  process: ChatProcessState
  /** Why the process last ended, when it was not asked to. */
  processError?: string
  info: ChatSessionInfo
  models: ChatModelOption[]
  commands: ChatCommand[]
  usage: ChatUsage
  /** item index by tool_use id, for pairing results and subagent progress. */
  toolIndex: Record<string, number>
  /** Streaming blocks still open, keyed `${messageId}:${blockIndex}`. */
  openBlocks: Record<string, number>
  /** The message stream events belong to — `message_start` names it, deltas don't. */
  streamMessage?: string
  /** Stop was pressed: the turn's error result is the interrupt, not a failure. */
  interrupting?: boolean
  /** Running tasks, and finished ones for {@link TASK_LINGER_MS}, by task id. */
  tasks: Record<string, ChatTask>
  /** Set on a resume with a cold cache until the first send. */
  coldCache?: ChatColdCache
  /** `/login` in progress or just finished; cleared when dismissed. */
  login?: ChatLogin
}

/** How `/login` signs in: the `claude auth login` flags. */
export type ChatLoginMethod = 'claudeai' | 'console' | 'sso'

export interface ChatLogin {
  /** running: waiting on the browser or a pasted code; verifying: code sent. */
  status: 'running' | 'verifying' | 'done' | 'failed'
  method: ChatLoginMethod
  /** The project is on another host: its browser can't open, so the code has to be pasted. */
  remote?: boolean
  /** The sign-in page that ends with a code to paste, once the CLI printed it. */
  url?: string
  /** On done: who is signed in now. */
  account?: string
  /** On failed: what the CLI said. */
  error?: string
}

export type ChatEvent =
  | { t: 'sdk'; m: unknown; at?: number }
  | { t: 'history'; messages: unknown[] }
  | { t: 'sent'; uuid: string; text: string; images: number; at?: number }
  | { t: 'prompt'; prompt: ChatPrompt }
  | { t: 'prompt-done'; id: string; allowed: boolean }
  | { t: 'process'; state: ChatProcessState; error?: string; at?: number }
  | { t: 'notice'; text: string; tone: 'muted' | 'warning' | 'error' }
  | { t: 'meta'; models?: ChatModelOption[]; commands?: ChatCommand[]; info?: Partial<ChatSessionInfo>; usage?: ChatUsage }
  | { t: 'interrupting' }
  | { t: 'reset' }
  | { t: 'bash'; id: string; command: string; at?: number }
  | { t: 'bash-done'; id: string; stdout: string; stderr: string; exitCode: number | null }
  /** The `!command` context went out with a message. */
  | { t: 'bash-sent'; ids: string[] }
  | { t: 'cold-cache'; cache: ChatColdCache }
  | { t: 'login'; login: ChatLogin | null }
  // Agent-neutral events: what the Codex and Pi sessions speak (Claude's stay `sdk`).
  /** Add a row, or replace the row with the same id. */
  | { t: 'item'; item: ChatItem; at?: number }
  /** Streamed text for a text/thinking row; creates it (streaming) when new. */
  | { t: 'delta'; id: string; kind: 'text' | 'thinking'; text: string; at?: number }
  /** A turn started, or ended (`error` when it failed, `interrupted` when Stop ended it). */
  | { t: 'turn'; state: 'start' | 'end'; error?: string; interrupted?: boolean; at?: number }
  /** The agent took a queued message: the given one, or the oldest still queued. */
  | { t: 'delivered'; uuid?: string }
  /** The conversation so far, read back from the agent's own session; ignored once the timeline has rows. */
  | { t: 'restore'; items: ChatItem[] }

/** What `chat-attach` returns: the state so far and the seq it corresponds to. */
export interface ChatSnapshot {
  seq: number
  state: ChatState
}

/** How a window answers a {@link ChatPrompt}. */
export type ChatPromptResponse =
  /** `mode`: also switch the session to that permission mode (e.g. "allow, and go auto"). */
  | { behavior: 'allow'; always?: boolean; mode?: ChatPermissionMode; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

export interface ChatImage {
  mediaType: string
  /** base64, no data: prefix */
  data: string
}

export const RESULT_TEXT_LIMIT = 20_000
/** Images kept per tool result, and the largest one kept (base64 chars, ~7.5 MB decoded). */
export const RESULT_IMAGE_LIMIT = 4
export const RESULT_IMAGE_CHARS = 10_000_000
const SHOWN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const INPUT_STRING_LIMIT = 50_000

export function emptyChatState(): ChatState {
  return {
    items: [],
    pending: [],
    busy: false,
    compacting: false,
    process: 'idle',
    info: {},
    models: [],
    commands: [],
    usage: {},
    toolIndex: {},
    openBlocks: {},
    tasks: {}
  }
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text
}

function clampInput(input: unknown): Record<string, unknown> {
  const source = obj(input) ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = typeof value === 'string' ? truncate(value, INPUT_STRING_LIMIT) : value
  }
  return out
}

/** A base64 image block we can draw, or undefined (URL sources, unknown or oversized data). */
function imageBlock(block: Json): ChatImage | undefined {
  const source = obj(block.source)
  const data = str(source?.data)
  if (!source || source.type !== 'base64' || !data || data.length > RESULT_IMAGE_CHARS) return undefined
  const mediaType = str(source.media_type) ?? 'image/png'
  return SHOWN_IMAGE_TYPES.has(mediaType) ? { mediaType, data } : undefined
}

/**
 * A tool_result's content as display text plus the images it carried. Images
 * past the limit, or ones we can't draw, are counted in the text instead.
 */
export function toolResultContent(content: unknown): { text: string; images: ChatImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const parts: string[] = []
  const images: ChatImage[] = []
  let dropped = 0
  for (const block of content) {
    const b = obj(block)
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') {
      const image = images.length < RESULT_IMAGE_LIMIT ? imageBlock(b) : undefined
      if (image) images.push(image)
      else dropped++
    }
  }
  if (dropped > 0) parts.push(dropped === 1 ? '[image not shown]' : `[${dropped} images not shown]`)
  return { text: parts.join('\n'), images }
}

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/
const BASH_INPUT_RE = /^<bash-input>([\s\S]*?)<\/bash-input>/
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/

const SHELL_COMMAND_RE = /<user-shell-command>([\s\S]*?)<\/user-shell-command>/
const SHELL_STDOUT_RE = /<user-shell-stdout>([\s\S]*?)<\/user-shell-stdout>/
const SHELL_STDERR_RE = /<user-shell-stderr>([\s\S]*?)<\/user-shell-stderr>/
const SHELL_EXIT_RE = /<user-shell-exit>(-?\d+|killed)<\/user-shell-exit>/
const SHELL_PREAMBLE = 'I ran a shell command myself (not a tool call you made):'

type UserTextEntry =
  | { kind: 'user' | 'notice'; text: string }
  | { kind: 'bash'; command: string; stdout?: string; stderr?: string; exitCode?: number | null }
  | { kind: 'bash-output'; stdout: string; stderr: string }

/**
 * The text block a `!command` rides along with the next message as. Not the CLI's
 * own `<bash-input>` / `<bash-stdout>` form: the CLI doesn't echo a message that
 * carries those back (`--replay-user-messages`), so it would stay "Queued" forever.
 * History still reads both.
 */
export function bashContextBlocks(command: string, stdout: string, stderr: string, exitCode: number | null): string[] {
  return [[
    SHELL_PREAMBLE,
    `<user-shell-command>${command}</user-shell-command>`,
    `<user-shell-stdout>${stdout}</user-shell-stdout>`,
    `<user-shell-stderr>${stderr}</user-shell-stderr>`,
    `<user-shell-exit>${exitCode === null ? 'killed' : exitCode}</user-shell-exit>`
  ].join('\n')]
}
/** `PostCompact [<hook command>] completed successfully: {}`, one per hook that ran. */
const HOOK_OK_RE = /(?:^|\s)[A-Z][A-Za-z]+ \[.*\] completed successfully(?::.*)?$/u

/**
 * A slash command's output without its hooks' success lines: `/compact` appends
 * one per Pre/PostCompact hook, its whole command line included. Failures stay.
 */
function withoutHookLines(text: string): string {
  return text.split('\n')
    .map((line) => line.replace(HOOK_OK_RE, ''))
    .filter((line) => line.trim())
    .join('\n')
    .trim()
}
const META_TAG_RE = /^<(local-command-caveat|system-reminder|command-message|task-notification|bash-input|bash-stdout|bash-stderr)>/

/**
 * How a user text block should show, or null to hide it. Claude records slash
 * commands and their output as tagged pseudo-messages in the transcript.
 */
function classifyUserText(text: string): UserTextEntry | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith(SHELL_PREAMBLE)) {
    const command = SHELL_COMMAND_RE.exec(trimmed)
    if (command) {
      const exit = SHELL_EXIT_RE.exec(trimmed)?.[1]
      return {
        kind: 'bash',
        command: command[1],
        stdout: SHELL_STDOUT_RE.exec(trimmed)?.[1] ?? '',
        stderr: SHELL_STDERR_RE.exec(trimmed)?.[1] ?? '',
        ...(exit !== undefined ? { exitCode: exit === 'killed' ? null : Number(exit) } : {})
      }
    }
  }
  const bash = BASH_INPUT_RE.exec(trimmed)
  if (bash) return { kind: 'bash', command: bash[1] }
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) {
    return { kind: 'bash-output', stdout: BASH_STDOUT_RE.exec(trimmed)?.[1] ?? '', stderr: BASH_STDERR_RE.exec(trimmed)?.[1] ?? '' }
  }
  if (INTERRUPT_RE.test(trimmed)) return { kind: 'notice', text: 'Interrupted' }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim()
    const name = command[1].trim()
    return { kind: 'user', text: args ? `${name} ${args}` : name }
  }
  const stdout = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/.exec(trimmed)
  if (stdout) {
    const body = withoutHookLines(stdout[1])
    return body ? { kind: 'notice', text: body } : null
  }
  if (META_TAG_RE.test(trimmed)) return null
  return { kind: 'user', text }
}

class Draft {
  items: ChatItem[]
  toolIndex: Record<string, number>
  openBlocks: Record<string, number>
  private copiedItems = false
  private copiedIndex = false
  private copiedBlocks = false

  /** `at`: when the event arrived; stamped on the rows it adds. */
  constructor(private readonly state: ChatState, private readonly idPrefix: string, private readonly at?: number) {
    this.items = state.items
    this.toolIndex = state.toolIndex
    this.openBlocks = state.openBlocks
  }

  private itemsMut(): ChatItem[] {
    if (!this.copiedItems) {
      this.items = this.items.slice()
      this.copiedItems = true
    }
    return this.items
  }

  private indexMut(): Record<string, number> {
    if (!this.copiedIndex) {
      this.toolIndex = { ...this.toolIndex }
      this.copiedIndex = true
    }
    return this.toolIndex
  }

  blocksMut(): Record<string, number> {
    if (!this.copiedBlocks) {
      this.openBlocks = { ...this.openBlocks }
      this.copiedBlocks = true
    }
    return this.openBlocks
  }

  nextId(hint?: string): string {
    return hint ?? `${this.idPrefix}${this.items.length}`
  }

  push(item: ChatItem): number {
    const items = this.itemsMut()
    items.push(this.at !== undefined && item.at === undefined ? { ...item, at: this.at } : item)
    const index = items.length - 1
    if (item.kind === 'tool') this.indexMut()[item.id] = index
    return index
  }

  update(index: number, patch: (item: ChatItem) => ChatItem): void {
    const current = this.items[index]
    if (!current) return
    const next = patch(current)
    if (next === current) return
    this.itemsMut()[index] = next
  }

  tool(id: string | undefined): number | undefined {
    return id === undefined ? undefined : this.toolIndex[id]
  }

  result(patch: Partial<ChatState>): ChatState {
    return {
      ...this.state,
      ...patch,
      items: this.items,
      toolIndex: this.toolIndex,
      openBlocks: this.openBlocks
    }
  }
}

function toolItem(block: Json, status: ChatToolStatus): ChatToolItem {
  const name = str(block.name) ?? 'tool'
  const input = clampInput(block.input)
  return {
    kind: 'tool',
    id: str(block.id) ?? '',
    name,
    label: summarizeTool(name, input),
    input,
    status
  }
}

function applyAssistantBlocks(draft: Draft, message: Json, parentToolUseId: string | null): void {
  const content = Array.isArray(message.content) ? message.content : []
  const messageId = str(message.id) ?? ''

  if (parentToolUseId) {
    // A subagent's own turn: only its tool calls surface, as progress on its Agent row.
    const parent = draft.tool(parentToolUseId)
    if (parent === undefined) return
    for (const raw of content) {
      const block = obj(raw)
      if (!block || block.type !== 'tool_use') continue
      const label = summarizeTool(str(block.name) ?? 'tool', block.input)
      draft.update(parent, (item) => item.kind === 'tool'
        ? { ...item, childCount: (item.childCount ?? 0) + 1, lastChild: label }
        : item)
    }
    return
  }

  for (const raw of content) {
    const block = obj(raw)
    if (!block) continue
    const type = str(block.type)
    if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
      const id = str(block.id)
      const existing = draft.tool(id)
      const fresh = toolItem(block, 'running')
      if (existing !== undefined) {
        draft.update(existing, (item) => item.kind === 'tool'
          ? { ...item, name: fresh.name, label: fresh.label, input: fresh.input, status: item.status === 'pending' ? 'running' : item.status }
          : item)
      } else {
        draft.push(fresh)
      }
      continue
    }
    if (type === 'text' || type === 'thinking') {
      const text = type === 'text' ? str(block.text) ?? '' : str(block.thinking) ?? ''
      // Match the block streamed for this message, if any: the final message is authoritative.
      const openKey = Object.keys(draft.openBlocks).find((key) => {
        if (!key.startsWith(`${messageId}:`)) return false
        const item = draft.items[draft.openBlocks[key]]
        return item?.kind === type
      })
      if (openKey !== undefined) {
        const index = draft.openBlocks[openKey]
        delete draft.blocksMut()[openKey]
        draft.update(index, (item) => (item.kind === 'text' || item.kind === 'thinking')
          ? { ...item, text: text || item.text, streaming: false }
          : item)
        continue
      }
      if (!text.trim()) continue
      draft.push(type === 'text'
        ? { kind: 'text', id: draft.nextId(), text }
        : { kind: 'thinking', id: draft.nextId(), text })
    }
  }
}

function applyStreamEvent(draft: Draft, event: Json, current: string): Partial<ChatState> {
  const type = str(event.type)
  if (type === 'message_start') {
    const messageId = str(obj(event.message)?.id)
    return messageId ? { streamMessage: messageId } : {}
  }
  if (type === 'content_block_start') {
    const block = obj(event.content_block)
    const index = typeof event.index === 'number' ? event.index : -1
    if (!block || index < 0) return {}
    const blockType = str(block.type)
    if (blockType === 'text' || blockType === 'thinking') {
      const at = draft.push(blockType === 'text'
        ? { kind: 'text', id: draft.nextId(), text: '', streaming: true }
        : { kind: 'thinking', id: draft.nextId(), text: '', streaming: true })
      draft.blocksMut()[`${current}:${index}`] = at
    } else if (blockType === 'tool_use' || blockType === 'server_tool_use') {
      const id = str(block.id)
      if (id && draft.tool(id) === undefined) draft.push(toolItem(block, 'pending'))
    }
    return {}
  }
  if (type === 'content_block_delta') {
    const delta = obj(event.delta)
    const index = typeof event.index === 'number' ? event.index : -1
    const at = draft.openBlocks[`${current}:${index}`]
    if (!delta || at === undefined) return {}
    const piece = delta.type === 'text_delta' ? str(delta.text)
      : delta.type === 'thinking_delta' ? str(delta.thinking)
        : undefined
    if (!piece) return {}
    draft.update(at, (item) => (item.kind === 'text' || item.kind === 'thinking')
      ? { ...item, text: item.text + piece }
      : item)
  }
  return {}
}

/** "Published <path> at https://claude.ai/artifact/… (Version 1, …)". */
const ARTIFACT_PUBLISHED = /^Published .+? at (https:\/\/claude\.ai\/\S+)/

/**
 * Where an Artifact call published, read from its result text. `meta` is the
 * message's structured result (live: `tool_use_result`, transcript:
 * `toolUseResult`), the only place the page's title shows up.
 */
function artifactOf(item: ChatToolItem, text: string, meta: Json | undefined): ChatToolItem['artifact'] {
  if (mcpArtifactCall(item.name)) return mcpArtifactOf(item, text)
  if (item.name !== 'Artifact') return undefined
  const url = ARTIFACT_PUBLISHED.exec(text)?.[1]
  if (!url) return undefined
  const title = (meta && str(meta.url) === url ? str(meta.title) : undefined) ?? str(item.input.title)
  return title ? { url, title } : { url }
}

/**
 * The claude-artifacts MCP server's publishing calls (`mcp__claude-artifacts__publish_files`
 * and friends): which one, or undefined for any other tool.
 */
export function mcpArtifactCall(name: string): 'publish_files' | 'publish_version' | 'edit_version' | undefined {
  const m = /^mcp__[^_]*artifacts[^_]*__(publish_files|publish_version|edit_version)$/i.exec(name)
  return m ? m[1] as 'publish_files' | 'publish_version' | 'edit_version' : undefined
}

/** The MCP server answers with the artifact as JSON: `{"url": "https://claude.ai/artifact/…", "title": …}`. */
function mcpArtifactOf(item: ChatToolItem, text: string): ChatToolItem['artifact'] {
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue
    let parsed: Json | undefined
    try { parsed = obj(JSON.parse(line)) } catch { continue }
    const url = str(parsed?.url)
    if (!url || !url.startsWith('https://claude.ai/')) continue
    const title = str(parsed?.title) ?? str(item.input.title)
    return title ? { url, title } : { url }
  }
  return undefined
}

function applyToolResults(draft: Draft, content: unknown[], meta?: Json): void {
  const results = content.filter((raw) => obj(raw)?.type === 'tool_result')
  for (const raw of results) {
    const block = obj(raw) as Json
    const index = draft.tool(str(block.tool_use_id))
    if (index === undefined) continue
    const isError = block.is_error === true
    const { text, images } = toolResultContent(block.content)
    draft.update(index, (item) => {
      if (item.kind !== 'tool') return item
      // The structured result is per message, so it only names a lone result.
      const artifact = isError ? undefined : artifactOf(item, text, results.length === 1 ? meta : undefined)
      return {
        ...item,
        status: item.status === 'denied' ? 'denied' : (isError ? 'error' : 'done'),
        result: truncate(text, RESULT_TEXT_LIMIT),
        ...(images.length > 0 ? { images } : {}),
        ...(artifact ? { artifact } : {})
      }
    })
  }
}

export interface ChatArtifact {
  url: string
  title: string
  description?: string
  /** The latest Artifact call that published it. */
  toolUseId: string
  /** How many times this session published it. */
  publishes: number
}

/** The pages this session published, latest first, one per URL. */
export function chatArtifacts(items: ChatItem[]): ChatArtifact[] {
  const byUrl = new Map<string, ChatArtifact>()
  for (const item of items) {
    if (item.kind !== 'tool' || !item.artifact) continue
    const { url } = item.artifact
    const prev = byUrl.get(url)
    const filePath = str(item.input.file_path)
    const title = item.artifact.title
      ?? prev?.title
      ?? (filePath ? filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') : undefined)
      ?? url
    byUrl.delete(url)
    byUrl.set(url, {
      url,
      title,
      description: str(item.input.description) ?? prev?.description,
      toolUseId: item.id,
      publishes: (prev?.publishes ?? 0) + 1
    })
  }
  return [...byUrl.values()].reverse()
}

/** A local file an Artifact publish sent: a path relative to `root`, then to the chat's directory. */
export interface ArtifactSource {
  from: string
  root?: string
  contentType?: string
  /** Text replacements claude.ai applied after the file was sent (MCP `edit_version`), in order. */
  edits?: { old: string; new: string }[]
}

/** A page published as text in the call itself (MCP `publish_version`): nothing on disk to show. */
const INLINE_PAGE: ArtifactSource = { from: '' }

/** Fold one claude-artifacts MCP call into the page and files; returns the new page. */
function foldMcpArtifactCall(
  call: 'publish_files' | 'publish_version' | 'edit_version',
  input: Record<string, unknown>,
  page: ArtifactSource | undefined,
  files: Record<string, ArtifactSource>
): ArtifactSource | undefined {
  if (call === 'publish_version') {
    for (const key of Object.keys(files)) delete files[key]
    return INLINE_PAGE
  }
  if (call === 'edit_version') {
    const edits = (Array.isArray(input.edits) ? input.edits : []).flatMap((raw) => {
      const e = obj(raw)
      const old = str(e?.old_text)
      return old ? [{ old, new: str(e?.new_text) ?? '' }] : []
    })
    const target = str(input.path)
    const key = target ? artifactPublishedPath(target) : undefined
    const source = !target || key === 'index.html' ? page : key ? files[key] : undefined
    if (!source || source === INLINE_PAGE || edits.length === 0) return page
    const edited = { ...source, edits: [...(source.edits ?? []), ...edits] }
    if (source === page) return edited
    if (key) files[key] = edited
    return page
  }
  if (input.mode === 'replace') {
    page = undefined
    for (const key of Object.keys(files)) delete files[key]
  }
  for (const removed of Array.isArray(input.remove) ? input.remove : []) {
    const key = typeof removed === 'string' ? artifactPublishedPath(removed) : undefined
    if (key) delete files[key]
  }
  for (const raw of Array.isArray(input.files) ? input.files : []) {
    const entry = obj(raw)
    const key = artifactPublishedPath(str(entry?.as) ?? '')
    const from = str(entry?.path)
    if (!key || !from) continue
    if (key === 'index.html') page = { from }
    else files[key] = { from }
  }
  return page
}

/** What a published page was made of on this machine, so it can be shown without claude.ai. */
export interface ArtifactSources {
  page: ArtifactSource
  /** Supporting files by published path (relative, no leading slash). */
  files: Record<string, ArtifactSource>
}

/** A published path as a page references it, or undefined when it could leave the page's folder. */
export function artifactPublishedPath(path: string): string | undefined {
  const clean = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!clean || clean.startsWith('/') || clean.split('/').some((part) => part === '..' || part === '')) return undefined
  return clean
}

/**
 * The local files behind a published page, folded over every Artifact call that
 * published to `url` (a later call replaces the page, adds or replaces files and
 * removes the ones it maps to null). An Error says why there is no local copy.
 */
export function artifactSources(items: ChatItem[], url: string): ArtifactSources | Error {
  let page: ArtifactSource | undefined
  let typed = false
  const files: Record<string, ArtifactSource> = {}
  for (const item of items) {
    if (item.kind !== 'tool' || item.artifact?.url !== url || item.input.asset === true) continue
    const { input } = item
    const mcp = mcpArtifactCall(item.name)
    if (mcp) {
      page = foldMcpArtifactCall(mcp, input, page, files)
      continue
    }
    const root = str(input.root)
    if (str(input.type_url)) typed = true
    const filePath = str(input.file_path)
    if (filePath) page = { from: filePath, ...(root ? { root } : {}) }
    const entries: [string, unknown][] = Array.isArray(input.files)
      ? input.files.map((entry): [string, unknown] => [str(obj(entry)?.path) ?? '', entry])
      : Object.entries(obj(input.files) ?? {})
    for (const [published, source] of entries) {
      const key = artifactPublishedPath(published)
      if (!key) continue
      const spec = obj(source)
      // Copied from another artifact on claude.ai's side: never on this machine.
      if (spec?.artifact !== undefined) {
        delete files[key]
        continue
      }
      const from = typeof source === 'string' ? source : str(spec?.from) ?? (Array.isArray(input.files) ? str(spec?.path) : undefined)
      if (!from) {
        // null removes it; a file copied from another artifact never was on this machine.
        delete files[key]
        continue
      }
      const contentType = str(spec?.contentType)
      files[key] = { from, ...(root ? { root } : {}), ...(contentType ? { contentType } : {}) }
    }
  }
  if (typed) return new Error('This artifact is built on a claude.ai type, so it only shows on claude.ai.')
  if (page === INLINE_PAGE) return new Error('Claude sent this page as text rather than from a file, so it only shows on claude.ai.')
  if (!page) return new Error('No local page for this artifact in this chat.')
  if (/\.(md|markdown)$/i.test(page.from)) return new Error('Markdown pages are rendered by claude.ai, so this one only shows there.')
  return { page, files }
}

function applyUserMessage(draft: Draft, m: Json, history: boolean): Partial<ChatState> {
  if (m.isMeta === true || m.isSynthetic === true) return {}
  const message = obj(m.message)
  if (!message) return {}
  if (m.parent_tool_use_id) return {}
  const content = message.content
  const uuid = str(m.uuid)

  // Our own send, echoed back once Claude takes it (--replay-user-messages).
  if (!history && m.isReplay === true && uuid) {
    const queued = draft.items.findIndex((item) => item.kind === 'user' && item.id === uuid)
    if (queued >= 0) {
      draft.update(queued, (item) => item.kind === 'user' ? { ...item, queued: false } : item)
      return { busy: true }
    }
  }

  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  applyToolResults(draft, blocks, obj(m.tool_use_result) ?? obj(m.toolUseResult))

  const texts: string[] = []
  let images = 0
  for (const raw of blocks) {
    const block = obj(raw)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') images++
  }
  if (texts.length === 0 && images === 0) return {}

  const shown = texts.map(classifyUserText).filter((entry): entry is UserTextEntry => entry !== null)
  // `!command`s ran before the message they rode along with.
  for (const entry of shown) {
    if (entry.kind === 'bash') {
      const { kind: _kind, ...fields } = entry
      draft.push({
        kind: 'bash',
        id: draft.nextId(),
        ...fields,
        ...(fields.stdout !== undefined ? { stdout: truncate(fields.stdout, RESULT_TEXT_LIMIT) } : {}),
        ...(fields.stderr !== undefined ? { stderr: truncate(fields.stderr, RESULT_TEXT_LIMIT) } : {})
      })
    } else if (entry.kind === 'bash-output') {
      let at = -1
      for (let i = draft.items.length - 1; i >= 0; i--) {
        const item = draft.items[i]
        if (item.kind === 'bash') {
          if (item.stdout === undefined && item.stderr === undefined) at = i
          break
        }
        if (item.kind === 'user') break
      }
      const output = { stdout: truncate(entry.stdout, RESULT_TEXT_LIMIT), stderr: truncate(entry.stderr, RESULT_TEXT_LIMIT) }
      if (at >= 0) draft.update(at, (item) => item.kind === 'bash' ? { ...item, ...output } : item)
      else draft.push({ kind: 'bash', id: draft.nextId(), command: '', ...output })
    }
  }
  const userText = shown.flatMap((entry) => entry.kind === 'user' ? [entry.text] : []).join('\n')
  if (userText || images > 0) {
    if (uuid && draft.items.some((item) => item.kind === 'user' && item.id === uuid)) return {}
    draft.push({ kind: 'user', id: uuid ?? draft.nextId(), text: userText, images })
  }
  for (const entry of shown) {
    if (entry.kind === 'notice') draft.push({ kind: 'notice', id: draft.nextId(), text: entry.text, tone: 'muted' })
  }
  return {}
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const STRING_FIELD = (key: string): RegExp => new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`)

/**
 * The phases a workflow script declares in its `meta` literal, so the row can
 * say "phase 1 of 3" before the later ones start. `task_started.prompt` carries
 * the script. Best effort: anything it can't read just leaves the list empty.
 */
export function declaredWorkflowPhases(script: string | undefined): ChatWorkflowPhase[] {
  if (!script) return []
  const metaAt = script.search(/export\s+const\s+meta\s*=/)
  if (metaAt < 0) return []
  const phasesAt = script.slice(metaAt).search(/\bphases\s*:\s*\[/)
  if (phasesAt < 0) return []
  const start = script.indexOf('[', metaAt + phasesAt)
  const end = script.indexOf(']', start)
  if (end < 0) return []
  const phases: ChatWorkflowPhase[] = []
  for (const match of script.slice(start + 1, end).matchAll(/\{([^{}]*)\}/g)) {
    const title = STRING_FIELD('title').exec(match[1])?.[2].replace(/\\(.)/g, '$1').trim()
    if (!title) continue
    const detail = STRING_FIELD('detail').exec(match[1])?.[2].replace(/\\(.)/g, '$1').trim()
    phases.push({ index: phases.length + 1, title, ...(detail ? { detail } : {}), started: false })
  }
  return phases
}

function workflowAgentState(state: unknown, startedAt: number | undefined): ChatWorkflowAgentState {
  switch (state) {
    case 'done': return 'done'
    case 'error':
    case 'failed': return 'failed'
    case 'skipped':
    case 'cancelled': return 'skipped'
    case 'start':
    case 'started':
    case 'starting':
    case 'queued': return startedAt === undefined ? 'queued' : 'running'
  }
  return 'running'
}

/**
 * Folds a `workflow_progress` snapshot (the run's `workflow_phase` and
 * `workflow_agent` entries, sent whole every few seconds) over what the row
 * already knows, keeping declared phases the run hasn't reached yet.
 */
export function foldWorkflowProgress(previous: ChatWorkflow | undefined, entries: unknown[]): ChatWorkflow {
  const phases = (previous?.phases ?? []).map((phase) => ({ ...phase }))
  const notePhase = (index: number | undefined, title: string | undefined): void => {
    if (index === undefined || !title) return
    const declared = phases.find((phase) => phase.title === title) ?? phases.find((phase) => phase.index === index && !phase.started)
    if (declared) {
      declared.index = index
      declared.title = title
      declared.started = true
    } else {
      phases.push({ index, title, started: true })
    }
  }
  const agents = new Map<number, ChatWorkflowAgent>()
  for (const raw of entries) {
    const entry = obj(raw)
    if (!entry) continue
    if (entry.type === 'workflow_phase') {
      notePhase(num(entry.index), str(entry.title)?.trim())
      continue
    }
    if (entry.type !== 'workflow_agent') continue
    const index = num(entry.index)
    if (index === undefined) continue
    const phaseIndex = num(entry.phaseIndex)
    notePhase(phaseIndex, str(entry.phaseTitle)?.trim())
    const startedAt = num(entry.startedAt)
    const attempt = num(entry.attempt)
    const lastTool = str(entry.lastToolSummary)?.trim() || str(entry.lastToolName)
    agents.set(index, {
      index,
      label: str(entry.label)?.trim() || `Agent ${index}`,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      state: workflowAgentState(entry.state, startedAt),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(num(entry.durationMs) !== undefined ? { durationMs: num(entry.durationMs) } : {}),
      ...(num(entry.tokens) !== undefined ? { tokens: num(entry.tokens) } : {}),
      ...(num(entry.toolCalls) !== undefined ? { toolCalls: num(entry.toolCalls) } : {}),
      ...(lastTool ? { lastTool } : {}),
      ...(attempt !== undefined && attempt > 1 ? { attempt } : {})
    })
  }
  // Phases are numbered by call order, so a declared one ahead of the run sorts by its slot.
  phases.sort((a, b) => a.index - b.index)
  return { phases, agents: [...agents.values()].sort((a, b) => a.index - b.index) }
}

function taskKind(taskType: string | undefined, toolName: string | undefined, agentType: string | undefined): ChatTaskKind {
  switch (taskType) {
    case 'local_agent':
    case 'remote_agent':
    case 'in_process_teammate':
      return 'subagent'
    case 'local_bash':
      return 'shell'
    case 'local_workflow':
      return 'workflow'
    case 'mcp_task':
      return 'mcp'
  }
  if (taskType?.startsWith('monitor')) return 'monitor'
  if (toolName === 'Agent' || toolName === 'Task' || agentType) return 'subagent'
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'shell'
  if (toolName === 'Monitor') return 'monitor'
  return 'other'
}

function isTaskDone(task: ChatTask): boolean {
  return task.status !== 'running'
}

/**
 * Tasks with finished ones past their linger dropped, so a long session's map
 * doesn't grow without end. `at` is the event's time; without one nothing ages.
 */
function pruneTasks(tasks: Record<string, ChatTask>, at: number | undefined): Record<string, ChatTask> {
  if (at === undefined) return tasks
  let out: Record<string, ChatTask> | null = null
  for (const [id, task] of Object.entries(tasks)) {
    if (!isTaskDone(task) || task.endedAt === undefined || task.endedAt + TASK_LINGER_MS >= at) continue
    out ??= { ...tasks }
    delete out[id]
  }
  return out ?? tasks
}

function finishTask(task: ChatTask, status: Exclude<ChatTaskStatus, 'running'>, at: number | undefined): ChatTask {
  return { ...task, status, endedAt: task.endedAt ?? at }
}

function applyTaskMessage(draft: Draft, state: ChatState, m: Json, subtype: string, at: number | undefined): Partial<ChatState> {
  const tasks = pruneTasks(state.tasks, at)
  const id = str(m.task_id)
  const existing = id ? tasks[id] : undefined
  const put = (task: ChatTask): Partial<ChatState> => ({ tasks: { ...tasks, [task.id]: task } })
  const drop = (): Partial<ChatState> => {
    if (!id || !existing) return tasks === state.tasks ? {} : { tasks }
    const next = { ...tasks }
    delete next[id]
    return { tasks: next }
  }
  const unchanged = (): Partial<ChatState> => tasks === state.tasks ? {} : { tasks }

  switch (subtype) {
    case 'task_started': {
      if (!id) return unchanged()
      if (m.ambient === true) return drop()
      const toolUseId = str(m.tool_use_id)
      const toolAt = draft.tool(toolUseId)
      const tool = toolAt === undefined ? undefined : draft.items[toolAt]
      const toolItem = tool?.kind === 'tool' ? tool : undefined
      const agentType = str(m.subagent_type) ?? str(toolItem?.input.subagent_type)
      const taskType = str(m.task_type)
      const kind = taskKind(taskType, toolItem?.name, agentType)
      const command = kind === 'shell' ? str(toolItem?.input.command) : undefined
      const workflow = str(m.workflow_name)
      const description = str(m.description)?.trim() || (workflow ? `Workflow ${workflow}` : '') || command || existing?.description || 'Task'
      const declared = kind === 'workflow' && !existing?.workflow ? declaredWorkflowPhases(str(m.prompt)) : []
      return put({
        ...existing,
        id,
        ...(toolUseId ? { toolUseId } : {}),
        kind,
        ...(taskType ? { taskType } : {}),
        description,
        ...(command ? { command } : {}),
        ...(agentType ? { agentType } : {}),
        background: m.is_backgrounded === true || existing?.background === true,
        ...(m.owned_by_subagent === true || existing?.nested ? { nested: true } : {}),
        ...(declared.length > 0 ? { workflow: { phases: declared, agents: [] } } : {}),
        // A resumed subagent registers again under its id: it runs anew.
        status: 'running',
        endedAt: undefined,
        startedAt: existing && existing.status === 'running' ? existing.startedAt ?? at : at
      })
    }
    case 'task_progress': {
      if (!existing) return unchanged()
      const usage = obj(m.usage)
      const summary = str(m.summary)?.trim()
      const lastTool = str(m.last_tool_name)
      return put({
        ...existing,
        toolUses: num(usage?.tool_uses) ?? existing.toolUses,
        tokens: num(usage?.total_tokens) ?? existing.tokens,
        ...(lastTool ? { lastTool } : {}),
        ...(summary ? { summary } : {}),
        // Only some progress frames carry the snapshot; the rest keep the last one.
        ...(Array.isArray(m.workflow_progress) ? { workflow: foldWorkflowProgress(existing.workflow, m.workflow_progress) } : {})
      })
    }
    case 'task_updated': {
      if (!existing) return unchanged()
      const patch = obj(m.patch) ?? {}
      let next: ChatTask = { ...existing }
      const description = str(patch.description)?.trim()
      if (description) next.description = description
      if (typeof patch.is_backgrounded === 'boolean') next.background = patch.is_backgrounded
      const endedAt = num(patch.end_time) ?? at
      switch (patch.status) {
        case 'completed': next = finishTask(next, 'completed', endedAt); break
        case 'failed': next = finishTask(next, 'failed', endedAt); break
        case 'killed': next = finishTask(next, 'stopped', endedAt); break
        case 'running':
        case 'pending':
        case 'paused':
          next = { ...next, status: 'running', endedAt: undefined }
          break
      }
      const error = str(patch.error)?.trim()
      if (error) next.summary = error
      return put(next)
    }
    case 'task_notification': {
      if (m.ambient === true) return drop()
      if (!existing) return unchanged()
      const status = m.status === 'failed' ? 'failed' : m.status === 'stopped' ? 'stopped' : 'completed'
      const usage = obj(m.usage)
      const summary = str(m.summary)?.trim()
      // The notification names the outcome, even after the level already ended it.
      return put({
        ...existing,
        status,
        endedAt: existing.endedAt ?? at,
        toolUses: num(usage?.tool_uses) ?? existing.toolUses,
        tokens: num(usage?.total_tokens) ?? existing.tokens,
        ...(summary ? { summary } : {})
      })
    }
    case 'background_tasks_changed': {
      // A level signal with replace semantics: the background tasks alive right now.
      const live = new Map<string, Json>()
      for (const raw of Array.isArray(m.tasks) ? m.tasks : []) {
        const entry = obj(raw)
        const taskId = str(entry?.task_id)
        if (entry && taskId) live.set(taskId, entry)
      }
      const next: Record<string, ChatTask> = {}
      for (const [taskId, task] of Object.entries(tasks)) {
        const entry = live.get(taskId)
        if (entry?.ambient === true) continue
        if (entry) {
          next[taskId] = task.status === 'running' && !task.background ? { ...task, background: true } : task
        } else if (task.background && task.status === 'running') {
          // Gone from the level without its bookend (yet): it ended somehow.
          next[taskId] = finishTask(task, 'completed', at)
        } else {
          next[taskId] = task
        }
      }
      for (const [taskId, entry] of live) {
        if (next[taskId] || tasks[taskId] || entry.ambient === true) continue
        const taskType = str(entry.task_type)
        next[taskId] = {
          id: taskId,
          kind: taskKind(taskType, undefined, undefined),
          ...(taskType ? { taskType } : {}),
          description: str(entry.description)?.trim() || 'Task',
          background: true,
          status: 'running',
          startedAt: at
        }
      }
      return { tasks: next }
    }
    default:
      return unchanged()
  }
}

/**
 * A finished background task's timeline line. A subagent's summary is its whole
 * report (Claude reads it and answers), so a multi-line one becomes the task's
 * name and outcome instead.
 */
function noticeLine(summary: string, task: ChatTask | undefined, status: unknown): string {
  if (!summary.includes('\n')) return summary
  const outcome = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'finished'
  return task ? `${task.description} ${outcome}` : firstLine(summary) ?? summary
}

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'])

function applySystemMessage(draft: Draft, state: ChatState, m: Json, history: boolean, at: number | undefined): Partial<ChatState> {
  const subtype = str(m.subtype)
  // Replayed history is over: none of its tasks run in this process.
  const taskPatch = !history && subtype && TASK_SUBTYPES.has(subtype) ? applyTaskMessage(draft, state, m, subtype, at) : {}
  switch (subtype) {
    case 'init':
      return {
        info: {
          ...state.info,
          sessionId: str(m.session_id) ?? state.info.sessionId,
          model: str(m.model) ?? state.info.model,
          permissionMode: str(m.permissionMode) ?? state.info.permissionMode,
          cwd: str(m.cwd) ?? state.info.cwd,
          claudeVersion: str(m.claude_code_version) ?? state.info.claudeVersion
        }
      }
    case 'status': {
      const mode = str(m.permissionMode)
      return {
        compacting: m.status === 'compacting',
        ...(mode ? { info: { ...state.info, permissionMode: mode } } : {})
      }
    }
    case 'compact_boundary':
      draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text: 'Context compacted', tone: 'muted' })
      return { compacting: false }
    case 'api_retry': {
      const attempt = typeof m.attempt === 'number' ? m.attempt : 0
      const max = typeof m.max_retries === 'number' ? m.max_retries : 0
      const status = typeof m.error_status === 'number' ? ` (${m.error_status})` : ''
      const text = `API error${status}, retrying ${attempt}/${max}…`
      const last = draft.items[draft.items.length - 1]
      if (last?.kind === 'notice' && last.text.startsWith('API error')) {
        draft.update(draft.items.length - 1, (item) => item.kind === 'notice' ? { ...item, text } : item)
      } else {
        draft.push({ kind: 'notice', id: draft.nextId(), text, tone: 'warning' })
      }
      return {}
    }
    case 'local_command_output': {
      const text = withoutHookLines(str(m.content) ?? '')
      if (text) draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text, tone: 'muted' })
      return {}
    }
    case 'informational': {
      const text = str(m.content)?.trim()
      if (text) {
        const tone = m.level === 'warning' ? 'warning' : 'muted'
        draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text, tone })
      }
      return {}
    }
    case 'permission_denied': {
      const index = draft.tool(str(m.tool_use_id))
      if (index !== undefined) {
        const reason = str(m.message)
        draft.update(index, (item) => item.kind === 'tool' ? { ...item, status: 'denied', result: reason ?? item.result } : item)
      }
      return {}
    }
    case 'task_notification': {
      const summary = str(m.summary)?.trim()
      // A foreground or subagent-owned task's summary is just its command line or
      // description, which its tool row already shows; only background work that
      // finished on its own gets a line.
      const taskId = str(m.task_id)
      const task = taskId ? state.tasks[taskId] : undefined
      const quiet = task !== undefined && (task.nested === true || !task.background)
      if (summary && m.skip_transcript !== true && !quiet) {
        const tone = m.status === 'failed' ? 'warning' : 'muted'
        draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text: noticeLine(summary, task, m.status), tone })
      }
      return taskPatch
    }
    default:
      return taskPatch
  }
}

/**
 * The turn ended, so a foreground task blocking one of its tool calls did too —
 * unless it was moved to the background. Tasks started from inside a subagent
 * (their tool call isn't a main-thread row) belong to that agent, not the turn.
 */
function endForegroundTasks(draft: Draft, tasks: Record<string, ChatTask>, interrupted: boolean, at: number | undefined): Record<string, ChatTask> {
  let out: Record<string, ChatTask> | null = null
  for (const [id, task] of Object.entries(tasks)) {
    if (task.status !== 'running' || task.background || draft.tool(task.toolUseId) === undefined) continue
    out ??= { ...tasks }
    out[id] = finishTask(task, interrupted ? 'stopped' : 'completed', at)
  }
  return out ?? tasks
}

function applyResult(draft: Draft, state: ChatState, m: Json, at: number | undefined): Partial<ChatState> {
  for (const key of Object.keys(draft.openBlocks)) {
    const index = draft.openBlocks[key]
    draft.update(index, (item) => (item.kind === 'text' || item.kind === 'thinking') ? { ...item, streaming: false } : item)
  }
  draft.openBlocks = {}
  // Tool rows still spinning belong to a turn that is over (interrupt, error).
  draft.items.forEach((item, index) => {
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'waiting')) {
      draft.update(index, (current) => current.kind === 'tool' ? { ...current, status: 'done' } : current)
    }
  })
  const subtype = str(m.subtype)
  let interrupted = state.interrupting === true
  if (subtype && subtype !== 'success') {
    const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : []
    const last = draft.items[draft.items.length - 1]
    interrupted = interrupted || errors.length === 0
      || errors.some((e) => /interrupt|abort/i.test(e))
      || (last?.kind === 'notice' && last.text === 'Interrupted')
    if (!interrupted) {
      draft.push({ kind: 'notice', id: draft.nextId(), text: errors.join('\n') || subtype.replace(/_/g, ' '), tone: 'error' })
    }
  } else if (m.is_error === true) {
    const text = str(m.result)?.trim()
    if (text) draft.push({ kind: 'notice', id: draft.nextId(), text, tone: 'error' })
  }
  const tasks = endForegroundTasks(draft, pruneTasks(state.tasks, at), interrupted, at)
  return { busy: false, turnStartedAt: undefined, compacting: false, interrupting: false, ...(tasks !== state.tasks ? { tasks } : {}) }
}

function applySdkMessage(state: ChatState, raw: unknown, at: number | undefined, history: boolean, draft: Draft): Partial<ChatState> {
  const m = obj(raw)
  if (!m) return {}
  switch (m.type) {
    case 'stream_event': {
      if (history || m.parent_tool_use_id) return {}
      const event = obj(m.event)
      const patch = event ? applyStreamEvent(draft, event, state.streamMessage ?? '') : {}
      return state.busy ? patch : { ...patch, busy: true, turnStartedAt: at ?? state.turnStartedAt }
    }
    case 'assistant': {
      const message = obj(m.message)
      if (message) applyAssistantBlocks(draft, message, str(m.parent_tool_use_id) ?? null)
      return history || state.busy ? {} : { busy: true, turnStartedAt: at ?? state.turnStartedAt }
    }
    case 'user':
      return applyUserMessage(draft, m, history)
    case 'system':
      return applySystemMessage(draft, state, m, history, at)
    case 'result':
      return history ? {} : applyResult(draft, state, m, at)
    default:
      return {}
  }
}

/** Row index by id: tools through the index, other rows by a scan from the end (recent rows change). */
function findItem(draft: Draft, id: string): number | undefined {
  const tool = draft.tool(id)
  if (tool !== undefined) return tool
  for (let index = draft.items.length - 1; index >= 0; index--) {
    if (draft.items[index].id === id) return index
  }
  return undefined
}

/** A row's status may not walk back from waiting-on-you to running while its prompt is open. */
function upsertItem(draft: Draft, state: ChatState, item: ChatItem): void {
  const index = findItem(draft, item.id)
  if (index === undefined) {
    draft.push(item)
    return
  }
  draft.update(index, (current) => {
    let next: ChatItem = current.at !== undefined && item.at === undefined ? { ...item, at: current.at } : item
    if (current.kind === 'tool' && next.kind === 'tool' && current.status === 'waiting'
      && (next.status === 'running' || next.status === 'pending')
      && state.pending.some((prompt) => prompt.toolUseId === item.id)) {
      next = { ...next, status: 'waiting' }
    }
    return next
  })
}

/** A turn ended: nothing streams on, and tools still spinning belong to a turn that is over. */
function settleTurn(draft: Draft): void {
  draft.items.forEach((item, index) => {
    if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
      draft.update(index, (current) => (current.kind === 'text' || current.kind === 'thinking') ? { ...current, streaming: false } : current)
    } else if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'waiting')) {
      draft.update(index, (current) => current.kind === 'tool' ? { ...current, status: 'done' } : current)
    }
  })
  draft.openBlocks = {}
}

/** Fold one event into the state. Pure: returns a new state, sharing what didn't change. */
export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.t) {
    case 'sdk': {
      if (obj(event.m)?.type === 'conversation_reset') {
        // /clear starts a new conversation in the same process; its tasks run on.
        return { ...emptyChatState(), process: state.process, info: state.info, models: state.models, commands: state.commands, usage: state.usage, tasks: state.tasks, login: state.login }
      }
      const draft = new Draft(state, `i${state.items.length}-`, event.at)
      return draft.result(applySdkMessage(state, event.m, event.at, false, draft))
    }
    case 'history': {
      let next = state
      for (const message of event.messages) {
        const draft = new Draft(next, `h${next.items.length}-`)
        const patch = applySdkMessage(next, message, undefined, true, draft)
        next = draft.result(patch)
      }
      // A history replay never leaves a turn open: whatever was running is over.
      const items = next.items.map((item) => item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')
        ? { ...item, status: 'done' as const }
        : item)
      return { ...next, items, busy: false, openBlocks: {} }
    }
    case 'sent': {
      const draft = new Draft(state, 's', event.at)
      draft.push({ kind: 'user', id: event.uuid, text: event.text, images: event.images, queued: true })
      return draft.result({ busy: true, turnStartedAt: state.busy ? state.turnStartedAt : (event.at ?? Date.now()), coldCache: undefined })
    }
    case 'prompt': {
      if (state.pending.some((prompt) => prompt.id === event.prompt.id)) return state
      const draft = new Draft(state, 'p')
      const index = draft.tool(event.prompt.toolUseId)
      if (index !== undefined) draft.update(index, (item) => item.kind === 'tool' ? { ...item, status: 'waiting' } : item)
      return draft.result({ pending: [...state.pending, event.prompt] })
    }
    case 'prompt-done': {
      const prompt = state.pending.find((p) => p.id === event.id)
      if (!prompt) return state
      const draft = new Draft(state, 'p')
      const index = draft.tool(prompt.toolUseId)
      if (index !== undefined) {
        draft.update(index, (item) => item.kind === 'tool'
          ? { ...item, status: event.allowed ? 'running' : 'denied' }
          : item)
      }
      return draft.result({ pending: state.pending.filter((p) => p.id !== event.id) })
    }
    case 'process': {
      if (event.state !== 'exited') {
        // A (re)started CLI has none of the old process's tasks, and reports new ones itself.
        return {
          ...state,
          process: event.state,
          processError: event.state === 'starting' ? undefined : state.processError,
          ...(event.state === 'starting' ? { tasks: {} } : {})
        }
      }
      // The process took its open prompts and unconsumed messages with it.
      const draft = new Draft(state, 'x')
      draft.items.forEach((item, index) => {
        if (item.kind === 'user' && item.queued) {
          draft.update(index, (current) => current.kind === 'user' ? { ...current, queued: false, failed: true } : current)
        }
        if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'waiting')) {
          draft.update(index, (current) => current.kind === 'tool' ? { ...current, status: 'error' } : current)
        }
        if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
          draft.update(index, (current) => (current.kind === 'text' || current.kind === 'thinking') ? { ...current, streaming: false } : current)
        }
      })
      if (event.error) draft.push({ kind: 'notice', id: draft.nextId(), text: event.error, tone: 'error' })
      draft.openBlocks = {}
      // Its tasks died with it.
      const tasks: Record<string, ChatTask> = {}
      for (const [id, task] of Object.entries(state.tasks)) {
        tasks[id] = task.status === 'running' ? finishTask(task, 'stopped', event.at) : task
      }
      return draft.result({
        process: 'exited',
        processError: event.error,
        busy: false,
        turnStartedAt: undefined,
        compacting: false,
        pending: [],
        tasks
      })
    }
    case 'notice': {
      const draft = new Draft(state, 'n')
      draft.push({ kind: 'notice', id: draft.nextId(), text: event.text, tone: event.tone })
      return draft.result({})
    }
    case 'meta':
      return {
        ...state,
        ...(event.models ? { models: event.models } : {}),
        ...(event.commands ? { commands: event.commands } : {}),
        ...(event.info ? { info: { ...state.info, ...event.info } } : {}),
        ...(event.usage ? { usage: { ...state.usage, ...event.usage } } : {})
      }
    case 'cold-cache':
      // A process restarted by a send resumes with the message already on its way.
      return state.busy ? state : { ...state, coldCache: event.cache }
    case 'interrupting':
      return state.busy ? { ...state, interrupting: true } : state
    case 'reset':
      return { ...emptyChatState(), models: state.models, commands: state.commands, usage: state.usage, login: state.login }
    case 'login': {
      if (event.login) return { ...state, login: event.login }
      if (!state.login) return state
      const { login: _login, ...rest } = state
      return rest
    }
    case 'item': {
      const draft = new Draft(state, 'a', event.at)
      upsertItem(draft, state, event.item)
      return draft.result({})
    }
    case 'delta': {
      const draft = new Draft(state, 'a', event.at)
      const index = findItem(draft, event.id)
      if (index === undefined) {
        draft.push({ kind: event.kind, id: event.id, text: event.text, streaming: true })
      } else {
        draft.update(index, (item) => (item.kind === 'text' || item.kind === 'thinking') ? { ...item, text: item.text + event.text, streaming: true } : item)
      }
      return draft.result(state.busy ? {} : { busy: true, turnStartedAt: event.at ?? state.turnStartedAt })
    }
    case 'turn': {
      if (event.state === 'start') {
        return state.busy ? state : { ...state, busy: true, turnStartedAt: event.at ?? Date.now() }
      }
      const draft = new Draft(state, 'a', event.at)
      settleTurn(draft)
      const interrupted = event.interrupted === true || state.interrupting === true
      if (interrupted) draft.push({ kind: 'notice', id: draft.nextId(), text: 'Interrupted', tone: 'muted' })
      else if (event.error) draft.push({ kind: 'notice', id: draft.nextId(), text: event.error, tone: 'error' })
      return draft.result({ busy: false, turnStartedAt: undefined, compacting: false, interrupting: false })
    }
    case 'delivered': {
      const index = state.items.findIndex((item) => item.kind === 'user' && item.queued === true && (event.uuid === undefined || item.id === event.uuid))
      if (index < 0) return state
      const draft = new Draft(state, 'a')
      draft.update(index, (item) => item.kind === 'user' ? { ...item, queued: false } : item)
      return draft.result({})
    }
    case 'restore': {
      if (state.items.length > 0 || event.items.length === 0) return state
      const draft = new Draft(state, 'h')
      for (const item of event.items) draft.push(item)
      settleTurn(draft)
      return draft.result({})
    }
    case 'bash': {
      const draft = new Draft(state, 'b')
      draft.push({ kind: 'bash', id: event.id, command: event.command, running: true })
      return draft.result({})
    }
    case 'bash-done':
    case 'bash-sent': {
      const ids = event.t === 'bash-done' ? [event.id] : event.ids
      const draft = new Draft(state, 'b')
      draft.items.forEach((item, index) => {
        if (item.kind !== 'bash' || !ids.includes(item.id)) return
        draft.update(index, (current) => {
          if (current.kind !== 'bash') return current
          if (event.t === 'bash-sent') return { ...current, pendingContext: false }
          return {
            ...current,
            running: false,
            stdout: truncate(event.stdout, RESULT_TEXT_LIMIT),
            stderr: truncate(event.stderr, RESULT_TEXT_LIMIT),
            exitCode: event.exitCode,
            pendingContext: true
          }
        })
      })
      return draft.result({})
    }
  }
}

/** The picker row for the model a session reports (an alias, or a dated wire id). */
export function findModelOption(models: ChatModelOption[], model: string | undefined): ChatModelOption | undefined {
  if (!model) return undefined
  const base = model.replace(/\[.*\]$/, '')
  return models.find((m) => m.value === model)
    ?? models.find((m) => m.resolvedModel && (model === m.resolvedModel || model.startsWith(`${m.resolvedModel}-`) || base === m.resolvedModel.replace(/\[.*\]$/, '')))
    ?? models.find((m) => m.value !== 'default' && base.includes(`-${m.value.replace(/\[.*\]$/, '')}-`))
}

/** Which kind of prompt a `canUseTool` call is, from the tool it is about. */
export function promptKindFor(toolName: string): ChatPromptKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'permission'
}

/** The composer's effort levels when the model doesn't list its own. */
export const CHAT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export const CHAT_PERMISSION_MODES = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass' }
] as const

export type ChatPermissionMode = typeof CHAT_PERMISSION_MODES[number]['value']

/**
 * Codex's sandbox and approval policy as one picker, after its own `/approvals`
 * presets. Approvals reach the tab as permission cards.
 */
export const CODEX_CHAT_MODES = [
  { value: 'read-only', label: 'Read only', description: 'Read files and answer; ask before any edit or command that changes something' },
  { value: 'ask', label: 'Ask', description: 'Work in the project folder; ask before going outside it or using the network' },
  { value: 'auto', label: 'Auto', description: 'Work in the project folder without asking' },
  { value: 'full-access', label: 'Full access', description: 'No sandbox and no questions — everything is allowed' }
] as const

export type CodexChatMode = typeof CODEX_CHAT_MODES[number]['value']
export const DEFAULT_CODEX_MODE: CodexChatMode = 'ask'

export function isCodexChatMode(value: unknown): value is CodexChatMode {
  return CODEX_CHAT_MODES.some((mode) => mode.value === value)
}

/** The Codex thread settings a mode stands for. */
export function codexModePolicy(mode: string | undefined): { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy: 'on-request' | 'never' } {
  switch (mode) {
    case 'read-only': return { sandbox: 'read-only', approvalPolicy: 'on-request' }
    case 'auto': return { sandbox: 'workspace-write', approvalPolicy: 'never' }
    case 'full-access': return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    default: return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  }
}

/** Pi's thinking levels (`set_thinking_level`), for models that list none of their own. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** What each agent's chat can do; the Claude-only parts of the tab hide for the others. */
export interface ChatAgentFeatures {
  /** The agent's name in the tab ("Message Codex…"). */
  label: string
  /** The composer's mode picker, or none. */
  modes: readonly { value: string; label: string; description?: string }[]
  /** `/btw` side questions. */
  sideQuestion: boolean
  /** `/login` and `/logout` through the CLI. */
  login: boolean
  /** The `/permissions` rules editor. */
  permissionsEditor: boolean
  /** Background tasks (subagents, shells) with Stop and Background. */
  tasks: boolean
  /** "Allow, switch to Auto" on a permission card. */
  autoOffer: boolean
}

export const CHAT_AGENT_FEATURES: Record<ChatAgent, ChatAgentFeatures> = {
  claude: { label: 'Claude', modes: CHAT_PERMISSION_MODES, sideQuestion: true, login: true, permissionsEditor: true, tasks: true, autoOffer: true },
  codex: { label: 'Codex', modes: CODEX_CHAT_MODES, sideQuestion: false, login: false, permissionsEditor: false, tasks: false, autoOffer: false },
  pi: { label: 'Pi', modes: [], sideQuestion: false, login: false, permissionsEditor: false, tasks: false, autoOffer: false }
}

export function chatAgentFeatures(agent: ChatAgent | undefined): ChatAgentFeatures {
  return CHAT_AGENT_FEATURES[agent ?? 'claude']
}

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return CHAT_PERMISSION_MODES.some((mode) => mode.value === value)
}

/**
 * `/btw`: a quick question answered from the conversation so far, without joining
 * it. The CLI doesn't list it (it's a terminal-UI command); the chat tab runs it
 * through the SDK's side-question request instead.
 */
export const SIDE_QUESTION_COMMAND: ChatCommand = {
  name: 'btw',
  description: 'Ask a quick side question — the answer stays out of the conversation',
  argumentHint: '<question>'
}

/** The question in `/btw <question>`; '' for a bare `/btw`, null for anything else. */
export function parseSideQuestion(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? (match[1] ?? '').trim() : null
}

export interface ChatSideAnswer {
  /** Null when the CLI had nothing to say (e.g. the question was cancelled). */
  response: string | null
  /** The CLI made up the answer itself (an error or refusal), not the model. */
  synthetic?: boolean
}

/** `/permissions`: the CLI's dialog is terminal UI; the chat tab has its own rules editor. */
export const PERMISSIONS_COMMAND: ChatCommand = {
  name: 'permissions',
  description: 'View and edit allow, ask and deny rules'
}

/** `/login` and `/logout`: the chat tab runs `claude auth` itself. */
export const LOGIN_COMMAND: ChatCommand = {
  name: 'login',
  description: 'Sign in to your Anthropic account',
  argumentHint: '[console|sso]'
}

export const LOGOUT_COMMAND: ChatCommand = {
  name: 'logout',
  description: 'Sign out from your Anthropic account'
}

/** The method in `/login [console|sso]`, or null for anything else. */
export function parseLoginCommand(text: string): ChatLoginMethod | null {
  const match = /^\/login(?:\s+(\S+))?\s*$/i.exec(text.trim())
  if (!match) return null
  const arg = match[1]?.toLowerCase()
  if (arg === 'console' || arg === 'sso') return arg
  return 'claudeai'
}

/** Built-in commands that only make sense in the terminal UI. */
export const TERMINAL_ONLY_COMMANDS = new Set([
  'config', 'settings', 'theme', 'terminal-setup', 'vim', 'doctor', 'ide',
  'install-github-app', 'permissions', 'hooks', 'agents', 'mcp', 'plugin', 'resume', 'status',
  'statusline', 'upgrade', 'exit', 'quit', 'rewind', 'export', 'memory', 'privacy-settings'
])

/**
 * The composer's `/` menu: the CLI doesn't list /btw, /permissions, /login or
 * /logout to SDK clients, so the chat tab adds them (it runs them itself), then
 * what the CLI reported. Codex and Pi chats list only their own commands.
 */
export function composerCommands(commands: ChatCommand[], agent: ChatAgent = 'claude'): ChatCommand[] {
  if (agent !== 'claude') return commands
  const own = [SIDE_QUESTION_COMMAND, PERMISSIONS_COMMAND, LOGIN_COMMAND, LOGOUT_COMMAND].filter((command) => !commands.some((c) => c.name === command.name))
  return own.length > 0 ? [...own, ...commands] : commands
}
