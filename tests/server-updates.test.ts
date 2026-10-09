import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bundleSha256 } from '../scripts/server-bundle.mjs'
import {
  BUNDLE_MAGIC,
  isSafeBundlePath,
  packBundle,
  readLocalBundle,
  unpackBundle,
  verifyBundle,
  type BundleManifest,
  type LocalBundle
} from '../src/main/host/link/bundle-archive'
import { acceptsBundle, decideUpdate } from '../src/main/host/link/update-policy'
import { diagnosticStreamKinds } from '../src/main/host/link/diagnostic-streams'
import { LinkChannel } from '../src/main/host/link/link-channels'
import { BUNDLE_STREAM_KIND, ServerUpdater, bundleDirName } from '../src/server/updater'
import { respawnCommand } from '../src/server/restart'
import { serverPaths } from '../src/server/server-env'
import { startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

const dirs: string[] = []
function tempDir(prefix = 'devtool-bundle-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A small server bundle: a few files, an executable, and a manifest whose sha256 matches. */
function makeBundle(builtAt: string, marker = 'v1'): LocalBundle {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'main.js'), `console.log(${JSON.stringify(marker)})\n`)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
  fs.mkdirSync(path.join(dir, 'node_modules/node-pty/prebuilds/darwin-arm64'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), Buffer.alloc(70_000, 7), { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'empty.txt'), '')
  const manifest: BundleManifest = { version: '0.6.0', commit: `c-${marker}`, builtAt, protocol: 1, node: '24.21.0', sha256: bundleSha256(dir) }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifest }
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

async function archiveBytes(dir: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of packBundle(dir).chunks()) parts.push(Uint8Array.from(chunk))
  return Buffer.concat(parts)
}

function rawArchive(files: { p: string; n: number; x?: 1 }[], body: Uint8Array): Uint8Array {
  const index = Buffer.from(JSON.stringify({ v: 1, files }))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(index.length)
  return Buffer.concat([Buffer.from(BUNDLE_MAGIC), length, index, body])
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bundle archive', () => {
  it('round-trips a bundle with its executable bit, and the copy verifies', async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    const bytes = await archiveBytes(bundle.dir)
    expect(bytes.length).toBe(packBundle(bundle.dir).total)
    const dest = path.join(tempDir(), 'out')
    // Odd chunk sizes cross every boundary in the archive.
    expect(await unpackBundle(chunked(bytes, 997), dest)).toMatchObject({ files: 5 })
    expect(verifyBundle(dest, bundle.manifest.sha256)).toEqual(bundle.manifest)
    expect(fs.statSync(path.join(dest, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(dest, 'main.js')).mode & 0o111).toBe(0)
    expect(readLocalBundle(dest)?.manifest.sha256).toBe(bundle.manifest.sha256)
  })

  it('refuses a bundle whose content does not match its sha256', async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    const dest = path.join(tempDir(), 'out')
    await unpackBundle(chunked(await archiveBytes(bundle.dir), 4096), dest)
    expect(() => verifyBundle(dest, 'f'.repeat(64))).toThrow(/manifest says/)
    fs.appendFileSync(path.join(dest, 'main.js'), '// tampered\n')
    expect(() => verifyBundle(dest, bundle.manifest.sha256)).toThrow(/content hash/)
  })

  it('refuses unsafe paths, duplicates, short and long archives, and size overruns', async () => {
    const out = () => path.join(tempDir(), 'out')
    for (const p of ['../evil', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b', '.']) {
      expect(isSafeBundlePath(p)).toBe(false)
      await expect(unpackBundle(chunked(rawArchive([{ p, n: 1 }], new Uint8Array(1)), 64), out())).rejects.toThrow(/unsafe path/)
    }
    await expect(unpackBundle(chunked(rawArchive([{ p: 'A', n: 1 }, { p: 'a', n: 1 }], new Uint8Array(2)), 64), out())).rejects.toThrow(/twice/)
    await expect(unpackBundle(chunked(rawArchive([{ p: 'a', n: 5 }], new Uint8Array(3)), 64), out())).rejects.toThrow(/ended/)
    await expect(unpackBundle(chunked(rawArchive([{ p: 'a', n: 1 }], new Uint8Array(3)), 64), out())).rejects.toThrow(/past its last file/)
    await expect(unpackBundle(chunked(Buffer.from('NOTABUNDLE'), 64), out())).rejects.toThrow(/not a DevTool server bundle/)
    await expect(unpackBundle(chunked(rawArchive([{ p: 'a', n: 100 }], new Uint8Array(100)), 64), out(), 50)).rejects.toThrow(/over 50 bytes/)
  })
})

describe('update policy', () => {
  const desktop: BundleManifest = { version: '0.6.0', commit: 'new', builtAt: '2026-10-09T12:00:00Z', protocol: 1, node: '24.21.0', sha256: 'a'.repeat(64) }
  const build = (bundleSha: string, builtAt: string) => ({ version: '0.6.0', commit: 'x', builtAt, bundleSha })

  it('uploads to an empty or older server, never to a newer one or the same build', () => {
    expect(decideUpdate(desktop, build('', ''))).toEqual({ upload: true, reason: 'server-empty' })
    expect(decideUpdate(desktop, build('b'.repeat(64), '2026-10-09T11:00:00Z'))).toEqual({ upload: true, reason: 'desktop-newer' })
    expect(decideUpdate(desktop, build('b'.repeat(64), '2026-10-09T13:00:00Z'))).toEqual({ upload: false, reason: 'server-newer' })
    expect(decideUpdate(desktop, build('b'.repeat(64), '2026-10-09T12:00:00Z'))).toEqual({ upload: false, reason: 'server-newer' })
    expect(decideUpdate(desktop, build('a'.repeat(64), '2020-01-01T00:00:00Z'))).toEqual({ upload: false, reason: 'same' })
    expect(decideUpdate(desktop, build('dev', ''))).toEqual({ upload: false, reason: 'source' })
    expect(decideUpdate(desktop, build('b'.repeat(64), ''))).toEqual({ upload: false, reason: 'unknown-age' })
    expect(decideUpdate(null, build('', ''))).toEqual({ upload: false, reason: 'no-bundle' })
  })

  it('makes the server refuse an older bundle too', () => {
    const running = { sha256: 'b'.repeat(64), builtAt: '2026-10-09T12:00:00Z' }
    expect(acceptsBundle(running, { sha256: 'a'.repeat(64), builtAt: '2026-10-09T11:00:00Z' })).toMatchObject({ ok: false })
    expect(acceptsBundle(running, { sha256: 'a'.repeat(64), builtAt: '2026-10-09T13:00:00Z' })).toEqual({ ok: true })
    expect(acceptsBundle(null, { sha256: 'a'.repeat(64), builtAt: '2000-01-01T00:00:00Z' })).toEqual({ ok: true })
  })

  it('respawns the installed layout from node/current and current/main.js', () => {
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: '/h' })
    expect(respawnCommand(paths, ['/h/node/24.21.0/bin/node', '/h/current/main.js'], '/usr/bin/node')).toEqual({ command: '/usr/bin/node', args: ['/h/current/main.js'] })
    expect(respawnCommand(paths, ['/x/node', '/repo/out/server/main.js', '--relay', 'ws://r'], '/x/node')).toEqual({ command: '/x/node', args: ['/repo/out/server/main.js', '--relay', 'ws://r'] })
  })
})

describe.skipIf(process.platform === 'win32')('updates through the relay', () => {
  const cleanups: (() => unknown)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  const OLD_BUILT = '2026-10-01T00:00:00.000Z'
  const OLD_SHA = 'b'.repeat(64)

  interface Rig {
    d: TestDesktop
    s: TestServer
    updater: ServerUpdater
    restarts: string[]
    idle: { value: boolean; listeners: Set<() => void> }
    home: string
  }

  /** Pairs by code; the server may go straight on to `updating`, so this doesn't wait for `online`. */
  async function pair(d: TestDesktop, s: TestServer): Promise<void> {
    await d.hub.pairWithCode((await s.link.createPairingCode()).code)
  }

  /** A desktop carrying `bundle` and a server that runs an older build in a fresh home. */
  async function rig(bundle: LocalBundle, running: { sha256: string; builtAt: string } = { sha256: OLD_SHA, builtAt: OLD_BUILT }): Promise<Rig> {
    const { relay } = await startTestRelay()
    cleanups.push(() => relay.close())
    const restarts: string[] = []
    const idle = { value: true, listeners: new Set<() => void>() }
    const home = tempDir('devtool-update-home-')
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: home })
    const ref: { updater?: ServerUpdater } = {}
    const s = await startTestServer(relay.url, {
      build: () => ({ version: '0.5.0', commit: 'old', builtAt: running.builtAt, bundleSha: running.sha256 }),
      streams: new Map([...diagnosticStreamKinds(), [BUNDLE_STREAM_KIND, (stream) => ref.updater!.streamHandler()(stream, { peer: '' })]]),
      linkCall: (call) => {
        if (call.ch === LinkChannel.Info) return Promise.resolve(ref.updater!.info())
        if (call.ch === LinkChannel.Restart) {
          ref.updater!.restartNow('test')
          return Promise.resolve({ restarting: true })
        }
        return undefined
      }
    })
    cleanups.push(() => s.close())
    const updater = new ServerUpdater({
      paths,
      running: { version: '0.5.0', commit: 'old', ...running },
      mode: 'daemon',
      log: (line) => s.log.push(line),
      isIdle: () => idle.value,
      onIdleChange: (listener) => {
        idle.listeners.add(listener)
        return () => idle.listeners.delete(listener)
      },
      restart: (reason) => {
        restarts.push(reason)
        updater.applyStaged()
      },
      onStatus: (info) => s.link.broadcast('server-status', [info]),
      ensureNode: async (version) => {
        const bin = path.join(paths.nodeDir, version, 'bin')
        fs.mkdirSync(bin, { recursive: true })
        fs.writeFileSync(path.join(bin, 'node'), '')
        return path.join(bin, 'node')
      },
      restartDelayMs: 10
    })
    ref.updater = updater
    const d = startTestDesktop(relay.url, { bundle: () => bundle })
    cleanups.push(() => d.close())
    return { d, s, updater, restarts, idle, home }
  }

  it('uploads a newer bundle, switches current and node/current, and restarts when idle', { timeout: 30_000 }, async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    const { d, s, restarts, home } = await rig(bundle)
    const states: string[] = []
    d.hub.onStateChange((state) => {
      const st = state.servers[0]?.state
      if (st && states.at(-1) !== st) states.push(st)
    })
    await pair(d, s)
    await waitFor(() => restarts.length === 1, 'restart', 15_000)
    expect(states).toContain('updating')
    const current = fs.readlinkSync(path.join(home, 'current'))
    expect(current).toBe(path.join('app', bundleDirName(bundle.manifest)))
    expect(fs.readlinkSync(path.join(home, 'node', 'current'))).toBe('24.21.0')
    expect(verifyBundle(path.join(home, current), bundle.manifest.sha256).commit).toBe('c-v1')
    expect(fs.existsSync(path.join(home, 'run', 'staged.json'))).toBe(false)
    expect(d.log.some((line) => line.includes('update=server-empty') || line.includes('update=desktop-newer'))).toBe(true)
    expect(d.status(s.id)?.state).toBe('updating')
  })

  it('stages while a tab is working, reports update-ready, and switches once idle', { timeout: 30_000 }, async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    const { d, s, restarts, idle, home } = await rig(bundle)
    idle.value = false
    await pair(d, s)
    await waitFor(() => d.status(s.id)?.updateReady !== undefined, 'update ready', 15_000)
    expect(d.status(s.id)).toMatchObject({ state: 'online', updateReady: { commit: 'c-v1', builtAt: bundle.manifest.builtAt } })
    expect(fs.existsSync(path.join(home, 'current'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'run', 'staged.json'), 'utf8'))).toMatchObject({ sha256: bundle.manifest.sha256 })
    expect(restarts).toEqual([])
    // The same bundle again (a reconnect) is not sent twice.
    await expect(d.hub.updateServer(s.id)).resolves.toMatchObject({ upload: true })
    expect(restarts).toEqual([])

    idle.value = true
    for (const listener of idle.listeners) listener()
    await waitFor(() => restarts.length === 1, 'restart once idle')
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(path.join('app', bundleDirName(bundle.manifest)))
  })

  it('restarts on server-restart while busy, and never downgrades', { timeout: 30_000 }, async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    const busy = await rig(bundle)
    busy.idle.value = false
    await pair(busy.d, busy.s)
    await waitFor(() => busy.d.status(busy.s.id)?.updateReady !== undefined, 'update ready', 15_000)
    await busy.d.hub.restartServer(busy.s.id)
    await waitFor(() => busy.restarts.length === 1, 'restart')
    expect(busy.d.status(busy.s.id)?.state).toBe('updating')

    const older = await rig(makeBundle('2026-09-01T00:00:00.000Z'))
    await pair(older.d, older.s)
    await waitFor(() => older.d.log.some((line) => line.includes('update=server-newer')), 'server-newer')
    expect(fs.existsSync(path.join(older.home, 'app'))).toBe(false)
  })

  it('a bundle that fails its check is refused and not sent again', { timeout: 30_000 }, async () => {
    const bundle = makeBundle('2026-10-09T10:00:00.000Z')
    fs.appendFileSync(path.join(bundle.dir, 'main.js'), '// changed after the manifest\n')
    const { d, s, restarts, home } = await rig(bundle)
    await pair(d, s)
    await waitFor(() => d.log.some((line) => line.includes('upload failed')), 'upload failed', 15_000)
    expect(d.log.find((line) => line.includes('upload failed'))).toMatch(/content hash/)
    expect(restarts).toEqual([])
    expect(fs.readdirSync(path.join(home, 'app'))).toEqual([])
    await expect(d.hub.updateServer(s.id)).resolves.toMatchObject({ upload: false })
    expect(d.status(s.id)?.state).toBe('online')
  })
})
