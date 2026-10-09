import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { PUSH_REGISTER_PATH, PUSH_SEND_PATH, RELAY_PATH } from '../../protocol/ts/index.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import { gatewayForwarder, upstreamForwarder } from './push/gateway.ts'
import type { PushGateway } from './push/gateway.ts'
import { createRelay } from './relay.ts'
import type { Clock, PushForwarder, Relay, RelayLimits } from './relay.ts'
import type { RelayStore } from './store.ts'
import { upgradeToWebSocket } from './ws/connection.ts'

/**
 * Binds the relay core to `node:http` and our own RFC 6455 implementation.
 * `GET /healthz` answers 200 "ok"; the WebSocket lives at `/v1`; a gateway serves
 * `POST /v1/push/register` and `POST /v1/push/send` (503 on any other relay); everything
 * else is 404.
 */

/** Largest JSON body the push endpoints read. */
export const PUSH_MAX_BODY_BYTES = 16 * 1024

export interface RelayServerOptions {
  store: RelayStore
  /** 0 picks a free port (tests). */
  port?: number
  host?: string
  limits?: Partial<RelayLimits>
  clock?: Clock
  logger?: Logger
  /** Take the client IP from `X-Forwarded-For` (set only behind a trusted reverse proxy). */
  trustProxy?: boolean
  /** Makes this relay the push gateway (§7): serves the push API and handles `push` in-process. */
  gateway?: PushGateway
  /** Not a gateway: forward `push` to this gateway's base URL. Absent or empty: `unavailable`. */
  pushUpstream?: string
  /** Replaces the forwarder derived from `gateway`/`pushUpstream` (tests). */
  pushForwarder?: PushForwarder
}

export interface RelayServer {
  readonly relay: Relay
  readonly http: Server
  readonly port: number
  /** `ws://host:port`, without the `/v1` path. */
  readonly url: string
  close(): Promise<void>
}

/**
 * The client address. Behind a proxy we take the **last** `X-Forwarded-For` entry: it is
 * the one our own proxy appended, while anything to its left came from the client and
 * can be forged.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const value = Array.isArray(header) ? header.join(',') : header
    const last = value?.split(',').map((s) => s.trim()).filter(Boolean).at(-1)
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://relay').pathname
  } catch {
    return ''
  }
}

function sendJson(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(json)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra })
  res.end(body)
}

class BodyTooLarge extends Error {}

/** Reads at most `limit` bytes; rejects with BodyTooLarge beyond that. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) return reject(new BodyTooLarge())
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.removeAllListeners('data')
        req.resume()
        reject(new BodyTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handlePush(req: IncomingMessage, res: ServerResponse, path: string, gateway: PushGateway | null, ip: string): Promise<void> {
  if (!gateway) return sendJson(res, 503, { error: 'unavailable' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' }, { Allow: 'POST' })
  let body: unknown
  try {
    body = JSON.parse((await readBody(req, PUSH_MAX_BODY_BYTES)).toString('utf8'))
  } catch (err) {
    if (err instanceof BodyTooLarge) return sendJson(res, 413, { error: 'too-large' }, { Connection: 'close' })
    return sendJson(res, 400, { error: 'bad-request' })
  }
  if (path === PUSH_REGISTER_PATH) {
    const reply = gateway.register(body, ip)
    return sendJson(res, reply.status, reply.json)
  }
  const o = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (typeof o.cap !== 'string' || typeof o.data !== 'string') return sendJson(res, 200, { result: 'bad-request' })
  sendJson(res, 200, { result: await gateway.send(o.cap, o.data) })
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`)
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const log = options.logger ?? silentLogger
  const trustProxy = options.trustProxy ?? false
  const gateway = options.gateway ?? null
  const forwarder =
    options.pushForwarder ??
    (gateway ? gatewayForwarder(gateway) : options.pushUpstream ? upstreamForwarder(options.pushUpstream, { logger: log }) : undefined)
  const relay = createRelay({ store: options.store, limits: options.limits, clock: options.clock, logger: log, push: forwarder })
  const sockets = new Set<Socket>()

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req)
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end('ok')
      return
    }
    if (path === PUSH_REGISTER_PATH || path === PUSH_SEND_PATH) {
      handlePush(req, res, path, gateway, clientIp(req, trustProxy)).catch((err: Error) => {
        log.error('push-http-failed', { error: err.message })
        if (!res.headersSent) sendJson(res, 500, { error: 'error' })
        else res.destroy()
      })
      return
    }
    if (path === RELAY_PATH) {
      res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', Connection: 'Upgrade' })
      res.end('websocket upgrade required')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  // A socket that never finishes its request headers (the upgrade included) isn't a
  // relay connection yet, so the per-IP caps don't see it: don't hold it for long.
  http.headersTimeout = 10_000
  http.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  http.on('clientError', (_err, socket: Duplex) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    if (pathOf(req) !== RELAY_PATH) return rejectUpgrade(socket, 404, 'Not Found')
    const ip = clientIp(req, trustProxy)
    if (!relay.admit(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests')
    const ws = upgradeToWebSocket(req, socket, head, {
      maxPayload: relay.limits.maxFrameBytes,
      maxBufferedBytes: relay.limits.phoneBufferCapBytes
    })
    if (!ws) return
    const handle = relay.open(
      {
        send: (text) => ws.sendText(text),
        sendBinary: (data) => ws.sendBinary(data),
        close: (code, reason) => ws.close(code, reason),
        terminate: () => ws.terminate(),
        bufferedBytes: () => ws.bufferedAmount,
        onBufferBelow: (bytes, fn) => ws.onBufferBelow(bytes, fn),
        setBufferCap: (bytes) => ws.setMaxBufferedBytes(bytes),
        pause: () => ws.pause(),
        resume: () => ws.resume()
      },
      { ip }
    )
    ws.attach({
      message: (data, isBinary) => handle.message(data, isBinary),
      close: (code) => {
        log.debug('socket-closed', { ip, code })
        handle.closed()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const port = (http.address() as AddressInfo).port
  const host = options.host && options.host !== '0.0.0.0' && options.host !== '::' ? options.host : '127.0.0.1'

  let closing: Promise<void> | null = null
  return {
    relay,
    http,
    port,
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        relay.shutdown()
        http.close(() => resolve())
        // Give sockets a moment to finish their close handshake, then force them.
        const force = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, 1000)
        force.unref()
        http.once('close', () => clearTimeout(force))
      })
      return closing
    }
  }
}
