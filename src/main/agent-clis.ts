import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { AI_TAB_TYPES, type AiTabType, type AppConfig } from '../shared/types'
import { agentCliCommand, versionFrom, type AgentCliStatus, type AgentClisReport } from '../shared/agent-clis'
import { agentCommandOverride, resolveAgentCommand } from './resolve-agent-command'

/** How long one `<cli> --version` may take before it counts as found without a version. */
const VERSION_TIMEOUT_MS = 5000

export interface AgentClisDeps {
  /** The login env (its PATH is where agent tabs find their CLI). */
  env: NodeJS.ProcessEnv
  /** Settings → AI Tools overrides (`claudeCommand`, …). */
  config: Pick<AppConfig, 'claudeCommand' | 'codexCommand' | 'piCommand'>
  platform?: NodeJS.Platform
  /** An executable regular file. */
  isExecutable?: (file: string) => boolean
  /** `<file> --version`'s output, or null when it failed or took too long. */
  runVersion?: (file: string, env: NodeJS.ProcessEnv) => Promise<string | null>
}

function nodeIsExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function nodeRunVersion(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(null)
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

/**
 * Where `command` is: itself when it is a path, else the first executable of
 * that name on `env.PATH` (Windows: through `resolveAgentCommand`, which knows
 * PATHEXT and npm's shims). Null when it isn't there.
 */
export function findAgentCli(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = nodeIsExecutable
): string | null {
  const requested = command.trim()
  if (!requested) return null
  if (platform === 'win32') {
    try {
      return resolveAgentCommand(requested, { platform, env, existsSync: isExecutable })
    } catch {
      return null
    }
  }
  if (requested.includes('/')) return isExecutable(requested) ? requested : null
  for (const dir of (env.PATH ?? '').split(path.posix.delimiter)) {
    if (!dir) continue
    const candidate = path.posix.join(dir, requested)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * `claude`, `codex` and `pi` on this host: found or not on the login PATH (or
 * at the path Settings names), and the version each reports. The version
 * calls run side by side, so one slow CLI costs at most a few seconds.
 */
export async function detectAgentClis(deps: AgentClisDeps, now: () => number = Date.now): Promise<AgentClisReport> {
  const platform = deps.platform ?? process.platform
  const isExecutable = deps.isExecutable ?? nodeIsExecutable
  const runVersion = deps.runVersion ?? nodeRunVersion
  const entries = await Promise.all(AI_TAB_TYPES.map(async (agent): Promise<[AiTabType, AgentCliStatus]> => {
    const command = agentCommandOverride(agentCliCommand(agent), deps.config).trim() || agentCliCommand(agent)
    const found = findAgentCli(command, deps.env, platform, isExecutable)
    if (!found) return [agent, { found: false }]
    // A Windows `.cmd` shim needs cmd.exe to run; it is there, which is what counts.
    const output = /\.(cmd|bat)$/i.test(found) ? null : await runVersion(found, deps.env)
    const version = output ? versionFrom(output) : null
    return [agent, { found: true, path: found, ...(version ? { version } : {}) }]
  }))
  return {
    clis: Object.fromEntries(entries) as Record<AiTabType, AgentCliStatus>,
    platform,
    checkedAt: now()
  }
}
