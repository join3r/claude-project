import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildVectors, VECTORS_DIR } from './generate-vectors.ts'
import { b64uDecode, b64uEncode, hexDecode, hexEncode } from './encoding.ts'
import { derivePairProof, deriveRelayToken, tokenHash } from './derive.ts'
import { deviceId, ed25519FromPrivate, ed25519Sign, x25519Dh, x25519FromPrivate } from './keys.ts'
import { createInitiator, createResponder } from './noise.ts'
import { parseClientMessage, relayAuthPayload, verifyHello } from './relay-messages.ts'
import type { HelloMessage, Role } from './relay-messages.ts'
import { decodePairingUri, encodePairingUri } from './pairing-uri.ts'
import type { PairingPayload } from './pairing-uri.ts'
import { negotiateVersion, parseAppMessage, parseDesktopHello, parseInbox, parsePhoneHello } from './app-messages.ts'
import type { VersionInfo } from './app-messages.ts'
import { Reassembler, fragmentMessage } from './fragments.ts'
import { parseChatNewParams, parseChatNewResult, parseChatParams, parseChatResult, parseTaskNewParams, parseTaskNewResult } from './chat-messages.ts'

/**
 * Two jobs: the committed vectors must be exactly what the generator produces today,
 * and they must be consumable the way the Swift side will consume them (from the JSON
 * alone, not from the generator's in-memory state).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(name: string): any {
  return JSON.parse(readFileSync(VECTORS_DIR + name, 'utf8'))
}

describe('generated vectors', () => {
  it('regenerate byte-for-byte identical to the committed files', () => {
    for (const [name, content] of Object.entries(buildVectors())) {
      expect(readFileSync(VECTORS_DIR + name, 'utf8'), `${name} is stale: run node protocol/ts/generate-vectors.ts`).toBe(content)
    }
  })

  it('noise-ik.json replays from the JSON alone', () => {
    const file = load('noise-ik.json')
    expect(file.vectors.length).toBeGreaterThan(0)
    for (const v of file.vectors) {
      const phoneStatic = x25519FromPrivate(hexDecode(v.phone.static.priv))
      const desktopStatic = x25519FromPrivate(hexDecode(v.desktop.static.priv))
      expect(hexEncode(phoneStatic.pub)).toBe(v.phone.static.pub)
      expect(hexEncode(desktopStatic.pub)).toBe(v.desktop.static.pub)
      const initiator = createInitiator({
        prologue: hexDecode(v.prologue),
        s: phoneStatic,
        e: x25519FromPrivate(hexDecode(v.phone.ephemeral.priv)),
        rs: desktopStatic.pub
      })
      const responder = createResponder({
        prologue: hexDecode(v.prologue),
        s: desktopStatic,
        e: x25519FromPrivate(hexDecode(v.desktop.ephemeral.priv))
      })
      const m1 = initiator.writeMessage(hexDecode(v.msg1.payload))
      expect(hexEncode(m1)).toBe(v.msg1.ciphertext)
      expect(hexEncode(responder.readMessage(m1))).toBe(v.msg1.payload)
      const m2 = responder.writeMessage(hexDecode(v.msg2.payload))
      expect(hexEncode(m2)).toBe(v.msg2.ciphertext)
      expect(hexEncode(initiator.readMessage(m2))).toBe(v.msg2.payload)
      expect(hexEncode(responder.handshakeHash)).toBe(v.handshakeHash)
      const phone = initiator.split()
      const desktop = responder.split()
      for (const m of v.transport) {
        const [send, recv] = m.from === 'phone' ? [phone, desktop] : [desktop, phone]
        expect(hexEncode(send.encrypt(hexDecode(m.payload)))).toBe(m.ciphertext)
        expect(hexEncode(recv.decrypt(hexDecode(m.ciphertext)))).toBe(m.payload)
      }
    }
  })

  it('derive.json', () => {
    const file = load('derive.json')
    for (const s of file.secrets) {
      const secret = hexDecode(s.secret)
      expect(hexEncode(deriveRelayToken(secret))).toBe(s.relayToken)
      expect(hexEncode(derivePairProof(secret))).toBe(s.pairProof)
      expect(hexEncode(tokenHash(hexDecode(s.relayToken)))).toBe(s.tokenHash)
      expect(b64uEncode(hexDecode(s.tokenHash))).toBe(s.tokenHashB64u)
    }
    for (const d of file.deviceIds) {
      expect(hexEncode(ed25519FromPrivate(hexDecode(d.seed)).pub)).toBe(d.pub)
      expect(deviceId(hexDecode(d.pub))).toBe(d.deviceId)
    }
    for (const k of file.x25519) expect(hexEncode(x25519FromPrivate(hexDecode(k.priv)).pub)).toBe(k.pub)
    for (const k of file.x25519Dh) expect(hexEncode(x25519Dh(hexDecode(k.priv), hexDecode(k.pub)))).toBe(k.shared)
  })

  it('relay-auth.json', () => {
    for (const v of load('relay-auth.json').vectors) {
      const payload = relayAuthPayload(v.role as Role, v.nonce)
      expect(hexEncode(payload)).toBe(v.payload)
      expect(hexEncode(ed25519Sign(hexDecode(v.ed25519.seed), payload))).toBe(v.sig)
      const hello = parseClientMessage(v.hello) as HelloMessage
      expect(verifyHello(hello, v.nonce)).toBe(v.ed25519.deviceId)
      expect(hexEncode(b64uDecode(hello.sig))).toBe(v.sig)
    }
  })

  it('pairing-uri.json', () => {
    const file = load('pairing-uri.json')
    for (const v of file.valid) {
      expect(decodePairingUri(v.uri)).toEqual(v.payload)
      if (!v.note) expect(encodePairingUri(v.payload as PairingPayload)).toBe(v.uri)
    }
    for (const v of file.invalid) expect(() => decodePairingUri(v.uri), v.reason).toThrow()
  })

  it('app-messages.json', () => {
    const file = load('app-messages.json')
    for (const s of file.phoneHello) expect(parsePhoneHello(s.json)).toEqual(s.expected)
    for (const s of file.desktopHello) expect(parseDesktopHello(s.json)).toEqual(s.expected)
    for (const s of file.appMessages) expect(parseAppMessage(s.json)).toEqual(s.expected)
    expect(parseInbox(JSON.parse(file.inboxWithUnknownFields.json))).toEqual(file.inboxWithUnknownFields.expected)
    for (const s of file.invalid.phoneHello) expect(() => parsePhoneHello(s)).toThrow()
    for (const s of file.invalid.desktopHello) expect(() => parseDesktopHello(s)).toThrow()
    for (const s of file.invalid.appMessages) expect(() => parseAppMessage(s)).toThrow()
    for (const n of file.versionNegotiation) {
      expect(negotiateVersion(n.local as VersionInfo, n.remote as VersionInfo)).toEqual(n.result)
    }
  })
})

describe('M2 vectors', () => {
  it('fragments.json splits and reassembles from the JSON alone', () => {
    const file = load('fragments.json')
    const message = hexDecode(file.message.hex)
    expect(message.length).toBe(file.message.length)
    expect(createHash('sha256').update(message).digest('hex')).toBe(file.message.sha256)
    expect(fragmentMessage(message, file.message.id).map(hexEncode)).toEqual(file.message.fragments)
    const r = new Reassembler()
    const outs = file.message.fragments.map((f: string) => r.push(hexDecode(f)))
    expect(outs.slice(0, -1).every((o: unknown) => o === null)).toBe(true)
    expect(hexEncode(outs.at(-1))).toBe(file.message.hex)
    // The boundary splits a UTF-8 character, so chunks can't be decoded on their own.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(hexDecode(file.message.fragments[0]).subarray(9))).toThrow()
    for (const scenario of file.scenarios) {
      const replay = new Reassembler()
      for (const step of scenario.steps) {
        if (step.reset) {
          replay.reset()
          continue
        }
        const out = replay.push(hexDecode(step.input))
        expect(out === null ? null : hexEncode(out), scenario.name).toBe(step.output)
      }
    }
  })

  it('chat-messages.json', () => {
    const file = load('chat-messages.json')
    for (const s of [...file.requests, ...file.events]) expect(parseAppMessage(s.json), s.json).toEqual(s.expected)
    for (const s of file.params) expect(parseChatParams(s.op, JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.results) expect(parseChatResult(s.op, JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.invalid.params) expect(() => parseChatParams(s.op, JSON.parse(s.json)), s.json).toThrow()
    for (const s of file.invalid.results) expect(() => parseChatResult(s.op, JSON.parse(s.json)), s.json).toThrow()
    for (const s of file.invalid.events) expect(() => parseAppMessage(s), s).toThrow()
    for (const s of file.new.params) expect(parseChatNewParams(JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.new.results) expect(parseChatNewResult(JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.new.invalid.params) expect(() => parseChatNewParams(JSON.parse(s)), s).toThrow()
    for (const s of file.new.invalid.results) expect(() => parseChatNewResult(JSON.parse(s)), s).toThrow()
    for (const s of file.taskNew.params) expect(parseTaskNewParams(JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.taskNew.results) expect(parseTaskNewResult(JSON.parse(s.json)), s.json).toEqual(s.expected)
    for (const s of file.taskNew.invalid.params) expect(() => parseTaskNewParams(JSON.parse(s)), s).toThrow()
    for (const s of file.taskNew.invalid.results) expect(() => parseTaskNewResult(JSON.parse(s)), s).toThrow()
  })
})
