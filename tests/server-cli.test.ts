import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseCliArgs, removeServerFiles, runCli, type CliIo, type DaemonStatus } from '../src/server/cli'
import {
  ControlServer,
  NotRunningError,
  UnsafeControlSocketError,
  assertPrivateDir,
  chooseControlSocket,
  controlRecordFile,
  controlRequest,
  ensurePrivateRunDir,
  findControlSocket
} from '../src/server/control'
import { parseMainArgs } from '../src/server/main'
import { checkPlatform, parseBootstrapArgs, takeToken } from '../src/server/bootstrap'
import { serverPaths } from '../src/server/server-env'
import type { ServiceContext } from '../src/server/service'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-cli-'))
  dirs.push(dir)
  return dir
}
const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('argument parsing', () => {
  it('parses the CLI', () => {
    expect(parseCliArgs(['status'])).toEqual({ cmd: 'status' })
    expect(parseCliArgs(['logs'])).toEqual({ cmd: 'logs', follow: false, lines: 200 })
    expect(parseCliArgs(['logs', '-f', '-n', '50'])).toEqual({ cmd: 'logs', follow: true, lines: 50 })
    expect(parseCliArgs(['pair'])).toEqual({ cmd: 'pair', wait: true })
    expect(parseCliArgs(['pair', '--no-wait'])).toEqual({ cmd: 'pair', wait: false })
    expect(parseCliArgs(['unpair', 'abc123'])).toEqual({ cmd: 'unpair', target: 'abc123' })
    expect(parseCliArgs(['uninstall'])).toEqual({ cmd: 'uninstall', data: 'ask', yes: false })
    expect(parseCliArgs(['uninstall', '--delete-data', '-y'])).toEqual({ cmd: 'uninstall', data: 'delete', yes: true })
    expect(parseCliArgs(['--help'])).toEqual({ cmd: 'help' })
    expect(() => parseCliArgs(['status', 'x'])).toThrow(/no arguments/)
    expect(() => parseCliArgs(['logs', '-n', 'x'])).toThrow(/number/)
    expect(() => parseCliArgs(['unpair'])).toThrow(/usage/)
    expect(() => parseCliArgs(['uninstall', '--keep-data', '--delete-data'])).toThrow(/choose one/)
    expect(() => parseCliArgs(['frobnicate'])).toThrow(/unknown command/)
    expect(() => parseCliArgs([])).toThrow(/usage/)
  })

  it('parses the launcher: daemon, check, version, CLI commands', () => {
    expect(parseMainArgs([])).toEqual({ mode: 'run' })
    expect(parseMainArgs(['--relay', 'ws://r'])).toEqual({ mode: 'run', relay: 'ws://r' })
    expect(parseMainArgs(['--check'])).toEqual({ mode: 'check' })
    expect(parseMainArgs(['status'])).toEqual({ mode: 'cli', argv: ['status'] })
    expect(parseMainArgs(['logs', '-f'])).toEqual({ mode: 'cli', argv: ['logs', '-f'] })
    expect(parseMainArgs(['--dev-pair', 'x'])).toBeNull()
  })

  it('takes the install token from DEVTOOL_TOKEN and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { DEVTOOL_TOKEN: ' T.24.21.0 ', HOME: '/h' }
    const warnings: string[] = []
    expect(takeToken({ allowRoot: false, noService: false }, env, (line) => warnings.push(line))).toMatchObject({ token: 'T.24.21.0' })
    expect(env).toEqual({ HOME: '/h' })
    expect(warnings).toEqual([])
    const flagged = takeToken({ token: 'F.1.2.3', allowRoot: false, noService: false }, { DEVTOOL_TOKEN: 'E.1.2.3' }, (line) => warnings.push(line))
    expect(flagged.token).toBe('F.1.2.3')
    expect(warnings[0]).toMatch(/visible to other users/)
    expect(takeToken({ allowRoot: false, noService: false }, {}).token).toBeUndefined()
  })

  it('parses the bootstrap', () => {
    expect(parseBootstrapArgs(['--token', 'T.24.21.0', '--name', 'box', '--allow-root'])).toEqual({ token: 'T.24.21.0', name: 'box', allowRoot: true, noService: false })
    expect(parseBootstrapArgs([])).toEqual({ allowRoot: false, noService: false })
    expect(() => parseBootstrapArgs(['--token'])).toThrow(/needs a value/)
    expect(() => parseBootstrapArgs(['extra'])).toThrow(/unexpected/)
  })
})

describe('bootstrap platform checks', () => {
  const ok = { platform: 'linux', arch: 'arm64', node: '24.21.0', glibc: '2.43', uid: 501, allowRoot: false }
  it('accepts Linux with glibc 2.28+ and macOS', () => {
    expect(() => checkPlatform(ok)).not.toThrow()
    expect(() => checkPlatform({ ...ok, glibc: '2.28' })).not.toThrow()
    expect(() => checkPlatform({ ...ok, platform: 'darwin', arch: 'x64', glibc: null })).not.toThrow()
  })
  it('refuses what the server cannot run on, and root without --allow-root', () => {
    expect(() => checkPlatform({ ...ok, platform: 'win32' })).toThrow(/Linux and macOS/)
    expect(() => checkPlatform({ ...ok, arch: 'ia32' })).toThrow(/x64 and arm64/)
    expect(() => checkPlatform({ ...ok, glibc: null })).toThrow(/no glibc/)
    expect(() => checkPlatform({ ...ok, glibc: '2.27' })).toThrow(/too old/)
    expect(() => checkPlatform({ ...ok, node: '22.1.0' })).toThrow(/Node 24/)
    expect(() => checkPlatform({ ...ok, uid: 0 })).toThrow(/--allow-root/)
    expect(() => checkPlatform({ ...ok, uid: 0, allowRoot: true })).not.toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('the CLI against a running server', () => {
  function io(): CliIo & { lines: string[]; errors: string[] } {
    const lines: string[] = []
    const errors: string[] = []
    return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line), confirm: async () => null }
  }
  const ctx = (paths: ReturnType<typeof serverPaths>): ServiceContext => ({ paths, suffix: '.test', platform: 'linux', uid: 1, user: 'u', userHome: tempDir(), log: () => {}, run: async () => ({ code: 127, stdout: '', stderr: '' }) })

  const status: DaemonStatus = {
    pid: 4242, serverId: 'f'.repeat(32), name: 'box', version: '0.6.0', commit: 'abcdef1234567890', builtAt: '2026-10-09T10:00:00Z', node: '24.21.0',
    home: '/h', supervisor: 'systemd', relay: { url: 'ws://r', state: 'online' },
    desktops: [{ id: 'a1'.repeat(16), name: 'join3r-mbp', online: true, pairedAt: 1, lastSeen: Date.now() }, { id: 'b2'.repeat(16), name: 'other', online: false, pairedAt: 1, lastSeen: null }],
    phones: [], update: { state: 'staged', version: '0.6.1', commit: 'cafe', builtAt: '' }
  }

  async function serve(handler: (cmd: string, request: Record<string, unknown>) => unknown, home = tempDir()) {
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: home })
    const control = new ControlServer(paths, async (request) => handler(request.cmd, request), () => {}, {})
    await control.start()
    closers.push(() => control.close())
    return paths
  }

  it('reports not running when nothing listens', async () => {
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: tempDir() })
    await expect(controlRequest(paths, { cmd: 'status' })).rejects.toBeInstanceOf(NotRunningError)
    const out = io()
    expect(await runCli(['status'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(3)
    expect(out.lines[0]).toBe('DevTool server: not running')
  })

  it('prints status, a pairing code, and unpairs by name or id prefix', async () => {
    const unpaired: string[] = []
    const paths = await serve((cmd, request) => {
      if (cmd === 'status') return status
      if (cmd === 'pair') return { code: 'CODE', exp: 2_000_000_000, state: 'waiting' }
      if (cmd === 'unpair') {
        unpaired.push(String(request.id))
        return { removed: true }
      }
      throw new Error('nope')
    })
    let out = io()
    expect(await runCli(['status'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(0)
    const text = out.lines.join('\n')
    expect(text).toContain('DevTool server "box"')
    expect(text).toContain('0.6.0 (commit abcdef123456')
    expect(text).toMatch(/join3r-mbp\s+a1a1a1a1\s+connected/)
    expect(text).toMatch(/other\s+b2b2b2b2\s+last seen never/)
    expect(text).toContain('0.6.1 (cafe) staged')

    out = io()
    expect(await runCli(['pair', '--no-wait'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(0)
    expect(out.lines).toContain('  CODE')

    out = io()
    expect(await runCli(['unpair', 'other'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(0)
    expect(await runCli(['unpair', 'a1a1'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(0)
    expect(unpaired).toEqual(['b2'.repeat(16), 'a1'.repeat(16)])
    expect(await runCli(['unpair', 'zzz'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(1)
  })

  it('a long home gets a fresh private dir in the temp dir, recorded under run/ for the CLI', async () => {
    const home = path.join(tempDir(), 'x'.repeat(110))
    fs.mkdirSync(home)
    const paths = await serve(() => status, home)
    const socket = fs.readFileSync(controlRecordFile(paths), 'utf8').trim()
    expect(socket.startsWith(fs.realpathSync(os.tmpdir())) || socket.startsWith(os.tmpdir())).toBe(true)
    expect(Buffer.byteLength(socket)).toBeLessThan(104)
    expect(fs.statSync(path.dirname(socket)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(socket).mode & 0o077).toBe(0)
    expect(findControlSocket(paths)).toBe(socket)
    await expect(controlRequest(paths, { cmd: 'status' })).resolves.toMatchObject({ name: 'box' })
  })

  it('prefers a private XDG_RUNTIME_DIR and skips one that is open, someone else\'s, or a symlink', () => {
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: tempDir() })
    // Short, so a socket in it fits (macOS temp dirs are long).
    const runtime = fs.mkdtempSync('/tmp/dts-')
    dirs.push(runtime)
    fs.chmodSync(runtime, 0o700)
    expect(path.dirname(chooseControlSocket(paths, { XDG_RUNTIME_DIR: runtime }).socket)).toBe(runtime)
    // Anything else falls back to run/ (or, for a long home, a fresh temp dir): never the runtime dir.
    const notRuntime = (env: NodeJS.ProcessEnv, uid?: number) => path.dirname(chooseControlSocket(paths, env, uid).socket) !== runtime
    fs.chmodSync(runtime, 0o755)
    expect(notRuntime({ XDG_RUNTIME_DIR: runtime })).toBe(true)
    fs.chmodSync(runtime, 0o700)
    expect(notRuntime({ XDG_RUNTIME_DIR: runtime }, process.getuid!() + 1)).toBe(true)
    const link = path.join(tempDir(), 'link')
    fs.symlinkSync(runtime, link)
    expect(path.dirname(chooseControlSocket(paths, { XDG_RUNTIME_DIR: link }).socket)).not.toBe(link)
  })

  it('refuses a run dir that is a symlink or belongs to someone else, and closes one of ours that is too open', async () => {
    const elsewhere = tempDir()
    const home = tempDir()
    fs.symlinkSync(elsewhere, path.join(home, 'run'))
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: home })
    const control = new ControlServer(paths, async () => null, () => {}, {})
    await expect(control.start()).rejects.toBeInstanceOf(UnsafeControlSocketError)
    expect(() => findControlSocket(paths)).toThrow(/symlink/)
    await expect(runCli(['status'], { bundleDir: '.', io: io(), paths, ctx: ctx(paths) })).resolves.toBe(1)

    const own = serverPaths({ DEVTOOL_SERVER_HOME: tempDir() })
    fs.mkdirSync(own.runDir, { mode: 0o755 })
    fs.chmodSync(own.runDir, 0o755)
    ensurePrivateRunDir(own)
    expect(fs.statSync(own.runDir).mode & 0o777).toBe(0o700)
    expect(() => assertPrivateDir(own.runDir, process.getuid!() + 1)).toThrow(/belongs to uid/)
  })

  it('the CLI refuses a recorded socket in an open dir, or a planted file that is not a socket', async () => {
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: tempDir() })
    ensurePrivateRunDir(paths)
    const open = tempDir()
    fs.chmodSync(open, 0o777)
    fs.writeFileSync(controlRecordFile(paths), `${path.join(open, 'control.sock')}\n`)
    expect(() => findControlSocket(paths)).toThrow(/open to other users/)
    const out = io()
    expect(await runCli(['pair', '--no-wait'], { bundleDir: '.', io: out, paths, ctx: ctx(paths) })).toBe(1)
    expect(out.errors[0]).toMatch(/^Refusing to talk to the server/)

    // A server won't start over something at its socket path that isn't its socket.
    fs.rmSync(controlRecordFile(paths))
    fs.writeFileSync(path.join(paths.runDir, 'control.sock'), 'not a socket')
    const control = new ControlServer(paths, async () => null, () => {}, {})
    await expect(control.start()).rejects.toThrow(/not a socket of yours/)
  })

  it('uninstall keeps the data dir unless asked to delete it', async () => {
    const home = tempDir()
    const paths = serverPaths({ DEVTOOL_SERVER_HOME: home })
    for (const dir of [paths.dataDir, paths.appDir, paths.nodeDir, paths.binDir, paths.logsDir]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(paths.dataDir, 'desktops.json'), '[]')
    removeServerFiles(paths, false)
    expect(fs.readdirSync(home)).toEqual(['data'])
    removeServerFiles(paths, true)
    expect(fs.existsSync(home)).toBe(false)
  })
})
