import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RELAY_PATH,
  b64uEncode,
  buildHello,
  decodeRelayBinaryFrame,
  deriveRelayToken,
  deviceId,
  encodeRelayBinaryFrame,
  encodeRelayMessage,
  generateEd25519,
  generateX25519,
  parseServerMessage,
  tokenHash
} from '../../protocol/ts/index.ts'
import type { ClientMessage, KeyPair, Role, ServerMessage } from '../../protocol/ts/index.ts'
import { startRelayServer } from '../src/server.ts'
import type { RelayServer, RelayServerOptions } from '../src/server.ts'
import { MemoryStore } from '../src/store.ts'

export interface Device {
  ed: KeyPair
  x: KeyPair
  id: string
}

export function makeDevice(): Device {
  const ed = generateEd25519()
  return { ed, x: generateX25519(), id: deviceId(ed.pub) }
}

export async function startTestRelay(options: Partial<RelayServerOptions> = {}): Promise<RelayServer> {
  return startRelayServer({ store: options.store ?? new MemoryStore(), port: 0, host: '127.0.0.1', ...options })
}

export function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), 'devtool-relay-test-'))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A random pairing secret with what the desktop sends (`tokenHash`) and what the phone sends (`token`). */
export function makeSecret(): { token: Uint8Array; tokenHash: string } {
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const token = deriveRelayToken(secret)
  return { token, tokenHash: b64uEncode(tokenHash(token)) }
}

export interface CloseInfo {
  code: number
  reason: string
}

type Pred = (m: ServerMessage) => boolean

/** A binary frame from the relay (§3.9): `peer` is the sender. */
export interface BinaryIn {
  peer: string
  envelope: Uint8Array
}

/**
 * A relay client over Node's global WebSocket that queues every server message, so
 * tests can `await next(...)` in any order and assert that nothing else arrived.
 */
export class TestClient {
  readonly ws: WebSocket
  readonly closed: Promise<CloseInfo>
  nonce = ''
  id = ''
  #queue: ServerMessage[] = []
  #waiters: Array<{ pred: Pred; resolve: (m: ServerMessage) => void }> = []
  #binary: BinaryIn[] = []
  #binaryWaiters: Array<(m: BinaryIn) => void> = []
  #closeInfo: CloseInfo | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => {
        this.#closeInfo = { code: e.code, reason: e.reason }
        resolve(this.#closeInfo)
      })
    })
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        const frame = decodeRelayBinaryFrame(new Uint8Array(e.data))
        const waiter = this.#binaryWaiters.shift()
        if (waiter) waiter(frame)
        else this.#binary.push(frame)
        return
      }
      const msg = parseServerMessage(String(e.data))
      if (!msg) return
      const i = this.#waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) {
        const [w] = this.#waiters.splice(i, 1)
        w.resolve(msg)
      } else {
        this.#queue.push(msg)
      }
    })
  }

  /** Opens a socket and waits for the challenge. */
  static async connect(server: RelayServer | string): Promise<TestClient> {
    const base = typeof server === 'string' ? server : server.url
    const ws = new WebSocket(base + RELAY_PATH)
    const client = new TestClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true })
    })
    const challenge = await client.next((m) => m.t === 'challenge')
    if (challenge.t === 'challenge') client.nonce = challenge.nonce
    return client
  }

  /** Connects and authenticates; resolves once `ready` arrives. `binary` asks for binary frames (§3.9). */
  static async auth(
    server: RelayServer | string,
    role: Role,
    device: Device,
    pair?: { to: string; token: Uint8Array },
    options: { binary?: boolean } = {}
  ): Promise<TestClient> {
    const client = await TestClient.connect(server)
    client.send(buildHello({ role, nonce: client.nonce, ed25519Priv: device.ed.priv, ed25519Pub: device.ed.pub, pair, binary: options.binary }))
    const ready = await client.next((m) => m.t === 'ready' || (m.t === 'error' && m.code === 'auth'))
    if (ready.t !== 'ready') throw new Error(`auth failed: ${JSON.stringify(ready)}`)
    client.id = ready.id
    return client
  }

  /** Sends `envelope` to `to` as a binary frame. */
  sendBinary(to: string, envelope: Uint8Array): void {
    this.ws.send(encodeRelayBinaryFrame(to, envelope))
  }

  /** Resolves with (and consumes) the next binary frame. */
  nextBinary(timeoutMs = 3000): Promise<BinaryIn> {
    const queued = this.#binary.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const waiter = (m: BinaryIn): void => {
        clearTimeout(timer)
        resolve(m)
      }
      const timer = setTimeout(() => {
        this.#binaryWaiters.splice(this.#binaryWaiters.indexOf(waiter), 1)
        reject(new Error('timed out waiting for a binary frame'))
      }, timeoutMs)
      this.#binaryWaiters.push(waiter)
    })
  }

  /** Binary frames that arrived and nobody claimed yet. */
  get binaryQueued(): number {
    return this.#binary.length
  }

  send(message: ClientMessage | string): void {
    this.ws.send(typeof message === 'string' ? message : encodeRelayMessage(message))
  }

  frame(to: string, data = 'AQID'): void {
    this.send({ t: 'frame', to, data })
  }

  /** Resolves with (and consumes) the first queued or future message matching `pred`. */
  next(pred: Pred = () => true, timeoutMs = 3000): Promise<ServerMessage> {
    const i = this.#queue.findIndex(pred)
    if (i >= 0) return Promise.resolve(this.#queue.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (m: ServerMessage) => {
          clearTimeout(timer)
          resolve(m)
        }
      }
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
        reject(new Error(`timed out waiting for a message; queued: ${JSON.stringify(this.#queue)}`))
      }, timeoutMs)
      this.#waiters.push(waiter)
    })
  }

  nextOfType<T extends ServerMessage['t']>(t: T, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>> {
    return this.next((m) => m.t === t, timeoutMs) as Promise<Extract<ServerMessage, { t: T }>>
  }

  /** Waits `ms`, then returns (and drains) whatever arrived unclaimed. */
  async drain(ms = 100): Promise<ServerMessage[]> {
    await sleep(ms)
    return this.#queue.splice(0)
  }

  /** Waits `ms`, then returns (and drains) the binary frames nobody claimed. */
  async drainBinary(ms = 100): Promise<BinaryIn[]> {
    await sleep(ms)
    return this.#binary.splice(0)
  }

  get isClosed(): boolean {
    return this.#closeInfo !== null
  }

  close(): Promise<CloseInfo> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close()
    return this.closed
  }
}

/** Resolves with the close info, or rejects if the socket is still open after `ms`. */
export async function closedWithin(client: TestClient, ms = 3000): Promise<CloseInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('socket did not close')), ms)
  })
  try {
    return await Promise.race([client.closed, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Desktop online with a live offer, and a phone that attached to it as pending. */
export async function pendingPair(server: RelayServer, desktopDevice = makeDevice(), phoneDevice = makeDevice()) {
  const desktop = await TestClient.auth(server, 'desktop', desktopDevice)
  const secret = makeSecret()
  desktop.send({ t: 'offer', tokenHash: secret.tokenHash, exp: Math.floor(Date.now() / 1000) + 300 })
  // Round-trip a ping so the offer is in place before the phone arrives.
  desktop.send({ t: 'ping' })
  await desktop.nextOfType('pong')
  const phone = await TestClient.auth(server, 'phone', phoneDevice, { to: desktopDevice.id, token: secret.token })
  await desktop.next((m) => m.t === 'peer' && m.id === phoneDevice.id && m.state === 'online')
  return { desktop, phone, desktopDevice, phoneDevice, secret }
}

/** `pendingPair` plus `authorize`, confirmed by a frame routed after the fact. */
export async function authorizedPair(server: RelayServer, desktopDevice = makeDevice(), phoneDevice = makeDevice()) {
  const p = await pendingPair(server, desktopDevice, phoneDevice)
  p.desktop.send({ t: 'authorize', phone: phoneDevice.id, pub: b64uEncode(phoneDevice.ed.pub) })
  p.desktop.send({ t: 'ping' })
  await p.desktop.nextOfType('pong')
  return p
}

/** Pings and waits for the pong, so everything sent before it has been handled. */
export async function roundTrip(client: TestClient): Promise<void> {
  client.send({ t: 'ping' })
  await client.nextOfType('pong')
}

/** `owner` (desktop or server) sends a fresh offer and waits until the relay holds it. */
export async function offer(owner: TestClient): Promise<{ token: Uint8Array; tokenHash: string }> {
  const secret = makeSecret()
  owner.send({ t: 'offer', tokenHash: secret.tokenHash, exp: Math.floor(Date.now() / 1000) + 300 })
  await roundTrip(owner)
  return secret
}
