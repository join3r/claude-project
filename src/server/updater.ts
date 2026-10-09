import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../main/atomic-write'
import { BUNDLE_MAX_BYTES, readLocalBundle, unpackBundle, verifyBundle, type BundleManifest } from '../main/host/link/bundle-archive'
import type { ServerInfo, ServerUpdateState } from '../main/host/link/link-channels'
import type { LinkStream, StreamHandler } from '../main/host/link/stream'
import { acceptsBundle } from '../main/host/link/update-policy'
import { ensureNode, flipSymlink, installedNode, symlinkTarget } from './node-install'
import type { ServerPaths } from './server-env'

/**
 * A server's updates (protocol/SERVER.md §10). A desktop with a newer bundle sends
 * it as a `bundle` stream; the updater unpacks it to `app/.incoming-*`, checks it
 * against its manifest's sha256, fetches the Node it names when that isn't
 * installed, and moves it to `app/<version>-<sha8>`. Then:
 *
 * - `install` mode (the bootstrap): `current` and `node/current` point at it at once.
 * - `daemon` mode: if no tab is working, it switches and restarts now; otherwise
 *   the bundle stays staged (`run/staged.json`, `update-ready` on the desktop) and
 *   the switch happens when the last working tab stops, on `server-restart`, or
 *   whenever the server stops anyway (a service restart, a reboot).
 *
 * Switching flips both symlinks (rename over, so atomic) and keeps the bundle that
 * was running plus the new one; older ones are deleted.
 */

export const BUNDLE_STREAM_KIND = 'bundle'

/** The `bundle` stream's `params`: what the desktop says it sends. */
export interface BundleStreamParams {
  version: string
  commit: string
  builtAt: string
  sha256: string
  /** Archive size in bytes. */
  bytes: number
}

/** What the server writes back before it ends the stream (failures abort it instead). */
export interface BundleStreamResult {
  ok: true
  /** `current`: it runs this bundle already; `installed`: switched (bootstrap); `restarting`; `staged`: waits for idle. */
  state: 'current' | 'installed' | 'restarting' | 'staged'
}

export interface ServerUpdaterOptions {
  paths: ServerPaths
  /** The bundle this process runs; null for the bootstrap or a source checkout. */
  running: Pick<BundleManifest, 'version' | 'commit' | 'builtAt' | 'sha256'> | null
  mode: 'daemon' | 'install'
  log: (message: string) => void
  /** No tab is working. */
  isIdle?: () => boolean
  onIdleChange?: (listener: () => void) => () => void
  /** Daemon: stop the process so the service manager starts `current`. */
  restart?: (reason: string) => void
  /** `info()` changed. */
  onStatus?: (info: ServerInfo) => void
  ensureNode?: (version: string) => Promise<string>
  /** Between answering the stream and restarting, so the answer gets out. */
  restartDelayMs?: number
}

interface Staged {
  dir: string
  manifest: BundleManifest
}

const SHA256_HEX = /^[0-9a-f]{64}$/

export function parseBundleParams(value: unknown): BundleStreamParams {
  const p = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (typeof p.sha256 !== 'string' || !SHA256_HEX.test(p.sha256)) throw new Error('bundle params need a sha256')
  if (typeof p.version !== 'string' || !p.version || p.version.length > 64) throw new Error('bundle params need a version')
  if (typeof p.builtAt !== 'string' || Number.isNaN(Date.parse(p.builtAt))) throw new Error('bundle params need builtAt')
  if (typeof p.bytes !== 'number' || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes > BUNDLE_MAX_BYTES) throw new Error(`bundle params need bytes (at most ${BUNDLE_MAX_BYTES})`)
  return { version: p.version, commit: typeof p.commit === 'string' ? p.commit.slice(0, 64) : '', builtAt: p.builtAt, sha256: p.sha256, bytes: p.bytes }
}

/** `app/<version>-<sha8>`, with the version made safe for a file name. */
export function bundleDirName(manifest: Pick<BundleManifest, 'version' | 'sha256'>): string {
  return `${manifest.version.replace(/[^A-Za-z0-9._-]/g, '_')}-${manifest.sha256.slice(0, 8)}`
}

export class ServerUpdater {
  private staged: Staged | null = null
  private restarting = false
  private restartCalled = false
  private receiving = false
  private idleUnsub: (() => void) | null = null
  private readonly stagedFile: string

  constructor(private readonly options: ServerUpdaterOptions) {
    this.stagedFile = path.join(options.paths.runDir, 'staged.json')
  }

  /** The `bundle` stream kind. */
  streamHandler(): StreamHandler {
    return (stream) => this.receive(stream)
  }

  info(): ServerInfo {
    const staged = this.staged
    if (!staged) return { update: null }
    const update: ServerUpdateState = {
      state: this.restarting ? 'restarting' : 'staged',
      version: staged.manifest.version,
      commit: staged.manifest.commit,
      builtAt: staged.manifest.builtAt
    }
    return { update }
  }

  /**
   * Daemon start: a bundle staged by an earlier run that never switched (it was
   * killed, say). Returns true when it switched to it and the caller must restart.
   */
  applyLeftoverStaged(): boolean {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(this.stagedFile, 'utf8'))
    } catch {
      return false
    }
    const dir = typeof (raw as { dir?: unknown }).dir === 'string' ? (raw as { dir: string }).dir : ''
    const bundle = dir ? readLocalBundle(dir) : null
    if (!bundle || symlinkTarget(this.options.paths.current) === path.resolve(dir) || !acceptsBundle(this.options.running, bundle.manifest).ok) {
      fs.rmSync(this.stagedFile, { force: true })
      return false
    }
    this.staged = { dir: bundle.dir, manifest: bundle.manifest }
    return this.applyStaged()
  }

  /**
   * Switches `current` (and `node/current`) to the staged bundle. Synchronous, so the
   * daemon can call it while stopping. True when there was one to switch to.
   */
  applyStaged(): boolean {
    const staged = this.staged
    if (!staged) return false
    const { paths } = this.options
    const node = installedNode(paths.nodeDir, staged.manifest.node)
    if (node) flipSymlink(paths.nodeCurrent, staged.manifest.node)
    else this.options.log(`update node ${staged.manifest.node} missing; keeping node/current`)
    const previous = symlinkTarget(paths.current)
    flipSymlink(paths.current, path.relative(paths.home, staged.dir))
    fs.rmSync(this.stagedFile, { force: true })
    this.options.log(`update switched current=${path.basename(staged.dir)}${previous ? ` previous=${path.basename(previous)}` : ''}`)
    this.prune([staged.dir, previous, this.runningDir()])
    this.staged = null
    return true
  }

  /** `server-restart`: switch to a staged bundle, if any, and restart now. */
  restartNow(reason: string): void {
    if (this.restartCalled) return
    const restart = this.options.restart
    if (!restart) throw new Error('This server cannot restart itself')
    this.restartCalled = true
    this.restarting = true
    this.emit()
    this.idleUnsub?.()
    this.idleUnsub = null
    // The daemon applies the staged bundle as it stops.
    restart(reason)
  }

  // ---- receiving -------------------------------------------------------------------

  private async receive(stream: LinkStream): Promise<void> {
    let params: BundleStreamParams
    try {
      params = parseBundleParams(stream.params)
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const refuse = (why: string) => {
      this.options.log(`update refused version=${params.version} sha=${params.sha256.slice(0, 12)}: ${why}`)
      stream.destroy(new Error(why))
    }
    if (this.receiving) return refuse('another bundle is arriving')
    if (this.restarting) return refuse('the server is restarting')
    if (this.options.running?.sha256 === params.sha256) {
      stream.resume()
      stream.end(JSON.stringify({ ok: true, state: 'current' } satisfies BundleStreamResult))
      return
    }
    if (this.staged?.manifest.sha256 === params.sha256) {
      stream.resume()
      stream.end(JSON.stringify({ ok: true, state: 'staged' } satisfies BundleStreamResult))
      return
    }
    const accepted = acceptsBundle(this.options.running, params)
    if (!accepted.ok) return refuse(accepted.why)

    this.receiving = true
    const { paths } = this.options
    const incoming = path.join(paths.appDir, `.incoming-${randomBytes(4).toString('hex')}`)
    const started = Date.now()
    try {
      fs.mkdirSync(paths.appDir, { recursive: true, mode: 0o755 })
      const { files, bytes } = await unpackBundle(stream, incoming, Math.max(params.bytes, 1))
      const manifest = verifyBundle(incoming, params.sha256)
      this.options.log(`update received version=${manifest.version} commit=${manifest.commit.slice(0, 12)} files=${files} bytes=${bytes} in ${Date.now() - started} ms`)
      if (!installedNode(paths.nodeDir, manifest.node)) {
        this.options.log(`update needs node ${manifest.node}`)
        await (this.options.ensureNode ?? ((version) => ensureNode({ nodeDir: paths.nodeDir, version, log: this.options.log })))(manifest.node)
      }
      const target = path.join(paths.appDir, bundleDirName(manifest))
      if (fs.existsSync(target) && symlinkTarget(paths.current) !== target) fs.rmSync(target, { recursive: true, force: true })
      if (fs.existsSync(target)) fs.rmSync(incoming, { recursive: true, force: true })
      else fs.renameSync(incoming, target)
      this.staged = { dir: target, manifest }
      fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
      atomicWriteFileSync(this.stagedFile, JSON.stringify({ dir: target, version: manifest.version, sha256: manifest.sha256 }) + '\n', 0o600)
    } catch (err) {
      fs.rmSync(incoming, { recursive: true, force: true })
      const message = (err as NodeJS.ErrnoException).code === 'ENOSPC' ? 'The server\'s disk is full' : err instanceof Error ? err.message : String(err)
      refuse(message)
      return
    } finally {
      this.receiving = false
    }

    let state: BundleStreamResult['state']
    if (this.options.mode === 'install') {
      this.applyStaged()
      state = 'installed'
    } else if (this.options.isIdle?.() ?? true) {
      state = 'restarting'
    } else {
      state = 'staged'
    }
    stream.end(JSON.stringify({ ok: true, state } satisfies BundleStreamResult))
    if (state === 'restarting') {
      this.restarting = true
      this.emit()
      setTimeout(() => this.restartNow('update'), this.options.restartDelayMs ?? 500)
    } else if (state === 'staged') {
      this.options.log('update staged; switching once no tab is working')
      this.emit()
      this.waitForIdle()
    }
  }

  private waitForIdle(): void {
    if (this.idleUnsub || !this.options.onIdleChange) return
    this.idleUnsub = this.options.onIdleChange(() => {
      if (!this.staged || this.restarting || !(this.options.isIdle?.() ?? true)) return
      this.options.log('update: every tab is idle now')
      this.restartNow('update (idle)')
    })
  }

  private runningDir(): string | null {
    return symlinkTarget(this.options.paths.current)
  }

  /** Deletes every unpacked bundle but `keep` (and any still arriving). */
  private prune(keep: (string | null)[]): void {
    const kept = new Set(keep.filter((dir): dir is string => !!dir).map((dir) => path.resolve(dir)))
    let entries: string[]
    try {
      entries = fs.readdirSync(this.options.paths.appDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.incoming-')) continue
      const dir = path.join(this.options.paths.appDir, name)
      if (kept.has(path.resolve(dir))) continue
      fs.rmSync(dir, { recursive: true, force: true })
      this.options.log(`update pruned ${name}`)
    }
  }

  private emit(): void {
    this.options.onStatus?.(this.info())
  }
}
