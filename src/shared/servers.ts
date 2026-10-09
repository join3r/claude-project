/**
 * DevTool servers as the desktop's windows see them: what main pushes over
 * `servers-state-changed` and answers on `servers-get-state`. The link itself
 * (protocol/SERVER.md) lives in `src/main/host/link/` and `src/main/servers/`.
 */

/** A server's link: `incompatible` means no common protocol version (see `update`). */
export type ServerConnectionKind = 'offline' | 'connecting' | 'online' | 'incompatible'

/** What a server build says about itself in its handshake. */
export interface ServerBuildInfo {
  version: string
  commit: string
  builtAt: string
  bundleSha: string
}

export interface ServerStatus {
  id: string
  name: string
  state: ServerConnectionKind
  /** Why it is offline or incompatible, for the UI. */
  error?: string
  /** `unknown-device`: the server has no pairing for this desktop; `revoked`: the relay pair is gone. */
  problem?: 'unknown-device' | 'revoked' | 'relay-too-old'
  /** With `incompatible`: the side that has to update. */
  update?: 'desktop' | 'server'
  /** Epoch ms. */
  pairedAt: number
  /** Epoch ms; null until it was seen after pairing. */
  lastSeen: number | null
  /** From its last handshake; null before the first one. */
  build: ServerBuildInfo | null
}

/** The shared relay socket, as far as servers are concerned. `too-old`: the relay predates servers (no binary frames). */
export type ServersRelayKind = 'idle' | 'connecting' | 'online' | 'offline' | 'too-old'

export interface ServersState {
  relay: { kind: ServersRelayKind; error?: string }
  servers: ServerStatus[]
}

export const RELAY_TOO_OLD_FOR_SERVERS = 'This relay is too old for servers'
