import { EventEmitter } from 'events'
import { execFile, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import type { SshConfig, TunnelConfig, TunnelState, TunnelStatus } from '../shared/types'
import { sshExecutable } from './resolve-agent-command'
import { piExtensionRemotePath } from './pi-extension-injector'

export type SshStatus = 'disconnected' | 'connecting' | 'connected'

/** Shell-quote a value for safe interpolation into a remote shell command */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** True when the user left Remote directory blank (start in $HOME). */
export function isBlankRemoteDir(dir: string | undefined): boolean {
  return !dir || !dir.trim()
}

/**
 * `cd` for the remote login shell. No directory → `cd` with no args, which
 * bash treats as the user’s home (MobaXterm-style).
 */
export function spawnCdCommand(cwd: string): string {
  const trimmed = cwd.trim()
  if (!trimmed) return 'cd'
  return `cd ${shellQuote(trimmed)}`
}

/** POSIX-join a remote base dir with a relative path */
export function joinRemotePath(remoteDir: string, relative: string): string {
  if (!remoteDir) return relative
  return remoteDir.replace(/\/+$/, '') + '/' + relative.replace(/^\/+/, '')
}

/** Pick this project's ControlMaster processes out of `ps -axo pid=,command=`.
 *
 *  A master whose control socket has been unlinked is unreachable by every
 *  socket-based mechanism we have (`-O exit`, `-O check`), yet it keeps holding
 *  the local tunnel port — so argv is the only handle left on it. Matching the
 *  full socket path keeps instances apart: a dev run (`~/.devtool-dev/ssh/…`)
 *  can never reap the packaged app's masters, or vice versa.
 *
 *  Requiring `-M` is what keeps mux *slaves* out of the results — those are the
 *  user's open remote terminals, spawned against the same `-S` path. */
export function parseMasterPids(psOutput: string, socketPath: string): number[] {
  const escaped = socketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ownsSocket = new RegExp(`(^|\\s)-S\\s+${escaped}(\\s|$)`)
  const isMaster = /(^|\s)-M(\s|$)/
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S.*)$/)
    if (!match) continue
    const [, pid, command] = match
    if (!ownsSocket.test(command) || !isMaster.test(command)) continue
    pids.push(parseInt(pid, 10))
  }
  return pids
}

/** Turn an `ssh -O forward` failure into something a user can act on. The raw
 *  error is the whole command line plus ssh's "mux_client_forward: forwarding
 *  request failed: Port forwarding failed", which says nothing about *why* —
 *  and by far the most common cause is the local port already being bound by
 *  something else (often an orphaned ssh master from an earlier session). */
export function describeTunnelFailure(err: unknown, tunnel: TunnelConfig): string {
  const raw = err instanceof Error ? err.message : String(err)
  const stderr = typeof (err as { stderr?: unknown })?.stderr === 'string' ? (err as { stderr: string }).stderr : ''
  if (/Port forwarding failed|forwarding request failed|Address already in use/i.test(raw + stderr)) {
    return `Could not open local port ${tunnel.sourcePort} — it is already in use by another process. Free it, or pick a different local port.`
  }
  return raw
}

/** Compute the ControlMaster socket path for a given socketDir + projectId */
export function controlSocketPath(socketDir: string, projectId: string): string {
  return path.join(socketDir, `${projectId}.sock`)
}

/**
 * Host-key options shared by master, mux slaves, and SOCKS. The user's own
 * ~/.ssh/known_hosts is used: first connect is TOFU (`accept-new`), a
 * *changed* key fails. Identity selection is left to ssh (agent, ~/.ssh/config).
 */
export function sshTrustArgs(): string[] {
  return ['-o', 'StrictHostKeyChecking=accept-new']
}

/** Create (or tighten) the ControlMaster / known_hosts directory to 0700. */
export function ensureSshDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Windows cannot POSIX-chmod; the dir still exists.
  }
}

/** Turn OpenSSH's host-key mismatch into a message that names known_hosts. */
export function formatSshConnectError(err: unknown): Error {
  const execErr = err as { message?: string; stderr?: string }
  const detail = `${execErr.stderr ?? ''}\n${execErr.message ?? String(err)}`
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(detail)) {
    return new Error(
      `SSH host key mismatch. The remote key does not match ~/.ssh/known_hosts. ` +
      `If you trust this host, remove its line from that file and reconnect. ` +
      `${execErr.message ?? String(err)}`
    )
  }
  if (/getsockname failed:\s*Not a socket/i.test(detail)) {
    return new Error(
      'This ssh.exe cannot share connections on Windows. Install Git for Windows ' +
      '(DevTool uses Git\\usr\\bin\\ssh.exe for remote projects) and reconnect.'
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Quote a value for the remote `bash -c` command. Only the Pi status extension
 * path (a fixed `$HOME/...` expression) is double-quoted so the login shell
 * expands `$HOME`; everything else is single-quoted verbatim.
 */
export function quoteSpawnArg(s: string): string {
  if (s === piExtensionRemotePath()) {
    return `"${s}"`
  }
  return shellQuote(s)
}

/** Pure argv builder: produce ssh args to read a remote file via cat */
export function buildReadRemoteFileArgs(
  socketDir: string,
  projectId: string,
  config: SshConfig,
  relativePath: string
): string[] {
  const userHost = `${config.username}@${config.host}`
  const port = String(config.port ?? 22)
  const sock = controlSocketPath(socketDir, projectId)
  const remotePath = joinRemotePath(config.remoteDir, relativePath)
  const args = ['-S', sock, '-o', 'ControlMaster=no', '-p', port, ...sshTrustArgs()]
  if (config.keyFile) args.push('-i', config.keyFile)
  args.push(userHost, 'cat', '--', shellQuote(remotePath))
  return args
}

export class SshConnectionManager extends EventEmitter {
  private socketDir: string
  private hookPort: number
  /** Master, mux slaves, and PTY spawn must share this binary. */
  private sshBin: string
  private statuses = new Map<string, SshStatus>()
  private remotePorts = new Map<string, number>()
  private configs = new Map<string, SshConfig>()
  private tunnels = new Map<string, TunnelConfig>()
  /** The tunnel the project is *configured* to have, as opposed to the one that
   *  is currently up (`tunnels`). Survives connection loss so that reconnects —
   *  including automatic ones, which have no renderer in the loop — can restore
   *  the connection to its full configured state. */
  private desiredTunnels = new Map<string, TunnelConfig>()
  private tunnelStates = new Map<string, TunnelState>()
  private socksProxies = new Map<string, { port: number; process: ChildProcess }>()
  private socksStartPromises = new Map<string, Promise<number>>()
  private connectLocks = new Map<string, Promise<void>>()
  private autoReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private autoReconnectAttempts = new Map<string, number>()
  private autoReconnectEnabled = new Set<string>()
  private tunnelRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private tunnelRetryAttempts = new Map<string, number>()
  private platform: NodeJS.Platform

  /** Promisified execFile that always returns { stdout, stderr } */
  private execFileAsync(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
    const file = cmd === 'ssh' ? this.sshBin : cmd
    return new Promise((resolve, reject) => {
      execFile(file, args, opts, (err, stdout, stderr) => {
        if (err) {
          const wrapped = err as Error & { stderr?: string; stdout?: string }
          if (typeof stderr === 'string') wrapped.stderr = stderr
          if (typeof stdout === 'string') wrapped.stdout = stdout
          reject(formatSshConnectError(wrapped))
        } else {
          resolve({ stdout: stdout as string, stderr: stderr as string })
        }
      })
    })
  }

  constructor(socketDir: string, hookPort: number, options?: { platform?: NodeJS.Platform }) {
    super()
    this.socketDir = socketDir
    this.hookPort = hookPort
    this.sshBin = sshExecutable()
    this.platform = options?.platform ?? process.platform
  }

  /** Absolute ssh.exe so ConPTY and ControlMaster use the same binary. */
  getSshCommand(): string {
    return this.sshBin
  }

  getSocketPath(projectId: string): string {
    return controlSocketPath(this.socketDir, projectId)
  }

  getStatus(projectId: string): SshStatus {
    return this.statuses.get(projectId) ?? 'disconnected'
  }

  setStatus(projectId: string, status: SshStatus): void {
    this.statuses.set(projectId, status)
    this.emit('status-changed', projectId, status)
  }

  getRemotePort(projectId: string): number | undefined {
    return this.remotePorts.get(projectId)
  }

  setRemotePort(projectId: string, port: number): void {
    this.remotePorts.set(projectId, port)
  }

  getTunnel(projectId: string): TunnelConfig | undefined {
    return this.tunnels.get(projectId)
  }

  getTunnelState(projectId: string): TunnelState {
    return this.tunnelStates.get(projectId) ?? { status: 'inactive' }
  }

  private setTunnelState(projectId: string, status: TunnelStatus, error?: string): void {
    const state = error ? { status, error } : { status }
    this.tunnelStates.set(projectId, state)
    this.emit('tunnel-status-changed', projectId, status, error)
  }

  /** Drop the *live* tunnel state. Deliberately keeps `desiredTunnels`: the
   *  configuration is still what the user asked for, it just isn't up right now. */
  private clearTunnelRuntime(projectId: string): void {
    this.cancelTunnelRetry(projectId)
    this.tunnels.delete(projectId)
    this.tunnelStates.delete(projectId)
    this.emit('tunnel-status-changed', projectId, 'inactive', undefined)
  }

  clearProject(projectId: string): void {
    this.cancelAutoReconnect(projectId)
    this.cancelTunnelRetry(projectId)
    this.statuses.delete(projectId)
    this.remotePorts.delete(projectId)
    this.configs.delete(projectId)
    this.tunnels.delete(projectId)
    this.desiredTunnels.delete(projectId)
    this.tunnelStates.delete(projectId)
    this.socksStartPromises.delete(projectId)
    const socksEntry = this.socksProxies.get(projectId)
    if (socksEntry) {
      try { socksEntry.process.kill() } catch { /* best-effort */ }
      this.socksProxies.delete(projectId)
    }
  }

  /** Args to establish the ControlMaster connection (no port forwarding yet). */
  buildMasterArgs(projectId: string, config: SshConfig): string[] {
    const args = [
      '-fN', '-M',
      '-S', this.getSocketPath(projectId),
      ...sshTrustArgs(),
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes',
      '-p', String(config.port)
    ]
    if (config.keyFile) {
      args.push('-i', config.keyFile)
    }
    args.push(`${config.username}@${config.host}`)
    return args
  }

  /** Args to add dynamic remote port forwarding via the existing master socket.
   *  Uses `-O forward` so the allocated port is printed to stdout reliably. */
  buildForwardArgs(projectId: string, config: SshConfig): string[] {
    return [
      '-S', this.getSocketPath(projectId),
      '-O', 'forward',
      '-R', `0:localhost:${this.hookPort}`,
      `${config.username}@${config.host}`
    ]
  }

  private formatTunnelSpec(tunnel: TunnelConfig): string {
    return `${tunnel.sourcePort}:${tunnel.host}:${tunnel.destinationPort}`
  }

  buildTunnelForwardArgs(projectId: string, config: SshConfig, tunnel: TunnelConfig): string[] {
    return [
      ...this.buildBaseArgs(projectId, config),
      '-O', 'forward',
      '-L', this.formatTunnelSpec(tunnel),
      `${config.username}@${config.host}`
    ]
  }

  buildTunnelCancelArgs(projectId: string, config: SshConfig, tunnel: TunnelConfig): string[] {
    return [
      ...this.buildBaseArgs(projectId, config),
      '-O', 'cancel',
      '-L', this.formatTunnelSpec(tunnel),
      `${config.username}@${config.host}`
    ]
  }

  /** Build common SSH args shared across spawn/check/exit (socket, port, keyFile). */
  private buildBaseArgs(projectId: string, config: SshConfig): string[] {
    const args = [
      '-S', this.getSocketPath(projectId),
      ...sshTrustArgs(),
      '-p', String(config.port)
    ]
    if (config.keyFile) {
      args.push('-i', config.keyFile)
    }
    return args
  }

  /**
   * Shared args for a remote command. Unix slaves reuse ControlMaster (`-S`).
   * Windows PTY tabs must not: Git ssh cannot mux a TTY, and Windows OpenSSH
   * cannot create the control socket at all.
   */
  private buildSessionArgs(projectId: string, config: SshConfig, multiplex: boolean): string[] {
    if (multiplex) return this.buildBaseArgs(projectId, config)
    const args = [
      ...sshTrustArgs(),
      '-p', String(config.port)
    ]
    if (config.keyFile) {
      args.push('-i', config.keyFile)
    }
    return args
  }

  buildSpawnArgs(
    projectId: string,
    config: SshConfig,
    command: string,
    commandArgs?: string[],
    envVars?: Record<string, string>,
    commandPrefix?: string,
    cwdOverride?: string
  ): string[] {
    const args = [
      ...this.buildSessionArgs(projectId, config, this.platform !== 'win32'),
      '-t',
      `${config.username}@${config.host}`
    ]
    const envPrefix = envVars
      ? Object.entries(envVars).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ') + ' '
      : ''
    const cmdSuffix = commandArgs?.length ? ' ' + commandArgs.map(a => quoteSpawnArg(a)).join(' ') : ''
    const prefix = commandPrefix || ''
    const cwd = cwdOverride || config.remoteDir
    // Wrap in an interactive login shell (-l -i). Login alone is not enough:
    // non-interactive bash skips ~/.bashrc (and Ubuntu's ~/.bashrc early-returns
    // for non-interactive shells), so PATH additions from nvm/cargo/local bin
    // never apply and commands like `pi` come back "not found" even though they
    // work in a normal terminal. We always allocate a tty (-t), so interactive
    // matches what the user's own ssh session would get.
    const innerCmd = `${prefix}${spawnCdCommand(cwd)} && ${envPrefix}exec ${command}${cmdSuffix}`
    args.push(`bash -l -i -c ${shellQuote(innerCmd)}`)
    return args
  }

  /**
   * Args for a non-tty remote command whose stdin/stdout are a protocol, not a
   * screen — the Claude chat tab's `claude` speaks stream-json over them. Same
   * interactive login shell as {@link buildSpawnArgs} so PATH matches the user's
   * terminal; `-T` because a tty would echo input and mangle the stream.
   */
  buildStdioSpawnArgs(
    projectId: string,
    config: SshConfig,
    command: string,
    commandArgs: string[],
    envVars: Record<string, string>,
    cwd: string
  ): string[] {
    const args = [
      ...this.buildSessionArgs(projectId, config, this.platform !== 'win32'),
      '-T',
      `${config.username}@${config.host}`
    ]
    const envPrefix = Object.entries(envVars).map(([k, v]) => `${k}=${shellQuote(v)} `).join('')
    const cmdSuffix = commandArgs.length ? ' ' + commandArgs.map(a => shellQuote(a)).join(' ') : ''
    const innerCmd = `${spawnCdCommand(cwd || config.remoteDir)} && ${envPrefix}exec ${command}${cmdSuffix}`
    args.push(`bash -l -i -c ${shellQuote(innerCmd)}`)
    return args
  }

  /** Args for an end-to-end liveness probe through the master socket: runs
   *  `true` on the remote host as a mux slave. Unlike `-O check` (which only
   *  asks the local master process if it's alive), this exercises the actual
   *  TCP connection to the server. */
  buildProbeArgs(projectId: string, config: SshConfig): string[] {
    return [
      ...this.buildBaseArgs(projectId, config),
      '-o', 'ControlMaster=no',
      '-o', 'BatchMode=yes',
      `${config.username}@${config.host}`,
      'true'
    ]
  }

  buildCheckArgs(projectId: string, config: SshConfig): string[] {
    return [
      ...this.buildBaseArgs(projectId, config),
      '-O', 'check',
      `${config.username}@${config.host}`
    ]
  }

  buildExitArgs(projectId: string, config: SshConfig): string[] {
    return [
      ...this.buildBaseArgs(projectId, config),
      '-O', 'exit',
      `${config.username}@${config.host}`
    ]
  }

  buildSocksProxyArgs(_projectId: string, config: SshConfig, localPort: number): string[] {
    // NOTE: Do NOT use buildBaseArgs/ControlMaster socket here.
    // SSH -D through a ControlMaster slave exits immediately because the master
    // handles the forwarding setup and the slave has nothing to keep it alive.
    // We need a standalone SSH connection that stays alive to keep the SOCKS port bound.
    const args = [
      ...sshTrustArgs(),
      '-p', String(config.port),
      '-D', String(localPort),
      '-N',
      '-o', 'ExitOnForwardFailure=yes'
    ]
    if (config.keyFile) {
      args.push('-i', config.keyFile)
    }
    args.push(`${config.username}@${config.host}`)
    return args
  }

  getConfig(projectId: string): SshConfig | undefined {
    return this.configs.get(projectId)
  }

  getSocksProxy(projectId: string): { port: number } | undefined {
    const entry = this.socksProxies.get(projectId)
    return entry ? { port: entry.port } : undefined
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = (addr as net.AddressInfo).port
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }

  private waitForPort(port: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tryConnect = () => {
        if (Date.now() > deadline) {
          reject(new Error(`SOCKS proxy did not become ready on port ${port} within ${timeoutMs}ms`))
          return
        }
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy()
          resolve()
        })
        sock.on('error', () => {
          setTimeout(tryConnect, 100)
        })
      }
      tryConnect()
    })
  }

  async startSocksProxy(projectId: string, config: SshConfig): Promise<number> {
    const existing = this.socksProxies.get(projectId)
    if (existing) return existing.port

    const pending = this.socksStartPromises.get(projectId)
    if (pending) return pending

    if (this.getStatus(projectId) !== 'connected') {
      throw new Error('SSH connection not established')
    }

    const startPromise = this.doStartSocksProxy(projectId, config, 0)
    this.socksStartPromises.set(projectId, startPromise)

    try {
      const port = await startPromise
      return port
    } finally {
      this.socksStartPromises.delete(projectId)
    }
  }

  private async doStartSocksProxy(projectId: string, config: SshConfig, attempt: number): Promise<number> {
    const port = await this.findFreePort()
    const args = this.buildSocksProxyArgs(projectId, config, port)
    const child = spawn(this.sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    // Catch spawn errors (e.g. ENOENT if ssh binary not found) to prevent
    // unhandled error events from crashing the Electron main process.
    // Held in an object: assigning from the callback leaves control-flow analysis
    // convinced a plain `let` is still null, which narrows it to `never` below.
    const spawnFailure = { error: null as Error | null }
    child.on('error', (err: Error) => { spawnFailure.error = err })

    try {
      await this.waitForPort(port)
    } catch {
      child.kill()
      if (spawnFailure.error) {
        throw new Error(`Failed to spawn ssh: ${spawnFailure.error.message}`)
      }
      if (attempt < 1 && !stderr.includes('Permission denied') && !stderr.includes('Connection refused')) {
        return this.doStartSocksProxy(projectId, config, attempt + 1)
      }
      throw new Error(`SOCKS proxy failed to start on port ${port}${stderr ? ': ' + stderr.slice(0, 200) : ''}`)
    }

    // Set map entry before attaching exit listener so the listener always
    // finds the entry (avoids narrow race if child dies between these lines).
    this.socksProxies.set(projectId, { port, process: child })

    child.on('exit', () => {
      if (this.socksProxies.has(projectId)) {
        this.socksProxies.delete(projectId)
        this.emit('socks-proxy-status-changed', projectId, false)
      }
    })

    return port
  }

  async stopSocksProxy(projectId: string): Promise<void> {
    const entry = this.socksProxies.get(projectId)
    if (!entry) return

    this.socksProxies.delete(projectId)
    entry.process.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { entry.process.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, 3000)
      entry.process.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  /** Return all currently-connected project configs (used for cleanup on shutdown). */
  getConnectedProjects(): Map<string, SshConfig> {
    const connected = new Map<string, SshConfig>()
    for (const [projectId, config] of this.configs.entries()) {
      if (this.getStatus(projectId) === 'connected') {
        connected.set(projectId, config)
      }
    }
    return connected
  }

  /** Connect (or reconnect) a project and bring it back to its full configured
   *  state. Pass `options.tunnel` to record the project's configured local
   *  forward (null clears it); omit `options` to reuse whatever was recorded
   *  last — which is what the internal auto-reconnect path does, so it restores
   *  the same tunnel the renderer-triggered connect established. */
  async connect(projectId: string, config: SshConfig, options?: { tunnel?: TunnelConfig | null }): Promise<void> {
    return this.connectWith(projectId, config, options, false)
  }

  /** `auto` marks an auto-reconnect attempt, which must keep the backoff count
   *  a manual connect resets — otherwise every retry runs at the 1s floor. */
  private async connectWith(
    projectId: string,
    config: SshConfig,
    options: { tunnel?: TunnelConfig | null } | undefined,
    auto: boolean
  ): Promise<void> {
    if (options && 'tunnel' in options) {
      if (options.tunnel) this.desiredTunnels.set(projectId, options.tunnel)
      else this.desiredTunnels.delete(projectId)
    }

    // Serialize per-project: if a connect is already in progress, wait for it
    // then check status — avoids a second call's cleanup killing the master
    // that the first call just established (race on app startup with multiple
    // windows sharing the same remote project).
    const existing = this.connectLocks.get(projectId)
    if (existing) {
      await existing.catch(() => {})
      if (this.getStatus(projectId) === 'connected') return
    }

    const promise = this.doConnect(projectId, config, auto)
    this.connectLocks.set(projectId, promise)
    try {
      await promise
    } finally {
      if (this.connectLocks.get(projectId) === promise) {
        this.connectLocks.delete(projectId)
      }
    }
  }

  private async doConnect(projectId: string, config: SshConfig, auto: boolean): Promise<void> {
    ensureSshDir(this.socketDir)

    // Clean up stale ControlMaster socket from a previous (dead) connection.
    // Without this, ssh -M will refuse to create a new master or connect
    // through the dead socket, leaving the session stuck. `ssh -O exit`
    // operates through the control socket, so only attempt it when the
    // socket file actually exists.
    this.stopHealthCheck(projectId)
    if (!auto) this.cancelPendingAutoReconnect(projectId)
    this.cancelTunnelRetry(projectId)
    const socketPath = this.getSocketPath(projectId)
    if (fs.existsSync(socketPath)) {
      try {
        await this.execFileAsync('ssh', this.buildExitArgs(projectId, config), { timeout: 5000 })
      } catch { /* master may already be dead */ }
      // `-O exit` can fail, time out, or even report success while the master
      // process is still alive. Unlinking the socket then *orphans* it: the
      // master keeps holding this project's local tunnel port, and no later
      // `-O exit` can ever reach it again because the socket it listened on is
      // gone. Every subsequent connect then fails at the `-L` forward with
      // "Port forwarding failed" and sits in 'connecting' forever. So never
      // trust the exit — verify with `-O check` and kill by pid while the
      // socket, and therefore `-O check`, still reaches it.
      await this.killMasterByPid(projectId, config)
      try { fs.unlinkSync(socketPath) } catch { /* may not exist */ }
    }

    // Reap masters the socket can no longer reach. Runs unconditionally — the
    // case that matters most is precisely the one where there is *no* socket
    // file, because an earlier connect unlinked it out from under a master that
    // is still alive and still bound to the tunnel port. We are about to spawn a
    // fresh master, so every process still holding this socket path is stale by
    // definition.
    await this.killStrayMasters(projectId)

    this.setStatus(projectId, 'connecting')
    this.configs.set(projectId, config)

    try {
      // Step 1: Establish ControlMaster connection (forks to background)
      const masterArgs = this.buildMasterArgs(projectId, config)
      await this.execFileAsync('ssh', masterArgs, { timeout: 30000 })

      // Step 2: Add dynamic remote port forwarding via -O forward.
      // This prints the allocated port to stdout reliably.
      const forwardArgs = this.buildForwardArgs(projectId, config)
      const { stdout } = await this.execFileAsync('ssh', forwardArgs, { timeout: 10000 })

      // Parse the allocated port from stdout.
      // `-O forward` may output "Allocated port XXXXX ..." or just the port number.
      const portMatch = stdout.match(/Allocated port (\d+)/) || stdout.trim().match(/^(\d+)$/)
      if (!portMatch) {
        await this.execFileAsync('ssh', this.buildExitArgs(projectId, config), { timeout: 5000 }).catch(() => {})
        this.setStatus(projectId, 'disconnected')
        this.configs.delete(projectId)
        throw new Error('SSH master connected but remote port forwarding was not allocated — stdout: ' + stdout.slice(0, 200))
      }
      this.setRemotePort(projectId, parseInt(portMatch[1], 10))
      this.autoReconnectEnabled.add(projectId)
      this.autoReconnectAttempts.delete(projectId)

      // Step 3: restore the configured local forward *before* announcing
      // 'connected'. Anyone who sees 'connected' must be able to rely on the
      // tunnel actually being up — otherwise an automatic recovery silently
      // leaves the user with a dead forward they believe is working.
      const tunnel = this.desiredTunnels.get(projectId)
      if (tunnel) {
        try {
          await this.applyTunnel(projectId, config, tunnel)
        } catch (tunnelErr) {
          // The master is alive but the connection is not in its configured
          // state, so we stay 'connecting' and keep retrying the forward on the
          // same backoff cadence auto-reconnect uses. The reason is surfaced
          // through the tunnel state.
          const message = tunnelErr instanceof Error ? tunnelErr.message : String(tunnelErr)
          this.tunnels.delete(projectId)
          this.setTunnelState(projectId, 'error', message)
          this.scheduleTunnelRetry(projectId, config)
          return
        }
      }
      this.setStatus(projectId, 'connected')
    } catch (err) {
      this.setStatus(projectId, 'disconnected')
      this.configs.delete(projectId)
      // If a previous session had succeeded, user hasn't explicitly disconnected,
      // and this attempt failed — keep trying in the background.
      if (this.autoReconnectEnabled.has(projectId)) {
        this.scheduleAutoReconnect(projectId, config)
      }
      throw err
    }
  }

  async disconnect(projectId: string, config: SshConfig): Promise<void> {
    this.stopHealthCheck(projectId)
    await this.stopSocksProxy(projectId)
    this.clearTunnelRuntime(projectId)
    const args = this.buildExitArgs(projectId, config)
    try {
      await this.execFileAsync('ssh', args, { timeout: 5000 })
    } catch {
      // Best-effort cleanup
    }
    const socketPath = this.getSocketPath(projectId)
    try { fs.unlinkSync(socketPath) } catch { /* may not exist */ }
    this.clearProject(projectId)
  }

  /** Bring up a local forward through the existing master socket. Shared by the
   *  renderer-driven `setTunnel` and by the connect/reconnect path, so both
   *  establish the tunnel exactly the same way. */
  private async applyTunnel(projectId: string, config: SshConfig, tunnel: TunnelConfig): Promise<void> {
    try {
      await this.execFileAsync('ssh', this.buildTunnelForwardArgs(projectId, config, tunnel), { timeout: 10000 })
    } catch (err) {
      throw new Error(describeTunnelFailure(err, tunnel))
    }
    this.tunnels.set(projectId, tunnel)
    this.setTunnelState(projectId, 'active')
  }

  async setTunnel(projectId: string, config: SshConfig, tunnel: TunnelConfig | null): Promise<void> {
    if (this.getStatus(projectId) !== 'connected') {
      throw new Error('SSH connection not established')
    }

    this.cancelTunnelRetry(projectId)
    const previousTunnel = this.tunnels.get(projectId)
    if (previousTunnel) {
      try {
        await this.execFileAsync('ssh', this.buildTunnelCancelArgs(projectId, config, previousTunnel), { timeout: 5000 })
      } catch {
        // Best-effort cleanup before replacing the forward.
      }
      this.tunnels.delete(projectId)
    }

    if (!tunnel) {
      this.desiredTunnels.delete(projectId)
      this.clearTunnelRuntime(projectId)
      return
    }

    this.desiredTunnels.set(projectId, tunnel)
    try {
      await this.applyTunnel(projectId, config, tunnel)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setTunnelState(projectId, 'error', message)
      throw new Error(`Failed to establish tunnel: ${message}`)
    }
  }

  async readRemoteFile(projectId: string, config: SshConfig, relativePath: string): Promise<string | null> {
    const status = this.getStatus(projectId)
    if (status !== 'connected') {
      const err = new Error('ssh-not-connected') as Error & { code?: string }
      err.code = 'SSH_NOT_CONNECTED'
      throw err
    }
    const args = buildReadRemoteFileArgs(this.socketDir, projectId, config, relativePath)
    try {
      const { stdout } = await this.execFileAsync('ssh', args, { timeout: 10000 })
      return stdout
    } catch (err: any) {
      if (err && typeof err === 'object' && (err.code === 1 || err.code === 2)) return null
      if (typeof err?.stderr === 'string' && /No such file/i.test(err.stderr)) return null
      throw err
    }
  }

  /** Last-resort teardown for a ControlMaster that ignored `-O exit`. `-O check`
   *  reports "Master running (pid=NNNN)" (on stderr for older OpenSSH), which is
   *  the only handle we have on a process that was forked with `-f`. */
  private async killMasterByPid(projectId: string, config: SshConfig): Promise<void> {
    let output: string
    try {
      const { stdout, stderr } = await this.execFileAsync('ssh', this.buildCheckArgs(projectId, config), { timeout: 5000 })
      output = stdout + stderr
    } catch (err: any) {
      // A non-zero exit means no master answered — nothing left to kill.
      output = typeof err?.stderr === 'string' ? err.stderr : ''
      if (!/Master running/.test(output)) return
    }
    const match = output.match(/pid=(\d+)/)
    if (!match) return
    await this.terminate(parseInt(match[1], 10))
  }

  /** Kill any ControlMaster still running against this project's socket path,
   *  including ones whose socket file is already gone. See `parseMasterPids`. */
  private async killStrayMasters(projectId: string): Promise<void> {
    let stdout: string
    try {
      ;({ stdout } = await this.execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 5000 }))
    } catch {
      return // No process list — nothing we can do beyond the socket-based path.
    }
    for (const pid of parseMasterPids(stdout, this.getSocketPath(projectId))) {
      await this.terminate(pid)
    }
  }

  /** SIGTERM a pid and wait for it to actually exit, so the tunnel port and
   *  sockets it held are free before we spawn its replacement — otherwise the
   *  new master can lose a race with the dying one and fail its `-L` forward. */
  private async terminate(pid: number, timeoutMs = 2000): Promise<void> {
    try { process.kill(pid, 'SIGTERM') } catch { return /* already gone */ }
    const deadline = timeoutMs / 100
    for (let i = 0; i < deadline; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { process.kill(pid, 0) } catch { return }
    }
  }

  async checkConnection(projectId: string, config: SshConfig): Promise<boolean> {
    const args = this.buildCheckArgs(projectId, config)
    try {
      await this.execFileAsync('ssh', args, { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  private healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>()

  private connectionProbes = new Map<string, Promise<boolean>>()

  /** Short-circuit the 10s health check poll when a slave PTY printed
   *  "Shared connection to ... closed". That message is NOT proof the tunnel
   *  died — ssh prints it on every mux-slave exit, including a remote command
   *  simply finishing or failing (e.g. "exec: pi: not found"). Tearing down
   *  unconditionally turns any fast-exiting remote command into an infinite
   *  gray-out/reconnect/respawn loop. So first verify end to end (see
   *  `verifyConnection`), and only tear down if that fails. */
  triggerReconnect(projectId: string, config: SshConfig): void {
    void this.verifyConnection(projectId, config)
  }

  /** Probe a project we believe is connected with a real `true` through the
   *  control socket. `-O check` isn't enough: it only asks the local master
   *  process, and that process outlives its TCP connection — after the machine
   *  wakes from sleep it keeps answering `-O check` while every new session
   *  through it fails with exit 255. On failure the connection is torn down and
   *  Layer 2 auto-reconnect takes over; a caller that connects right away
   *  supersedes the pending retry. Concurrent calls share one probe. Resolves
   *  false when the project isn't (or is no longer) connected. */
  verifyConnection(projectId: string, config: SshConfig): Promise<boolean> {
    if (this.getStatus(projectId) !== 'connected') return Promise.resolve(false)
    const pending = this.connectionProbes.get(projectId)
    if (pending) return pending
    const probe = this.probeConnection(projectId, config).finally(() => {
      this.connectionProbes.delete(projectId)
    })
    this.connectionProbes.set(projectId, probe)
    return probe
  }

  /** `verifyConnection` for every connected project — run when the machine wakes. */
  verifyAll(): void {
    for (const [projectId, config] of this.getConnectedProjects()) {
      void this.verifyConnection(projectId, config)
    }
  }

  private async probeConnection(projectId: string, config: SshConfig): Promise<boolean> {
    try {
      await this.execFileAsync('ssh', this.buildProbeArgs(projectId, config), { timeout: 5000 })
      // Master answered end-to-end — the connection is fine.
      return true
    } catch {
      if (this.getStatus(projectId) !== 'connected') return false
      this.stopHealthCheck(projectId)
      this.clearTunnelRuntime(projectId)
      this.setStatus(projectId, 'disconnected')
      if (this.autoReconnectEnabled.has(projectId)) {
        this.scheduleAutoReconnect(projectId, config)
      }
      return false
    }
  }

  startHealthChecks(projectId: string, config: SshConfig, intervalMs = 10000): void {
    this.stopHealthCheck(projectId)
    const timer = setInterval(async () => {
      if (this.getStatus(projectId) !== 'connected') {
        this.stopHealthCheck(projectId)
        return
      }
      const ok = await this.checkConnection(projectId, config)
      if (!ok) {
        this.clearTunnelRuntime(projectId)
        this.setStatus(projectId, 'disconnected')
        this.stopHealthCheck(projectId)
        if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config)
        }
      }
    }, intervalMs)
    this.healthCheckTimers.set(projectId, timer)
  }

  /** Schedule an auto-reconnect attempt with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s).
   *  Chains on failure; stops when the connect succeeds or auto-reconnect is cancelled
   *  (explicit disconnect, clearProject, or a competing manual connect). */
  private scheduleAutoReconnect(projectId: string, config: SshConfig): void {
    if (this.autoReconnectTimers.has(projectId)) return
    const attempts = this.autoReconnectAttempts.get(projectId) ?? 0
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000)
    const timer = setTimeout(async () => {
      this.autoReconnectTimers.delete(projectId)
      if (!this.autoReconnectEnabled.has(projectId)) return
      this.autoReconnectAttempts.set(projectId, attempts + 1)
      try {
        await this.connectWith(projectId, config, undefined, true)
        if (this.getStatus(projectId) === 'connected') {
          this.autoReconnectAttempts.delete(projectId)
          this.startHealthChecks(projectId, config)
        } else if (this.tunnelRetryTimers.has(projectId)) {
          // Master is back but the configured forward isn't up yet — the tunnel
          // retry owns recovery from here (and hands back if the master dies).
          this.autoReconnectAttempts.delete(projectId)
        } else if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config)
        }
      } catch {
        if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config)
        }
      }
    }, delay)
    this.autoReconnectTimers.set(projectId, timer)
  }

  /** Retry a configured local forward that failed to come up after the master
   *  connected, on the same exponential backoff as auto-reconnect. The project
   *  stays 'connecting' until the forward is live: the master is usable, but the
   *  connection is not in the state the user configured, so callers must not
   *  treat it as fully connected. */
  private scheduleTunnelRetry(projectId: string, config: SshConfig): void {
    if (this.tunnelRetryTimers.has(projectId)) return
    const attempts = this.tunnelRetryAttempts.get(projectId) ?? 0
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000)
    const timer = setTimeout(async () => {
      this.tunnelRetryTimers.delete(projectId)
      const tunnel = this.desiredTunnels.get(projectId)
      if (!tunnel || !this.autoReconnectEnabled.has(projectId)) return
      if (this.getStatus(projectId) === 'connected') return
      this.tunnelRetryAttempts.set(projectId, attempts + 1)

      // The master can die while we retry the forward — hand back to the full
      // reconnect path when it does, instead of retrying a forward forever
      // against a dead socket.
      const masterAlive = await this.checkConnection(projectId, config)
      if (!masterAlive) {
        this.cancelTunnelRetry(projectId)
        this.setStatus(projectId, 'disconnected')
        if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config)
        }
        return
      }

      try {
        await this.applyTunnel(projectId, config, tunnel)
        this.tunnelRetryAttempts.delete(projectId)
        this.setStatus(projectId, 'connected')
        this.startHealthChecks(projectId, config)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.setTunnelState(projectId, 'error', message)
        this.scheduleTunnelRetry(projectId, config)
      }
    }, delay)
    this.tunnelRetryTimers.set(projectId, timer)
  }

  private cancelTunnelRetry(projectId: string): void {
    const timer = this.tunnelRetryTimers.get(projectId)
    if (timer) {
      clearTimeout(timer)
      this.tunnelRetryTimers.delete(projectId)
    }
    this.tunnelRetryAttempts.delete(projectId)
  }

  /** Cancel a pending auto-reconnect timer but keep the intent to auto-reconnect.
   *  Used when a manual connect is starting — we don't want a stale timer to race,
   *  but we do want auto-reconnect to resume if the manual attempt itself fails. */
  private cancelPendingAutoReconnect(projectId: string): void {
    const timer = this.autoReconnectTimers.get(projectId)
    if (timer) {
      clearTimeout(timer)
      this.autoReconnectTimers.delete(projectId)
    }
    this.autoReconnectAttempts.delete(projectId)
  }

  /** Fully stop auto-reconnect for a project — used on explicit disconnect. */
  private cancelAutoReconnect(projectId: string): void {
    this.autoReconnectEnabled.delete(projectId)
    this.cancelPendingAutoReconnect(projectId)
  }

  private stopHealthCheck(projectId: string): void {
    const timer = this.healthCheckTimers.get(projectId)
    if (timer) {
      clearInterval(timer)
      this.healthCheckTimers.delete(projectId)
    }
  }

  stopHealthChecks(): void {
    for (const projectId of [...this.healthCheckTimers.keys()]) {
      this.stopHealthCheck(projectId)
    }
  }

  async disconnectAll(): Promise<void> {
    this.stopHealthChecks()
    const entries = [...this.configs.entries()]
    await Promise.allSettled(
      entries.map(([projectId, config]) => this.disconnect(projectId, config))
    )
  }
}
