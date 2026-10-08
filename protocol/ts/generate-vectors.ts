import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { b64uDecode, b64uEncode, hexDecode, hexEncode, toBytes, utf8Encode } from './encoding.ts'
import { derivePairProof, deriveRelayToken, tokenHash } from './derive.ts'
import { deviceId, ed25519FromPrivate, x25519Dh, x25519FromPrivate } from './keys.ts'
import type { KeyPair } from './keys.ts'
import { DEVTOOL_NOISE_PROLOGUE, NOISE_PROTOCOL_NAME, createInitiator, createResponder } from './noise.ts'
import { buildHello, relayAuthPayload } from './relay-messages.ts'
import type { Role } from './relay-messages.ts'
import { encodePairingUri } from './pairing-uri.ts'
import type { PairingPayload } from './pairing-uri.ts'
import { encodeJson, negotiateVersion, parseAppMessage, parseDesktopHello, parsePhoneHello } from './app-messages.ts'
import type { DesktopHello, PhoneHello } from './app-messages.ts'
import { FRAGMENT_CHUNK, Reassembler, fragmentMessage } from './fragments.ts'
import { parseBranchesListParams, parseBranchesListResult, parseStreamNewParams, parseStreamNewResult, parseChatParams, parseChatResult, parseChatSettingsParams, parseChatImageParams, parseChatImageResult, parseChatCommandsParams, parseChatCommandsResult, parseChatBtwParams, parseChatBtwResult, parseChatPermissionsParams, parseChatPermissionsResult, parseChatPermissionsUpdateParams, parseTaskNewParams, parseTaskNewResult, parseTaskCloseParams, parseTaskCloseResult, parseTabCloseParams, parsePinSetParams, parseTaskTriageParams } from './chat-messages.ts'
import { openPushCap, openPushPayload, parsePushParams, pushRegisterMessage, sealPushCap, sealPushPayload, signPushRegister } from './push.ts'
import type { PushPayload } from './push.ts'
import { PROJECT_TILE_PALETTE, fnv1a32, projectTile, taskPlace } from './project-tile.ts'

/**
 * Writes `protocol/vectors/*.json` (§5). Every byte comes from fixed labels, so running
 * this again must reproduce the committed files exactly; `vectors.test.ts` checks that.
 * The layout of each file is documented in `protocol/vectors/README.md`.
 *
 *   node protocol/ts/generate-vectors.ts
 */

/** 32 deterministic bytes per label. Not a KDF anyone should copy; it only seeds tests. */
function seed(label: string): Uint8Array {
  return toBytes(createHash('sha256').update(`devtool-vector:${label}`).digest())
}

const hex = hexEncode
const text = (value: unknown): string => JSON.stringify(value)

function x25519Json(pair: KeyPair): { priv: string; pub: string } {
  return { priv: hex(pair.priv), pub: hex(pair.pub) }
}

function ed25519Json(pair: KeyPair): { seed: string; pub: string; deviceId: string } {
  return { seed: hex(pair.priv), pub: hex(pair.pub), deviceId: deviceId(pair.pub) }
}

interface NoiseCase {
  name: string
  phoneHello: PhoneHello | null
  desktopHello: DesktopHello | null
}

function noiseIk(): unknown {
  const phoneEd = ed25519FromPrivate(seed('phone-ed25519'))
  const cases: NoiseCase[] = [
    {
      name: 'pair',
      phoneHello: {
        v: 1, min: 1, app: 'ios/0.1.0', features: [], kind: 'pair',
        proof: b64uEncode(derivePairProof(seed('pair-secret'))),
        deviceName: "Vladimir's iPhone", ed: b64uEncode(phoneEd.pub)
      },
      desktopHello: { v: 1, min: 1, app: 'devtool/0.3.2', features: [], desktopName: 'join3r-mbp', result: 'pending' }
    },
    {
      name: 'resume',
      phoneHello: {
        v: 1, min: 1, app: 'ios/0.1.0', features: [], kind: 'resume',
        deviceName: "Vladimir's iPhone", ed: b64uEncode(phoneEd.pub)
      },
      desktopHello: { v: 1, min: 1, app: 'devtool/0.3.2', features: [], desktopName: 'join3r-mbp', result: 'ok' }
    },
    { name: 'empty-payloads', phoneHello: null, desktopHello: null }
  ]
  const prologue = utf8Encode(DEVTOOL_NOISE_PROLOGUE)
  const vectors = cases.map((c) => {
    const phoneStatic = x25519FromPrivate(seed('phone-x25519'))
    const desktopStatic = x25519FromPrivate(seed('desktop-x25519'))
    const phoneEphemeral = x25519FromPrivate(seed(`${c.name}:phone-ephemeral`))
    const desktopEphemeral = x25519FromPrivate(seed(`${c.name}:desktop-ephemeral`))
    const initiator = createInitiator({ prologue, s: phoneStatic, e: phoneEphemeral, rs: desktopStatic.pub })
    const responder = createResponder({ prologue, s: desktopStatic, e: desktopEphemeral })
    const payload1 = c.phoneHello ? encodeJson(c.phoneHello) : new Uint8Array(0)
    const payload2 = c.desktopHello ? encodeJson(c.desktopHello) : new Uint8Array(0)
    const msg1 = initiator.writeMessage(payload1)
    responder.readMessage(msg1)
    const msg2 = responder.writeMessage(payload2)
    initiator.readMessage(msg2)
    const phone = initiator.split()
    const desktop = responder.split()
    const transport: { from: Role; payload: string; ciphertext: string }[] = []
    const send = (from: Role, body: string): void => {
      const payload = utf8Encode(body)
      const ciphertext = from === 'phone' ? phone.encrypt(payload) : desktop.encrypt(payload)
      transport.push({ from, payload: hex(payload), ciphertext: hex(ciphertext) })
    }
    // Interleaved, plus two in a row from the desktop so a counter mix-up shows.
    send('phone', text({ t: 'req', id: 1, op: 'inbox.get' }))
    send('desktop', text({ t: 'evt', e: 'pairing', status: 'accepted' }))
    send('desktop', text({ t: 'res', id: 1, ok: false, error: { code: 'unsupported', message: 'demo' } }))
    send('phone', text({ t: 'req', id: 2, op: 'inbox.get' }))
    send('phone', '')
    send('desktop', text({ t: 'evt', e: 'unknown-event' }))
    return {
      name: c.name,
      protocol: NOISE_PROTOCOL_NAME,
      prologue: hex(prologue),
      phone: { static: x25519Json(phoneStatic), ephemeral: x25519Json(phoneEphemeral) },
      desktop: { static: x25519Json(desktopStatic), ephemeral: x25519Json(desktopEphemeral) },
      msg1: { payload: hex(payload1), ciphertext: hex(msg1) },
      msg2: { payload: hex(payload2), ciphertext: hex(msg2) },
      handshakeHash: hex(initiator.handshakeHash),
      transport
    }
  })
  return {
    description: NOISE_PROTOCOL_NAME + ' with the DevTool prologue. Phone = initiator, desktop = responder. Hex-encoded bytes.',
    vectors
  }
}

function derive(): unknown {
  const secrets = ['pair-secret', 'pair-secret-2'].map((label) => {
    const secret = seed(label)
    const relayToken = deriveRelayToken(secret)
    return {
      secret: hex(secret),
      relayToken: hex(relayToken),
      pairProof: hex(derivePairProof(secret)),
      tokenHash: hex(tokenHash(relayToken)),
      tokenHashB64u: b64uEncode(tokenHash(relayToken))
    }
  })
  const deviceIds = ['phone-ed25519', 'desktop-ed25519'].map((label) => ed25519Json(ed25519FromPrivate(seed(label))))
  const a = x25519FromPrivate(seed('phone-x25519'))
  const b = x25519FromPrivate(seed('desktop-x25519'))
  return {
    description: 'HKDF-SHA256 (empty salt, 32 bytes) derivations, device IDs, and raw key derivations. Hex unless named *B64u.',
    secrets,
    deviceIds,
    x25519: [x25519Json(a), x25519Json(b)],
    x25519Dh: [{ priv: hex(a.priv), pub: hex(b.pub), shared: hex(x25519Dh(a.priv, b.pub)) }]
  }
}

function relayAuth(): unknown {
  const cases: { label: string; role: Role; pair: boolean }[] = [
    { label: 'desktop-ed25519', role: 'desktop', pair: false },
    { label: 'phone-ed25519', role: 'phone', pair: false },
    { label: 'phone-ed25519', role: 'phone', pair: true }
  ]
  const desktopId = deviceId(ed25519FromPrivate(seed('desktop-ed25519')).pub)
  return {
    description: 'Relay hello signatures (§3.1). payload = utf8("devtool-relay-v1\\n" + role + "\\n" + nonce); nonce is the b64u string as sent in the challenge.',
    vectors: cases.map((c, i) => {
      const key = ed25519FromPrivate(seed(c.label))
      const nonce = b64uEncode(seed(`nonce-${i}`))
      const hello = buildHello({
        role: c.role,
        nonce,
        ed25519Priv: key.priv,
        ed25519Pub: key.pub,
        pair: c.pair ? { to: desktopId, token: deriveRelayToken(seed('pair-secret')) } : undefined
      })
      return {
        ed25519: ed25519Json(key),
        role: c.role,
        nonce,
        payload: hex(relayAuthPayload(c.role, nonce)),
        sig: hex(b64uDecode(hello.sig)),
        hello: text(hello)
      }
    })
  }
}

function pairingUri(): unknown {
  const desktopEd = ed25519FromPrivate(seed('desktop-ed25519'))
  const payload: PairingPayload = {
    v: 1,
    relay: 'wss://relay.devtool.awantech.sk',
    id: deviceId(desktopEd.pub),
    x: b64uEncode(x25519FromPrivate(seed('desktop-x25519')).pub),
    e: b64uEncode(desktopEd.pub),
    s: b64uEncode(seed('pair-secret')),
    n: 'join3r-mbp',
    exp: 1790000300
  }
  const local: PairingPayload = { ...payload, relay: 'ws://localhost:8787', n: 'Žluťoučký kůň 🐴' }
  const b64Json = (value: unknown): string => b64uEncode(utf8Encode(JSON.stringify(value)))
  return {
    description: 'Pairing URIs (§2). `valid[].uri` is exactly what encoding `payload` produces; decoding it must give `payload` back.',
    valid: [
      { payload, uri: encodePairingUri(payload) },
      { payload: local, uri: encodePairingUri(local) },
      {
        note: 'unknown JSON fields are dropped on decode',
        payload,
        uri: 'devtool://pair?d=' + b64Json({ ...payload, future: { x: 1 } })
      }
    ],
    invalid: [
      { reason: 'wrong scheme', uri: 'https://pair?d=' + b64Json(payload) },
      { reason: 'wrong host', uri: 'devtool://pear?d=' + b64Json(payload) },
      { reason: 'missing payload', uri: 'devtool://pair' },
      { reason: 'payload not base64url', uri: 'devtool://pair?d=***' },
      { reason: 'unsupported version', uri: 'devtool://pair?d=' + b64Json({ ...payload, v: 2 }) },
      { reason: 'id does not match e', uri: 'devtool://pair?d=' + b64Json({ ...payload, id: '0'.repeat(32) }) },
      { reason: 'secret wrong length', uri: 'devtool://pair?d=' + b64Json({ ...payload, s: b64uEncode(new Uint8Array(16)) }) },
      { reason: 'relay not a websocket URL', uri: 'devtool://pair?d=' + b64Json({ ...payload, relay: 'https://relay.example' }) },
      { reason: 'exp missing', uri: 'devtool://pair?d=' + b64Json({ ...payload, exp: undefined }) }
    ]
  }
}

function appMessages(): unknown {
  const phoneEd = b64uEncode(ed25519FromPrivate(seed('phone-ed25519')).pub)
  const proof = b64uEncode(derivePairProof(seed('pair-secret')))
  const inbox = {
    desktop: { id: deviceId(ed25519FromPrivate(seed('desktop-ed25519')).pub), name: 'join3r-mbp' },
    generatedAt: 1790000000000,
    projects: [
      {
        id: 'p1', name: 'api-server', emoji: '🚀', remote: false,
        streams: [
          { id: 's-main', name: 'main', main: true },
          { id: 's-050', name: '0.5.0', branch: '0.5.0' },
          { id: 's-bugs', name: 'bugfixes' }
        ],
        lastStreamId: 's-050',
        tasks: [{
          id: 't1', name: 'fix-auth', streamId: 's-main', streamName: 'main',
          status: 'working', since: 1790000000000, activity: 'Running Bash',
          lastInteractedAt: 1790000000000, attentionAt: 1790000000000,
          eventAt: 1790000000000, unread: true,
          tabs: [
            { id: 'tab1', type: 'claude-chat', title: 'Claude', status: 'working', since: 1790000000000, activity: 'Running Bash', topic: 'Fix the login redirect' },
            { id: 'tab2', type: 'terminal', title: 'zsh', status: 'idle' }
          ]
        }, {
          id: 't2', name: 'Fix the login redirect', streamId: 's-050', streamName: '0.5.0', status: 'idle',
          settledAt: 1789990000000,
          tabs: [{ id: 'tab3', type: 'claude-chat', title: 'Claude', status: 'idle' }]
        }, {
          id: 't3', name: 'bump-deps', streamId: 's-050', streamName: '0.5.0', status: 'exited', since: 1789990000000,
          snoozedUntil: 1790003600000, tabs: []
        }, {
          id: 't4', name: 'Terminal', streamId: 's-main', streamName: 'main', status: 'attention',
          snoozeUntilAttention: true,
          tabs: [{ id: 'tab4', type: 'terminal', title: 'zsh', status: 'attention' }]
        }]
      },
      { id: 'p2', name: 'remote-box', remote: true, streams: [{ id: 's-main-2', name: 'main', main: true }], tasks: [] }
    ],
    pinned: [
      { projectId: 'p1', streamId: 's-050', taskId: 't2' },
      { projectId: 'p1', streamId: 's-bugs' },
      { projectId: 'p2' }
    ]
  }
  const withExtras = {
    desktop: { id: inbox.desktop.id, name: 'join3r-mbp', color: 'blue' },
    generatedAt: 1790000000000,
    layout: 'grid',
    projects: [{
      id: 'p1', name: 'api-server', remote: false, emoji: null, pinned: true, lastStreamId: null,
      streams: [{ id: 's-main', name: 'main', main: 'yes', branch: null, color: 'green' }],
      tasks: [{
        id: 't1', name: 'fix-auth', streamId: 's-main', streamName: 'main', status: 'thinking', since: null,
        activity: null, notes: 'x', attentionAt: null, branch: null,
        unread: false, settledAt: null, snoozeUntilAttention: 'yes',
        tabs: [
          { id: 'tab1', type: 'gemini', title: 'Gemini', status: 'thinking', since: 5, badge: 3 },
          { id: 'tab2', type: 'pi', title: 'Pi', status: 'attention', activity: null }
        ]
      }]
    }],
    pinned: [{ projectId: 'p1', streamId: null, taskId: null, color: 'red' }]
  }
  const withExtrasExpected = {
    desktop: { id: inbox.desktop.id, name: 'join3r-mbp' },
    generatedAt: 1790000000000,
    projects: [{
      id: 'p1', name: 'api-server', remote: false,
      streams: [{ id: 's-main', name: 'main' }],
      tasks: [{
        id: 't1', name: 'fix-auth', streamId: 's-main', streamName: 'main', status: 'idle',
        tabs: [
          { id: 'tab1', type: 'gemini', title: 'Gemini', status: 'idle', since: 5 },
          { id: 'tab2', type: 'pi', title: 'Pi', status: 'attention' }
        ]
      }]
    }],
    pinned: [{ projectId: 'p1' }]
  }
  const phonePair = { v: 2, min: 2, app: 'ios/0.2.0', features: [], kind: 'pair', proof, deviceName: "Vladimir's iPhone", ed: phoneEd }
  const phoneResume = { v: 2, min: 2, app: 'ios/0.2.0', features: ['x'], kind: 'resume', deviceName: 'iPad', ed: phoneEd }
  const desktopOk = { v: 2, min: 2, app: 'devtool/0.3.2', features: [], desktopName: 'join3r-mbp', result: 'ok' }

  const sample = (json: unknown, parse: (s: string) => unknown): { json: string; expected: unknown } => {
    const s = typeof json === 'string' ? json : text(json)
    return { json: s, expected: parse(s) ?? null }
  }
  return {
    description: 'Sample JSON for handshake payloads and app messages. Parse `json`; the result must equal `expected` (null = ignore the message). `invalid` entries must fail to parse.',
    phoneHello: [
      sample(phonePair, parsePhoneHello),
      sample(phoneResume, parsePhoneHello),
      sample({ ...phoneResume, pushCap: 'future', proof }, parsePhoneHello)
    ],
    desktopHello: [
      sample(desktopOk, parseDesktopHello),
      sample({ ...desktopOk, result: 'unknown-device', extra: [1, 2] }, parseDesktopHello)
    ],
    appMessages: [
      sample({ t: 'req', id: 1, op: 'inbox.get' }, parseAppMessage),
      sample({ t: 'req', id: 2, op: 'chat.send', args: { text: 'hi' } }, parseAppMessage),
      sample({ t: 'res', id: 1, ok: true, result: inbox }, parseAppMessage),
      sample({ t: 'res', id: 2, ok: false, error: { code: 'unsupported', message: 'Unknown op chat.send' } }, parseAppMessage),
      sample({ t: 'evt', e: 'inbox', seq: 1, inbox }, parseAppMessage),
      sample({ t: 'evt', e: 'inbox', seq: 2, inbox: withExtras, compressed: false }, parseAppMessage),
      sample({ t: 'evt', e: 'pairing', status: 'accepted' }, parseAppMessage),
      sample({ t: 'evt', e: 'pairing', status: 'revoked', reason: 'user' }, parseAppMessage),
      sample({ t: 'evt', e: 'future', seq: 1 }, parseAppMessage),
      sample({ t: 'hint', text: 'future message type' }, parseAppMessage)
    ],
    inboxWithUnknownFields: { json: text(withExtras), expected: withExtrasExpected },
    invalid: {
      phoneHello: [
        text({ ...phonePair, proof: undefined }),
        text({ ...phonePair, kind: 'bond' }),
        text({ ...phonePair, ed: 'short' }),
        text({ ...phonePair, v: 2, min: 3 })
      ],
      desktopHello: [text({ ...desktopOk, result: 'maybe' }), text({ ...desktopOk, desktopName: 7 })],
      appMessages: [
        text({ t: 'req', op: 'inbox.get' }),
        text({ t: 'res', id: 1, ok: 'yes' }),
        text({ t: 'evt', e: 'inbox', seq: 1, inbox: { projects: [] } }),
        // A version 1 project: no streams, tasks without a stream or status.
        text({ t: 'evt', e: 'inbox', seq: 1, inbox: { desktop: inbox.desktop, generatedAt: 1, projects: [{ id: 'p', name: 'p', remote: false, tasks: [] }] } }),
        text({ t: 'evt', e: 'inbox', seq: 1, inbox: { desktop: inbox.desktop, generatedAt: 1, projects: [{ id: 'p', name: 'p', remote: false, streams: [], tasks: [{ id: 't', name: 't', tabs: [] }] }] } }),
        text({ t: 'evt', e: 'pairing', status: 'maybe' }),
        '[1,2,3]',
        'not json'
      ]
    },
    versionNegotiation: [
      [{ v: 1, min: 1 }, { v: 1, min: 1 }],
      [{ v: 2, min: 1 }, { v: 1, min: 1 }],
      [{ v: 1, min: 1 }, { v: 3, min: 2 }],
      [{ v: 3, min: 3 }, { v: 2, min: 1 }],
      [{ v: 1, min: 1 }, { v: 3, min: 3 }],
      // Version 2 is a hard cutover: a v1 peer must update, whichever side it is.
      [{ v: 2, min: 2 }, { v: 1, min: 1 }],
      [{ v: 1, min: 1 }, { v: 2, min: 2 }],
      [{ v: 2, min: 2 }, { v: 2, min: 2 }]
    ].map(([local, remote]) => ({ local, remote, result: negotiateVersion(local, remote) }))
  }
}

/**
 * An exactly `size`-byte JSON message. When it is well over one chunk, the first chunk
 * boundary falls inside a two-byte UTF-8 character, so a receiver that decodes chunks
 * on their own fails.
 */
function paddedMessage(size: number): Uint8Array {
  const head = '{"t":"res","id":7,"ok":true,"result":{"kind":"tool","input":"'
  const tail = '"}}'
  // Pad with 'é' (2 bytes) from the start of the input, with one ASCII byte first if
  // needed to make FRAGMENT_CHUNK land on the second byte of an 'é'.
  const lead = (FRAGMENT_CHUNK - head.length) % 2 === 0 ? 'x' : ''
  let body = lead
  let bytes = head.length + lead.length + tail.length
  let i = 0
  while (bytes + 2 <= size) {
    // A readable repeating pattern, mostly 'é', with an escaped newline every 40 (never at the chunk boundary).
    body += i % 40 === 39 && Math.abs(bytes - FRAGMENT_CHUNK) > 4 ? '\\n' : 'é'
    bytes += 2
    i++
  }
  while (bytes < size) {
    body += 'x'
    bytes++
  }
  const out = utf8Encode(head + body + tail)
  if (out.length !== size) throw new Error(`padded message is ${out.length} bytes`)
  if (size > FRAGMENT_CHUNK + 100 && (out[FRAGMENT_CHUNK] & 0xc0) !== 0x80) throw new Error('chunk boundary is not inside a character')
  return out
}

function fragmentHex(id: number, i: number, n: number, chunk: string): string {
  const header = new Uint8Array(9)
  const view = new DataView(header.buffer)
  header[0] = 0x01
  view.setUint32(1, id)
  view.setUint16(5, i)
  view.setUint16(7, n)
  return hex(header) + hex(utf8Encode(chunk))
}

type Step = { input: string; output: string | null } | { reset: true }

/** Runs `inputs` through a fresh Reassembler so the expected outputs are the implementation's. */
function scenario(name: string, inputs: (string | 'reset')[]): { name: string; steps: Step[] } {
  const r = new Reassembler({ now: () => 0 })
  const steps = inputs.map((input): Step => {
    if (input === 'reset') {
      r.reset()
      return { reset: true }
    }
    const out = r.push(hexDecode(input))
    return { input, output: out ? hex(out) : null }
  })
  return { name, steps }
}

function fragments(): unknown {
  const big = paddedMessage(150000)
  const bigFragments = fragmentMessage(big, 7)
  const exact = paddedMessage(FRAGMENT_CHUNK)
  const overByOne = paddedMessage(FRAGMENT_CHUNK + 1)
  const whole = hex(utf8Encode('{"t":"evt","e":"x"}'))
  const a = ['{"t":"evt",', '"e":"a"', '}']
  const b = ['{"t":"evt","e":', '"b"}']
  const f = (id: number, i: number, n: number, chunk: string): string => fragmentHex(id, i, n, chunk)
  return {
    description: 'Transport plaintext fragmentation (SPEC.md §6.1). `message` split with fragment id 7 gives `fragments`; feeding them in order to a receiver gives back `message`. `scenarios` replay step by step against a fresh receiver: `output` is the complete JSON the step yields, or null.',
    chunkSize: FRAGMENT_CHUNK,
    message: {
      id: 7,
      length: big.length,
      sha256: createHash('sha256').update(big).digest('hex'),
      hex: hex(big),
      fragments: bigFragments.map(hex)
    },
    boundaries: [
      { note: 'exactly the chunk size: sent whole', length: exact.length, sha256: createHash('sha256').update(exact).digest('hex'), fragmentCount: fragmentMessage(exact, 0).length },
      {
        note: 'one byte over: two fragments, the second holding one byte',
        length: overByOne.length,
        sha256: createHash('sha256').update(overByOne).digest('hex'),
        fragmentCount: fragmentMessage(overByOne, 0).length,
        lastFragment: hex(fragmentMessage(overByOne, 0)[1])
      }
    ],
    scenarios: [
      scenario('a complete JSON message passes through', [whole]),
      scenario('in order', [f(1, 0, 3, a[0]), f(1, 1, 3, a[1]), f(1, 2, 3, a[2])]),
      scenario('out of order', [f(1, 2, 3, a[2]), f(1, 0, 3, a[0]), f(1, 1, 3, a[1])]),
      scenario('two messages interleaved', [f(1, 0, 3, a[0]), f(2, 0, 2, b[0]), f(1, 1, 3, a[1]), f(2, 1, 2, b[1]), f(1, 2, 3, a[2])]),
      scenario('a whole message between fragments', [f(1, 0, 3, a[0]), whole, f(1, 1, 3, a[1]), f(1, 2, 3, a[2])]),
      scenario('a repeated chunk drops the message', [f(1, 0, 3, a[0]), f(1, 0, 3, a[0]), f(1, 1, 3, a[1]), f(1, 2, 3, a[2])]),
      scenario('n changing drops the message', [f(1, 0, 3, a[0]), f(1, 1, 2, a[1]), f(1, 2, 3, a[2])]),
      scenario('n below 2 is dropped', [f(1, 0, 1, '{"t":"evt","e":"a"}')]),
      scenario('i not below n is dropped', [f(1, 3, 3, a[0])]),
      scenario('a fragment with no chunk is ignored', [hex(new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 2]))]),
      scenario('an unknown first byte is ignored', ['02' + hex(utf8Encode('{"t":"evt"}')), hex(utf8Encode('[1,2]')), whole]),
      scenario('a fifth partial message is dropped', [
        f(1, 0, 2, b[0]), f(2, 0, 2, b[0]), f(3, 0, 2, b[0]), f(4, 0, 2, b[0]),
        f(5, 0, 2, b[0]), f(5, 1, 2, b[1]), f(1, 1, 2, b[1]), f(5, 0, 2, b[0]), f(5, 1, 2, b[1])
      ]),
      scenario('a reset clears partial messages', [f(1, 0, 2, b[0]), 'reset', f(1, 1, 2, b[1]), f(1, 0, 2, b[0])]),
      scenario('an id can be reused once its message completed', [f(1, 0, 2, b[0]), f(1, 1, 2, b[1]), f(1, 0, 3, a[0]), f(1, 1, 3, a[1]), f(1, 2, 3, a[2])])
    ]
  }
}

function chatMessages(): unknown {
  const tool = { kind: 'tool', id: 'toolu_01', name: 'Bash', summary: 'Bash · npm test', status: 'done', hasDetail: true }
  const items = [
    { kind: 'user', id: 'u1', text: 'Run the tests, please.' },
    { kind: 'user', id: 'u2', text: 'And a screenshot', images: 1, queued: true },
    { kind: 'user', id: 'u3', text: 'lost', failed: true },
    { kind: 'thinking', id: 'i3-0', preview: 'Let me look at the test runner first…' },
    { kind: 'text', id: 'i4-0', markdown: 'Running **the tests** now.' },
    tool,
    { kind: 'tool', id: 'toolu_02', name: 'Agent', summary: 'Explore · find auth code', status: 'running', hasDetail: true, childCount: 3, lastChild: 'Grep · verifyToken' },
    { kind: 'notice', id: 'n9-0', text: 'Interrupted', tone: 'muted' },
    { kind: 'tool', id: 'toolu_04', name: 'Read', summary: 'Read · screenshot.png', status: 'done', hasDetail: true, images: 2 },
    { kind: 'text', id: 'i10-0', markdown: 'All 42 tests pass', streaming: true }
  ]
  const prompts = [
    {
      kind: 'permission', id: 'req-1', toolName: 'Bash', title: 'Claude wants to run a command', summary: 'Bash · rm -rf dist',
      detail: 'rm -rf dist\n\nClean the build output', canAlwaysAllow: true
    },
    {
      kind: 'question', id: 'req-2',
      questions: [{
        question: 'Which database should we use?', header: 'Database', multiSelect: false,
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }]
      }, {
        question: 'Which extras?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Admin' }]
      }]
    },
    { kind: 'plan', id: 'req-3', markdown: '## Plan\n\n1. Add the column\n2. Backfill' },
    { kind: 'permission', id: 'req-4', toolName: 'Write', title: 'Write src/a.ts', summary: 'Write · src/a.ts', canAlwaysAllow: false, agent: true }
  ]
  const settings = {
    modelName: 'Opus 4.5',
    models: [{ value: 'opus', label: 'Opus 4.5', description: 'Most capable' }, { value: 'haiku', label: 'Haiku 4.5' }],
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high']
  }
  const usage = {
    contextTokens: 48000, contextMax: 200000, costCents: 137,
    fiveHour: { used: 42, resetsAt: 1790003600000 }, sevenDay: { used: 7 }
  }
  const view = {
    tabId: 'tab-chat', title: 'Claude', busy: true, turnStartedAt: 1790000000000, process: 'running',
    permissionMode: 'default', model: 'claude-opus-4-5', settings, usage, items, hasEarlier: true, prompts
  }
  const viewWithUnknowns = {
    ...view,
    layout: 'bubbles',
    busy: false, turnStartedAt: null, process: 'hibernating', model: null,
    settings: { model: 'haiku', modelName: 'Haiku 4.5', models: [{ value: 'haiku', label: 'Haiku 4.5', description: null, tier: 2 }], effort: 'low', defaultEffort: null, efforts: [], speed: 'fast' },
    usage: { contextTokens: null, costCents: 0, fiveHour: { used: 100, resetsAt: null, scope: 'org' }, sevenDay: null, opus: { used: 3 } },
    items: [
      { ...items[0], images: 0, queued: false, reactions: ['👍'] },
      { kind: 'diagram', id: 'd1', svg: '<svg/>' },
      { ...tool, status: 'paused', childCount: null, colour: 'red' },
      { kind: 'notice', id: 'n1', text: 'Heads up', tone: 'loud' }
    ],
    prompts: [{ kind: 'survey', id: 'req-9', stars: 5 }, { ...prompts[3], agent: false, risk: 'high' }]
  }
  const params = (op: string, value: unknown): { op: string; json: string; expected: unknown } =>
    ({ op, json: text(value), expected: parseChatParams(op, value) })
  const result = (op: string, value: unknown): { op: string; json: string; expected: unknown } =>
    ({ op, json: text(value), expected: parseChatResult(op, value) })
  const sample = (json: unknown): { json: string; expected: unknown } => {
    const s = text(json)
    return { json: s, expected: parseAppMessage(s) ?? null }
  }
  const event = {
    t: 'evt', e: 'chat', tabId: 'tab-chat', seq: 12,
    upserts: [{ kind: 'text', id: 'i10-0', markdown: 'All 42 tests pass.' }, { kind: 'tool', id: 'toolu_03', name: 'Read', summary: 'Read · package.json', status: 'pending', hasDetail: true }],
    removes: [], prompts: [prompts[0]], busy: true, turnStartedAt: 1790000000000, process: 'running', permissionMode: 'default', model: 'claude-opus-4-5'
  }
  return {
    description: 'Sample chat.* requests, params, results and evt chat messages (SPEC.md §6.2–§6.4). Parse `json` with the named parser; the result must equal `expected`. `invalid` entries must fail to parse.',
    requests: [
      sample({ t: 'req', id: 10, op: 'chat.open', params: { tabId: 'tab-chat' } }),
      sample({ t: 'req', id: 11, op: 'chat.send', params: { tabId: 'tab-chat', text: 'Reply with just the word hi' } }),
      sample({ t: 'req', id: 12, op: 'chat.close', params: null }),
      sample({ t: 'req', id: 13, op: 'chat.answer', params: { tabId: 'tab-chat', promptId: 'req-1', answer: { behavior: 'allow' } }, trace: 'x' })
    ],
    params: [
      params('chat.open', { tabId: 'tab-chat' }),
      params('chat.close', { tabId: 'tab-chat', extra: 1 }),
      params('chat.earlier', { tabId: 'tab-chat', before: 'u1' }),
      params('chat.earlier', { tabId: 'tab-chat', before: 'u1', limit: 20 }),
      params('chat.earlier', { tabId: 'tab-chat', before: 'u1', limit: 500 }),
      params('chat.send', { tabId: 'tab-chat', text: 'Reply with just the word hi' }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-1', answer: { behavior: 'allow' } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-1', answer: { behavior: 'allow', always: true } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-1', answer: { behavior: 'allow', always: false } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-1', answer: { behavior: 'deny', message: 'Not now' } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-3', answer: { behavior: 'deny' } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-2', answer: { behavior: 'answers', answers: { 'Which database should we use?': 'Postgres', 'Which extras?': 'Auth, Admin' } } }),
      params('chat.answer', { tabId: 'tab-chat', promptId: 'req-3', answer: { behavior: 'approvePlan' } }),
      params('chat.interrupt', { tabId: 'tab-chat' }),
      params('chat.detail', { tabId: 'tab-chat', itemId: 'toolu_01' }),
      params('inbox.get', null)
    ],
    results: [
      result('chat.open', { seq: 11, view }),
      result('chat.open', { seq: 3, view: viewWithUnknowns }),
      result('chat.earlier', { items: items.slice(0, 2), hasEarlier: false }),
      result('chat.detail', { kind: 'tool', input: '{\n  "command": "npm test"\n}', result: '42 passing' }),
      result('chat.detail', { kind: 'tool', input: '{}' }),
      result('chat.detail', { kind: 'text', markdown: 'The whole long answer' }),
      result('chat.close', {}),
      result('chat.send', {}),
      result('chat.answer', { note: 'ignored' }),
      result('chat.interrupt', {}),
      result('inbox.get', {})
    ],
    events: [
      sample(event),
      sample({ ...event, seq: 13, upserts: [], removes: ['i10-0'], prompts: [], busy: false, turnStartedAt: null, process: 'exited', processError: 'Claude exited (code 1)', model: null }),
      sample({ ...event, seq: 15, upserts: [], usage: { ...usage, fiveHour: { used: 43, resetsAt: 1790003600000 } }, settings: { ...settings, effort: 'high', defaultEffort: undefined } }),
      sample({ ...event, seq: 14, upserts: [{ kind: 'poll', id: 'x1', options: [] }, { ...items[3], preview: 'more…', streaming: true }], prompts: viewWithUnknowns.prompts, process: 'napping', cursor: 5 })
    ],
    invalid: {
      params: [
        { op: 'chat.open', json: text({}) },
        { op: 'chat.open', json: text({ tabId: 7 }) },
        { op: 'chat.send', json: text({ tabId: 't' }) },
        { op: 'chat.send', json: text({ tabId: 't', text: '   ' }) },
        { op: 'chat.send', json: text({ tabId: 't', text: 'x'.repeat(32001) }) },
        { op: 'chat.earlier', json: text({ tabId: 't', before: 'u1', limit: 0 }) },
        { op: 'chat.earlier', json: text({ tabId: 't', before: 'u1', limit: -3 }) },
        { op: 'chat.answer', json: text({ tabId: 't', promptId: 'p', answer: { behavior: 'maybe' } }) },
        { op: 'chat.answer', json: text({ tabId: 't', promptId: 'p', answer: { behavior: 'answers', answers: { q: 1 } } }) },
        { op: 'chat.answer', json: text({ tabId: 't', promptId: 'p' }) },
        { op: 'chat.detail', json: text({ tabId: 't' }) },
        { op: 'chat.close', json: 'null' }
      ],
      results: [
        { op: 'chat.open', json: text({ seq: 1 }) },
        { op: 'chat.open', json: text({ seq: 1, view: { ...view, items: [{ kind: 'text', id: 'x' }] } }) },
        { op: 'chat.open', json: text({ seq: 1, view: { ...view, busy: 'yes' } }) },
        { op: 'chat.earlier', json: text({ items: [] }) },
        { op: 'chat.detail', json: text({ kind: 'image' }) },
        { op: 'chat.send', json: '[]' }
      ],
      events: [
        text({ ...event, tabId: undefined }),
        text({ ...event, removes: [1] }),
        text({ ...event, upserts: [{ kind: 'tool', id: 'x', name: 'Bash', summary: 's', status: 'done' }] }),
        text({ ...event, prompts: [{ kind: 'plan', id: 'p' }] }),
        text({ ...event, upserts: [{ kind: 'text', markdown: 'no id' }] }),
        text({ ...event, settings: { models: [] } }),
        text({ ...event, settings: { ...settings, models: [{ value: 'opus' }] } }),
        text({ ...event, usage: { fiveHour: { used: 12.5 } } }),
        text({ ...event, usage: { costCents: -1 } }),
        text({ ...event, upserts: [{ kind: 'tool', id: 'x', name: 'Read', summary: 's', status: 'done', hasDetail: true, images: 'two' }] })
      ]
    },
    // §8.4: `task.new` names a project (and optionally a stream) and carries the first prompt.
    taskNew: {
      params: [
        text({ projectId: 'p1', prompt: 'Fix the login redirect' }),
        text({ projectId: 'p1', streamId: 's-050', prompt: 'Plan the refactor', mode: 'plan' }),
        text({ projectId: 'p1', streamId: null, prompt: 'Go', mode: null, extra: true }),
        // Version 1's `workspace` is gone: it is ignored like any unknown field.
        text({ projectId: 'p1', prompt: 'Go', workspace: true })
      ].map((json) => ({ json, expected: parseTaskNewParams(JSON.parse(json)) })),
      results: [text({ taskId: 'task-new', tabId: 'tab-new' }), text({ taskId: 'task-new', tabId: 'tab-new', seq: 0 })].map((json) => ({ json, expected: parseTaskNewResult(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ prompt: 'no project' }),
          text({ projectId: 'p1' }),
          text({ projectId: 'p1', prompt: '   ' }),
          text({ projectId: 'p1', prompt: 'Go', mode: 'yolo' }),
          text({ projectId: 'p1', streamId: 7, prompt: 'Go' }),
          'null'
        ],
        results: [text({ tabId: 'tab-new' }), text({ taskId: 'task-new' }), '[]']
      }
    },
    // §8.7: `task.close` archives a task, reporting a working agent or unsaved edits until the phone confirms.
    taskClose: {
      params: [
        text({ taskId: 't1' }),
        text({ taskId: 't1', stopWorking: true, discardUnsaved: true }),
        text({ taskId: 't1', stopWorking: 1, discardUnsaved: null, discardWorkspace: true, extra: true })
      ].map((json) => ({ json, expected: parseTaskCloseParams(JSON.parse(json)) })),
      results: [
        text({ closed: true }),
        text({ closed: true, warning: 'ignored' }),
        text({ closed: false, blocker: 'working' }),
        text({ closed: false, blocker: 'unsaved', extra: 1 })
      ].map((json) => ({ json, expected: parseTaskCloseResult(JSON.parse(json)) })),
      invalid: {
        params: [text({}), text({ taskId: 7 }), 'null'],
        results: [text({}), text({ closed: false }), text({ closed: 'yes' }), text({ closed: false, blocker: 'unmerged' }), '[]']
      }
    },
    // §8.8: `tab.close` names a tab; its result is `{}`.
    tabClose: {
      params: [text({ tabId: 'tab2' }), text({ tabId: 'tab2', extra: true })].map((json) => ({ json, expected: parseTabCloseParams(JSON.parse(json)) })),
      invalid: { params: [text({}), text({ tabId: null }), 'null'] }
    },
    // §8.10: `pin.set` pins or unpins a project, a stream with `streamId`, or a task with `taskId`; its result is `{}`.
    pinSet: {
      params: [
        text({ projectId: 'p1', pinned: true }),
        text({ projectId: 'p1', streamId: 's-050', pinned: true }),
        text({ projectId: 'p1', streamId: 's-050', taskId: 't2', pinned: false }),
        text({ projectId: 'p1', streamId: null, taskId: null, pinned: true, extra: 1 })
      ].map((json) => ({ json, expected: parsePinSetParams(JSON.parse(json)) })),
      invalid: { params: [text({ pinned: true }), text({ projectId: 'p1' }), text({ projectId: 'p1', pinned: 'yes' }), text({ projectId: 'p1', taskId: 7, pinned: true }), text({ projectId: 'p1', streamId: 7, pinned: true }), 'null'] }
    },
    // §8.11: `task.triage` marks a task read or unread, settles, snoozes or undoes either; its result is `{}`.
    taskTriage: {
      params: [
        text({ taskId: 't1', action: 'read' }),
        text({ taskId: 't1', action: 'unread', until: 5 }),
        text({ taskId: 't1', action: 'settle' }),
        text({ taskId: 't1', action: 'unsettle' }),
        text({ taskId: 't1', action: 'snooze', until: 1790003600000 }),
        text({ taskId: 't1', action: 'snooze', untilAttention: true, until: null }),
        text({ taskId: 't1', action: 'unsnooze', untilAttention: true, extra: 1 })
      ].map((json) => ({ json, expected: parseTaskTriageParams(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ action: 'read' }),
          text({ taskId: 't1' }),
          text({ taskId: 't1', action: 'archive' }),
          text({ taskId: 't1', action: 'snooze' }),
          text({ taskId: 't1', action: 'snooze', untilAttention: false }),
          text({ taskId: 't1', action: 'snooze', until: 1790003600000, untilAttention: true }),
          text({ taskId: 't1', action: 'snooze', until: -1 }),
          text({ taskId: 't1', action: 'snooze', until: '1790003600000' }),
          'null'
        ]
      }
    },
    // §8.12: `stream.new` makes a stream on a new worktree or in the project folder.
    streamNew: {
      params: [
        text({ projectId: 'p1', name: '0.6.0', worktree: true }),
        text({ projectId: 'p1', name: ' Chapter 2 ', worktree: true, branch: ' chapter-2 ', baseBranch: 'main', extra: 1 }),
        text({ projectId: 'p1', name: 'Docs', worktree: false, branch: 'docs', baseBranch: 'main' }),
        text({ projectId: 'p1', name: '0.6.0', worktree: true, branch: null, baseBranch: null })
      ].map((json) => ({ json, expected: parseStreamNewParams(JSON.parse(json)) })),
      results: [text({ streamId: 's-060' }), text({ streamId: 's-060', branch: '0.6.0' })].map((json) => ({ json, expected: parseStreamNewResult(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ name: '0.6.0', worktree: true }),
          text({ projectId: 'p1', worktree: true }),
          text({ projectId: 'p1', name: '   ', worktree: false }),
          text({ projectId: 'p1', name: '0.6.0' }),
          text({ projectId: 'p1', name: '0.6.0', worktree: 'yes' }),
          text({ projectId: 'p1', name: '0.6.0', worktree: true, branch: '  ' }),
          text({ projectId: 'p1', name: '0.6.0', worktree: true, baseBranch: '' }),
          text({ projectId: 'p1', name: '0.6.0', worktree: true, branch: 7 }),
          'null'
        ],
        results: [text({}), text({ streamId: 7 }), '[]']
      }
    },
    // §8.13: `branches.list` lists a project's local branches for the From picker.
    branchesList: {
      params: [text({ projectId: 'p1' }), text({ projectId: 'p1', extra: true })].map((json) => ({ json, expected: parseBranchesListParams(JSON.parse(json)) })),
      results: [
        text({ branches: ['main', '0.5.0', 'fix/login'], defaultBase: 'main' }),
        text({ branches: [], defaultBase: '' }),
        text({ branches: ['develop'], defaultBase: 'develop', remote: 'origin' })
      ].map((json) => ({ json, expected: parseBranchesListResult(JSON.parse(json)) })),
      invalid: {
        params: [text({}), text({ projectId: 7 }), 'null'],
        results: [text({ branches: ['main'] }), text({ defaultBase: 'main' }), text({ branches: ['main', 7], defaultBase: 'main' }), text({ branches: 'main', defaultBase: 'main' }), '[]']
      }
    },
    // §8.9: `chat.image` fetches one tool-result image.
    image: {
      params: [
        text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 0 }),
        text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 1, maxSide: 600 }),
        text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 0, maxSide: 10, extra: true }),
        text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 0, maxSide: 100000 }),
        text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 2, maxSide: null })
      ].map((json) => ({ json, expected: parseChatImageParams(JSON.parse(json)) })),
      results: [
        text({ mediaType: 'image/png', data: 'iVBORw0KGgo=' }),
        text({ mediaType: 'image/jpeg', data: '/9j/4AAQ', width: 640 })
      ].map((json) => ({ json, expected: parseChatImageResult(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ tabId: 'tab-chat', itemId: 'toolu_04' }),
          text({ tabId: 'tab-chat', index: 0 }),
          text({ tabId: 'tab-chat', itemId: 'toolu_04', index: -1 }),
          text({ tabId: 'tab-chat', itemId: 'toolu_04', index: 1.5 }),
          'null'
        ],
        results: [text({ mediaType: 'image/png' }), text({ mediaType: 'image/png', data: '' }), text({ mediaType: 'image/tiff', data: 'AAAA' }), '[]']
      }
    },
    // §8.5: `chat.settings` changes the pickers; its result is `{}`.
    settings: {
      params: [
        text({ tabId: 'tab-chat', mode: 'plan' }),
        text({ tabId: 'tab-chat', model: 'haiku', effort: 'low' }),
        text({ tabId: 'tab-chat', model: '', effort: '' }),
        text({ tabId: 'tab-chat', mode: null, effort: 'max', extra: true })
      ].map((json) => ({ json, expected: parseChatSettingsParams(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ mode: 'plan' }),
          text({ tabId: 'tab-chat' }),
          text({ tabId: 'tab-chat', mode: 'yolo' }),
          text({ tabId: 'tab-chat', model: 4 }),
          'null'
        ]
      }
    },
    // §8.14: the composer's `/` menu, `/btw` and `/permissions`.
    commands: {
      params: [text({ tabId: 'tab-chat' }), text({ tabId: 'tab-chat', extra: 1 })].map((json) => ({ json, expected: parseChatCommandsParams(JSON.parse(json)) })),
      results: [
        text({
          commands: [
            { name: 'btw', description: 'Ask a quick side question — the answer stays out of the conversation', argumentHint: '<question>' },
            { name: 'permissions', description: 'View and edit allow, ask and deny rules' },
            { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>' },
            { name: 'review', description: 'Review a pull request', argumentHint: null, source: 'builtin' },
            { name: 'config', description: 'Open config panel', terminalOnly: true },
            { name: 'init', terminalOnly: false }
          ]
        }),
        text({ commands: [] })
      ].map((json) => ({ json, expected: parseChatCommandsResult(JSON.parse(json)) })),
      invalid: {
        params: [text({}), text({ tabId: 7 }), 'null'],
        results: [text({}), text({ commands: [{ description: 'no name' }] }), text({ commands: [{ name: 'x', description: 4 }] }), text({ commands: 'btw' }), '[]']
      }
    },
    btw: {
      params: [
        text({ tabId: 'tab-chat', question: 'what does the reducer do with removes?' }),
        text({ tabId: 'tab-chat', question: '  why?  ', extra: true })
      ].map((json) => ({ json, expected: parseChatBtwParams(JSON.parse(json)) })),
      results: [
        text({ response: 'It applies `removes` before `upserts`.' }),
        text({ response: null }),
        text({}),
        text({ response: 'API Error: overloaded', synthetic: true }),
        text({ response: 'ok', synthetic: false, extra: 1 })
      ].map((json) => ({ json, expected: parseChatBtwResult(JSON.parse(json)) })),
      invalid: {
        params: [
          text({ question: 'why?' }),
          text({ tabId: 'tab-chat' }),
          text({ tabId: 'tab-chat', question: '   ' }),
          text({ tabId: 'tab-chat', question: 'x'.repeat(20001) }),
          'null'
        ],
        results: [text({ response: 4 }), '[]', 'null']
      }
    },
    permissions: {
      params: [text({ tabId: 'tab-chat' }), text({ tabId: 'tab-chat', cwd: '/elsewhere' })].map((json) => ({ json, expected: parseChatPermissionsParams(JSON.parse(json)) })),
      results: [
        text({
          sources: [
            { kind: 'localSettings', path: '/Users/me/app/.claude/settings.local.json', exists: true, allow: ['Bash(npm test:*)', 'Read(./docs/**)'], ask: [], deny: ['Bash(rm -rf:*)'], defaultMode: 'acceptEdits' },
            { kind: 'projectSettings', path: '/Users/me/app/.claude/settings.json', exists: false, allow: [], ask: [], deny: [], error: null },
            { kind: 'policySettings', path: '/Library/Application Support/ClaudeCode/managed-settings.json', exists: true, allow: [], ask: [], deny: [] },
            { kind: 'userSettings', path: '/Users/me/.claude/settings.json', exists: true, allow: [], ask: [], deny: [], error: "Couldn't read it: Unexpected token } in JSON at position 41" }
          ]
        }),
        text({ sources: [] })
      ].map((json) => ({ json, expected: parseChatPermissionsResult(JSON.parse(json)) })),
      updateParams: [
        text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'allow', rule: 'Bash(npm test:*)', action: 'add' }),
        text({ tabId: 'tab-chat', kind: 'userSettings', behavior: 'deny', rule: ' WebFetch ', action: 'remove', extra: 1 })
      ].map((json) => ({ json, expected: parseChatPermissionsUpdateParams(JSON.parse(json)) })),
      invalid: {
        params: [text({}), 'null'],
        results: [
          text({}),
          text({ sources: [{ kind: 'localSettings', path: '/a', exists: true, allow: [], ask: [] }] }),
          text({ sources: [{ kind: 'localSettings', path: '/a', exists: 'yes', allow: [], ask: [], deny: [] }] }),
          text({ sources: [{ kind: 'localSettings', path: '/a', exists: true, allow: [1], ask: [], deny: [] }] }),
          '[]'
        ],
        updateParams: [
          text({ kind: 'localSettings', behavior: 'allow', rule: 'Read', action: 'add' }),
          text({ tabId: 'tab-chat', kind: 'managedSettings', behavior: 'allow', rule: 'Read', action: 'add' }),
          text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'always', rule: 'Read', action: 'add' }),
          text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'allow', rule: 'Read', action: 'toggle' }),
          text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'allow', rule: '  ', action: 'add' }),
          text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'allow', rule: 'x'.repeat(2001), action: 'add' }),
          text({ tabId: 'tab-chat', kind: 'localSettings', behavior: 'allow', action: 'add' }),
          'null'
        ]
      }
    }
  }
}

/** File name → exact file contents (pretty JSON, trailing newline). */
/** §7: registration signature, the sealed cap, payload sealing and `push.*` params. */
function push(): unknown {
  const phone = ed25519FromPrivate(seed('push-phone-ed25519'))
  const token = hex(seed('push-apns-token'))
  const ts = 1790000000
  const register = signPushRegister(phone.priv, phone.pub, token, 'sandbox', ts)

  const sealKey = seed('push-gateway-seal-key')
  const capNonce = seed('push-cap-nonce').subarray(0, 12)
  const capPayload = { d: deviceId(phone.pub), g: 3, t: token, e: 'sandbox' as const }
  const cap = sealPushCap(sealKey, capPayload, capNonce)
  if (JSON.stringify(openPushCap(sealKey, cap)) !== JSON.stringify(capPayload)) throw new Error('cap does not round-trip')

  const key = seed('push-payload-key')
  const keyId = seed('push-payload-key-id').subarray(0, 8)
  const nonce = seed('push-payload-nonce').subarray(0, 12)
  const payloads: { name: string; payload: PushPayload }[] = [
    {
      name: 'permission',
      payload: { v: 1, kind: 'permission', desktop: 'd'.repeat(32), tab: 'tab-chat', prompt: 'toolu_01', title: 'api-server / fix-auth', body: 'Bash · npm test', at: 1790000000000 }
    },
    {
      name: 'done without prompt',
      payload: { v: 1, kind: 'done', desktop: 'd'.repeat(32), tab: 'tab-chat', title: 'api-server / fix-auth', body: 'All 42 tests pass.', at: 1790000000001 }
    },
    {
      name: 'long body is cut',
      payload: { v: 1, kind: 'question', desktop: 'd'.repeat(32), tab: 'tab-chat', prompt: 'q1', title: 'x'.repeat(200), body: 'é'.repeat(1000), at: 1790000000002 }
    },
    {
      // Control characters escape to six bytes each, so 400 of them overflow 3072.
      name: 'body shortened to fit',
      payload: { v: 1, kind: 'plan', desktop: 'd'.repeat(32), tab: 'tab-chat', prompt: 'p1', title: 't', body: '\u0001'.repeat(400), at: 1790000000003 }
    }
  ]
  const sealed = payloads.map(({ name, payload }) => {
    const data = sealPushPayload(key, keyId, payload, nonce)
    return { name, input: payload, data, opened: openPushPayload(key, data) }
  })

  const params = [
    { op: 'push.register', params: { cap, key: b64uEncode(key), keyId: b64uEncode(keyId), kinds: ['permission', 'done', 'future-kind'] } },
    { op: 'push.unregister', params: {} }
  ].map((c) => ({ ...c, parsed: parsePushParams(c.op, c.params) }))

  return {
    register: {
      phone: ed25519Json(phone),
      token,
      env: 'sandbox',
      ts,
      message: text(new TextDecoder().decode(pushRegisterMessage(token, 'sandbox', ts))),
      body: register
    },
    cap: { sealKey: hex(sealKey), nonce: hex(capNonce), payload: capPayload, cap },
    payload: { key: hex(key), keyId: hex(keyId), nonce: hex(nonce), cases: sealed },
    params
  }
}

/** §10: a project's tile (initials and palette index) and its task place. */
function projectTiles(): unknown {
  const projects: { id: string; name: string; emoji?: string }[] = [
    { id: 'p-stem', name: 'stem-project' },
    { id: 'p-claude', name: 'claude-project' },
    { id: 'p-dmarc', name: 'dmarc' },
    { id: 'p-thumb', name: 'thumb' },
    { id: '6f1c2e9a-3b7d-4c55-9e0a-1d2f3a4b5c6d', name: 'DevTool' },
    { id: 'p-snake', name: 'my_api server' },
    { id: 'p-acronym', name: 'APIServer' },
    { id: 'p-digits', name: '2fa-app' },
    { id: 'p-single', name: 'x' },
    { id: 'p-unicode', name: 'école ßeta' },
    { id: 'p-cjk', name: '日本語' },
    { id: 'p-symbols', name: ' 🦀 ' },
    { id: 'p-empty', name: '' },
    { id: 'p-emoji', name: 'rust-tools', emoji: '🦀' }
  ]
  const places: { project: string; stream?: { name: string; isMain?: boolean }; place?: string }[] = [
    { project: 'claude-project' },
    { project: 'claude-project', stream: { name: 'main', isMain: true } },
    { project: 'claude-project', stream: { name: '0.6.0' } },
    { project: 'thumb', stream: { name: 'Chapter 1' } }
  ]
  return {
    description: 'Project tiles (§10): FNV-1a 32-bit of the UTF-8 project id, mod the palette length, picks the swatch; initials come from the name. Places join project and stream with " › ".',
    palette: PROJECT_TILE_PALETTE,
    tiles: projects.map((project) => ({ ...project, fnv1a32: fnv1a32(project.id), ...projectTile(project) })),
    places: places.map((c) => ({ ...c, place: taskPlace(c.project, c.stream) }))
  }
}

export function buildVectors(): Record<string, string> {
  const files: Record<string, unknown> = {
    'noise-ik.json': noiseIk(),
    'derive.json': derive(),
    'relay-auth.json': relayAuth(),
    'pairing-uri.json': pairingUri(),
    'app-messages.json': appMessages(),
    'fragments.json': fragments(),
    'chat-messages.json': chatMessages(),
    'push.json': push(),
    'project-tile.json': projectTiles()
  }
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [name, JSON.stringify(value, null, 2) + '\n']))
}

export const VECTORS_DIR = fileURLToPath(new URL('../vectors/', import.meta.url))

function main(): void {
  mkdirSync(VECTORS_DIR, { recursive: true })
  for (const [name, content] of Object.entries(buildVectors())) {
    writeFileSync(VECTORS_DIR + name, content)
    console.log(`wrote protocol/vectors/${name}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
