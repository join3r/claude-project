import { ProtocolError, utf8Decode, utf8Encode } from '../../../../protocol/ts/index.ts'
import type { VersionInfo } from '../../../../protocol/ts/index.ts'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from './version'

/** Noise prologue of the desktop↔server link (protocol/SERVER.md §2); never the phones' `devtool-mobile-v1`. */
export const HOST_LINK_PROLOGUE = 'devtool-server-v1'

export type HostLinkApp = 'devtool-desktop' | 'devtool-server'

/** What a build says about itself: the server's comes from manifest.json, the desktop's from its package. */
export interface LinkBuild {
  version: string
  commit: string
  /** ISO time, or empty when unknown (a dev run). */
  builtAt: string
  /** The server bundle's sha256 (manifest.json); empty when there is none. */
  bundleSha: string
}

/** Message 1's payload (desktop) and, with `result`, message 2's (server). */
export interface HostLinkHello extends VersionInfo {
  app: HostLinkApp
  build: LinkBuild
  /** Optional capabilities this side has; none are defined in version 1. */
  features: string[]
  /** A display name: the desktop's host name, or the server's configured name. */
  name: string
}

/**
 * - `ok`: the session is up.
 * - `incompatible`: no common version; the reply's `v`/`min` say which side to update.
 * - `unknown-device`: the server has no pairing for this desktop's keys.
 */
export type HostLinkResult = 'ok' | 'incompatible' | 'unknown-device'

export interface HostLinkReply extends HostLinkHello {
  result: HostLinkResult
}

const RESULTS: readonly string[] = ['ok', 'incompatible', 'unknown-device']
const APPS: readonly string[] = ['devtool-desktop', 'devtool-server']

export function buildHello(app: HostLinkApp, build: LinkBuild, name: string, features: string[] = []): HostLinkHello {
  return { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION, app, build, features, name }
}

export function encodeHandshakePayload(payload: HostLinkHello | HostLinkReply): Uint8Array {
  return utf8Encode(JSON.stringify(payload))
}

type Obj = Record<string, unknown>

function parseObject(bytes: Uint8Array): Obj {
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(bytes))
  } catch (err) {
    throw new ProtocolError('handshake payload is not JSON', { cause: err })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError('handshake payload must be an object')
  return value as Obj
}

function text(o: Obj, key: string, max: number): string {
  const value = o[key]
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * Only `{v, min}`: read first, so a peer whose payload has a future shape still
 * gets a clean `incompatible` (as phones do, SPEC.md §4.3).
 */
export function parseHandshakeVersion(bytes: Uint8Array): VersionInfo {
  const o = parseObject(bytes)
  const { v, min } = o
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ProtocolError('v must be a positive integer')
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > v) throw new ProtocolError('min must be an integer from 1 to v')
  return { v, min }
}

export function parseHello(bytes: Uint8Array): HostLinkHello {
  const o = parseObject(bytes)
  const version = parseHandshakeVersion(bytes)
  const app = o.app
  if (typeof app !== 'string' || !APPS.includes(app)) throw new ProtocolError('app must be devtool-desktop or devtool-server')
  const build = typeof o.build === 'object' && o.build !== null ? (o.build as Obj) : {}
  return {
    ...version,
    app: app as HostLinkApp,
    build: {
      version: text(build, 'version', 64),
      commit: text(build, 'commit', 64),
      builtAt: text(build, 'builtAt', 64),
      bundleSha: text(build, 'bundleSha', 128)
    },
    features: Array.isArray(o.features) ? o.features.filter((f): f is string => typeof f === 'string').slice(0, 64) : [],
    name: text(o, 'name', 100)
  }
}

export function parseReply(bytes: Uint8Array): HostLinkReply {
  const o = parseObject(bytes)
  const result = o.result
  if (typeof result !== 'string' || !RESULTS.includes(result)) throw new ProtocolError('result has an unknown value')
  // An `incompatible` reply may come from a version whose hello has another shape.
  if (result === 'incompatible') {
    let version: VersionInfo
    try {
      version = parseHandshakeVersion(bytes)
    } catch {
      version = { v: 0, min: 0 }
    }
    return { ...version, app: 'devtool-server', build: { version: text((o.build ?? {}) as Obj, 'version', 64), commit: '', builtAt: '', bundleSha: '' }, features: [], name: text(o, 'name', 100), result }
  }
  return { ...parseHello(bytes), result: result as HostLinkResult }
}
