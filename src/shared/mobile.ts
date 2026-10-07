/**
 * Settings → Mobile: the persisted config and the state main broadcasts to every
 * window over `mobile-state-changed`. The wire protocol with the phone lives in
 * `protocol/` and `src/main/mobile/`; nothing here crosses the relay.
 */

export const DEFAULT_MOBILE_RELAY_URL = 'wss://relay.devtool.awantech.sk'

export interface MobileConfig {
  /** Off by default: nothing connects to a relay until Mobile is turned on or a pairing starts. */
  enabled: boolean
  /** Relay base URL (`ws://` or `wss://`); the client appends `/v1`. */
  relayUrl: string
  /** Shown on the phone. Empty or absent uses the host name. */
  desktopName?: string
}

export const DEFAULT_MOBILE_CONFIG: MobileConfig = {
  enabled: false,
  relayUrl: DEFAULT_MOBILE_RELAY_URL
}

const RELAY_URL_MAX = 2048

/** A relay URL main will connect to: `ws://` or `wss://`, with a host and no credentials. */
export function isValidRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RELAY_URL_MAX) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false
  if (!parsed.hostname) return false
  if (parsed.username || parsed.password) return false
  return true
}

export const UNENCRYPTED_RELAY_WARNING =
  'Unencrypted relay: connection metadata is visible on the network (messages stay end-to-end encrypted).'

/**
 * A `ws://` relay that isn't on this machine. The channel is still Noise-encrypted,
 * but who talks to whom and when travels in the clear, so Settings warns about it.
 */
export function isUnencryptedRemoteRelay(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'ws:') return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host))
}

/** Trim and drop a trailing slash so `…/v1` can be appended without doubling it. */
export function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** Whatever config.json holds (or nothing) → a usable MobileConfig. */
export function normalizeMobileConfig(raw: unknown): MobileConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_MOBILE_CONFIG }
  const record = raw as Record<string, unknown>
  const relayCandidate = typeof record.relayUrl === 'string' ? normalizeRelayUrl(record.relayUrl) : ''
  const config: MobileConfig = {
    enabled: record.enabled === true,
    relayUrl: isValidRelayUrl(relayCandidate) ? relayCandidate : DEFAULT_MOBILE_RELAY_URL
  }
  if (typeof record.desktopName === 'string' && record.desktopName.trim()) {
    config.desktopName = record.desktopName.trim().slice(0, 100)
  }
  return config
}

/**
 * The relay connection as Settings shows it. `offline` carries the reason when
 * there is one (unreachable, auth refused, not wired yet).
 */
export type MobileConnectionState =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'offline'; error?: string }

/** A phone that proved the QR code's secret and is waiting for Accept / Reject. */
export interface MobilePendingRequest {
  phoneId: string
  name: string
  receivedAt: number
  /**
   * Whether the phone is connected right now. A request survives the phone dropping
   * off until the pairing window (the offer's `exp`) closes, since it comes back and
   * re-handshakes with the same proof.
   */
  online: boolean
}

/** The side that has to update before a phone and this desktop can talk (SPEC.md §4.3). */
export type MobileUpdateSide = 'phone' | 'desktop'

/** A phone whose last handshake was refused for its protocol version. */
export interface MobileIncompatiblePhone {
  name: string
  update: MobileUpdateSide
  /** Epoch ms. */
  at: number
}

export interface MobilePairedDevice {
  id: string
  name: string
  pairedAt: number
  /** Epoch ms; null before the phone was ever seen after pairing. */
  lastSeen: number | null
  online: boolean
  /** The phone registered for push notifications (SPEC.md §7.4). */
  push: boolean
  /** Its last handshake was refused for its protocol version: who has to update. */
  outdated?: MobileUpdateSide
}

/** A live QR code. `exp` is unix **seconds**, as in the pairing URI. */
export interface MobilePairingInvite {
  uri: string
  exp: number
}

export interface MobileState {
  enabled: boolean
  relayUrl: string
  desktopName: string
  connection: MobileConnectionState
  invite: MobilePairingInvite | null
  pending: MobilePendingRequest | null
  devices: MobilePairedDevice[]
  /** The latest unpaired phone refused for its protocol version (a pairing attempt from an old app). */
  incompatible?: MobileIncompatiblePhone
}
