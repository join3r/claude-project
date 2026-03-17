import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

export type SshStatus = 'disconnected' | 'connecting' | 'connected'

interface SshConfig {
  host: string
  port: number
  username: string
  keyFile?: string
  remoteDir: string
}

export class SshConnectionManager extends EventEmitter {
  private socketDir: string
  private hookPort: number
  private statuses = new Map<string, SshStatus>()
  private remotePorts = new Map<string, number>()
  private configs = new Map<string, SshConfig>()

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

  clearProject(projectId: string): void {
    this.statuses.delete(projectId)
    this.remotePorts.delete(projectId)
    this.configs.delete(projectId)
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
