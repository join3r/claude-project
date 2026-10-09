import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RELAY_BUFFER_HIGH_WATER_BYTES,
  RELAY_BUFFER_LOW_WATER_BYTES,
  RELAY_HOST_BUFFER_CAP_BYTES,
  RELAY_HOST_BYTES_BURST,
  RELAY_HOST_BYTES_PER_SECOND,
  RELAY_HOST_RATE_BURST,
  RELAY_HOST_RATE_PER_SECOND,
  RELAY_PATH,
  RELAY_PHONE_BUFFER_CAP_BYTES,
  RELAY_RATE_BURST,
  RELAY_RATE_PER_SECOND,
  RelayCloseCode,
  b64uEncode,
  buildHello,
  encodeRelayBinaryFrame,
  encodeRelayMessage,
  parseServerMessage
} from '../../protocol/ts/index.ts'
import type { ClientMessage, Role, ServerMessage } from '../../protocol/ts/index.ts'
import { DEFAULT_LIMITS } from '../src/relay.ts'
import type { RelayLimits } from '../src/relay.ts'
import { startRelayServer } from '../src/server.ts'
import type { RelayServer } from '../src/server.ts'
import { MemoryStore, SqliteStore } from '../src/store.ts'
import { TestClient, closedWithin, makeDevice, makeSecret, offer, roundTrip, sleep, startTestRelay, tempDir } from './helpers.ts'
import type { Device } from './helpers.ts'

/**
 * §3.8–§3.11: the `server` role, desktop↔server pairing in both directions, generalized
 * routing and presence, binary frames, per-role budgets and backpressure.
 */

const servers: RelayServer[] = []
const clients: Array<{ close(): unknown; isClosed: boolean }> = []
const cleanups: Array<() => void> = []

async function relay(options: Parameters<typeof startTestRelay>[0] = {}): Promise<RelayServer> {
  const server = await startTestRelay(options)
  servers.push(server)
  return server
}

async function auth(...args: Parameters<typeof TestClient.auth>): Promise<TestClient> {
  const client = await TestClient.auth(...args)
  clients.push({ close: () => client.ws.close(), get isClosed() { return client.isClosed } })
  return client
}

afterEach(async () => {
  for (const c of clients.splice(0)) if (!c.isClosed) c.close()
  for (const s of servers.splice(0)) await s.close()
  for (const f of cleanups.splice(0)) f()
})

const pubOf = (device: Device): string => b64uEncode(device.ed.pub)
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

/** Token flow (§3.8): the desktop offers, the server pairs in its hello, the desktop authorizes. */
async function tokenFlow(server: RelayServer, options: { desktopBinary?: boolean; serverBinary?: boolean } = {}) {
  const dDev = makeDevice()
  const sDev = makeDevice()
  const desktop = await auth(server, 'desktop', dDev, undefined, { binary: options.desktopBinary ?? true })
  const secret = await offer(desktop)
  const srv = await auth(server, 'server', sDev, { to: dDev.id, token: secret.token }, { binary: options.serverBinary ?? true })
  expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })
  desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
  await roundTrip(desktop)
  return { desktop, srv, dDev, sDev }
}

/** Code flow (§3.8): the server offers, a connected desktop sends `pair`, the server authorizes. */
async function codeFlow(server: RelayServer) {
  const dDev = makeDevice()
  const sDev = makeDevice()
  const srv = await auth(server, 'server', sDev, undefined, { binary: true })
  const desktop = await auth(server, 'desktop', dDev, undefined, { binary: true })
  const secret = await offer(srv)
  desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
  expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })
  srv.send({ t: 'authorize', peer: dDev.id, pub: pubOf(dDev) })
  await roundTrip(srv)
  return { desktop, srv, dDev, sDev }
}

describe('server role', () => {
  it('authenticates a server, and confirms binary frames only to a hello that asked', async () => {
    const server = await relay()
    const sDev = makeDevice()
    const srv = await TestClient.connect(server)
    clients.push({ close: () => srv.ws.close(), get isClosed() { return srv.isClosed } })
    srv.send(buildHello({ role: 'server', nonce: srv.nonce, ed25519Priv: sDev.ed.priv, ed25519Pub: sDev.ed.pub, binary: true }))
    expect(await srv.next()).toEqual({ t: 'ready', id: sDev.id, binary: true })

    const dDev = makeDevice()
    const desktop = await TestClient.connect(server)
    clients.push({ close: () => desktop.ws.close(), get isClosed() { return desktop.isClosed } })
    desktop.send(buildHello({ role: 'desktop', nonce: desktop.nonce, ed25519Priv: dDev.ed.priv, ed25519Pub: dDev.ed.pub }))
    // Byte for byte what relays before servers sent.
    const raw = await new Promise<string>((resolve) => desktop.ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true }))
    expect(raw).toBe(`{"t":"ready","id":"${dDev.id}"}`)
  })

  it('answers an unknown role with unsupported and 4401, and unknown messages with unsupported', async () => {
    const server = await relay()
    const stranger = await TestClient.connect(server)
    clients.push({ close: () => stranger.ws.close(), get isClosed() { return stranger.isClosed } })
    stranger.send(JSON.stringify({ t: 'hello', role: 'toaster', pub: b64uEncode(new Uint8Array(32)), sig: b64uEncode(new Uint8Array(64)) }))
    expect(await stranger.next()).toEqual({ t: 'error', code: 'unsupported', message: 'unknown role toaster' })
    expect((await closedWithin(stranger)).code).toBe(RelayCloseCode.Auth)

    const srv = await auth(server, 'server', makeDevice())
    srv.send(JSON.stringify({ t: 'teleport', to: 'mars' }))
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'unsupported' })
    // A known message that is malformed is still bad-request.
    srv.send(JSON.stringify({ t: 'pair', to: 'nope', token: 'AA' }))
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    await roundTrip(srv)
  })

  it('lets servers offer, authorize, revoke and push, and phones none of it', async () => {
    const server = await relay()
    const srv = await auth(server, 'server', makeDevice())
    await offer(srv)
    srv.send({ t: 'push', id: 7, cap: 'c', data: 'AQ' })
    expect(await srv.nextOfType('pushed')).toEqual({ t: 'pushed', id: 7, result: 'unavailable' })
    const phone = await auth(server, 'phone', makeDevice())
    const stranger = makeDevice()
    for (const message of [
      { t: 'authorize', peer: stranger.id, pub: pubOf(stranger) },
      { t: 'revoke', peer: stranger.id },
      { t: 'push', id: 1, cap: 'c', data: 'AQ' }
    ] as ClientMessage[]) {
      phone.send(message)
      expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden' })
    }
  })
})

describe('desktop↔server pairing', () => {
  it('token flow: pending on the hello, frames both ways, authorize persists (desktop, server)', async () => {
    const store = new MemoryStore()
    const server = await relay({ store })
    const dDev = makeDevice()
    const sDev = makeDevice()
    const desktop = await auth(server, 'desktop', dDev, undefined, { binary: true })
    const secret = await offer(desktop)
    const srv = await auth(server, 'server', sDev, { to: dDev.id, token: secret.token }, { binary: true })
    // The server hosts the desktop: it gets the desktop's presence by itself...
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })
    // ...while the desktop only learns about the server by watching it.
    expect(await desktop.drain(50)).toEqual([])

    srv.sendBinary(dDev.id, bytes(1, 9))
    expect(await desktop.nextBinary()).toEqual({ peer: sDev.id, envelope: bytes(1, 9) })
    desktop.sendBinary(sDev.id, bytes(2, 8))
    expect(await srv.nextBinary()).toEqual({ peer: dDev.id, envelope: bytes(2, 8) })

    desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
    await roundTrip(desktop)
    expect(store.getPair(dDev.id, sDev.id)).toMatchObject({ ownerRole: 'desktop', kind: 'server', peerPub: pubOf(sDev), ownerPub: pubOf(dDev) })
    expect(server.relay.stats().pending).toBe(0)

    desktop.send({ t: 'watch', desktops: [sDev.id] })
    expect(await desktop.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'online' })
    srv.ws.close()
    const gone = await desktop.nextOfType('peer')
    expect(gone).toMatchObject({ id: sDev.id, state: 'offline' })
    expect(typeof gone.lastSeen).toBe('number')

    // Back without a token: the pair is enough, and the server's roster has the desktop.
    const again = await auth(server, 'server', sDev, undefined, { binary: true })
    expect(await again.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })
    expect(await desktop.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'online' })
    again.sendBinary(dDev.id, bytes(3))
    expect(await desktop.nextBinary()).toEqual({ peer: sDev.id, envelope: bytes(3) })

    // The server sees the desktop come and go without watching.
    desktop.ws.close()
    expect(await again.nextOfType('peer')).toMatchObject({ id: dDev.id, state: 'offline' })
  })

  it('code flow: the server offers, a connected desktop sends pair, the server authorizes', async () => {
    const store = new MemoryStore()
    const server = await relay({ store })
    const sDev = makeDevice()
    const dDev = makeDevice()
    const srv = await auth(server, 'server', sDev, undefined, { binary: true })
    const desktop = await auth(server, 'desktop', dDev)
    const secret = await offer(srv)
    desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })

    // A JSON desktop and a binary server: the relay converts.
    desktop.frame(sDev.id, 'AQI')
    expect(await srv.nextBinary()).toEqual({ peer: dDev.id, envelope: bytes(1, 2) })
    srv.sendBinary(dDev.id, bytes(3, 4))
    expect(await desktop.nextOfType('frame')).toEqual({ t: 'frame', from: sDev.id, data: 'AwQ' })

    // Only the side that made the offer authorizes.
    desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: sDev.id })
    srv.send({ t: 'authorize', peer: dDev.id, pub: pubOf(dDev) })
    await roundTrip(srv)
    expect(store.getPair(sDev.id, dDev.id)).toMatchObject({ ownerRole: 'server', kind: 'desktop' })
    expect(store.findPair(dDev.id, sDev.id)).not.toBeNull()

    desktop.send({ t: 'watch', desktops: [sDev.id] })
    expect(await desktop.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'online' })

    // The offer was used once; pairing again with it changes nothing.
    desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
    await roundTrip(desktop)
    expect(await desktop.drain(50)).toEqual([])
    const late = await auth(server, 'desktop', makeDevice())
    late.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
    expect(await late.nextOfType('error')).toMatchObject({ code: 'forbidden', to: sDev.id })
  })

  it('refuses two of a kind, oneself and a wrong token, and a refused role does not use up the offer', async () => {
    const server = await relay()
    const d1 = makeDevice()
    const desktop1 = await auth(server, 'desktop', d1)
    const secret = await offer(desktop1)
    const desktop2 = await auth(server, 'desktop', makeDevice())
    desktop2.send({ t: 'pair', to: d1.id, token: b64uEncode(secret.token) })
    expect(await desktop2.nextOfType('error')).toEqual({ t: 'error', code: 'forbidden', message: 'a desktop cannot pair with a desktop', to: d1.id })
    desktop1.send({ t: 'pair', to: d1.id, token: b64uEncode(secret.token) })
    expect(await desktop1.nextOfType('error')).toMatchObject({ code: 'forbidden', to: d1.id })
    desktop2.send({ t: 'pair', to: d1.id, token: b64uEncode(makeDevice().ed.pub) })
    expect(await desktop2.nextOfType('error')).toMatchObject({ code: 'forbidden', message: 'no live pairing offer matches this token' })

    // The offer is still live for a role that may use it.
    const sDev = makeDevice()
    const srv = await auth(server, 'server', sDev)
    srv.send({ t: 'pair', to: d1.id, token: b64uEncode(secret.token) })
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: d1.id, state: 'online' })
    srv.frame(d1.id, 'BQ')
    expect(await desktop1.nextOfType('frame')).toEqual({ t: 'frame', from: sDev.id, data: 'BQ' })

    // Server↔server.
    const s2 = makeDevice()
    const srv2Offer = await offer(srv)
    const srv2 = await auth(server, 'server', s2, { to: sDev.id, token: srv2Offer.token })
    expect(await srv2.nextOfType('error')).toMatchObject({ code: 'forbidden', message: 'a server cannot pair with a server', to: sDev.id })
    srv2.frame(sDev.id, 'BQ')
    expect(await srv2.nextOfType('error')).toMatchObject({ code: 'forbidden', to: sDev.id })
  })

  it('a pending desktop whose window lapses is told, the server sees it go, and the desktop stays connected', async () => {
    const server = await relay()
    const sDev = makeDevice()
    const dDev = makeDevice()
    const srv = await auth(server, 'server', sDev)
    const desktop = await auth(server, 'desktop', dDev)
    const secret = makeSecret()
    srv.send({ t: 'offer', tokenHash: secret.tokenHash, exp: Math.ceil(Date.now() / 1000) + 1 })
    await roundTrip(srv)
    desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
    expect(await srv.nextOfType('peer')).toMatchObject({ id: dDev.id, state: 'online' })
    expect(await desktop.nextOfType('error', 3000)).toEqual({ t: 'error', code: 'forbidden', to: sDev.id, message: 'pairing window expired' })
    expect(await srv.nextOfType('peer')).toMatchObject({ id: dDev.id, state: 'offline' })
    await roundTrip(desktop)
    expect(desktop.isClosed).toBe(false)
    desktop.frame(sDev.id)
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: sDev.id })
  })
})

describe('revoke and authorize from either side', () => {
  it('either party revokes; the other gets peer revoked and routing stops both ways', async () => {
    const store = new MemoryStore()
    const server = await relay({ store })

    // Desktop-owned pair, revoked by the server.
    const a = await tokenFlow(server)
    a.srv.send({ t: 'revoke', peer: a.dDev.id })
    expect(await a.desktop.nextOfType('peer')).toEqual({ t: 'peer', id: a.sDev.id, state: 'revoked' })
    expect(store.findPair(a.dDev.id, a.sDev.id)).toBeNull()
    a.desktop.sendBinary(a.sDev.id, bytes(1))
    expect(await a.desktop.nextOfType('error')).toMatchObject({ code: 'forbidden', to: a.sDev.id })
    a.srv.sendBinary(a.dDev.id, bytes(1))
    expect(await a.srv.nextOfType('error')).toMatchObject({ code: 'forbidden', to: a.dDev.id })
    // Again: nothing to remove, nobody is told.
    a.srv.send({ t: 'revoke', peer: a.dDev.id })
    await roundTrip(a.srv)
    expect(await a.desktop.drain(50)).toEqual([])

    // Server-owned pair, revoked by the desktop, which also drops its watch.
    const b = await codeFlow(server)
    b.desktop.send({ t: 'watch', desktops: [b.sDev.id] })
    expect(await b.desktop.nextOfType('peer')).toMatchObject({ id: b.sDev.id, state: 'online' })
    b.desktop.send({ t: 'revoke', peer: b.sDev.id })
    expect(await b.srv.nextOfType('peer')).toEqual({ t: 'peer', id: b.dDev.id, state: 'revoked' })
    b.srv.ws.close()
    expect(await b.desktop.drain(100)).toEqual([])
  })

  it('revoke cancels a pending pair from either side', async () => {
    const server = await relay()
    const sDev = makeDevice()
    const dDev = makeDevice()
    const srv = await auth(server, 'server', sDev)
    const desktop = await auth(server, 'desktop', dDev)
    const secret = await offer(srv)
    desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
    await srv.nextOfType('peer')
    desktop.send({ t: 'revoke', peer: sDev.id })
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'revoked' })
    expect(server.relay.stats().pending).toBe(0)
    srv.frame(dDev.id)
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'forbidden', to: dDev.id })
  })

  it('authorize takes peer or the old phone field, checks the key, and refuses both fields at once', async () => {
    const store = new MemoryStore()
    const server = await relay({ store })
    const sDev = makeDevice()
    const pDev = makeDevice()
    const srv = await auth(server, 'server', sDev)
    const secret = await offer(srv)
    await auth(server, 'phone', pDev, { to: sDev.id, token: secret.token })
    await srv.nextOfType('peer')
    const stranger = makeDevice()
    srv.send({ t: 'authorize', peer: pDev.id, pub: pubOf(stranger) })
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'bad-request', to: pDev.id })
    srv.send(JSON.stringify({ t: 'authorize', peer: pDev.id, phone: pDev.id, pub: pubOf(pDev) }))
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    srv.send({ t: 'authorize', phone: pDev.id, pub: pubOf(pDev) })
    srv.send({ t: 'authorize', peer: pDev.id, pub: pubOf(pDev) })
    await roundTrip(srv)
    expect(await srv.drain(50)).toEqual([])
    expect(store.getPair(sDev.id, pDev.id)).toMatchObject({ ownerRole: 'server', kind: 'phone' })
  })
})

describe('routing', () => {
  it('routes between every paired role combination and forbids everything else', async () => {
    const server = await relay()
    const P = makeDevice()
    const D = makeDevice()
    const S = makeDevice()
    const desktop = await auth(server, 'desktop', D)
    const dOffer = await offer(desktop)
    const phone = await auth(server, 'phone', P, { to: D.id, token: dOffer.token })
    await desktop.next((m) => m.t === 'peer' && m.id === P.id)
    desktop.send({ t: 'authorize', peer: P.id, pub: pubOf(P) })
    const srv = await auth(server, 'server', S)
    // The phone joins the server with the post-hello `pair` message.
    const sOffer = await offer(srv)
    phone.send({ t: 'pair', to: S.id, token: b64uEncode(sOffer.token) })
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: P.id, state: 'online' })
    srv.send({ t: 'authorize', peer: P.id, pub: pubOf(P) })
    // The server, already connected, joins the desktop's offer the same way.
    const dsOffer = await offer(desktop)
    srv.send({ t: 'pair', to: D.id, token: b64uEncode(dsOffer.token) })
    await srv.next((m) => m.t === 'peer' && m.id === D.id)
    desktop.send({ t: 'authorize', peer: S.id, pub: pubOf(S) })
    await roundTrip(desktop)
    await roundTrip(srv)

    const strangers = {
      phone: await auth(server, 'phone', makeDevice()),
      desktop: await auth(server, 'desktop', makeDevice()),
      server: await auth(server, 'server', makeDevice())
    } satisfies Record<Role, TestClient>
    const paired: Record<Role, TestClient> = { phone, desktop, server: srv }
    for (const c of [...Object.values(paired), ...Object.values(strangers)]) await c.drain(0)

    let n = 0
    for (const from of Object.keys(paired) as Role[]) {
      for (const to of Object.keys(paired) as Role[]) {
        if (from === to) continue
        const data = b64uEncode(bytes(++n))
        paired[from].frame(paired[to].id, data)
        expect(await paired[to].nextOfType('frame')).toEqual({ t: 'frame', from: paired[from].id, data })
      }
      for (const to of Object.keys(strangers) as Role[]) {
        paired[from].frame(strangers[to].id)
        expect(await paired[from].nextOfType('error')).toMatchObject({ code: 'forbidden', to: strangers[to].id })
        strangers[to].frame(paired[from].id)
        expect(await strangers[to].nextOfType('error')).toMatchObject({ code: 'forbidden', to: paired[from].id })
      }
      paired[from].frame(paired[from].id)
      expect(await paired[from].nextOfType('error')).toMatchObject({ code: 'forbidden' })
    }

    // Presence: the phone watches both hosts; a desktop watching a phone it hosts is ignored.
    phone.send({ t: 'watch', desktops: [D.id, S.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: D.id, state: 'online' })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: S.id, state: 'online' })
    desktop.send({ t: 'watch', desktops: [P.id, strangers.server.id] })
    await roundTrip(desktop)
    expect(await desktop.drain(50)).toEqual([])

    // Offline beats nothing: a paired recipient that left gets `offline`, nothing is queued.
    srv.ws.close()
    expect(await phone.nextOfType('peer')).toMatchObject({ id: S.id, state: 'offline' })
    desktop.frame(S.id)
    expect(await desktop.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: S.id })
    phone.frame(S.id)
    expect(await phone.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: S.id })
  })
})

describe('phone↔server', () => {
  it('a phone pairs with and talks to a server exactly as with a desktop', async () => {
    const server = await relay()
    const sDev = makeDevice()
    const pDev = makeDevice()
    const srv = await auth(server, 'server', sDev, undefined, { binary: true })
    const secret = await offer(srv)
    const phone = await auth(server, 'phone', pDev, { to: sDev.id, token: secret.token })
    expect(await srv.nextOfType('peer')).toEqual({ t: 'peer', id: pDev.id, state: 'online' })
    phone.frame(sDev.id, 'AQID')
    expect(await srv.nextBinary()).toEqual({ peer: pDev.id, envelope: bytes(1, 2, 3) })
    srv.sendBinary(pDev.id, bytes(2, 1))
    expect(await phone.nextOfType('frame')).toEqual({ t: 'frame', from: sDev.id, data: 'AgE' })
    srv.send({ t: 'authorize', phone: pDev.id, pub: pubOf(pDev) })
    await roundTrip(srv)
    phone.send({ t: 'watch', desktops: [sDev.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'online' })
    srv.ws.close()
    expect(await phone.nextOfType('peer')).toMatchObject({ id: sDev.id, state: 'offline' })
    const back = await auth(server, 'server', sDev)
    expect(await back.nextOfType('peer')).toEqual({ t: 'peer', id: pDev.id, state: 'online' })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'online' })
    back.send({ t: 'revoke', phone: pDev.id })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: sDev.id, state: 'revoked' })
  })
})

describe('binary frames', () => {
  it('converts both ways, takes binary from any client, and reports errors in JSON with the peer', async () => {
    const server = await relay()
    const { desktop, srv, dDev, sDev } = await tokenFlow(server, { desktopBinary: false })
    // A desktop that didn't ask for binary still may send it; it receives JSON.
    desktop.sendBinary(sDev.id, bytes(4, 5, 6))
    expect(await srv.nextBinary()).toEqual({ peer: dDev.id, envelope: bytes(4, 5, 6) })
    const big = new Uint8Array(200 * 1024).map((_, i) => i & 0xff)
    srv.sendBinary(dDev.id, big)
    const frame = await desktop.nextOfType('frame')
    expect(frame.from).toBe(sDev.id)
    expect(Buffer.from(frame.data, 'base64url').equals(Buffer.from(big))).toBe(true)
    // JSON in, binary out.
    desktop.frame(sDev.id, b64uEncode(big.subarray(0, 1000)))
    expect((await srv.nextBinary()).envelope).toEqual(big.subarray(0, 1000))

    const stranger = makeDevice()
    srv.sendBinary(stranger.id, bytes(1))
    expect(await srv.nextOfType('error')).toEqual({ t: 'error', code: 'forbidden', message: 'not paired', to: stranger.id })
    srv.ws.send(new Uint8Array(16))
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'bad-request' })
    // Once the relay has let the desktop go (the server hosts it, so it is told):
    desktop.ws.close()
    expect(await srv.nextOfType('peer')).toMatchObject({ id: dDev.id, state: 'offline' })
    srv.sendBinary(dDev.id, bytes(1))
    expect(await srv.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: dDev.id })
    expect(srv.isClosed).toBe(false)
  })

  it('refuses binary before hello and binary over the size limit', async () => {
    const server = await relay()
    const early = await TestClient.connect(server)
    clients.push({ close: () => early.ws.close(), get isClosed() { return early.isClosed } })
    early.ws.send(encodeRelayBinaryFrame(makeDevice().id, bytes(1)))
    expect(await early.next()).toMatchObject({ t: 'error', code: 'auth' })
    expect((await closedWithin(early)).code).toBe(RelayCloseCode.Auth)
    const { srv, dDev } = await tokenFlow(server)
    srv.sendBinary(dDev.id, new Uint8Array(256 * 1024))
    expect((await closedWithin(srv)).code).toBe(RelayCloseCode.TooBig)
  })
})

describe('budgets', () => {
  it('has the documented defaults per role', () => {
    expect([RELAY_RATE_PER_SECOND, RELAY_RATE_BURST]).toEqual([50, 200])
    expect([RELAY_HOST_RATE_PER_SECOND, RELAY_HOST_RATE_BURST]).toEqual([1000, 4000])
    expect([RELAY_HOST_BYTES_PER_SECOND, RELAY_HOST_BYTES_BURST]).toEqual([8 << 20, 32 << 20])
    expect([RELAY_BUFFER_HIGH_WATER_BYTES, RELAY_BUFFER_LOW_WATER_BYTES]).toEqual([4 << 20, 1 << 20])
    expect([RELAY_PHONE_BUFFER_CAP_BYTES, RELAY_HOST_BUFFER_CAP_BYTES]).toEqual([8 << 20, 32 << 20])
    expect(DEFAULT_LIMITS).toMatchObject({
      ratePerSecond: 50, rateBurst: 200, hostRatePerSecond: 1000, hostRateBurst: 4000,
      hostBytesPerSecond: 8 << 20, hostBytesBurst: 32 << 20, bufferHighWaterBytes: 4 << 20,
      bufferLowWaterBytes: 1 << 20, phoneBufferCapBytes: 8 << 20, hostBufferCapBytes: 32 << 20
    })
  })

  it('throttles desktops and servers on messages instead of refusing them; phones keep the strike rule', async () => {
    const server = await relay({ limits: { ratePerSecond: 1, rateBurst: 3, hostRatePerSecond: 100, hostRateBurst: 10 } })
    for (const role of ['desktop', 'server'] as const) {
      const host = await auth(server, role, makeDevice())
      const started = Date.now()
      for (let i = 0; i < 60; i++) host.send({ t: 'ping' })
      for (let i = 0; i < 60; i++) expect(await host.next(() => true, 3000)).toEqual({ t: 'pong' })
      // 10 from the burst, the other 50 at 100/s.
      expect(Date.now() - started).toBeGreaterThanOrEqual(400)
      expect(host.isClosed).toBe(false)
    }
    const phone = await auth(server, 'phone', makeDevice())
    for (let i = 0; i < 4; i++) phone.send({ t: 'ping' })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'rate' })
    phone.send({ t: 'ping' })
    expect((await closedWithin(phone)).code).toBe(RelayCloseCode.Rate)
  })

  it('throttles payload bytes', async () => {
    const server = await relay({ limits: { hostBytesPerSecond: 256 * 1024, hostBytesBurst: 256 * 1024 } })
    const { desktop, srv, sDev } = await tokenFlow(server)
    const started = Date.now()
    for (let i = 0; i < 8; i++) desktop.sendBinary(sDev.id, new Uint8Array(64 * 1024).fill(i + 1))
    for (let i = 0; i < 8; i++) expect((await srv.nextBinary(5000)).envelope[0]).toBe(i + 1)
    // 512 KiB against a 256 KiB burst at 256 KiB/s. The frame that runs the bucket into
    // debt still goes through and the next one waits, so the last arrives after ~750 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(await desktop.drain(0)).toEqual([])
  })
})

/**
 * A WebSocket client on a raw TCP socket, so a test can stop reading it the way a slow
 * or stuck receiver would. It keeps parsed text messages and counts binary ones.
 */
class RawClient {
  readonly socket: Socket
  readonly closed: Promise<void>
  id = ''
  isClosed = false
  closeCode: number | null = null
  binaryCount = 0
  readonly seqs: number[] = []
  #texts: ServerMessage[] = []
  #buf: Buffer = Buffer.alloc(0)
  #upgraded = false

  private constructor(socket: Socket) {
    this.socket = socket
    this.closed = new Promise((resolve) =>
      socket.on('close', () => {
        this.isClosed = true
        resolve()
      })
    )
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
  }

  static async connect(server: RelayServer): Promise<RawClient> {
    const socket = netConnect(server.port, '127.0.0.1')
    const client = new RawClient(socket)
    socket.write(
      `GET ${RELAY_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`
    )
    return client
  }

  async auth(role: Role, device: Device, options: { pair?: { to: string; token: Uint8Array }; binary?: boolean } = {}): Promise<void> {
    const challenge = await this.next((m) => m.t === 'challenge')
    if (challenge.t !== 'challenge') throw new Error('no challenge')
    this.send(buildHello({ role, nonce: challenge.nonce, ed25519Priv: device.ed.priv, ed25519Pub: device.ed.pub, ...options }))
    const ready = await this.next((m) => m.t === 'ready')
    if (ready.t === 'ready') this.id = ready.id
  }

  send(message: ClientMessage): void {
    this.socket.write(maskedFrame(0x1, Buffer.from(encodeRelayMessage(message))))
  }

  async next(pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const i = this.#texts.findIndex(pred)
      if (i >= 0) return this.#texts.splice(i, 1)[0]
      if (Date.now() > until) throw new Error(`timed out; have ${JSON.stringify(this.#texts)}`)
      await sleep(5)
    }
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
    if (!this.#upgraded) {
      const end = this.#buf.indexOf('\r\n\r\n')
      if (end < 0) return
      this.#buf = this.#buf.subarray(end + 4)
      this.#upgraded = true
    }
    for (;;) {
      if (this.#buf.length < 2) return
      let length = this.#buf[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.#buf.length < 4) return
        length = this.#buf.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.#buf.length < 10) return
        length = Number(this.#buf.readBigUInt64BE(2))
        offset = 10
      }
      if (this.#buf.length < offset + length) return
      const opcode = this.#buf[0] & 0x0f
      const payload = this.#buf.subarray(offset, offset + length)
      if (opcode === 0x1) {
        const msg = parseServerMessage(payload.toString('utf8'))
        if (msg) this.#texts.push(msg)
      } else if (opcode === 0x2) {
        this.binaryCount++
        this.seqs.push(payload.readUInt32BE(16))
      } else if (opcode === 0x8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      }
      this.#buf = this.#buf.subarray(offset + length)
    }
  }
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0, 0x80 | length])
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const key = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3]
  return Buffer.concat([header, key, masked])
}

/** A desktop (Node's WebSocket) paired with a server on a raw socket the test can stop reading. */
async function desktopAndRawServer(limits: Partial<RelayLimits>) {
  // Every test client is on 127.0.0.1: lift the per-IP byte budget unless a test sets it.
  const server = await relay({ limits: { ipBytesPerSecond: 1 << 30, ipBytesBurst: 1 << 30, ...limits } })
  const dDev = makeDevice()
  const desktop = await auth(server, 'desktop', dDev, undefined, { binary: true })
  const { srv, sDev } = await addRawServer(server, desktop, dDev)
  return { server, desktop, srv, dDev, sDev }
}

/** Another server on a raw socket, paired with `desktop` by token. */
async function addRawServer(server: RelayServer, desktop: TestClient, dDev: Device) {
  const sDev = makeDevice()
  const secret = await offer(desktop)
  const srv = await RawClient.connect(server)
  cleanups.push(() => srv.socket.destroy())
  await srv.auth('server', sDev, { pair: { to: dDev.id, token: secret.token }, binary: true })
  desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
  await roundTrip(desktop)
  return { srv, sDev }
}

/** Polls `get` until it is truthy, or fails after `ms`. */
async function until(get: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!get()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in ${ms} ms`)
    await sleep(10)
  }
}

const CHUNK = 64 * 1024

function numbered(seq: number): Uint8Array {
  const envelope = new Uint8Array(CHUNK)
  new DataView(envelope.buffer).setUint32(0, seq)
  return envelope
}

describe('backpressure', () => {
  it('pauses a sender while its receiver stops reading, resumes it after, and keeps relay memory bounded', async () => {
    const highWater = 256 * 1024
    const { server, desktop, srv, sDev } = await desktopAndRawServer({
      bufferHighWaterBytes: highWater,
      bufferLowWaterBytes: 64 * 1024,
      hostBytesPerSecond: 1 << 30,
      hostBytesBurst: 1 << 30,
      hostRatePerSecond: 1e6,
      hostRateBurst: 1e6
    })
    srv.socket.pause()

    // Send until the relay holds the desktop back (the OS buffers some megabytes first).
    let sent = 0
    while (server.relay.stats().paused === 0) {
      if (sent >= 2048) throw new Error('the sender was never paused')
      for (let i = 0; i < 16; i++) desktop.sendBinary(sDev.id, numbered(sent++))
      await sleep(10)
    }
    const queuedAtPause = server.relay.stats().queued
    // Keep sending another 16 MiB: the relay doesn't read it, so its queue doesn't grow.
    for (let i = 0; i < 256; i++) desktop.sendBinary(sDev.id, numbered(sent++))
    await sleep(300)
    const stats = server.relay.stats()
    expect(stats.paused).toBe(1)
    const frameOnWire = CHUNK + 16 + 10
    expect(queuedAtPause).toBeLessThanOrEqual(highWater + 2 * frameOnWire)
    expect(stats.queued).toBeLessThanOrEqual(queuedAtPause + frameOnWire)
    expect(desktop.ws.bufferedAmount).toBeGreaterThan(0)
    expect(desktop.isClosed).toBe(false)

    // The receiver reads again: everything arrives, in order, and the sender is let go.
    srv.socket.resume()
    const until = Date.now() + 15_000
    while (srv.binaryCount < sent && Date.now() < until) await sleep(20)
    expect(srv.binaryCount).toBe(sent)
    expect(srv.seqs).toEqual(Array.from({ length: sent }, (_, i) => i))
    expect(server.relay.stats().paused).toBe(0)
    await roundTrip(desktop)
    expect(desktop.isClosed).toBe(false)
    expect(srv.isClosed).toBe(false)
  })

  it('lets paused senders go when their receiver disconnects', async () => {
    const { server, desktop, srv, sDev } = await desktopAndRawServer({
      bufferHighWaterBytes: 256 * 1024,
      hostBytesPerSecond: 1 << 30,
      hostBytesBurst: 1 << 30
    })
    srv.socket.pause()
    let sent = 0
    while (server.relay.stats().paused === 0) {
      if (sent >= 2048) throw new Error('the sender was never paused')
      for (let i = 0; i < 16; i++) desktop.sendBinary(sDev.id, numbered(sent++))
      await sleep(10)
    }
    srv.socket.destroy()
    const until = Date.now() + 5000
    while (server.relay.stats().paused > 0 && Date.now() < until) await sleep(10)
    expect(server.relay.stats()).toMatchObject({ paused: 0, online: 1 })
    // Reading again: anything it held back, and anything new, finds the server offline.
    await roundTrip(desktop)
    desktop.sendBinary(sDev.id, numbered(sent++))
    expect(await desktop.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: sDev.id })
    expect(desktop.isClosed).toBe(false)
  })

  it('still disconnects a receiver whose queue passes its hard cap', async () => {
    // Backpressure off (high-water mark above the cap), so only the cap is left.
    const { server, desktop, srv, sDev } = await desktopAndRawServer({
      bufferHighWaterBytes: 1 << 30,
      hostBufferCapBytes: 512 * 1024,
      hostBytesPerSecond: 1 << 30,
      hostBytesBurst: 1 << 30
    })
    srv.socket.pause()
    let sent = 0
    // A paused raw socket never reads the relay's FIN, so watch the relay's side.
    while (server.relay.stats().online === 2) {
      if (sent >= 2048) throw new Error('the receiver was never dropped')
      for (let i = 0; i < 16; i++) desktop.sendBinary(sDev.id, numbered(sent++))
      await sleep(10)
    }
    await desktop.drain(100)
    desktop.sendBinary(sDev.id, numbered(sent++))
    expect(await desktop.nextOfType('error')).toEqual({ t: 'error', code: 'offline', to: sDev.id })
    expect(desktop.isClosed).toBe(false)
  })
})

describe('database from before servers', () => {
  it('a relay on a migrated relay.db keeps routing the phones paired before', async () => {
    const dir = tempDir()
    cleanups.push(dir.remove)
    const path = `${dir.path}/relay.db`
    const dDev = makeDevice()
    const pDev = makeDevice()
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE pairs (
        desktop_id TEXT NOT NULL, phone_id TEXT NOT NULL, phone_pub TEXT NOT NULL,
        desktop_pub TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (desktop_id, phone_id)
      );
      CREATE INDEX pairs_by_phone ON pairs (phone_id);
    `)
    old.prepare('INSERT INTO pairs VALUES (?, ?, ?, ?, ?)').run(dDev.id, pDev.id, pubOf(pDev), pubOf(dDev), 1)
    old.close()
    const store = new SqliteStore(path)
    cleanups.unshift(() => store.close())
    const server = await startRelayServer({ store, port: 0, host: '127.0.0.1' })
    servers.push(server)
    const desktop = await auth(server, 'desktop', dDev)
    const phone = await auth(server, 'phone', pDev)
    expect(await desktop.nextOfType('peer')).toEqual({ t: 'peer', id: pDev.id, state: 'online' })
    phone.send({ t: 'watch', desktops: [dDev.id] })
    expect(await phone.nextOfType('peer')).toEqual({ t: 'peer', id: dDev.id, state: 'online' })
    phone.frame(dDev.id, 'Aw')
    expect(await desktop.nextOfType('frame')).toEqual({ t: 'frame', from: pDev.id, data: 'Aw' })
  })
})

describe('hardening', () => {
  const fast = { hostBytesPerSecond: 1 << 30, hostBytesBurst: 1 << 30 }

  /** Sends numbered 64 KiB frames from `desktop` to `to` until `done()`. */
  async function flood(desktop: TestClient, to: string, done: () => boolean, from = 0): Promise<number> {
    let sent = from
    while (!done()) {
      if (sent - from >= 2048) throw new Error('flooded 128 MiB without effect')
      for (let i = 0; i < 16; i++) desktop.sendBinary(to, numbered(sent++))
      await sleep(10)
    }
    return sent
  }

  it('drops a receiver that keeps pinging but never reads, and lets its sender go', async () => {
    const { server, desktop, srv, sDev } = await desktopAndRawServer({
      ...fast,
      bufferHighWaterBytes: 256 * 1024,
      bufferLowWaterBytes: 64 * 1024,
      stallTimeoutMs: 500
    })
    srv.socket.pause()
    // Alive as far as the idle timeout goes: it writes, it just never reads.
    const pings = setInterval(() => srv.send({ t: 'ping' }), 100)
    try {
      let sent = await flood(desktop, sDev.id, () => server.relay.stats().paused > 0)
      const pausedAt = Date.now()
      await until(() => server.relay.stats().online === 1, 3000, 'stalled receiver dropped')
      expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(300)
      expect(server.relay.stats()).toMatchObject({ dropped: 1, paused: 0, connections: 1 })
      await roundTrip(desktop)
      desktop.sendBinary(sDev.id, numbered(sent++))
      expect(await desktop.next((m) => m.t === 'error' && m.code === 'offline')).toEqual({ t: 'error', code: 'offline', to: sDev.id })
      expect(desktop.isClosed).toBe(false)
    } finally {
      clearInterval(pings)
    }
  })

  it('drops a stalled receiver even after its senders left', async () => {
    const { server, desktop, srv, sDev } = await desktopAndRawServer({ ...fast, bufferHighWaterBytes: 256 * 1024, bufferLowWaterBytes: 64 * 1024, stallTimeoutMs: 400 })
    srv.socket.pause()
    const pings = setInterval(() => srv.send({ t: 'ping' }), 100)
    try {
      await flood(desktop, sDev.id, () => server.relay.stats().paused > 0)
      desktop.ws.close()
      await until(() => server.relay.stats().online === 0, 3000, 'stalled receiver dropped')
      expect(server.relay.stats()).toMatchObject({ dropped: 1, queued: 0 })
    } finally {
      clearInterval(pings)
    }
  })

  it('keeps a receiver that drains in time', async () => {
    const { server, desktop, srv, sDev } = await desktopAndRawServer({ ...fast, bufferHighWaterBytes: 256 * 1024, bufferLowWaterBytes: 64 * 1024, stallTimeoutMs: 1500 })
    srv.socket.pause()
    const sent = await flood(desktop, sDev.id, () => server.relay.stats().paused > 0)
    await sleep(300)
    srv.socket.resume()
    await until(() => srv.binaryCount === sent, 10_000, 'everything delivered')
    await sleep(1500)
    expect(server.relay.stats()).toMatchObject({ dropped: 0, online: 2, paused: 0 })
  })

  it('drops the largest queues first once the relay-wide ceiling is passed', async () => {
    const { server, desktop, srv: big, dDev, sDev: bigDev } = await desktopAndRawServer({
      ...fast,
      bufferHighWaterBytes: 1 << 30,
      hostBufferCapBytes: 1 << 30,
      maxQueuedBytes: 1024 * 1024,
      queueSweepMs: 50
    })
    const { srv: small, sDev: smallDev } = await addRawServer(server, desktop, dDev)
    big.socket.pause()
    small.socket.pause()
    for (let i = 0; i < 4; i++) desktop.sendBinary(smallDev.id, numbered(i))
    await flood(desktop, bigDev.id, () => server.relay.stats().dropped > 0)
    await sleep(200)
    expect(server.relay.stats()).toMatchObject({ dropped: 1, online: 2 })
    desktop.sendBinary(bigDev.id, numbered(0))
    expect(await desktop.next((m) => m.t === 'error' && m.code === 'offline')).toMatchObject({ to: bigDev.id })
    small.socket.resume()
    await until(() => small.binaryCount === 4, 3000, 'small receiver served')
  })

  it('caps open connections per IP, and admits again once one closes', async () => {
    const server = await relay({ limits: { maxConnectionsPerIp: 2 } })
    const a = await TestClient.connect(server)
    const b = await TestClient.connect(server)
    clients.push({ close: () => a.ws.close(), get isClosed() { return a.isClosed } })
    clients.push({ close: () => b.ws.close(), get isClosed() { return b.isClosed } })
    await expect(TestClient.connect(server)).rejects.toThrow()
    a.ws.close()
    await until(() => server.relay.stats().connections === 1, 3000, 'socket released')
    const c = await TestClient.connect(server)
    clients.push({ close: () => c.ws.close(), get isClosed() { return c.isClosed } })
    expect(server.relay.stats().connections).toBe(2)
  })

  it('shares one byte budget across every connection from an IP', async () => {
    const server = await relay({ limits: { ipBytesPerSecond: 256 * 1024, ipBytesBurst: 256 * 1024 } })
    const sDev = makeDevice()
    const srv = await auth(server, 'server', sDev, undefined, { binary: true })
    const desktops: TestClient[] = []
    for (let i = 0; i < 2; i++) {
      const dDev = makeDevice()
      const desktop = await auth(server, 'desktop', dDev, undefined, { binary: true })
      const secret = await offer(desktop)
      srv.send({ t: 'pair', to: dDev.id, token: b64uEncode(secret.token) })
      await srv.next((m) => m.t === 'peer' && m.id === dDev.id)
      desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
      await roundTrip(desktop)
      desktops.push(desktop)
    }
    await sleep(1100) // let the IP budget refill after the setup
    const started = Date.now()
    for (let i = 0; i < 4; i++) for (const desktop of desktops) desktop.sendBinary(sDev.id, new Uint8Array(64 * 1024).fill(i + 1))
    for (let i = 0; i < 8; i++) await srv.nextBinary(5000)
    // Each desktop alone is well within its own 8 MiB/s; together they pass the IP's 256 KiB/s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
    for (const desktop of desktops) expect(desktop.isClosed).toBe(false)
  })

  it('limits pushes per connection', async () => {
    const server = await relay({ limits: { pushRatePerSecond: 1, pushRateBurst: 2 } })
    const srv = await auth(server, 'server', makeDevice())
    for (let id = 1; id <= 3; id++) srv.send({ t: 'push', id, cap: 'c', data: 'AQ' })
    const results = [await srv.nextOfType('pushed'), await srv.nextOfType('pushed'), await srv.nextOfType('pushed')]
    expect(results.map((r) => r.result)).toEqual(['unavailable', 'unavailable', 'rate'])
  })

  it('caps pending pairs per device, pairs per device, and new pairs per IP', async () => {
    const server = await relay({ limits: { maxPendingPerDevice: 2, maxPairsPerDevice: 2, newPairsPerIpPerHour: 2 } })
    const sDev = makeDevice()
    const srv = await auth(server, 'server', sDev)
    const devs: Device[] = []
    const desktops: TestClient[] = []
    for (let i = 0; i < 3; i++) {
      devs.push(makeDevice())
      desktops.push(await auth(server, 'desktop', devs[i]))
    }
    const pairWith = async (desktop: TestClient): Promise<void> => {
      const secret = await offer(srv)
      desktop.send({ t: 'pair', to: sDev.id, token: b64uEncode(secret.token) })
      await roundTrip(desktop)
    }
    await pairWith(desktops[0])
    await pairWith(desktops[1])
    await pairWith(desktops[2])
    expect(await desktops[2].nextOfType('error')).toMatchObject({ code: 'forbidden', message: 'too many pending pairs', to: sDev.id })
    expect(server.relay.stats().pending).toBe(2)

    srv.send({ t: 'authorize', peer: devs[0].id, pub: pubOf(devs[0]) })
    srv.send({ t: 'authorize', peer: devs[1].id, pub: pubOf(devs[1]) })
    await roundTrip(srv)
    expect((await srv.drain(50)).filter((m) => m.t === 'error')).toEqual([])
    // Two pairs now: a third is refused. With one revoked, the IP's third new pair is.
    await pairWith(desktops[2])
    srv.send({ t: 'authorize', peer: devs[2].id, pub: pubOf(devs[2]) })
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'forbidden', message: 'too many pairs', to: devs[2].id })
    srv.send({ t: 'revoke', peer: devs[0].id })
    srv.send({ t: 'authorize', peer: devs[2].id, pub: pubOf(devs[2]) })
    expect(await srv.nextOfType('error')).toMatchObject({ code: 'rate', to: devs[2].id })
    // Repeating an existing authorize is free.
    srv.send({ t: 'authorize', peer: devs[1].id, pub: pubOf(devs[1]) })
    await roundTrip(srv)
    expect((await srv.drain(50)).filter((m) => m.t === 'error')).toEqual([])
  })

  it('does not rewrite a pair that is already stored', async () => {
    let writes = 0
    const store = new MemoryStore()
    const putPair = store.putPair.bind(store)
    store.putPair = (pair) => {
      writes++
      putPair(pair)
    }
    const server = await relay({ store })
    const { desktop, sDev } = await tokenFlow(server)
    for (let i = 0; i < 20; i++) desktop.send({ t: 'authorize', peer: sDev.id, pub: pubOf(sDev) })
    await roundTrip(desktop)
    expect(writes).toBe(1)
  })

  it('makes hosts pay per watched ID', async () => {
    const server = await relay({ limits: { hostRatePerSecond: 100, hostRateBurst: 10 } })
    const desktop = await auth(server, 'desktop', makeDevice())
    const ids = Array.from({ length: 50 }, () => makeDevice().id)
    const started = Date.now()
    desktop.send({ t: 'watch', desktops: ids })
    desktop.send({ t: 'ping' })
    await desktop.nextOfType('pong', 5000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  it('forgets the oldest lastSeen beyond its cap', async () => {
    const server = await relay({ limits: { maxLastSeen: 2 } })
    const dDev = makeDevice()
    const pDev = makeDevice()
    const desktop = await auth(server, 'desktop', dDev)
    const secret = await offer(desktop)
    const phone = await auth(server, 'phone', pDev, { to: dDev.id, token: secret.token })
    desktop.send({ t: 'authorize', peer: pDev.id, pub: pubOf(pDev) })
    await roundTrip(desktop)
    phone.ws.close()
    await desktop.next((m) => m.t === 'peer' && m.id === pDev.id && m.state === 'offline')
    desktop.ws.close()
    await until(() => server.relay.stats().connections === 0, 3000, 'both gone')
    const other = await auth(server, 'phone', makeDevice())
    other.ws.close()
    await until(() => server.relay.stats().connections === 0, 3000, 'third gone')
    // The phone's lastSeen was the oldest of three: the roster no longer reports it.
    const back = await auth(server, 'desktop', dDev)
    expect(await back.drain(100)).toEqual([])
  })

  it('keeps pairing refusals out of the info log', async () => {
    const lines: Array<{ level: string; event: string }> = []
    const capture = (level: string) => (event: string): void => void lines.push({ level, event })
    const server = await relay({ logger: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') } })
    const host = await auth(server, 'desktop', makeDevice())
    const target = await auth(server, 'server', makeDevice())
    await offer(target)
    for (let i = 0; i < 50; i++) host.send({ t: 'pair', to: target.id, token: b64uEncode(makeDevice().ed.pub) })
    await roundTrip(host)
    expect(lines.filter((l) => l.event === 'pair-refused').length).toBe(50)
    expect(lines.filter((l) => l.level === 'info' && l.event === 'pair-refused')).toEqual([])
  })
})
