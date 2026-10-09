import { describe, expect, it } from 'vitest'
import { b64uEncode, hexEncode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { generateEd25519 } from './keys.ts'
import {
  RELAY_BINARY_ID_BYTES,
  UnsupportedMessageError,
  buildHello,
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
  encodeRelayMessage,
  pairTarget,
  parseClientMessage,
  parseRelayMessage,
  parseServerMessage,
  verifyHello
} from './relay-messages.ts'
import type { AuthorizeMessage, RevokeMessage } from './relay-messages.ts'

/** SPEC.md §3.8–§3.11: the server role, `pair`, generalized authorize/revoke, binary frames. */

const ID = 'a'.repeat(32)
const ID2 = 'b'.repeat(32)
const K32 = b64uEncode(new Uint8Array(32).fill(1))
const S64 = b64uEncode(new Uint8Array(64).fill(2))
const parse = (value: unknown) => parseClientMessage(JSON.stringify(value))

describe('server role messages', () => {
  it('parses a server hello and keeps binary only when true', () => {
    expect(parse({ t: 'hello', role: 'server', pub: K32, sig: S64, binary: true })).toEqual({ t: 'hello', role: 'server', pub: K32, sig: S64, binary: true })
    expect(parse({ t: 'hello', role: 'desktop', pub: K32, sig: S64, binary: false })).toEqual({ t: 'hello', role: 'desktop', pub: K32, sig: S64 })
    expect(parse({ t: 'hello', role: 'server', pub: K32, sig: S64, pair: { to: ID, token: K32 } })).toEqual({
      t: 'hello', role: 'server', pub: K32, sig: S64, pair: { to: ID, token: K32 }
    })
    expect(() => parse({ t: 'hello', role: 'server', pub: K32, sig: S64, binary: 'yes' })).toThrow(ProtocolError)
  })

  it('builds and verifies a server hello, with binary', () => {
    const key = generateEd25519()
    const nonce = b64uEncode(new Uint8Array(32).fill(9))
    const hello = buildHello({ role: 'server', nonce, ed25519Priv: key.priv, ed25519Pub: key.pub, binary: true })
    expect(hello).toMatchObject({ role: 'server', binary: true })
    const parsed = parseClientMessage(encodeRelayMessage(hello))
    expect(parsed.t === 'hello' && verifyHello(parsed, nonce)).toMatch(/^[0-9a-f]{32}$/)
    expect(verifyHello({ ...hello, role: 'desktop' }, nonce)).toBeNull()
    expect(buildHello({ role: 'desktop', nonce, ed25519Priv: key.priv, ed25519Pub: key.pub, binary: false })).not.toHaveProperty('binary')
  })

  it('parses ready with binary, pair, and authorize/revoke with peer or phone', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'ready', id: ID, binary: true }))).toEqual({ t: 'ready', id: ID, binary: true })
    expect(parseServerMessage(JSON.stringify({ t: 'ready', id: ID, binary: false }))).toEqual({ t: 'ready', id: ID })
    expect(parse({ t: 'pair', to: ID, token: K32, x: 1 })).toEqual({ t: 'pair', to: ID, token: K32 })
    expect(parseRelayMessage(JSON.stringify({ t: 'pair', to: ID, token: K32 }))).toEqual({ t: 'pair', to: ID, token: K32 })
    expect(() => parse({ t: 'pair', to: ID, token: S64 })).toThrow(ProtocolError)
    expect(() => parse({ t: 'pair', to: 'x', token: K32 })).toThrow(ProtocolError)

    const byPeer = parse({ t: 'authorize', peer: ID, pub: K32 }) as AuthorizeMessage
    const byPhone = parse({ t: 'authorize', phone: ID2, pub: K32 }) as AuthorizeMessage
    expect(byPeer).toEqual({ t: 'authorize', peer: ID, pub: K32 })
    expect(byPhone).toEqual({ t: 'authorize', phone: ID2, pub: K32 })
    expect([pairTarget(byPeer), pairTarget(byPhone)]).toEqual([ID, ID2])
    const revoke = parse({ t: 'revoke', peer: ID }) as RevokeMessage
    expect(revoke).toEqual({ t: 'revoke', peer: ID })
    expect(pairTarget(revoke)).toBe(ID)
    expect(() => parse({ t: 'authorize', peer: ID, phone: ID, pub: K32 })).toThrow(ProtocolError)
    expect(() => parse({ t: 'revoke' })).toThrow(ProtocolError)
    expect(parseServerMessage(JSON.stringify({ t: 'error', code: 'unsupported', message: 'unknown client message type' }))).toEqual({
      t: 'error', code: 'unsupported', message: 'unknown client message type'
    })
  })

  it('throws UnsupportedMessageError for an unknown type or role, ProtocolError for the rest', () => {
    const unknownType = (() => { try { parse({ t: 'teleport' }) } catch (err) { return err } })()
    expect(unknownType).toBeInstanceOf(UnsupportedMessageError)
    expect(unknownType).toBeInstanceOf(ProtocolError)
    expect((unknownType as UnsupportedMessageError).role).toBeUndefined()
    const unknownRole = (() => { try { parse({ t: 'hello', role: 'toaster', pub: K32, sig: S64 }) } catch (err) { return err } })()
    expect(unknownRole).toBeInstanceOf(UnsupportedMessageError)
    expect((unknownRole as UnsupportedMessageError).role).toBe('toaster')
    const malformed = (() => { try { parse({ t: 'hello', role: 7, pub: K32, sig: S64 }) } catch (err) { return err } })()
    expect(malformed).toBeInstanceOf(ProtocolError)
    expect(malformed).not.toBeInstanceOf(UnsupportedMessageError)
  })
})

describe('binary relay frames', () => {
  it('round-trips [16-byte id][envelope]', () => {
    const envelope = new Uint8Array([3, 1, 2, 3])
    const frame = encodeRelayBinaryFrame(ID, envelope)
    expect(frame.length).toBe(RELAY_BINARY_ID_BYTES + envelope.length)
    expect(hexEncode(frame.subarray(0, 16))).toBe(ID)
    expect(decodeRelayBinaryFrame(frame)).toEqual({ peer: ID, envelope })
  })

  it('refuses a bad id, an empty envelope and a short frame', () => {
    expect(() => encodeRelayBinaryFrame('A'.repeat(32), new Uint8Array([1]))).toThrow(ProtocolError)
    expect(() => encodeRelayBinaryFrame(ID, new Uint8Array(0))).toThrow(ProtocolError)
    expect(() => decodeRelayBinaryFrame(new Uint8Array(16))).toThrow(ProtocolError)
    expect(() => decodeRelayBinaryFrame(new Uint8Array(3))).toThrow(ProtocolError)
  })
})
