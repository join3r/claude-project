import { FrameKind, b64uDecode, b64uEncode } from '../../../../protocol/ts/index.ts'
import type { ClientMessage, ErrorMessage, PeerMessage } from '../../../../protocol/ts/index.ts'
import type { RelayServerMessage, RelayTransport, RelayTransportState } from '../../mobile/mobile-service'
import { PairFrame } from './pairing'

/** The relay connection a {@link RelayMux} shares: `RelayClient` in the app, a fake in tests. */
export interface MuxedRelayClient {
  connect(relayUrl: string): void
  close(): void
  readonly relayUrl: string | null
  send(message: ClientMessage): boolean
  sendBinary(peer: string, envelope: Uint8Array): boolean
  isBinary(): boolean
  bufferedAmount(): number
  onBufferBelow(below: number, fn: () => void): void
  getState(): RelayTransportState
  onMessage(listener: (message: RelayServerMessage) => void): () => void
  onBinaryFrame(listener: (from: string, envelope: Uint8Array) => void): () => void
  onStateChange(listener: (state: RelayTransportState) => void): () => void
}

/** What a host link (the desktop's servers, a server's desktops) gets from the shared socket. */
export interface HostLinkPort {
  /** Want the socket, on `relayUrl`. The last URL any user connected with wins. */
  connect(relayUrl: string): void
  /** No longer want the socket; it closes once nobody does. */
  close(): void
  getState(): RelayTransportState
  /** Whether the relay confirmed binary frames (§3.9); servers need it. */
  isBinary(): boolean
  send(message: ClientMessage): boolean
  sendBinary(peer: string, envelope: Uint8Array): boolean
  bufferedAmount(): number
  onBufferBelow(below: number, fn: () => void): void
  onStateChange(listener: (state: RelayTransportState) => void): () => void
  /** Another user of the socket sent an `offer`, which replaced this one's at the relay. */
  onOfferTaken(listener: () => void): () => void
}

export interface HostLinkHandlers {
  /** An envelope from a peer this port owns (JSON frames are decoded to bytes). */
  frame(from: string, envelope: Uint8Array): void
  peer(message: PeerMessage): void
  /** Errors about a peer it owns, and every error without a `to`. */
  error(message: ErrorMessage): void
  /**
   * A pairing hello (`0x05`, protocol/SERVER.md §7) from a peer no port owns yet:
   * a new server answering this desktop's invite, or a desktop proving a server's
   * code. Only one port should take these.
   */
  pairing?(from: string, envelope: Uint8Array): void
  /**
   * A Noise message 1 (`0x01`) from a peer no port owns: true when it is this
   * port's (a server telling a desktop it no longer knows from a phone, protocol/SERVER.md §3).
   * The port then gets it through `frame`; otherwise it goes to the phones.
   */
  claimHandshake?(from: string, envelope: Uint8Array): boolean
}

interface Lease {
  wanted: boolean
  url: string | null
  offerTakenListeners: Set<() => void>
}

interface HostLease extends Lease {
  owns: (peerId: string) => boolean
  handlers: HostLinkHandlers
  stateListeners: Set<(state: RelayTransportState) => void>
}

interface MobileLease extends Lease {
  messageListeners: Set<(message: RelayServerMessage) => void>
  stateListeners: Set<(state: RelayTransportState) => void>
}

const IDLE: RelayTransportState = { kind: 'idle' }

/**
 * One relay socket and one identity for everything a host does through the relay
 * (plan: "Relay connection on the desktop"). Phones go to the mobile service as
 * they always did; the peers a host link owns (a desktop's servers, a server's
 * desktops) go to that link instead. The socket runs while any user wants it.
 *
 * Routing is by peer ID: a `frame`, `peer` or `error { to }` about a peer some
 * host link `owns` goes to that link, everything else to the mobile transports.
 * A frame from a peer nobody owns is a link's only when it is a pairing hello
 * (`0x05`) or a message 1 the link claims (`claimHandshake`).
 * Binary frames for phones are turned back into JSON `frame`s, since the mobile
 * service speaks JSON; a host link always gets bytes.
 */
export class RelayMux {
  private readonly hostLeases = new Set<HostLease>()
  private readonly mobileLeases = new Set<MobileLease>()
  /** The URL of the user that connected last. */
  private url: string | null = null
  /**
   * The relay keeps one live offer per host (SPEC.md §3.2), so a phone QR and a
   * server invite (or, on a server, a desktop code and a phone QR) share it: the
   * last user to send `offer` holds it, and the one before is told it lost it.
   */
  private offerHolder: Lease | null = null

  constructor(private readonly client: MuxedRelayClient, private readonly log: (message: string) => void = () => {}) {
    client.onMessage((message) => this.route(message))
    client.onBinaryFrame((from, envelope) => this.routeBinary(from, envelope))
    client.onStateChange((state) => {
      for (const lease of this.mobileLeases) if (lease.wanted) for (const l of lease.stateListeners) l(state)
      for (const lease of this.hostLeases) if (lease.wanted) for (const l of lease.stateListeners) l(state)
    })
  }

  /** What `MobileService` gets from `createTransport()`: one per connect, like the RelayClient it replaces. */
  mobileTransport(): RelayTransport {
    const lease: MobileLease = { wanted: false, url: null, offerTakenListeners: new Set(), messageListeners: new Set(), stateListeners: new Set() }
    this.mobileLeases.add(lease)
    return {
      connect: (relayUrl) => this.want(lease, relayUrl),
      close: () => {
        this.release(lease)
        this.mobileLeases.delete(lease)
      },
      send: (message) => this.send(lease, message),
      getState: () => (lease.wanted ? this.client.getState() : IDLE),
      onMessage: (listener) => {
        lease.messageListeners.add(listener)
        return () => { lease.messageListeners.delete(listener) }
      },
      onStateChange: (listener) => {
        lease.stateListeners.add(listener)
        return () => { lease.stateListeners.delete(listener) }
      },
      onOfferTaken: (listener) => {
        lease.offerTakenListeners.add(listener)
        return () => { lease.offerTakenListeners.delete(listener) }
      }
    }
  }

  /** A host link's port: frames, presence and errors about the peers `owns` claims come here. */
  hostPort(owns: (peerId: string) => boolean, handlers: HostLinkHandlers): HostLinkPort {
    const lease: HostLease = { wanted: false, url: null, owns, handlers, stateListeners: new Set(), offerTakenListeners: new Set() }
    this.hostLeases.add(lease)
    return {
      connect: (relayUrl) => this.want(lease, relayUrl),
      close: () => this.release(lease),
      getState: () => (lease.wanted ? this.client.getState() : IDLE),
      isBinary: () => lease.wanted && this.client.isBinary(),
      send: (message) => this.send(lease, message),
      sendBinary: (peer, envelope) => lease.wanted && this.client.sendBinary(peer, envelope),
      bufferedAmount: () => this.client.bufferedAmount(),
      onBufferBelow: (below, fn) => this.client.onBufferBelow(below, fn),
      onStateChange: (listener) => {
        lease.stateListeners.add(listener)
        return () => { lease.stateListeners.delete(listener) }
      },
      onOfferTaken: (listener) => {
        lease.offerTakenListeners.add(listener)
        return () => { lease.offerTakenListeners.delete(listener) }
      }
    }
  }

  /** Whether anything wants the socket right now. */
  get active(): boolean {
    return [...this.hostLeases, ...this.mobileLeases].some((lease) => lease.wanted)
  }

  private want(lease: Lease & { stateListeners: Set<(state: RelayTransportState) => void> }, relayUrl: string): void {
    const was = lease.wanted
    lease.wanted = true
    lease.url = relayUrl
    this.url = relayUrl
    const before = this.client.getState()
    this.update()
    // Joining a socket another user already brought online: this user never sees
    // the change to online happen, so it is told now (it sends its offer, `watch`...).
    if (!was && before.kind === 'online' && this.client.getState().kind === 'online') {
      for (const listener of lease.stateListeners) listener(this.client.getState())
    }
  }

  private send(lease: Lease, message: ClientMessage): boolean {
    if (!lease.wanted) return false
    const sent = this.client.send(message)
    if (sent && message.t === 'offer') {
      const previous = this.offerHolder
      this.offerHolder = lease
      if (previous && previous !== lease) {
        for (const listener of [...previous.offerTakenListeners]) {
          try {
            listener()
          } catch (err) {
            this.log(`relayMux offerTaken listener error=${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }
    return sent
  }

  private release(lease: Lease): void {
    if (!lease.wanted) return
    lease.wanted = false
    this.update()
  }

  private update(): void {
    if (!this.active) {
      if (this.client.relayUrl !== null) this.client.close()
      return
    }
    const url = this.url!
    if (this.client.relayUrl !== url.replace(/\/+$/, '')) {
      if (this.client.relayUrl !== null) this.log(`relayMux relay=${url}`)
      this.client.connect(url)
    }
  }

  private ownerOf(peerId: string): HostLease | null {
    for (const lease of this.hostLeases) if (lease.wanted && lease.owns(peerId)) return lease
    return null
  }

  /** A pairing hello from a peer nobody owns yet goes to the port that takes them. */
  private pairingOwner(envelope: Uint8Array): HostLease | null {
    if (envelope[0] !== PairFrame.Hello) return null
    for (const lease of this.hostLeases) if (lease.wanted && lease.handlers.pairing) return lease
    return null
  }

  /** A Noise message 1 from a peer nobody owns: the port that recognises it as its own, if any. */
  private handshakeOwner(from: string, envelope: Uint8Array): HostLease | null {
    if (envelope[0] !== FrameKind.Handshake1) return null
    for (const lease of this.hostLeases) {
      if (!lease.wanted || !lease.handlers.claimHandshake) continue
      try {
        if (lease.handlers.claimHandshake(from, envelope)) return lease
      } catch (err) {
        this.log(`relayMux claimHandshake error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return null
  }

  /** Bytes from a peer no port owns: a pairing hello or a handshake a port claims, else null (the phones'). */
  private unownedFrame(from: string, envelope: Uint8Array): boolean {
    const pairing = this.pairingOwner(envelope)
    if (pairing) {
      pairing.handlers.pairing!(from, envelope)
      return true
    }
    const handshake = this.handshakeOwner(from, envelope)
    if (handshake) {
      handshake.handlers.frame(from, envelope)
      return true
    }
    return false
  }

  private route(message: RelayServerMessage): void {
    switch (message.t) {
      case 'frame': {
        const owner = this.ownerOf(message.from)
        if (owner) {
          let bytes: Uint8Array
          try {
            bytes = b64uDecode(message.data)
          } catch {
            return
          }
          if (bytes.length > 0) owner.handlers.frame(message.from, bytes)
          return
        }
        let bytes: Uint8Array | null = null
        try {
          bytes = b64uDecode(message.data)
        } catch {
          // Not ours to judge: the mobile service drops it.
        }
        if (bytes && bytes.length > 0 && this.unownedFrame(message.from, bytes)) return
        break
      }
      case 'peer': {
        const owner = this.ownerOf(message.id)
        if (owner) {
          owner.handlers.peer(message)
          return
        }
        break
      }
      case 'error': {
        if (message.to) {
          const owner = this.ownerOf(message.to)
          if (owner) {
            owner.handlers.error(message)
            return
          }
        } else {
          for (const lease of this.hostLeases) if (lease.wanted) lease.handlers.error(message)
        }
        break
      }
      case 'pushed':
        break
    }
    this.toMobile(message)
  }

  private routeBinary(from: string, envelope: Uint8Array): void {
    const owner = this.ownerOf(from)
    if (owner) {
      owner.handlers.frame(from, envelope)
      return
    }
    if (this.unownedFrame(from, envelope)) return
    // A phone's frame on a binary socket: the mobile service reads JSON frames.
    this.toMobile({ t: 'frame', from, data: b64uEncode(envelope) })
  }

  private toMobile(message: RelayServerMessage): void {
    for (const lease of this.mobileLeases) {
      if (!lease.wanted) continue
      for (const listener of lease.messageListeners) listener(message)
    }
  }
}
