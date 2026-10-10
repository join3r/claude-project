import os from 'os'
import { AI_TAB_META, type AppConfig, type SshConfig } from '../shared/types'
import type { PtyManager } from './pty-manager'
import type { ScrollbackStorage } from './scrollback-storage'
import type { SshConnectionManager } from './ssh-connection-manager'
import type { HookInjector } from './hook-injector'
import type { TabActivityRegistry } from './tab-activity-registry'
import { agentCommandOverride, conptySpawnArgv, isAiAgentCommand, resolveAgentCommand } from './resolve-agent-command'
import { isLocalInteractiveTerminal, resolveLocalTerminalSpawn } from './resolve-local-terminal'
import { wrapInteractiveShellWithCondaActivate } from './conda-env'
import type { CondaEnvInfo } from '../shared/conda'
import { isInterruptKey } from './key-interrupts'
import { buildRemotePiExtensionScript, piExtensionRemotePath } from './pi-extension-injector'

export const MAX_SCROLLBACK_CHARS = 2_000_000

export function trimScrollback(scrollback: string): string {
  if (scrollback.length <= MAX_SCROLLBACK_CHARS) return scrollback
  return scrollback.slice(-MAX_SCROLLBACK_CHARS)
}

interface PtyRuntime {
  attachedClientIds: Set<string>
  controllerClientId: string | null
  /** Who holds the output back (a congested host link); the PTY is paused while any does. */
  outputHolds: Set<string>
  cols: number
  rows: number
  scrollback: string
  exitCode: number | null
  /** A Claude tab reporting through hooks, whose Esc may end a turn without a Stop. */
  claudeHooks: boolean
}

export interface PtyAttachResult {
  cols: number
  rows: number
  scrollback: string
  exitCode: number | null
}

export interface PtySpawnRequest {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  args?: string[]
  extraEnv?: Record<string, string>
  projectId?: string
  sshConfig?: SshConfig
}

export interface PtySessionsDeps {
  ptyManager: PtyManager
  scrollbackStorage: ScrollbackStorage
  activityRegistry: TabActivityRegistry
  sshManager: () => SshConnectionManager
  hookInjector: () => HookInjector
  hookPort: () => number
  hookToken: () => string
  getConfig: () => AppConfig
  /** Push the tab's current agent activity to every window. */
  broadcastAgentActivity: (tabId: string) => void
  sendToClient: (clientId: string, channel: string, ...args: unknown[]) => void
  log: (message: string) => void
  /** The pi status extension shipped with the app (`pi -e <path>`). */
  piExtensionPath: () => string
  /** The project's conda env, activated for local PTYs (remote ones use the host's). */
  condaEnvForProject?: (projectId?: string) => CondaEnvInfo | undefined
  /** A tab's process was killed (closing a notebook tab also stops its kernel). */
  onKill?: (tabId: string) => void
  /** Esc was typed into a Claude tab (see `KeyInterrupts`). */
  onInterruptKey?: (tabId: string) => void
  /**
   * Host-side status (a DevTool server): output of the tabs no hook reports on
   * (shells, Codex), and the end of any tab's process. Unset on a desktop, whose
   * windows report those tabs' status themselves.
   */
  terminalStatus?: {
    output: (tabId: string, data: string) => void
    forget: (tabId: string) => void
  }
}

/** Claude and pi tabs report their status through hooks; the rest only have their output. */
function hasStatusHooks(shell: string, extraEnv?: Record<string, string>): boolean {
  return (shell === 'claude' || shell === AI_TAB_META.pi.command) && !!extraEnv?.DEVTOOL_TAB_ID
}

/**
 * Terminal tabs' processes, owned by main so they outlive the window showing
 * them: several windows (clients) can attach to one PTY, one of which (the
 * last to type or resize) controls its size.
 */
export class PtySessions {
  private readonly runtimes = new Map<string, PtyRuntime>()

  constructor(private readonly deps: PtySessionsDeps) {}

  has(tabId: string): boolean {
    return this.runtimes.has(tabId)
  }

  attachedClients(tabId: string): ReadonlySet<string> | undefined {
    return this.runtimes.get(tabId)?.attachedClientIds
  }

  /** Tabs whose process is still running, including ones no window currently shows. */
  liveTabIds(): string[] {
    const ids: string[] = []
    for (const [tabId, runtime] of this.runtimes.entries()) {
      if (runtime.exitCode === null) ids.push(tabId)
    }
    return ids
  }

  /** A client (window) went away: it no longer sees any PTY, and hands control to another viewer. */
  detachClient(clientId: string): void {
    for (const [tabId, runtime] of this.runtimes.entries()) {
      runtime.attachedClientIds.delete(clientId)
      if (runtime.controllerClientId === clientId) {
        const nextController = runtime.attachedClientIds.values().next().value ?? null
        runtime.controllerClientId = nextController
        this.deps.log(`ptyControllerReassigned id=${tabId} clientId=${nextController ?? 'none'}`)
      }
    }
  }

  /**
   * Flow control: `holder` (a congested link) holds the tab's output back. The PTY
   * stops being read, so the program blocks on its writes rather than any output
   * being dropped, until every holder has let go. False when there is no such tab.
   */
  holdOutput(tabId: string, holder: string): boolean {
    const runtime = this.runtimes.get(tabId)
    if (!runtime || runtime.exitCode !== null) return false
    if (runtime.outputHolds.has(holder)) return true
    runtime.outputHolds.add(holder)
    if (runtime.outputHolds.size === 1) this.deps.ptyManager.pause(tabId)
    return true
  }

  releaseOutput(tabId: string, holder: string): void {
    const runtime = this.runtimes.get(tabId)
    if (!runtime || !runtime.outputHolds.delete(holder)) return
    if (runtime.outputHolds.size === 0) this.deps.ptyManager.resume(tabId)
  }

  /** Tabs `holder` holds back right now. */
  heldBy(holder: string): string[] {
    const ids: string[] = []
    for (const [tabId, runtime] of this.runtimes) if (runtime.outputHolds.has(holder)) ids.push(tabId)
    return ids
  }

  saveScrollback(tabId: string, data: string): void {
    const scrollback = trimScrollback(data)
    this.deps.scrollbackStorage.save(tabId, scrollback)
    const runtime = this.runtimes.get(tabId)
    if (runtime) runtime.scrollback = scrollback
  }

  loadScrollback(tabId: string): string | null {
    const runtime = this.runtimes.get(tabId)
    return runtime ? runtime.scrollback : this.deps.scrollbackStorage.load(tabId)
  }

  discardScrollback(tabId: string): void {
    this.deps.scrollbackStorage.delete(tabId)
  }

  saveAllScrollback(): void {
    for (const [tabId, runtime] of this.runtimes.entries()) {
      this.deps.scrollbackStorage.save(tabId, runtime.scrollback)
    }
  }

  /** Main-initiated teardown (task removal): no scrollback save, no activity change. */
  discard(tabId: string): void {
    this.deps.ptyManager.kill(tabId)
    this.runtimes.delete(tabId)
    this.deps.terminalStatus?.forget(tabId)
  }

  killAll(): void {
    this.deps.ptyManager.killAll()
  }

  write(clientId: string, id: string, data: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.attachedClientIds.has(clientId)) return
    this.claimControl(id, clientId)
    this.deps.ptyManager.write(id, data)
    if (runtime.claudeHooks && runtime.exitCode === null && isInterruptKey(data)) this.deps.onInterruptKey?.(id)
  }

  /** Main's own input to a tab's live process (no window involved). False when it has none. */
  writeFromMain(id: string, data: string): boolean {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.exitCode !== null) return false
    this.deps.ptyManager.write(id, data)
    return true
  }

  resize(clientId: string, clientFocused: boolean, id: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.attachedClientIds.has(clientId)) return
    if (!clientFocused && runtime.controllerClientId !== clientId) {
      this.deps.log(`ptyResizeIgnored id=${id} clientId=${clientId} cols=${cols} rows=${rows}`)
      return
    }
    this.claimControl(id, clientId)
    runtime.cols = cols
    runtime.rows = rows
    this.broadcastToAttached(id, 'pty-size-sync', id, cols, rows)
    this.deps.ptyManager.resize(id, cols, rows)
  }

  kill(id: string): void {
    this.deps.log(`ptyKill id=${id}`)
    const runtime = this.runtimes.get(id)
    if (runtime) {
      this.deps.scrollbackStorage.save(id, runtime.scrollback)
    }
    this.deps.ptyManager.kill(id)
    this.runtimes.delete(id)
    this.deps.terminalStatus?.forget(id)
    this.deps.onKill?.(id)
    // No process, no activity: a status left at 'working' here would show the
    // task as busy for the rest of the session.
    this.deps.activityRegistry.remove(id)
    this.deps.broadcastAgentActivity(id)
  }

  attachOrCreate(clientId: string, request: PtySpawnRequest): PtyAttachResult {
    const { id, cols, rows, projectId, sshConfig } = request
    let runtime = this.runtimes.get(id)
    // If the stored runtime's PTY has already exited and this tab is an SSH tab
    // whose project is currently connected, drop the dead runtime so we respawn
    // fresh.  Happens when a tab is hidden (renderer-side spawnedRef=false) while
    // SSH master dies and auto-reconnects: the renderer's false→true respawn
    // effect skips hidden tabs, so main is the only place left to detect and
    // clean up the stranded dead slave — otherwise the user sees a frozen
    // "Shared connection closed" in scrollback when they switch back to the tab.
    if (runtime && runtime.exitCode !== null && sshConfig && projectId
        && this.deps.sshManager().getStatus(projectId) === 'connected') {
      this.deps.log(`ptyAttach refresh-dead id=${id} exitCode=${runtime.exitCode}`)
      this.deps.ptyManager.kill(id)
      this.deps.scrollbackStorage.delete(id)
      this.runtimes.delete(id)
      runtime = undefined
    }
    if (!runtime) {
      this.deps.log(`ptyAttach create clientId=${clientId} id=${id}`)
      runtime = {
        attachedClientIds: new Set<string>(),
        controllerClientId: clientId,
        outputHolds: new Set<string>(),
        cols,
        rows,
        scrollback: this.deps.scrollbackStorage.load(id) ?? '',
        exitCode: null,
        claudeHooks: request.shell === 'claude' && !!request.extraEnv?.DEVTOOL_TAB_ID
      }
      this.runtimes.set(id, runtime)
      runtime.attachedClientIds.add(clientId)
      this.spawn(request)
    } else {
      this.deps.log(`ptyAttach reuse clientId=${clientId} id=${id} scrollback=${runtime.scrollback.length} exit=${runtime.exitCode}`)
      runtime.attachedClientIds.add(clientId)
    }
    return {
      cols: runtime.cols,
      rows: runtime.rows,
      scrollback: runtime.scrollback,
      exitCode: runtime.exitCode
    }
  }

  private spawn({ id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig }: PtySpawnRequest): void {
    const { deps } = this
    deps.log(`ptySpawn start id=${id} shell=${shell} cwd=${cwd}`)
    // A fresh process for this tab: whatever the old one was doing (including
    // 'exited') describes a process that no longer exists.
    deps.activityRegistry.reset(id)
    deps.broadcastAgentActivity(id)
    deps.terminalStatus?.forget(id)
    const statusOutput = deps.terminalStatus && !hasStatusHooks(shell, extraEnv) ? deps.terminalStatus.output : null

    // Capture the current runtime so callbacks can verify they belong to the
    // right generation.  After a kill+respawn cycle the same `id` maps to a
    // different runtime object — without this check the OLD process's delayed
    // onData/onExit would pollute the NEW runtime (setting exitCode, pushing
    // stale "Shared connection closed" output, etc.).
    const expectedRuntime = this.runtimes.get(id)

    const callbacks = {
      onData: (data: string) => {
        const runtime = this.runtimes.get(id)
        if (!runtime || runtime !== expectedRuntime) return
        runtime.scrollback = trimScrollback(runtime.scrollback + data)
        this.broadcastToAttached(id, 'pty-data', id, data)
        statusOutput?.(id, data)
        // Layer 3: a slave printing "Shared connection to <host> closed" means
        // the master's tunnel is dead — force an immediate reconnect instead
        // of waiting for the next health-check tick (up to 10s) and without
        // trusting `-O check` (which returns true when the master process is
        // alive but its TCP to the server has died).
        if (sshConfig && projectId && /Shared connection to \S+ closed/.test(data)) {
          deps.sshManager().triggerReconnect(projectId, sshConfig)
        }
      },
      onExit: (exitCode: number) => {
        const runtime = this.runtimes.get(id)
        if (!runtime || runtime !== expectedRuntime) return
        runtime.exitCode = exitCode
        deps.terminalStatus?.forget(id)
        deps.activityRegistry.exited(id)
        deps.broadcastAgentActivity(id)
        deps.log(`ptyExit id=${id} exitCode=${exitCode}`)
        this.broadcastToAttached(id, 'pty-exit', id, exitCode)
      }
    }

    if (sshConfig && projectId) {
      const sshManager = deps.sshManager()
      if (sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      const remoteCwd = cwd || sshConfig.remoteDir
      const isClaudeRemote = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      const isPiRemote = shell === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID
      let hookInjectPrefix = ''
      let remoteArgs = args
      let remoteEnv = extraEnv
      if (isClaudeRemote) {
        const remotePort = sshManager.getRemotePort(projectId)
        if (remotePort) {
          const hookInjector = deps.hookInjector()
          hookInjector.remoteInject(projectId, remoteCwd, extraEnv.DEVTOOL_TAB_ID)
          hookInjectPrefix = hookInjector.buildRemoteInjectScript(remoteCwd, remotePort) + ' && '
          deps.log(`hookInjectRemote dir=${remoteCwd} port=${remotePort} tabId=${extraEnv?.DEVTOOL_TAB_ID}`)
        }
      } else if (isPiRemote) {
        // pi loads the status extension via `-e`; write it to the remote host and
        // point its callback at the reverse-tunnel port (reaches the local hook-server).
        const remotePort = sshManager.getRemotePort(projectId)
        if (remotePort) {
          const remoteExtPath = piExtensionRemotePath()
          hookInjectPrefix = buildRemotePiExtensionScript(deps.piExtensionPath()) + ' && '
          // Ahead of the caller's args, so a first prompt stays the last argument.
          remoteArgs = ['-e', remoteExtPath, ...(args ?? [])]
          remoteEnv = {
            ...extraEnv,
            DEVTOOL_HOOK_PORT: String(remotePort),
            DEVTOOL_HOOK_TOKEN: deps.hookToken()
          }
        }
      }

      const sshArgs = sshManager.buildSpawnArgs(projectId, sshConfig, shell, remoteArgs, remoteEnv, hookInjectPrefix, remoteCwd)
      // Same binary as ControlMaster. On Windows that is Git ssh.exe (native
      // OpenSSH cannot own the mux socket). ConPTY needs an absolute path.
      const sshFile = sshManager.getSshCommand()
      deps.log(`ptySpawn ssh id=${id} file=${sshFile}`)
      deps.ptyManager.spawn(id, sshFile, os.tmpdir(), cols, rows, sshArgs, undefined, callbacks)
    } else {
      const condaEnv = deps.condaEnvForProject?.(projectId)
      const isClaudeLocal = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      const isPiLocal = shell === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID
      if (isClaudeLocal) {
        // Hooks land in the dir Claude is actually started in (a workspace task's
        // worktree, not the project root) — logged so a missing status is easy to
        // trace back to the settings file it should have been written to.
        deps.hookInjector().inject(cwd, extraEnv.DEVTOOL_TAB_ID)
        deps.log(`hookInject dir=${cwd} tabId=${extraEnv?.DEVTOOL_TAB_ID}`)
      }
      let localArgs = args
      let localEnv = extraEnv
      if (isPiLocal) {
        // Ahead of the caller's args, so a first prompt stays the last argument.
        localArgs = ['-e', deps.piExtensionPath(), ...(args ?? [])]
        localEnv = {
          ...extraEnv,
          DEVTOOL_HOOK_PORT: String(deps.hookPort()),
          DEVTOOL_HOOK_TOKEN: deps.hookToken()
        }
      }
      // Keep `shell` as `pi`/`claude`/`codex` for hook detection above. Resolve the
      // actual file CreateProcess can open (Windows needs pi.cmd, not a bare `pi`).
      let spawnFile = shell
      let spawnArgs = localArgs ?? []
      const config = deps.getConfig()
      if (isAiAgentCommand(shell)) {
        const override = agentCommandOverride(shell, config).trim()
        spawnFile = resolveAgentCommand(override || shell)
        const wrapped = conptySpawnArgv(spawnFile, spawnArgs)
        spawnFile = wrapped.file
        spawnArgs = wrapped.args
        deps.log(`ptySpawn resolve id=${id} shell=${shell} file=${spawnFile} args=${spawnArgs.length}`)
      } else if (isLocalInteractiveTerminal(shell, spawnArgs)) {
        // Git Bash / $SHELL from Settings — do not inherit process.env.SHELL on Windows.
        const resolved = resolveLocalTerminalSpawn(config)
        const wrapped = wrapInteractiveShellWithCondaActivate(resolved, condaEnv)
        spawnFile = wrapped.file
        spawnArgs = wrapped.args
        deps.log(`ptySpawn resolve id=${id} shell=${shell} file=${spawnFile} args=${spawnArgs.join(' ')}`)
      }
      deps.ptyManager.spawn(id, spawnFile, cwd, cols, rows, spawnArgs, localEnv, callbacks, condaEnv)
    }
  }

  private claimControl(tabId: string, clientId: string): void {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    if (runtime.controllerClientId !== clientId) {
      runtime.controllerClientId = clientId
      this.deps.log(`ptyController id=${tabId} clientId=${clientId}`)
    }
  }

  private broadcastToAttached(tabId: string, channel: string, ...args: unknown[]): void {
    const clientIds = this.runtimes.get(tabId)?.attachedClientIds
    if (!clientIds) return
    for (const clientId of clientIds) this.deps.sendToClient(clientId, channel, ...args)
  }
}
