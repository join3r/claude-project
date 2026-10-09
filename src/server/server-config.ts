import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from '../main/storage'
import { DEFAULT_MOBILE_RELAY_URL, isValidRelayUrl, normalizeRelayUrl } from '../shared/mobile'

/** `<data>/server.json`: what the server needs before any desktop talks to it. */
export interface ServerConfig {
  /** The relay it connects to (`ws://` or `wss://`, without `/v1`). */
  relayUrl: string
  /** Shown on desktops; empty uses the host name. */
  name: string
}

const FILE = 'server.json'

export function loadServerConfig(dataDir: string): ServerConfig {
  let raw: Partial<ServerConfig> = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as Partial<ServerConfig>
  } catch {
    // None yet (or unreadable): the defaults.
  }
  return {
    relayUrl: isValidRelayUrl(raw.relayUrl) ? normalizeRelayUrl(raw.relayUrl) : DEFAULT_MOBILE_RELAY_URL,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 100) : ''
  }
}

export function saveServerConfig(dataDir: string, patch: Partial<ServerConfig>): ServerConfig {
  const next = { ...loadServerConfig(dataDir), ...patch }
  if (!isValidRelayUrl(next.relayUrl)) throw new Error(`Not a relay URL: ${next.relayUrl}`)
  next.relayUrl = normalizeRelayUrl(next.relayUrl)
  atomicWriteFileSync(path.join(dataDir, FILE), JSON.stringify(next, null, 2) + '\n', 0o600)
  return next
}

/** The name desktops see: the configured one, else the host name. */
export function serverDisplayName(config: ServerConfig): string {
  return config.name || os.hostname().replace(/\.local$/, '')
}
