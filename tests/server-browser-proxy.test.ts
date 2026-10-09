import { once } from 'events'
import http from 'http'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerBrowserProxies, proxyLoginHandler } from '../src/main/servers/server-browser-proxy'
import { basic, exchangeUntil, proxyConnect, readToEnd } from './helpers/proxy-client'
import { tcpLoopback } from './helpers/tcp-loopback'

/**
 * Browser tabs of server projects (plan step 9): an authenticated HTTP proxy
 * per server, started on first use and stopped once idle, each request a `tcp`
 * stream the server dials (here: a loopback link whose server dials this machine).
 */

const SRV = 'ab'.repeat(16)
const SRV2 = 'cd'.repeat(16)

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
  it('serves an HTTP page on the server\'s localhost, with the credentials only DevTool knows', async () => {
    const web = await httpServer()
    const { p, routes } = proxies()
    const port = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    expect(routes).toEqual([['proj', port]])
    const request = `GET http://localhost:${web}/notes/ HTTP/1.1\r\nHost: localhost:${web}\r\n`
    expect(await exchangeUntil(port, `${request}\r\n`, (t) => t.includes('\r\n\r\n'))).toMatch(/^HTTP\/1\.1 407/)
    const credentials = p.credentialsFor({ isProxy: true, host: '127.0.0.1', port, realm: 'devtool-abababababab' })!
    expect(credentials.username).toBe('devtool-abababababab')
    expect(Buffer.from(credentials.password, 'base64url')).toHaveLength(32)
    const response = await exchangeUntil(port, `${request}Proxy-Authorization: ${basic(credentials.username, credentials.password)}\r\n\r\n`, (t) => t.includes('listing of'))
    expect(response).toMatch(/^HTTP\/1\.1 200 OK/)
    expect(response).toContain(`listing of /notes/ via localhost:${web}`)
    // And through a CONNECT tunnel (https, ws).
    const { socket, status } = await proxyConnect(port, `localhost:${web}`, basic(credentials.username, credentials.password))
    expect(status).toBe('HTTP/1.1 200 Connection Established')
    socket.write(`GET /tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    expect(await readToEnd(socket)).toContain('listing of /tunnel via localhost')
  })

  it('gives every listener its own secret', async () => {
    const { p } = proxies()
    const a = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    const b = await p.acquire(SRV2, 'proj-2', 'win:1', 'tab-2')
    const ca = p.credentialsFor({ isProxy: true, host: '127.0.0.1', port: a })!
    const cb = p.credentialsFor({ isProxy: true, host: '127.0.0.1', port: b })!
    expect(ca.password).not.toBe(cb.password)
    expect(cb.username).toBe('devtool-cdcdcdcdcdcd')
  })

  it('answers only its own proxies\' challenges in Electron\'s login event', async () => {
    const { p } = proxies()
    const port = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    const handler = proxyLoginHandler(() => p)
    const answer = (authInfo: { isProxy: boolean; host: string; port: number; realm?: string }) => {
      let prevented = false
      let given: [string | undefined, string | undefined] | null = null
      handler({ preventDefault: () => { prevented = true } }, null, {}, authInfo, (u, pw) => { given = [u, pw] })
      return { prevented, given }
    }
    const ours = answer({ isProxy: true, host: '127.0.0.1', port, realm: 'devtool-abababababab' })
    expect(ours.prevented).toBe(true)
    expect(ours.given).toEqual(['devtool-abababababab', p.credentialsFor({ isProxy: true, host: '127.0.0.1', port })!.password])
    for (const other of [
      { isProxy: false, host: '127.0.0.1', port },
      { isProxy: true, host: 'localhost', port },
      { isProxy: true, host: '127.0.0.1', port: port + 1 },
      { isProxy: true, host: '127.0.0.1', port, realm: 'someone-else' },
      { isProxy: true, host: 'proxy.corp.example', port: 3128 }
    ]) {
      expect(answer(other), JSON.stringify(other)).toEqual({ prevented: false, given: null })
    }
    expect(answer({ isProxy: true, host: '127.0.0.1', port }).prevented).toBe(true)
    await p.forget(SRV)
    expect(answer({ isProxy: true, host: '127.0.0.1', port })).toEqual({ prevented: false, given: null })
  })

  it('answers a refused port with 502', async () => {
    const closed = net.createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const dead = (closed.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { p } = proxies()
    const port = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    const { username, password } = p.credentialsFor({ isProxy: true, host: '127.0.0.1', port })!
    const reply = await exchangeUntil(port, `GET http://127.0.0.1:${dead}/ HTTP/1.1\r\nHost: 127.0.0.1:${dead}\r\nProxy-Authorization: ${basic(username, password)}\r\n\r\n`, (t) => t.includes('ECONNREFUSED'))
    expect(reply).toMatch(/^HTTP\/1\.1 502 Bad Gateway/)
    expect(reply).toContain('ECONNREFUSED')
  })

  it('shares one listener per server, and routes each project once', async () => {
    const { p, routes } = proxies()
    const a = await p.acquire(SRV, 'proj-a', 'win:1', 'tab-1')
    const b = await p.acquire(SRV, 'proj-b', 'win:1', 'tab-2')
    const again = await p.acquire(SRV, 'proj-a', 'win:2', 'tab-3')
    const other = await p.acquire(SRV2, 'proj-c', 'win:1', 'tab-4')
    expect(a).toBe(b)
    expect(again).toBe(a)
    expect(other).not.toBe(a)
    expect(routes).toEqual([['proj-a', a], ['proj-b', a], ['proj-c', other]])
  })

  it('stops a listener once its last tab lets go and it stays idle, and routes again on new use', async () => {
    const { p, routes, timers } = proxies()
    const first = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    await p.acquire(SRV, 'proj', 'win:2', 'tab-2')
    p.release('win:1', 'tab-1')
    expect(timers.tasks.size).toBe(0)
    p.releaseClient('win:2')
    expect(timers.tasks.size).toBe(1)
    // Used again before the timer: kept.
    await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    expect(timers.tasks.size).toBe(0)
    p.release('win:1', 'tab-1')
    timers.fire()
    await expect.poll(() => p.port(SRV)).toBeUndefined()
    const refused = net.connect({ port: first, host: '127.0.0.1' })
    const failed = await new Promise<boolean>((resolve) => { refused.once('error', () => resolve(true)); refused.once('connect', () => resolve(false)) })
    refused.destroy()
    expect(failed).toBe(true)
    const second = await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    expect(routes.at(-1)).toEqual(['proj', second])
  })

  it('forgets a removed server at once', async () => {
    const { p } = proxies()
    await p.acquire(SRV, 'proj', 'win:1', 'tab-1')
    await p.forget(SRV)
    expect(p.port(SRV)).toBeUndefined()
  })
})
