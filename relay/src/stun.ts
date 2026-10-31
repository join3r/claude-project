import { createSocket, type Socket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { crc32 } from 'node:zlib'
import type { Logger } from './log.ts'

/**
 * A STUN Binding responder (RFC 5389, no authentication) on UDP. Desktops and
 * DevTool servers ask it for their public address and port so they can punch a
 * direct path through NAT (protocol/SERVER.md §13). It answers nothing else:
 * no TURN, no relaying, and a reply is never bigger than the request plus 32
 * bytes, so it can't be used to amplify traffic.
 */

const MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const XOR_MAPPED_ADDRESS = 0x0020
const FINGERPRINT = 0x8028
const FINGERPRINT_XOR = 0x5354554e
const HEADER_BYTES = 20
/** Requests bigger than this aren't from a client we serve. */
const MAX_REQUEST_BYTES = 548
/** Requests one address may make per second before the rest are dropped. */
export const STUN_REQUESTS_PER_SECOND = 20

export interface StunServer {
  readonly port: number
  close(): Promise<void>
}

/** Parses a Binding Request: its transaction ID, or null when it isn't one. */
export function bindingTransaction(packet: Uint8Array): Uint8Array | null {
  if (packet.length < HEADER_BYTES || packet.length > MAX_REQUEST_BYTES) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  // The two top bits of a STUN message are zero; the type must be a Binding Request.
  if (view.getUint16(0) !== BINDING_REQUEST) return null
  const length = view.getUint16(2)
  if (length % 4 !== 0 || HEADER_BYTES + length !== packet.length) return null
  if (view.getUint32(4) !== MAGIC_COOKIE) return null
  return packet.slice(8, 20)
}

/** A Binding Success Response with XOR-MAPPED-ADDRESS and FINGERPRINT. */
export function bindingResponse(transaction: Uint8Array, address: string, port: number): Uint8Array {
  const v4 = isIPv4(address)
  const addressBytes = v4 ? ipv4Bytes(address) : ipv6Bytes(address)
  const attrLength = 4 + addressBytes.length
  const length = 4 + attrLength + 8
  const out = new Uint8Array(HEADER_BYTES + length)
  const view = new DataView(out.buffer)
  view.setUint16(0, BINDING_SUCCESS)
  view.setUint16(2, length)
  view.setUint32(4, MAGIC_COOKIE)
  out.set(transaction, 8)
  let at = HEADER_BYTES
  view.setUint16(at, XOR_MAPPED_ADDRESS)
  view.setUint16(at + 2, attrLength)
  view.setUint8(at + 4, 0)
  view.setUint8(at + 5, v4 ? 0x01 : 0x02)
  view.setUint16(at + 6, port ^ (MAGIC_COOKIE >>> 16))
  // XOR with the cookie, then (IPv6) the transaction ID: header bytes 4..19.
  for (let i = 0; i < addressBytes.length; i++) out[at + 8 + i] = addressBytes[i] ^ out[4 + i]
  at += 4 + attrLength
  view.setUint16(at, FINGERPRINT)
  view.setUint16(at + 2, 4)
  view.setUint32(at + 4, (crc32(out.subarray(0, at)) ^ FINGERPRINT_XOR) >>> 0)
  return out
}

function ipv4Bytes(address: string): Uint8Array {
  return Uint8Array.from(address.split('.').map(Number))
}

function ipv6Bytes(address: string): Uint8Array {
  const zone = address.indexOf('%')
  const plain = zone === -1 ? address : address.slice(0, zone)
  const [head, tail = ''] = plain.split('::')
  const parse = (part: string) => (part ? part.split(':') : [])
  let headGroups = parse(head)
  let tailGroups = parse(tail)
  const out = new Uint8Array(16)
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const embed = (groups: string[]) => {
    const last = groups[groups.length - 1]
    if (!last || !isIPv4(last)) return groups
    const b = ipv4Bytes(last)
    return [...groups.slice(0, -1), ((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)]
  }
  headGroups = embed(headGroups)
  tailGroups = embed(tailGroups)
  const groups = plain.includes('::') ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups] : headGroups
  groups.forEach((g, i) => {
    const n = parseInt(g, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  })
  return out
}

/** `::ffff:1.2.3.4` (a dual-stack socket's view of an IPv4 client) → `1.2.3.4`. */
function unmapped(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return m ? m[1] : address
}

/** Listens on `port` (both IPv6 and IPv4 where the host has them). */
export async function startStunServer(options: { port: number; host?: string; logger: Logger }): Promise<StunServer> {
  const { logger } = options
  const counts = new Map<string, number>()
  const reset = setInterval(() => counts.clear(), 1000)
  reset.unref()
  let answered = 0

  const listen = (type: 'udp4' | 'udp6', host: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = createSocket({ type, ipv6Only: false, reuseAddr: false })
      socket.once('error', reject)
      socket.bind(options.port, host, () => {
        socket.off('error', reject)
        socket.on('error', (err) => logger.warn('stun-error', { error: err.message }))
        resolve(socket)
      })
    })

  let socket: Socket
  if (options.host && options.host !== '::') {
    socket = await listen(isIPv4(options.host) ? 'udp4' : 'udp6', options.host)
  } else {
    try {
      socket = await listen('udp6', '::')
    } catch {
      socket = await listen('udp4', '0.0.0.0')
    }
  }
  socket.on('message', (packet, rinfo) => {
    const transaction = bindingTransaction(packet)
    if (!transaction) return
    const n = (counts.get(rinfo.address) ?? 0) + 1
    counts.set(rinfo.address, n)
    if (n > STUN_REQUESTS_PER_SECOND) return
    const address = unmapped(rinfo.address)
    const reply = bindingResponse(transaction, address, rinfo.port)
    socket.send(reply, rinfo.port, rinfo.address)
    answered++
    if (answered % 1000 === 1) logger.debug('stun-answered', { total: answered })
  })
  const port = socket.address().port
  logger.info('stun-listening', { port })
  return {
    port,
    close: () => new Promise((resolve) => {
      clearInterval(reset)
      socket.close(() => resolve())
    })
  }
}
