import { createHash } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import type { ServerPaths } from './server-env'

/**
 * The CLI's line to a running server: a Unix socket in `<home>/run` (0700), one
 * JSON request and one JSON answer per connection. `devtool-server pair` has to go
 * through the daemon, because the relay allows one socket per identity.
 */

/** Unix socket paths are capped near 104 bytes; a long home gets one under a 0700 dir in the temp dir. */
export function controlSocketPath(paths: ServerPaths): string {
  const inRun = path.join(paths.runDir, 'control.sock')
  if (Buffer.byteLength(inRun) < 100) return inRun
  const hash = createHash('sha256').update(path.resolve(paths.home)).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `devtool-server-${os.userInfo().uid}`, `${hash}.sock`)
}

export interface ControlRequest {
  cmd: string
  [key: string]: unknown
}

export type ControlHandler = (request: ControlRequest) => Promise<unknown>

const MAX_REQUEST_BYTES = 64 * 1024

export class ControlServer {
  private server: net.Server | null = null

  constructor(private readonly socketPath: string, private readonly handler: ControlHandler, private readonly log: (message: string) => void) {}

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.socketPath), 0o700)
    // A socket left by a server that died: the instance lock says nobody else runs.
    fs.rmSync(this.socketPath, { force: true })
    const server = net.createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    fs.chmodSync(this.socketPath, 0o600)
    server.on('error', (err) => this.log(`control error=${err.message}`))
    this.server = server
  }

  close(): void {
    this.server?.close()
    this.server = null
    fs.rmSync(this.socketPath, { force: true })
  }

  private serve(socket: net.Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      socket.removeAllListeners('data')
      let request: ControlRequest
      try {
        request = JSON.parse(line) as ControlRequest
        if (typeof request?.cmd !== 'string') throw new Error('no cmd')
      } catch {
        socket.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n')
        return
      }
      this.handler(request).then(
        (result) => socket.end(JSON.stringify({ ok: true, result: result ?? null }) + '\n'),
        (err: unknown) => socket.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
      )
    })
  }
}

/** Thrown when no server answers on the socket. */
export class NotRunningError extends Error {
  constructor() {
    super('The DevTool server is not running')
    this.name = 'NotRunningError'
  }
}

export function controlRequest(socketPath: string, request: ControlRequest, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The DevTool server did not answer'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => { buffer += chunk })
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? new NotRunningError() : err)
    })
    socket.on('end', () => {
      clearTimeout(timer)
      try {
        const answer = JSON.parse(buffer) as { ok: boolean; result?: unknown; error?: string }
        if (answer.ok) resolve(answer.result)
        else reject(new Error(answer.error ?? 'failed'))
      } catch {
        reject(new Error('The DevTool server sent an unreadable answer'))
      }
    })
  })
}
