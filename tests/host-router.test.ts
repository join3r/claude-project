import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HostRouter, LOCAL_HOST, RouteIndex, type RouterHub } from '../src/main/servers/host-router'
import { HOST_ROUTES, SERVER_EVENTS, SERVER_PRIVATE_EVENTS } from '../src/main/servers/host-routes'
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
    // Forwarded (with an ownership check) or deliberately kept from the windows.
    expect([...pushed].filter(ch => !(ch in SERVER_EVENTS) && !SERVER_PRIVATE_EVENTS.includes(ch))).toEqual([])
  })
})

describe('step 7 routes (files, editor, Git panel, chat, conda, notebooks, agent CLIs)', () => {
  const routeKeys = (channel: string): unknown[] => {
    const route = HOST_ROUTES[channel]
    return typeof route === 'object' && 'by' in route ? route.by : []
  }

  it('sends every call those features make to the project\'s host, by the argument that names it', () => {
    // Where the preload puts the project id: the last argument of the path-taking calls.
    const byProject: Record<string, number> = {
      'fb-read-directory': 2, 'fb-read-file': 2, 'fb-write-file': 3, 'fb-create-file': 3, 'fb-create-directory': 3,
      'fb-rename': 3, 'fb-delete': 2, 'fb-git-status': 1, 'fb-git-diff': 2, 'fb-git-stage': 3, 'fb-git-unstage': 3,
      'fb-git-discard': 3, 'fb-git-pull': 2, 'fb-git-commit': 3, 'fb-git-push': 2, 'git-project-posture': 1,
      'git-commit-history': 1, 'conda-list-envs': 0, 'chat-list-files': 1, 'chat-permissions-read': 1,
      'chat-permissions-update': 5, 'claude-session-exists': 2
    }
    for (const [channel, at] of Object.entries(byProject)) expect(routeKeys(channel), channel).toEqual([{ project: at }])
    for (const channel of ['chat-detach', 'chat-bash', 'chat-login', 'chat-login-code', 'chat-login-dismiss', 'chat-logout',
      'chat-respond', 'chat-interrupt', 'chat-set-mode', 'notebook-kernel-execute', 'notebook-kernel-interrupt']) {
      expect(routeKeys(channel), channel).toEqual([{ tab: 0 }])
    }
    expect(HOST_ROUTES['chat-send']).toEqual({ by: [{ tab: 0 }], remote: 'custom' })
    for (const channel of ['host-agent-clis', 'host-refresh-env']) expect(routeKeys(channel), channel).toEqual([{ host: 0 }])
  })

  it('pins a chat and a kernel to their host when they start, and lets go when they end', () => {
    expect(HOST_ROUTES['chat-attach']).toEqual({ by: [{ projectField: [1, 'projectId'] }, { tab: 0 }], pin: 'set' })
    expect(HOST_ROUTES['chat-close']).toEqual({ by: [{ tab: 0 }], pin: 'clear' })
    expect(HOST_ROUTES['notebook-kernel-start']).toEqual({ by: [{ project: 1 }, { tab: 0 }], pin: 'set' })
    expect(HOST_ROUTES['notebook-kernel-restart']).toEqual({ by: [{ project: 1 }, { tab: 0 }], pin: 'set' })
    expect(HOST_ROUTES['notebook-kernel-shutdown']).toEqual({ by: [{ tab: 0 }], pin: 'clear' })
  })

  it('forwards a server\'s chat and kernel events only for tabs pinned there, and its hooks for its own tabs', () => {
    expect(SERVER_EVENTS['chat-event']).toBe('pinned-tab')
    expect(SERVER_EVENTS['notebook-kernel-event']).toBe('pinned-tab')
    for (const channel of ['hook-session-start', 'hook-working', 'hook-stopped', 'hook-notification', 'hook-activity', 'agent-activity']) {
      expect(SERVER_EVENTS[channel], channel).toBe('server-tab')
    }
  })
})

describe('step 8 routes (streams, task worktrees, landing)', () => {
  it('sends every stream, task worktree and landing call to the host of the project or task it names', () => {
    for (const channel of ['task-worktree-ensure', 'stream-worktree-setup-run', 'task-land', 'task-landing-retry', 'task-landing-abort',
      'task-landing-fix', 'task-update-from-stream', 'task-stream-ahead', 'task-landing-preview', 'task-worktree-close']) {
      expect(HOST_ROUTES[channel], channel).toEqual({ by: [{ project: 0 }] })
    }
    // The setup approval and a dismissed error name only the task.
    for (const channel of ['task-worktree-decide', 'task-worktree-dismiss']) expect(HOST_ROUTES[channel], channel).toEqual({ by: [{ task: 0 }] })
    expect(HOST_ROUTES['task-worktree-states']).toEqual({ merge: 'tasks' })
    for (const channel of ['workspace-list-branches', 'workspace-create', 'workspace-delete', 'workspace-restore']) {
      expect(HOST_ROUTES[channel], channel).toEqual({ by: [{ projectField: [0, 'projectId'] }] })
    }
    // Moving or reopening a task carries its agent sessions on the project's host.
    expect(HOST_ROUTES['task-move-prepare']).toEqual({ by: [{ project: 4 }] })
  })

  it('forwards a server\'s worktree and landing pushes only for its own tasks', () => {
    expect(SERVER_EVENTS['task-worktree-state']).toBe('server-task')
    expect(SERVER_EVENTS['task-landing-state']).toBe('server-task')
  })
})

describe('step 9 routes (Open in IDE\'s key on a server)', () => {
  it('sends the authorized_keys channels to the server their first argument names', () => {
    for (const channel of ['host-ssh-authorize-key', 'host-ssh-revoke-key']) {
      expect(HOST_ROUTES[channel], channel).toEqual({ by: [{ host: 0 }] })
    }
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
    const logs: string[] = []
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
      log: (message) => logs.push(message)
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
    return { router, index, hub, calls, sent, broadcast, projectUpdates, register, invoke, local, logs }
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
    // The data no longer has the server's tab (its task was closed, the tab never
    // started here, so it isn't pinned): the index still knows where it was.
    t.index.update([fixtureProject({ id: 'local-p', directory: '/home/me/l' })])
    t.invoke('chat-close', ['srv-tab'])
    await Promise.resolve()
    expect(t.calls.map(c => [c.serverId, c.ch])).toEqual([['srvA', 'chat-close']])
  })

  it('sends pushes from a server to the window they name, or to every window', async () => {
    const t = setup()
    t.register('pty-spawn')
    await t.invoke('pty-spawn', ['srv-tab', '', '/srv/p', 80, 24, undefined, undefined, 'srv-p', undefined])
    t.router.deliver({ serverId: 'srvA', client: 'win:2', ch: 'pty-data', args: ['srv-tab', 'output'] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'agent-activity', args: ['srv-tab', { tool: 'Bash' }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'projects-updated', args: [{ source: 'local', revision: 3 }] })
    expect(t.sent).toEqual([['win:2', 'pty-data', 'srv-tab', 'output']])
    expect(t.broadcast).toEqual([['agent-activity', 'srv-tab', { tool: 'Bash' }]])
    // Always the pushing server's own source, whatever the push says.
    expect(t.projectUpdates).toEqual([['srvA', { source: 'local', revision: 3 }]])
  })

  it('never forwards a channel off the list, nor this desktop\'s own ones', () => {
    const t = setup()
    for (const ch of ['config-updated', 'notes-updated', 'theme-changed', 'menu-new-task', 'updates-status', 'mobile-state-changed',
      'servers-state-changed', 'ssh-status-changed', 'socks-proxy-status-changed', 'something-new']) {
      t.router.deliver({ serverId: 'srvA', client: '*', ch, args: [{}] })
      t.router.deliver({ serverId: 'srvA', client: 'win:1', ch, args: [{}] })
    }
    expect(t.sent).toEqual([])
    expect(t.broadcast).toEqual([])
    // Logged once each; a server's own config and notes pushes are expected and dropped quietly.
    expect(t.logs).toContain('router dropServerEvent server=srvA ch=menu-new-task reason=not a forwarded channel')
    expect(t.logs.some(l => l.includes('ch=config-updated'))).toBe(false)
  })

  it('hands a server\'s phone state to windows tagged with that server, and routes its phone calls by the host argument', async () => {
    const t = setup()
    const state = { enabled: true, devices: [] }
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'server-mobile-state-changed', args: [state] })
    // A server can't speak for another one: the id in front is always the sender's.
    t.router.deliver({ serverId: 'srvA', client: 'win:2', ch: 'server-mobile-state-changed', args: ['srvB', state] })
    expect(t.broadcast).toEqual([['server-mobile-state-changed', 'srvA', state]])
    expect(t.sent).toEqual([['win:2', 'server-mobile-state-changed', 'srvA', 'srvB', state]])
    // Its plain `mobile-state-changed` is this desktop's own Settings › Mobile, never a server's.
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'mobile-state-changed', args: [state] })
    expect(t.broadcast).toHaveLength(1)

    for (const ch of ['server-mobile-get-state', 'server-mobile-start-pairing', 'server-mobile-cancel-pairing', 'server-mobile-accept', 'server-mobile-reject', 'server-mobile-revoke']) {
      expect(HOST_ROUTES[ch]).toEqual({ by: [{ host: 0 }] })
    }
    t.register('server-mobile-accept')
    await t.invoke('server-mobile-accept', ['srvA', 'e'.repeat(32)])
    expect(t.calls.at(-1)).toMatchObject({ serverId: 'srvA', ch: 'server-mobile-accept', args: ['srvA', 'e'.repeat(32)] })
    expect(await t.invoke('server-mobile-accept', ['local', 'e'.repeat(32)])).toBe('local-answer')
  })

  it('drops a server\'s push about a tab, task or project it doesn\'t own', async () => {
    const t = setup()
    // Output for a tab pinned nowhere (this desktop's, or the server's never spawned here).
    t.router.deliver({ serverId: 'srvA', client: 'win:1', ch: 'pty-data', args: ['local-tab', 'injected\r'] })
    t.router.deliver({ serverId: 'srvA', client: 'win:1', ch: 'pty-data', args: ['srv-tab', 'not attached'] })
    t.router.deliver({ serverId: 'srvA', client: 'win:1', ch: 'chat-event', args: ['local-tab', 1, {}] })
    // Hooks, activity, task and project pushes about this desktop's things.
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'hook-working', args: ['local-tab'] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'agent-activity', args: ['local-tab', { tool: 'rm -rf' }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'task-worktree-state', args: ['local-t', { phase: 'failed' }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'archive-changed', args: ['local-p'] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'tasks-removed', args: [{ projectId: 'local-p', taskId: 'local-t', tabIds: ['local-tab'] }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'tabs-restart', args: [{ tabIds: ['local-tab'] }] })
    // Another server's tab, pinned there.
    t.index.pin('b-tab', 'srvB')
    t.router.deliver({ serverId: 'srvA', client: 'win:1', ch: 'pty-data', args: ['b-tab', 'x'] })
    // A per-window push sent as a broadcast.
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'server-clone-progress', args: ['op', 'line'] })
    expect(t.sent).toEqual([])
    expect(t.broadcast).toEqual([])

    // Its own: a removal keeps only its tab ids.
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'tasks-removed', args: [{ projectId: 'srv-p', taskId: 'srv-t', tabIds: ['srv-tab', 'local-tab'] }] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'tabs-restart', args: [{ tabIds: ['srv-tab', 'local-tab'] }] })
    expect(t.broadcast).toEqual([
      ['tasks-removed', { projectId: 'srv-p', taskId: 'srv-t', tabIds: ['srv-tab'] }],
      ['tabs-restart', { tabIds: ['srv-tab'] }]
    ])
  })

  it('keeps a local tab here when a server claims its id, and a pinned tab where it was pinned', async () => {
    const t = setup()
    t.register('pty-spawn')
    t.register('pty-write', 'on')
    t.register('pty-kill', 'on')
    const local = fixtureProject({ id: 'local-p', directory: '/home/me/l', tasks: [{ id: 'local-t', tabs: { left: [{ id: 'local-tab', type: 'terminal', title: 'T' }] } }] })
    const greedy = { ...fixtureProject({ id: 'srv-p', directory: '/srv/p', tasks: [{ id: 'local-t', tabs: { left: [{ id: 'local-tab', type: 'terminal', title: 'T' }] } }] }), host: 'srvA' }
    t.index.update([greedy, local])
    t.invoke('pty-write', ['local-tab', 'secret keystrokes'])
    expect(t.local.get('pty-write')).toHaveBeenCalledTimes(1)
    expect(t.calls).toEqual([])

    // Pinned at spawn: later data can't move it, until the process ends.
    await t.invoke('pty-spawn', ['tab-x', '', '/home/me/l', 80, 24, undefined, undefined, 'local-p', undefined])
    t.index.update([local, { ...greedy, streams: [{ id: 's', name: 'main', isMain: true, tasks: [{ id: 't2', name: 't', panes: [{ tabs: [{ id: 'tab-x', type: 'terminal', title: 'T' }], activeTabId: 'tab-x', width: 1 }] }] }] }])
    t.invoke('pty-write', ['tab-x', 'more keystrokes'])
    expect(t.calls).toEqual([])
    expect(t.local.get('pty-write')).toHaveBeenCalledTimes(2)
    t.invoke('pty-kill', ['tab-x'])
    expect(t.index.pinnedHost('tab-x')).toBeUndefined()

    // Two servers claiming one id: neither gets it.
    t.index.update([{ ...greedy, id: 'a' }, { ...greedy, id: 'b', host: 'srvB' }])
    expect(t.router.hostFor('pty-write', ['local-tab', 'x'])).toBe(LOCAL_HOST)
  })

  it('takes only a server\'s own tabs from its merged answer', async () => {
    const t = setup()
    t.register('get-agent-activity', 'handle', {})
    const hub = t.hub as { call: RouterHub['call'] }
    const call = hub.call
    hub.call = async (serverId, clientId, ch, args, options) =>
      ch === 'get-agent-activity' ? { 'srv-tab': { tool: 'Bash' }, 'local-tab': { tool: 'fake' } } : call(serverId, clientId, ch, args, options)
    expect(await t.invoke('get-agent-activity', [])).toEqual({ 'srv-tab': { tool: 'Bash' } })
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

  it('lands a server project\'s task on its server, and answers its setup approval there, as the calling window', async () => {
    const t = setup()
    for (const channel of ['task-land', 'task-landing-abort', 'task-stream-ahead', 'task-worktree-ensure', 'stream-worktree-setup-run', 'task-worktree-decide']) {
      t.register(channel)
    }
    await t.invoke('task-land', ['srv-p', 'srv-t', { keepWorktree: false }], ctx('win:2'))
    await t.invoke('task-landing-abort', ['srv-p', 'srv-t'])
    await t.invoke('task-stream-ahead', ['srv-p', 'srv-t'])
    await t.invoke('task-worktree-ensure', ['srv-p', 'srv-t', { name: 'Fix it' }])
    const pending = { repoKey: '/srv/p/.git', hash: 'h', commands: ['npm ci'] }
    await t.invoke('stream-worktree-setup-run', ['srv-p', 'stream-x', pending])
    await t.invoke('task-worktree-decide', ['srv-t', 'run'])
    expect(t.calls.map(c => [c.serverId, c.clientId, c.ch])).toEqual([
      ['srvA', 'win:2', 'task-land'],
      ['srvA', 'win:1', 'task-landing-abort'],
      ['srvA', 'win:1', 'task-stream-ahead'],
      ['srvA', 'win:1', 'task-worktree-ensure'],
      ['srvA', 'win:1', 'stream-worktree-setup-run'],
      ['srvA', 'win:1', 'task-worktree-decide']
    ])
    for (const channel of ['task-land', 'stream-worktree-setup-run', 'task-worktree-decide']) expect(t.local.get(channel)).not.toHaveBeenCalled()

    // This desktop's own projects and tasks are landed and approved here.
    expect(await t.invoke('task-land', ['local-p', 'local-t', {}])).toBe('local-answer')
    expect(await t.invoke('stream-worktree-setup-run', ['local-p', 'stream-x', pending])).toBe('local-answer')
    expect(await t.invoke('task-worktree-decide', ['local-t', 'run'])).toBe('local-answer')
    expect(t.calls).toHaveLength(6)
  })

  it('takes only a server\'s own tasks from its worktree states', async () => {
    const t = setup()
    t.register('task-worktree-states', 'handle', { 'local-t': { phase: 'creating' } })
    const hub = t.hub as { call: RouterHub['call'] }
    const call = hub.call
    hub.call = async (serverId, clientId, ch, args, options) => ch === 'task-worktree-states'
      ? { 'srv-t': { phase: 'needs-approval' }, 'local-t': { phase: 'failed', error: 'spoofed' } }
      : call(serverId, clientId, ch, args, options)
    expect(await t.invoke('task-worktree-states', [])).toEqual({ 'local-t': { phase: 'creating' }, 'srv-t': { phase: 'needs-approval' } })
  })

  it('still forwards a server\'s last landing push about a task it archived, but never one about a local task that left', () => {
    const t = setup()
    // The server's landing closed its task: the data loses it, then the landing state clears.
    t.index.update([fixtureProject({ id: 'local-p', directory: '/home/me/l' }), { ...fixtureProject({ id: 'srv-p', directory: '/srv/p' }), host: 'srvA' }])
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'task-landing-state', args: ['srv-t', null] })
    t.router.deliver({ serverId: 'srvA', client: '*', ch: 'task-landing-state', args: ['local-t', null] })
    t.router.deliver({ serverId: 'srvB', client: '*', ch: 'task-landing-state', args: ['srv-t', null] })
    expect(t.broadcast).toEqual([['task-landing-state', 'srv-t', null]])
    // A call about it still reaches the server it was on.
    expect(t.router.hostFor('task-worktree-dismiss', ['srv-t'])).toBe('srvA')
    expect(t.router.hostFor('task-worktree-dismiss', ['local-t'])).toBe(LOCAL_HOST)
  })
})
