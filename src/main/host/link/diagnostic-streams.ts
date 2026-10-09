import { createHash } from 'crypto'
import { once } from 'events'
import type { LinkStream, StreamHandler } from './stream'

/**
 * Stream kinds for checking a link end to end (protocol/SERVER.md §6.3). A server
 * serves all three; they read and write only the bytes the desktop sends or asks
 * for, so they are harmless on a real server and double as a speed test.
 *
 * - `echo`: writes back everything it reads, then ends.
 * - `sink`: reads to the end (pausing `delayMs` after each chunk, to play a slow
 *   reader), then writes `{"bytes":N,"sha256":"<hex>"}` and ends.
 * - `source`: writes `bytes` bytes of {@link sourceByte}, then ends.
 */
export const DIAGNOSTIC_STREAM_KINDS = ['echo', 'sink', 'source'] as const

/** Most bytes one `source` stream produces. */
export const SOURCE_MAX_BYTES = 4 * 1024 * 1024 * 1024
const MAX_DELAY_MS = 1000
const SOURCE_CHUNK = 64 * 1024

/** Byte `i` of a `source` stream with `seed`: easy to check on the other end. */
export function sourceByte(i: number, seed: number): number {
  return (i * 31 + seed + (i >>> 8)) & 0xff
}

/** `count` bytes of a `source` stream starting at byte `start`. */
export function sourceBytes(start: number, count: number, seed: number): Uint8Array {
  const out = new Uint8Array(count)
  for (let k = 0; k < count; k++) out[k] = sourceByte(start + k, seed)
  return out
}

function param(params: unknown, key: string): unknown {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[key] : undefined
}

function intParam(params: unknown, key: string, max: number, fallback: number): number {
  const value = param(params, key)
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${key} must be an integer from 0 to ${max}`)
  }
  return value
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Writes `chunk`, then waits for room (or for the stream to go away). */
async function write(stream: LinkStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk) || stream.destroyed) return
  const abort = new AbortController()
  await Promise.race([
    once(stream, 'drain', { signal: abort.signal }),
    once(stream, 'close', { signal: abort.signal })
  ]).catch(() => {}).finally(() => abort.abort())
}

const echo: StreamHandler = (stream) => {
  stream.pipe(stream)
}

const sink: StreamHandler = async (stream) => {
  const delayMs = intParam(stream.params, 'delayMs', MAX_DELAY_MS, 0)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
    if (delayMs > 0) await sleep(delayMs)
  }
  stream.end(Buffer.from(JSON.stringify({ bytes, sha256: hash.digest('hex') })))
}

const source: StreamHandler = async (stream) => {
  const total = intParam(stream.params, 'bytes', SOURCE_MAX_BYTES, 0)
  const seed = intParam(stream.params, 'seed', 255, 0)
  // Nothing comes the other way; reading lets the stream finish once both ends are done.
  stream.resume()
  for (let sent = 0; sent < total && !stream.destroyed;) {
    const n = Math.min(SOURCE_CHUNK, total - sent)
    await write(stream, sourceBytes(sent, n, seed))
    sent += n
  }
  stream.end()
}

export function diagnosticStreamKinds(): Map<string, StreamHandler> {
  return new Map<string, StreamHandler>([['echo', echo], ['sink', sink], ['source', source]])
}
