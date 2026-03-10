import * as pty from 'node-pty'
import { getShellEnv } from './shell-env'

interface PtyInstance {
  process: pty.IPty
  projectDir: string
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()

  spawn(id: string, shell: string, cwd: string, cols: number, rows: number, args?: string[], extraEnv?: Record<string, string>): void {
    if (this.instances.has(id)) {
      this.kill(id)
    }
    const proc = pty.spawn(shell, args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...getShellEnv(), ...extraEnv }
    })
    this.instances.set(id, { process: proc, projectDir: cwd })
  }

  write(id: string, data: string): void {
    this.instances.get(id)?.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.instances.get(id)?.process.resize(cols, rows)
    } catch {
      // Process already exited, fd is closed — ignore
    }
  }

  onData(id: string, callback: (data: string) => void): void {
    this.instances.get(id)?.process.onData(callback)
  }

  onExit(id: string, callback: (exitCode: number) => void): void {
    this.instances.get(id)?.process.onExit(({ exitCode }) => callback(exitCode))
  }

  kill(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.process.kill()
      this.instances.delete(id)
    }
  }

  killAll(): void {
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }
}
