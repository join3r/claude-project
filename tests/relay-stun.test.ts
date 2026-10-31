import { createSocket } from 'node:dgram'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { bindingResponse, bindingTransaction, startStunServer, type StunServer } from '../relay/src/stun.ts'
import { createLogger } from '../relay/src/log.ts'
import { loadDirect } from '../src/main/host/link/direct'

const log = createLogger('error')
const servers: StunServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

function request(transaction: Uint8Array): Uint8Array {
  const out = new Uint8Array(20)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0x0001)
  view.setUint16(2, 0)
  view.setUint32(4, 0x2112a442)
  out.set(transaction, 8)
  return out
}

/** XOR-MAPPED-ADDRESS → "address:port". */
function mapped(response: Uint8Array): string {
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength)
  expect(view.getUint16(0)).toBe(0x0101)
  expect(view.getUint16(20)).toBe(0x0020)
  const family = view.getUint8(25)
  const port = view.getUint16(26) ^ 0x2112
  if (family === 0x01) {
    const bytes = [0, 1, 2, 3].map((i) => response[28 + i] ^ response[4 + i])
    return `${bytes.join('.')}:${port}`
  }
  const bytes = Array.from({ length: 16 }, (_, i) => response[28 + i] ^ response[4 + i])
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16))
  return `[${groups.join(':')}]:${port}`
}

describe('relay STUN responder', () => {
  it('answers a Binding Request with the XOR-mapped address and a valid fingerprint', () => {
    const tx = Uint8Array.from({ length: 12 }, (_, i) => i * 7)
    expect(bindingTransaction(request(tx))).toEqual(tx)
    const response = bindingResponse(tx, '203.0.113.9', 40000)
    expect(mapped(response)).toBe('203.0.113.9:40000')
    expect(response.subarray(8, 20)).toEqual(tx)
    const view = new DataView(response.buffer)
    const at = response.length - 8
    expect(view.getUint16(at)).toBe(0x8028)
    expect(view.getUint32(at + 4)).toBe((crc32(response.subarray(0, at)) ^ 0x5354554e) >>> 0)
    expect(mapped(bindingResponse(tx, '2001:db8::1', 5))).toBe('[2001:db8:0:0:0:0:0:1]:5')
  })

  it('ignores what isn\'t a Binding Request', () => {
    const tx = new Uint8Array(12)
    const wrongType = request(tx)
    wrongType[1] = 0x03
    expect(bindingTransaction(wrongType)).toBeNull()
    const noCookie = request(tx)
    noCookie[4] = 0
    expect(bindingTransaction(noCookie)).toBeNull()
    expect(bindingTransaction(new Uint8Array(10))).toBeNull()
    expect(bindingTransaction(new Uint8Array(2000))).toBeNull()
  })

  it('tells a UDP client its own address and port', async () => {
    const stun = await startStunServer({ port: 0, host: '127.0.0.1', logger: log })
    servers.push(stun)
    const socket = createSocket('udp4')
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
    const reply = new Promise<Uint8Array>((resolve) => socket.once('message', (m) => resolve(new Uint8Array(m))))
    socket.send(request(new Uint8Array(12).fill(9)), stun.port, '127.0.0.1')
    expect(mapped(await reply)).toBe(`127.0.0.1:${socket.address().port}`)
    socket.close()
  })

  it('is enough for libdatachannel to gather a server-reflexive candidate', { timeout: 20_000 }, async () => {
    const api = await loadDirect(() => {})
    if (!api) throw new Error('node-datachannel did not load')
    const stun = await startStunServer({ port: 0, host: '127.0.0.1', logger: log })
    servers.push(stun)
    const offer = await api.offer({ iceServers: [`stun:127.0.0.1:${stun.port}`], log: () => {} })
    offer.close()
    // On loopback the reflexive address equals a host one, which libjuice may fold
    // away; what matters is that gathering completed with candidates.
    expect(offer.signal.candidates.length).toBeGreaterThan(0)
    expect(offer.signal.sdp).toContain('a=ice-ufrag')
  })
})
