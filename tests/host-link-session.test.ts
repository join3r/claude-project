import { createHash } from 'crypto'
import { once } from 'events'
import { describe, expect, it } from 'vitest'
import { LinkError } from '../src/main/host/link/errors'
import { LinkSession, type IncomingCall, type IncomingEvent, type LinkTimers, type LinkTransport } from '../src/main/host/link/session'
import { STREAM_WINDOW, type StreamKinds } from '../src/main/host/link/stream'
import { diagnosticStreamKinds, sourceBytes } from '../src/main/host/link/diagnostic-streams'
import { decodeLinkMessage, type LinkMessage } from '../src/main/host/link/wire'

/** Timers a test advances by hand (only what the session's batching uses). */
class ManualTimers implements LinkTimers {
  private tasks = new Map<number, () => void>()
  private seq = 0
  setTimeout = (fn: () => void) => { const id = ++this.seq; this.tasks.set(id, fn); return id }
  clearTimeout = (handle: unknown) => { this.tasks.delete(handle as number) }
  get pending(): number { return this.tasks.size }
  fire(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) task()
  }
}

interface Wire {
  /** Every message each side sent, decoded, in order. */
  sent: { desktop: LinkMessage[]; server: LinkMessage[] }
  /** Credit the desktop has received so far. */
  creditReceived: number
  /** The most data the desktop ever had out beyond the credit it had received. */
  maxDataPastCredit: number
  congested: boolean
  drain(): void
}

/**
 * A desktop and a server session joined back to back, delivering on a microtask
 * (as a socket would, later and in order).
 */
function loopback(options: {
  onCall?: (call: IncomingCall) => Promise<unknown>
  onEvent?: (event: IncomingEvent) => void
  onDetach?: (client: string) => void
  serverStreams?: StreamKinds
  desktopStreams?: StreamKinds
  timers?: LinkTimers
} = {}) {
  const drainWaiters: (() => void)[] = []
  const wire: Wire = {
    sent: { desktop: [], server: [] },
    creditReceived: 0,
    maxDataPastCredit: 0,
    congested: false,
    drain() {
      wire.congested = false
      for (const fn of drainWaiters.splice(0)) fn()
    }
  }
  const peers: { desktop?: LinkSession; server?: LinkSession } = {}
  const transport = (from: 'desktop' | 'server'): LinkTransport => ({
    send: (plaintext) => {
      const message = decodeLinkMessage(plaintext)
      wire.sent[from].push(message)
      if (from === 'desktop' && message.type === 'data') {
        const sent = wire.sent.desktop.reduce((n, m) => n + (m.type === 'data' ? m.bytes.length : 0), 0)
        wire.maxDataPastCredit = Math.max(wire.maxDataPastCredit, sent - wire.creditReceived)
      }
      const copy = Uint8Array.from(plaintext)
      queueMicrotask(() => {
        if (from === 'server' && message.type === 'credit') wire.creditReceived += message.n
        ;(from === 'desktop' ? peers.server : peers.desktop)!.receive(copy)
      })
      return true
    },
    congested: () => wire.congested,
    whenDrained: (fn) => { if (wire.congested) drainWaiters.push(fn); else fn() }
  })
  const desktop = new LinkSession({ transport: transport('desktop'), side: 'desktop', peer: 'server', onEvent: options.onEvent, streams: options.desktopStreams, log: () => {} })
  const server = new LinkSession({
    transport: transport('server'),
    side: 'server',
    peer: 'desktop',
    onCall: options.onCall,
    onDetach: options.onDetach,
    streams: options.serverStreams ?? diagnosticStreamKinds(),
    coalesce: { channel: 'pty-data', windowMs: 16, maxChars: 16 * 1024 },
    log: () => {},
    timers: options.timers
  })
  peers.desktop = desktop
  peers.server = server
  return { desktop, server, wire }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe('host link session (loopback)', () => {
  it('answers calls, and turns a handler error into a remote-error', async () => {
    const calls: IncomingCall[] = []
    const { desktop } = loopback({
      onCall: async (call) => {
        calls.push(call)
        if (call.ch === 'fail') throw new Error('nope')
        return { echoed: call.args }
      }
    })
    await expect(desktop.call('win:1', 'echo', [1, 'two', undefined], true)).resolves.toEqual({ echoed: [1, 'two', undefined] })
    expect(calls[0]).toMatchObject({ client: 'win:1', ch: 'echo', focused: true })
    await expect(desktop.call('win:1', 'fail', [])).rejects.toMatchObject({ name: 'LinkError', code: 'remote-error', message: 'nope' })
  })

  it('fails a result over 4 MiB cleanly, telling the caller to use a stream', async () => {
    const { desktop } = loopback({ onCall: async () => 'x'.repeat(5 * 1024 * 1024) })
    const error = await desktop.call('win:1', 'fb-read-file', []).catch((err: LinkError) => err)
    expect(error).toBeInstanceOf(LinkError)
    expect((error as LinkError).code).toBe('too-large')
    expect((error as LinkError).message).toMatch(/4 MiB.*fb-read-file needs a stream/)
  })

  it('refuses calls toward the desktop, and too-large arguments before sending', async () => {
    const { server, desktop } = loopback()
    await expect(server.call('x', 'anything', [])).rejects.toMatchObject({ code: 'unsupported' })
    await expect(desktop.call('win:1', 'pty-write', ['t', 'y'.repeat(5 * 1024 * 1024)])).rejects.toMatchObject({ code: 'too-large' })
  })

  it('fails pending calls with the close error when the session ends', async () => {
    const { desktop } = loopback({ onCall: () => new Promise(() => {}) })
    const pending = desktop.call('win:1', 'slow', [])
    await tick()
    desktop.close(new LinkError('server-offline', 'The server went offline'))
    await expect(pending).rejects.toMatchObject({ code: 'server-offline' })
    await expect(desktop.call('win:1', 'again', [])).rejects.toMatchObject({ code: 'server-offline' })
  })

  it('delivers events and detaches', async () => {
    const events: IncomingEvent[] = []
    const detached: string[] = []
    const { server, desktop } = loopback({ onEvent: (e) => events.push(e), onDetach: (c) => detached.push(c) })
    server.sendEvent('*', 'projects-updated', [{ revision: 2 }])
    desktop.detach('win:4')
    await tick()
    expect(events).toEqual([{ client: '*', ch: 'projects-updated', args: [{ revision: 2 }] }])
    expect(detached).toEqual(['win:4'])
  })

  it('batches pty-data per client and tab, and flushes it before anything else for order', async () => {
    const timers = new ManualTimers()
    const events: IncomingEvent[] = []
    let release!: (value: unknown) => void
    const { server, desktop, wire } = loopback({ timers, onEvent: (e) => events.push(e), onCall: () => new Promise((resolve) => { release = resolve }) })
    for (let i = 0; i < 100; i++) server.sendEvent('win:1', 'pty-data', ['tab-a', `${i},`])
    server.sendEvent('win:2', 'pty-data', ['tab-a', 'other window'])
    server.sendEvent('win:1', 'pty-data', ['tab-b', 'other tab'])
    expect(wire.sent.server).toHaveLength(0)
    expect(timers.pending).toBe(1)
    timers.fire()
    await tick()
    expect(events.map((e) => [e.client, e.args[0]])).toEqual([['win:1', 'tab-a'], ['win:2', 'tab-a'], ['win:1', 'tab-b']])
    expect(events[0].args[1]).toBe(Array.from({ length: 100 }, (_, i) => `${i},`).join(''))

    // pty-exit flushes the output before it, without waiting for the timer.
    events.length = 0
    server.sendEvent('win:1', 'pty-data', ['tab-a', 'last words'])
    server.sendEvent('win:1', 'pty-exit', ['tab-a', 0])
    await tick()
    expect(events.map((e) => e.ch)).toEqual(['pty-data', 'pty-exit'])
    expect(events[0].args[1]).toBe('last words')

    // So does a call's result.
    events.length = 0
    const result = desktop.call('win:1', 'pty-spawn', [])
    await tick()
    server.sendEvent('win:1', 'pty-data', ['tab-a', 'before the result'])
    release({ scrollback: '' })
    await result
    expect(events.map((e) => e.args[1])).toEqual(['before the result'])
  })

  it('splits a large batch into messages that fit one Noise message, without breaking characters', async () => {
    const timers = new ManualTimers()
    const events: IncomingEvent[] = []
    const { server } = loopback({ timers, onEvent: (e) => events.push(e) })
    const text = '😀'.repeat(20_000) // 40000 UTF-16 units
    server.sendEvent('win:1', 'pty-data', ['tab', text])
    await tick()
    expect(events.length).toBe(3)
    expect(events.every((e) => (e.args[1] as string).length <= 16 * 1024)).toBe(true)
    expect(events.map((e) => e.args[1]).join('')).toBe(text)
  })

  it('echoes a stream both ways', async () => {
    const { desktop } = loopback()
    const stream = desktop.openStream('echo')
    const payload = sourceBytes(0, 1_000_000, 7)
    stream.end(payload)
    const back = await readAll(stream)
    expect(back.equals(Buffer.from(payload))).toBe(true)
    await tick()
    expect(desktop.openStreamCount).toBe(0)
  })

  it('keeps at most one window in flight to a slow reader', async () => {
    const { desktop, wire } = loopback()
    const stream = desktop.openStream('sink', { delayMs: 2 })
    const total = 3 * 1024 * 1024
    const payload = sourceBytes(0, total, 3)
    for (let offset = 0; offset < total; offset += 256 * 1024) {
      if (!stream.write(payload.subarray(offset, offset + 256 * 1024))) await once(stream, 'drain')
    }
    stream.end()
    const reply = JSON.parse((await readAll(stream)).toString()) as { bytes: number; sha256: string }
    expect(reply).toEqual({ bytes: total, sha256: createHash('sha256').update(payload).digest('hex') })
    // Never more than the window beyond what the reader granted, and it did fill the window.
    expect(wire.maxDataPastCredit).toBeLessThanOrEqual(STREAM_WINDOW)
    expect(wire.maxDataPastCredit).toBeGreaterThan(STREAM_WINDOW / 2)
    // The sink read slowly, so the sender really waited for credit.
    expect(wire.sent.server.filter((m) => m.type === 'credit').length).toBeGreaterThan(10)
  })

  it('reads a source stream and stops writing while the socket is congested', async () => {
    const { desktop, wire } = loopback()
    wire.congested = true
    const stream = desktop.openStream('echo')
    stream.write(Buffer.alloc(1000, 1))
    await tick()
    expect(wire.sent.desktop.filter((m) => m.type === 'data')).toHaveLength(0)
    wire.drain()
    stream.end()
    expect((await readAll(stream)).length).toBe(1000)

    const source = desktop.openStream('source', { bytes: 700_000, seed: 9 })
    source.end()
    const bytes = await readAll(source)
    expect(bytes.equals(Buffer.from(sourceBytes(0, 700_000, 9)))).toBe(true)
  })

  it('refuses an unknown stream kind, and aborts streams when the session closes', async () => {
    const { desktop } = loopback()
    const refused = desktop.openStream('teleport')
    const error = await new Promise<Error>((resolve) => refused.on('error', resolve))
    expect(error).toMatchObject({ code: 'refused', message: 'unknown stream kind teleport' })

    const open = desktop.openStream('echo')
    const closed = new Promise<Error>((resolve) => open.on('error', resolve))
    open.write('hi')
    await tick()
    desktop.close(new LinkError('server-offline', 'gone'))
    expect(await closed).toMatchObject({ code: 'server-offline' })
    expect(desktop.openStreamCount).toBe(0)
  })

  it('aborts a stream that sends past its credit', async () => {
    const seen: Error[] = []
    const streams: StreamKinds = new Map([['hold', (stream) => { stream.on('error', (e) => seen.push(e)) }]])
    const { desktop, server } = loopback({ serverStreams: streams })
    const stream = desktop.openStream('hold')
    stream.on('error', () => {})
    await tick()
    // Forge a data message past the window, as a broken peer would.
    const { encodeLinkMessage } = await import('../src/main/host/link/wire')
    server.receive(encodeLinkMessage({ type: 'data', sid: stream.sid, bytes: new Uint8Array(STREAM_WINDOW + 1) }))
    await tick()
    expect(seen[0]).toMatchObject({ code: 'protocol-error' })
  })
})
