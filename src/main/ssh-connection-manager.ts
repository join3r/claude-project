import { EventEmitter } from 'events'
import { execFile, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import type { SshConfig, TunnelConfig, TunnelState, TunnelStatus } from '../shared/types'

export type SshStatus = 'disconnected' | 'connecting' | 'connected'

/** Shell-quote a value for safe interpolation into a remote shell command */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** POSIX-join a remote base dir with a relative path */
export function joinRemotePath(remoteDir: string, relative: string): string {
  if (!remoteDir) return relative
  return remoteDir.replace(/\/+$/, '') + '/' + relative.replace(/^\/+/, '')
}

/** Compute the ControlMaster socket path for a given socketDir + projectId */
export function controlSocketPath(socketDir: string, projectId: string): string {
  return path.join(socketDir, `${projectId}.sock`)
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
  const args = ['-S', sock, '-o', 'ControlMaster=no', '-p', port]
  if (config.keyFile) args.push('-i', config.keyFile)
  args.push(userHost, 'cat', '--', shellQuote(remotePath))
  return args
}

export class SshConnectionManager extends EventEmitter {
  private socketDir: string
  private hookPort: number
  private statuses = new Map<string, SshStatus>()
  private remotePorts = new Map<string, number>()
  private configs = new Map<string, SshConfig>()
  private tunnels = new Map<string, TunnelConfig>()
  private tunnelStates = new Map<string, TunnelState>()
  private socksProxies = new Map<string, { port: number; process: ChildProcess }>()
  private socksStartPromises = new Map<string, Promise<number>>()
  private connectLocks = new Map<string, Promise<void>>()
  private autoReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private autoReconnectAttempts = new Map<string, number>()
  private autoReconnectEnabled = new Set<string>()

  /** Promisified execFile that always returns { stdout, stderr } */
  private execFileAsync(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout: stdout as string, stderr: stderr as string })
      })
    })
  }

  constructor(socketDir: string, hookPort: number) {
    super()
    this.socketDir = socketDir
    this.hookPort = hookPort
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

  private clearTunnelRuntime(projectId: string): void {
    this.tunnels.delete(projectId)
    this.tunnelStates.delete(projectId)
    this.emit('tunnel-status-changed', projectId, 'inactive', undefined)
  }

  clearProject(projectId: string): void {
    this.cancelAutoReconnect(projectId)
    this.statuses.delete(projectId)
    this.remotePorts.delete(projectId)
    this.configs.delete(projectId)
    this.tunnels.delete(projectId)
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
      '-o', 'StrictHostKeyChecking=accept-new',
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
      '-o', 'StrictHostKeyChecking=accept-new',
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
      ...this.buildBaseArgs(projectId, config),
      '-t',
      `${config.username}@${config.host}`
    ]
    const envPrefix = envVars
      ? Object.entries(envVars).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ') + ' '
      : ''
    const cmdSuffix = commandArgs?.length ? ' ' + commandArgs.map(a => shellQuote(a)).join(' ') : ''
    const prefix = commandPrefix || ''
    const cwd = cwdOverride || config.remoteDir
    // Wrap in an interactive login shell (-l -i). Login alone is not enough:
    // non-interactive bash skips ~/.bashrc (and Ubuntu's ~/.bashrc early-returns
    // for non-interactive shells), so PATH additions from nvm/cargo/local bin
    // never apply and commands like `pi` come back "not found" even though they
    // work in a normal terminal. We always allocate a tty (-t), so interactive
    // matches what the user's own ssh session would get.
    const innerCmd = `${prefix}cd ${shellQuote(cwd)} && ${envPrefix}exec ${command}${cmdSuffix}`
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
      '-o', 'StrictHostKeyChecking=accept-new',
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
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    // Catch spawn errors (e.g. ENOENT if ssh binary not found) to prevent
    // unhandled error events from crashing the Electron main process.
    let spawnError: Error | null = null
    child.on('error', (err: Error) => { spawnError = err })

    try {
      await this.waitForPort(port)
    } catch {
      child.kill()
      if (spawnError) {
        throw new Error(`Failed to spawn ssh: ${spawnError.message}`)
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

  async connect(projectId: string, config: SshConfig): Promise<void> {
    // Serialize per-project: if a connect is already in progress, wait for it
    // then check status — avoids a second call's cleanup killing the master
    // that the first call just established (race on app startup with multiple
    // windows sharing the same remote project).
    const existing = this.connectLocks.get(projectId)
    if (existing) {
      await existing.catch(() => {})
      if (this.getStatus(projectId) === 'connected') return
    }

    const promise = this.doConnect(projectId, config)
    this.connectLocks.set(projectId, promise)
    try {
      await promise
    } finally {
      if (this.connectLocks.get(projectId) === promise) {
        this.connectLocks.delete(projectId)
      }
    }
  }

  private async doConnect(projectId: string, config: SshConfig): Promise<void> {
    if (!fs.existsSync(this.socketDir)) {
      fs.mkdirSync(this.socketDir, { recursive: true })
    }

    // Clean up stale ControlMaster socket from a previous (dead) connection.
    // Without this, ssh -M will refuse to create a new master or connect
    // through the dead socket, leaving the session stuck. `ssh -O exit`
    // operates through the control socket, so only attempt it when the
    // socket file actually exists.
    this.stopHealthCheck(projectId)
    this.cancelPendingAutoReconnect(projectId)
    const socketPath = this.getSocketPath(projectId)
    if (fs.existsSync(socketPath)) {
      try {
        await this.execFileAsync('ssh', this.buildExitArgs(projectId, config), { timeout: 5000 })
      } catch { /* master may already be dead */ }
      try { fs.unlinkSync(socketPath) } catch { /* may not exist */ }
    }

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
      this.setStatus(projectId, 'connected')
      this.autoReconnectEnabled.add(projectId)
      this.autoReconnectAttempts.delete(projectId)
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

  async setTunnel(projectId: string, config: SshConfig, tunnel: TunnelConfig | null): Promise<void> {
    if (this.getStatus(projectId) !== 'connected') {
      throw new Error('SSH connection not established')
    }

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
      this.clearTunnelRuntime(projectId)
      return
    }

    try {
      await this.execFileAsync('ssh', this.buildTunnelForwardArgs(projectId, config, tunnel), { timeout: 10000 })
      this.tunnels.set(projectId, tunnel)
      this.setTunnelState(projectId, 'active')
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

  private reconnectProbes = new Set<string>()

  /** Short-circuit the 10s health check poll when a slave PTY printed
   *  "Shared connection to ... closed". That message is NOT proof the tunnel
   *  died — ssh prints it on every mux-slave exit, including a remote command
   *  simply finishing or failing (e.g. "exec: pi: not found"). Tearing down
   *  unconditionally turns any fast-exiting remote command into an infinite
   *  gray-out/reconnect/respawn loop. So first verify with an end-to-end probe
   *  through the control socket (a real `true` over the master's TCP — `-O
   *  check` isn't enough because the master process can outlive its dead TCP
   *  connection). Only if the probe fails do we tear down and let Layer 2
   *  auto-reconnect take over. */
  triggerReconnect(projectId: string, config: SshConfig): void {
    if (this.getStatus(projectId) !== 'connected') return
    if (this.reconnectProbes.has(projectId)) return
    this.reconnectProbes.add(projectId)
    void this.probeThenReconnect(projectId, config)
  }

  private async probeThenReconnect(projectId: string, config: SshConfig): Promise<void> {
    try {
      await this.execFileAsync('ssh', this.buildProbeArgs(projectId, config), { timeout: 5000 })
      // Master answered end-to-end — the "connection closed" was a normal
      // slave exit, not a dead tunnel. Leave the connection alone.
    } catch {
      if (this.getStatus(projectId) !== 'connected') return
      this.stopHealthCheck(projectId)
      this.clearTunnelRuntime(projectId)
      this.setStatus(projectId, 'disconnected')
      if (this.autoReconnectEnabled.has(projectId)) {
        this.scheduleAutoReconnect(projectId, config)
      }
    } finally {
      this.reconnectProbes.delete(projectId)
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
        await this.connect(projectId, config)
        if (this.getStatus(projectId) === 'connected') {
          this.autoReconnectAttempts.delete(projectId)
          this.startHealthChecks(projectId, config)
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
