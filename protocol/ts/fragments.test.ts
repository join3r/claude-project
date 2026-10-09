import { describe, expect, it } from 'vitest'
import { utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { generateX25519 } from './keys.ts'
import { NOISE_MAX_MESSAGE, createInitiator, createResponder } from './noise.ts'
import {
  FRAGMENT_CHUNK,
  FRAGMENT_HEADER,
  FramedTransport,
  MAX_FRAGMENTS,
  MAX_REASSEMBLED,
  PARTIAL_TIMEOUT_MS,
  Reassembler,
  fragmentMessage
} from './fragments.ts'
import {
  ChatLimits,
  capText,
  parseBranchesListParams,
  parseBranchesListResult,
  parseStreamNewParams,
  parseTaskNewParams,
  parseChatParams,
  parseChatResult,
  parseChatViewItem,
  parseChatViewPrompt
} from './chat-messages.ts'

function jsonOf(size: number): Uint8Array {
  const head = '{"pad":"'
  const tail = '"}'
  return utf8Encode(head + 'a'.repeat(size - head.length - tail.length) + tail)
}

function frag(id: number, i: number, n: number, chunk: Uint8Array | string): Uint8Array {
  const body = typeof chunk === 'string' ? utf8Encode(chunk) : chunk
  const out = new Uint8Array(FRAGMENT_HEADER + body.length)
  const view = new DataView(out.buffer)
  out[0] = 1
  view.setUint32(1, id)
  view.setUint16(5, i)
  view.setUint16(7, n)
  out.set(body, FRAGMENT_HEADER)
  return out
}

function pair(): { phone: FramedTransport; desktop: FramedTransport } {
  const phoneStatic = generateX25519()
  const desktopStatic = generateX25519()
  const prologue = utf8Encode('test')
  const initiator = createInitiator({ prologue, s: phoneStatic, rs: desktopStatic.pub })
  const responder = createResponder({ prologue, s: desktopStatic })
  responder.readMessage(initiator.writeMessage(new Uint8Array(0)))
  initiator.readMessage(responder.writeMessage(new Uint8Array(0)))
  return { phone: new FramedTransport(initiator.split()), desktop: new FramedTransport(responder.split()) }
}

describe('fragmentMessage', () => {
  it('sends a message up to the chunk size whole', () => {
    const json = jsonOf(FRAGMENT_CHUNK)
    expect(fragmentMessage(json, 0)).toEqual([json])
  })

  it('splits a larger one into 60000-byte chunks with a header', () => {
    const json = jsonOf(FRAGMENT_CHUNK * 2 + 5)
    const parts = fragmentMessage(json, 0xdeadbeef)
    expect(parts.map((p) => p.length)).toEqual([FRAGMENT_CHUNK + 9, FRAGMENT_CHUNK + 9, 5 + 9])
    const view = new DataView(parts[2].buffer)
    expect([parts[2][0], view.getUint32(1), view.getUint16(5), view.getUint16(7)]).toEqual([1, 0xdeadbeef, 2, 3])
  })

  it('refuses a message over 4 MiB and ids outside u32', () => {
    expect(() => fragmentMessage(new Uint8Array(MAX_REASSEMBLED + 1).fill(0x7b), 0)).toThrow(ProtocolError)
    expect(() => fragmentMessage(jsonOf(FRAGMENT_CHUNK + 1), -1)).toThrow(ProtocolError)
    expect(() => fragmentMessage(jsonOf(FRAGMENT_CHUNK + 1), 2 ** 32)).toThrow(ProtocolError)
  })

  it('a 4 MiB message fits in MAX_FRAGMENTS and reassembles', () => {
    const json = jsonOf(MAX_REASSEMBLED)
    const parts = fragmentMessage(json, 1)
    expect(parts.length).toBe(MAX_FRAGMENTS)
    const r = new Reassembler()
    const outs = parts.map((p) => r.push(p))
    expect(Buffer.from(outs.at(-1)!).equals(Buffer.from(json))).toBe(true)
  })
})

describe('Reassembler', () => {
  it('drops a partial message after 30 s', () => {
    let now = 0
    const logs: string[] = []
    const r = new Reassembler({ now: () => now, log: (m) => logs.push(m) })
    expect(r.push(frag(1, 0, 2, '{"a":'))).toBeNull()
    now = PARTIAL_TIMEOUT_MS - 1
    expect(r.pending).toBe(1)
    now = PARTIAL_TIMEOUT_MS
    expect(r.push(frag(1, 1, 2, '1}'))).toBeNull()
    expect(logs.some((l) => l.includes('incomplete'))).toBe(true)
    // The late chunk started a new partial message, which never completes.
    expect(r.pending).toBe(1)
  })

  it('drops oversized chunks and a message that grows past 4 MiB', () => {
    const r = new Reassembler()
    expect(r.push(frag(1, 0, 2, new Uint8Array(FRAGMENT_CHUNK + 1)))).toBeNull()
    expect(r.pending).toBe(0)
    expect(r.push(frag(2, 0, MAX_FRAGMENTS + 1, 'x'))).toBeNull()
    expect(r.pending).toBe(0)
  })

  it('passes whole JSON through and ignores other first bytes', () => {
    const r = new Reassembler()
    expect(r.push(utf8Encode('{}'))).toEqual(utf8Encode('{}'))
    expect(r.push(new Uint8Array([0x02, 0x7b]))).toBeNull()
    expect(r.push(new Uint8Array(0))).toBeNull()
  })
})

describe('FramedTransport', () => {
  it('round-trips small and fragmented messages over Noise, each ciphertext within the Noise limit', () => {
    const { phone, desktop } = pair()
    for (const size of [2, FRAGMENT_CHUNK, FRAGMENT_CHUNK + 1, 150000, 1_000_000]) {
      const json = jsonOf(Math.max(size, 12))
      const sealed = desktop.seal(json)
      expect(sealed.every((c) => c.length <= NOISE_MAX_MESSAGE)).toBe(true)
      const outs = sealed.map((c) => phone.open(c))
      expect(outs.slice(0, -1).every((o) => o === null)).toBe(true)
      expect(utf8Decode(outs.at(-1)!) === utf8Decode(json)).toBe(true)
    }
    // The other direction has its own counter.
    const back = phone.seal(jsonOf(70000))
    expect(new DataView(desktop.transport.decrypt(back[0]).buffer).getUint32(1)).toBe(0)
  })

  it('throws when a ciphertext does not decrypt', () => {
    const { phone } = pair()
    expect(() => phone.open(new Uint8Array(32))).toThrow()
  })
})

describe('chat parsers', () => {
  it('keeps an unknown item or prompt kind as unknown', () => {
    expect(parseChatViewItem({ kind: 'chart', id: 'c1', data: [] })).toEqual({ kind: 'unknown', id: 'c1', unknownKind: 'chart' })
    expect(parseChatViewPrompt({ kind: 'form', id: 'f' })).toEqual({ kind: 'unknown', id: 'f', unknownKind: 'form' })
  })

  it('validates chat params', () => {
    expect(parseChatParams('inbox.get', undefined)).toBeNull()
    expect(() => parseChatParams('chat.send', { tabId: 't', text: 'x'.repeat(ChatLimits.send + 1) })).toThrow(ProtocolError)
    expect(parseChatParams('chat.send', { tabId: 't', text: 'x'.repeat(ChatLimits.send) })).toMatchObject({ tabId: 't' })
    expect(parseChatResult('chat.send', { anything: 1 })).toEqual({})
  })

  it('parses task.new (§8.4) and caps its prompt like chat.send', () => {
    expect(parseTaskNewParams({ projectId: 'p1', prompt: 'Go', mode: 'plan' })).toEqual({ projectId: 'p1', prompt: 'Go', mode: 'plan' })
    expect(() => parseTaskNewParams({ projectId: 'p1', prompt: 'x'.repeat(ChatLimits.send + 1) })).toThrow(ProtocolError)
    expect(parseTaskNewParams({ projectId: 'p1', prompt: 'x'.repeat(ChatLimits.send) }).prompt).toHaveLength(ChatLimits.send)
    expect(parseChatParams('task.new', { projectId: 'p1', prompt: 'Go' })).toBeNull()
  })

  it('parses task.new images (§8.4) within their caps', () => {
    const png = { mediaType: 'image/png', data: 'iVBO' }
    expect(parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [png] })).toEqual({ projectId: 'p1', prompt: 'Go', images: [png] })
    expect(parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [] })).toEqual({ projectId: 'p1', prompt: 'Go' })
    expect(() => parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [{ mediaType: 'image/tiff', data: 'x' }] })).toThrow(ProtocolError)
    expect(() => parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [{ mediaType: 'image/png', data: '' }] })).toThrow(ProtocolError)
    expect(() => parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: Array(ChatLimits.sentImages + 1).fill(png) })).toThrow(ProtocolError)
    const half = { mediaType: 'image/jpeg', data: 'x'.repeat(ChatLimits.sentImageData / 2) }
    expect(parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [half, half] }).images).toHaveLength(2)
    expect(() => parseTaskNewParams({ projectId: 'p1', prompt: 'Go', images: [half, half, png] })).toThrow(ProtocolError)
  })

  it('parses chat.send images (§6.3) like task.new', () => {
    const png = { mediaType: 'image/png', data: 'iVBO' }
    expect(parseChatParams('chat.send', { tabId: 't', text: 'Look', images: [png] })).toEqual({ tabId: 't', text: 'Look', images: [png] })
    expect(parseChatParams('chat.send', { tabId: 't', text: 'Look', images: [] })).toEqual({ tabId: 't', text: 'Look' })
    expect(() => parseChatParams('chat.send', { tabId: 't', text: 'Look', images: [{ mediaType: 'image/bmp', data: 'x' }] })).toThrow(ProtocolError)
  })

  it('parses stream.new (§8.12): trims, drops branch fields without a worktree, names no tab', () => {
    expect(parseStreamNewParams({ projectId: 'p1', name: ' 0.6.0 ', worktree: true, branch: ' 0.6.0 ', baseBranch: 'main' }))
      .toEqual({ projectId: 'p1', name: '0.6.0', worktree: true, branch: '0.6.0', baseBranch: 'main' })
    expect(parseStreamNewParams({ projectId: 'p1', name: 'Docs', worktree: false, branch: 'docs', baseBranch: 'main' }))
      .toEqual({ projectId: 'p1', name: 'Docs', worktree: false })
    expect(() => parseStreamNewParams({ projectId: 'p1', name: '  ', worktree: false })).toThrow(ProtocolError)
    expect(() => parseStreamNewParams({ projectId: 'p1', name: 'x', worktree: 'yes' })).toThrow(ProtocolError)
    expect(() => parseStreamNewParams({ projectId: 'p1', name: 'x', worktree: true, branch: ' ' })).toThrow(ProtocolError)
    expect(parseChatParams('stream.new', { projectId: 'p1', name: 'x', worktree: false })).toBeNull()
  })

  it('parses branches.list (§8.13)', () => {
    expect(parseBranchesListParams({ projectId: 'p1', extra: 1 })).toEqual({ projectId: 'p1' })
    expect(() => parseBranchesListParams({})).toThrow(ProtocolError)
    expect(parseBranchesListResult({ branches: ['main', 'dev'], defaultBase: 'main' })).toEqual({ branches: ['main', 'dev'], defaultBase: 'main' })
    expect(() => parseBranchesListResult({ branches: [1], defaultBase: '' })).toThrow(ProtocolError)
    expect(parseChatParams('chat.new', { taskId: 't1' })).toBeNull()
  })

  it('capText cuts to the limit with an ellipsis and never splits a surrogate pair', () => {
    expect(capText('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(capText('abcdef', 4)).toEqual({ text: 'abc…', truncated: true })
    const emoji = 'ab😀cd'
    const cut = capText(emoji, 4).text
    expect(cut.length).toBeLessThanOrEqual(4)
    expect(cut).toBe('ab…')
  })
})
