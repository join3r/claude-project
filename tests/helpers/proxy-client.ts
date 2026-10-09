import { once } from 'events'
import net from 'net'

/** `Proxy-Authorization` for `user:pass`. */
export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** Sends `head` (and `body`) to the proxy, half-closes when `end`, and answers everything that comes back until the proxy closes. */
export async function proxyExchange(port: number, head: string, options: { body?: Buffer | string; end?: boolean } = {}): Promise<string> {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
  socket.on('error', () => {})
  await once(socket, 'connect')
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.write(head)
  if (options.body) socket.write(options.body)
  if (options.end !== false) socket.end()
  await Promise.race([once(socket, 'end'), once(socket, 'close')])
  socket.destroy()
  return Buffer.concat(chunks).toString('latin1')
}

/** Opens a CONNECT tunnel; answers the socket (after the proxy's reply) and the reply's status line. */
export async function proxyConnect(port: number, authority: string, authorization?: string): Promise<{ socket: net.Socket; status: string }> {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
  socket.on('error', () => {})
  await once(socket, 'connect')
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}\r\n`)
  let buffer = Buffer.alloc(0)
  while (!buffer.includes('\r\n\r\n')) {
    const [chunk] = await Promise.race([once(socket, 'data'), once(socket, 'close').then(() => [Buffer.alloc(0)])]) as [Buffer]
    if (chunk.length === 0) break
    buffer = Buffer.concat([buffer, chunk])
  }
  socket.pause()
  const end = buffer.indexOf('\r\n\r\n')
  if (end >= 0 && end + 4 < buffer.length) socket.unshift(buffer.subarray(end + 4))
  return { socket, status: buffer.toString('latin1').split('\r\n')[0] }
}

export async function readToEnd(socket: net.Socket): Promise<string> {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.resume()
  if (!socket.readableEnded) await Promise.race([once(socket, 'end'), once(socket, 'close')])
  return Buffer.concat(chunks).toString('latin1')
}

/**
 * Writes `data` and keeps the connection open (as a browser does) until what
 * came back satisfies `done`, or `timeoutMs` passes. Answers what came back.
 */
export async function exchangeUntil(port: number, data: string, done: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
  const socket = net.connect({ port, host: '127.0.0.1' })
  socket.on('error', () => {})
  await once(socket, 'connect')
  let text = ''
  const finished = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1')
      if (done(text)) {
        clearTimeout(timer)
        resolve()
      }
    })
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  socket.write(data)
  await finished
  socket.destroy()
  return text
}
