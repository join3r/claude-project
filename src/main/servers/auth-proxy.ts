import { createHash, timingSafeEqual } from 'crypto'
import http from 'http'
import type net from 'net'
import type { Duplex } from 'stream'

/**
 * A small HTTP proxy for the browser tabs of server projects: 127.0.0.1 only,
 * and every request must carry `Proxy-Authorization: Basic` with this
 * listener's secret, so no other local process or user can use it to reach the
 * server. Chromium answers the challenge through Electron's `login` event
 * (`proxyLoginHandler`); SOCKS has no auth Chromium speaks, hence HTTP.
 *
 * Node's own HTTP parser reads the client: a keep-alive connection may carry
 * requests for several origins, so every request is checked on its own and gets
 * a fresh upstream (a `tcp` stream the server dials, `agent: false`), closed
 * after its response. Nothing of one request can reach another's upstream.
 * - `CONNECT host:port` (https, ws and wss) tunnels to the host it names.
 * - `GET http://host:port/path` (absolute form, plain http) goes on in origin
 *   form without the proxy's and the hop-by-hop headers.
 * - A plain-http websocket upgrade goes on the same way, then is spliced.
 * Names are never resolved here.
 */

export interface ProxyTarget {
  host: string
  port: number
}

export interface AuthProxyOptions {
  username: string
  password: string
  /** `Proxy-Authenticate: Basic realm="<realm>"`. */
  realm: string
  /** Dials the target; a rejection's `code` picks 502 or 504. */
  connect: (target: ProxyTarget) => Promise<Duplex>
  /** Joins a client socket to an upstream for a tunnel (pipes, half-closes, resets). */
  splice: (client: net.Socket, upstream: Duplex) => void
  log?: (message: string) => void
  /** Concurrent client connections. */
  maxConnections?: number
  /** Concurrent upstreams (requests and tunnels); past it, 503. */
  maxUpstreams?: number
  /** Request line plus headers. */
  maxHeaderBytes?: number
  /** For a request's headers to arrive. */
  headersTimeoutMs?: number
  /** A tunnel or exchange with no traffic either way for this long is closed. */
  idleTimeoutMs?: number
}

export const PROXY_MAX_CONNECTIONS = 256
export const PROXY_MAX_UPSTREAMS = 128
export const PROXY_MAX_HEADER_BYTES = 16 * 1024
const HEADERS_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 60 * 60_000

/** Never passed on: the proxy's own, and HTTP/1.1's hop-by-hop headers. */
const HOP_BY_HOP = new Set(['proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/** `Basic <base64(user:pass)>` against the expected token, in constant time. */
export function proxyAuthorized(header: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof header !== 'string') return false
  const match = /^basic\s+(\S+)\s*$/i.exec(header)
  if (!match) return false
  return timingSafeEqual(sha256(match[1]), sha256(expectedToken))
}

/** `host:port` of a CONNECT (`[v6]:port` for IPv6); null when malformed. */
export function parseAuthority(authority: string): ProxyTarget | null {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:/[\]@]+)):(\d{1,5})$/.exec(authority)
  if (!match) return null
  const port = Number(match[3])
  if (port < 1 || port > 65535) return null
  return { host: match[1] ?? match[2], port }
}

/** The origin of an absolute-form `http://` request; null for anything else. */
export function parseAbsoluteHttp(url: string | undefined): { target: ProxyTarget; path: string; hostHeader: string } | null {
  if (!url || !/^http:\/\//i.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || !parsed.hostname) return null
  const port = parsed.port ? Number(parsed.port) : 80
  if (port < 1 || port > 65535) return null
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname
  return { target: { host, port }, path: `${parsed.pathname}${parsed.search}`, hostHeader: parsed.host }
}

/**
 * `rawHeaders` without the hop-by-hop ones, nor any the `Connection` header
 * names (`keepUpgrade` keeps `Connection`/`Upgrade` for a websocket upgrade).
 */
export function endToEndHeaders(rawHeaders: string[], keepUpgrade = false): [string, string][] {
  const named = new Set<string>()
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'connection') {
      for (const token of rawHeaders[i + 1].split(',')) named.add(token.trim().toLowerCase())
    }
  }
  const out: [string, string][] = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const lower = rawHeaders[i].toLowerCase()
    if (keepUpgrade && (lower === 'upgrade' || lower === 'connection')) {
      out.push([rawHeaders[i], rawHeaders[i + 1]])
      continue
    }
    if (HOP_BY_HOP.has(lower) || (named.has(lower) && !(keepUpgrade && lower === 'upgrade'))) continue
    out.push([rawHeaders[i], rawHeaders[i + 1]])
  }
  return out
}

/** Header pairs as `http.request` takes them: repeated names become arrays. */
function headerObject(pairs: [string, string][]): http.OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    const prev = out[key]
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
  }
  return out
}

function rawResponse(status: string, headers: string[] = [], body = ''): string {
  return [`HTTP/1.1 ${status}`, ...headers, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body].join('\r\n')
}

function failureStatus(err: unknown): { status: number; text: string } {
  const code = (err as { code?: string })?.code
  return code === 'ETIMEDOUT' ? { status: 504, text: 'Gateway Timeout' } : { status: 502, text: 'Bad Gateway' }
}

/** The listener (see the module comment). Closing it drops every connection. */
export class AuthProxyServer {
  private server: http.Server | null = null
  private boundPort = 0
  private upstreams = 0
  private readonly expectedToken: string
  private readonly sockets = new Set<net.Socket>()

  constructor(private readonly options: AuthProxyOptions) {
    if (options.username.includes(':')) throw new Error('A proxy user name has no colon')
    if (!/^[\x21-\x7e]+$/.test(options.realm) || options.realm.includes('"')) throw new Error('Bad realm')
    this.expectedToken = Buffer.from(`${options.username}:${options.password}`).toString('base64')
  }

  get port(): number {
    return this.boundPort
  }

  get upstreamCount(): number {
    return this.upstreams
  }

  listen(port = 0): Promise<number> {
    if (this.server) return Promise.resolve(this.boundPort)
    const server = http.createServer({
      maxHeaderSize: this.options.maxHeaderBytes ?? PROXY_MAX_HEADER_BYTES,
      headersTimeout: this.options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      // Uploads through the proxy may take long; idleness is what ends them.
      requestTimeout: 0
    })
    server.maxConnections = this.options.maxConnections ?? PROXY_MAX_CONNECTIONS
    server.setTimeout(this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    server.on('connection', (socket: net.Socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('request', (req, res) => this.onRequest(req, res))
    server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => this.onConnect(req, socket, head))
    server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => this.onUpgrade(req, socket, head))
    server.on('clientError', (err: NodeJS.ErrnoException, socket: net.Socket) => {
      if (!socket.writable) return void socket.destroy()
      const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request'
      socket.end(rawResponse(status))
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (err) => this.options.log?.(`proxy listener error=${err.message}`))
        this.boundPort = (server.address() as net.AddressInfo).port
        resolve(this.boundPort)
      })
    })
  }

  close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private authorized(req: http.IncomingMessage): boolean {
    // Node joins repeated headers; a second Proxy-Authorization makes it not match.
    return proxyAuthorized(req.headers['proxy-authorization'], this.expectedToken)
  }

  private challenge(): string[] {
    return [`Proxy-Authenticate: Basic realm="${this.options.realm}"`]
  }

  /** Counts an upstream against the cap; false when full. */
  private takeUpstream(): boolean {
    if (this.upstreams >= (this.options.maxUpstreams ?? PROXY_MAX_UPSTREAMS)) return false
    this.upstreams++
    return true
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': `Basic realm="${this.options.realm}"`, 'Content-Length': 0 })
      res.end()
      return
    }
    const origin = parseAbsoluteHttp(req.url)
    if (!origin) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end('This is a proxy: send absolute http:// URLs, or CONNECT for https and websockets\n')
      return
    }
    if (!this.takeUpstream()) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end('Too many connections through this server\n')
      return
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.upstreams--
    }
    const headers = endToEndHeaders(req.rawHeaders)
    if (!headers.some(([name]) => name.toLowerCase() === 'host')) headers.unshift(['Host', origin.hostHeader])
    const { target } = origin
    const upstream = http.request({
      method: req.method,
      path: origin.path,
      headers: headerObject(headers),
      // No agent at all (`agent: false` would make a fresh one that ignores
      // createConnection): one fresh upstream per request, nothing pooled or
      // shared between origins.
      agent: undefined,
      createConnection: ((_options: unknown, ready: (err: Error | null, socket?: Duplex) => void) => {
        this.options.connect(target).then((stream) => {
          ready(null, stream)
          stream.resume()
        }, (err: Error) => ready(err))
        return undefined
      }) as unknown as http.RequestOptions['createConnection']
    })
    upstream.setHeader('Connection', 'close')
    upstream.on('response', (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, endToEndHeaders(upRes.rawHeaders).flat())
      upRes.pipe(res)
      upRes.once('end', release)
    })
    upstream.on('error', (err) => {
      release()
      this.options.log?.(`proxy ${target.host}:${target.port} failed: ${err.message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      const { status, text } = failureStatus(err)
      res.writeHead(status, text, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end(`DevTool could not reach ${target.host}:${target.port} from the server: ${err.message}\n`)
    })
    upstream.once('close', release)
    // The client went away before its answer: so does the upstream.
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  private onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    socket.on('error', () => {})
    if (!this.authorized(req)) {
      socket.end(rawResponse('407 Proxy Authentication Required', this.challenge()))
      return
    }
    const target = parseAuthority(req.url ?? '')
    if (!target) {
      socket.end(rawResponse('400 Bad Request'))
      return
    }
    void this.tunnel(socket, target, 'HTTP/1.1 200 Connection Established\r\n\r\n', head)
  }

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    socket.on('error', () => {})
    if (!this.authorized(req)) {
      socket.end(rawResponse('407 Proxy Authentication Required', this.challenge()))
      return
    }
    const origin = parseAbsoluteHttp(req.url)
    if (!origin || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.end(rawResponse('400 Bad Request'))
      return
    }
    const headers = endToEndHeaders(req.rawHeaders, true)
    if (!headers.some(([name]) => name.toLowerCase() === 'host')) headers.unshift(['Host', origin.hostHeader])
    const requestHead = [`${req.method} ${origin.path} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n')
    void this.tunnel(socket, origin.target, null, Buffer.concat([Buffer.from(requestHead, 'latin1'), head]))
  }

  /** Dials `target`; answers `reply` (CONNECT) and passes `first` upstream, then splices the two. */
  private async tunnel(socket: net.Socket, target: ProxyTarget, reply: string | null, first: Buffer): Promise<void> {
    if (!this.takeUpstream()) {
      socket.end(rawResponse('503 Service Unavailable'))
      return
    }
    let upstream: Duplex
    try {
      upstream = await this.options.connect(target)
    } catch (err) {
      this.upstreams--
      const message = err instanceof Error ? err.message : String(err)
      this.options.log?.(`proxy tunnel ${target.host}:${target.port} failed: ${message}`)
      const { status, text } = failureStatus(err)
      if (!socket.destroyed) socket.end(rawResponse(`${status} ${text}`, ['Content-Type: text/plain; charset=utf-8'], `DevTool could not reach ${target.host}:${target.port} from the server: ${message}\n`))
      return
    }
    upstream.once('close', () => { this.upstreams-- })
    if (socket.destroyed) {
      upstream.destroy()
      return
    }
    socket.setTimeout(this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => socket.destroy())
    if (reply) socket.write(reply)
    if (first.length > 0) upstream.write(first)
    this.options.splice(socket, upstream)
  }
}
