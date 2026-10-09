import { once } from 'events'
import http from 'http'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerBrowserProxies } from '../src/main/servers/server-browser-proxy'
import { Socks5Reply } from '../src/main/servers/socks5-server'
import { readToEnd, socks5Connect, socks5Request } from './helpers/socks5-client'
import { tcpLoopback } from './helpers/tcp-loopback'

/**
 * Browser tabs of server projects (plan step 9): a SOCKS5 listener per server,
 * started on first use and stopped once idle, each CONNECT a `tcp` stream the
 * server dials (here: a loopback link whose server dials this machine).
 */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class ManualTimers {
  tasks = new Map<number, () => void>()
  seq = 0
  setTimeout = (fn: () => void) => { const id = ++this.seq; this.tasks.set(id, fn); return id }
  clearTimeout = (handle: unknown) => { this.tasks.delete(handle as number) }
  fire(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) task()
  }
}

async function httpServer(): Promise<number> {
  const server = http.createServer((req, res) => res.end(`listing of ${req.url} via ${req.headers.host}`))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as net.AddressInfo).port
}

function proxies(timers = new ManualTimers()) {
  const loop = tcpLoopback()
  cleanups.push(() => loop.close())
  const routes: [string, number][] = []
  const p = new ServerBrowserProxies({
    openTcp: loop.openTcp,
    route: async (projectId, port) => { routes.push([projectId, port]) },
    log: () => {},
    timers
  })
  cleanups.push(() => p.stop())
  return { p, routes, timers }
}

describe('server browser proxies', () => {
  it('serves an HTTP page on the server\'s localhost through SOCKS5 (domain names resolve on the server)', async () => {
    const web = await httpServer()
    const { p, routes } = proxies()
    const port = await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    expect(routes).toEqual([['proj', port]])
    const { socket, reply } = await socks5Connect(port, socks5Request(1, 'localhost', web))
    expect(reply).toBe(Socks5Reply.Succeeded)
    socket.write(`GET /notes/ HTTP/1.1\r\nHost: localhost:${web}\r\nConnection: close\r\n\r\n`)
    const response = (await readToEnd(socket)).toString()
    expect(response).toMatch(/^HTTP\/1\.1 200 OK/)
    expect(response).toContain(`listing of /notes/ via localhost:${web}`)
  })

  it('answers a refused port with "connection refused"', async () => {
    const closed = net.createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const dead = (closed.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { p } = proxies()
    const port = await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    expect((await socks5Connect(port, socks5Request(1, '127.0.0.1', dead, 'ipv4'))).reply).toBe(Socks5Reply.ConnectionRefused)
  })

  it('shares one listener per server, and routes each project once', async () => {
    const { p, routes } = proxies()
    const a = await p.acquire('srv', 'proj-a', 'win:1', 'tab-1')
    const b = await p.acquire('srv', 'proj-b', 'win:1', 'tab-2')
    const again = await p.acquire('srv', 'proj-a', 'win:2', 'tab-3')
    const other = await p.acquire('srv-2', 'proj-c', 'win:1', 'tab-4')
    expect(a).toBe(b)
    expect(again).toBe(a)
    expect(other).not.toBe(a)
    expect(routes).toEqual([['proj-a', a], ['proj-b', a], ['proj-c', other]])
  })

  it('stops a listener once its last tab lets go and it stays idle, and routes again on new use', async () => {
    const { p, routes, timers } = proxies()
    const first = await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    await p.acquire('srv', 'proj', 'win:2', 'tab-2')
    p.release('win:1', 'tab-1')
    expect(timers.tasks.size).toBe(0)
    p.releaseClient('win:2')
    expect(timers.tasks.size).toBe(1)
    // Used again before the timer: kept.
    await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    expect(timers.tasks.size).toBe(0)
    p.release('win:1', 'tab-1')
    timers.fire()
    await expect.poll(() => p.port('srv')).toBeUndefined()
    const refused = net.connect({ port: first, host: '127.0.0.1' })
    const failed = await new Promise<boolean>((resolve) => { refused.once('error', () => resolve(true)); refused.once('connect', () => resolve(false)) })
    refused.destroy()
    expect(failed).toBe(true)
    const second = await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    expect(routes.at(-1)).toEqual(['proj', second])
  })

  it('forgets a removed server at once', async () => {
    const { p } = proxies()
    await p.acquire('srv', 'proj', 'win:1', 'tab-1')
    await p.forget('srv')
    expect(p.port('srv')).toBeUndefined()
  })
})
