import type { HostLinkPort } from './relay-mux'
import type { SealedChannel } from './secure'
import type { LinkTransport } from './session'

/**
 * Over this many bytes queued on the relay socket, a link holds back what can wait:
 * streams stop writing and a server pauses the terminals writing to that desktop.
 * Well under the relay's 4 MiB high-water mark (SPEC.md §3.10).
 */
export const LINK_HIGH_WATER_BYTES = 512 * 1024
/** ...and resumes once the socket is back under this. */
export const LINK_LOW_WATER_BYTES = 128 * 1024

/** A session's transport through the shared relay socket to `peer`, sealed by `channel`. */
export function relayLinkTransport(port: HostLinkPort, peer: string, channel: SealedChannel): LinkTransport {
  return {
    send: (plaintext) => {
      for (const envelope of channel.seal(plaintext)) {
        if (!port.sendBinary(peer, envelope)) return false
      }
      return true
    },
    congested: () => port.bufferedAmount() > LINK_HIGH_WATER_BYTES,
    whenDrained: (fn) => port.onBufferBelow(LINK_LOW_WATER_BYTES, fn)
  }
}
