import net from 'net'

/**
 * A minimal SOCKS5 server (RFC 1928) for the browser tabs of server projects:
 * no authentication, CONNECT only. BIND and UDP ASSOCIATE are refused. Domain
 * names are passed on as they are, never resolved here (socks5h), so whoever
 * dials them (a DevTool server) resolves `localhost` and internal names itself.
 */

export type Socks5AddressType = 'ipv4' | 'domain' | 'ipv6'

export interface Socks5Target {
  host: string
  port: number
  type: Socks5AddressType
}

/** RFC 1928 §6 reply codes. */
export const Socks5Reply = {
  Succeeded: 0x00,
  GeneralFailure: 0x01,
  NotAllowed: 0x02,
  NetworkUnreachable: 0x03,
  HostUnreachable: 0x04,
  ConnectionRefused: 0x05,
  TtlExpired: 0x06,
  CommandNotSupported: 0x07,
  AddressTypeNotSupported: 0x08
} as const

const VERSION = 5
const NO_AUTH = 0x00
const NO_ACCEPTABLE_METHOD = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
/** A greeting is at most 257 bytes and a request 262: anything longer before CONNECT is junk. */
const MAX_HANDSHAKE_BYTES = 600
const HANDSHAKE_TIMEOUT_MS = 10_000

/** The reply for a failed connect: a Node or link error code, mapped to RFC 1928's nearest. */
export function socksReplyForCode(code: string | undefined): number {
  switch (code) {
    case 'ECONNREFUSED':
      return Socks5Reply.ConnectionRefused
    case 'EHOSTUNREACH':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'ETIMEDOUT':
      return Socks5Reply.HostUnreachable
    case 'ENETUNREACH':
    case 'server-offline':
      return Socks5Reply.NetworkUnreachable
    case 'EACCES':
    case 'EPERM':
      return Socks5Reply.NotAllowed
    default:
      return Socks5Reply.GeneralFailure
  }
}

/** One parsed CONNECT-or-other request, or `null` while it is incomplete. */
export type Socks5Request =
  | { ok: true; command: number; target: Socks5Target; length: number }
  | { ok: false; reply: number }

/** IPv6 from 16 bytes, in the compressed text form Node and URLs use. */
function ipv6Text(bytes: Uint8Array): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // Collapse the longest run of zero groups (at least two) to `::`.
  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > bestLength && j - i >= 2) { bestStart = i; bestLength = j - i }
    i = j
  }
  if (bestStart < 0) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLength).join(':')
  return `${head}::${tail}`
}

/** Parses the request after the greeting (RFC 1928 §4). */
export function parseSocks5Request(buffer: Uint8Array): Socks5Request | null {
  if (buffer.length < 4) return null
  if (buffer[0] !== VERSION) return { ok: false, reply: Socks5Reply.GeneralFailure }
  const command = buffer[1]
  const type = buffer[3]
  let offset = 4
  let host: string
  let kind: Socks5AddressType
  if (type === ATYP_IPV4) {
    if (buffer.length < offset + 4 + 2) return null
    host = Array.from(buffer.subarray(offset, offset + 4)).join('.')
    offset += 4
    kind = 'ipv4'
  } else if (type === ATYP_DOMAIN) {
    if (buffer.length < offset + 1) return null
    const length = buffer[offset]
    if (buffer.length < offset + 1 + length + 2) return null
    host = Buffer.from(buffer.subarray(offset + 1, offset + 1 + length)).toString('latin1')
    offset += 1 + length
    kind = 'domain'
    if (length === 0 || /[\s\0/\\]/.test(host)) return { ok: false, reply: Socks5Reply.HostUnreachable }
  } else if (type === ATYP_IPV6) {
    if (buffer.length < offset + 16 + 2) return null
    host = ipv6Text(buffer.subarray(offset, offset + 16))
    offset += 16
    kind = 'ipv6'
  } else {
    return { ok: false, reply: Socks5Reply.AddressTypeNotSupported }
  }
  const port = (buffer[offset] << 8) | buffer[offset + 1]
  offset += 2
  if (port === 0) return { ok: false, reply: Socks5Reply.HostUnreachable }
  return { ok: true, command, target: { host, port, type: kind }, length: offset }
}

/** A reply with an all-zero IPv4 bound address: clients don't use it for CONNECT. */
function replyBytes(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

export interface Socks5ServerOptions {
  /**
   * Dials the target. The duplex it resolves is joined to the client by
   * `splice`; a rejection's `code` picks the reply ({@link socksReplyForCode}).
   */
  connect: (target: Socks5Target) => Promise<net.Socket | NodeJS.ReadWriteStream>
  /** Joins the client to what `connect` returned (pipes, half-closes, resets). */
  splice: (client: net.Socket, upstream: net.Socket | NodeJS.ReadWriteStream) => void
  log?: (message: string) => void
  /** Default 127.0.0.1: the listener is for this machine's browser sessions only. */
  host?: string
  handshakeTimeoutMs?: number
}

/**
 * A listener on an ephemeral port. Each client's greeting must offer "no
 * authentication"; its request must be CONNECT, which goes to `connect`.
 */
export class Socks5Server {
  private server: net.Server | null = null
  private readonly clients = new Set<net.Socket>()
  private boundPort = 0

  constructor(private readonly options: Socks5ServerOptions) {}

  get port(): number {
    return this.boundPort
  }

  get connectionCount(): number {
    return this.clients.size
  }

  listen(port = 0): Promise<number> {
    if (this.server) return Promise.resolve(this.boundPort)
    const server = net.createServer({ allowHalfOpen: true }, (client) => this.accept(client))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (err) => this.options.log?.(`socks5 listener error=${err.message}`))
        this.boundPort = (server.address() as net.AddressInfo).port
        resolve(this.boundPort)
      })
    })
  }

  /** Stops listening and drops every connection. */
  close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private accept(client: net.Socket): void {
    this.clients.add(client)
    client.once('close', () => this.clients.delete(client))
    client.on('error', () => {})
    client.setNoDelay(true)
    let buffer: Buffer = Buffer.alloc(0)
    let phase: 'greeting' | 'request' = 'greeting'
    const timer = setTimeout(() => client.destroy(), this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    client.once('close', () => clearTimeout(timer))
    const refuse = (code: number) => {
      clearTimeout(timer)
      client.off('data', onData)
      client.end(replyBytes(code))
    }
    const onData = (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        client.destroy()
        return
      }
      if (phase === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== VERSION) {
          client.destroy()
          return
        }
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        buffer = buffer.subarray(2 + count)
        if (!methods.includes(NO_AUTH)) {
          clearTimeout(timer)
          client.off('data', onData)
          client.end(Buffer.from([VERSION, NO_ACCEPTABLE_METHOD]))
          return
        }
        client.write(Buffer.from([VERSION, NO_AUTH]))
        phase = 'request'
      }
      const request = parseSocks5Request(buffer)
      if (!request) return
      if (!request.ok) {
        refuse(request.reply)
        return
      }
      if (request.command !== CMD_CONNECT) {
        this.options.log?.(`socks5 refused command=${request.command}`)
        refuse(Socks5Reply.CommandNotSupported)
        return
      }
      // Whatever the client sent after its request goes upstream once connected.
      const early = buffer.subarray(request.length)
      clearTimeout(timer)
      client.pause()
      client.off('data', onData)
      void this.connect(client, request.target, early)
    }
    client.on('data', onData)
  }

  private async connect(client: net.Socket, target: Socks5Target, early: Buffer): Promise<void> {
    let upstream: net.Socket | NodeJS.ReadWriteStream
    try {
      upstream = await this.options.connect(target)
    } catch (err) {
      const code = (err as { code?: string })?.code
      this.options.log?.(`socks5 connect ${target.host}:${target.port} failed code=${code ?? '?'} ${err instanceof Error ? err.message : String(err)}`)
      if (!client.destroyed) client.end(replyBytes(socksReplyForCode(code)))
      return
    }
    if (client.destroyed) {
      ;(upstream as { destroy?: () => void }).destroy?.()
      return
    }
    client.write(replyBytes(Socks5Reply.Succeeded))
    if (early.length > 0) upstream.write(early)
    this.options.splice(client, upstream)
    client.resume()
  }
}
