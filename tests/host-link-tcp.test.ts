import { createHash, randomBytes } from 'crypto'
import { once } from 'events'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkSession, type LinkTransport } from '../src/main/host/link/session'
import { STREAM_WINDOW, type StreamKinds } from '../src/main/host/link/stream'
import { decodeLinkMessage } from '../src/main/host/link/wire'
import {
  TCP_STREAM_KIND,
  TcpConnectError,
  connectTcpStream,
  parseTcpTarget,
  spliceTcp,
  tcpFailureCode,
  tcpStreamHandler
} from '../src/main/host/link/tcp-stream'

/**
 * The `tcp` stream kind (protocol/SERVER.md §6.3) over two sessions joined back
 * to back: the server's handler dials real sockets on this machine.
 */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function loopback(serverStreams: StreamKinds) {
  const peers: { desktop?: LinkSession; server?: LinkSession } = {}
  let maxPastCredit = 0
  let desktopSent = 0
  let desktopCredit = 0
  const transport = (from: 'desktop' | 'server'): LinkTransport => ({
    send: (plaintext) => {
      const message = decodeLinkMessage(plaintext)
      if (from === 'desktop' && message.type === 'data') {
        desktopSent += message.bytes.length
        maxPastCredit = Math.max(maxPastCredit, desktopSent - desktopCredit)
      }
      const copy = Uint8Array.from(plaintext)
      queueMicrotask(() => {
        if (from === 'server' && message.type === 'credit') desktopCredit += message.n
        ;(from === 'desktop' ? peers.server : peers.desktop)?.receive(copy)
      })
      return true
    },
    congested: () => false,
    whenDrained: (fn) => fn()
  })
  peers.desktop = new LinkSession({ transport: transport('desktop'), side: 'desktop', peer: 'server', log: () => {} })
  peers.server = new LinkSession({ transport: transport('server'), side: 'server', peer: 'desktop', streams: serverStreams, log: () => {} })
  return { desktop: peers.desktop, server: peers.server, maxPastCredit: () => maxPastCredit }
}

const tcpKinds = (options: Parameters<typeof tcpStreamHandler>[0] = {}): StreamKinds => new Map([[TCP_STREAM_KIND, tcpStreamHandler(options)]])

/** A TCP server on 127.0.0.1 for the test; `onConnection` gets every socket. */
async function listen(onConnection: (socket: net.Socket) => void, options: net.ServerOpts = {}): Promise<number> {
  const server = net.createServer(options, onConnection)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}) })
  cleanups.push(() => { for (const s of sockets) s.destroy() })
  return (server.address() as net.AddressInfo).port
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * Everything `stream` sends until its end. Not `for await`: that destroys the
 * stream once it ends, which would cut off its other direction.
 */
function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.once('end', () => resolve(Buffer.concat(chunks)))
    stream.once('error', reject)
    // A connected tcp stream comes paused.
    stream.resume()
  })
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('tcp stream kind', () => {
  it('parses {host, port} and refuses anything else', () => {
    expect(parseTcpTarget({ host: 'localhost', port: 8000 })).toEqual({ host: 'localhost', port: 8000 })
    expect(parseTcpTarget({ host: '[::1]', port: 22 })).toEqual({ host: '::1', port: 22 })
    for (const bad of [null, [], { host: '', port: 1 }, { host: 'a b', port: 1 }, { host: 'x', port: 0 }, { host: 'x', port: 65536 }, { host: 'x', port: 1.5 }, { host: 'x/y', port: 1 }]) {
      expect(() => parseTcpTarget(bad), JSON.stringify(bad)).toThrow(/^EINVAL/)
    }
    expect(tcpFailureCode('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9')).toBe('ECONNREFUSED')
    expect(tcpFailureCode('nope')).toBeNull()
  })

  it('round-trips bytes through a socket the server dials', async () => {
    const port = await listen((socket) => socket.pipe(socket))
    const { desktop } = loopback(tcpKinds())
    const stream = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port }))
    stream.end(Buffer.from('hello over tcp'))
    expect((await readAll(stream)).toString()).toBe('hello over tcp')
  })

  it('moves a large transfer both ways within the credit window', { timeout: 30_000 }, async () => {
    const download = randomBytes(12 * 1024 * 1024)
    const upload = randomBytes(6 * 1024 * 1024)
    let received: Promise<string> = Promise.resolve('')
    const port = await listen((socket) => {
      socket.end(download)
      received = readAll(socket).then(sha)
    }, { allowHalfOpen: true })
    const { desktop, maxPastCredit } = loopback(tcpKinds())
    const stream = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: 'localhost', port }))
    const reading = readAll(stream)
    stream.end(upload)
    expect(sha(await reading)).toBe(sha(download))
    expect(await received).toBe(sha(upload))
    expect(maxPastCredit()).toBeLessThanOrEqual(STREAM_WINDOW)
  })

  it('reports a refused port with its code', async () => {
    const port = await closedPort()
    const { desktop } = loopback(tcpKinds())
    const error = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port })).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(TcpConnectError)
    expect((error as TcpConnectError).code).toBe('ECONNREFUSED')
  })

  it('gives up on a target that never answers, and refuses bad params', async () => {
    const { desktop } = loopback(tcpKinds({ connectTimeoutMs: 100, connect: () => new net.Socket() }))
    const timedOut = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '10.255.255.1', port: 80 })).catch((err: unknown) => err)
    expect((timedOut as TcpConnectError).code).toBe('ETIMEDOUT')
    const bad = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: 'x', port: 0 })).catch((err: unknown) => err)
    expect((bad as TcpConnectError).code).toBe('EINVAL')
  })

  it('is refused by a server without the kind', async () => {
    const { desktop } = loopback(new Map())
    const error = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port: 1 })).catch((err: unknown) => err)
    expect((error as TcpConnectError).code).toBe('refused')
  })

  it('passes half-closes both ways: the target ends first and still reads what follows', async () => {
    let targetGot: Promise<string> = Promise.resolve('')
    const port = await listen((socket) => {
      socket.end('bye from target')
      targetGot = readAll(socket).then((b) => b.toString())
    }, { allowHalfOpen: true })
    const { desktop } = loopback(tcpKinds())
    const stream = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port }))
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
    expect((await readAll(stream)).toString()).toBe('bye from target')
    stream.end('late words')
    expect(await targetGot).toBe('late words')
    await closed
    // Both ends finished cleanly: no reset either way.
    expect(stream.readableEnded && stream.writableFinished).toBe(true)
  })

  it('resets the other side when either side resets or aborts', async () => {
    const targets: net.Socket[] = []
    const port = await listen((socket) => { targets.push(socket) })
    const { desktop } = loopback(tcpKinds())

    // The target resets: the desktop's stream aborts.
    const first = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port }))
    const firstError = new Promise<Error>((resolve) => first.once('error', resolve))
    first.resume()
    await expect.poll(() => targets.length).toBe(1)
    targets[0].resetAndDestroy()
    expect((await firstError).message).toMatch(/^ECONNRESET/)
    expect(first.readableEnded && first.writableFinished).toBe(false)

    // The desktop aborts: the target's socket closes without a clean end.
    const second = await connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port }))
    second.on('error', () => {})
    await expect.poll(() => targets.length).toBe(2)
    const closed = new Promise<boolean>((resolve) => targets[1].once('close', (hadError) => resolve(hadError)))
    second.destroy(new Error('user closed the tab'))
    // Reset, not a clean FIN.
    expect(await closed).toBe(true)
  })

  it('splices a local socket to a stream, ends and resets included', async () => {
    const port = await listen((socket) => socket.pipe(socket))
    const { desktop } = loopback(tcpKinds())
    // A local listener whose every connection is spliced to the server's echo.
    const local = net.createServer({ allowHalfOpen: true }, (conn) => {
      void connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, { host: '127.0.0.1', port })).then((stream) => spliceTcp(conn, stream))
    })
    local.listen(0, '127.0.0.1')
    await once(local, 'listening')
    cleanups.push(() => new Promise<void>((resolve) => local.close(() => resolve())))
    const client = net.connect({ port: (local.address() as net.AddressInfo).port, host: '127.0.0.1', allowHalfOpen: true })
    await once(client, 'connect')
    client.end('spliced')
    expect((await readAll(client)).toString()).toBe('spliced')
  })
})
