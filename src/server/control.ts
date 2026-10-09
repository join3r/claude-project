import { createHash } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from '../main/atomic-write'
import type { ServerPaths } from './server-env'

/**
 * The CLI's line to a running server: a Unix socket, one JSON request and one JSON
 * answer per connection. `devtool-server pair` has to go through the daemon,
 * because the relay allows one socket per identity.
 *
 * Whoever answers on this socket hands out pairing codes, so it must be ours. The
 * server puts it in a private dir, in this order:
 *   1. `$XDG_RUNTIME_DIR` (per-user, 0700, made by the login manager),
 *   2. `<home>/run` (0700) when the path fits a socket address,
 *   3. a fresh `mkdtemp` dir (0700) in the temp dir,
 * and records the choice in `<home>/run/control-socket`. Both ends check with
 * `lstat` (never following a symlink) that the dir and the socket belong to this
 * user with no group or other access, and refuse otherwise.
 */

/** Unix socket addresses are capped near 104 bytes (macOS); keep a margin. */
const MAX_SOCKET_PATH = 100
const SOCKET_NAME = 'control.sock'

export class UnsafeControlSocketError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeControlSocketError'
  }
}

/** Thrown when no server answers on the socket (or none recorded one). */
export class NotRunningError extends Error {
  constructor() {
    super('The DevTool server is not running')
    this.name = 'NotRunningError'
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function describeMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`
}

/** `dir` is a real directory (not a symlink), owned by `uid`, with no group or other access. */
export function assertPrivateDir(dir: string, uid: number | null = currentUid()): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch (err) {
    throw new UnsafeControlSocketError(`${dir} is not there: ${(err as Error).message}`)
  }
  if (stat.isSymbolicLink()) throw new UnsafeControlSocketError(`${dir} is a symlink; refusing to use it for the control socket`)
  if (!stat.isDirectory()) throw new UnsafeControlSocketError(`${dir} is not a directory`)
  if (uid !== null && stat.uid !== uid) throw new UnsafeControlSocketError(`${dir} belongs to uid ${stat.uid}, not to you (uid ${uid}); refusing to use it`)
  if ((stat.mode & 0o077) !== 0) throw new UnsafeControlSocketError(`${dir} is open to other users (mode ${describeMode(stat.mode)}); it must be 0700`)
}

/** `file` is a socket (not a symlink), owned by `uid`, with no group or other access. */
export function assertPrivateSocket(file: string, uid: number | null = currentUid()): void {
  const stat = fs.lstatSync(file)
  if (!stat.isSocket()) throw new UnsafeControlSocketError(`${file} is not a socket`)
  if (uid !== null && stat.uid !== uid) throw new UnsafeControlSocketError(`${file} belongs to uid ${stat.uid}, not to you (uid ${uid}); refusing to talk to it`)
  if ((stat.mode & 0o077) !== 0) throw new UnsafeControlSocketError(`${file} is open to other users (mode ${describeMode(stat.mode)})`)
}

/** `<home>/run/control-socket`: where the running server put its socket. */
export function controlRecordFile(paths: ServerPaths): string {
  return path.join(paths.runDir, 'control-socket')
}

/** `<home>/run`, created 0700; one that exists must be ours (a too open one of ours is closed). */
export function ensurePrivateRunDir(paths: ServerPaths, uid: number | null = currentUid()): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(paths.runDir)
  if (!stat.isSymbolicLink() && stat.isDirectory() && (uid === null || stat.uid === uid) && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(paths.runDir, 0o700)
  }
  assertPrivateDir(paths.runDir, uid)
}

function fits(socketPath: string): boolean {
  return Buffer.byteLength(socketPath) < MAX_SOCKET_PATH
}

/**
 * The server's pick of a socket path (see the module comment). The temp-dir
 * fallback is a fresh `mkdtemp` dir, so nobody can have prepared it.
 */
export function chooseControlSocket(paths: ServerPaths, env: NodeJS.ProcessEnv = process.env, uid: number | null = currentUid()): { socket: string; ownDir: boolean } {
  const runtime = env.XDG_RUNTIME_DIR?.trim()
  if (runtime && path.isAbsolute(runtime)) {
    const hash = createHash('sha256').update(path.resolve(paths.home)).digest('hex').slice(0, 12)
    const socket = path.join(runtime, `devtool-server-${hash}.sock`)
    try {
      assertPrivateDir(runtime, uid)
      if (fits(socket)) return { socket, ownDir: false }
    } catch {
      // Not usable: fall through.
    }
  }
  const inRun = path.join(paths.runDir, SOCKET_NAME)
  if (fits(inRun)) return { socket: inRun, ownDir: false }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-server-'))
  fs.chmodSync(dir, 0o700)
  return { socket: path.join(dir, SOCKET_NAME), ownDir: true }
}

/**
 * The CLI's side: the socket the running server recorded, after checking the record,
 * the socket's dir and the socket itself. NotRunningError when there is no record or
 * no socket; UnsafeControlSocketError when anything is not private to this user.
 */
export function findControlSocket(paths: ServerPaths, uid: number | null = currentUid()): string {
  const record = controlRecordFile(paths)
  try {
    fs.lstatSync(paths.runDir)
  } catch {
    throw new NotRunningError()
  }
  assertPrivateDir(paths.runDir, uid)
  let socket: string
  try {
    const stat = fs.lstatSync(record)
    if (!stat.isFile()) throw new UnsafeControlSocketError(`${record} is not a regular file`)
    if (uid !== null && stat.uid !== uid) throw new UnsafeControlSocketError(`${record} belongs to uid ${stat.uid}, not to you`)
    socket = fs.readFileSync(record, 'utf8').trim()
  } catch (err) {
    if (err instanceof UnsafeControlSocketError) throw err
    throw new NotRunningError()
  }
  if (!path.isAbsolute(socket)) throw new UnsafeControlSocketError(`${record} names no absolute socket path`)
  assertPrivateDir(path.dirname(socket), uid)
  try {
    fs.lstatSync(socket)
  } catch {
    throw new NotRunningError()
  }
  assertPrivateSocket(socket, uid)
  return socket
}

export interface ControlRequest {
  cmd: string
  [key: string]: unknown
}

export type ControlHandler = (request: ControlRequest) => Promise<unknown>

const MAX_REQUEST_BYTES = 64 * 1024

export class ControlServer {
  private server: net.Server | null = null
  private socket: string | null = null
  private ownDir = false

  constructor(private readonly paths: ServerPaths, private readonly handler: ControlHandler, private readonly log: (message: string) => void, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** The socket it listens on, once started. */
  get socketPath(): string | null {
    return this.socket
  }

  async start(): Promise<void> {
    const uid = currentUid()
    ensurePrivateRunDir(this.paths, uid)
    const { socket, ownDir } = chooseControlSocket(this.paths, this.env, uid)
    const dir = path.dirname(socket)
    assertPrivateDir(dir, uid)
    // A socket a server of ours left behind when it died (the instance lock says nobody runs).
    try {
      const stale = fs.lstatSync(socket)
      if (!stale.isSocket() || (uid !== null && stale.uid !== uid)) throw new UnsafeControlSocketError(`${socket} exists and is not a socket of yours; refusing to replace it`)
      fs.rmSync(socket)
    } catch (err) {
      if (err instanceof UnsafeControlSocketError) throw err
    }
    const server = net.createServer((connection) => this.serve(connection))
    // Created private from the start, not chmod'ed after another user could connect.
    let umask: number | null = null
    try {
      umask = process.umask(0o077)
    } catch {
      // Not allowed in a worker thread; the dir is private anyway.
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socket, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } finally {
      if (umask !== null) process.umask(umask)
    }
    fs.chmodSync(socket, 0o600)
    assertPrivateSocket(socket, uid)
    server.on('error', (err) => this.log(`control error=${err.message}`))
    this.server = server
    this.socket = socket
    this.ownDir = ownDir
    atomicWriteFileSync(controlRecordFile(this.paths), `${socket}\n`, 0o600)
    this.log(`control socket=${socket}`)
  }

  close(): void {
    this.server?.close()
    this.server = null
    const socket = this.socket
    if (!socket) return
    this.socket = null
    fs.rmSync(socket, { force: true })
    try {
      if (fs.readFileSync(controlRecordFile(this.paths), 'utf8').trim() === socket) fs.rmSync(controlRecordFile(this.paths), { force: true })
    } catch {
      // No record.
    }
    if (this.ownDir) fs.rmSync(path.dirname(socket), { recursive: true, force: true })
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

/** One request to the running server, after {@link findControlSocket}'s checks. */
export function controlRequest(paths: ServerPaths, request: ControlRequest, timeoutMs = 30_000): Promise<unknown> {
  let socketPath: string
  try {
    socketPath = findControlSocket(paths)
  } catch (err) {
    return Promise.reject(err)
  }
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
