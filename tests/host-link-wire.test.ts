import { describe, expect, it } from 'vitest'
import { FrameKind, ProtocolError, Reassembler, createInitiator, createResponder, encodeEnvelope, generateX25519, utf8Encode } from '../protocol/ts/index.ts'
import { LinkError } from '../src/main/host/link/errors'
import { buildHello, parseHello, parseReply, encodeHandshakePayload, HOST_LINK_PROLOGUE } from '../src/main/host/link/handshake'
import { LinkInitiator, answerHandshake } from '../src/main/host/link/secure'
import { LINK_MAX_MESSAGE, LinkMessageType, decodeLinkMessage, decodeValue, encodeLinkMessage, encodeValue, isLinkMessageByte, type LinkMessage } from '../src/main/host/link/wire'
import { decodeDevKeys, decodeDevPairCode, encodeDevKeys, encodeDevPairCode } from '../src/main/host/link/dev-pair'
import { b64uEncode, deviceId, generateEd25519 } from '../protocol/ts/index.ts'

const build = { version: '0.6.0', commit: 'abc', builtAt: '2026-10-09T00:00:00Z', bundleSha: 'f00' }

describe('host link wire format', () => {
  it('round-trips every message type', () => {
    const messages: LinkMessage[] = [
      { type: 'call', id: 7, client: 'win:1', ch: 'pty-spawn', args: ['tab', '/bin/sh', 80, { a: 1 }], focused: true },
      { type: 'call', id: 8, client: 'win:2', ch: 'load-config', args: [] },
      { type: 'result', id: 7, ok: true, value: { scrollback: 'x', exitCode: null } },
      { type: 'result', id: 9, ok: true, value: undefined },
      { type: 'result', id: 8, ok: false, error: { code: 'remote-error', message: 'boom' } },
      { type: 'event', client: '*', ch: 'projects-updated', args: [{ revision: 3 }] },
      { type: 'event', client: 'win:1', ch: 'pty-data', args: ['tab', '\u001b[31mred\u001b[0m 😀\r\n'] },
      { type: 'detach', client: 'win:1' },
      { type: 'open', sid: 1, kind: 'sink', params: { delayMs: 3 } },
      { type: 'data', sid: 1, bytes: new Uint8Array([1, 2, 3, 0, 255]) },
      { type: 'credit', sid: 1, n: 65536 },
      { type: 'close', sid: 1, reason: 'end' },
      { type: 'close', sid: 3, reason: 'refused', message: 'unknown stream kind x' }
    ]
    for (const message of messages) {
      const bytes = encodeLinkMessage(message)
      expect(isLinkMessageByte(bytes[0])).toBe(true)
      const decoded = decodeLinkMessage(bytes)
      if (message.type === 'data') {
        expect(decoded).toMatchObject({ type: 'data', sid: 1 })
        expect([...(decoded as { bytes: Uint8Array }).bytes]).toEqual([1, 2, 3, 0, 255])
      } else {
        expect(decoded).toEqual(message)
      }
    }
  })

  it('sends a final string argument as raw UTF-8, not escaped JSON', () => {
    const output = '\u001b'.repeat(1000)
    const bytes = encodeLinkMessage({ type: 'event', client: 'win:1', ch: 'pty-data', args: ['tab', output] })
    // Escaped in JSON each ESC would be 6 bytes (\u001b).
    expect(bytes.length).toBeLessThan(1100)
    expect(bytes[0]).toBe(LinkMessageType.Event)
  })

  it('keeps what structured clone keeps: undefined arguments, bytes, dates, non-finite numbers', () => {
    const args = ['tab', undefined, [1, undefined, 3], new Uint8Array([9, 8]), new Date(1234), NaN, -Infinity, { gone: undefined, kept: null }]
    const decoded = decodeValue(encodeValue(args)) as unknown[]
    expect(decoded).toHaveLength(8)
    expect(decoded[1]).toBeUndefined()
    expect([...(decoded[2] as unknown[])]).toEqual([1, undefined, 3])
    expect(decoded[3]).toEqual(new Uint8Array([9, 8]))
    expect(decoded[4]).toEqual(new Date(1234))
    expect(decoded[5]).toBeNaN()
    expect(decoded[6]).toBe(-Infinity)
    expect(decoded[7]).toEqual({ kept: null })
    expect(decodeValue(encodeValue(undefined))).toBeUndefined()
    // pty-spawn's trailing optional arguments survive a call.
    const call = decodeLinkMessage(encodeLinkMessage({ type: 'call', id: 1, client: 'win:1', ch: 'pty-spawn', args: ['t', '/bin/sh', '/', 80, 24, ['-c', 'x'], {}, undefined, undefined] }))
    expect(call).toMatchObject({ args: ['t', '/bin/sh', '/', 80, 24, ['-c', 'x'], {}, undefined, undefined] })
    expect((call as { args: unknown[] }).args).toHaveLength(9)
  })

  it('refuses a message over 4 MiB with too-large', () => {
    const big = 'x'.repeat(LINK_MAX_MESSAGE)
    expect(() => encodeLinkMessage({ type: 'result', id: 1, ok: true, value: big })).toThrow(LinkError)
    try {
      encodeLinkMessage({ type: 'result', id: 1, ok: true, value: big })
    } catch (err) {
      expect((err as LinkError).code).toBe('too-large')
    }
    // Just under the limit is fine.
    expect(encodeLinkMessage({ type: 'data', sid: 1, bytes: new Uint8Array(LINK_MAX_MESSAGE - 64) }).length).toBeLessThanOrEqual(LINK_MAX_MESSAGE)
  })

  it('rejects malformed messages with ProtocolError', () => {
    const header = (type: number, json: string, extra = new Uint8Array(0)) => {
      const head = utf8Encode(json)
      const out = new Uint8Array(5 + head.length + extra.length)
      out[0] = type
      new DataView(out.buffer).setUint32(1, head.length)
      out.set(head, 5)
      out.set(extra, 5 + head.length)
      return out
    }
    expect(() => decodeLinkMessage(new Uint8Array([0x10, 0, 0]))).toThrow(ProtocolError)
    expect(() => decodeLinkMessage(header(0x2f, '{}'))).toThrow(/unknown link message type/)
    expect(() => decodeLinkMessage(header(0x10, '{"id":-1,"client":"w","ch":"c","args":[]}'))).toThrow(ProtocolError)
    expect(() => decodeLinkMessage(header(0x10, '{"id":1,"client":"w","ch":"c","args":{}}'))).toThrow(/args/)
    expect(() => decodeLinkMessage(header(0x23, '{"sid":1,"reason":"bye"}'))).toThrow(/reason/)
    expect(() => decodeLinkMessage(header(0x12, 'not json'))).toThrow(/JSON/)
    const truncated = header(0x22, '{"sid":1,"n":5}')
    new DataView(truncated.buffer).setUint32(1, 999)
    expect(() => decodeLinkMessage(truncated)).toThrow(/runs past/)
  })

  it('lets link messages through the reassembler only when asked to', () => {
    const message = encodeLinkMessage({ type: 'credit', sid: 1, n: 5 })
    expect(new Reassembler().push(message)).toBeNull()
    expect(new Reassembler({ isWhole: isLinkMessageByte }).push(message)).toEqual(message)
    // JSON is not a link message.
    expect(new Reassembler({ isWhole: isLinkMessageByte }).push(utf8Encode('{"t":"req"}'))).toBeNull()
  })
})

describe('host link handshake', () => {
  const desktopKey = generateX25519()
  const serverKey = generateX25519()
  const reply = () => ({ ...buildHello('devtool-server', build, 'srv') })

  it('establishes a session for a desktop whose key the server knows', () => {
    const initiator = new LinkInitiator(desktopKey, serverKey.pub, () => {})
    const message1 = initiator.start(buildHello('devtool-desktop', build, 'mac'))
    expect(message1[0]).toBe(FrameKind.Handshake1)
    let seen: Uint8Array | null = null
    const outcome = answerHandshake(serverKey, message1.subarray(1), reply, ({ remoteStatic, hello }) => {
      seen = remoteStatic
      expect(hello).toMatchObject({ app: 'devtool-desktop', name: 'mac', build })
      return 'ok'
    }, () => {})
    expect(seen).toEqual(desktopKey.pub)
    expect(outcome.result).toBe('ok')
    const { reply: parsed, channel } = initiator.finish(outcome.envelope.subarray(1))
    expect(parsed).toMatchObject({ result: 'ok', app: 'devtool-server', name: 'srv', v: 1, min: 1 })
    expect(channel).not.toBeNull()
    // Both ends now speak: a link message one way, a 200 KB one (fragmented) back.
    const ping = encodeLinkMessage({ type: 'detach', client: 'win:1' })
    const envelopes = channel!.seal(ping)
    expect(envelopes).toHaveLength(1)
    expect(outcome.channel!.open(envelopes[0].subarray(1))).toEqual(ping)
    const big = encodeLinkMessage({ type: 'data', sid: 2, bytes: new Uint8Array(200_000).fill(7) })
    const parts = outcome.channel!.seal(big)
    expect(parts.length).toBe(4)
    const opened = parts.map((p) => channel!.open(p.subarray(1)))
    expect(opened.slice(0, 3)).toEqual([null, null, null])
    expect(opened[3]).toEqual(big)
  })

  it('answers unknown-device without a session, and incompatible to a newer desktop', () => {
    const initiator = new LinkInitiator(desktopKey, serverKey.pub, () => {})
    const outcome = answerHandshake(serverKey, initiator.start(buildHello('devtool-desktop', build, 'mac')).subarray(1), reply, () => 'unknown-device', () => {})
    expect(outcome).toMatchObject({ result: 'unknown-device', channel: null })
    expect(initiator.finish(outcome.envelope.subarray(1))).toMatchObject({ reply: { result: 'unknown-device' }, channel: null })

    const future = new LinkInitiator(desktopKey, serverKey.pub, () => {})
    const hello = { ...buildHello('devtool-desktop', build, 'mac'), v: 3, min: 2, shape: 'from the future' }
    const newer = answerHandshake(serverKey, future.start(hello).subarray(1), reply, () => 'ok', () => {})
    expect(newer).toMatchObject({ result: 'incompatible', update: 'server', channel: null })
    expect(future.finish(newer.envelope.subarray(1)).reply).toMatchObject({ result: 'incompatible', v: 1, min: 1 })
  })

  it('uses its own prologue: a phone-style handshake does not read', () => {
    const phoneSide = createInitiator({ prologue: utf8Encode('devtool-mobile-v1'), s: desktopKey, rs: serverKey.pub })
    const message1 = phoneSide.writeMessage(encodeHandshakePayload(buildHello('devtool-desktop', build, 'mac')))
    expect(() => answerHandshake(serverKey, message1, reply, () => 'ok', () => {})).toThrow(ProtocolError)
    // ...while the link's prologue does.
    const right = createInitiator({ prologue: utf8Encode(HOST_LINK_PROLOGUE), s: desktopKey, rs: serverKey.pub })
    expect(answerHandshake(serverKey, right.writeMessage(encodeHandshakePayload(buildHello('devtool-desktop', build, 'mac'))), reply, () => 'ok', () => {}).result).toBe('ok')
    expect(createResponder).toBeTypeOf('function')
    expect(encodeEnvelope(FrameKind.Reset)).toEqual(new Uint8Array([4]))
  })

  it('parses hellos leniently and replies strictly', () => {
    expect(parseHello(utf8Encode(JSON.stringify({ v: 1, min: 1, app: 'devtool-desktop', name: 7 })))).toMatchObject({ name: '', features: [], build: { version: '' } })
    expect(() => parseHello(utf8Encode(JSON.stringify({ v: 1, min: 1, app: 'toaster' })))).toThrow(ProtocolError)
    expect(() => parseReply(utf8Encode(JSON.stringify({ v: 1, min: 1, app: 'devtool-server', result: 'maybe' })))).toThrow(/result/)
  })
})

describe('dev pairing codes', () => {
  it('round-trips keys and codes and checks the id against the key', () => {
    const x = b64uEncode(generateX25519().pub)
    const edKey = generateEd25519()
    const ed = b64uEncode(edKey.pub)
    expect(decodeDevKeys(encodeDevKeys({ x25519Pub: x, ed25519Pub: ed }))).toEqual({ x25519Pub: x, ed25519Pub: ed })
    expect(() => decodeDevKeys('nope')).toThrow()
    const offer = { id: deviceId(edKey.pub), x25519Pub: x, ed25519Pub: ed, name: 'srv', token: b64uEncode(new Uint8Array(32).fill(1)), exp: 123 }
    expect(decodeDevPairCode(encodeDevPairCode(offer))).toEqual(offer)
    expect(() => decodeDevPairCode(encodeDevPairCode({ ...offer, id: 'f'.repeat(32) }))).toThrow(/id/)
  })
})
