/**
 * DevTool servers as the desktop's windows see them: what main pushes over
 * `servers-state-changed` and answers on `servers-get-state`. The link itself
 * (protocol/SERVER.md) lives in `src/main/host/link/` and `src/main/servers/`.
 */

/**
 * A server's link. `incompatible` means no common protocol version (see `update`).
 * `updating`: the desktop is uploading its server bundle, or the server is
 * restarting into the one it just got.
 */
export type ServerConnectionKind = 'offline' | 'connecting' | 'online' | 'incompatible' | 'updating'

/** What a server build says about itself in its handshake. */
export interface ServerBuildInfo {
  version: string
  commit: string
  builtAt: string
  bundleSha: string
}

/** The machine a server runs on, from its handshake. */
export interface ServerHostInfo {
  /** `process.platform`: `linux` or `darwin`. */
  os: string
  /** `process.arch`: `x64` or `arm64`. */
  arch: string
  hostname: string
  /** The Node version the server runs on. */
  node: string
}

/** A newer bundle the server holds but hasn't switched to, because a tab is working. */
export interface ServerPendingUpdate {
  version: string
  commit: string
  builtAt: string
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
  /** The server staged an update and swaps once no tab is working ("Server update ready · Restart now"). */
  updateReady?: ServerPendingUpdate
  /** While the desktop uploads its bundle: bytes sent so far and the total. */
  upload?: { sent: number; total: number }
  /**
   * The installer (bootstrap) is or was the last one connected: the server is
   * being installed and its service hasn't connected yet. Add server shows
   * "Connected" only once this is gone.
   */
  installing?: boolean
  /** Epoch ms. */
  pairedAt: number
  /** Epoch ms; null until it was seen after pairing. */
  lastSeen: number | null
  /** From its last handshake; null before the first one. */
  build: ServerBuildInfo | null
  /** From its pairing or last handshake; null when the server never said. */
  host: ServerHostInfo | null
}

/** The shared relay socket, as far as servers are concerned. `too-old`: the relay predates servers (no binary frames). */
export type ServersRelayKind = 'idle' | 'connecting' | 'online' | 'offline' | 'too-old'

/** A server invite the desktop minted: the install one-liner for a new server. */
export interface ServerInvite {
  /** `curl -fsSL <base>/install | DEVTOOL_TOKEN=<token> sh`. */
  oneLiner: string
  token: string
  /** Epoch ms; the invite and its relay offer lapse then. */
  expiresAt: number
}

/** The live invite: `waiting` for a server, then `paired` with `serverId` until it lapses or is cancelled. */
export interface ServerInviteState extends ServerInvite {
  status: 'waiting' | 'paired'
  serverId?: string
}

export interface ServersState {
  relay: { kind: ServersRelayKind; error?: string }
  servers: ServerStatus[]
  /** At most one: a new invite (or a phone QR, which shares the relay offer) replaces it. */
  invite: ServerInviteState | null
}

/** A pairing code a server minted for another desktop ("Add another device"). */
export interface ServerDeviceCode {
  code: string
  /** Epoch ms. */
  expiresAt: number
}

export interface ServerRemoveOptions {
  /** Also uninstall the server when it is online (its service and files). */
  uninstall?: boolean
  /** With `uninstall`: keep the server's data dir (its identity, projects and settings). */
  keepData?: boolean
}

/** `servers-update`'s answer: whether this desktop sent its bundle, and why (see update-policy.ts). */
export interface ServerUpdateResult {
  upload: boolean
  reason: 'server-empty' | 'same' | 'desktop-newer' | 'server-newer' | 'no-bundle' | 'source' | 'unknown-age'
}

export const RELAY_TOO_OLD_FOR_SERVERS = 'This relay is too old for servers'

/** Where the install script and the bootstrap are served from; `DEVTOOL_INSTALL_URL` overrides it. */
export const DEFAULT_INSTALL_URL = 'https://devtool.awantech.sk'

/**
 * The command a user pastes on a new server. The token goes in the script's
 * environment, not its arguments, so other users of that machine can't read it
 * from `ps`. A base URL other than the default is passed on too, so the script
 * fetches the bootstrap from the same place.
 */
export function installOneLiner(token: string, baseUrl: string = DEFAULT_INSTALL_URL): string {
  const base = baseUrl.replace(/\/+$/, '')
  const env = base === DEFAULT_INSTALL_URL ? '' : `DEVTOOL_INSTALL_URL=${base} `
  return `curl -fsSL ${base}/install | ${env}DEVTOOL_TOKEN=${token} sh`
}
