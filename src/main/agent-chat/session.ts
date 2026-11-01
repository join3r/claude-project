import { spawn, type ChildProcess } from 'child_process'
import type { ChatEvent, ChatImage, ChatPrompt, ChatPromptResponse, ChatSideAnswer } from '../../shared/claude-chat'

/**
 * One chat tab's agent process, whichever agent it is. `ChatSession` (Claude,
 * through the Agent SDK), `CodexChatSession` (`codex app-server`) and
 * `PiChatSession` (`pi --mode rpc`) all speak it, so `ClaudeChatManager` runs
 * every chat tab the same way.
 */
export interface AgentChatSession {
  start(): Promise<void>
  /** Queue a user message; `context` is text that goes ahead of it (the `!command`s run since the last one). */
  send(text: string, images?: ChatImage[], context?: string[]): string
  interrupt(): Promise<void>
  askSideQuestion(question: string): Promise<ChatSideAnswer>
  stopTask(taskId: string): Promise<boolean>
  backgroundTask(toolUseId: string): Promise<boolean>
  /** Answer a held prompt. False when it is no longer open. */
  respond(promptId: string, response: ChatPromptResponse): boolean
  setModel(model: string | undefined): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setEffort(effort: string | undefined): Promise<void>
  isEnded(): boolean
  close(): void
}

/** What the Codex and Pi sessions are started with. */
export interface AgentSessionOptions {
  cwd: string
  sessionId: string
  /** The CLI to run, already resolved. */
  executable: string
  env: Record<string, string | undefined>
  /** The project's extra CLI args for this agent, split. */
  extraArgs?: string[]
  model?: string
  permissionMode?: string
  effort?: string
  /** Windows: a `.cmd` shim runs through cmd.exe. */
  wrap?: (file: string, args: string[]) => { file: string; args: string[] }
  onEvent: (event: ChatEvent) => void
  onHook: (body: Record<string, unknown>) => void
  onPromptResolved: (prompt: ChatPrompt, allowed: boolean) => void
  onExit: (error?: string) => void
  log: (message: string) => void
  /** Tests swap the process. */
  spawnProcess?: (file: string, args: string[], cwd: string, env: Record<string, string | undefined>) => ChildProcess
}

/**
 * Splits a byte stream into JSON records on LF only. Pi's RPC docs require it
 * (`readline` also splits on U+2028/U+2029, which JSON strings may contain); it
 * suits Codex's JSON-RPC lines just as well. Lines that aren't JSON go to `onJunk`.
 */
export class JsonlReader {
  private buffer = ''

  constructor(private readonly onRecord: (record: unknown) => void, private readonly onJunk: (line: string) => void = () => {}) {}

  push(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        this.onJunk(line)
        continue
      }
      this.onRecord(record)
    }
  }
}

export interface JsonlChild {
  write(record: unknown): void
  kill(): void
}

/**
 * Start an agent CLI that talks JSON lines over stdio. `onExit` fires once, with
 * the stderr tail when the process failed to start or died on its own.
 */
export function spawnJsonl(
  options: AgentSessionOptions,
  args: string[],
  handlers: { onRecord: (record: unknown) => void; onExit: (error?: string) => void }
): JsonlChild {
  const argv = options.wrap ? options.wrap(options.executable, args) : { file: options.executable, args }
  const child = options.spawnProcess
    ? options.spawnProcess(argv.file, argv.args, options.cwd, options.env)
    : spawn(argv.file, argv.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  let exited = false
  let killed = false
  const exit = (error?: string): void => {
    if (exited) return
    exited = true
    handlers.onExit(error)
  }
  const reader = new JsonlReader(handlers.onRecord, (line) => options.log(`agentChat junk=${JSON.stringify(line.slice(0, 200))}`))
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => reader.push(chunk))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
  child.stdin?.on('error', () => { /* the exit handler reports it */ })
  child.on('error', (err) => exit(err.message))
  child.on('close', (code, signal) => {
    if (killed) return exit()
    const tail = stderr.trim().split('\n').slice(-6).join('\n')
    exit(code === 0 && !signal ? undefined : `${options.executable} exited with ${code ?? signal}${tail ? `\n${tail}` : ''}`)
  })
  return {
    write(record) {
      if (exited || !child.stdin?.writable) return
      child.stdin.write(`${JSON.stringify(record)}\n`)
    },
    kill() {
      killed = true
      try { child.kill() } catch { /* already gone */ }
    }
  }
}

/** The `!command` context and the message as one text input. */
export function withContext(text: string, context: string[]): string {
  return context.length === 0 ? text : [...context, text].filter(Boolean).join('\n\n')
}
