import { afterEach, describe, expect, it } from 'vitest'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  DEVTOOL_NOISE_PROLOGUE,
  FrameKind,
  RELAY_PATH,
  b64uDecode,
  b64uEncode,
  createInitiator,
  decodeEnvelope,
  decodePairingUri,
  derivePairProof,
  deriveRelayToken,
  encodeEnvelope,
  encodeJson,
  encodeRelayMessage,
  generateEd25519,
  generateX25519,
  parseAppMessage,
  parseDesktopHello,
  parseInbox,
  parseServerMessage
} from '../../protocol/ts/index.ts'
import type { AppMessage, DesktopHello, NoiseTransport, PhoneHello } from '../../protocol/ts/index.ts'
import { FakeDesktop } from '../../protocol/tools/fake-desktop-core.ts'
import type { StoredPairing } from '../../protocol/tools/fake-desktop-core.ts'
import type { RelayServer } from '../src/server.ts'
import { MemoryStore } from '../src/store.ts'
import { TestClient, closedWithin, makeDevice, sleep, startTestRelay } from './helpers.ts'
import type { Device } from './helpers.ts'

/**
 * End to end through real sockets: protocol/tools' fake desktop on one side, a phone
 * built from protocol/ts on the other, the real Noise IK handshake in between. The
 * relay only ever sees opaque frames.
 */

const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

async function waitFor<T>(get: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = get()
    if (value) return value
    if (Date.now() > until) throw new Error('condition not met in time')
    await sleep(10)
  }
}

interface DesktopHarness {
  desktop: FakeDesktop
  offers: string[]
  pairings: StoredPairing[]
  ws: WebSocket
}

async function startFakeDesktop(server: RelayServer): Promise<DesktopHarness> {
  const ws = new WebSocket(server.url + RELAY_PATH)
  const offers: string[] = []
  const harness: DesktopHarness = { desktop: null as unknown as FakeDesktop, offers, pairings: [], ws }
  harness.desktop = new FakeDesktop({
    identity: { x25519: generateX25519(), ed25519: generateEd25519() },
    name: 'it-desktop',
    relayUrl: server.url,
    pairings: [],
    savePairings: (p) => {
      harness.pairings = [...p]
    },
    sendRelay: (m) => ws.send(encodeRelayMessage(m)),
    approve: () => Promise.resolve(true),
    onOffer: (uri) => offers.push(uri),
    log: () => {}
  })
  ws.addEventListener('message', (e) => {
    const msg = parseServerMessage(String(e.data))
    if (msg) harness.desktop.handleServerMessage(msg)
  })
  ws.addEventListener('close', () => harness.desktop.onDisconnected())
  cleanups.push(() => ws.close())
  await waitFor(() => offers.length > 0)
  return harness
}

/** The phone side of §4: Noise initiator over a TestClient. */
class Phone {
  readonly device: Device = makeDevice()
  client!: TestClient
  transport: NoiseTransport | null = null

  async connect(relayUrl: string, pair?: { to: string; token: Uint8Array }): Promise<void> {
    this.client = await TestClient.auth(relayUrl, 'phone', this.device, pair)
    cleanups.push(() => this.client.close())
  }

  async handshake(desktopId: string, desktopX: Uint8Array, kind: 'pair' | 'resume', secret?: Uint8Array): Promise<DesktopHello> {
    const hs = createInitiator({ prologue: new TextEncoder().encode(DEVTOOL_NOISE_PROLOGUE), s: this.device.x, rs: desktopX })
    const payload: PhoneHello = {
      v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION, app: 'ios/it', features: [], kind, deviceName: 'IT iPhone', ed: b64uEncode(this.device.ed.pub),
      ...(secret ? { proof: b64uEncode(derivePairProof(secret)) } : {})
    }
    this.client.frame(desktopId, b64uEncode(encodeEnvelope(FrameKind.Handshake1, hs.writeMessage(encodeJson(payload)))))
    const reply = await this.client.nextOfType('frame')
    expect(reply.from).toBe(desktopId)
    const env = decodeEnvelope(b64uDecode(reply.data))
    expect(env.kind).toBe(FrameKind.Handshake2)
    const hello = parseDesktopHello(hs.readMessage(env.body))
    this.transport = hs.split()
    return hello
  }

  send(desktopId: string, message: AppMessage): void {
    this.client.frame(desktopId, b64uEncode(encodeEnvelope(FrameKind.Transport, this.transport!.encrypt(encodeJson(message)))))
  }

  async receive(): Promise<AppMessage | null> {
    const frame = await this.client.nextOfType('frame')
    const env = decodeEnvelope(b64uDecode(frame.data))
    expect(env.kind).toBe(FrameKind.Transport)
    return parseAppMessage(this.transport!.decrypt(env.body))
  }
}

describe('fake desktop + phone through the relay', () => {
  it('pairs with Noise IK, gets authorized, serves the inbox, resumes, and is revoked', async () => {
    const store = new MemoryStore()
    const server = await startTestRelay({ store })
    cleanups.push(() => server.close())
    const d = await startFakeDesktop(server)
    const qr = decodePairingUri(d.offers[0])
    expect(qr.id).toBe(d.desktop.id)
    const secret = b64uDecode(qr.s)
    const desktopX = b64uDecode(qr.x)

    // Pair: the relay sees the relayToken; the desktop checks the pairProof inside Noise.
    const phone = new Phone()
    await phone.connect(qr.relay, { to: qr.id, token: deriveRelayToken(secret) })
    const hello = await phone.handshake(qr.id, desktopX, 'pair', secret)
    expect(hello).toMatchObject({ result: 'pending', desktopName: 'it-desktop' })
    expect(await phone.receive()).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    await waitFor(() => store.getPair(d.desktop.id, phone.device.id))
    expect(d.pairings.map((p) => p.id)).toEqual([phone.device.id])
    // The used offer was replaced by a fresh one.
    await waitFor(() => d.offers.length === 2)

    phone.send(qr.id, { t: 'req', id: 1, op: 'inbox.get' })
    const res = await phone.receive()
    expect(res).toMatchObject({ t: 'res', id: 1, ok: true })
    expect(parseInbox((res as { result: unknown }).result).desktop).toEqual({ id: qr.id, name: 'it-desktop' })
    d.desktop.tick()
    expect(await phone.receive()).toMatchObject({ t: 'evt', e: 'inbox', seq: 1 })

    // Reconnect as an authorized phone: no pair token, a resume handshake, presence via watch.
    await phone.client.close()
    await waitFor(() => d.pairings[0]?.lastSeen !== null)
    await phone.connect(qr.relay)
    phone.client.send({ t: 'watch', desktops: [qr.id] })
    expect(await phone.client.nextOfType('peer')).toEqual({ t: 'peer', id: qr.id, state: 'online' })
    expect((await phone.handshake(qr.id, desktopX, 'resume')).result).toBe('ok')
    phone.send(qr.id, { t: 'req', id: 2, op: 'inbox.get' })
    expect(await phone.receive()).toMatchObject({ t: 'res', id: 2, ok: true })

    // A stale QR can't pair a second phone: the relay refuses the consumed token.
    const intruder = new Phone()
    await intruder.connect(qr.relay, { to: qr.id, token: deriveRelayToken(secret) })
    expect(await intruder.client.nextOfType('error')).toMatchObject({ code: 'forbidden', to: qr.id })

    // Revoke from the desktop side of the relay protocol.
    d.ws.send(encodeRelayMessage({ t: 'revoke', phone: phone.device.id }))
    expect(await phone.client.nextOfType('peer')).toEqual({ t: 'peer', id: qr.id, state: 'revoked' })
    expect(store.getPair(qr.id, phone.device.id)).toBeNull()
    phone.send(qr.id, { t: 'req', id: 3, op: 'inbox.get' })
    expect(await phone.client.nextOfType('error')).toMatchObject({ code: 'forbidden', to: qr.id })
  })

  it('a phone with a wrong desktop key gets no reply, and the relay keeps both connected', async () => {
    const server = await startTestRelay()
    cleanups.push(() => server.close())
    const d = await startFakeDesktop(server)
    const qr = decodePairingUri(d.offers[0])
    const phone = new Phone()
    await phone.connect(qr.relay, { to: qr.id, token: deriveRelayToken(b64uDecode(qr.s)) })
    const hs = createInitiator({ prologue: new TextEncoder().encode(DEVTOOL_NOISE_PROLOGUE), s: phone.device.x, rs: generateX25519().pub })
    phone.client.frame(qr.id, b64uEncode(encodeEnvelope(FrameKind.Handshake1, hs.writeMessage(new Uint8Array(0)))))
    expect(await phone.client.drain(200)).toEqual([])
    expect(phone.client.isClosed).toBe(false)
    await phone.client.close()
    const code = (await closedWithin(phone.client)).code
    expect(code).toBe(1005)
  })
})
