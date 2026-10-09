import { describe, expect, it } from 'vitest'
import { RelayClient, type RelayClientTimers, type WebSocketLike } from '../src/main/mobile/relay-client'
import type { RelayServerMessage, RelayTransportState } from '../src/main/mobile/mobile-service'
import {
  b64uEncode,
  deviceId,
  generateEd25519,
  parseClientMessage,
  verifyHello
} from '../protocol/ts/index.ts'
import type { ClientMessage, HelloMessage } from '../protocol/ts/index.ts'

class Timers implements RelayClientTimers {
  current = 0
  private seq = 0
  private tasks = new Map<number, { at: number; fn: () => void; every?: number }>()
  now = () => this.current
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.seq; this.tasks.set(id, { at: this.current + ms, fn }); return id }
  clearTimeout = (h: unknown) => { this.tasks.delete(h as number) }
  setInterval = (fn: () => void, ms: number) => { const id = ++this.seq; this.tasks.set(id, { at: this.current + ms, fn, every: ms }); return id }
  clearInterval = (h: unknown) => { this.tasks.delete(h as number) }
  advance(ms: number): void {
    const until = this.current + ms
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, task] = due
      this.current = task.at
      if (task.every) task.at += task.every
      else this.tasks.delete(id)
      task.fn()
    }
    this.current = until
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: ClientMessage[] = []
  closedWith: number | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(parseClientMessage(data)) }
  close(code = 1000): void { this.closedWith = code; this.readyState = 3 }
  // server side
  open(): void { this.readyState = 1; this.onopen?.({}) }
  push(message: object): void { this.onmessage?.({ data: JSON.stringify(message) }) }
  drop(code = 1006, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }) }
}

const NONCE = b64uEncode(new Uint8Array(32).fill(5))

function setup() {
  const keys = generateEd25519()
  const id = deviceId(keys.pub)
  const timers = new Timers()
  const sockets: FakeSocket[] = []
  const states: RelayTransportState[] = []
  const messages: RelayServerMessage[] = []
  const client = new RelayClient({
    ed25519: () => keys,
    deviceId: () => id,
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s },
    timers
  })
  client.onStateChange((s) => states.push(s))
  client.onMessage((m) => messages.push(m))
  const socket = () => sockets[sockets.length - 1]
  /** Run the relay's side of §3.1 on the latest socket. */
  const authenticate = () => {
    socket().open()
    socket().push({ t: 'challenge', nonce: NONCE })
    const hello = socket().sent.at(-1) as HelloMessage
    expect(verifyHello(hello, NONCE)).toBe(id)
    socket().push({ t: 'ready', id })
  }
  return { client, keys, id, timers, sockets, socket, states, messages, authenticate }
}

describe('RelayClient', () => {
  it('connects to <relay>/v1, signs the challenge as a desktop and goes online on ready', () => {
    const env = setup()
    env.client.connect('ws://localhost:8787/')
    expect(env.socket().url).toBe('ws://localhost:8787/v1')
    expect(env.client.getState()).toEqual({ kind: 'connecting' })
    env.authenticate()
    expect(env.socket().sent[0]).toMatchObject({ t: 'hello', role: 'desktop', pub: b64uEncode(env.keys.pub) })
    expect(env.states.map(s => s.kind)).toEqual(['connecting', 'online'])
  })

  it('refuses to send before ready, sends after', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.socket().open()
    expect(env.client.send({ t: 'revoke', phone: 'a'.repeat(32) })).toBe(false)
    env.socket().push({ t: 'challenge', nonce: NONCE })
    env.socket().push({ t: 'ready', id: env.id })
    expect(env.client.send({ t: 'revoke', phone: 'a'.repeat(32) })).toBe(true)
    expect(env.socket().sent.at(-1)).toEqual({ t: 'revoke', phone: 'a'.repeat(32) })
  })

  it('passes frame, peer and error to the service, answers pings, ignores junk', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.authenticate()
    const phone = 'b'.repeat(32)
    env.socket().push({ t: 'frame', from: phone, data: 'AQID', extra: 1 })
    env.socket().push({ t: 'peer', id: phone, state: 'online' })
    env.socket().push({ t: 'error', code: 'offline', to: phone })
    env.socket().push({ t: 'ping' })
    env.socket().onmessage?.({ data: 'not json' })
    env.socket().push({ t: 'mystery' })
    expect(env.messages).toEqual([
      { t: 'frame', from: phone, data: 'AQID' },
      { t: 'peer', id: phone, state: 'online' },
      { t: 'error', code: 'offline', to: phone }
    ])
    expect(env.socket().sent.at(-1)).toEqual({ t: 'pong' })
  })

  it('reconnects with backoff 1 s → 30 s and resets it after a good connection', () => {
    const env = setup()
    env.client.connect('ws://r')
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      const before = env.sockets.length
      env.socket().drop(1006)
      let waited = 0
      while (env.sockets.length === before) { env.timers.advance(500); waited += 500 }
      delays.push(waited)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(env.client.getState()).toEqual({ kind: 'connecting' })
    env.authenticate()
    env.socket().drop(1006)
    env.timers.advance(999)
    const count = env.sockets.length
    env.timers.advance(1)
    expect(env.sockets.length).toBe(count + 1)
  })

  it('reports why it is offline', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.socket().onerror?.({})
    env.socket().drop(1006)
    expect(env.client.getState()).toEqual({ kind: 'offline', error: 'Relay unreachable' })
    env.timers.advance(1000)
    env.socket().open()
    env.socket().drop(4401, 'auth')
    expect(env.client.getState()).toEqual({ kind: 'offline', error: 'Relay refused this desktop' })
  })

  it('pings every 25 s and gives up on a relay silent for 60 s', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.authenticate()
    const first = env.socket()
    env.timers.advance(25_000)
    expect(first.sent.at(-1)).toEqual({ t: 'ping' })
    first.push({ t: 'pong' })
    env.timers.advance(50_000)
    expect(first.sent.filter(m => m.t === 'ping')).toHaveLength(3)
    expect(first.closedWith).toBeNull()
    env.timers.advance(25_000) // 75 s since the pong
    expect(first.closedWith).toBe(1000)
    expect(env.client.getState()).toEqual({ kind: 'offline', error: 'Relay stopped responding' })
  })

  it('abandons an attempt that never reaches ready', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.socket().open()
    env.timers.advance(15_000)
    expect(env.socket().closedWith).toBe(1000)
    expect(env.client.getState().kind).toBe('offline')
  })

  it('close stops everything, including pending reconnects', () => {
    const env = setup()
    env.client.connect('ws://r')
    env.socket().drop(1006)
    env.client.close()
    expect(env.client.getState()).toEqual({ kind: 'idle' })
    env.timers.advance(120_000)
    expect(env.sockets).toHaveLength(1)
  })

  it('a socket that fails to construct counts as a failed attempt', () => {
    const env = setup()
    const client = new RelayClient({
      ed25519: () => env.keys,
      deviceId: () => env.id,
      createSocket: () => { throw new Error('bad url') },
      timers: env.timers
    })
    client.connect('ws://r')
    expect(client.getState()).toEqual({ kind: 'offline', error: 'bad url' })
  })
})

describe('RelayClient as a host on binary frames (SPEC.md §3.9)', () => {
  class BinarySocket extends FakeSocket {
    bufferedAmount = 0
    binaryType: string | undefined
    readonly binary: Uint8Array[] = []
    override send(data: string | Uint8Array): void {
      if (typeof data === 'string') super.send(data)
      else this.binary.push(data)
    }
    pushBinary(bytes: Uint8Array): void {
      this.onmessage?.({ data: bytes.slice().buffer })
    }
  }

  function hostSetup(role: 'desktop' | 'server') {
    const keys = generateEd25519()
    const id = deviceId(keys.pub)
    const timers = new Timers()
    const sockets: BinarySocket[] = []
    const frames: { from: string; envelope: Uint8Array }[] = []
    const client = new RelayClient({
      role,
      binary: true,
      ed25519: () => keys,
      deviceId: () => id,
      createSocket: (url) => { const s = new BinarySocket(url); sockets.push(s); return s },
      timers
    })
    client.onBinaryFrame((from, envelope) => frames.push({ from, envelope }))
    const socket = () => sockets[sockets.length - 1]
    const authenticate = (binary = true) => {
      socket().open()
      socket().push({ t: 'challenge', nonce: NONCE })
      const hello = socket().sent.at(-1) as HelloMessage
      expect(verifyHello(hello, NONCE)).toBe(id)
      socket().push(binary ? { t: 'ready', id, binary: true } : { t: 'ready', id })
      return hello
    }
    return { client, id, timers, socket, frames, authenticate }
  }

  it('signs in as a server asking for binary frames, and says whether the relay agreed', () => {
    const env = hostSetup('server')
    env.client.connect('ws://r')
    expect(env.socket().binaryType).toBe('arraybuffer')
    const hello = env.authenticate()
    expect(hello).toMatchObject({ role: 'server', binary: true })
    expect(env.client.isBinary()).toBe(true)
    expect(env.client.relayUrl).toBe('ws://r')

    const old = hostSetup('desktop')
    old.client.connect('ws://r')
    old.authenticate(false)
    expect(old.client.getState()).toEqual({ kind: 'online' })
    expect(old.client.isBinary()).toBe(false)
  })

  it('hands binary frames to their listeners and sends them, only once online', () => {
    const env = hostSetup('desktop')
    env.client.connect('ws://r')
    const peer = 'c'.repeat(32)
    expect(env.client.sendBinary(peer, new Uint8Array([3, 1]))).toBe(false)
    env.authenticate()
    expect(env.client.sendBinary(peer, new Uint8Array([3, 1]))).toBe(true)
    expect([...env.socket().binary[0]]).toEqual([...new Uint8Array(16).fill(0xcc), 3, 1])
    env.socket().pushBinary(new Uint8Array([...new Uint8Array(16).fill(0xab), 2, 9, 9]))
    expect(env.frames).toEqual([{ from: 'ab'.repeat(16), envelope: new Uint8Array([2, 9, 9]) }])
    // Junk is logged and dropped.
    env.socket().pushBinary(new Uint8Array([1, 2]))
    expect(env.frames).toHaveLength(1)
  })

  it('waits three idle timeouts before giving up on a relay while its own sends are queued', () => {
    const env = hostSetup('server')
    env.client.connect('ws://r')
    env.authenticate()
    env.socket().bufferedAmount = 5 * 1024 * 1024
    env.timers.advance(75_000)
    expect(env.client.getState().kind).toBe('online')
    env.timers.advance(100_000) // 175 s: still under 3 × 60 s
    expect(env.client.getState().kind).toBe('online')
    env.timers.advance(25_000) // the first ping tick after 180 s of silence
    expect(env.client.getState()).toEqual({ kind: 'offline', error: 'Relay stopped responding' })
  })

  it('runs drain waiters once the buffer is under their mark, or the socket is gone', () => {
    const env = hostSetup('desktop')
    env.client.connect('ws://r')
    env.authenticate()
    const order: string[] = []
    env.client.onBufferBelow(100, () => order.push('immediate'))
    env.socket().bufferedAmount = 1000
    env.client.onBufferBelow(100, () => order.push('low'))
    env.client.onBufferBelow(500, () => order.push('high'))
    env.timers.advance(50)
    expect(order).toEqual(['immediate'])
    env.socket().bufferedAmount = 400
    env.timers.advance(10)
    expect(order).toEqual(['immediate', 'high'])
    env.client.onBufferBelow(10, () => order.push('gone'))
    env.socket().drop(1006)
    expect(order).toEqual(['immediate', 'high', 'low', 'gone'])
  })
})
