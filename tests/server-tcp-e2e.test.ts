import { createHash, randomBytes } from 'crypto'
import { once } from 'events'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnosticStreamKinds } from '../src/main/host/link/diagnostic-streams'
import { TCP_STREAM_KIND, TcpConnectError, connectTcpStream, tcpStreamHandler } from '../src/main/host/link/tcp-stream'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer } from './helpers/host-link'

/**
 * `tcp` streams end to end (protocol/SERVER.md §6.3): a desktop's ServerHub, the
 * real relay and a server's ServerLink in process. The server dials this machine.
 */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

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

async function linked() {
  const { relay } = await startTestRelay()
  cleanups.push(() => relay.close())
  const server = await startTestServer(relay.url, { streams: new Map([...diagnosticStreamKinds(), [TCP_STREAM_KIND, tcpStreamHandler()]]) })
  cleanups.push(() => server.close())
  const desktop = startTestDesktop(relay.url)
  cleanups.push(() => desktop.close())
  await pairByCode(desktop, server)
  const openTcp = (host: string, port: number) => connectTcpStream(() => desktop.hub.openStream(server.id, TCP_STREAM_KIND, { host, port }))
  return { desktop, server, openTcp }
}

describe.skipIf(process.platform === 'win32')('tcp streams through the relay', () => {
  it('carries a large transfer both ways to a port on the server', { timeout: 60_000 }, async () => {
    const download = randomBytes(24 * 1024 * 1024)
    const upload = randomBytes(8 * 1024 * 1024)
    let uploaded: Promise<string> = Promise.resolve('')
    const target = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.end(download)
      uploaded = readAll(socket).then(sha)
    })
    target.listen(0, '127.0.0.1')
    await once(target, 'listening')
    cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())))
    const { openTcp } = await linked()
    const stream = await openTcp('localhost', (target.address() as net.AddressInfo).port)
    const reading = readAll(stream)
    stream.end(upload)
    const got = await reading
    expect(sha(got)).toBe(sha(download))
    expect(await uploaded).toBe(sha(upload))
  })

  it('reports a refused port, and the link stays up', { timeout: 30_000 }, async () => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const dead = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const { desktop, server, openTcp } = await linked()
    const error = await openTcp('127.0.0.1', dead).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(TcpConnectError)
    expect((error as TcpConnectError).code).toBe('ECONNREFUSED')
    expect(desktop.status(server.id)?.state).toBe('online')
  })
})
