import net from 'net'
import { LinkError, LinkErrorCode, errorMessage } from './errors'
import type { LinkStream, StreamHandler } from './stream'

/**
 * The `tcp` stream kind (protocol/SERVER.md §6.3): the desktop names
 * `{host, port}` and the server dials it from its own network view, so
 * `localhost` is the server and names resolve there. Browser tabs of server
 * projects (through the desktop's authenticated HTTP proxy) and Open in IDE (through the
 * desktop's ssh socket) both ride on it.
 *
 * Once connected the server writes one byte, {@link TCP_CONNECTED}, then pipes
 * both ways. A failure to connect aborts the stream with
 * `close {reason: "error", message: "<CODE>: <text>"}`, where CODE is Node's
 * (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH...). Either side's `end` is
 * a TCP half-close; a reset (or an abort) on one side resets the other.
 */
export const TCP_STREAM_KIND = 'tcp'
/** The first byte the server writes once its socket is connected. */
export const TCP_CONNECTED = 0x00
/** How long the server waits for the target to accept. */
export const TCP_CONNECT_TIMEOUT_MS = 10_000
/** The desktop's wait for the connected byte: the server's own timeout plus a relay round trip. */
const DESKTOP_CONNECT_SLACK_MS = 5_000

export interface TcpTarget {
  host: string
  port: number
}

/** `{host, port}` from an `open`'s params; throws a readable error for anything else. */
export function parseTcpTarget(params: unknown): TcpTarget {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error('EINVAL: tcp needs {host, port}')
  const { host, port } = params as Record<string, unknown>
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\s\0/\\]/.test(host)) {
    throw new Error('EINVAL: tcp host must be a hostname or an IP address')
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('EINVAL: tcp port must be an integer from 1 to 65535')
  }
  // `[::1]` as a URL writes it; net wants the bare address.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (!bare) throw new Error('EINVAL: tcp host must be a hostname or an IP address')
  return { host: bare, port }
}

/** `CODE: text` for a socket error, so the desktop can tell refused from unreachable. */
function describeSocketError(err: unknown): string {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'EIO'
  const message = errorMessage(err)
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`
}

export interface TcpStreamOptions {
  connectTimeoutMs?: number
  log?: (message: string) => void
  /** Tests: dial something else. */
  connect?: (target: TcpTarget) => net.Socket
}

function resetSocket(socket: net.Socket): void {
  if (socket.destroyed) return
  if (typeof socket.resetAndDestroy === 'function' && !socket.connecting) socket.resetAndDestroy()
  else socket.destroy()
}

/**
 * The server's end of `tcp`. Only paired desktops can open streams, and a paired
 * desktop already runs shells on the server, so any host and port is fair game:
 * this is what `ssh -D` gives the same user.
 */
export function tcpStreamHandler(options: TcpStreamOptions = {}): StreamHandler {
  const timeoutMs = options.connectTimeoutMs ?? TCP_CONNECT_TIMEOUT_MS
  const dial = options.connect ?? ((target: TcpTarget) => net.connect({ host: target.host, port: target.port, allowHalfOpen: true }))
  return (stream) => {
    const target = parseTcpTarget(stream.params)
    const socket = dial(target)
    socket.setNoDelay(true)
    const timer = setTimeout(() => {
      const err = Object.assign(new Error(`connect ETIMEDOUT ${target.host}:${target.port}`), { code: 'ETIMEDOUT' })
      socket.destroy(err)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setKeepAlive(true, 60_000)
      stream.write(Uint8Array.of(TCP_CONNECTED))
      socket.pipe(stream)
      stream.pipe(socket)
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      options.log?.(`tcp ${target.host}:${target.port} ${describeSocketError(err)}`)
      if (!stream.destroyed) stream.destroy(new Error(describeSocketError(err)))
    })
    // Aborted by the desktop (or the link went): reset the connection. A stream that
    // ended both ways closes too, and then the socket finishes on its own.
    stream.once('close', () => {
      clearTimeout(timer)
      if (!(stream.readableEnded && stream.writableFinished)) resetSocket(socket)
    })
  }
}

/** Why a `tcp` stream didn't connect: Node's code from the server, or a link code (`server-offline`, `refused`...). */
export class TcpConnectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TcpConnectError'
  }
}

/** The code at the front of a `tcp` failure message (`ECONNREFUSED: ...`), if there is one. */
export function tcpFailureCode(message: string): string | null {
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message)
  return match ? match[1] : null
}

function connectError(err: unknown): TcpConnectError {
  if (err instanceof TcpConnectError) return err
  const message = errorMessage(err)
  if (err instanceof LinkError) {
    // An abort carries the server's `CODE: text`; a refusal is a server without `tcp`.
    const code = err.code === LinkErrorCode.Aborted ? tcpFailureCode(message) ?? 'EIO' : err.code
    return new TcpConnectError(code, message)
  }
  return new TcpConnectError(tcpFailureCode(message) ?? 'EIO', message)
}

/**
 * The desktop's end: opens a `tcp` stream and resolves once the server says it is
 * connected, with the stream paused and ready to pipe. Rejects with a
 * {@link TcpConnectError}.
 */
export function connectTcpStream(open: () => LinkStream, options: { timeoutMs?: number } = {}): Promise<LinkStream> {
  let stream: LinkStream
  try {
    stream = open()
  } catch (err) {
    return Promise.reject(connectError(err))
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    const fail = (err: TcpConnectError) => {
      cleanup()
      if (!stream.destroyed) stream.destroy()
      reject(err)
    }
    const onData = (chunk: Buffer) => {
      stream.pause()
      cleanup()
      if (chunk.length === 0 || chunk[0] !== TCP_CONNECTED) {
        fail(new TcpConnectError('EPROTO', 'The server answered a tcp stream with something else'))
        return
      }
      if (chunk.length > 1) stream.unshift(chunk.subarray(1))
      resolve(stream)
    }
    const onError = (err: Error) => fail(connectError(err))
    const onEnd = () => fail(new TcpConnectError('ECONNRESET', 'The server closed the tcp stream before connecting'))
    const timer = setTimeout(() => fail(new TcpConnectError('ETIMEDOUT', 'The server did not connect in time')),
      (options.timeoutMs ?? TCP_CONNECT_TIMEOUT_MS) + DESKTOP_CONNECT_SLACK_MS)
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

/**
 * Joins a local socket to a connected `tcp` stream: bytes both ways, a half-close
 * passed on as one, and a reset or abort on either side resetting the other.
 */
export function spliceTcp(local: net.Socket, stream: LinkStream): void {
  local.on('error', (err) => {
    if (!stream.destroyed) stream.destroy(err)
  })
  stream.on('error', () => resetSocket(local))
  // Closed without its peer's FIN: destroyed here (a listener shutting down), so abort the stream too.
  local.once('close', () => {
    if (!local.readableEnded && !stream.destroyed) stream.destroy(new Error('ECONNRESET: the local side closed'))
  })
  stream.once('close', () => {
    if (!(stream.readableEnded && stream.writableFinished)) resetSocket(local)
  })
  local.pipe(stream)
  stream.pipe(local)
}
