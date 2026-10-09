import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spliceTcp, type TcpTarget } from '../host/link/tcp-stream'
import type { LinkStream } from '../host/link/stream'

/** Unix socket addresses are capped near 104 bytes (macOS); keep a margin. */
const MAX_SOCKET_PATH = 100
/** Where the server's sshd listens, from the server's own view. */
export const SSHD_TARGET: TcpTarget = { host: '127.0.0.1', port: 22 }

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** A directory that is ours alone: a real dir (no symlink), owned by us, 0700. Tightens one of ours that is too open. */
export function ensurePrivateDir(dir: string, uid: number | null = currentUid()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory`)
  if (uid !== null && stat.uid !== uid) throw new Error(`${dir} belongs to another user`)
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

/**
 * The socket ssh's ProxyCommand connects to for a server:
 * `<configDir>/servers/<id>/ssh.sock`, or, when that path is too long for a
 * socket address, one in a fresh private dir under the temp dir (the ssh
 * config is written for whichever this run listens on).
 */
export function sshSocketPath(configDir: string, serverId: string, fallbackDir: () => string): string {
  const preferred = path.join(configDir, 'servers', serverId, 'ssh.sock')
  if (Buffer.byteLength(preferred) < MAX_SOCKET_PATH) return preferred
  return path.join(fallbackDir(), `${serverId.slice(0, 16)}.sock`)
}

export interface ServerSshSocketsDeps {
  configDir: string
  /** A connected `tcp` stream on the server (connectTcpStream). */
  openTcp: (serverId: string, target: TcpTarget) => Promise<LinkStream>
  log: (message: string) => void
}

interface Listener {
  server: net.Server
  path: string
  ready: Promise<void>
}

/**
 * The desktop's end of Open in IDE (plan step 9): per set-up server, a Unix
 * socket (0600, in a 0700 dir) whose every connection is piped to that server's
 * `127.0.0.1:22` over a `tcp` stream. ssh reaches it through the ProxyCommand
 * in DevTool's ssh config, so it only works while DevTool runs.
 */
export class ServerSshSockets {
  private readonly listeners = new Map<string, Listener>()
  private readonly connections = new Set<net.Socket>()
  private fallback: string | null = null

  constructor(private readonly deps: ServerSshSocketsDeps) {}

  /** The socket for `serverId`: where it listens, or would. */
  socketPath(serverId: string): string {
    return this.listeners.get(serverId)?.path ?? sshSocketPath(this.deps.configDir, serverId, () => this.fallbackDir())
  }

  /** Listens for `serverId` (once). Resolves with the socket's path. */
  async ensure(serverId: string): Promise<string> {
    const existing = this.listeners.get(serverId)
    if (existing) {
      await existing.ready
      return existing.path
    }
    const socket = this.socketPath(serverId)
    ensurePrivateDir(path.dirname(socket))
    removeStaleSocket(socket)
    const server = net.createServer({ allowHalfOpen: true }, (conn) => this.accept(serverId, conn))
    const ready = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => {
        server.off('error', reject)
        server.on('error', (err) => this.deps.log(`serverIde socket server=${serverId} error=${err.message}`))
        try {
          fs.chmodSync(socket, 0o600)
        } catch {
          // The 0700 dir is what keeps others out.
        }
        resolve()
      })
    })
    const listener: Listener = { server, path: socket, ready }
    this.listeners.set(serverId, listener)
    try {
      await ready
    } catch (err) {
      this.listeners.delete(serverId)
      throw err
    }
    this.deps.log(`serverIde listening server=${serverId} socket=${socket}`)
    return socket
  }

  /** Stops listening for `serverId` and removes its socket. */
  async close(serverId: string): Promise<void> {
    const listener = this.listeners.get(serverId)
    if (!listener) return
    this.listeners.delete(serverId)
    await new Promise<void>((resolve) => listener.server.close(() => resolve()))
    removeStaleSocket(listener.path)
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) conn.destroy()
    this.connections.clear()
    await Promise.all([...this.listeners.keys()].map((serverId) => this.close(serverId)))
    if (this.fallback) fs.rmSync(this.fallback, { recursive: true, force: true })
    this.fallback = null
  }

  private fallbackDir(): string {
    if (!this.fallback) {
      // A fresh mkdtemp dir: nobody can have prepared it.
      this.fallback = fs.mkdtempSync(path.join(os.tmpdir().length < 40 ? os.tmpdir() : '/tmp', 'devtool-ssh-'))
      fs.chmodSync(this.fallback, 0o700)
    }
    return this.fallback
  }

  private accept(serverId: string, conn: net.Socket): void {
    this.connections.add(conn)
    conn.once('close', () => this.connections.delete(conn))
    conn.on('error', () => {})
    conn.pause()
    this.deps.openTcp(serverId, SSHD_TARGET).then(
      (stream) => {
        if (conn.destroyed) {
          stream.destroy()
          return
        }
        spliceTcp(conn, stream)
      },
      (err: unknown) => {
        this.deps.log(`serverIde ssh server=${serverId} failed: ${err instanceof Error ? err.message : String(err)}`)
        conn.destroy()
      }
    )
  }
}

/** Unlinks `file` if it is a socket (a crashed run's); leaves anything else alone. */
function removeStaleSocket(file: string): void {
  try {
    if (fs.lstatSync(file).isSocket()) fs.unlinkSync(file)
  } catch {
    // Not there.
  }
}
