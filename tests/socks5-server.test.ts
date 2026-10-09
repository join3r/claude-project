import { once } from 'events'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { Socks5Reply, Socks5Server, parseSocks5Request, socksReplyForCode, type Socks5Target } from '../src/main/servers/socks5-server'
import { readBytes, readToEnd, socks5Connect, socks5Request } from './helpers/socks5-client'

/** The SOCKS5 server the browser tabs of server projects use (no auth, CONNECT only). */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A SOCKS server whose CONNECTs reach a local echo server, recording every target. */
async function socksToEcho(fail?: (target: Socks5Target) => Error | null) {
  const open = new Set<net.Socket>()
  const echo = net.createServer({ allowHalfOpen: true }, (socket) => {
    open.add(socket)
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  echo.listen(0, '127.0.0.1')
  await once(echo, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of open) socket.destroy()
    echo.close(() => resolve())
  }))
  const echoPort = (echo.address() as net.AddressInfo).port
  const targets: Socks5Target[] = []
  const socks = new Socks5Server({
    connect: async (target) => {
      targets.push(target)
      const error = fail?.(target)
      if (error) throw error
      const upstream = net.connect({ port: echoPort, host: '127.0.0.1', allowHalfOpen: true })
      await once(upstream, 'connect')
      return upstream
    },
    splice: (client, upstream) => {
      client.pipe(upstream as net.Socket)
      ;(upstream as net.Socket).pipe(client)
    }
  })
  const port = await socks.listen()
  cleanups.push(() => socks.close())
  return { port, targets, socks }
}

describe('SOCKS5 server', () => {
  it('parses CONNECT requests for domains, IPv4 and IPv6 addresses', () => {
    expect(parseSocks5Request(socks5Request(1, 'localhost', 8000))).toEqual({ ok: true, command: 1, target: { host: 'localhost', port: 8000, type: 'domain' }, length: 4 + 1 + 9 + 2 })
    expect(parseSocks5Request(socks5Request(1, '10.0.0.7', 443, 'ipv4'))).toMatchObject({ ok: true, target: { host: '10.0.0.7', port: 443, type: 'ipv4' } })
    expect(parseSocks5Request(socks5Request(1, '::1', 22, 'ipv6'))).toMatchObject({ ok: true, target: { host: '::1', port: 22, type: 'ipv6' } })
    expect(parseSocks5Request(socks5Request(1, 'fd00:1::2:0:0:3', 80, 'ipv6'))).toMatchObject({ target: { host: 'fd00:1::2:0:0:3' } })
    // Incomplete: wait for more.
    expect(parseSocks5Request(socks5Request(1, 'localhost', 8000).subarray(0, 8))).toBeNull()
    expect(parseSocks5Request(Buffer.from([5, 1, 0, 9, 1, 2]))).toEqual({ ok: false, reply: Socks5Reply.AddressTypeNotSupported })
    expect(parseSocks5Request(socks5Request(1, 'localhost', 0))).toEqual({ ok: false, reply: Socks5Reply.HostUnreachable })
  })

  it('maps connect failures to reply codes', () => {
    expect(socksReplyForCode('ECONNREFUSED')).toBe(Socks5Reply.ConnectionRefused)
    expect(socksReplyForCode('ENOTFOUND')).toBe(Socks5Reply.HostUnreachable)
    expect(socksReplyForCode('ETIMEDOUT')).toBe(Socks5Reply.HostUnreachable)
    expect(socksReplyForCode('server-offline')).toBe(Socks5Reply.NetworkUnreachable)
    expect(socksReplyForCode(undefined)).toBe(Socks5Reply.GeneralFailure)
  })

  it('handshakes without authentication and CONNECTs a domain name as is (resolved by whoever dials)', async () => {
    const { port, targets } = await socksToEcho()
    const { socket, reply } = await socks5Connect(port, socks5Request(1, 'localhost', 8000))
    expect(reply).toBe(Socks5Reply.Succeeded)
    expect(targets).toEqual([{ host: 'localhost', port: 8000, type: 'domain' }])
    socket.end('through socks')
    expect((await readToEnd(socket)).toString()).toBe('through socks')
  })

  it('CONNECTs IPv4 and IPv6 addresses', async () => {
    const { port, targets } = await socksToEcho()
    for (const [host, type] of [['127.0.0.1', 'ipv4'], ['::1', 'ipv6']] as const) {
      const { socket, reply } = await socks5Connect(port, socks5Request(1, host, 9000, type))
      expect(reply).toBe(Socks5Reply.Succeeded)
      socket.destroy()
    }
    expect(targets.map((t) => [t.host, t.type])).toEqual([['127.0.0.1', 'ipv4'], ['::1', 'ipv6']])
  })

  it('passes on bytes the client sent right after its request', async () => {
    const { port } = await socksToEcho()
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    await once(socket, 'connect')
    socket.pause()
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socks5Request(1, 'example.internal', 80), Buffer.from('early')]))
    expect([...await readBytes(socket, 2)]).toEqual([5, 0])
    expect((await readBytes(socket, 10))[1]).toBe(0)
    socket.end()
    expect((await readToEnd(socket)).toString()).toBe('early')
  })

  it('refuses BIND and UDP ASSOCIATE, unknown address types and clients that want authentication', async () => {
    const { port, targets } = await socksToEcho()
    expect((await socks5Connect(port, socks5Request(2, 'localhost', 80))).reply).toBe(Socks5Reply.CommandNotSupported)
    expect((await socks5Connect(port, socks5Request(3, 'localhost', 80))).reply).toBe(Socks5Reply.CommandNotSupported)
    expect((await socks5Connect(port, Buffer.from([5, 1, 0, 9, 0, 0]))).reply).toBe(Socks5Reply.AddressTypeNotSupported)
    expect(targets).toEqual([])

    const socket = net.connect({ port, host: '127.0.0.1' })
    await once(socket, 'connect')
    socket.pause()
    socket.write(Buffer.from([5, 1, 0x02]))
    expect([...await readBytes(socket, 2)]).toEqual([5, 0xff])
  })

  it('answers a failed connect with its reply code, and drops non-SOCKS5 clients', async () => {
    const { port } = await socksToEcho((target) => target.port === 1 ? Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) : null)
    expect((await socks5Connect(port, socks5Request(1, 'localhost', 1))).reply).toBe(Socks5Reply.ConnectionRefused)

    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write(Buffer.from([4, 1, 0, 80, 127, 0, 0, 1, 0]))
    await once(socket, 'close')
  })

  it('listens on 127.0.0.1 only, and close drops every connection', async () => {
    const { port, socks } = await socksToEcho()
    const { socket } = await socks5Connect(port, socks5Request(1, 'localhost', 80))
    expect(socks.connectionCount).toBe(1)
    socket.resume()
    // The client is half-open (allowHalfOpen): it sees the end, and closes when it ends too.
    const closed = once(socket, 'end')
    await socks.close()
    await closed
    expect(socks.connectionCount).toBe(0)
  })
})
