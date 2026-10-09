import { once } from 'events'
import net from 'net'

/** Bytes of a SOCKS5 request for `host` (a domain, or an IPv4/IPv6 literal) and `port`. */
export function socks5Request(command: number, host: string, port: number, type: 'domain' | 'ipv4' | 'ipv6' = 'domain'): Buffer {
  let address: Buffer
  if (type === 'ipv4') address = Buffer.from([0x01, ...host.split('.').map(Number)])
  else if (type === 'ipv6') {
    const [head, tail = ''] = host.split('::')
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
    address = Buffer.concat([Buffer.from([0x04]), Buffer.from(groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff] }))])
  } else address = Buffer.concat([Buffer.from([0x03, Buffer.byteLength(host)]), Buffer.from(host)])
  return Buffer.concat([Buffer.from([0x05, command, 0x00]), address, Buffer.from([port >> 8, port & 0xff])])
}

/** Reads exactly `n` bytes from a paused socket. */
export async function readBytes(socket: net.Socket, n: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let have = 0
  while (have < n) {
    const chunk = socket.read() as Buffer | null
    if (chunk) {
      chunks.push(chunk)
      have += chunk.length
      continue
    }
    if (socket.readableEnded || socket.destroyed) break
    await Promise.race([once(socket, 'readable'), once(socket, 'close')])
  }
  const all = Buffer.concat(chunks)
  if (all.length > n) socket.unshift(all.subarray(n))
  return all.subarray(0, n)
}

/**
 * A SOCKS5 client: greets with "no authentication", sends `request`, and
 * answers the reply code with the socket (ready for the stream when it is 0).
 */
export async function socks5Connect(port: number, request: Buffer): Promise<{ socket: net.Socket; reply: number }> {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
  socket.on('error', () => {})
  await once(socket, 'connect')
  socket.pause()
  socket.write(Buffer.from([0x05, 0x01, 0x00]))
  const method = await readBytes(socket, 2)
  if (method[1] !== 0x00) return { socket, reply: -1 }
  socket.write(request)
  const reply = await readBytes(socket, 10)
  return { socket, reply: reply.length >= 2 ? reply[1] : -2 }
}

/** Everything a socket sends until it ends. */
export async function readToEnd(socket: net.Socket): Promise<Buffer> {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  if (!socket.readableEnded) await Promise.race([once(socket, 'end'), once(socket, 'close')])
  return Buffer.concat(chunks)
}
