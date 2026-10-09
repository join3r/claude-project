import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HostRouter, LOCAL_HOST, RouteIndex, type RouterHub } from '../src/main/servers/host-router'
import { HOST_ROUTES, SERVER_EVENTS } from '../src/main/servers/host-routes'
import type { IpcContext, IpcRegistrar } from '../src/main/ipc/registrar'
import { fixtureProject } from './helpers/streams-fixtures'
import type { HostServices } from '../src/main/host/host-services'

type Handler = (ctx: IpcContext, ...args: unknown[]) => unknown

/** A registrar that only records what is registered, so a test can call the (wrapped) handlers. */
function recordingRegistrar() {
  const handlers = new Map<string, { kind: 'handle' | 'on' | 'onSync'; handler: Handler }>()
  const registrar: IpcRegistrar = {
    handle: (channel, _schema, handler) => { handlers.set(channel, { kind: 'handle', handler: handler as unknown as Handler }) },
    on: (channel, _schema, handler) => { handlers.set(channel, { kind: 'on', handler: handler as unknown as Handler }) },
    onSync: (channel, _schema, handler) => { handlers.set(channel, { kind: 'onSync', handler: handler as unknown as Handler }) }
  }
  return { registrar, handlers }
}

const ctx = (clientId = 'win:1', focused = true): IpcContext => ({ clientId, isFocused: () => focused })

describe('host route table', () => {
  let configDir: string
  let host: HostServices
  let channels: string[]

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-router-'))
    const { HostServices } = await import('../src/main/host/host-services')
    const { plaintextSecrets, passThroughImageCodec } = await import('../src/server/server-env')
    host = new HostServices({
      env: {
        configDir,
        appVersion: '0.0.0',
        resourcePath: (name) => name,
        secrets: plaintextSecrets,
        powerSave: { start: () => 1, stop: () => {}, isStarted: () => false },
        images: passThroughImageCodec,
        log: () => {}
      },
      clients: { send: () => {}, broadcast: () => {}, clientIds: () => [] }
    })
    const { registrar, handlers } = recordingRegistrar()
    host.registerIpcHandlers(registrar)
    channels = [...handlers.keys()]
  })

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('has a route for every host channel, and none for a channel the host doesn\'t have', () => {
    expect(channels.length).toBeGreaterThan(100)
    expect(channels.filter(ch => !(ch in HOST_ROUTES))).toEqual([])
    expect(Object.keys(HOST_ROUTES).filter(ch => !channels.includes(ch))).toEqual([])
  })

  it('refuses to register a channel without a route', () => {
    const router = new HostRouter({ hub: () => null, index: new RouteIndex(), windows: { send: () => {}, broadcast: () => {} }, onProjectsUpdate: () => {}, log: () => {} })
    const { registrar } = recordingRegistrar()
    expect(() => router.wrap(registrar).handle('no-such-host-channel', [], () => 1)).toThrow(/has no route/)
    expect(() => host.registerIpcHandlers(router.wrap(recordingRegistrar().registrar))).not.toThrow()
  })

  it('has a rule for every push the host sends', () => {
    // Every `broadcast('x'` / `send(<client>, 'x'` in the host's code.
    const desktopOnly = new Set(['index.ts', 'app-runtime.ts', 'updates.ts', 'window.ts', 'socks-proxy.ts'])
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && !desktopOnly.has(entry.name)) files.push(full)
      }
    }
    walk(path.resolve('src/main'))
    const pattern = /(?:broadcast|sendToClient|broadcastToAttached|broadcastToAttachedClients|send)\((?:[\w.]+, )?'([a-z0-9:-]+)'/g
    const pushed = new Set<string>()
    for (const file of files) {
      if (file.includes(`${path.sep}servers${path.sep}`)) continue
      for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) pushed.add(match[1])
    }
    for (const channel of ['servers-state-changed']) pushed.delete(channel)
    expect([...pushed].filter(ch => !(ch in SERVER_EVENTS))).toEqual([])
  })
})

describe('HostRouter', () => {
  function setup() {
    const index = new RouteIndex()
    index.update([
      fixtureProject({ id: 'local-p', directory: '/home/me/l', tasks: [{ id: 'local-t', tabs: { left: [{ id: 'local-tab', type: 'terminal', title: 'T' }] } }] }),
      {
        ...fixtureProject({ id: 'srv-p', directory: '/srv/p', tasks: [{ id: 'srv-t', tabs: { left: [{ id: 'srv-tab', type: 'terminal', title: 'T' }] } }] }),
        host: 'srvA'
      }
    ])
    const calls: Array<{ serverId: string; clientId: string; ch: string; args: unknown[]; focused?: boolean }> = []
    const online = ['srvA']
    const hub: RouterHub = {
      call: async (serverId, clientId, ch, args, options) => {
        calls.push({ serverId, clientId, ch, args, focused: options.focused })
        if (ch === 'get-agent-activity') return { 'srv-tab': { tool: 'Bash' } }
        if (ch === 'pty-spawn') return { cols: 80, rows: 24, scrollback: 'from the server', exitCode: null }
        return undefined
      },
      onlineServers: () => online
    }
    const sent: unknown[][] = []
    const broadcast: unknown[][] = []
    const projectUpdates: unknown[][] = []
    const router = new HostRouter({
      hub: () => hub,
      index,
      windows: {
        send: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
        broadcast: (channel, ...args) => { broadcast.push([channel, ...args]) }
      },
      onProjectsUpdate: (serverId, update) => projectUpdates.push([serverId, update]),
      custom: { 'save-projects': (serverId, c, args) => ({ custom: serverId, clientId: c.clientId, payload: args[1] }) },
      desktop: { 'load-projects': (_c, args, local) => ({ ...(local(args) as object), srvA: { revision: 9 } }) },
      log: () => {}
    })
    const { registrar, handlers } = recordingRegistrar()
    const wrapped = router.wrap(registrar)
    const local = new Map<string, ReturnType<typeof vi.fn>>()
    const register = (channel: string, kind: 'handle' | 'on' | 'onSync' = 'handle', answer: unknown = 'local-answer') => {
      const fn = vi.fn(() => answer)
      local.set(channel, fn)
      if (kind === 'handle') wrapped.handle(channel, [], fn as never)
      else if (kind === 'on') wrapped.on(channel, [], fn as never)
      else wrapped.onSync(channel, [], fn as never, false)
    }
    const invoke = (channel: string, args: unknown[], c = ctx()) => handlers.get(channel)!.handler(c, ...args)
    return { router, index, hub, calls, sent, broadcast, projectUpdates, register, invoke, local }
  }

  it('spawns a server project\'s PTY on its server, as the calling window, and keeps the tab there', async () => {
    const t = setup()
    t.register('pty-spawn')
    t.register('pty-write', 'on')
    t.register('pty-kill', 'on')

    const args = ['new-tab', '', '/srv/p', 80, 24, undefined, undefined, 'srv-p', undefined]
    const attach = await t.invoke('pty-spawn', args, ctx('win:3', false))
    expect(attach).toMatchObject({ scrollback: 'from the server' })
    expect(t.calls).toEqual([{ serverId: 'srvA', clientId: 'win:3', ch: 'pty-spawn', args, focused: false }])
    expect(t.local.get('pty-spawn')).not.toHaveBeenCalled()

    // The tab id was never in the data: its spawn put it on the server.
    t.invoke('pty-write', ['new-tab', 'echo hi\r'])
    t.invoke('pty-kill', ['new-tab'])
    await Promise.resolve()
    expect(t.calls.slice(1).map(c => [c.serverId, c.ch, c.args])).toEqual([
      ['srvA', 'pty-write', ['new-tab', 'echo hi\r']],
      ['srvA', 'pty-kill', ['new-tab']]
    ])
    expect(t.local.get('pty-write')).not.toHaveBeenCalled()
  })

  it('runs a local project\'s calls here', async () => {
    const t = setup()
    t.register('pty-spawn')
    t.register('pty-write', 'on')
    expect(await t.invoke('pty-spawn', ['local-tab', '', '/home/me/l', 80, 24, undefined, undefined, 'local-p', undefined])).toBe('local-answer')
    t.invoke('pty-write', ['local-tab', 'x'])
    t.invoke('pty-write', ['unknown-tab', 'x'])
    expect(t.local.get('pty-write')).toHaveBeenCalledTimes(2)
    expect(t.calls).toEqual([])
    expect(t.router.hostFor('pty-write', ['local-tab', 'x'])).toBe(LOCAL_HOST)
  })

  it('routes a tab that left the data to the host it was on', async () => {
    const t = setup()
    t.register('chat-close', 'on')
    // The data no longer has the server's tab (its task was closed): the index still knows it.
    t.index.update([fixtureProject({ id: 'local-p', directory: '/home/me/l' })])
    t.invoke('chat-close', ['srv-tab'])
    await Promise.resolve()
    expect(t.calls.map(c => [c.serverId, c.ch])).toEqual([['srvA', 'chat-close']])
  })

  it('sends pushes from a server to the window they name, or to every window', () => {
    const t = setup()
    t.router.deliver({ serverId: 'srvA', client: 'win:2', ch: 'pty-data', args: ['srv-tab', 'output'] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'agent-activity', args: ['srv-tab', { tool: 'Bash' }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'config-updated', args: [{ theme: 'dark' }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'something-new', args: [] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'projects-updated', args: [{ source: 'local', revision: 3 }] })
    expect(t.sent).toEqual([['win:2', 'pty-data', 'srv-tab', 'output']])
    expect(t.broadcast).toEqual([['agent-activity', 'srv-tab', { tool: 'Bash' }]])
    expect(t.projectUpdates).toEqual([['srvA', { source: 'local', revision: 3 }]])
  })

  it('merges every online server\'s answer into this desktop\'s', async () => {
    const t = setup()
    t.register('get-agent-activity', 'handle', { 'local-tab': { tool: 'Read' } })
    expect(await t.invoke('get-agent-activity', [])).toEqual({ 'local-tab': { tool: 'Read' }, 'srv-tab': { tool: 'Bash' } })
  })

  it('splits a list of tabs by host, and tells every server about an empty dirty list', async () => {
    const t = setup()
    t.register('report-dirty-tabs')
    t.register('tabs-restart')
    await t.invoke('report-dirty-tabs', [['local-tab', 'srv-tab']])
    expect(t.local.get('report-dirty-tabs')).toHaveBeenLastCalledWith(expect.anything(), ['local-tab'])
    expect(t.calls.at(-1)).toMatchObject({ serverId: 'srvA', ch: 'report-dirty-tabs', args: [['srv-tab']] })
    await t.invoke('report-dirty-tabs', [[]])
    expect(t.calls.at(-1)).toMatchObject({ serverId: 'srvA', ch: 'report-dirty-tabs', args: [[]] })
    const before = t.calls.length
    await t.invoke('tabs-restart', [['local-tab']])
    expect(t.calls.length).toBe(before)
  })

  it('routes by the host argument, and lets the desktop answer load-projects and save a server\'s slice', async () => {
    const t = setup()
    t.register('server-list-dirs')
    t.register('load-projects', 'handle', { local: { revision: 1 } })
    t.register('save-projects')
    await t.invoke('server-list-dirs', ['srvA', '~', undefined])
    expect(t.calls.at(-1)).toMatchObject({ serverId: 'srvA', ch: 'server-list-dirs' })
    expect(await t.invoke('server-list-dirs', ['local', '~', undefined])).toBe('local-answer')
    expect(await t.invoke('load-projects', [])).toEqual({ local: { revision: 1 }, srvA: { revision: 9 } })
    expect(await t.invoke('save-projects', ['srvA', { baseRevision: 1 }])).toEqual({ custom: 'srvA', clientId: 'win:1', payload: { baseRevision: 1 } })
    expect(await t.invoke('save-projects', ['local', { baseRevision: 1 }])).toBe('local-answer')
  })

  it('answers a server tab\'s synchronous scrollback save without waiting for the server', () => {
    const t = setup()
    t.register('scrollback-save-sync', 'onSync', true)
    expect(t.invoke('scrollback-save-sync', ['srv-tab', 'xterm text'])).toBe(true)
    expect(t.local.get('scrollback-save-sync')).not.toHaveBeenCalled()
    expect(t.calls).toEqual([])
    t.invoke('scrollback-save-sync', ['local-tab', 'xterm text'])
    expect(t.local.get('scrollback-save-sync')).toHaveBeenCalledTimes(1)
  })
})
