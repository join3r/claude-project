import fs from 'fs'
import path from 'path'
import { utf8Decode, utf8Encode } from '../../../../protocol/ts/index.ts'
import { MANIFEST_FILE, bundleFiles, bundleSha256 } from '../../../../scripts/server-bundle.mjs'

/**
 * The `bundle` stream's payload (protocol/SERVER.md §6.3): a server bundle
 * (`out/server/`) as one byte stream the desktop writes and the server unpacks. A
 * tiny format of our own, so a Windows desktop can send one without `tar`:
 *
 *     magic "DTBUNDL1"  indexLength:u32be  index (UTF-8 JSON)  file bytes...
 *     index = { v: 1, files: [{ p: "<posix path>", n: <bytes>, x?: 1 }] }
 *
 * The files follow in index order, back to back. `x: 1` marks an executable
 * (0755); every other file is 0644. The archive holds every file of the bundle,
 * `manifest.json` included; the server checks the unpacked tree against the
 * manifest's `sha256` (scripts/server-bundle.mjs) before it uses it.
 */

export const BUNDLE_MAGIC = 'DTBUNDL1'
/** Most bytes one archive may hold (the bundle is about 3 MiB). */
export const BUNDLE_MAX_BYTES = 256 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const READ_CHUNK = 256 * 1024

/** `manifest.json` of a server bundle (scripts/build-server.mjs). */
export interface BundleManifest {
  version: string
  commit: string
  builtAt: string
  /** The host link protocol it speaks. */
  protocol: number
  /** The Node version it runs on. */
  node: string
  sha256: string
}

/** A bundle on disk: its dir and manifest. */
export interface LocalBundle {
  dir: string
  manifest: BundleManifest
}

interface IndexEntry {
  p: string
  n: number
  x?: 1
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** A manifest with every field a server needs, or null. */
export function parseBundleManifest(value: unknown): BundleManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const m = value as Record<string, unknown>
  if (typeof m.version !== 'string' || !m.version || m.version.length > 64) return null
  if (typeof m.commit !== 'string' || m.commit.length > 64) return null
  if (typeof m.builtAt !== 'string' || Number.isNaN(Date.parse(m.builtAt))) return null
  if (typeof m.protocol !== 'number' || !Number.isInteger(m.protocol) || m.protocol < 1) return null
  if (typeof m.node !== 'string' || !NODE_VERSION.test(m.node)) return null
  if (typeof m.sha256 !== 'string' || !SHA256_HEX.test(m.sha256)) return null
  return { version: m.version, commit: m.commit, builtAt: m.builtAt, protocol: m.protocol, node: m.node, sha256: m.sha256 }
}

/** The bundle in `dir`, or null when there is none (or its manifest is incomplete). */
export function readLocalBundle(dir: string): LocalBundle | null {
  try {
    const manifest = parseBundleManifest(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')))
    return manifest ? { dir, manifest } : null
  } catch {
    return null
  }
}

/** A relative POSIX path that stays inside the bundle dir. */
export function isSafeBundlePath(p: string): boolean {
  if (!p || p.length > 512 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** The archive of the bundle in `dir`: its total size and its bytes, read file by file. */
export function packBundle(dir: string): { total: number; chunks: () => AsyncGenerator<Uint8Array> } {
  const files = [...bundleFiles(dir), MANIFEST_FILE]
  const entries: IndexEntry[] = files.map((p) => {
    const stat = fs.statSync(path.join(dir, p))
    // Windows has no x bit: the only executables a bundle has are node-pty's spawn-helpers.
    const executable = process.platform === 'win32' ? path.posix.basename(p) === 'spawn-helper' : (stat.mode & 0o111) !== 0
    return { p, n: stat.size, ...(executable ? { x: 1 as const } : {}) }
  })
  const index = utf8Encode(JSON.stringify({ v: 1, files: entries }))
  const header = new Uint8Array(BUNDLE_MAGIC.length + 4 + index.length)
  header.set(utf8Encode(BUNDLE_MAGIC), 0)
  new DataView(header.buffer).setUint32(BUNDLE_MAGIC.length, index.length)
  header.set(index, BUNDLE_MAGIC.length + 4)
  const total = header.length + entries.reduce((sum, e) => sum + e.n, 0)
  return {
    total,
    chunks: async function* () {
      yield header
      for (const entry of entries) {
        const handle = await fs.promises.open(path.join(dir, entry.p), 'r')
        try {
          let left = entry.n
          while (left > 0) {
            const buffer = Buffer.alloc(Math.min(READ_CHUNK, left))
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
            if (bytesRead === 0) throw new Error(`${entry.p} shrank while it was being sent`)
            left -= bytesRead
            yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
          }
        } finally {
          await handle.close()
        }
      }
    }
  }
}

/** Reads exactly what the archive says from an async byte source. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array | Buffer>
  private buffer: Uint8Array = new Uint8Array(0)
  private offset = 0
  total = 0

  constructor(source: AsyncIterable<Uint8Array | Buffer>, private readonly maxBytes: number) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  /** Up to `max` bytes, at least 1; null at the end. */
  async some(max: number): Promise<Uint8Array | null> {
    if (this.offset >= this.buffer.length) {
      const next = await this.iterator.next()
      if (next.done) return null
      const chunk = next.value
      this.buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      this.offset = 0
      this.total += this.buffer.length
      if (this.total > this.maxBytes) throw new Error(`the bundle is over ${this.maxBytes} bytes`)
      if (this.buffer.length === 0) return this.some(max)
    }
    const n = Math.min(max, this.buffer.length - this.offset)
    const out = this.buffer.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  async exactly(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const part = await this.some(n - filled)
      if (!part) throw new Error('the bundle ended early')
      out.set(part, filled)
      filled += part.length
    }
    return out
  }

  async atEnd(): Promise<boolean> {
    return (await this.some(1)) === null
  }
}

/**
 * Unpacks an archive from `source` into `dest` (which must not exist yet). Throws on
 * a malformed archive, an unsafe path, or more than `maxBytes`; the caller removes
 * `dest` then. Does not check the content hash: see {@link verifyBundle}.
 */
export async function unpackBundle(source: AsyncIterable<Uint8Array | Buffer>, dest: string, maxBytes = BUNDLE_MAX_BYTES): Promise<{ files: number; bytes: number }> {
  const reader = new ByteReader(source, maxBytes)
  const magic = utf8Decode(await reader.exactly(BUNDLE_MAGIC.length))
  if (magic !== BUNDLE_MAGIC) throw new Error('not a DevTool server bundle')
  const lengthBytes = await reader.exactly(4)
  const indexLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0)
  if (indexLength > MAX_INDEX_BYTES) throw new Error('the bundle index is too large')
  let index: { v?: unknown; files?: unknown }
  try {
    index = JSON.parse(utf8Decode(await reader.exactly(indexLength))) as typeof index
  } catch {
    throw new Error('the bundle index is not JSON')
  }
  if (index.v !== 1 || !Array.isArray(index.files) || index.files.length > MAX_FILES) throw new Error('unknown bundle index')
  const seen = new Set<string>()
  const entries: IndexEntry[] = index.files.map((raw: unknown) => {
    const e = raw as Partial<IndexEntry>
    if (typeof e.p !== 'string' || !isSafeBundlePath(e.p)) throw new Error(`unsafe path in the bundle: ${String(e.p)}`)
    if (typeof e.n !== 'number' || !Number.isSafeInteger(e.n) || e.n < 0) throw new Error(`bad size for ${e.p}`)
    const key = e.p.toLowerCase()
    if (seen.has(key)) throw new Error(`${e.p} is in the bundle twice`)
    seen.add(key)
    return { p: e.p, n: e.n, ...(e.x === 1 ? { x: 1 as const } : {}) }
  })
  fs.mkdirSync(dest, { recursive: false, mode: 0o755 })
  let bytes = 0
  for (const entry of entries) {
    const target = path.join(dest, ...entry.p.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
    const handle = await fs.promises.open(target, 'wx', entry.x ? 0o755 : 0o644)
    try {
      let left = entry.n
      while (left > 0) {
        const part = await reader.some(left)
        if (!part) throw new Error(`the bundle ended inside ${entry.p}`)
        await handle.write(part)
        left -= part.length
      }
    } finally {
      await handle.close()
    }
    // The umask may have taken the x bit away.
    if (entry.x) fs.chmodSync(target, 0o755)
    bytes += entry.n
  }
  if (!(await reader.atEnd())) throw new Error('the bundle has bytes past its last file')
  return { files: entries.length, bytes }
}

/**
 * The unpacked bundle's manifest, once its content hash matches both the manifest's
 * and `expectedSha` (what the desktop said it sent). Throws otherwise.
 */
export function verifyBundle(dir: string, expectedSha: string): BundleManifest {
  const bundle = readLocalBundle(dir)
  if (!bundle) throw new Error('the bundle has no valid manifest.json')
  if (bundle.manifest.sha256 !== expectedSha) throw new Error(`the bundle's manifest says ${bundle.manifest.sha256}, the desktop said ${expectedSha}`)
  const actual = bundleSha256(dir)
  if (actual !== expectedSha) throw new Error(`the bundle's content hash is ${actual}, expected ${expectedSha}`)
  return bundle.manifest
}
