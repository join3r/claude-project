import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BINDING_GLOBAL, DATACHANNEL_MANIFEST, matchesIntegrity, prebuildName, prepareDatachannel } from '../src/server/datachannel-binary'

const dirs: string[] = []
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BINDING_GLOBAL]
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ndc-'))
  dirs.push(dir)
  return dir
}

const integrity = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

/** This machine's installed prebuild, packed the way npm ships it. */
function hostTarball(): Uint8Array | null {
  const name = prebuildName()
  const binary = name && path.resolve('node_modules/@node-datachannel', name, 'node_datachannel.node')
  if (!binary || !fs.existsSync(binary)) return null
  const work = tempDir()
  fs.mkdirSync(path.join(work, 'package'))
  fs.copyFileSync(binary, path.join(work, 'package', 'node_datachannel.node'))
  execFileSync('tar', ['-czf', path.join(work, 'p.tgz'), '-C', work, 'package'])
  return new Uint8Array(fs.readFileSync(path.join(work, 'p.tgz')))
}

function bundleWith(prebuild: { url: string; integrity: string }): string {
  const bundleDir = tempDir()
  const name = prebuildName()!
  fs.writeFileSync(path.join(bundleDir, DATACHANNEL_MANIFEST), JSON.stringify({ version: '0.0.0-test', prebuilds: { [name]: prebuild } }))
  return bundleDir
}

describe('node-datachannel binary for a bundled server', () => {
  it('names prebuilds the way node-datachannel does', () => {
    expect(prebuildName('linux', 'x64', true)).toBe('linux-x64-gnu')
    expect(prebuildName('linux', 'arm64', false)).toBe('linux-arm64-musl')
    expect(prebuildName('darwin', 'arm64')).toBe('darwin-arm64')
    expect(prebuildName('win32', 'x64')).toBeNull()
    expect(prebuildName('linux', 'ia32')).toBeNull()
  })

  it('checks npm sha512 integrity strings', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(matchesIntegrity(bytes, integrity(bytes))).toBe(true)
    expect(matchesIntegrity(new Uint8Array([1, 2, 4]), integrity(bytes))).toBe(false)
    expect(matchesIntegrity(bytes, 'sha1-abc')).toBe(false)
  })

  it('does nothing for a server run from source (no manifest)', async () => {
    expect(await prepareDatachannel({ bundleDir: tempDir(), home: tempDir(), log: () => {} })).toBe(false)
  })

  it('refuses a download that does not match its hash, and keeps nothing', async () => {
    if (!prebuildName()) return
    const home = tempDir()
    const bundleDir = bundleWith({ url: 'https://example.invalid/p.tgz', integrity: integrity(new Uint8Array([9])) })
    await expect(prepareDatachannel({ bundleDir, home, log: () => {}, fetchBytes: async () => new Uint8Array([1]) })).rejects.toThrow(/sha512/)
    expect(fs.existsSync(path.join(home, 'native'))).toBe(false)
  })

  it.skipIf(!hostTarball())('fetches, unpacks and loads the binary once, then reuses it', async () => {
    const tarball = hostTarball()!
    const home = tempDir()
    const bundleDir = bundleWith({ url: 'https://example.invalid/p.tgz', integrity: integrity(tarball) })
    let fetches = 0
    const fetchBytes = async () => { fetches++; return tarball }
    expect(await prepareDatachannel({ bundleDir, home, log: () => {}, fetchBytes })).toBe(true)
    const binding = (globalThis as Record<string, unknown>)[BINDING_GLOBAL] as { PeerConnection?: unknown }
    expect(typeof binding.PeerConnection).toBe('function')
    delete (globalThis as Record<string, unknown>)[BINDING_GLOBAL]
    expect(await prepareDatachannel({ bundleDir, home, log: () => {}, fetchBytes })).toBe(true)
    expect(fetches).toBe(1)
  })
})
