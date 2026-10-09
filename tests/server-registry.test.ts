import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChildProcess } from 'child_process'
import { ClientRegistry } from '../src/server/client-registry'
import { v } from '../src/main/ipc/validate'
import {
  loadServerManifest,
  loginShell,
  passThroughImageCodec,
  plaintextSecrets,
  serverPaths
} from '../src/server/server-env'
import { inhibitorCommand, ProcessPowerSave } from '../src/server/power-save'
import { fitImage, ImageTooLargeError } from '../src/main/mobile/chat-image'
import { IdentityStore } from '../src/main/mobile/identity'

function registryWithHandlers(log: (message: string) => void = () => {}) {
  const gone: string[] = []
  const registry = new ClientRegistry({ onClientGone: (id) => gone.push(id), log })
  const ipc = registry.createRegistrar(log)
  ipc.handle('echo', [v.string()], (ctx, text) => ({ from: ctx.clientId, text }))
  ipc.handle('focus', [], (ctx) => ctx.isFocused())
  ipc.handle('mutate', [v.plainObject()], (_ctx, value) => { (value as { touched?: boolean }).touched = true; return value })
  const fired: { clientId: string; n: number }[] = []
  ipc.on('fire', [v.number()], (ctx, n) => { fired.push({ clientId: ctx.clientId, n }) })
  ipc.onSync('sync', [v.string()], (_ctx, text) => `sync:${text}`, 'fallback')
  return { registry, gone, fired }
}

describe('ClientRegistry', () => {
  it('runs invoke, send and sendSync channels as the calling client', async () => {
    const { registry, fired } = registryWithHandlers()
    registry.registerClient('link:d1/1', () => {})
    expect(await registry.call('link:d1/1', 'echo', ['hi'])).toEqual({ from: 'link:d1/1', text: 'hi' })
    expect(await registry.call('link:d1/1', 'fire', [7])).toBeUndefined()
    expect(fired).toEqual([{ clientId: 'link:d1/1', n: 7 }])
    expect(await registry.call('link:d1/1', 'sync', ['x'])).toBe('sync:x')
    await expect(registry.call('link:d1/1', 'nope')).rejects.toThrow('No handler for nope')
  })

  it('refuses clients that are not registered, or no longer are', async () => {
    const log = vi.fn()
    const { registry, gone, fired } = registryWithHandlers(log)
    await expect(registry.call('stranger', 'echo', ['hi'])).rejects.toThrow(/IPC echo refused/)
    // A refused send is dropped, as a window's is.
    await registry.call('stranger', 'fire', [1])
    expect(fired).toEqual([])
    expect(await registry.call('stranger', 'sync', ['x'])).toBe('fallback')

    registry.registerClient('c1', () => {})
    registry.unregisterClient('c1')
    expect(gone).toEqual(['c1'])
    expect(registry.hasClient('c1')).toBe(false)
    await expect(registry.call('c1', 'echo', ['hi'])).rejects.toThrow(/refused/)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ipcRefused channel=echo'))
  })

  it('validates arguments before the handler runs', async () => {
    const { registry } = registryWithHandlers()
    registry.registerClient('c1', () => {})
    await expect(registry.call('c1', 'echo', [42])).rejects.toThrow(/Invalid IPC argument/)
  })

  it('passes each client its own focus', async () => {
    const { registry } = registryWithHandlers()
    let focused = false
    registry.registerClient('c1', () => {}, { isFocused: () => focused })
    registry.registerClient('c2', () => {})
    expect(await registry.call('c1', 'focus')).toBe(false)
    focused = true
    expect(await registry.call('c1', 'focus')).toBe(true)
    expect(await registry.call('c2', 'focus')).toBe(false)
  })

  it('copies arguments and results across the boundary, as IPC does', async () => {
    const { registry } = registryWithHandlers()
    registry.registerClient('c1', () => {})
    const arg = { a: 1 }
    const result = await registry.call('c1', 'mutate', [arg]) as { touched?: boolean }
    expect(result).toEqual({ a: 1, touched: true })
    expect(arg).toEqual({ a: 1 })
  })

  it('delivers send and broadcast to the registered sinks, each with its own copy', () => {
    const log = vi.fn()
    const registry = new ClientRegistry({ log })
    const got: Record<string, [string, unknown[]][]> = { c1: [], c2: [] }
    registry.registerClient('c1', (channel, args) => { got.c1.push([channel, args]) })
    registry.registerClient('c2', (channel, args) => { got.c2.push([channel, args]) })
    registry.registerClient('broken', () => { throw new Error('sink down') })
    expect(registry.clientIds()).toEqual(['c1', 'c2', 'broken'])

    registry.send('c2', 'pty-data', 't1', 'hi')
    registry.send('gone', 'pty-data', 't1', 'lost')
    const payload = { revision: 1 }
    registry.broadcast('projects-updated', payload)

    expect(got.c1).toEqual([['projects-updated', [{ revision: 1 }]]])
    expect(got.c2).toEqual([['pty-data', ['t1', 'hi']], ['projects-updated', [{ revision: 1 }]]])
    expect(got.c1[0][1][0]).not.toBe(payload)
    expect(got.c1[0][1][0]).not.toBe(got.c2[1][1][0])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('clientSendFailed clientId=broken channel=projects-updated'))
  })

  it('refuses a second registration of a client id or a channel', () => {
    const { registry } = registryWithHandlers()
    registry.registerClient('c1', () => {})
    expect(() => registry.registerClient('c1', () => {})).toThrow(/already registered/)
    expect(() => registry.handle('echo', () => 1)).toThrow(/already registered/)
  })
})

describe('server env', () => {
  it('lives in ~/.devtool-server unless DEVTOOL_SERVER_HOME says otherwise', () => {
    expect(serverPaths({})).toEqual({
      home: path.join(os.homedir(), '.devtool-server'),
      dataDir: path.join(os.homedir(), '.devtool-server', 'data')
    })
    const custom = path.resolve('/srv/devtool')
    expect(serverPaths({ DEVTOOL_SERVER_HOME: '/srv/devtool' })).toEqual({ home: custom, dataDir: path.join(custom, 'data') })
  })

  it('reads the bundle manifest, or falls back to the repo version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-manifest-'))
    try {
      const manifest = { version: '9.9.9', commit: 'abc', builtAt: '2026-10-09T00:00:00.000Z', protocol: 0, node: '24.21.0', sha256: 'f00' }
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
      expect(loadServerManifest(dir)).toEqual(manifest)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
    expect(loadServerManifest(path.resolve('src/server'))).toMatchObject({ version, commit: 'dev', sha256: 'dev' })
  })

  it('logs in with $SHELL, or the passwd shell when that is unset or /bin/sh', () => {
    expect(loginShell('/bin/zsh', '/bin/bash')).toBe('/bin/zsh')
    expect(loginShell('/bin/sh', '/bin/bash')).toBe('/bin/bash')
    expect(loginShell(undefined, '/usr/bin/fish')).toBe('/usr/bin/fish')
    expect(loginShell('', '/bin/bash')).toBe('/bin/bash')
    expect(loginShell('/bin/sh', '/usr/sbin/nologin')).toBe('/bin/sh')
    expect(loginShell(undefined, '/bin/false')).toBeUndefined()
    expect(loginShell(undefined, null)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('stores the identity unencrypted, 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-identity-'))
    try {
      const identity = new IdentityStore(path.join(dir, 'mobile'), plaintextSecrets).get()
      const file = path.join(dir, 'mobile', 'identity.json')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).enc).toBe('none')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(new IdentityStore(path.join(dir, 'mobile'), plaintextSecrets).get().id).toBe(identity.id)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes phone images through when they fit and refuses them otherwise', () => {
    const image = { mediaType: 'image/png', data: Buffer.from('not really a png').toString('base64') }
    expect(fitImage(image, 64, passThroughImageCodec)).toEqual(image)
    expect(() => fitImage(image, 64, passThroughImageCodec, 4)).toThrow(ImageTooLargeError)
  })
})

describe('ProcessPowerSave', () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    child.kill = vi.fn(() => { child.emit('exit', null, 'SIGTERM') })
    return child
  }

  it('runs caffeinate on macOS and systemd-inhibit on Linux, both tied to the server pid', () => {
    expect(inhibitorCommand('darwin', 42)).toEqual({ file: '/usr/bin/caffeinate', args: ['-i', '-w', '42'] })
    expect(inhibitorCommand('linux', 42)?.file).toBe('systemd-inhibit')
    expect(inhibitorCommand('linux', 42)?.args.slice(-4)).toEqual(['tail', '--pid=42', '-f', '/dev/null'])
    expect(inhibitorCommand('win32', 42)).toBeNull()
  })

  it('holds a blocker while its process runs and stops it on stop', () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const spawn = vi.fn(() => {
      const child = fakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    })
    const power = new ProcessPowerSave({ platform: 'linux', pid: 7, spawn })
    const id = power.start('prevent-app-suspension')
    expect(spawn).toHaveBeenCalledWith('systemd-inhibit', expect.arrayContaining(['--pid=7']))
    expect(power.isStarted(id)).toBe(true)
    power.stop(id)
    expect(children[0].kill).toHaveBeenCalled()
    expect(power.isStarted(id)).toBe(false)
  })

  it('gives up for good, with one log line, when the inhibitor is missing or refused', () => {
    const log = vi.fn()
    const children: ReturnType<typeof fakeChild>[] = []
    const spawn = vi.fn(() => {
      const child = fakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    })
    const power = new ProcessPowerSave({ platform: 'linux', pid: 7, spawn, log })
    const id = power.start('prevent-app-suspension')
    children[0].emit('exit', 1, null)
    expect(power.isStarted(id)).toBe(false)
    const again = power.start('prevent-app-suspension')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(power.isStarted(again)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/powerSave unavailable/)
  })

  it('blocks nothing on a platform without an inhibitor', () => {
    const spawn = vi.fn()
    const power = new ProcessPowerSave({ platform: 'freebsd', spawn })
    expect(power.isStarted(power.start('prevent-app-suspension'))).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
})
