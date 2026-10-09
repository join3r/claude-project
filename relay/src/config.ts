import { resolve } from 'node:path'
import { DEFAULT_PUSH_GATEWAY, b64uDecode } from '../../protocol/ts/index.ts'
import { parseLogLevel } from './log.ts'
import type { LogLevel } from './log.ts'
import { DEFAULT_APNS_TOPIC } from './push/apns.ts'
import type { RelayLimits } from './relay.ts'

export type PushSenderConfig =
  | { mode: 'apns'; keyFile: string; keyId: string; teamId: string; topic: string }
  | { mode: 'simctl'; device: string; topic: string }
  | { mode: 'log' }

/** §7: this relay is the gateway, forwards to one, or has push off. */
export type PushConfig =
  | { role: 'gateway'; sealKey: Uint8Array; sender: PushSenderConfig }
  | { role: 'forward'; upstream: string }
  | { role: 'off' }

export interface RelayConfig {
  port: number
  host: string
  /** Directory holding relay.db. */
  dataDir: string
  trustProxy: boolean
  logLevel: LogLevel
  push: PushConfig
  /** Limits set in the environment (see LIMIT_ENV); absent when none are. */
  limits?: Partial<RelayLimits>
}

type Env = Record<string, string | undefined>

const APPLE_ID_RE = /^[A-Z0-9]{10}$/

function parseSealKey(value: string): Uint8Array {
  let key: Uint8Array
  try {
    key = b64uDecode(value.trim())
  } catch {
    throw new Error('RELAY_PUSH_SEAL_KEY must be base64url (no padding) of 32 random bytes')
  }
  if (key.length !== 32) throw new Error(`RELAY_PUSH_SEAL_KEY must be 32 bytes, got ${key.length}`)
  return key
}

function parseSender(env: Env): PushSenderConfig {
  const topic = env.RELAY_APNS_TOPIC || DEFAULT_APNS_TOPIC
  const mode = env.RELAY_APNS_MODE || (env.RELAY_APNS_KEY_FILE ? 'apns' : '')
  switch (mode) {
    case 'apns': {
      const keyFile = env.RELAY_APNS_KEY_FILE
      const keyId = env.RELAY_APNS_KEY_ID ?? ''
      const teamId = env.RELAY_APNS_TEAM_ID ?? ''
      if (!keyFile) throw new Error('RELAY_APNS_MODE=apns needs RELAY_APNS_KEY_FILE (the .p8 auth key from Apple)')
      if (!APPLE_ID_RE.test(keyId)) throw new Error('RELAY_APNS_KEY_ID must be the 10-character key ID of the .p8 key')
      if (!APPLE_ID_RE.test(teamId)) throw new Error('RELAY_APNS_TEAM_ID must be the 10-character Apple team ID')
      return { mode: 'apns', keyFile: resolve(keyFile), keyId, teamId, topic }
    }
    case 'simctl':
      return { mode: 'simctl', device: env.RELAY_SIMCTL_DEVICE || 'booted', topic }
    case 'log':
      return { mode: 'log' }
    case '':
      throw new Error('RELAY_PUSH_SEAL_KEY is set, so this relay is a push gateway: set RELAY_APNS_KEY_FILE (with RELAY_APNS_KEY_ID and RELAY_APNS_TEAM_ID), or RELAY_APNS_MODE=simctl or log')
    default:
      throw new Error(`RELAY_APNS_MODE must be apns, simctl or log, got ${mode}`)
  }
}

function parseUpstream(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`RELAY_PUSH_UPSTREAM must be an http(s) URL, got ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`RELAY_PUSH_UPSTREAM must be an http(s) URL, got ${value}`)
  return value.replace(/\/+$/, '')
}

export function parsePushConfig(env: Env): PushConfig {
  if (env.RELAY_PUSH_SEAL_KEY) return { role: 'gateway', sealKey: parseSealKey(env.RELAY_PUSH_SEAL_KEY), sender: parseSender(env) }
  if (env.RELAY_APNS_MODE || env.RELAY_APNS_KEY_FILE) {
    throw new Error('RELAY_APNS_MODE / RELAY_APNS_KEY_FILE need RELAY_PUSH_SEAL_KEY (32 random bytes, base64url) to run a push gateway')
  }
  const upstream = env.RELAY_PUSH_UPSTREAM === undefined ? DEFAULT_PUSH_GATEWAY : env.RELAY_PUSH_UPSTREAM.trim()
  if (upstream === '') return { role: 'off' }
  return { role: 'forward', upstream: parseUpstream(upstream) }
}

/** Limits an operator may set, by environment variable. Sizes take a K, M or G suffix (×1024). */
export const LIMIT_ENV = {
  RELAY_HOST_BYTES_PER_SECOND: { key: 'hostBytesPerSecond', size: true },
  RELAY_HOST_BYTES_BURST: { key: 'hostBytesBurst', size: true },
  RELAY_IP_BYTES_PER_SECOND: { key: 'ipBytesPerSecond', size: true },
  RELAY_IP_BYTES_BURST: { key: 'ipBytesBurst', size: true },
  RELAY_MAX_QUEUED_BYTES: { key: 'maxQueuedBytes', size: true },
  RELAY_MAX_CONNECTIONS_PER_IP: { key: 'maxConnectionsPerIp', size: false },
  RELAY_NEW_PAIRS_PER_IP_PER_HOUR: { key: 'newPairsPerIpPerHour', size: false },
  RELAY_STALL_TIMEOUT_MS: { key: 'stallTimeoutMs', size: false }
} as const satisfies Record<string, { key: keyof RelayLimits; size: boolean }>

const SIZE_RE = /^(\d+)([kmg])?$/i
const SIZE_UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

export function parseLimits(env: Env): Partial<RelayLimits> {
  const limits: Partial<RelayLimits> = {}
  for (const [name, { key, size }] of Object.entries(LIMIT_ENV)) {
    const raw = env[name]?.trim()
    if (!raw) continue
    const match = (size ? SIZE_RE : /^(\d+)()$/).exec(raw)
    const value = match ? Number(match[1]) * (match[2] ? SIZE_UNITS[match[2].toLowerCase()] : 1) : NaN
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive whole number${size ? ' of bytes (K, M or G suffix allowed)' : ''}, got ${raw}`)
    }
    limits[key] = value
  }
  return limits
}

/**
 * Reads PORT, HOST, RELAY_DATA, RELAY_TRUST_PROXY, LOG_LEVEL, the push settings
 * (RELAY_PUSH_SEAL_KEY, RELAY_APNS_*, RELAY_SIMCTL_DEVICE, RELAY_PUSH_UPSTREAM) and the
 * limits in LIMIT_ENV.
 */
export function loadConfig(env: Env = process.env): RelayConfig {
  const port = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env.PORT}`)
  const limits = parseLimits(env)
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: resolve(env.RELAY_DATA || './data'),
    trustProxy: env.RELAY_TRUST_PROXY === '1' || env.RELAY_TRUST_PROXY === 'true',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    push: parsePushConfig(env),
    ...(Object.keys(limits).length > 0 ? { limits } : {})
  }
}
