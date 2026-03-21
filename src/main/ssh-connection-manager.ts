import { EventEmitter } from 'events'
import { execFile, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import type { SshConfig, TunnelConfig, TunnelState, TunnelStatus } from '../shared/types'

export type SshStatus = 'disconnected' | 'connecting' | 'connected'

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
    return path.join(this.socketDir, `${projectId}.sock`)
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

  /** Shell-quote a value for safe interpolation into a remote shell command */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
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
    commandPrefix?: string
  ): string[] {
    const args = [
      ...this.buildBaseArgs(projectId, config),
      '-t',
      `${config.username}@${config.host}`
    ]
    const envPrefix = envVars
      ? Object.entries(envVars).map(([k, v]) => `${k}=${this.shellQuote(v)}`).join(' ') + ' '
      : ''
    const cmdSuffix = commandArgs?.length ? ' ' + commandArgs.map(a => this.shellQuote(a)).join(' ') : ''
    const prefix = commandPrefix || ''
    // Wrap in login shell so the user's profile is sourced (PATH, etc.)
    const innerCmd = `${prefix}cd ${this.shellQuote(config.remoteDir)} && ${envPrefix}exec ${command}${cmdSuffix}`
    args.push(`bash -l -c ${this.shellQuote(innerCmd)}`)
    return args
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
    if (!fs.existsSync(this.socketDir)) {
      fs.mkdirSync(this.socketDir, { recursive: true })
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
    } catch (err) {
      this.setStatus(projectId, 'disconnected')
      this.configs.delete(projectId)
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
      }
    }, intervalMs)
    this.healthCheckTimers.set(projectId, timer)
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
