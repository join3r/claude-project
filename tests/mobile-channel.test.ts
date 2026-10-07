import { describe, expect, it } from 'vitest'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import type { ChannelHooks, PhoneChannel, VerifiedHello } from '../src/main/mobile/mobile-service'
import {
  FrameKind,
  bytesEqual,
  encodeEnvelope,
  generateX25519,
  utf8Encode
} from '../protocol/ts/index.ts'
import type { AppMessage, HandshakeResult } from '../protocol/ts/index.ts'
import { FakePhone } from './helpers/fake-phone'

function setup(decide: (hello: VerifiedHello) => HandshakeResult = () => 'ok', features?: () => string[]) {
  const desktop = generateX25519()
  const toPhone: Uint8Array[] = []
  const hellos: VerifiedHello[] = []
  const established: HandshakeResult[] = []
  const incompatible: { update: 'phone' | 'desktop'; deviceName?: string }[] = []
  const appMessages: AppMessage[] = []
  let lost = 0
  const hooks: ChannelHooks = {
    sendFrame: (data) => toPhone.push(data),
    onHello: (hello) => { hellos.push(hello); return decide(hello) },
    onIncompatible: (info) => incompatible.push(info),
    onEstablished: (result) => established.push(result),
    onAppMessage: (message) => appMessages.push(message),
    onSessionLost: () => { lost++ }
  }
  const channel: PhoneChannel = createNoiseChannelFactory({
    staticKey: () => desktop,
    app: 'devtool/test',
    desktopName: () => 'test-mbp',
    features,
    log: () => {}
  }).create('phone', hooks)
  const phone = new FakePhone(desktop.pub)
  /** Deliver everything the phone queued, then everything the desktop answered. */
  const pump = () => {
    for (const data of phone.outbox.splice(0)) channel.receive(data)
    for (const data of toPhone.splice(0)) phone.receive(data)
  }
  return { desktop, channel, phone, hooks, toPhone, hellos, established, appMessages, incompatible, lost: () => lost, pump }
}

describe('Noise channel (desktop responder)', () => {
  it('lists its features in the hello (SPEC.md §8.1)', () => {
    const env = setup(() => 'ok', () => ['chat.new'])
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    expect(env.phone.desktopHello).toMatchObject({ features: ['chat.new'], result: 'ok' })
  })

  it('completes a handshake and carries app messages both ways', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    expect(env.hellos).toHaveLength(1)
    expect(env.hellos[0].hello).toMatchObject({ kind: 'resume', deviceName: 'Test iPhone', v: 2, min: 2 })
    expect(bytesEqual(env.hellos[0].remoteStatic, env.phone.x.pub)).toBe(true)
    expect(env.phone.desktopHello).toEqual({ v: 2, min: 2, app: 'devtool/test', features: [], desktopName: 'test-mbp', result: 'ok' })
    expect(env.channel.established).toBe(true)
    expect(env.established).toEqual(['ok'])

    env.phone.request(7, 'inbox.get')
    env.pump()
    expect(env.appMessages).toEqual([{ t: 'req', id: 7, op: 'inbox.get' }])

    expect(env.channel.send({ t: 'evt', e: 'pairing', status: 'accepted' })).toBe(true)
    env.pump()
    expect(env.phone.messages).toEqual([{ t: 'evt', e: 'pairing', status: 'accepted' }])
  })

  it('establishes a session for pending too', () => {
    const env = setup(() => 'pending')
    env.phone.startHandshake(env.phone.hello('pair', new Uint8Array(32)))
    env.pump()
    expect(env.phone.desktopHello?.result).toBe('pending')
    expect(env.channel.established).toBe(true)
    expect(env.hellos[0].hello.proof).toBeDefined()
  })

  it.each(['rejected', 'unknown-device'] as const)('answers %s without keeping a session', (result) => {
    const env = setup(() => result)
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    expect(env.phone.desktopHello?.result).toBe(result)
    expect(env.channel.established).toBe(false)
    expect(env.established).toEqual([])
    expect(env.channel.send({ t: 'evt', e: 'pairing', status: 'accepted' })).toBe(false)
  })

  it('answers incompatible on the version alone, before parsing the rest', () => {
    const env = setup()
    env.phone.startHandshake(utf8Encode(JSON.stringify({ v: 4, min: 3, future: true })))
    env.pump()
    expect(env.phone.desktopHello?.result).toBe('incompatible')
    expect(env.hellos).toHaveLength(0)
    expect(env.channel.established).toBe(false)
    expect(env.incompatible).toEqual([{ update: 'desktop', deviceName: undefined }])
  })

  it('refuses a version 1 phone (the streams cutover) and says the phone has to update', () => {
    const env = setup()
    env.phone.startHandshake({ ...env.phone.hello('resume'), v: 1, min: 1 })
    env.pump()
    expect(env.phone.desktopHello).toMatchObject({ v: 2, min: 2, result: 'incompatible' })
    expect(env.hellos).toHaveLength(0)
    expect(env.incompatible).toEqual([{ update: 'phone', deviceName: 'Test iPhone' }])
  })

  it('answers rejected to a malformed hello payload', () => {
    const env = setup()
    env.phone.startHandshake(utf8Encode(JSON.stringify({ v: 2, min: 2, kind: 'resume' })))
    env.pump()
    expect(env.phone.desktopHello?.result).toBe('rejected')
    expect(env.hellos).toHaveLength(0)
  })

  it('drops an unreadable message 1 silently', () => {
    const env = setup()
    // Encrypted to some other desktop's key: this desktop cannot decrypt it.
    const stranger = new FakePhone(generateX25519().pub)
    env.channel.receive(stranger.startHandshake(stranger.hello('resume')))
    env.channel.receive(encodeEnvelope(FrameKind.Handshake1, new Uint8Array(10)))
    expect(env.toPhone).toEqual([])
    expect(env.hellos).toHaveLength(0)
  })

  it('answers a transport frame without a session with a reset', () => {
    const env = setup()
    env.channel.receive(encodeEnvelope(FrameKind.Transport, new Uint8Array(40)))
    expect(env.toPhone).toEqual([encodeEnvelope(FrameKind.Reset)])
  })

  it('a frame it cannot decrypt ends the session with a reset', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    env.channel.receive(encodeEnvelope(FrameKind.Transport, new Uint8Array(40)))
    expect(env.toPhone.at(-1)).toEqual(encodeEnvelope(FrameKind.Reset))
    expect(env.channel.established).toBe(false)
    expect(env.lost()).toBe(1)
  })

  it('a reset from the phone drops the session', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    env.channel.receive(encodeEnvelope(FrameKind.Reset))
    expect(env.channel.established).toBe(false)
    expect(env.lost()).toBe(1)
    expect(env.toPhone).toEqual([])
  })

  it('a new message 1 replaces the session', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    expect(env.lost()).toBe(1)
    expect(env.established).toEqual(['ok', 'ok'])
    expect(env.channel.send({ t: 'evt', e: 'pairing', status: 'accepted' })).toBe(true)
    env.pump()
    expect(env.phone.messages).toHaveLength(1)
  })

  it('fragments app messages above 60000 bytes and reassembles fragmented reqs (SPEC.md §6.1)', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    const big = { t: 'res', id: 1, ok: true, result: 'é'.repeat(70_000) } as const
    expect(env.channel.send(big)).toBe(true)
    expect(env.toPhone).toHaveLength(3)
    env.pump()
    expect(env.phone.messages).toEqual([big])

    env.phone.request(2, 'chat.send', { tabId: 't', text: 'x'.repeat(65_000) })
    expect(env.phone.outbox).toHaveLength(2)
    env.pump()
    expect(env.appMessages).toEqual([{ t: 'req', id: 2, op: 'chat.send', params: { tabId: 't', text: 'x'.repeat(65_000) } }])
  })

  it('refuses app messages above 4 MiB', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    const huge = { t: 'res', id: 1, ok: true, result: 'x'.repeat(4 * 1024 * 1024) } as const
    expect(env.channel.send(huge)).toBe(false)
    expect(env.toPhone).toEqual([])
  })

  it('answers an unknown envelope kind with a reset and ignores message 2', () => {
    const env = setup()
    env.channel.receive(Uint8Array.of(0x09, 1, 2))
    expect(env.toPhone).toEqual([encodeEnvelope(FrameKind.Reset)])
    env.channel.receive(encodeEnvelope(FrameKind.Handshake2, new Uint8Array(48)))
    expect(env.toPhone).toHaveLength(1)
  })

  it('does nothing once closed', () => {
    const env = setup()
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    env.channel.close()
    expect(env.channel.established).toBe(false)
    expect(env.channel.send({ t: 'evt', e: 'pairing', status: 'revoked' })).toBe(false)
    env.phone.startHandshake(env.phone.hello('resume'))
    env.pump()
    expect(env.hellos).toHaveLength(1)
  })
})
