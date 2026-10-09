import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
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
      // A token given as an argument works, with a warning that ps shows it.
      expect(damaged.stderr).toContain('visible to other users')
      const fromEnv = spawnSync(shell, [installer], { encoding: 'utf8', env: { ...env, DEVTOOL_TOKEN: 'AAAA.24.x.1' } })
      expect(fromEnv.stderr).toContain('damaged')
      expect(fromEnv.stderr).not.toContain('visible to other users')
      expect(fs.existsSync('/nonexistent/devtool-test')).toBe(false)
    })
  }
})

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe.skipIf(process.platform === 'win32' || !has('curl'))('site/install end to end, with a stand-in Node', () => {
  it('fetches and checks the bootstrap, and hands it the token in its environment only', { timeout: 30_000 }, async () => {
    // The site, served from the repo.
    const server = http.createServer((req, res) => {
      const file = path.join(path.resolve('site'), path.normalize(decodeURIComponent((req.url ?? '/').split('?')[0])))
      if (!file.startsWith(path.resolve('site')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200).end(fs.readFileSync(file))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-install-run-'))
    cleanups.push(() => fs.rmSync(work, { recursive: true, force: true }))
    const home = path.join(work, 'home')
    const out = path.join(work, 'out')
    fs.mkdirSync(out)
    // Random, so nothing but a real leak (say, this test's own source in some process) can match it.
    const secret = randomBytes(24).toString('hex')
    const token = `${secret}.${SERVER_NODE_VERSION}`
    // "Node" is a script that answers the installer's probe, then records how the bootstrap was started.
    const nodeBin = path.join(home, 'node', SERVER_NODE_VERSION, 'bin')
    fs.mkdirSync(nodeBin, { recursive: true })
    fs.writeFileSync(path.join(nodeBin, 'node'), [
      '#!/bin/sh',
      '[ "$1" = "-e" ] && exit 0',
      'printf "%s\\n" "$@" > "$STUB_OUT/argv"',
      'env > "$STUB_OUT/env"',
      'ps -A -o args= > "$STUB_OUT/ps" 2>/dev/null || ps -ef > "$STUB_OUT/ps"',
      'exit 0',
      ''
    ].join('\n'), { mode: 0o755 })
    // curl records its arguments before it runs.
    const shims = path.join(work, 'shims')
    fs.mkdirSync(shims)
    const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(shims, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$STUB_OUT/curl"\nexec ${realCurl} "$@"\n`, { mode: 0o755 })

    // `curl ... | DEVTOOL_TOKEN=<token> sh -s -- --name box`: the script on stdin, the token in the environment.
    const child = spawn('sh', ['-s', '--', '--name', 'box'], {
      env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, DEVTOOL_INSTALL_URL: base, DEVTOOL_SERVER_HOME: home, STUB_OUT: out, DEVTOOL_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.end(fs.readFileSync(installer))
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    expect(output).toContain('Node 24.21.0 is already installed.'.replace('24.21.0', SERVER_NODE_VERSION))
    expect(code).toBe(0)

    const argv = fs.readFileSync(path.join(out, 'argv'), 'utf8').trim().split('\n')
    expect(argv[0]).toMatch(/bootstrap\.mjs$/)
    expect(argv.slice(1)).toEqual(['--name', 'box'])
    expect(fs.readFileSync(path.join(out, 'env'), 'utf8')).toContain(`DEVTOOL_TOKEN=${token}\n`)
    // While the bootstrap runs, no process on the machine has the token in its arguments.
    const ps = fs.readFileSync(path.join(out, 'ps'), 'utf8')
    expect(ps).toContain('bootstrap.mjs')
    expect(ps).not.toContain(secret)
    expect(fs.readFileSync(path.join(out, 'curl'), 'utf8')).not.toContain(secret)
    expect(fs.readlinkSync(path.join(home, 'node', 'current'))).toBe(SERVER_NODE_VERSION)
  })
})
