import type { SshConfig } from '../../shared/types'
import {
  bashContextBlocks,
  emptyChatState,
  isChatPermissionMode,
  reduceChat,
  type ChatEvent,
  type ChatImage,
  type ChatLogin,
  type ChatLoginMethod,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatSideAnswer,
  type ChatSnapshot,
  type ChatState
} from '../../shared/claude-chat'
import { randomUUID } from 'crypto'
import { ChatSession } from './chat-session'
import { runBash, type BashSpawn } from './bash-mode'
import { accountFromStatus, loginArgs, loginUrlFrom, outputTail, startLogin, type LoginRun } from './auth'
import { createRemoteSpawner, type RemoteCommand } from './remote-spawn'
import { readLocalTranscript, readRemoteTranscript, SESSION_ID_RE } from './transcript'

/** What a window tells main about the chat tab it mounts. */
export interface ChatTabConfig {
  /** Local dir, or the remote dir for an ssh project. */
  cwd: string
  sessionId: string
  projectId?: string
  sshConfig?: SshConfig
  /** The project's extra Claude CLI args, already split. */
  extraArgs?: string[]
}

export interface ChatManagerDeps {
  sendToClient: (clientId: string, channel: string, ...args: unknown[]) => void
  /** The local `claude` to run (Settings override, else PATH). */
  resolveLocalClaude: () => string
  /** Env for a local `claude`: the login shell's, as terminal tabs get. */
  localEnv: () => Record<string, string | undefined>
  /** Make sure the project's ssh master is up. */
  ensureSsh: (projectId: string, sshConfig: SshConfig) => Promise<void>
  /** argv for a non-tty `claude` on the project's host, through the master socket. */
  remoteCommand: (projectId: string, sshConfig: SshConfig, cwd: string, claudeArgs: string[], env: Record<string, string>) => RemoteCommand
  /** How to run a `!command` for this tab: its shell, locally or on the project's host. */
  bashSpawn: (config: ChatTabConfig, command: string) => BashSpawn
  /** How to run `claude <args>` outside the session (`claude auth …`), locally or on the project's host. */
  claudeSpawn: (config: ChatTabConfig, args: string[]) => BashSpawn
  /** Run a script on the project's host and return stdout. */
  remoteExec: (projectId: string, sshConfig: SshConfig, script: string) => Promise<string>
  /** A hook payload from the session, for the status/activity pipeline. */
  onHook: (tabId: string, body: Record<string, unknown>) => void
  onPromptResolved: (tabId: string, prompt: ChatPrompt, allowed: boolean) => void
  /** The process started or ended (liveness, status). */
  onProcessChange: (tabId: string, running: boolean, error?: string) => void
  log: (message: string) => void
}

/** `claude auth login` turning down a pasted code (it then waits for another). */
const LOGIN_REJECTED_RE = /invalid|error|fail|expired/i

/**
 * A non-window subscriber (the mobile bridge): called after every event, with the
 * state already folded. `state` is the runtime's own (treat it as read-only).
 */
export type ChatListener = (seq: number, event: ChatEvent, state: ChatState) => void

/** Every chat's events, whether or not anything attached (the mobile push emitter). */
export type ChatWatcher = (tabId: string, event: ChatEvent, state: ChatState) => void

interface ChatRuntime {
  tabId: string
  config: ChatTabConfig
  state: ChatState
  seq: number
  /** Clients (windows) mounting the tab. */
  attached: Set<string>
  listeners: Set<ChatListener>
  session: ChatSession | null
  /** History loaded (or being loaded); later attaches wait on it. */
  ready: Promise<void>
  /** The transcript exists on disk, so a (re)start resumes rather than creates. */
  hasTranscript: boolean
  model?: string
  permissionMode?: string
  effort?: string
  /** Finished `!command`s whose output goes to Claude with the next message. */
  bashContext: { id: string; blocks: string[] }[]
  /** `/login` running `claude auth login`. */
  loginRun?: LoginRun
  /** Its output so far, and how long that was when the last code went in. */
  loginOutput?: () => string
  loginMark?: number
}

/**
 * Chat tabs' processes, owned by main like PTYs: one per tab, shared by every
 * window that mounts it, kept running while the tab is hidden or its window is
 * gone, and ended only when the tab is closed, converted or the app quits.
 *
 * Main keeps each tab's folded {@link ChatState}; `attach` returns it as a
 * snapshot tagged with a sequence number, and every later event goes out with
 * the next one, so a window can apply events without ever double-counting.
 */
export class ClaudeChatManager {
  private readonly runtimes = new Map<string, ChatRuntime>()
  private readonly watchers = new Set<ChatWatcher>()

  constructor(private readonly deps: ChatManagerDeps) {}

  async attach(clientId: string, tabId: string, config: ChatTabConfig): Promise<ChatSnapshot> {
    const runtime = this.runtimeFor(tabId, config)
    runtime.attached.add(clientId)
    return this.ready(runtime)
  }

  /**
   * Attach a non-window subscriber, the way a window attaches: the runtime is created
   * from `config` (loading history, starting the process) if the tab has none yet.
   * The listener sees every event from now on; call the returned function to stop.
   * Removing the last listener never stops the process, as a window detaching doesn't.
   */
  async listen(tabId: string, config: ChatTabConfig, listener: ChatListener): Promise<{ snapshot: ChatSnapshot; stop: () => void }> {
    const runtime = this.runtimeFor(tabId, config)
    runtime.listeners.add(listener)
    const stop = (): void => {
      runtime.listeners.delete(listener)
    }
    try {
      return { snapshot: await this.ready(runtime), stop }
    } catch (err) {
      stop()
      throw err
    }
  }

  /** The folded state so far, or null when the tab has no runtime. */
  /** See every chat's events from now on; call the returned function to stop. */
  watch(watcher: ChatWatcher): () => void {
    this.watchers.add(watcher)
    return () => { this.watchers.delete(watcher) }
  }

  snapshot(tabId: string): ChatSnapshot | null {
    const runtime = this.runtimes.get(tabId)
    return runtime ? { seq: runtime.seq, state: runtime.state } : null
  }

  private runtimeFor(tabId: string, config: ChatTabConfig): ChatRuntime {
    let runtime = this.runtimes.get(tabId)
    if (!runtime) {
      runtime = this.createRuntime(tabId, config)
    } else if (runtime.session === null || runtime.session.isEnded()) {
      // A dead process is restarted on the next send; keep config fresh for it.
      runtime.config = config
    }
    return runtime
  }

  private async ready(runtime: ChatRuntime): Promise<ChatSnapshot> {
    await runtime.ready
    if (!runtime.session || runtime.session.isEnded()) {
      if (runtime.state.process === 'idle') void this.startSession(runtime)
    }
    return { seq: runtime.seq, state: runtime.state }
  }

  detach(clientId: string, tabId: string): void {
    this.runtimes.get(tabId)?.attached.delete(clientId)
  }

  detachClient(clientId: string): void {
    for (const runtime of this.runtimes.values()) runtime.attached.delete(clientId)
  }

  attachedClients(tabId: string): Set<string> | undefined {
    return this.runtimes.get(tabId)?.attached
  }

  has(tabId: string): boolean {
    return this.runtimes.has(tabId)
  }

  liveTabIds(): string[] {
    const ids: string[] = []
    for (const runtime of this.runtimes.values()) {
      if (runtime.session && !runtime.session.isEnded()) ids.push(runtime.tabId)
    }
    return ids
  }

  async send(tabId: string, text: string, images: ChatImage[] = []): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    if (!runtime.session || runtime.session.isEnded()) await this.startSession(runtime)
    if (!runtime.session) return
    const context = runtime.bashContext
    runtime.bashContext = []
    runtime.session.send(text, images, context.flatMap((entry) => entry.blocks))
    if (context.length > 0) this.emit(runtime, { t: 'bash-sent', ids: context.map((entry) => entry.id) })
    runtime.hasTranscript = true
  }

  /**
   * `!command`: run it in the project's shell, show it in the timeline, and hand
   * command and output to Claude with the next message — the CLI's bash mode, which
   * doesn't start a turn of its own.
   */
  async runBash(tabId: string, command: string): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    const id = `bash-${randomUUID()}`
    this.emit(runtime, { t: 'bash', id, command, at: Date.now() })
    const { config } = runtime
    if (config.sshConfig && config.projectId) {
      try {
        await this.deps.ensureSsh(config.projectId, config.sshConfig)
      } catch (err) {
        this.emit(runtime, { t: 'bash-done', id, stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: null })
        return
      }
    }
    const result = await runBash(this.deps.bashSpawn(config, command))
    this.deps.log(`chatBash tab=${tabId} exit=${result.exitCode}`)
    if (this.runtimes.get(tabId) !== runtime) return
    runtime.bashContext.push({ id, blocks: bashContextBlocks(command, result.stdout, result.stderr, result.exitCode) })
    this.emit(runtime, { t: 'bash-done', id, ...result })
  }

  /**
   * `/login`: run `claude auth login` where this tab's `claude` runs, show its
   * progress as the tab's `login`, then restart an idle process so it signs in
   * with the new account. A second `/login` replaces the first.
   */
  async login(tabId: string, method: ChatLoginMethod): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    this.endLogin(runtime)
    const { config } = runtime
    const remote = !!(config.sshConfig && config.projectId)
    const login: ChatLogin = { status: 'running', method, ...(remote ? { remote: true } : {}) }
    this.emit(runtime, { t: 'login', login })
    if (config.sshConfig && config.projectId) {
      try {
        await this.deps.ensureSsh(config.projectId, config.sshConfig)
      } catch (err) {
        this.emit(runtime, { t: 'login', login: { ...login, status: 'failed', error: err instanceof Error ? err.message : String(err) } })
        return
      }
    }
    // What the CLI has printed so far, and how much of it was there when a code went in.
    let output = ''
    const update = (patch: Partial<ChatLogin>): void => {
      const current = runtime.state.login
      if (current) this.emit(runtime, { t: 'login', login: { ...current, ...patch } })
    }
    const run: LoginRun = startLogin(this.deps.claudeSpawn(config, loginArgs(method)), (text) => {
      output = text
      if (runtime.loginRun !== run) return
      const current = runtime.state.login
      if (!current) return
      if (!current.url) {
        const url = loginUrlFrom(text)
        if (url) update({ url })
        return
      }
      // A bad code: the CLI says so and waits for another.
      const reply = current.status === 'verifying' ? text.slice(runtime.loginMark ?? text.length) : ''
      if (LOGIN_REJECTED_RE.test(reply)) update({ status: 'running', error: outputTail(reply, 2) })
    })
    runtime.loginRun = run
    runtime.loginOutput = () => output
    const result = await run.done
    this.deps.log(`chatLogin tab=${tabId} method=${method} ok=${result.ok}`)
    if (runtime.loginRun !== run || this.runtimes.get(tabId) !== runtime) return
    runtime.loginRun = undefined
    if (!result.ok) {
      update({ status: 'failed', error: outputTail(result.output) || 'Sign-in failed.' })
      return
    }
    const status = await runBash(this.deps.claudeSpawn(config, ['auth', 'status', '--json']))
    if (this.runtimes.get(tabId) !== runtime) return
    const account = accountFromStatus(status.stdout)
    const { error: _error, ...done } = runtime.state.login ?? login
    this.emit(runtime, { t: 'login', login: { ...done, status: 'done', ...(account ? { account } : {}) } })
    this.restartForAuth(runtime)
  }

  /** The code the sign-in page showed, for a running `/login`. */
  submitLoginCode(tabId: string, code: string): void {
    const runtime = this.runtimes.get(tabId)
    const login = runtime?.state.login
    if (!runtime?.loginRun || !login || login.status !== 'running') return
    runtime.loginMark = runtime.loginOutput?.().length
    runtime.loginRun.submitCode(code)
    const { error: _error, ...rest } = login
    this.emit(runtime, { t: 'login', login: { ...rest, status: 'verifying' } })
  }

  /** Stop a running `/login`, or dismiss a finished one. */
  dismissLogin(tabId: string): void {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    this.endLogin(runtime)
    this.emit(runtime, { t: 'login', login: null })
  }

  /** `/logout`: `claude auth logout` where this tab's `claude` runs. */
  async logout(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    this.endLogin(runtime)
    if (runtime.state.login) this.emit(runtime, { t: 'login', login: null })
    const { config } = runtime
    if (config.sshConfig && config.projectId) await this.deps.ensureSsh(config.projectId, config.sshConfig)
    const result = await runBash(this.deps.claudeSpawn(config, ['auth', 'logout']))
    this.deps.log(`chatLogout tab=${tabId} exit=${result.exitCode}`)
    if (this.runtimes.get(tabId) !== runtime) return
    if (result.exitCode !== 0) {
      this.emit(runtime, { t: 'notice', text: `Couldn't sign out: ${outputTail(result.stderr || result.stdout) || 'claude auth logout failed.'}`, tone: 'error' })
      return
    }
    this.emit(runtime, { t: 'notice', text: 'Signed out. Use /login to sign in again.', tone: 'muted' })
    this.restartForAuth(runtime)
  }

  private endLogin(runtime: ChatRuntime): void {
    const run = runtime.loginRun
    runtime.loginRun = undefined
    runtime.loginOutput = undefined
    runtime.loginMark = undefined
    run?.cancel()
  }

  /**
   * A running `claude` keeps the credentials it started with: restart it, resuming
   * the conversation. Mid-turn it is left alone; the next process picks them up.
   */
  private restartForAuth(runtime: ChatRuntime): void {
    if (!runtime.session || runtime.session.isEnded() || runtime.state.busy) return
    runtime.session.close()
    void this.startSession(runtime)
  }

  async interrupt(tabId: string): Promise<void> {
    await this.runtimes.get(tabId)?.session?.interrupt()
  }

  /** `/btw`. Starts (resuming) the process when it isn't running, like a send does. */
  async askSideQuestion(tabId: string, question: string): Promise<ChatSideAnswer> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    if (!runtime.session || runtime.session.isEnded()) await this.startSession(runtime)
    if (!runtime.session) throw new Error('Claude is not running.')
    return runtime.session.askSideQuestion(question)
  }

  /** Stop one of the tab's tasks. False (with a notice in the timeline) when it couldn't. */
  async stopTask(tabId: string, taskId: string): Promise<boolean> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return false
    if (!runtime.session || runtime.session.isEnded()) {
      this.emit(runtime, { t: 'notice', text: "Couldn't stop the task: Claude is not running.", tone: 'warning' })
      return false
    }
    return runtime.session.stopTask(taskId)
  }

  /** Send the foreground task a tool call started to the background. */
  async backgroundTask(tabId: string, toolUseId: string): Promise<boolean> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return false
    if (!runtime.session || runtime.session.isEnded()) {
      this.emit(runtime, { t: 'notice', text: "Couldn't send the task to the background: Claude is not running.", tone: 'warning' })
      return false
    }
    return runtime.session.backgroundTask(toolUseId)
  }

  respond(tabId: string, promptId: string, response: ChatPromptResponse): boolean {
    const runtime = this.runtimes.get(tabId)
    const answered = runtime?.session?.respond(promptId, response) ?? false
    // A restarted process keeps the mode the answer switched to.
    if (answered && runtime && response.behavior === 'allow' && isChatPermissionMode(response.mode)) runtime.permissionMode = response.mode
    return answered
  }

  async setModel(tabId: string, model: string | undefined): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.model = model
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setModel(model)
    else this.emit(runtime, { t: 'meta', info: { model, modelPicked: model !== undefined } })
  }

  async setPermissionMode(tabId: string, mode: string): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.permissionMode = mode
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setPermissionMode(mode)
    else this.emit(runtime, { t: 'meta', info: { permissionMode: mode } })
  }

  async setEffort(tabId: string, effort: string | undefined): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.effort = effort
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setEffort(effort)
    else this.emit(runtime, { t: 'meta', info: { effort } })
  }

  /** End the process but keep the timeline (e.g. before the tab turns into a terminal). */
  stop(tabId: string): void {
    this.runtimes.get(tabId)?.session?.close()
  }

  /** The tab is gone: end the process and forget everything. */
  close(tabId: string): void {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    this.endLogin(runtime)
    runtime.session?.close()
    this.runtimes.delete(tabId)
  }

  closeAll(): void {
    for (const tabId of [...this.runtimes.keys()]) this.close(tabId)
  }

  private createRuntime(tabId: string, config: ChatTabConfig): ChatRuntime {
    const runtime: ChatRuntime = {
      tabId,
      config,
      state: emptyChatState(),
      seq: 0,
      attached: new Set(),
      listeners: new Set(),
      session: null,
      ready: Promise.resolve(),
      hasTranscript: false,
      bashContext: []
    }
    runtime.ready = this.loadHistory(runtime)
    this.runtimes.set(tabId, runtime)
    return runtime
  }

  private async loadHistory(runtime: ChatRuntime): Promise<void> {
    const { sessionId, cwd, projectId, sshConfig } = runtime.config
    if (!SESSION_ID_RE.test(sessionId)) return
    try {
      let messages: unknown[]
      if (sshConfig && projectId) {
        await this.deps.ensureSsh(projectId, sshConfig)
        messages = await readRemoteTranscript(sessionId, (script) => this.deps.remoteExec(projectId, sshConfig, script))
      } else {
        messages = await readLocalTranscript(sessionId, cwd)
      }
      runtime.hasTranscript = messages.length > 0
      if (messages.length > 0) this.emit(runtime, { t: 'history', messages })
      this.deps.log(`chatHistory tab=${runtime.tabId} messages=${messages.length}`)
    } catch (err) {
      this.deps.log(`chatHistory tab=${runtime.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      this.emit(runtime, { t: 'notice', text: `Couldn't load this conversation's history: ${err instanceof Error ? err.message : String(err)}`, tone: 'warning' })
    }
  }

  private async startSession(runtime: ChatRuntime): Promise<void> {
    if (runtime.session && !runtime.session.isEnded()) return
    const { tabId, config } = runtime
    const remote = config.sshConfig && config.projectId ? { projectId: config.projectId, sshConfig: config.sshConfig } : null
    let session: ChatSession | null = null
    const onEvent = (event: ChatEvent): void => {
      if (runtime.session !== session) return
      this.emit(runtime, event)
    }

    let spawn: ConstructorParameters<typeof ChatSession>[0]['spawn']
    let env: Record<string, string | undefined>
    let executable: string
    if (remote) {
      // The ssh master may be reconnecting; one attempt, then the send fails visibly.
      await this.deps.ensureSsh(remote.projectId, remote.sshConfig)
      env = { ...process.env }
      executable = 'claude'
      spawn = createRemoteSpawner(
        (claudeArgs, addedEnv) => this.deps.remoteCommand(remote.projectId, remote.sshConfig, config.cwd, claudeArgs, addedEnv),
        env,
        {
          onStderr: (text) => session?.captureStderr(text),
          onDropped: (line) => this.deps.log(`chatRemote dropped tab=${tabId} line=${JSON.stringify(line.slice(0, 200))}`),
          onSpawn: (command) => this.deps.log(`chatRemote spawn tab=${tabId} file=${command.file}`)
        }
      )
    } else {
      env = this.deps.localEnv()
      executable = this.deps.resolveLocalClaude()
    }

    session = new ChatSession({
      cwd: config.cwd,
      sessionId: config.sessionId,
      resume: runtime.hasTranscript,
      executable,
      env,
      extraArgs: config.extraArgs,
      model: runtime.model,
      permissionMode: runtime.permissionMode,
      effort: runtime.effort,
      spawn,
      onEvent,
      onHook: (body) => {
        if (runtime.session === session) this.deps.onHook(tabId, body)
      },
      onPromptResolved: (prompt, allowed) => {
        if (runtime.session === session) this.deps.onPromptResolved(tabId, prompt, allowed)
      },
      onExit: (error) => {
        if (runtime.session !== session) return
        this.deps.log(`chatExit tab=${tabId}${error ? ` error=${JSON.stringify(error.slice(0, 300))}` : ''}`)
        this.deps.onProcessChange(tabId, false, error)
      },
      log: this.deps.log
    })
    runtime.session = session
    this.deps.log(`chatStart tab=${tabId} resume=${runtime.hasTranscript} remote=${remote ? 'yes' : 'no'} exe=${executable}`)
    this.deps.onProcessChange(tabId, true)
    try {
      await session.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit(runtime, { t: 'process', state: 'exited', at: Date.now(), error: `Couldn't start Claude: ${message}` })
      runtime.session = null
      this.deps.onProcessChange(tabId, false, message)
    }
  }

  private emit(runtime: ChatRuntime, event: ChatEvent): void {
    runtime.state = reduceChat(runtime.state, event)
    runtime.seq += 1
    for (const clientId of runtime.attached) {
      this.deps.sendToClient(clientId, 'chat-event', runtime.tabId, runtime.seq, event)
    }
    for (const listener of runtime.listeners) {
      try {
        listener(runtime.seq, event, runtime.state)
      } catch (err) {
        this.deps.log(`chatListener tab=${runtime.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const watcher of this.watchers) {
      try {
        watcher(runtime.tabId, event, runtime.state)
      } catch (err) {
        this.deps.log(`chatWatcher tab=${runtime.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
