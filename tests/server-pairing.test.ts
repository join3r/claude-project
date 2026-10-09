import { afterEach, describe, expect, it } from 'vitest'
import path from 'path'
import {
  ProtocolError,
  b64uEncode,
  derivePairProof,
  deviceId,
  generateEd25519,
  generateX25519
} from '../protocol/ts/index.ts'
import type { RelayServer } from '../relay/src/server.ts'
import {
  PAIRING_TTL_SECONDS,
  PAIRING_VERSION,
  PairingError,
  PairingInitiator,
  PairingOffer,
  answerPairing,
  decodeTicket,
  encodeTicket,
  isTicketExpired,
  type PairingHello,
  type PairingTicket
} from '../src/main/host/link/pairing'
import { DEFAULT_MOBILE_CONFIG, DEFAULT_MOBILE_RELAY_URL, type MobileConfig } from '../src/shared/mobile'
import { installOneLiner } from '../src/shared/servers'
import { MobileService } from '../src/main/mobile/mobile-service'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import { createInvite } from '../src/main/mobile/invite'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

const build = { version: '0.6.0', commit: 'abc', builtAt: '2026-10-09T00:00:00Z', bundleSha: 'f00' }

function ticket(overrides: Partial<PairingTicket> = {}): PairingTicket {
  const ed = generateEd25519()
  return {
    kind: 'install',
    relay: 'ws://127.0.0.1:8787',
    id: deviceId(ed.pub),
    x25519Pub: generateX25519().pub,
    ed25519Pub: ed.pub,
    secret: new Uint8Array(32).fill(7),
    exp: 1_900_000_000,
    name: 'join3r-mbp',
    node: '24.21.0',
    ...overrides
  }
}

describe('pairing tickets', () => {
  it('round-trips an install token, with the Node version readable after the dot', () => {
    const t = ticket()
    const text = encodeTicket(t)
    expect(text).toMatch(/^[A-Za-z0-9_-]+\.24\.21\.0$/)
    expect(decodeTicket(text, 'install')).toEqual(t)
    // The one-liner stays short enough to paste.
    expect(installOneLiner(text).length).toBeLessThan(260)
  })

  it('leaves the default relay out and names a custom one', () => {
    const short = encodeTicket(ticket({ relay: DEFAULT_MOBILE_RELAY_URL }))
    const long = encodeTicket(ticket({ relay: 'wss://relay.example.com' }))
    expect(long.length).toBeGreaterThan(short.length)
    expect(decodeTicket(short).relay).toBe(DEFAULT_MOBILE_RELAY_URL)
    expect(decodeTicket(long).relay).toBe('wss://relay.example.com')
    expect(decodeTicket(encodeTicket(ticket({ relay: 'ws://host.orb.internal:8787/' }))).relay).toBe('ws://host.orb.internal:8787')
  })

  it('round-trips a device code without a Node version, and tells the two kinds apart', () => {
    const code = encodeTicket(ticket({ kind: 'device', node: undefined }))
    expect(code).not.toContain('.')
    expect(decodeTicket(code, 'device').kind).toBe('device')
    expect(() => decodeTicket(code, 'install')).toThrow(/pairing code for a desktop/)
    expect(() => decodeTicket(encodeTicket(ticket()), 'device')).toThrow(/install token/)
  })

  it('refuses junk, truncation, a missing Node version and a bad relay', () => {
    const text = encodeTicket(ticket())
    const [body] = text.split('.')
    expect(() => decodeTicket('hello')).toThrow(ProtocolError)
    expect(() => decodeTicket(body.slice(0, 120))).toThrow(ProtocolError)
    expect(() => decodeTicket(body)).toThrow(/Node version/)
    expect(() => decodeTicket(`${body}.24.x`)).toThrow(/Node version/)
    expect(() => encodeTicket(ticket({ node: undefined }))).toThrow(/Node version/)
    expect(() => decodeTicket(encodeTicket(ticket({ relay: 'http://nope' })))).toThrow(/relay/)
  })

  it('derives the id from the key and truncates long names on a character boundary', () => {
    const t = ticket({ name: 'é'.repeat(100) })
    const decoded = decodeTicket(encodeTicket(t))
    expect(decoded.id).toBe(deviceId(t.ed25519Pub))
    expect(decoded.name).toBe('é'.repeat(32))
  })

  it('expires at exp', () => {
    expect(isTicketExpired({ exp: 100 }, 99_999)).toBe(false)
    expect(isTicketExpired({ exp: 100 }, 100_000)).toBe(true)
  })
})

describe('pairing offers', () => {
  const peer = { id: 'a'.repeat(32), x25519Pub: 'x' }

  it('mints 15 minute single-use offers', () => {
    const offer = PairingOffer.mint(1_000_000)
    expect(offer.exp).toBe(1000 + PAIRING_TTL_SECONDS)
    expect(offer.offerMessage()).toEqual({ t: 'offer', tokenHash: offer.tokenHash, exp: offer.exp })
    expect(offer.check(derivePairProof(offer.secret), peer, 1_000_000)).toEqual({ ok: true, again: false })
    // The same device again (its reply got lost): ok again. Anyone else: used.
    expect(offer.check(derivePairProof(offer.secret), peer, 1_000_000)).toEqual({ ok: true, again: true })
    expect(offer.check(derivePairProof(offer.secret), { ...peer, id: 'b'.repeat(32) }, 1_000_000)).toEqual({ ok: false, reason: 'used' })
  })

  it('refuses a wrong proof and an expired offer', () => {
    const offer = PairingOffer.mint(0)
    expect(offer.check(new Uint8Array(32), peer, 0)).toEqual({ ok: false, reason: 'wrong-secret' })
    expect(offer.check(new Uint8Array(31), peer, 0)).toEqual({ ok: false, reason: 'wrong-secret' })
    expect(offer.check(derivePairProof(offer.secret), peer, PAIRING_TTL_SECONDS * 1000)).toEqual({ ok: false, reason: 'expired' })
    expect(offer.consumed).toBeNull()
  })
})

describe('pairing handshake (loopback)', () => {
  const minter = generateX25519()
  const holder = generateX25519()
  const holderEd = generateEd25519()
  const holderId = deviceId(holderEd.pub)

  function hello(offer: PairingOffer, overrides: Partial<PairingHello> = {}): PairingHello {
    return { ...PAIRING_VERSION, app: 'devtool-server', proof: b64uEncode(derivePairProof(offer.secret)), ed: b64uEncode(holderEd.pub), name: 'srv', build, ...overrides }
  }

  function run(offer: PairingOffer, h: PairingHello, from = holderId, now = 0) {
    const initiator = new PairingInitiator(holder, minter.pub)
    const message1 = initiator.start(h)
    expect(message1[0]).toBe(0x05)
    const outcome = answerPairing(minter, message1.subarray(1), from, 'devtool-server',
      () => ({ app: 'devtool-desktop', name: 'mac', build }),
      ({ hello: got, remoteStatic }) => {
        const check = offer.check(Buffer.from(got.proof, 'base64url'), { id: from, x25519Pub: b64uEncode(remoteStatic) }, now)
        return check.ok ? { result: 'ok' } : { result: 'rejected', reason: check.reason }
      })
    expect(outcome.envelope[0]).toBe(0x06)
    return { outcome, reply: initiator.finish(outcome.envelope.subarray(1)) }
  }

  it('accepts the right proof and reveals the holder\'s static key', () => {
    const offer = PairingOffer.mint(0)
    const { outcome, reply } = run(offer, hello(offer, { host: { os: 'linux', arch: 'arm64', hostname: 'box', node: '24.21.0' }, bootstrap: 1 }))
    expect(reply).toMatchObject({ result: 'ok', app: 'devtool-desktop', name: 'mac', build })
    expect(outcome.hello).toMatchObject({ host: { os: 'linux' }, bootstrap: 1 })
    expect(b64uEncode(outcome.remoteStatic)).toBe(b64uEncode(holder.pub))
  })

  it('rejects a wrong secret, a used or expired offer, a key that is not the sender, and the wrong role', () => {
    const offer = PairingOffer.mint(0)
    expect(run(offer, hello(offer, { proof: b64uEncode(new Uint8Array(32)) })).reply).toMatchObject({ result: 'rejected', reason: 'wrong-secret' })
    expect(run(offer, hello(offer), holderId, PAIRING_TTL_SECONDS * 1000).reply).toMatchObject({ result: 'rejected', reason: 'expired' })
    expect(run(offer, hello(offer), 'f'.repeat(32)).reply).toMatchObject({ result: 'rejected', reason: 'bad-key' })
    expect(run(offer, hello(offer, { app: 'devtool-desktop' })).reply).toMatchObject({ result: 'rejected', reason: 'role' })
    expect(run(offer, hello(offer)).reply.result).toBe('ok')
    const other = generateEd25519()
    expect(run(offer, hello(offer, { ed: b64uEncode(other.pub) }), deviceId(other.pub)).reply).toMatchObject({ result: 'rejected', reason: 'used' })
  })

  it('answers incompatible to a version it does not speak', () => {
    const offer = PairingOffer.mint(0)
    expect(run(offer, hello(offer, { v: 3, min: 3 })).reply.result).toBe('incompatible')
  })

  it('drops a message 1 meant for another key', () => {
    const offer = PairingOffer.mint(0)
    const message1 = new PairingInitiator(holder, generateX25519().pub).start(hello(offer))
    expect(() => answerPairing(minter, message1.subarray(1), holderId, 'devtool-server', () => ({ app: 'devtool-desktop', name: '', build }), () => ({ result: 'ok' }))).toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('pairing through the relay', () => {
  const cleanups: (() => unknown)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function relay(): Promise<RelayServer> {
    const { relay } = await startTestRelay()
    cleanups.push(() => relay.close())
    return relay
  }
  function desktop(relayUrl: string): TestDesktop {
    const d = startTestDesktop(relayUrl)
    cleanups.push(() => d.close())
    return d
  }
  async function server(relayUrl: string): Promise<TestServer> {
    const s = await startTestServer(relayUrl)
    cleanups.push(() => s.close())
    return s
  }

  it('token flow: a new server pairs with an invite, the desktop stores it and connects, no Accept', { timeout: 30_000 }, async () => {
    const r = await relay()
    const d = desktop(r.url)
    const s = await server(r.url)
    const invite = d.hub.createInvite()
    expect(invite.oneLiner).toBe(`curl -fsSL https://devtool.awantech.sk/install | sh -s -- ${invite.token}`)
    expect(d.hub.getState().invite).toMatchObject({ status: 'waiting', token: invite.token })
    await waitFor(() => d.hub.getState().relay.kind === 'online', 'desktop relay online')

    const record = await s.link.pairWithInstallToken(decodeTicket(invite.token, 'install'), { bootstrap: 1 })
    expect(record).toMatchObject({ id: d.identity.get().id, name: 'test-mac' })
    await waitFor(() => d.status(s.id)?.state === 'online', 'server online')
    expect(d.status(s.id)).toMatchObject({ name: 'test-server', host: { os: process.platform, arch: process.arch } })
    expect(d.hub.getState().invite).toMatchObject({ status: 'paired', serverId: s.id })
    expect(s.link.desktops.get(d.identity.get().id)?.x25519Pub).toBe(b64uEncode(d.identity.get().x25519.pub))
    await expect(d.hub.call(s.id, 'win:1', 'load-config')).resolves.toMatchObject({ claudeCommand: '' })

    // Single use: a second server with the same token is refused by the relay.
    const late = await server(r.url)
    await expect(late.link.pairWithInstallToken(decodeTicket(invite.token, 'install'))).rejects.toMatchObject({ code: 'relay-refused' })

    // Presence works after pairing: the server goes and comes back.
    s.link.stop()
    await waitFor(() => d.status(s.id)?.state === 'offline', 'server offline')
    s.link.start()
    await waitFor(() => d.status(s.id)?.state === 'online', 'server back', 15_000)
  })

  it('token flow: refuses a wrong secret, an expired token and a cancelled invite', { timeout: 30_000 }, async () => {
    const r = await relay()
    const d = desktop(r.url)
    const s = await server(r.url)
    const invite = d.hub.createInvite()
    await waitFor(() => d.hub.getState().relay.kind === 'online', 'desktop relay online')
    const good = decodeTicket(invite.token, 'install')

    // The relay checks the token's hash: a wrong secret never reaches the desktop.
    await expect(s.link.pairWithInstallToken({ ...good, secret: new Uint8Array(32).fill(9) })).rejects.toMatchObject({ code: 'relay-refused' })
    // Expired: refused before anything is sent.
    await expect(s.link.pairWithInstallToken({ ...good, exp: Math.floor(Date.now() / 1000) - 1 })).rejects.toMatchObject({ code: 'expired' })

    // Cancelled on the desktop: with no server paired it leaves the relay, and the offer goes with it.
    d.hub.cancelInvite()
    expect(d.hub.getState().invite).toBeNull()
    await waitFor(() => d.client.getState().kind === 'idle', 'desktop off the relay')
    await waitFor(() => r.relay.stats().offers === 0, 'relay saw it go')
    const error = await s.link.pairWithInstallToken(good).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PairingError)
    expect(error).toMatchObject({ code: 'relay-refused' })
    expect(d.status(s.id)).toBeUndefined()
  })

  it('a phone QR and a server invite share the relay offer: the newer one wins', { timeout: 30_000 }, async () => {
    const r = await relay()
    const d = desktop(r.url)
    let config: MobileConfig = { ...DEFAULT_MOBILE_CONFIG, relayUrl: r.url }
    const mobile = new MobileService({
      getConfig: () => config,
      saveConfig: (next) => { config = next },
      projects: { peek: () => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }), subscribe: () => () => {} },
      activity: new TabActivityRegistry(),
      pairings: new PairingsStore(path.join(d.dir, 'mobile')),
      getDesktopId: () => d.identity.peekId(),
      defaultDesktopName: () => 'test-mac',
      createTransport: () => d.mux.mobileTransport(),
      channels: createNoiseChannelFactory({ staticKey: () => d.identity.get().x25519, app: 'devtool/test', desktopName: () => 'test-mac', log: () => {} }),
      createInvite: (options) => createInvite(d.identity.get(), options),
      broadcastState: () => {},
      log: () => {}
    })
    mobile.start()
    cleanups.push(() => mobile.stop())
    await mobile.startPairing()
    await waitFor(() => mobile.getState().connection.kind === 'online', 'mobile online')
    expect(mobile.getState().invite).not.toBeNull()

    d.hub.createInvite()
    await waitFor(() => mobile.getState().invite === null, 'QR dropped')
    expect(d.hub.getState().invite?.status).toBe('waiting')

    await mobile.startPairing()
    await waitFor(() => d.hub.getState().invite === null, 'invite dropped')
  })

  it('code flow: refuses a used code, a wrong secret, an expired code and another relay', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const first = desktop(r.url)
    const { code } = await s.link.createPairingCode()
    await first.hub.pairWithCode(code)
    await waitFor(() => first.status(s.id)?.state === 'online', 'server online')
    expect(s.link.codeState()).toMatchObject({ state: 'paired', desktop: { id: first.identity.get().id, name: 'test-mac' } })

    // Single use.
    const second = desktop(r.url)
    await expect(second.hub.pairWithCode(code)).rejects.toMatchObject({ code: 'relay-refused' })

    // A tampered secret: the relay's token check fails.
    const fresh = decodeTicket((await s.link.createPairingCode()).code, 'device')
    await expect(second.hub.pairWithCode(encodeTicket({ ...fresh, secret: new Uint8Array(32).fill(3) }))).rejects.toMatchObject({ code: 'relay-refused' })
    // Expired, and from another relay: refused before anything is sent.
    await expect(second.hub.pairWithCode(encodeTicket({ ...fresh, exp: 1 }))).rejects.toMatchObject({ code: 'expired' })
    await expect(second.hub.pairWithCode(encodeTicket({ ...fresh, relay: 'wss://elsewhere.example' }))).rejects.toThrow(/uses the relay wss:\/\/elsewhere\.example/)
    await expect(second.hub.pairWithCode(encodeTicket({ ...fresh, kind: 'install', node: '24.21.0' }))).rejects.toThrow(/install token/)

    // The fresh code still works for the second desktop; both are connected.
    await pairByCode(second, s)
    expect(s.link.connectedDesktops().sort()).toEqual([first.identity.get().id, second.identity.get().id].sort())
  })

  it('add another device: a paired desktop asks the server for a code, and a second desktop pairs with it', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const first = desktop(r.url)
    await pairByCode(first, s)
    const { code, expiresAt } = await first.hub.deviceCode(s.id)
    expect(expiresAt).toBeGreaterThan(Date.now() + 14 * 60_000)
    const second = desktop(r.url)
    await second.hub.pairWithCode(code)
    await waitFor(() => second.status(s.id)?.state === 'online', 'second desktop online')
    expect(s.link.desktops.list().map((d) => d.name)).toEqual(['test-mac', 'test-mac'])
  })

  it('unpairing on the server revokes the relay pair and the desktop hears it', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    expect(s.link.unpair(d.identity.get().id)).toBe(true)
    await waitFor(() => d.status(s.id)?.problem === 'revoked', 'revoked')
    expect(s.link.desktops.list()).toEqual([])
  })
})
