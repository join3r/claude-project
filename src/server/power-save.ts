import { spawn as spawnProcess, type ChildProcess } from 'child_process'
import type { PowerSaveApi } from '../main/sleep-blocker'

type Spawn = (file: string, args: string[]) => ChildProcess

/**
 * The command that holds off system sleep for as long as it runs, and exits on
 * its own once process `pid` is gone (so a killed server leaves no blocker):
 * `caffeinate` on macOS, `systemd-inhibit` on Linux. Null elsewhere.
 */
export function inhibitorCommand(platform: NodeJS.Platform, pid: number): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)] }
  if (platform === 'linux') {
    return {
      file: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=DevTool server', '--why=An agent is working', '--mode=block',
        'tail', `--pid=${pid}`, '-f', '/dev/null']
    }
  }
  return null
}

export interface ProcessPowerSaveOptions {
  platform?: NodeJS.Platform
  pid?: number
  spawn?: Spawn
  log?: (message: string) => void
}

/**
 * {@link PowerSaveApi} without Electron: each blocker is a child process running
 * {@link inhibitorCommand}. Where that is missing or refused (no systemd, no
 * logind permission for a user without a session) it logs once and blocks
 * nothing, which on a server that never suspends is no loss.
 */
export class ProcessPowerSave implements PowerSaveApi {
  private readonly holders = new Map<number, ChildProcess>()
  private nextId = 1
  private unavailable = false
  private readonly command: { file: string; args: string[] } | null
  private readonly spawn: Spawn
  private readonly log: (message: string) => void

  constructor(options: ProcessPowerSaveOptions = {}) {
    this.command = inhibitorCommand(options.platform ?? process.platform, options.pid ?? process.pid)
    this.spawn = options.spawn ?? ((file, args) => spawnProcess(file, args, { stdio: 'ignore' }))
    this.log = options.log ?? (() => {})
  }

  start(_type: 'prevent-app-suspension'): number {
    const id = this.nextId++
    const command = this.command
    if (!command || this.unavailable) return id
    let child: ChildProcess
    try {
      child = this.spawn(command.file, command.args)
    } catch (err) {
      this.giveUp(`${command.file} failed to start: ${err instanceof Error ? err.message : String(err)}`)
      return id
    }
    this.holders.set(id, child)
    child.on('error', (err) => {
      if (this.holders.get(id) === child) this.holders.delete(id)
      this.giveUp(`${command.file} failed: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      // Still ours, so not stopped: it gave up by itself (no systemd, access denied).
      if (this.holders.get(id) !== child) return
      this.holders.delete(id)
      this.giveUp(`${command.file} exited code=${code ?? ''} signal=${signal ?? ''}`)
    })
    return id
  }

  stop(id: number): void {
    const child = this.holders.get(id)
    this.holders.delete(id)
    child?.kill()
  }

  isStarted(id: number): boolean {
    return this.holders.has(id)
  }

  private giveUp(reason: string): void {
    if (this.unavailable) return
    this.unavailable = true
    this.log(`powerSave unavailable (${reason}); sleep is not blocked while agents work`)
  }
}
