import { spawn } from 'child_process'

/** Past this the suggestion gives up: the agent reads a few files and scripts, which takes seconds. */
export const RUN_COMMAND_SUGGEST_TIMEOUT_MS = 180_000

/** At most this many come back; the rest are dropped. */
const MAX_COMMANDS = 10
const NAME_MAX = 40
const COMMAND_MAX = 500

export interface SuggestedRunCommand {
  name: string
  command: string
}

export type RunCommandSuggestResult =
  | { ok: true; commands: SuggestedRunCommand[] }
  | { ok: false; error: string }

export interface RunCommandSuggestRequest {
  /** The folder the commands will run in: main's, a stream's worktree. */
  dir: string
  /** Commands set already where they're being edited (the draft rows). */
  current: SuggestedRunCommand[]
  /** For a stream: the project's commands, which it gets unless it replaces them. */
  inherited?: SuggestedRunCommand[]
}

export interface RunCommandSuggesterDeps {
  /** The user's own `claude`, as chat tabs run it. */
  executable: () => string
  env: () => Record<string, string | undefined>
  log: (message: string) => void
}

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, command: { type: 'string' } },
        required: ['name', 'command']
      }
    }
  },
  required: ['commands']
})

const SYSTEM_PROMPT = [
  'You set up the buttons a developer clicks to work with the project in a folder: install, run, and the other jobs the project really has, such as test, build, install the app locally, release or deploy.',
  'Look before you answer: package.json scripts, lockfiles, Makefile, justfile, Taskfile, Procfile, docker-compose, pyproject, Cargo.toml, README, CLAUDE.md and AGENTS.md, and the folders that hold the project\'s own scripts and procedures (scripts/, bin/, tools/, deploy/, .claude/skills/, .github/workflows/), plus deploy config such as fly.toml, vercel.json, netlify.toml, wrangler.toml or Dockerfile.',
  'When the project has its own script for a job, call that script (./scripts/install.sh, make deploy) instead of rebuilding its steps by hand, and read it first to learn what it does and name it after that: a script that builds the app and copies it into /Applications installs the app, it does not install dependencies.',
  'Suggest a deploy, release or publish command only when the project shows how it is done (a script, a make target, a package script, a documented procedure in README, CLAUDE.md or a skill, a deploy tool config). Never make one up. These are buttons the developer presses on purpose and checks before saving, so do include them when they exist.',
  'Each command is one shell command line run with sh -c in that folder: no comments, no line breaks; join steps with &&.',
  'Names are short and lowercase and say what the button does: install first when dependencies need installing, then run, then the others (test, build, install app, deploy, deploy (staging), release). Only the command named run is the app\'s main run button: never give that name to anything that deploys, releases or installs.',
  'Use the package manager the lockfile says. Never suggest commands that delete data, rewrite git history or put secrets on the command line; a deploy script that reads its own credentials is fine.',
  'Reply with the commands as the JSON schema asks, nothing else.'
].join(' ')

function listText(list: SuggestedRunCommand[]): string {
  return list.map(c => `- ${c.name}: ${c.command}`).join('\n')
}

/** The user message: what is set already, and for a stream what it gets from the project. */
export function suggestPrompt(request: RunCommandSuggestRequest): string {
  const parts = ['Suggest the commands for this folder: install and run, and the other jobs this project has its own way of doing (its scripts, deploys, releases).']
  if (request.inherited) {
    parts.push(
      request.inherited.length > 0
        ? `This folder is one branch of the project. It already gets these project commands:\n${listText(request.inherited)}\nSuggest only commands this branch needs differently (same name to replace one) or in addition. Reply with an empty list when the project's commands fit.`
        : 'This folder is one branch of the project, which has no commands yet.'
    )
  }
  if (request.current.length > 0) {
    parts.push(`Already set here (keep a name to change its command, drop nothing on purpose):\n${listText(request.current)}`)
  }
  return parts.join('\n\n')
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** The agent's commands, cleaned: one line each, named, no duplicate names, within limits. Null when unusable. */
export function parseSuggestedCommands(value: unknown): SuggestedRunCommand[] | null {
  const list = (value && typeof value === 'object' ? (value as { commands?: unknown }).commands : undefined)
  if (!Array.isArray(list)) return null
  const out: SuggestedRunCommand[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { name, command } = item as { name?: unknown; command?: unknown }
    if (typeof name !== 'string' || typeof command !== 'string') continue
    const cleanName = oneLine(name).slice(0, NAME_MAX)
    const cleanCommand = oneLine(command)
    if (!cleanName || !cleanCommand || cleanCommand.length > COMMAND_MAX) continue
    const key = cleanName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: cleanName, command: cleanCommand })
    if (out.length === MAX_COMMANDS) break
  }
  return out
}

/** `claude -p --output-format json`'s reply: its `structured_output`, else the `result` text read as JSON. */
export function parseSuggestReply(stdout: string): SuggestedRunCommand[] | null {
  let reply: { structured_output?: unknown; result?: unknown; is_error?: unknown }
  try {
    reply = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!reply || typeof reply !== 'object' || reply.is_error === true) return null
  if (reply.structured_output !== undefined) return parseSuggestedCommands(reply.structured_output)
  if (typeof reply.result !== 'string') return null
  const start = reply.result.indexOf('{')
  const end = reply.result.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return parseSuggestedCommands(JSON.parse(reply.result.slice(start, end + 1)))
  } catch {
    return null
  }
}

/**
 * Install and run commands for a folder from the user's `claude`: one `claude -p`
 * in that folder that can only read (Read, Glob, Grep: nothing it runs), with no
 * settings (so no hooks), no MCP servers and no saved session. Nothing is saved
 * here: the user checks the commands in the editor first, since DevTool runs them.
 */
export function suggestRunCommands(
  request: RunCommandSuggestRequest,
  deps: RunCommandSuggesterDeps,
  timeoutMs = RUN_COMMAND_SUGGEST_TIMEOUT_MS
): Promise<RunCommandSuggestResult> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (result: RunCommandSuggestResult, why?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (why) deps.log(`runCommandSuggest failed: ${why}`)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(deps.executable(), [
        '-p', '--model', 'sonnet', '--no-session-persistence',
        '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep',
        '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
        '--append-system-prompt', SYSTEM_PROMPT,
        '--output-format', 'json', '--json-schema', SCHEMA
      ], {
        cwd: request.dir,
        env: deps.env() as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      finish({ ok: false, error: `Couldn't start claude: ${message}` }, message)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: 'Claude took too long' }, 'timed out')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', (err) => finish({ ok: false, error: `Couldn't start claude: ${err.message}` }, err.message))
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: 'Claude failed to suggest commands' }, `exit ${code}`)
      const commands = parseSuggestReply(out)
      if (!commands) return finish({ ok: false, error: 'Claude gave no usable commands' }, `unusable reply ${JSON.stringify(out.slice(0, 200))}`)
      finish({ ok: true, commands })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(suggestPrompt(request))
  })
}
