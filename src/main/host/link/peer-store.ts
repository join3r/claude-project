import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../../storage'
import type { ServerBuildInfo } from '../../../shared/servers'

/**
 * One paired peer of the host link: a server (on a desktop) or a desktop (on a
 * server). Keys are raw 32-byte public keys, base64url without padding.
 */
export interface PeerRecord {
  /** Device ID: hex of the first 16 bytes of SHA-256(ed25519Pub). */
  id: string
  name: string
  x25519Pub: string
  ed25519Pub: string
  /** Epoch ms. */
  pairedAt: number
  /** Epoch ms; null until the peer is seen after pairing. */
  lastSeen: number | null
  /** What its last handshake said about its build. */
  build?: ServerBuildInfo
}

const B64U_32 = /^[A-Za-z0-9_-]{43}$/
const DEVICE_ID = /^[0-9a-f]{32}$/

function isRecord(value: unknown): value is PeerRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && DEVICE_ID.test(r.id)
    && typeof r.name === 'string'
    && typeof r.x25519Pub === 'string' && B64U_32.test(r.x25519Pub)
    && typeof r.ed25519Pub === 'string' && B64U_32.test(r.ed25519Pub)
    && typeof r.pairedAt === 'number' && Number.isFinite(r.pairedAt)
    && (r.lastSeen === null || r.lastSeen === undefined || (typeof r.lastSeen === 'number' && Number.isFinite(r.lastSeen)))
}

function isBuild(value: unknown): value is ServerBuildInfo {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  return ['version', 'commit', 'builtAt', 'bundleSha'].every((key) => typeof b[key] === 'string')
}

/**
 * The peers one side of the host link paired with: a desktop's servers
 * (`<configDir>/servers/servers.json`) or a server's desktops
 * (`<data>/desktops.json`). The relay keeps its own pairs for routing; only this
 * file says which Noise key each peer must prove.
 */
export class PeerStore {
  private readonly file: string
  private records: PeerRecord[]

  constructor(private readonly dir: string, fileName: string, private readonly log: (message: string) => void = () => {}) {
    this.file = path.join(dir, fileName)
    this.records = this.load()
  }

  list(): PeerRecord[] {
    return this.records.map((r) => ({ ...r }))
  }

  get(id: string): PeerRecord | null {
    const found = this.records.find((r) => r.id === id)
    return found ? { ...found } : null
  }

  has(id: string): boolean {
    return this.records.some((r) => r.id === id)
  }

  /** Adds, or replaces the record with the same id (the server paired again). */
  add(record: PeerRecord): void {
    this.records = [...this.records.filter((r) => r.id !== record.id), { ...record }]
    this.persist()
  }

  remove(id: string): boolean {
    const next = this.records.filter((r) => r.id !== id)
    if (next.length === this.records.length) return false
    this.records = next
    this.persist()
    return true
  }

  touchLastSeen(id: string, at: number): void {
    const current = this.records.find((r) => r.id === id)
    if (!current || (current.lastSeen !== null && current.lastSeen >= at)) return
    this.update(id, { lastSeen: at })
  }

  setBuild(id: string, build: ServerBuildInfo): void {
    const current = this.records.find((r) => r.id === id)
    if (!current || JSON.stringify(current.build) === JSON.stringify(build)) return
    this.update(id, { build: { ...build } })
  }

  private update(id: string, patch: Partial<PeerRecord>): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, ...patch } : r))
    this.persist()
  }

  private load(): PeerRecord[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.log(`peerStore file=${this.file} unreadable error=${String(err)}`)
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) throw new Error('top-level JSON value is not an array')
      return parsed.filter(isRecord).map((r) => {
        const { build, ...rest } = r
        return { ...rest, lastSeen: r.lastSeen ?? null, ...(isBuild(build) ? { build } : {}) }
      })
    } catch (err) {
      this.log(`peerStore file=${this.file} corrupt error=${String(err)}`)
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      } catch {
        // The next save replaces it.
      }
      return []
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(this.file, JSON.stringify(this.records, null, 2), 0o600)
  }
}
