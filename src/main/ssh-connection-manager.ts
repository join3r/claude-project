import { EventEmitter } from 'events'
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
    args.push(`${prefix}cd ${this.shellQuote(config.remoteDir)} && exec ${envPrefix}${command}${cmdSuffix}`)
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

  // Stubs — filled in by later tasks. No-op until then so Task 2 type-checks.
  stopHealthChecks(): void { /* implemented in Task 4 */ }
  async disconnect(_projectId: string, _config: SshConfig): Promise<void> { /* implemented in Task 3 */ }

  async disconnectAll(): Promise<void> {
    this.stopHealthChecks()
    const entries = [...this.configs.entries()]
    await Promise.allSettled(
      entries.map(([projectId, config]) => this.disconnect(projectId, config))
    )
  }
}
