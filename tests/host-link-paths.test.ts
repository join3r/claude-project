import { describe, expect, it } from 'vitest'
import { LinkPaths, PATH_MESSAGE_TYPE } from '../src/main/host/link/paths'
import type { LinkTransport } from '../src/main/host/link/session'

/** A transport that records what was sent through it. */
function recorder(): LinkTransport & { sent: Uint8Array[]; up: boolean } {
  const t = {
    sent: [] as Uint8Array[],
    up: true,
    send(plaintext: Uint8Array) {
      if (!t.up) return false
      t.sent.push(plaintext)
      return true
    },
    congested: () => false,
    whenDrained: (fn: () => void) => fn()
  }
  return t
}

const msg = (n: number) => new Uint8Array([0x12, n])

describe('LinkPaths (protocol/SERVER.md §13.5)', () => {
  it('sends a path marker as the last relay message, then everything over the pipe', () => {
    const relay = recorder()
    const direct = recorder()
    const paths = new LinkPaths(relay, () => {}, () => {})
    paths.send(msg(1))
    expect(paths.useDirect(direct)).toBe(true)
    paths.send(msg(2))
    expect(relay.sent.map((m) => m[0])).toEqual([0x12, PATH_MESSAGE_TYPE])
    expect(direct.sent).toEqual([msg(2)])
    expect(paths.sendingDirect).toBe(true)
    expect(paths.onDirect).toBe(true)
  })

  it('holds pipe messages until the marker comes through the relay, keeping order', () => {
    const got: number[] = []
    const relayOut = recorder()
    const directOut = recorder()
    const peer = new LinkPaths(relayOut, () => {}, () => {})
    const receiver = new LinkPaths(recorder(), (m) => got.push(m[1]), () => {})
    // The peer sends 1 on the relay, moves, then 2 and 3 on the pipe.
    peer.send(msg(1))
    peer.useDirect(directOut)
    peer.send(msg(2))
    peer.send(msg(3))
    // The pipe is faster: 2 and 3 arrive before the relay delivers 1 and the marker.
    for (const m of directOut.sent) receiver.fromDirect(m)
    expect(got).toEqual([])
    expect(receiver.onDirect).toBe(false)
    for (const m of relayOut.sent) receiver.fromRelay(m)
    expect(got).toEqual([1, 2, 3])
    expect(receiver.onDirect).toBe(true)
    receiver.fromDirect(msg(4))
    expect(got).toEqual([1, 2, 3, 4])
  })

  it('refuses to move when the marker cannot go out', () => {
    const relay = recorder()
    relay.up = false
    const paths = new LinkPaths(relay, () => {}, () => {})
    expect(paths.useDirect(recorder())).toBe(false)
    expect(paths.onDirect).toBe(false)
  })

  it('gives up when the pipe brings too much before the marker', () => {
    const failures: string[] = []
    const paths = new LinkPaths(recorder(), () => {}, (why) => failures.push(why))
    const big = new Uint8Array(4 * 1024 * 1024)
    for (let i = 0; i < 5; i++) paths.fromDirect(big)
    expect(failures).toHaveLength(1)
  })
})
