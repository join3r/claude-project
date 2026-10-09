import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { b64uEncode, buildHello, RelayCloseCode } from '../../protocol/ts/index.ts'
import { startRelayServer } from '../src/server.ts'
import type { RelayServer } from '../src/server.ts'
import { SqliteStore } from '../src/store.ts'
import type { RelayStore } from '../src/store.ts'
import {
  TestClient,
  authorizedPair,
  closedWithin,
  makeDevice,
  makeSecret,
  pendingPair,
  sleep,
  startTestRelay,
  tempDir
} from './helpers.ts'

const servers: RelayServer[] = []
const clients: TestClient[] = []
const cleanups: Array<() => void> = []

async function relay(options: Parameters<typeof startTestRelay>[0] = {}): Promise<RelayServer> {
  const server = await startTestRelay(options)
  servers.push(server)
  return server
}

function track<T extends TestClient>(client: T): T {
  clients.push(client)
  return client
}

async function auth(...args: Parameters<typeof TestClient.auth>): Promise<TestClient> {
  return track(await TestClient.auth(...args))
}

afterEach(async () => {
  for (const c of clients.splice(0)) if (!c.isClosed) c.ws.close()
  for (const s of servers.splice(0)) await s.close()
  for (const f of cleanups.splice(0)) f()
})

/** Sends a raw HTTP request and returns the status line. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request))
    let data = ''
    socket.on('data', (d) => {
      data += d.toString('latin1')
      if (data.includes('\r\n')) {
        socket.destroy()
        resolve(data.split('\r\n')[0])
      }
    })
    socket.on('error', reject)
  })
}

function upgradeRequest(path: string, headers = ''): string {
  return `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`
}

describe('http', () => {
  it('answers /healthz, 404s everything else, and only upgrades /v1', async () => {
    const server = await relay()
    const base = `http://127.0.0.1:${server.port}`
    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/v2`)).status).toBe(404)
    expect(await rawRequest(server.port, upgradeRequest('/v2'))).toBe('HTTP/1.1 404 Not Found')
    expect(await rawRequest(server.port, upgradeRequest('/v1'))).toBe('HTTP/1.1 101 Switching Protocols')
  })
})

describe('auth', () => {
  it('sends a challenge and answers a valid hello with ready and the device ID', async () => {
    const server = await relay()
    const device = makeDevice()
    const client = track(await TestClient.connect(server))
    expect(client.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    client.send(buildHello({ role: 'desktop', nonce: client.nonce, ed25519Priv: device.ed.priv, ed25519Pub: device.ed.pub }))
    expect(await client.next()).toEqual({ t: 'ready', id: device.id })
  })

  it('rejects a signature over another nonce with auth + 4401', async () => {
    const server = await relay()
    const device = makeDevice()
    const client = track(await TestClient.connect(server))
    const wrongNonce = b64uEncode(new Uint8Array(32))
    client.send(buildHello({ role: 'phone', nonce: wrongNonce, ed25519Priv: device.ed.priv, ed25519Pub: device.ed.pub }))
    expect(await client.next()).toMatchObject({ t: 'error', code: 'auth' })
    expect((await closedWithin(client)).code).toBe(RelayCloseCode.Auth)
  })

  it('rejects a hello signed for the other role', async () => {
    const server = await relay()
    const device = makeDevice()
    const client = track(await TestClient.connect(server))
    const hello = buildHello({ role: 'phone', nonce: client.nonce, ed25519Priv: device.ed.priv, ed25519Pub: device.ed.pub })
    client.send({ ...hello, role: 'desktop' })
    expect((await closedWithin(client)).code).toBe(RelayCloseCode.Auth)
  })

  it('rejects anything other than hello first, including malformed JSON', async () => {
    const server = await relay()
    const a = track(await TestClient.connect(server))
    a.send({ t: 'ping' })
    expect(await a.next()).toMatchObject({ t: 'error', code: 'auth' })
    expect((await closedWithin(a)).code).toBe(RelayCloseCode.Auth)
    const b = track(await TestClient.connect(server))
    b.send('not json')
    expect((await closedWithin(b)).code).toBe(RelayCloseCode.Auth)
  })

  it('closes with 4408 when no hello arrives in time', async () => {
    const server = await relay({ limits: { helloTimeoutMs: 200 } })
    const client = track(await TestClient.connect(server))
    const started = Date.now()
    expect((await closedWithin(client)).code).toBe(RelayCloseCode.HelloTimeout)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })
})

describe('pairing', () => {
  it('routes both ways for a pending phone, persists authorize, and survives a relay restart', async () => {
    const dir = tempDir()
    cleanups.push(dir.remove)
    const dbPath = `${dir.path}/relay.db`
    let store: RelayStore = new SqliteStore(dbPath)
    let server = await startRelayServer({ store, port: 0, host: '127.0.0.1' })

    const desktopDevice = makeDevice()
    const phoneDevice = makeDevice()
    const { desktop, phone } = await pendingPair(server, desktopDevice, phoneDevice)

    phone.frame(desktopDevice.id, 'AQ')
    expect(await desktop.nextOfType('frame')).toEqual({ t: 'frame', from: phoneDevice.id, data: 'AQ' })
    desktop.frame(phoneDevice.id, 'Ag')
    expect(await phone.nextOfType('frame')).toEqual({ t: 'frame', from: desktopDevice.id, data: 'Ag' })

    desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(phoneDevice.ed.pub) })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong')
    expect(store.getPair(desktopDevice.id, phoneDevice.id)).toMatchObject({
      ownerRole: 'desktop',
      kind: 'phone',
      peerPub: b64uEncode(phoneDevice.ed.pub),
      ownerPub: b64uEncode(desktopDevice.ed.pub)
    })
    expect(await desktop.drain(50)).toEqual([])

    // Restart the relay on the same database: the pair is all that survives.
    await server.close()
    await Promise.all([closedWithin(desktop), closedWithin(phone)])
    store.close()
    store = new SqliteStore(dbPath)
    server = await startRelayServer({ store, port: 0, host: '127.0.0.1' })
    servers.push(server)
    cleanups.unshift(() => store.close())

    const desktop2 = await auth(server, 'desktop', desktopDevice)
    const phone2 = await auth(server, 'phone', phoneDevice)
    expect(await desktop2.nextOfType('peer')).toEqual({ t: 'peer', id: phoneDevice.id, state: 'online' })
    phone2.send({ t: 'watch', desktops: [desktopDevice.id] })
    expect(await phone2.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'online' })
    phone2.frame(desktopDevice.id, 'Aw')
    expect(await desktop2.nextOfType('frame')).toEqual({ t: 'frame', from: phoneDevice.id, data: 'Aw' })
    desktop2.frame(phoneDevice.id, 'BA')
    expect(await phone2.nextOfType('frame')).toEqual({ t: 'frame', from: desktopDevice.id, data: 'BA' })
  })

  it('uses an offer once: a second phone with the same token is refused', async () => {
    const server = await relay()
    const { desktop, desktopDevice, secret } = await pendingPair(server)
    clients.push(desktop)
    const late = makeDevice()
    const phone2 = await auth(server, 'phone', late, { to: desktopDevice.id, token: secret.token })
    expect(await phone2.nextOfType('error')).toMatchObject({ code: 'forbidden', to: desktopDevice.id })
    phone2.frame(desktopDevice.id)
    expect(await phone2.nextOfType('error')).toMatchObject({ code: 'forbidden', to: desktopDevice.id })
    expect(await desktop.drain(50)).toEqual([])
  })

  it('refuses an expired offer, a wrong token and a replaced offer', async () => {
    const server = await relay()
    const desktopDevice = makeDevice()
    const desktop = await auth(server, 'desktop', desktopDevice)
    const expired = makeSecret()
    desktop.send({ t: 'offer', tokenHash: expired.tokenHash, exp: Math.floor(Date.now() / 1000) - 1 })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong')
    const a = await auth(server, 'phone', makeDevice(), { to: desktopDevice.id, token: expired.token })
    expect(await a.nextOfType('error')).toMatchObject({ code: 'forbidden', to: desktopDevice.id })

    const first = makeSecret()
    const second = makeSecret()
    desktop.send({ t: 'offer', tokenHash: first.tokenHash, exp: Math.floor(Date.now() / 1000) + 300 })
    desktop.send({ t: 'offer', tokenHash: second.tokenHash, exp: Math.floor(Date.now() / 1000) + 300 })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong')
    const b = await auth(server, 'phone', makeDevice(), { to: desktopDevice.id, token: first.token })
    expect(await b.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    const c = await auth(server, 'phone', makeDevice(), { to: desktopDevice.id, token: makeSecret().token })
    expect(await c.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    const d = await auth(server, 'phone', makeDevice(), { to: desktopDevice.id, token: second.token })
    expect(await d.drain(50)).toEqual([])
    expect(await desktop.nextOfType('peer')).toMatchObject({ id: d.id, state: 'online' })
  })

  it('disconnects a pending phone whose offer lapses without authorize', async () => {
    const server = await relay()
    const desktopDevice = makeDevice()
    const desktop = await auth(server, 'desktop', desktopDevice)
    const secret = makeSecret()
    // Expires 1-2 s from now (exp has whole-second granularity).
    const exp = Math.ceil(Date.now() / 1000) + 1
    desktop.send({ t: 'offer', tokenHash: secret.tokenHash, exp })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong')
    const phoneDevice = makeDevice()
    const phone = await auth(server, 'phone', phoneDevice, { to: desktopDevice.id, token: secret.token })
    expect(await desktop.nextOfType('peer')).toMatchObject({ id: phoneDevice.id, state: 'online' })
    expect(await phone.nextOfType('error', 3000)).toMatchObject({ code: 'forbidden', to: desktopDevice.id, message: 'pairing window expired' })
    expect((await closedWithin(phone)).code).toBe(RelayCloseCode.PairingExpired)
    expect(await desktop.nextOfType('peer')).toMatchObject({ id: phoneDevice.id, state: 'offline' })
    // Authorizing after the window is too late.
    desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(phoneDevice.ed.pub) })
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: phoneDevice.id })
  })

  it('lets a pending phone reconnect within the window without a new offer', async () => {
    const server = await relay()
    const { desktop, phone, desktopDevice, phoneDevice } = await pendingPair(server)
    clients.push(desktop, phone)
    phone.ws.close()
    await desktop.next((m) => m.t === 'peer' && m.state === 'offline')
    const again = await auth(server, 'phone', phoneDevice)
    await desktop.next((m) => m.t === 'peer' && m.state === 'online')
    again.frame(desktopDevice.id)
    expect(await desktop.nextOfType('frame')).toMatchObject({ from: phoneDevice.id })
  })

  it('only authorizes pending or already authorized phones, with the authenticated key', async () => {
    const server = await relay()
    const { desktop, phoneDevice } = await pendingPair(server)
    clients.push(desktop)
    const stranger = makeDevice()
    desktop.send({ t: 'authorize', phone: stranger.id, pub: b64uEncode(stranger.ed.pub) })
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: stranger.id })
    // A pub that isn't the phone's own key: the ID won't match.
    desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(stranger.ed.pub) })
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'bad-request', to: phoneDevice.id })
    desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(phoneDevice.ed.pub) })
    desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(phoneDevice.ed.pub) })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong')
    expect(await desktop.drain(50)).toEqual([])
  })

  it('does not let phones send desktop messages or servers send watch', async () => {
    const server = await relay()
    const phone = await auth(server, 'phone', makeDevice())
    phone.send({ t: 'offer', tokenHash: makeSecret().tokenHash, exp: 1 })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    // Desktops may watch (servers); servers have nobody to watch.
    const host = await auth(server, 'server', makeDevice())
    host.send({ t: 'watch', desktops: [] })
    expect(await host.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    const desktop = await auth(server, 'desktop', makeDevice())
    desktop.send('{"t":"frame","to":"nope","data":"AA"}')
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    desktop.send('garbage')
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    desktop.ws.send(new Uint8Array([1, 2, 3]))
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    desktop.send({ t: 'ping' })
    expect(await desktop.nextOfType('pong')).toEqual({ t: 'pong' })
  })
})

describe('routing', () => {
  it('forbids frames between unpaired devices, and to oneself', async () => {
    const server = await relay()
    const desktopDevice = makeDevice()
    const desktop = await auth(server, 'desktop', desktopDevice)
    const phone = await auth(server, 'phone', makeDevice())
    phone.frame(desktopDevice.id)
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden', to: desktopDevice.id })
    desktop.frame(phone.id)
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: phone.id })
    desktop.frame(desktopDevice.id)
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    expect(await desktop.drain(50)).toEqual([])
  })

  it('answers offline for a paired recipient that is not connected, and queues nothing', async () => {
    const server = await relay()
    const { desktop, phone, desktopDevice, phoneDevice } = await authorizedPair(server)
    clients.push(phone)
    desktop.ws.close()
    await closedWithin(desktop)
    await phone.drain(50)
    phone.frame(desktopDevice.id, 'BQ')
    expect(await phone.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: desktopDevice.id })
    const back = await auth(server, 'desktop', desktopDevice)
    expect(await back.nextOfType('peer')).toMatchObject({ id: phoneDevice.id, state: 'online' })
    expect(await back.drain(100)).toEqual([])
  })

  it('revoke deletes the pair, tells the phone, and stops routing both ways', async () => {
    const server = await relay()
    const { desktop, phone, desktopDevice, phoneDevice } = await authorizedPair(server)
    clients.push(desktop, phone)
    phone.send({ t: 'watch', desktops: [desktopDevice.id] })
    await phone.nextOfType('peer')
    desktop.send({ t: 'revoke', phone: phoneDevice.id })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'revoked' })
    phone.frame(desktopDevice.id)
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden', to: desktopDevice.id })
    desktop.frame(phoneDevice.id)
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: phoneDevice.id })
    // No more presence for a revoked desktop, and watch now ignores it.
    phone.send({ t: 'watch', desktops: [desktopDevice.id] })
    desktop.ws.close()
    expect(await phone.drain(150)).toEqual([])
    // Revoking again is a no-op.
    const d2 = await auth(server, 'desktop', desktopDevice)
    d2.send({ t: 'revoke', phone: phoneDevice.id })
    d2.send({ t: 'ping' })
    await d2.nextOfType('pong')
    expect(await phone.drain(50)).toEqual([])
  })
})

describe('presence', () => {
  it('reports online/offline with lastSeen to watching phones and to desktops', async () => {
    const server = await relay()
    const { desktop, phone, desktopDevice, phoneDevice } = await authorizedPair(server)
    clients.push(phone)
    phone.send({ t: 'watch', desktops: [desktopDevice.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'online' })

    const before = Date.now()
    desktop.ws.close()
    const offline = await phone.nextOfType('peer')
    expect(offline).toMatchObject({ id: desktopDevice.id, state: 'offline' })
    expect(offline.lastSeen).toBeGreaterThanOrEqual(before - 5)
    expect(offline.lastSeen).toBeLessThanOrEqual(Date.now())

    // A fresh watch reports the remembered lastSeen.
    phone.send({ t: 'watch', desktops: [desktopDevice.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'offline', lastSeen: offline.lastSeen })

    const desktop2 = await auth(server, 'desktop', desktopDevice)
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'online' })
    expect(await desktop2.nextOfType('peer')).toEqual({ t: 'peer', id: phoneDevice.id, state: 'online' })

    phone.ws.close()
    const phoneOffline = await desktop2.nextOfType('peer')
    expect(phoneOffline).toMatchObject({ id: phoneDevice.id, state: 'offline' })
    expect(typeof phoneOffline.lastSeen).toBe('number')

    // A desktop connecting later learns the phone's lastSeen from the roster.
    desktop2.ws.close()
    await closedWithin(desktop2)
    const desktop3 = await auth(server, 'desktop', desktopDevice)
    expect(await desktop3.nextOfType('peer')).toEqual({ t: 'peer', id: phoneDevice.id, state: 'offline', lastSeen: phoneOffline.lastSeen })
  })

  it('watch ignores unauthorized IDs and replies once per authorized one', async () => {
    const server = await relay()
    const { phone, desktop, desktopDevice } = await authorizedPair(server)
    clients.push(phone, desktop)
    const other = await auth(server, 'desktop', makeDevice())
    const neverSeen = makeDevice().id
    phone.send({ t: 'watch', desktops: [other.id, desktopDevice.id, neverSeen, desktopDevice.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: desktopDevice.id, state: 'online' })
    expect(await phone.drain(100)).toEqual([])
    // An unwatched-but-unauthorized desktop's presence never reaches the phone.
    other.ws.close()
    expect(await phone.drain(100)).toEqual([])
    // Nor does an authorized one the phone stopped watching.
    phone.send({ t: 'watch', desktops: [] })
    desktop.ws.close()
    expect(await phone.drain(100)).toEqual([])
  })
})

describe('limits', () => {
  it('closes with 1009 on a message over the maximum size', async () => {
    const server = await relay()
    const desktop = await auth(server, 'desktop', makeDevice())
    desktop.send({ t: 'frame', to: makeDevice().id, data: 'A'.repeat(256 * 1024) })
    expect((await closedWithin(desktop)).code).toBe(RelayCloseCode.TooBig)
  })

  it('accepts a message just under the maximum size', async () => {
    const server = await relay()
    const { desktop, phone, phoneDevice } = await authorizedPair(server)
    clients.push(desktop, phone)
    const overhead = JSON.stringify({ t: 'frame', to: phoneDevice.id, data: '' }).length
    const data = 'A'.repeat(Math.floor((256 * 1024 - overhead) / 4) * 4)
    desktop.frame(phoneDevice.id, data)
    expect((await phone.nextOfType('frame')).data.length).toBe(data.length)
  })

  it('answers rate once, then closes with 4429 when the client keeps going', async () => {
    const server = await relay({ limits: { ratePerSecond: 1, rateBurst: 3 } })
    // Phones keep the two-strike rule; desktops and servers are throttled instead (server-role.test.ts).
    const phone = await auth(server, 'phone', makeDevice())
    // The hello used one token.
    phone.send({ t: 'ping' })
    phone.send({ t: 'ping' })
    phone.send({ t: 'ping' })
    expect(await phone.nextOfType('pong')).toEqual({ t: 'pong' })
    expect(await phone.nextOfType('pong')).toEqual({ t: 'pong' })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'rate' })
    phone.send({ t: 'ping' })
    expect((await closedWithin(phone)).code).toBe(RelayCloseCode.Rate)
  })

  it('forgives a rate violation once the client backs off', async () => {
    const server = await relay({ limits: { ratePerSecond: 20, rateBurst: 2, rateStrikeWindowMs: 100 } })
    const phone = await auth(server, 'phone', makeDevice())
    phone.send({ t: 'ping' })
    phone.send({ t: 'ping' })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'rate' })
    await sleep(200)
    phone.send({ t: 'ping' })
    phone.send({ t: 'ping' })
    phone.send({ t: 'ping' })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'rate' })
    expect(phone.isClosed).toBe(false)
  })

  it('limits new connections per IP', async () => {
    const server = await relay({ limits: { connectionsPerIpPerMinute: 2 } })
    track(await TestClient.connect(server))
    track(await TestClient.connect(server))
    await expect(TestClient.connect(server)).rejects.toThrow()
    expect(await rawRequest(server.port, upgradeRequest('/v1'))).toBe('HTTP/1.1 429 Too Many Requests')
  })

  it('honors X-Forwarded-For only when trusting the proxy', async () => {
    const trusted = await relay({ limits: { connectionsPerIpPerMinute: 1 }, trustProxy: true })
    expect(await rawRequest(trusted.port, upgradeRequest('/v1', 'X-Forwarded-For: 1.1.1.1, 10.0.0.1\r\n'))).toContain('101')
    expect(await rawRequest(trusted.port, upgradeRequest('/v1', 'X-Forwarded-For: 10.0.0.2\r\n'))).toContain('101')
    // Only the last hop counts: a forged left-hand entry doesn't buy a fresh budget.
    expect(await rawRequest(trusted.port, upgradeRequest('/v1', 'X-Forwarded-For: 9.9.9.9, 10.0.0.2\r\n'))).toContain('429')

    const untrusted = await relay({ limits: { connectionsPerIpPerMinute: 1 } })
    expect(await rawRequest(untrusted.port, upgradeRequest('/v1', 'X-Forwarded-For: 10.0.0.3\r\n'))).toContain('101')
    expect(await rawRequest(untrusted.port, upgradeRequest('/v1', 'X-Forwarded-For: 10.0.0.4\r\n'))).toContain('429')
  })

  it('replaces an older connection for the same device ID with 4409, without an offline flap', async () => {
    const server = await relay()
    const { desktop, phone, desktopDevice, phoneDevice } = await authorizedPair(server)
    clients.push(desktop, phone)
    phone.send({ t: 'watch', desktops: [desktopDevice.id] })
    await phone.nextOfType('peer')
    const newer = await auth(server, 'desktop', desktopDevice)
    expect((await closedWithin(desktop)).code).toBe(RelayCloseCode.Replaced)
    const seen = await phone.drain(100)
    expect(seen).toEqual([{ t: 'peer', id: desktopDevice.id, state: 'online' }])
    phone.frame(desktopDevice.id)
    expect(await newer.nextOfType('frame')).toMatchObject({ from: phoneDevice.id })
  })

  it('closes sockets that stay silent past the idle timeout, and pings keep them open', async () => {
    const server = await relay({ limits: { idleTimeoutMs: 300 } })
    const quiet = await auth(server, 'desktop', makeDevice())
    const chatty = await auth(server, 'phone', makeDevice())
    const keepAlive = setInterval(() => chatty.send({ t: 'ping' }), 100)
    try {
      expect((await closedWithin(quiet, 2000)).code).toBe(RelayCloseCode.GoingAway)
      await sleep(200)
      expect(chatty.isClosed).toBe(false)
    } finally {
      clearInterval(keepAlive)
    }
    expect((await closedWithin(chatty, 2000)).code).toBe(RelayCloseCode.GoingAway)
  })

  it('closes every socket with 1001 on shutdown', async () => {
    const server = await startTestRelay()
    const a = await TestClient.auth(server, 'desktop', makeDevice())
    const b = await TestClient.connect(server)
    await server.close()
    expect((await closedWithin(a)).code).toBe(1001)
    expect((await closedWithin(b)).code).toBe(1001)
  })
})
