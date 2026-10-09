import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type { Role } from '../../protocol/ts/index.ts'

/**
 * The relay's only durable state (§3.6): which devices are paired, with both Ed25519
 * public keys. Offers, pending peers and lastSeen live in memory. A push gateway
 * (§7.1) also keeps one generation counter per registered device.
 */

/**
 * One authorized pair (§3.8). The owner is the side that made the offer and sent
 * `authorize`; `kind` is the peer's role. There is at most one pair per two devices,
 * in one orientation.
 */
export interface Pair {
  ownerId: string
  ownerRole: Role
  /** b64u Ed25519 public key of the owner. */
  ownerPub: string
  peerId: string
  /** The peer's role: `phone` for every pair made before servers existed. */
  kind: Role
  /** b64u Ed25519 public key of the peer. */
  peerPub: string
  /** Unix ms. */
  createdAt: number
}

export interface RelayStore {
  /** The pair `ownerId` authorized for `peerId`, in that orientation only. */
  getPair(ownerId: string, peerId: string): Pair | null
  /** The pair between `a` and `b`, whichever of them owns it. */
  findPair(a: string, b: string): Pair | null
  /** Inserts or replaces the pair, and drops one in the other orientation. */
  putPair(pair: Pair): void
  /** Deletes the pair between `a` and `b` in either orientation. Returns whether one was deleted. */
  deletePair(a: string, b: string): boolean
  /** Every pair `id` is part of, as owner or as peer. */
  pairsOf(id: string): Pair[]
  close(): void
}

/** §7.1 `push_devices`: the current push generation of each device. No tokens. */
export interface PushStore {
  /** The device's current generation, 0 if it never registered. */
  pushGeneration(deviceId: string): number
  /** A new registration: bumps the generation (first one is 1) and returns it. */
  bumpPushGeneration(deviceId: string, now: number): number
  /**
   * Retires `generation` if it is still the current one (APNs said the token is dead),
   * so a registration that raced ahead of it isn't invalidated. Returns whether it did.
   */
  retirePushGeneration(deviceId: string, generation: number, now: number): boolean
}

const phonesOf = (pairs: Pair[], hostId: string): string[] =>
  pairs.filter((p) => p.ownerId === hostId && p.kind === 'phone').map((p) => p.peerId)
const hostsOf = (pairs: Pair[], phoneId: string): string[] =>
  pairs.filter((p) => p.peerId === phoneId && p.kind === 'phone').map((p) => p.ownerId)

export class MemoryStore implements RelayStore, PushStore {
  readonly #pairs = new Map<string, Pair>()
  readonly #push = new Map<string, number>()

  #key(ownerId: string, peerId: string): string {
    return `${ownerId}:${peerId}`
  }

  getPair(ownerId: string, peerId: string): Pair | null {
    const pair = this.#pairs.get(this.#key(ownerId, peerId))
    return pair ? { ...pair } : null
  }

  findPair(a: string, b: string): Pair | null {
    return this.getPair(a, b) ?? this.getPair(b, a)
  }

  putPair(pair: Pair): void {
    this.#pairs.delete(this.#key(pair.peerId, pair.ownerId))
    this.#pairs.set(this.#key(pair.ownerId, pair.peerId), { ...pair })
  }

  deletePair(a: string, b: string): boolean {
    const one = this.#pairs.delete(this.#key(a, b))
    const other = this.#pairs.delete(this.#key(b, a))
    return one || other
  }

  pairsOf(id: string): Pair[] {
    return [...this.#pairs.values()].filter((p) => p.ownerId === id || p.peerId === id).map((p) => ({ ...p }))
  }

  /** Phones that `hostId` (a desktop or server) authorized. */
  phonesForDesktop(hostId: string): string[] {
    return phonesOf(this.pairsOf(hostId), hostId)
  }

  /** Desktops and servers that authorized `phoneId`. */
  desktopsForPhone(phoneId: string): string[] {
    return hostsOf(this.pairsOf(phoneId), phoneId)
  }

  pushGeneration(deviceId: string): number {
    return this.#push.get(deviceId) ?? 0
  }

  bumpPushGeneration(deviceId: string): number {
    const generation = this.pushGeneration(deviceId) + 1
    this.#push.set(deviceId, generation)
    return generation
  }

  retirePushGeneration(deviceId: string, generation: number): boolean {
    if (this.#push.get(deviceId) !== generation) return false
    this.#push.set(deviceId, generation + 1)
    return true
  }

  close(): void {}
}

interface PairRow {
  owner_id: string
  owner_role: string
  owner_pub: string
  peer_id: string
  kind: string
  peer_pub: string
  created_at: number
}

function rowToPair(row: PairRow): Pair {
  return {
    ownerId: row.owner_id,
    ownerRole: row.owner_role as Role,
    ownerPub: row.owner_pub,
    peerId: row.peer_id,
    kind: row.kind as Role,
    peerPub: row.peer_pub,
    createdAt: Number(row.created_at)
  }
}

/** `PRAGMA user_version` once `pairs` has the (owner, peer, kind) shape. */
export const SCHEMA_VERSION = 2

const CREATE_PAIRS = `
  CREATE TABLE pairs (
    owner_id   TEXT    NOT NULL,
    owner_role TEXT    NOT NULL,
    owner_pub  TEXT    NOT NULL,
    peer_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    peer_pub   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, peer_id)
  );
  CREATE INDEX pairs_by_peer ON pairs (peer_id);
`

/**
 * Brings `pairs` to SCHEMA_VERSION in one transaction. Version 1 (unversioned, from
 * before servers) was `pairs(desktop_id, phone_id, phone_pub, desktop_pub, created_at)`;
 * each of its rows becomes owner = the desktop, peer = the phone, kind `phone`. One way
 * only: a relay from before servers can't open the migrated file.
 */
function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (version >= SCHEMA_VERSION) return
  const columns = (db.prepare('PRAGMA table_info(pairs)').all() as Array<{ name: string }>).map((c) => c.name)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (columns.includes('desktop_id')) {
      db.exec(`
        ALTER TABLE pairs RENAME TO pairs_v1;
        DROP INDEX IF EXISTS pairs_by_phone;
        ${CREATE_PAIRS}
        INSERT INTO pairs (owner_id, owner_role, owner_pub, peer_id, kind, peer_pub, created_at)
          SELECT desktop_id, 'desktop', desktop_pub, phone_id, 'phone', phone_pub, created_at FROM pairs_v1;
        DROP TABLE pairs_v1;
      `)
    } else if (columns.length === 0) {
      db.exec(CREATE_PAIRS)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** `node:sqlite` at the given path (normally `$RELAY_DATA/relay.db`). */
export class SqliteStore implements RelayStore, PushStore {
  readonly #db: DatabaseSync
  readonly #get: StatementSync
  readonly #find: StatementSync
  readonly #put: StatementSync
  readonly #delete: StatementSync
  readonly #of: StatementSync
  readonly #pushGet: StatementSync
  readonly #pushBump: StatementSync
  readonly #pushRetire: StatementSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS push_devices (
        device_id  TEXT    PRIMARY KEY,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    migrate(this.#db)
    this.#get = this.#db.prepare('SELECT * FROM pairs WHERE owner_id = ? AND peer_id = ?')
    this.#find = this.#db.prepare('SELECT * FROM pairs WHERE (owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?) LIMIT 1')
    this.#put = this.#db.prepare(
      'INSERT OR REPLACE INTO pairs (owner_id, owner_role, owner_pub, peer_id, kind, peer_pub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.#delete = this.#db.prepare('DELETE FROM pairs WHERE (owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?)')
    this.#of = this.#db.prepare('SELECT * FROM pairs WHERE owner_id = ? UNION ALL SELECT * FROM pairs WHERE peer_id = ?')
    this.#pushGet = this.#db.prepare('SELECT generation FROM push_devices WHERE device_id = ?')
    this.#pushBump = this.#db.prepare(
      `INSERT INTO push_devices (device_id, generation, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (device_id) DO UPDATE SET generation = generation + 1, updated_at = excluded.updated_at
       RETURNING generation`
    )
    this.#pushRetire = this.#db.prepare(
      'UPDATE push_devices SET generation = generation + 1, updated_at = ? WHERE device_id = ? AND generation = ?'
    )
  }

  getPair(ownerId: string, peerId: string): Pair | null {
    const row = this.#get.get(ownerId, peerId) as PairRow | undefined
    return row ? rowToPair(row) : null
  }

  findPair(a: string, b: string): Pair | null {
    const row = this.#find.get(a, b, b, a) as PairRow | undefined
    return row ? rowToPair(row) : null
  }

  putPair(pair: Pair): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#delete.run(pair.peerId, pair.ownerId, pair.peerId, pair.ownerId)
      this.#put.run(pair.ownerId, pair.ownerRole, pair.ownerPub, pair.peerId, pair.kind, pair.peerPub, pair.createdAt)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  deletePair(a: string, b: string): boolean {
    return Number(this.#delete.run(a, b, b, a).changes) > 0
  }

  pairsOf(id: string): Pair[] {
    return (this.#of.all(id, id) as unknown as PairRow[]).map(rowToPair)
  }

  /** Phones that `hostId` (a desktop or server) authorized. */
  phonesForDesktop(hostId: string): string[] {
    return phonesOf(this.pairsOf(hostId), hostId)
  }

  /** Desktops and servers that authorized `phoneId`. */
  desktopsForPhone(phoneId: string): string[] {
    return hostsOf(this.pairsOf(phoneId), phoneId)
  }

  pushGeneration(deviceId: string): number {
    const row = this.#pushGet.get(deviceId) as { generation: number } | undefined
    return row ? Number(row.generation) : 0
  }

  bumpPushGeneration(deviceId: string, now: number): number {
    return Number((this.#pushBump.get(deviceId, now) as { generation: number }).generation)
  }

  retirePushGeneration(deviceId: string, generation: number, now: number): boolean {
    return Number(this.#pushRetire.run(now, deviceId, generation).changes) > 0
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close()
  }
}
