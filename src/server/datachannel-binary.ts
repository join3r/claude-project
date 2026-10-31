import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { errorMessage } from '../main/host/link/errors'

/**
 * node-datachannel's native binary for a bundled server (protocol/SERVER.md §13.6).
 *
 * The prebuilds are about 9 MB per platform, three times the rest of the bundle,
 * and the bundle travels over the relay on every update. So the bundle carries
 * only `datachannel.json` (written by scripts/build-server.mjs from
 * package-lock.json): each platform's npm tarball URL and its sha512. A server
 * fetches its own platform's tarball the first time it needs it, checks the hash,
 * and keeps the binary under `<home>/native/`. When that fails it has no direct
 * path and every desktop stays on the relay.
 *
 * The bundled node-datachannel's own loader is replaced at build time by one that
 * returns {@link BINDING_GLOBAL}, so this file sets that before importing it.
 */

export const DATACHANNEL_MANIFEST = 'datachannel.json'
/** Where the build's stub loader finds the binding. */
export const BINDING_GLOBAL = '__devtoolNodeDatachannel'

export interface DatachannelManifest {
  version: string
  /** `linux-x64-gnu` → the npm tarball. */
  prebuilds: Record<string, { url: string; integrity: string }>
}

const execFileAsync = promisify(execFile)

/** The prebuild name for this machine, as node-datachannel names them. */
export function prebuildName(platform = process.platform, arch = process.arch, glibc = hasGlibc()): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'linux') return `linux-${arch}-${glibc ? 'gnu' : 'musl'}`
  return null
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return Boolean(report?.header?.glibcVersionRuntime)
}

/** Checks `bytes` against an npm `sha512-<base64>` integrity string. */
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, expected] = integrity.split('-', 2)
  if (algorithm !== 'sha512' || !expected) return false
  return createHash('sha512').update(bytes).digest('base64') === expected
}

/**
 * Makes the binding available to the bundled node-datachannel. True when it is
 * (already set, or fetched and loaded now); false when this bundle has no
 * manifest (a server run from source loads the npm package as it is), and throws
 * when the bundle has one but the binary can't be had.
 */
export async function prepareDatachannel(options: {
  bundleDir: string
  home: string
  log: (message: string) => void
  fetchBytes?: (url: string) => Promise<Uint8Array>
}): Promise<boolean> {
  const global = globalThis as Record<string, unknown>
  if (global[BINDING_GLOBAL]) return true
  let manifest: DatachannelManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(options.bundleDir, DATACHANNEL_MANIFEST), 'utf8')) as DatachannelManifest
  } catch {
    return false
  }
  const name = prebuildName()
  const prebuild = name ? manifest.prebuilds[name] : undefined
  if (!name || !prebuild) throw new Error(`no node-datachannel prebuild for ${process.platform}-${process.arch}`)
  const dir = path.join(options.home, 'native', `node-datachannel-${manifest.version}-${name}`)
  const binary = path.join(dir, 'node_datachannel.node')
  if (!fs.existsSync(binary)) {
    options.log(`direct fetching node-datachannel ${manifest.version} (${name})`)
    const tarball = await (options.fetchBytes ?? fetchBytes)(prebuild.url)
    if (!matchesIntegrity(tarball, prebuild.integrity)) throw new Error(`node-datachannel ${name}: the download does not match its sha512`)
    await extractBinary(tarball, dir, binary)
  }
  global[BINDING_GLOBAL] = createRequire(import.meta.url)(binary)
  return true
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Unpacks `package/node_datachannel.node` from the tarball into `binary`, atomically. */
async function extractBinary(tarball: Uint8Array, dir: string, binary: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const work = `${dir}.tmp-${randomBytes(4).toString('hex')}`
  fs.mkdirSync(work, { recursive: true })
  try {
    const archive = path.join(work, 'package.tgz')
    fs.writeFileSync(archive, tarball)
    await execFileAsync('tar', ['-xzf', archive, '-C', work, 'package/node_datachannel.node'])
    fs.mkdirSync(dir, { recursive: true })
    const target = `${binary}.tmp`
    fs.copyFileSync(path.join(work, 'package', 'node_datachannel.node'), target)
    fs.renameSync(target, binary)
  } catch (err) {
    throw new Error(`could not unpack node-datachannel: ${errorMessage(err)}`, { cause: err })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
