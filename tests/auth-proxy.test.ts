import { once } from 'events'
import http from 'http'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProxyServer, endToEndHeaders, parseAbsoluteHttp, parseAuthority, proxyAuthorized, type ProxyTarget } from '../src/main/servers/auth-proxy'
import { basic, exchangeUntil, proxyConnect, proxyExchange, readToEnd } from './helpers/proxy-client'

/**
 * The authenticated HTTP proxy for the browser tabs of server projects (plan
 * step 9). Upstreams here are plain sockets to stand-in origins on this machine:
 * the test maps the names it is asked for (a.test, b.test) to their ports.
 */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const USER = 'devtool-0123456789ab'
const PASS = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlYw'
const AUTH = basic(USER, PASS)

interface Origin {
  port: number
  /** Everything each connection to this origin received. */
  connections: string[]
}

/**
 * A stand-in origin: answers each request head with `<name>:<request line>`
 * and closes (Connection: close), or switches to an echo after a websocket upgrade.
 */
async function origin(name: string): Promise<Origin> {
  const connections: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    const index = connections.push('') - 1
    let upgraded = false
    socket.on('data', (chunk: Buffer) => {
      connections[index] += chunk.toString('latin1')
      if (upgraded) {
        socket.write(chunk)
        return
      }
      const text = connections[index]
      if (!text.includes('\r\n\r\n')) return
      if (/^upgrade: websocket/im.test(text)) {
        upgraded = true
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        return
      }
      const body = `${name}:${text.split('\r\n')[0]}`
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nSet-Cookie: from=${name}\r\nConnection: close\r\n\r\n${body}`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }))
  return { port: (server.address() as net.AddressInfo).port, connections }
}

/** A proxy whose upstreams go to the origins by name; records every target dialled. */
async function proxy(origins: Record<string, Origin>, options: Partial<ConstructorParameters<typeof AuthProxyServer>[0]> = {}) {
  const dialled: ProxyTarget[] = []
  const server = new AuthProxyServer({
    username: USER,
    password: PASS,
    realm: USER,
    connect: async (target) => {
      dialled.push(target)
      const known = origins[target.host]
      const socket = net.connect({ host: '127.0.0.1', port: known ? known.port : target.port, allowHalfOpen: true })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', (err) => reject(Object.assign(err, { code: (err as NodeJS.ErrnoException).code })))
      })
      socket.pause()
      return socket
    },
    splice: (client, upstream) => {
      const socket = upstream as net.Socket
      client.pipe(socket)
      socket.pipe(client)
      socket.on('error', () => client.destroy())
      client.on('close', () => socket.destroy())
    },
    ...options
  })
  const port = await server.listen()
  cleanups.push(() => server.close())
  return { server, port, dialled }
}

/** One request through the proxy with Node's client; `agent` to share a keep-alive connection. */
function viaProxy(port: number, url: string, options: { agent?: http.Agent; auth?: string | null; method?: string; body?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const host = new URL(url).host
    const req = http.request({
      host: '127.0.0.1', port, path: url, method: options.method ?? 'GET', agent: options.agent ?? false,
      headers: { Host: host, ...(options.auth === null ? {} : { 'Proxy-Authorization': options.auth ?? AUTH }) }
    }, (res) => {
      let body = ''
      res.setEncoding('latin1')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers, reused: req.reusedSocket }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('authenticated proxy', () => {
  it('parses authorities, absolute URLs, credentials and hop-by-hop headers', () => {
    expect(parseAuthority('localhost:443')).toEqual({ host: 'localhost', port: 443 })
    expect(parseAuthority('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
    for (const bad of ['localhost', 'host:0', 'host:70000', 'a b:1', 'user@host:1', 'http://x:1']) expect(parseAuthority(bad), bad).toBeNull()
    expect(parseAbsoluteHttp('http://localhost:8000/a/b?c=1')).toEqual({ target: { host: 'localhost', port: 8000 }, path: '/a/b?c=1', hostHeader: 'localhost:8000' })
    expect(parseAbsoluteHttp('http://[::1]/')).toEqual({ target: { host: '::1', port: 80 }, path: '/', hostHeader: '[::1]' })
    for (const bad of ['/relative', 'https://x/', 'http://u:p@x/', 'ftp://x/', undefined]) expect(parseAbsoluteHttp(bad), String(bad)).toBeNull()
    const token = Buffer.from(`${USER}:${PASS}`).toString('base64')
    expect(proxyAuthorized(`Basic ${token}`, token)).toBe(true)
    expect(proxyAuthorized(`basic  ${token} `, token)).toBe(true)
    for (const bad of [`Basic ${token}x`, `Bearer ${token}`, `Basic ${token}, Basic ${token}`, undefined]) expect(proxyAuthorized(bad, token)).toBe(false)
    expect(endToEndHeaders(['Host', 'a', 'Proxy-Authorization', 'x', 'Connection', 'keep-alive, X-Secret', 'X-Secret', '1', 'Keep-Alive', '5', 'TE', 'trailers', 'Cookie', 'c=1']))
      .toEqual([['Host', 'a'], ['Cookie', 'c=1']])
    expect(endToEndHeaders(['Host', 'a', 'Connection', 'Upgrade', 'Upgrade', 'websocket', 'Proxy-Connection', 'x'], true))
      .toEqual([['Host', 'a'], ['Connection', 'Upgrade'], ['Upgrade', 'websocket']])
  })

  it('answers 407 on every path without credentials, or with wrong ones, and dials nothing', async () => {
    const a = await origin('A')
    const { port, dialled } = await proxy({ 'a.test': a })
    for (const auth of [null, basic(USER, 'wrong'), basic('someone', PASS), 'Basic !!!']) {
      const res = await viaProxy(port, 'http://a.test/', { auth })
      expect(res.status).toBe(407)
      expect(res.headers['proxy-authenticate']).toBe(`Basic realm="${USER}"`)
    }
    expect((await proxyConnect(port, 'a.test:443')).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect((await proxyConnect(port, 'a.test:443', basic(USER, 'nope'))).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    const upgrade = await proxyExchange(port, 'GET http://a.test/ws HTTP/1.1\r\nHost: a.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    expect(upgrade).toMatch(/^HTTP\/1\.1 407/)
    expect(dialled).toEqual([])
  })

  it('forwards plain http in origin form without the proxy\'s headers, body framed by Node', async () => {
    const a = await origin('A')
    const { port } = await proxy({ 'a.test': a })
    const res = await viaProxy(port, 'http://a.test/api/items?x=1', { method: 'POST', body: 'payload' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('A:POST /api/items?x=1 HTTP/1.1')
    expect(res.headers['set-cookie']).toEqual(['from=A'])
    const sent = a.connections[0]
    expect(sent).toMatch(/^POST \/api\/items\?x=1 HTTP\/1\.1\r\n/)
    expect(sent).toMatch(/\r\nhost: a\.test\r\n/i)
    expect(sent).toMatch(/\r\nconnection: close\r\n/i)
    expect(sent).not.toMatch(/proxy-/i)
  })

  it('gives each request on one keep-alive client connection its own upstream to its own origin', async () => {
    const a = await origin('A')
    const b = await origin('B')
    const { port, dialled } = await proxy({ 'a.test': a, 'b.test': b })
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    cleanups.push(() => agent.destroy())
    const first = await viaProxy(port, 'http://a.test/one', { agent })
    const second = await viaProxy(port, 'http://b.test/two', { agent })
    expect(second.reused).toBe(true)
    expect(first.body).toBe('A:GET /one HTTP/1.1')
    expect(second.body).toBe('B:GET /two HTTP/1.1')
    expect(second.headers['set-cookie']).toEqual(['from=B'])
    expect(dialled).toEqual([{ host: 'a.test', port: 80 }, { host: 'b.test', port: 80 }])
    expect(a.connections).toHaveLength(1)
    expect(a.connections[0]).not.toContain('/two')
    expect(b.connections).toHaveLength(1)
  })

  it('keeps pipelined and smuggled requests off another origin\'s upstream', async () => {
    const a = await origin('A')
    const b = await origin('B')
    const { port } = await proxy({ 'a.test': a, 'b.test': b })
    // Pipelined: two requests in one write; each goes to its own origin.
    const pipelined = await exchangeUntil(port,
      `GET http://a.test/1 HTTP/1.1\r\nHost: a.test\r\nProxy-Authorization: ${AUTH}\r\n\r\n` +
      `GET http://b.test/2 HTTP/1.1\r\nHost: b.test\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
      (text) => text.includes('B:GET'))
    expect(pipelined).toContain('A:GET /1 HTTP/1.1')
    expect(pipelined).toContain('B:GET /2 HTTP/1.1')
    expect(a.connections.join('')).not.toContain('GET /2 ')
    expect(b.connections.join('')).not.toContain('GET /1 ')

    // Content-Length and Transfer-Encoding together: refused before any upstream.
    const before = a.connections.length + b.connections.length
    const smuggled = await proxyExchange(port,
      `POST http://a.test/ HTTP/1.1\r\nHost: a.test\r\nProxy-Authorization: ${AUTH}\r\nContent-Length: 60\r\nTransfer-Encoding: chunked\r\n\r\n` +
      `0\r\n\r\nGET http://b.test/smuggled HTTP/1.1\r\nHost: b.test\r\nProxy-Authorization: ${AUTH}\r\n\r\n`)
    expect(smuggled).toMatch(/^HTTP\/1\.1 400/)
    expect(a.connections.length + b.connections.length).toBe(before)
    expect(b.connections.join('')).not.toContain('smuggled')

    // A request hidden in a body stays that origin's body.
    const hidden = `GET http://b.test/hidden HTTP/1.1\r\nHost: b.test\r\nProxy-Authorization: ${AUTH}\r\n\r\n`
    const upload = await exchangeUntil(port, `POST http://a.test/upload HTTP/1.1\r\nHost: a.test\r\nProxy-Authorization: ${AUTH}\r\nContent-Length: ${hidden.length}\r\n\r\n${hidden}`,
      (text) => text.includes('A:POST'))
    expect(upload).toContain('A:POST /upload HTTP/1.1')
    expect(b.connections.join('')).not.toContain('hidden')
  })

  it('tunnels CONNECT to the host it names', async () => {
    const a = await origin('A')
    const { port, dialled } = await proxy({ 'a.test': a })
    const { socket, status } = await proxyConnect(port, 'a.test:443', AUTH)
    expect(status).toBe('HTTP/1.1 200 Connection Established')
    expect(dialled).toEqual([{ host: 'a.test', port: 443 }])
    socket.write('GET /inside HTTP/1.1\r\nHost: a.test\r\n\r\n')
    expect(await readToEnd(socket)).toContain('A:GET /inside HTTP/1.1')
  })

  it('carries a websocket upgrade over plain http', async () => {
    const a = await origin('A')
    const { port } = await proxy({ 'a.test': a })
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write(`GET http://a.test/ws HTTP/1.1\r\nHost: a.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nProxy-Authorization: ${AUTH}\r\n\r\n`)
    let text = ''
    while (!text.includes('\r\n\r\n')) text += ((await once(socket, 'data'))[0] as Buffer).toString('latin1')
    expect(text).toMatch(/^HTTP\/1\.1 101 Switching Protocols/)
    expect(a.connections[0]).toMatch(/^GET \/ws HTTP\/1\.1\r\n/)
    expect(a.connections[0]).toMatch(/\r\nUpgrade: websocket\r\n/)
    expect(a.connections[0]).not.toMatch(/proxy-authorization/i)
    socket.write('frame')
    expect(((await once(socket, 'data'))[0] as Buffer).toString()).toBe('frame')
    socket.destroy()
  })

  it('refuses https in absolute form and origin-form requests; 502 when the origin refuses', async () => {
    const { port, dialled } = await proxy({})
    expect((await viaProxy(port, 'https://a.test/')).status).toBe(400)
    expect(await proxyExchange(port, `GET / HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${AUTH}\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/)
    expect(dialled).toEqual([])
    const closed = net.createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const dead = (closed.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = await viaProxy(port, `http://127.0.0.1:${dead}/`)
    expect(refused.status).toBe(502)
    expect(refused.body).toContain('ECONNREFUSED')
  })

  it('refuses an oversize head with 431, and caps upstreams with 503', async () => {
    const a = await origin('A')
    const { port, dialled } = await proxy({ 'a.test': a }, { maxUpstreams: 1 })
    const huge = `GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\nX-Big: ${'a'.repeat(20 * 1024)}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`
    expect(await proxyExchange(port, huge)).toMatch(/^HTTP\/1\.1 431/)
    expect(dialled).toEqual([])
    const held = await proxyConnect(port, 'a.test:443', AUTH)
    expect(held.status).toBe('HTTP/1.1 200 Connection Established')
    expect((await viaProxy(port, 'http://a.test/')).status).toBe(503)
    expect((await proxyConnect(port, 'a.test:443', AUTH)).status).toBe('HTTP/1.1 503 Service Unavailable')
    held.socket.destroy()
  })

  it('listens on 127.0.0.1 only', async () => {
    const { server } = await proxy({})
    const lan = Object.values((await import('os')).networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address
    if (!lan) return
    const socket = net.connect({ port: server.port, host: lan })
    const failed = await new Promise<boolean>((resolve) => { socket.once('error', () => resolve(true)); socket.once('connect', () => resolve(false)) })
    socket.destroy()
    expect(failed).toBe(true)
  })
})
