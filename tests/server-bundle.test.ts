import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bundleFiles, bundleSha256, electronGuardPlugin } from '../scripts/server-bundle.mjs'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function bundle(root: string, entry: string): Promise<string> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [electronGuardPlugin(root)]
  })
  return result.outputFiles[0].text
}

describe('server build: electron guard', () => {
  it('fails the build on an electron import, naming the importer', async () => {
    const root = tempDir('devtool-guard-')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src/entry.ts'), "import { helper } from './helper'\nconsole.log(helper())\n")
    fs.writeFileSync(path.join(root, 'src/helper.ts'), "import { app } from 'electron'\nexport const helper = () => app.getVersion()\n")
    await expect(bundle(root, 'src/entry.ts')).rejects.toThrow(/"electron" is imported by src\/helper\.ts/)
  })

  it('also catches electron-updater and electron subpaths', async () => {
    const root = tempDir('devtool-guard-')
    fs.writeFileSync(path.join(root, 'a.ts'), "export { autoUpdater } from 'electron-updater'\n")
    fs.writeFileSync(path.join(root, 'b.ts'), "import 'electron/main'\n")
    await expect(bundle(root, 'a.ts')).rejects.toThrow(/"electron-updater" is imported by a\.ts/)
    await expect(bundle(root, 'b.ts')).rejects.toThrow(/"electron\/main" is imported by b\.ts/)
  })

  it('lets type-only electron imports and look-alike names through', async () => {
    const root = tempDir('devtool-guard-')
    fs.mkdirSync(path.join(root, 'node_modules/electronish'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules/electronish/index.js'), 'export const x = 1\n')
    fs.writeFileSync(path.join(root, 'entry.ts'), "import type { App } from 'electron'\nimport { x } from 'electronish'\nexport const y: App | number = x\n")
    expect(await bundle(root, 'entry.ts')).toContain('x = 1')
  })
})

describe('server build: bundle hash', () => {
  function makeBundle(): string {
    const dir = tempDir('devtool-bundle-')
    fs.mkdirSync(path.join(dir, 'node_modules/node-pty/lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.js'), 'console.log(1)\n')
    fs.writeFileSync(path.join(dir, 'server.js'), 'export {}\n')
    fs.writeFileSync(path.join(dir, 'node_modules/node-pty/lib/index.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"sha256":"?"}\n')
    return dir
  }

  it('lists the files sorted, without the manifest', () => {
    expect(bundleFiles(makeBundle())).toEqual(['main.js', 'node_modules/node-pty/lib/index.js', 'server.js'])
  })

  it('is sha256sum of the sorted listing, and ignores the manifest', () => {
    const dir = makeBundle()
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const listing = bundleFiles(dir).map(file => `${sha(fs.readFileSync(path.join(dir, file), 'utf8'))}  ${file}\n`).join('')
    const hash = bundleSha256(dir)
    expect(hash).toBe(sha(listing))

    fs.writeFileSync(path.join(dir, 'manifest.json'), `{"sha256":"${hash}"}\n`)
    expect(bundleSha256(dir)).toBe(hash)
    fs.writeFileSync(path.join(dir, 'server.js'), 'export {} // changed\n')
    expect(bundleSha256(dir)).not.toBe(hash)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink in the bundle', () => {
    const dir = makeBundle()
    fs.symlinkSync(path.join(dir, 'main.js'), path.join(dir, 'link.js'))
    expect(() => bundleFiles(dir)).toThrow(/link\.js .* not a regular file/)
  })
})
