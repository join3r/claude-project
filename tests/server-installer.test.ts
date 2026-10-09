import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { SERVER_NODE_VERSION } from '../scripts/server-bundle.mjs'
// @ts-expect-error: a plain .mjs script without types
import { bundleBootstrap } from '../scripts/build-installer.mjs'

/**
 * site/install and site/server/bootstrap.mjs are committed (deploying the site is
 * an rsync), so they must match their sources: `npm run build:installer`.
 */

const installer = path.resolve('site/install')
const bootstrap = path.resolve('site/server/bootstrap.mjs')

function has(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`]).status === 0
}

describe('site/install', () => {
  it('is stamped with the Node version and the committed bootstrap\'s sha256', () => {
    const text = fs.readFileSync(installer, 'utf8')
    const sha = createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex')
    expect(text).toContain(`NODE_DEFAULT='${SERVER_NODE_VERSION}'`)
    expect(text).toContain(`BOOTSTRAP_SHA256='${sha}'`)
    expect(text).not.toContain('@@')
    expect(fs.statSync(installer).mode & 0o111).not.toBe(0)
  })

  it('bootstrap.mjs is what src/server/bootstrap.ts builds to (run npm run build:installer)', async () => {
    const fresh = Buffer.from(await bundleBootstrap() as Uint8Array)
    expect(createHash('sha256').update(fresh).digest('hex')).toBe(createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex'))
  }, 30_000)

  it.skipIf(process.platform === 'win32' || !has('shellcheck'))('passes shellcheck as POSIX sh', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', installer], { encoding: 'utf8' })
    expect(result.stdout + result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  for (const shell of ['sh', 'dash', 'bash', 'zsh']) {
    // Windows has at most Git Bash, which the installer refuses as a platform.
    it.skipIf(process.platform === 'win32' || !has(shell))(`parses with ${shell} and refuses bad arguments before touching anything`, () => {
      expect(spawnSync(shell, ['-n', installer]).status).toBe(0)
      const env = { ...process.env, DEVTOOL_SERVER_HOME: '/nonexistent/devtool-test' }
      const help = spawnSync(shell, [installer, '--help'], { encoding: 'utf8', env })
      expect(help.status).toBe(0)
      expect(help.stdout).toMatch(/^usage:/)
      const bogus = spawnSync(shell, [installer, '--bogus'], { encoding: 'utf8', env })
      expect(bogus.status).toBe(1)
      expect(bogus.stderr).toContain('unknown option: --bogus')
      const code = spawnSync(shell, [installer, 'AAAA'], { encoding: 'utf8', env })
      expect(code.status).toBe(1)
      expect(code.stderr).toContain('pairing code for DevTool')
      const damaged = spawnSync(shell, [installer, 'AAAA.24.x.1'], { encoding: 'utf8', env })
      expect(damaged.status).toBe(1)
      expect(damaged.stderr).toContain('damaged')
      expect(fs.existsSync('/nonexistent/devtool-test')).toBe(false)
    })
  }
})
