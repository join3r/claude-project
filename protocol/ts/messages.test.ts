import { describe, expect, it } from 'vitest'
import { b64uEncode, utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, generateEd25519, generateX25519 } from './keys.ts'
import {
  buildHello, encodeRelayMessage, parseClientMessage, parseRelayMessage, parseServerMessage, relayAuthPayload, verifyHello
} from './relay-messages.ts'
import { decodePairingUri, encodePairingUri, isPairingExpired, PAIRING_URI_PREFIX } from './pairing-uri.ts'
import type { PairingPayload } from './pairing-uri.ts'
import { encodeJson, negotiateVersion, parseAppMessage, parseHelloVersion, parseInbox, parsePhoneHello } from './app-messages.ts'

const ID = 'a'.repeat(32)
const K32 = b64uEncode(new Uint8Array(32).fill(1))
const S64 = b64uEncode(new Uint8Array(64).fill(2))

describe('relay messages', () => {
  it('parses every client message and drops unknown fields', () => {
    const cases: [unknown, unknown][] = [
      [{ t: 'hello', role: 'desktop', pub: K32, sig: S64, extra: 1 }, { t: 'hello', role: 'desktop', pub: K32, sig: S64 }],
      [
        { t: 'hello', role: 'phone', pub: K32, sig: S64, pair: { to: ID, token: K32, x: 1 } },
        { t: 'hello', role: 'phone', pub: K32, sig: S64, pair: { to: ID, token: K32 } }
      ],
      [{ t: 'offer', tokenHash: K32, exp: 1790000300 }, { t: 'offer', tokenHash: K32, exp: 1790000300 }],
      [{ t: 'authorize', phone: ID, pub: K32 }, { t: 'authorize', phone: ID, pub: K32 }],
      [{ t: 'revoke', phone: ID }, { t: 'revoke', phone: ID }],
      [{ t: 'watch', desktops: [ID] }, { t: 'watch', desktops: [ID] }],
      [{ t: 'frame', to: ID, data: 'AQ' }, { t: 'frame', to: ID, data: 'AQ' }],
      [{ t: 'ping' }, { t: 'ping' }],
      [{ t: 'pong', at: 5 }, { t: 'pong' }]
    ]
    for (const [input, expected] of cases) expect(parseClientMessage(JSON.stringify(input))).toEqual(expected)
  })

  it('parses every server message', () => {
    const cases: [unknown, unknown][] = [
      [{ t: 'challenge', nonce: K32 }, { t: 'challenge', nonce: K32 }],
      [{ t: 'ready', id: ID }, { t: 'ready', id: ID }],
      [{ t: 'frame', from: ID, data: 'AQ' }, { t: 'frame', from: ID, data: 'AQ' }],
      [{ t: 'peer', id: ID, state: 'online' }, { t: 'peer', id: ID, state: 'online' }],
      [{ t: 'peer', id: ID, state: 'offline', lastSeen: 1790000000000 }, { t: 'peer', id: ID, state: 'offline', lastSeen: 1790000000000 }],
      [{ t: 'error', code: 'offline', to: ID }, { t: 'error', code: 'offline', to: ID }],
      [{ t: 'error', code: 'auth', message: 'bad sig' }, { t: 'error', code: 'auth', message: 'bad sig' }]
    ]
    for (const [input, expected] of cases) {
      expect(parseServerMessage(JSON.stringify(input))).toEqual(expected)
      expect(parseRelayMessage(JSON.stringify(input))).toEqual(expected)
    }
    expect(parseRelayMessage(JSON.stringify({ t: 'frame', to: ID, data: 'AQ' }))).toEqual({ t: 'frame', to: ID, data: 'AQ' })
  })

  it('rejects malformed messages', () => {
    const bad: unknown[] = [
      'nope', [1], null, { t: 'teleport' },
      { t: 'hello', role: 'admin', pub: K32, sig: S64 },
      { t: 'hello', role: 'phone', pub: K32, sig: K32 },
      { t: 'hello', role: 'phone', pub: K32, sig: S64, pair: { to: 'x', token: K32 } },
      { t: 'offer', tokenHash: K32, exp: -1 },
      { t: 'offer', tokenHash: K32, exp: 1.5 },
      { t: 'authorize', phone: ID.toUpperCase(), pub: K32 },
      { t: 'watch', desktops: ID },
      { t: 'watch', desktops: [1] },
      { t: 'frame', to: ID, data: '' },
      { t: 'frame', to: ID, data: 'a=' },
      { t: 'frame', to: ID, from: ID, data: 'AQ' }
    ]
    for (const input of bad) {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      expect(() => parseClientMessage(text), text).toThrow(ProtocolError)
    }
    expect(() => parseServerMessage(JSON.stringify({ t: 'hello' }))).toThrow(ProtocolError)
    expect(() => parseServerMessage(JSON.stringify({ t: 'error' }))).toThrow(ProtocolError)
    expect(() => parseServerMessage(JSON.stringify({ t: 'error', code: '' }))).toThrow(ProtocolError)
    expect(() => parseServerMessage(JSON.stringify({ t: 'peer', id: ID, state: 1 }))).toThrow(ProtocolError)
    expect(() => parseServerMessage(JSON.stringify({ t: 'peer', id: 'x', state: 'asleep' }))).toThrow(ProtocolError)
  })

  it('tolerates relay values a newer relay may add', () => {
    // Unknown error code: kept, so the client treats it as a generic error.
    expect(parseServerMessage(JSON.stringify({ t: 'error', code: 'maintenance', to: ID }))).toEqual({ t: 'error', code: 'maintenance', to: ID })
    // Unknown peer state: the message is ignored.
    expect(parseServerMessage(JSON.stringify({ t: 'peer', id: ID, state: 'asleep' }))).toBeNull()
    expect(parseRelayMessage(JSON.stringify({ t: 'peer', id: ID, state: 'asleep' }))).toBeNull()
  })

  it('signs and verifies hello', () => {
    const key = generateEd25519()
    const nonce = b64uEncode(new Uint8Array(32).fill(7))
    const hello = buildHello({ role: 'phone', nonce, ed25519Priv: key.priv, ed25519Pub: key.pub, pair: { to: ID, token: new Uint8Array(32) } })
    const parsed = parseClientMessage(encodeRelayMessage(hello))
    expect(parsed).toEqual(hello)
    expect(verifyHello(hello, nonce)).toBe(deviceId(key.pub))
    expect(verifyHello(hello, b64uEncode(new Uint8Array(32)))).toBeNull()
    expect(verifyHello({ ...hello, role: 'desktop' }, nonce)).toBeNull()
    expect(utf8Decode(relayAuthPayload('phone', nonce))).toBe(`devtool-relay-v1\nphone\n${nonce}`)
  })
})

function payload(): PairingPayload {
  const ed = generateEd25519()
  return {
    v: 1,
    relay: 'ws://localhost:8787',
    id: deviceId(ed.pub),
    x: b64uEncode(generateX25519().pub),
    e: b64uEncode(ed.pub),
    s: K32,
    n: 'host',
    exp: 1790000300
  }
}

describe('pairing URI', () => {
  it('round-trips', () => {
    const p = payload()
    const uri = encodePairingUri(p)
    expect(uri.startsWith(PAIRING_URI_PREFIX)).toBe(true)
    expect(decodePairingUri(uri)).toEqual(p)
    expect(decodePairingUri(`  ${uri}&utm=x\n`)).toEqual(p)
  })

  it('refuses to encode an invalid payload', () => {
    expect(() => encodePairingUri({ ...payload(), id: ID })).toThrow(ProtocolError)
    expect(() => encodePairingUri({ ...payload(), relay: 'http://x' })).toThrow(ProtocolError)
  })

  it('rejects garbage', () => {
    for (const uri of ['', 'devtool://pair', 'devtool://pair?d=', 'devtool://pair?d=AAAA', 'not a url']) {
      expect(() => decodePairingUri(uri), uri).toThrow(ProtocolError)
    }
  })

  it('checks expiry separately', () => {
    expect(isPairingExpired({ exp: 100 }, 99_999)).toBe(false)
    expect(isPairingExpired({ exp: 100 }, 100_000)).toBe(true)
  })
})

describe('app messages', () => {
  it('requires a proof only for pair', () => {
    const base = { v: 1, min: 1, app: 'ios/0.1.0', deviceName: 'd', ed: K32 }
    expect(parsePhoneHello(JSON.stringify({ ...base, kind: 'resume' }))).toEqual({ ...base, kind: 'resume', features: [] })
    expect(() => parsePhoneHello(JSON.stringify({ ...base, kind: 'pair' }))).toThrow(ProtocolError)
    expect(parsePhoneHello(encodeJson({ ...base, features: [], kind: 'pair', proof: K32 })).proof).toBe(K32)
  })

  it('reads the version before anything else', () => {
    expect(parseHelloVersion(utf8Encode('{"v":7,"min":6,"shape":"future"}'))).toEqual({ v: 7, min: 6 })
    expect(() => parseHelloVersion('{"v":1,"min":2}')).toThrow(ProtocolError)
    expect(() => parseHelloVersion('{"v":0,"min":0}')).toThrow(ProtocolError)
  })

  it('negotiates versions', () => {
    expect(negotiateVersion({ v: 2, min: 1 }, { v: 1, min: 1 })).toEqual({ ok: true, version: 1 })
    expect(negotiateVersion({ v: 2, min: 2 }, { v: 1, min: 1 })).toEqual({ ok: false, update: 'remote' })
    expect(negotiateVersion({ v: 1, min: 1 }, { v: 2, min: 2 })).toEqual({ ok: false, update: 'local' })
  })

  it('ignores unknown message types and answers the caller for unknown ops', () => {
    expect(parseAppMessage('{"t":"future"}')).toBeNull()
    expect(parseAppMessage('{"t":"evt","e":"future"}')).toBeNull()
    expect(parseAppMessage('{"t":"req","id":3,"op":"future.op"}')).toEqual({ t: 'req', id: 3, op: 'future.op' })
    expect(parseAppMessage('{"t":"res","id":3,"ok":false,"error":{"code":"x"}}')).toEqual({
      t: 'res', id: 3, ok: false, error: { code: 'x', message: '' }
    })
  })

  it('validates inbox structure', () => {
    const inbox = { desktop: { id: ID, name: 'd' }, generatedAt: 1, projects: [] }
    expect(parseInbox(inbox)).toEqual(inbox)
    expect(() => parseInbox({ ...inbox, projects: [{ id: 'p', name: 'n', tasks: [{ id: 't', name: 'n' }] }] })).toThrow(ProtocolError)
    expect(() => parseInbox({ ...inbox, generatedAt: 'now' })).toThrow(ProtocolError)
    expect(parseInbox({ ...inbox, projects: [{ id: 'p', name: 'n', streams: [], tasks: [] }] }).projects[0].remote).toBe(false)
    // A version 1 project has no streams.
    expect(() => parseInbox({ ...inbox, projects: [{ id: 'p', name: 'n', tasks: [] }] })).toThrow(ProtocolError)
  })
})
