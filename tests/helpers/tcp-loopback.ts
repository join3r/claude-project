import { LinkError } from '../../src/main/host/link/errors'
import { LinkSession, type LinkTransport } from '../../src/main/host/link/session'
import type { LinkStream } from '../../src/main/host/link/stream'
import { TCP_STREAM_KIND, connectTcpStream, tcpStreamHandler, type TcpTarget } from '../../src/main/host/link/tcp-stream'

/**
 * A desktop and a server link session back to back, the server serving `tcp`:
 * `openTcp` is what AppRuntime hands the browser proxies and Open in IDE, with
 * the server's dials going to this machine.
 */
export function tcpLoopback(): { openTcp: (serverId: string, target: TcpTarget) => Promise<LinkStream>; desktop: LinkSession; close(): void } {
  const peers: { desktop?: LinkSession; server?: LinkSession } = {}
  const transport = (from: 'desktop' | 'server'): LinkTransport => ({
    send: (plaintext) => {
      const copy = Uint8Array.from(plaintext)
      queueMicrotask(() => (from === 'desktop' ? peers.server : peers.desktop)?.receive(copy))
      return true
    },
    congested: () => false,
    whenDrained: (fn) => fn()
  })
  peers.desktop = new LinkSession({ transport: transport('desktop'), side: 'desktop', peer: 'server', log: () => {} })
  peers.server = new LinkSession({ transport: transport('server'), side: 'server', peer: 'desktop', streams: new Map([[TCP_STREAM_KIND, tcpStreamHandler()]]), log: () => {} })
  const desktop = peers.desktop
  return {
    desktop,
    openTcp: (_serverId, target) => connectTcpStream(() => desktop.openStream(TCP_STREAM_KIND, target)),
    close: () => {
      peers.desktop?.close(new LinkError('server-offline', 'closed'))
      peers.server?.close(new LinkError('server-offline', 'closed'))
    }
  }
}
