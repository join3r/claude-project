import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { SshConfig } from '../../shared/types'
import type { ClaudeChatManager } from '../claude-chat/chat-manager'
import { readPermissionSettings, updatePermissionRule } from '../claude-chat/permission-settings'
import { PERMISSION_BEHAVIORS } from '../../shared/chat-permissions'
import type { CodexSessionManager } from '../codex-session-manager'
import type { HookInjector } from '../hook-injector'
import { spawnCdCommand, type SshConnectionManager } from '../ssh-connection-manager'
import type { IpcRegistrar } from './registrar'
import {
  chatImages,
  chatPromptResponse,
  chatTaskArgs,
  chatTabConfig,
  optSafeId,
  optSshConfig,
  optStr,
  safeId,
  sshConfig,
  str,
  stringList
} from './schemas'
import { v } from './validate'
import { buildRemoteSessionCopyScript, copyLocalSession } from '../agent-session-move'

const execFileAsync = promisify(execFile)

/** Claude derives a project's session dir name by replacing non-alphanumerics with '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Session ids are UUID-ish; anything else never names a session file (and never reaches a shell). */
export function isClaudeSessionId(sessionId: string): boolean {
  return /^[0-9a-fA-F-]{8,64}$/.test(sessionId)
}

export function localClaudeSessionExists(cwd: string, sessionId: string, homeDir: string = os.homedir()): boolean {
  const projectsDir = path.join(homeDir, '.claude', 'projects')
  const fileName = `${sessionId}.jsonl`
  if (fs.existsSync(path.join(projectsDir, claudeProjectSlug(cwd), fileName))) return true
  // Fallback sweep across all projects in case the slug derivation ever
  // diverges from Claude's — a hit anywhere preserves the resume attempt.
  try {
    return fs.readdirSync(projectsDir).some(dir => fs.existsSync(path.join(projectsDir, dir, fileName)))
  } catch {
    return false
  }
}

export interface AgentDeps {
  sshManager: () => SshConnectionManager
  hookInjector: () => HookInjector
  codexSessionManager: CodexSessionManager
  chatManager: () => ClaudeChatManager
  ensureSshConnected: (projectId: string, sshConfig: SshConfig) => Promise<void>
  cleanupRemoteHooks: (projectId: string, sshConfig: SshConfig, remoteDir: string | undefined, tabId: string) => Promise<void>
  /** Drop a tab's agent activity and tell every window. */
  forgetActivity: (tabId: string) => void
  /** Throws unless `dir` is a known local project/workspace directory. */
  assertAllowedDirectory: (dir: string) => Promise<string>
}

/** Files the chat composer's @-mention offers: git's view (tracked + untracked, not ignored). */
async function listChatFiles(deps: AgentDeps, cwd: string, projectId?: string, config?: SshConfig): Promise<string[]> {
  const script = 'git ls-files --cached --others --exclude-standard 2>/dev/null | head -20000'
  try {
    if (config && projectId) {
      await deps.ensureSshConnected(projectId, config)
      const manager = deps.sshManager()
      const { stdout } = await execFileAsync(manager.getSshCommand(), [
        '-S', manager.getSocketPath(projectId),
        `${config.username}@${config.host}`,
        `${spawnCdCommand(cwd || config.remoteDir)} && ${script}`
      ], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })
      return stdout.split('\n').filter(Boolean)
    }
    const allowed = await deps.assertAllowedDirectory(cwd)
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: allowed, timeout: 10_000, maxBuffer: 64 * 1024 * 1024
    })
    return stdout.split('\n').filter(Boolean).slice(0, 20_000)
  } catch {
    return []
  }
}

/** Hook injection, Codex/Claude session lookups and Claude chat tabs. */
export function registerAgentHandlers(ipc: IpcRegistrar, deps: AgentDeps): void {
  ipc.handle('hooks-inject', [v.string({ nonEmpty: true }), safeId], async (_event, projectDir, tabId) => {
    // Writes `.claude/settings.local.json` into the directory: only into ones the user configured.
    await deps.assertAllowedDirectory(projectDir)
    deps.hookInjector().inject(projectDir, tabId)
  })
  // Release is owner-tracked in HookInjector: an unknown dir/tab pair is a no-op.
  ipc.handle('hooks-cleanup', [str, safeId], (_event, projectDir, tabId) => {
    deps.hookInjector().cleanup(projectDir, tabId)
  })
  ipc.handle('hooks-cleanup-remote', [safeId, sshConfig, optStr, safeId], (_event, projectId, config, remoteDir, tabId) =>
    deps.cleanupRemoteHooks(projectId, config, remoteDir, tabId))

  ipc.handle(
    'codex-read-session',
    [str, v.optional(v.number()), optSafeId, optSshConfig],
    async (_event, cwd, afterTs, projectId, config) => {
      if (!config || !projectId) {
        return { sessionId: await deps.codexSessionManager.readLatestSessionId(cwd, afterTs) }
      }

      const manager = deps.sshManager()
      if (manager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      const readScript = deps.codexSessionManager.buildRemoteReadSessionScript(cwd, afterTs)
      const sshArgs = [
        '-S', manager.getSocketPath(projectId),
        `${config.username}@${config.host}`,
        readScript
      ]

      try {
        const { stdout } = await execFileAsync(manager.getSshCommand(), sshArgs, { timeout: 5000 })
        return JSON.parse(stdout.trim()) as { sessionId: string | null }
      } catch (error) {
        throw new Error(`Failed to read Codex session: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
  )

  // Claude prunes old sessions (and never persists sessions that got no user
  // message), so a stored sessionId can go stale; spawning `claude --resume`
  // with it dies with "No conversation found". The renderer checks here first
  // and starts fresh when the session file is gone.
  ipc.handle('claude-session-exists', [str, str, optSafeId, optSshConfig], async (_event, cwd, sessionId, projectId, config) => {
    if (!isClaudeSessionId(sessionId)) return false

    if (!config || !projectId) return localClaudeSessionExists(cwd, sessionId)

    const manager = deps.sshManager()
    if (manager.getStatus(projectId) !== 'connected') {
      throw new Error('SSH connection not established')
    }
    const sshArgs = [
      '-S', manager.getSocketPath(projectId),
      `${config.username}@${config.host}`,
      `ls "$HOME"/.claude/projects/*/${sessionId}.jsonl >/dev/null 2>&1 && echo yes || echo no`
    ]
    const { stdout } = await execFileAsync(manager.getSshCommand(), sshArgs, { timeout: 5000 })
    return stdout.trim() === 'yes'
  })

  // A task moving to another worktree: copy its Claude/Pi sessions into the new
  // directory's session folder (so the restart resumes them) and say which of the
  // given directories exist there (terminals opened on a sub-folder follow it).
  ipc.handle(
    'task-move-prepare',
    [
      v.string({ nonEmpty: true }),
      v.string({ nonEmpty: true }),
      v.array(v.object({ kind: v.literal('claude', 'pi'), sessionId: v.string({ nonEmpty: true, max: 64 }) })),
      stringList,
      optSafeId,
      optSshConfig
    ],
    async (_event, fromDir, toDir, sessions, dirs, projectId, config): Promise<{ dirsExist: boolean[] }> => {
      if (!config || !projectId) {
        for (const session of sessions) {
          try {
            copyLocalSession(session, fromDir, toDir)
          } catch {
            // Best effort: the agent then starts a new session, as before.
          }
        }
        return { dirsExist: dirs.map(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) }
      }
      await deps.ensureSshConnected(projectId, config)
      const manager = deps.sshManager()
      try {
        const { stdout } = await execFileAsync(manager.getSshCommand(), [
          '-S', manager.getSocketPath(projectId),
          `${config.username}@${config.host}`,
          buildRemoteSessionCopyScript(sessions, fromDir, toDir, dirs)
        ], { timeout: 15_000 })
        const flags = stdout.split('\n').map(line => line.trim()).filter(line => line === '0' || line === '1')
        return { dirsExist: dirs.map((_dir, i) => flags[i] === '1') }
      } catch {
        return { dirsExist: dirs.map(() => false) }
      }
    }
  )

  ipc.handle('chat-attach', [safeId, chatTabConfig], (ctx, tabId, config) =>
    deps.chatManager().attach(ctx.clientId, tabId, config))
  ipc.on('chat-detach', [safeId], (ctx, tabId) => {
    deps.chatManager().detach(ctx.clientId, tabId)
  })
  ipc.handle('chat-send', [safeId, str, chatImages], (_event, tabId, text, images) =>
    deps.chatManager().send(tabId, text, images ?? []))
  ipc.handle('chat-bash', [safeId, v.string({ nonEmpty: true, max: 20_000 })], (_event, tabId, command) =>
    deps.chatManager().runBash(tabId, command))
  ipc.handle('chat-login', [safeId, v.literal('claudeai', 'console', 'sso')], (_event, tabId, method) =>
    deps.chatManager().login(tabId, method))
  ipc.handle('chat-login-code', [safeId, v.string({ nonEmpty: true, max: 4_000 })], (_event, tabId, code) =>
    deps.chatManager().submitLoginCode(tabId, code))
  ipc.handle('chat-login-dismiss', [safeId], (_event, tabId) => deps.chatManager().dismissLogin(tabId))
  ipc.handle('chat-logout', [safeId], (_event, tabId) => deps.chatManager().logout(tabId))
  ipc.handle('chat-side-question', [safeId, v.string({ nonEmpty: true, max: 20_000 })], (_event, tabId, question) =>
    deps.chatManager().askSideQuestion(tabId, question))
  ipc.handle('chat-interrupt', [safeId], (_event, tabId) => deps.chatManager().interrupt(tabId))
  ipc.handle('chat-stop-task', chatTaskArgs, (_event, tabId, taskId) => deps.chatManager().stopTask(tabId, taskId))
  ipc.handle('chat-background-task', chatTaskArgs, (_event, tabId, toolUseId) =>
    deps.chatManager().backgroundTask(tabId, toolUseId))
  ipc.handle('chat-respond', [safeId, v.string({ nonEmpty: true }), chatPromptResponse], (_event, tabId, promptId, response) =>
    deps.chatManager().respond(tabId, promptId, response))
  ipc.handle('chat-set-model', [safeId, optStr], (_event, tabId, model) => deps.chatManager().setModel(tabId, model))
  ipc.handle('chat-set-mode', [safeId, str], (_event, tabId, mode) => deps.chatManager().setPermissionMode(tabId, mode))
  ipc.handle('chat-set-effort', [safeId, optStr], (_event, tabId, effort) => deps.chatManager().setEffort(tabId, effort))
  // Stop keeps the timeline (a tab turning into a terminal); close forgets the tab.
  ipc.handle('chat-stop', [safeId], (_event, tabId) => deps.chatManager().stop(tabId))
  ipc.on('chat-close', [safeId], (_event, tabId) => {
    deps.chatManager().close(tabId)
    deps.forgetActivity(tabId)
  })
  ipc.handle('chat-list-files', [str, optSafeId, optSshConfig], (_event, cwd, projectId, config) =>
    listChatFiles(deps, cwd, projectId, config))
  // `/permissions`: the project's settings files are only reachable for directories the user configured.
  ipc.handle('chat-permissions-read', [v.string({ nonEmpty: true })], async (_event, cwd) =>
    readPermissionSettings(await deps.assertAllowedDirectory(cwd)))
  ipc.handle('chat-permissions-update', [
    v.string({ nonEmpty: true }),
    v.literal('localSettings', 'projectSettings', 'userSettings'),
    v.literal(...PERMISSION_BEHAVIORS),
    v.string({ nonEmpty: true, max: 2000 }),
    v.literal('add', 'remove')
  ], async (_event, cwd, kind, behavior, rule, action) =>
    updatePermissionRule(await deps.assertAllowedDirectory(cwd), kind, behavior, rule, action))
}
