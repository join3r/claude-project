import { describe, expect, it } from 'vitest'
import { b64uEncode } from '../protocol/ts/index.ts'
import type { ClientMessage, ErrorMessage, PeerMessage } from '../protocol/ts/index.ts'
import { RelayMux, type MuxedRelayClient } from '../src/main/host/link/relay-mux'
import type { RelayServerMessage, RelayTransportState } from '../src/main/mobile/mobile-service'

/** A RelayClient stand-in: records connects and sends, and lets the test push messages and states. */
class FakeClient implements MuxedRelayClient {
  relayUrl: string | null = null
  state: RelayTransportState = { kind: 'idle' }
  binary = true
  connects: string[] = []
  sent: ClientMessage[] = []
  binarySent: { peer: string; envelope: Uint8Array }[] = []
  private messageListeners = new Set<(m: RelayServerMessage) => void>()
  private binaryListeners = new Set<(from: string, e: Uint8Array) => void>()
  private stateListeners = new Set<(s: RelayTransportState) => void>()
  connect(url: string): void { this.relayUrl = url.replace(/\/+$/, ''); this.connects.push(url); this.setState({ kind: 'connecting' }) }
  close(): void { this.relayUrl = null; this.setState({ kind: 'idle' }) }
  send(message: ClientMessage): boolean { this.sent.push(message); return this.state.kind === 'online' }
  sendBinary(peer: string, envelope: Uint8Array): boolean { this.binarySent.push({ peer, envelope }); return true }
  isBinary(): boolean { return this.binary }
  bufferedAmount(): number { return 0 }
  onBufferBelow(_below: number, fn: () => void): void { fn() }
  getState(): RelayTransportState { return this.state }
  onMessage(l: (m: RelayServerMessage) => void) { this.messageListeners.add(l); return () => { this.messageListeners.delete(l) } }
  onBinaryFrame(l: (from: string, e: Uint8Array) => void) { this.binaryListeners.add(l); return () => { this.binaryListeners.delete(l) } }
  onStateChange(l: (s: RelayTransportState) => void) { this.stateListeners.add(l); return () => { this.stateListeners.delete(l) } }
  setState(state: RelayTransportState): void { this.state = state; for (const l of this.stateListeners) l(state) }
  push(message: RelayServerMessage): void { for (const l of this.messageListeners) l(message) }
  pushBinary(from: string, envelope: Uint8Array): void { for (const l of this.binaryListeners) l(from, envelope) }
}

const SERVER = 'a'.repeat(32)
const PHONE = 'b'.repeat(32)

function setup() {
  const client = new FakeClient()
  const mux = new RelayMux(client)
  const link = { frames: [] as { from: string; envelope: Uint8Array }[], peers: [] as PeerMessage[], errors: [] as ErrorMessage[], states: [] as string[] }
  const port = mux.hostPort((id) => id === SERVER, {
    frame: (from, envelope) => link.frames.push({ from, envelope }),
    peer: (m) => link.peers.push(m),
    error: (m) => link.errors.push(m)
  })
  port.onStateChange((s) => link.states.push(s.kind))
  const mobileMessages: RelayServerMessage[] = []
  const mobileStates: string[] = []
  const mobile = mux.mobileTransport()
  mobile.onMessage((m) => mobileMessages.push(m))
  mobile.onStateChange((s) => mobileStates.push(s.kind))
  return { client, mux, port, link, mobile, mobileMessages, mobileStates }
}

describe('RelayMux', () => {
  it('runs the socket while anyone wants it, on the URL of the last to connect', () => {
    const env = setup()
    expect(env.mux.active).toBe(false)
    env.port.connect('ws://relay-a')
    expect(env.client.connects).toEqual(['ws://relay-a'])
    env.client.setState({ kind: 'online' })
    // Mobile joins a socket that is already up: it hears `online` at once.
    env.mobile.connect('ws://relay-a')
    expect(env.client.connects).toEqual(['ws://relay-a'])
    expect(env.mobileStates).toEqual(['online'])
    // A new relay URL reconnects everyone.
    env.mobile.connect('ws://relay-b/')
    expect(env.client.connects).toEqual(['ws://relay-a', 'ws://relay-b/'])
    env.port.close()
    expect(env.client.relayUrl).toBe('ws://relay-b')
    env.mobile.close()
    expect(env.client.relayUrl).toBeNull()
    expect(env.mux.active).toBe(false)
  })

  it('routes frames, presence and errors by peer: servers to the link, everything else to mobile', () => {
    const env = setup()
    env.port.connect('ws://r')
    env.mobile.connect('ws://r')
    env.client.setState({ kind: 'online' })
    env.client.pushBinary(SERVER, new Uint8Array([3, 7]))
    env.client.pushBinary(PHONE, new Uint8Array([1, 2]))
    env.client.push({ t: 'frame', from: SERVER, data: b64uEncode(new Uint8Array([3, 8])) })
    env.client.push({ t: 'frame', from: PHONE, data: 'AQM' })
    env.client.push({ t: 'peer', id: SERVER, state: 'online' })
    env.client.push({ t: 'peer', id: PHONE, state: 'offline' })
    env.client.push({ t: 'error', code: 'offline', to: SERVER })
    env.client.push({ t: 'error', code: 'offline', to: PHONE })
    env.client.push({ t: 'error', code: 'rate' })
    env.client.push({ t: 'pushed', id: 1, result: 'ok' })

    expect(env.link.frames).toEqual([{ from: SERVER, envelope: new Uint8Array([3, 7]) }, { from: SERVER, envelope: new Uint8Array([3, 8]) }])
    expect(env.link.peers).toEqual([{ t: 'peer', id: SERVER, state: 'online' }])
    expect(env.link.errors).toEqual([{ t: 'error', code: 'offline', to: SERVER }, { t: 'error', code: 'rate' }])
    expect(env.mobileMessages).toEqual([
      // A phone's binary frame comes back as the JSON frame the mobile service reads.
      { t: 'frame', from: PHONE, data: b64uEncode(new Uint8Array([1, 2])) },
      { t: 'frame', from: PHONE, data: 'AQM' },
      { t: 'peer', id: PHONE, state: 'offline' },
      { t: 'error', code: 'offline', to: PHONE },
      { t: 'error', code: 'rate' },
      { t: 'pushed', id: 1, result: 'ok' }
    ])
    expect(env.link.states).toEqual(['connecting', 'online'])
  })

  it('gives a user that no longer wants the socket nothing more, and lets it send nothing', () => {
    const env = setup()
    env.port.connect('ws://r')
    env.client.setState({ kind: 'online' })
    env.client.push({ t: 'frame', from: PHONE, data: 'AQM' })
    expect(env.mobileMessages).toEqual([])
    expect(env.mobile.getState()).toEqual({ kind: 'idle' })
    expect(env.mobile.send({ t: 'revoke', phone: PHONE })).toBe(false)
    expect(env.port.send({ t: 'watch', desktops: [SERVER] })).toBe(true)
    env.port.close()
    env.client.pushBinary(SERVER, new Uint8Array([3]))
    expect(env.link.frames).toEqual([])
    expect(env.port.sendBinary(SERVER, new Uint8Array([3]))).toBe(false)
  })
})

describe('ServerHub on a relay from before servers', () => {
  it('shows "too old for servers", keeps its servers offline and sends no watch or pair', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const { ServerHub } = await import('../src/main/servers/server-hub')
    const { generateEd25519, generateX25519, deviceId } = await import('../protocol/ts/index.ts')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-hub-old-relay-'))
    try {
      const ed = generateEd25519()
      const id = deviceId(ed.pub)
      fs.mkdirSync(path.join(dir, 'servers'))
      fs.writeFileSync(path.join(dir, 'servers', 'servers.json'), JSON.stringify([
        { id, name: 'box', x25519Pub: b64uEncode(generateX25519().pub), ed25519Pub: b64uEncode(ed.pub), pairedAt: 1, lastSeen: null }
      ]))
      const client = new FakeClient()
      client.binary = false
      const hub = new ServerHub({
        configDir: dir,
        relay: new RelayMux(client),
        identity: { get: () => { throw new Error('the identity is not needed here') } },
        relayUrl: () => 'ws://old-relay',
        build: { version: '1', commit: '', builtAt: '', bundleSha: '' },
        desktopName: () => 'mac',
        log: () => {}
      })
      const states: string[] = []
      hub.onStateChange((state) => states.push(state.relay.kind))
      hub.start()
      expect(client.connects).toEqual(['ws://old-relay'])
      client.setState({ kind: 'online' })
      expect(hub.getState()).toMatchObject({
        relay: { kind: 'too-old', error: 'This relay is too old for servers' },
        servers: [{ id, name: 'box', state: 'offline', problem: 'relay-too-old' }]
      })
      expect(client.sent).toEqual([])
      expect(client.binarySent).toEqual([])
      expect(states.at(-1)).toBe('too-old')
      hub.stop()
      expect(client.relayUrl).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
