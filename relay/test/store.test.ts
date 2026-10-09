import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../protocol/ts/index.ts'
import { loadConfig } from '../src/config.ts'
import { IpLimiter, TokenBucket } from '../src/rate.ts'
import { MemoryStore, SCHEMA_VERSION, SqliteStore } from '../src/store.ts'
import type { Pair, PushStore, RelayStore } from '../src/store.ts'
import { tempDir } from './helpers.ts'

const pair = (ownerId: string, peerId: string, createdAt = 1, ownerRole: Role = 'desktop', kind: Role = 'phone'): Pair => ({
  ownerId, ownerRole, ownerPub: `o-${ownerId}`, peerId, kind, peerPub: `p-${peerId}`, createdAt
})

const peersOf = (store: RelayStore, id: string): string[] =>
  store.pairsOf(id).map((p) => (p.ownerId === id ? p.peerId : p.ownerId)).sort()

function exercise(store: RelayStore): void {
  expect(store.getPair('d1', 'p1')).toBeNull()
  expect(store.findPair('p1', 'd1')).toBeNull()
  store.putPair(pair('d1', 'p1'))
  store.putPair(pair('d1', 'p2'))
  store.putPair(pair('d2', 'p1'))
  store.putPair(pair('d1', 'p1', 5))
  expect(store.getPair('d1', 'p1')).toEqual(pair('d1', 'p1', 5))
  expect(store.getPair('p1', 'd1')).toBeNull()
  expect(store.findPair('p1', 'd1')).toEqual(pair('d1', 'p1', 5))
  expect(peersOf(store, 'd1')).toEqual(['p1', 'p2'])
  expect(peersOf(store, 'p1')).toEqual(['d1', 'd2'])
  if (store instanceof MemoryStore || store instanceof SqliteStore) {
    expect(store.phonesForDesktop('d1').sort()).toEqual(['p1', 'p2'])
    expect(store.desktopsForPhone('p1').sort()).toEqual(['d1', 'd2'])
  }
  expect(store.deletePair('p1', 'd1')).toBe(true)
  expect(store.deletePair('d1', 'p1')).toBe(false)
  expect(peersOf(store, 'p1')).toEqual(['d2'])

  // Desktop↔server: one pair per two devices, whichever side owns it.
  store.putPair(pair('d1', 's1', 7, 'desktop', 'server'))
  expect(store.findPair('s1', 'd1')).toEqual(pair('d1', 's1', 7, 'desktop', 'server'))
  store.putPair(pair('s1', 'd1', 8, 'server', 'desktop'))
  expect(store.getPair('d1', 's1')).toBeNull()
  expect(store.findPair('d1', 's1')).toEqual(pair('s1', 'd1', 8, 'server', 'desktop'))
  expect(peersOf(store, 'd1')).toEqual(['p2', 's1'])
  expect(peersOf(store, 's1')).toEqual(['d1'])
}

function exercisePush(store: PushStore): void {
  expect(store.pushGeneration('p1')).toBe(0)
  expect(store.bumpPushGeneration('p1', 1)).toBe(1)
  expect(store.bumpPushGeneration('p1', 2)).toBe(2)
  expect(store.bumpPushGeneration('p2', 2)).toBe(1)
  expect(store.pushGeneration('p1')).toBe(2)
  expect(store.retirePushGeneration('p1', 1, 3)).toBe(false)
  expect(store.pushGeneration('p1')).toBe(2)
  expect(store.retirePushGeneration('p1', 2, 3)).toBe(true)
  expect(store.pushGeneration('p1')).toBe(3)
  expect(store.retirePushGeneration('nobody', 0, 3)).toBe(false)
}

describe('stores', () => {
  it('MemoryStore', () => {
    exercise(new MemoryStore())
    exercisePush(new MemoryStore())
  })

  it('SqliteStore, including reopening the file', () => {
    const dir = tempDir()
    try {
      const path = `${dir.path}/nested/relay.db`
      const store = new SqliteStore(path)
      exercise(store)
      exercisePush(store)
      store.close()
      const again = new SqliteStore(path)
      expect(again.pushGeneration('p1')).toBe(3)
      expect(again.getPair('d2', 'p1')).toEqual(pair('d2', 'p1'))
      expect(peersOf(again, 'd1')).toEqual(['p2', 's1'])
      again.close()
    } finally {
      dir.remove()
    }
  })

  it('SqliteStore migrates a database from before servers, keeping every pair', () => {
    const dir = tempDir()
    try {
      const path = `${dir.path}/relay.db`
      // The schema every relay before servers created, verbatim, with two pairs and a push row.
      const old = new DatabaseSync(path)
      old.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS pairs (
          desktop_id  TEXT    NOT NULL,
          phone_id    TEXT    NOT NULL,
          phone_pub   TEXT    NOT NULL,
          desktop_pub TEXT    NOT NULL,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (desktop_id, phone_id)
        );
        CREATE INDEX IF NOT EXISTS pairs_by_phone ON pairs (phone_id);
        CREATE TABLE IF NOT EXISTS push_devices (
          device_id  TEXT    PRIMARY KEY,
          generation INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO pairs VALUES ('d1', 'p1', 'p-p1', 'd-d1', 1700000000000);
        INSERT INTO pairs VALUES ('d2', 'p1', 'p-p1', 'd-d2', 1700000000001);
        INSERT INTO push_devices VALUES ('p1', 4, 1700000000002);
      `)
      old.close()

      const store = new SqliteStore(path)
      expect(store.getPair('d1', 'p1')).toEqual({
        ownerId: 'd1', ownerRole: 'desktop', ownerPub: 'd-d1', peerId: 'p1', kind: 'phone', peerPub: 'p-p1', createdAt: 1700000000000
      })
      expect(store.findPair('p1', 'd2')).toMatchObject({ ownerId: 'd2', peerId: 'p1', kind: 'phone', createdAt: 1700000000001 })
      expect(peersOf(store, 'p1')).toEqual(['d1', 'd2'])
      expect(store.pushGeneration('p1')).toBe(4)
      store.putPair(pair('d1', 's1', 9, 'desktop', 'server'))
      store.close()

      // Reopening doesn't migrate twice; the old table and index are gone.
      const again = new SqliteStore(path)
      expect(peersOf(again, 'd1')).toEqual(['p1', 's1'])
      again.close()
      const raw = new DatabaseSync(path)
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
      const objects = (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
      expect(objects).toEqual(expect.arrayContaining(['pairs', 'pairs_by_peer', 'push_devices']))
      expect(objects).not.toContain('pairs_v1')
      expect(objects).not.toContain('pairs_by_phone')
      raw.close()
    } finally {
      dir.remove()
    }
  })
})

describe('rate limiting', () => {
  it('token bucket allows the burst, then the steady rate', () => {
    const bucket = new TokenBucket(50, 200, 0)
    let allowed = 0
    for (let i = 0; i < 300; i++) if (bucket.take(0)) allowed++
    expect(allowed).toBe(200)
    expect(bucket.take(10)).toBe(false)
    expect(bucket.take(20)).toBe(true)
    // Refill caps at the burst.
    let later = 0
    for (let i = 0; i < 300; i++) if (bucket.take(60_000)) later++
    expect(later).toBe(200)
  })

  it('token bucket spends into debt and says how long until it is out of it', () => {
    const bucket = new TokenBucket(1000, 4, 0)
    expect(bucket.spend(4, 0)).toBe(0)
    expect(bucket.spend(1, 0)).toBe(1)
    expect(bucket.waitMs(1)).toBe(0)
    expect(bucket.spend(10, 1)).toBe(10)
    expect(bucket.waitMs(6)).toBe(5)
    const bytes = new TokenBucket(1024, 2048, 0)
    expect(bytes.spend(4096, 0)).toBe(2000)
  })

  it('IP limiter uses a sliding one-minute window', () => {
    const limiter = new IpLimiter(20)
    for (let i = 0; i < 20; i++) expect(limiter.admit('a', i)).toBe(true)
    expect(limiter.admit('a', 30_000)).toBe(false)
    expect(limiter.admit('b', 30_000)).toBe(true)
    expect(limiter.admit('a', 60_000)).toBe(false)
    expect(limiter.admit('a', 90_001)).toBe(true)
    limiter.prune(200_000)
    expect(limiter.size).toBe(0)
  })
})

describe('config', () => {
  it('has the documented defaults and reads the environment', () => {
    expect(loadConfig({})).toMatchObject({ port: 8787, host: '0.0.0.0', trustProxy: false, logLevel: 'info' })
    expect(loadConfig({}).dataDir).toMatch(/\/data$/)
    expect(loadConfig({ PORT: '9000', HOST: '127.0.0.1', RELAY_DATA: '/data', RELAY_TRUST_PROXY: '1', LOG_LEVEL: 'debug' })).toEqual({
      port: 9000, host: '127.0.0.1', dataDir: '/data', trustProxy: true, logLevel: 'debug',
      push: { role: 'forward', upstream: 'https://relay.devtool.awantech.sk' }
    })
    expect(() => loadConfig({ PORT: 'x' })).toThrow()
  })

  it('reads limits from the environment, with K/M/G sizes', () => {
    expect(loadConfig({}).limits).toBeUndefined()
    expect(loadConfig({
      RELAY_HOST_BYTES_PER_SECOND: '4M', RELAY_HOST_BYTES_BURST: '16m', RELAY_IP_BYTES_PER_SECOND: '8388608',
      RELAY_IP_BYTES_BURST: '1G', RELAY_MAX_QUEUED_BYTES: '256M', RELAY_MAX_CONNECTIONS_PER_IP: '10',
      RELAY_NEW_PAIRS_PER_IP_PER_HOUR: '5', RELAY_STALL_TIMEOUT_MS: '20000'
    }).limits).toEqual({
      hostBytesPerSecond: 4 << 20, hostBytesBurst: 16 << 20, ipBytesPerSecond: 8 << 20, ipBytesBurst: 1 << 30,
      maxQueuedBytes: 256 << 20, maxConnectionsPerIp: 10, newPairsPerIpPerHour: 5, stallTimeoutMs: 20000
    })
    expect(() => loadConfig({ RELAY_MAX_CONNECTIONS_PER_IP: '10K' })).toThrow(/RELAY_MAX_CONNECTIONS_PER_IP/)
    expect(() => loadConfig({ RELAY_HOST_BYTES_PER_SECOND: '0' })).toThrow(/RELAY_HOST_BYTES_PER_SECOND/)
    expect(() => loadConfig({ RELAY_IP_BYTES_BURST: 'lots' })).toThrow(/RELAY_IP_BYTES_BURST/)
  })
})
