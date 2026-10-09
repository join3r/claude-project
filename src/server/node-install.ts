import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

/**
 * Node for the server, from nodejs.org (or `DEVTOOL_NODE_MIRROR`): the `.tar.gz`
 * (minimal images have no xz), checked against the release's SHASUMS256.txt, then
 * unpacked with the system `tar` into `<home>/node/<version>/`. `site/install` does
 * the same in sh for the first install; the server does it when an update needs
 * another Node.
 */

export const DEFAULT_NODE_MIRROR = 'https://nodejs.org/dist'

export interface NodeInstallOptions {
  /** `<home>/node`. */
  nodeDir: string
  version: string
  platform?: NodeJS.Platform
  arch?: string
  mirror?: string
  log?: (message: string) => void
  fetch?: typeof fetch
}

/** `node-v24.21.0-linux-arm64`, or null on a platform the server doesn't run on. */
export function nodeDistName(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  return os && cpu ? `node-v${version}-${os}-${cpu}` : null
}

/** The sha256 SHASUMS256.txt lists for `file`, or null. */
export function shasumFor(shasums: string, file: string): string | null {
  for (const line of shasums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match && match[2] === file) return match[1]
  }
  return null
}

/** `<nodeDir>/<version>/bin/node` when that Node is installed. */
export function installedNode(nodeDir: string, version: string): string | null {
  const bin = path.join(nodeDir, version, 'bin', 'node')
  return fs.existsSync(bin) ? bin : null
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`))))
  })
}

/** Installs Node `version` unless it is there already; returns its `bin/node`. */
export async function ensureNode(options: NodeInstallOptions): Promise<string> {
  const existing = installedNode(options.nodeDir, options.version)
  if (existing) return existing
  const dist = nodeDistName(options.version, options.platform, options.arch)
  if (!dist) throw new Error(`Node has no build for ${options.platform ?? process.platform}-${options.arch ?? process.arch} that the server supports`)
  const mirror = (options.mirror ?? process.env.DEVTOOL_NODE_MIRROR ?? DEFAULT_NODE_MIRROR).replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const log = options.log ?? (() => {})
  const file = `${dist}.tar.gz`
  const base = `${mirror}/v${options.version}`
  log(`node download ${base}/${file}`)

  const sums = await doFetch(`${base}/SHASUMS256.txt`)
  if (!sums.ok) throw new Error(`Cannot fetch ${base}/SHASUMS256.txt: HTTP ${sums.status}`)
  const expected = shasumFor(await sums.text(), file)
  if (!expected) throw new Error(`SHASUMS256.txt for Node ${options.version} does not list ${file}`)

  fs.mkdirSync(options.nodeDir, { recursive: true, mode: 0o755 })
  const tag = randomBytes(4).toString('hex')
  const archive = path.join(options.nodeDir, `.download-${tag}.tar.gz`)
  const unpack = path.join(options.nodeDir, `.unpack-${tag}`)
  try {
    const response = await doFetch(`${base}/${file}`)
    if (!response.ok || !response.body) throw new Error(`Cannot fetch ${base}/${file}: HTTP ${response.status}`)
    const hash = createHash('sha256')
    const source = Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)
    source.on('data', (chunk: Buffer) => hash.update(chunk))
    await pipeline(source, fs.createWriteStream(archive))
    const actual = hash.digest('hex')
    if (actual !== expected) throw new Error(`${file} has sha256 ${actual}, SHASUMS256.txt says ${expected}`)
    fs.mkdirSync(unpack)
    await run('tar', ['-xzf', archive, '-C', unpack])
    const target = path.join(options.nodeDir, options.version)
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(path.join(unpack, dist), target)
    log(`node installed ${target}`)
    return path.join(target, 'bin', 'node')
  } finally {
    fs.rmSync(archive, { force: true })
    fs.rmSync(unpack, { recursive: true, force: true })
  }
}

/** Points `link` at `target` atomically: a new symlink renamed over the old one. */
export function flipSymlink(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  fs.symlinkSync(target, tmp)
  try {
    fs.renameSync(tmp, link)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Where a symlink points, resolved against its dir; null when it isn't one. */
export function symlinkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link))
  } catch {
    return null
  }
}
