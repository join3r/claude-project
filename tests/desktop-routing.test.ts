import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DesktopRouting, type RoutingHub } from '../src/main/servers/desktop-routing'
import type { ServerEvent } from '../src/main/servers/server-hub'
import type { IpcContext, IpcRegistrar } from '../src/main/ipc/registrar'
import type { ProjectsData } from '../src/shared/types'
import type { ServersState } from '../src/shared/servers'
import { fixtureProject } from './helpers/streams-fixtures'

/**
 * A desktop's routing put together around a fake ServerHub: the server's
 * projects arrive with `host`, a server project's terminal spawns there, and
 * the server's terminal output reaches the window that spawned it.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Handler = (ctx: IpcContext, ...args: unknown[]) => unknown

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-routing-'))
  dirs.push(configDir)
  const serverData: ProjectsData = {
    projects: [fixtureProject({ id: 'srv-p', directory: '/home/srv/app' })],
    tags: [],
    projectOrder: ['srv-p'],
    pinnedItems: []
  }
  const state: ServersState = {
    relay: { kind: 'online' },
    servers: [{ id: 'srvA', name: 'box', state: 'online', pairedAt: 1, lastSeen: 2, build: null }]
  }
  const eventListeners = new Set<(event: ServerEvent) => void>()
  const calls: Array<{ serverId: string; clientId: string; ch: string; args: unknown[] }> = []
  const hub: RoutingHub = {
    getState: () => state,
    onStateChange: () => () => {},
    onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    call: async (serverId, clientId, ch, args = []) => {
      calls.push({ serverId, clientId, ch, args })
      if (ch === 'load-projects') return { local: { revision: 77, data: serverData } }
      if (ch === 'get-agent-activity') return {}
      if (ch === 'pty-spawn') return { cols: 80, rows: 24, scrollback: '$ ', exitCode: null }
      return undefined
    }
  }
  const sent: unknown[][] = []
  const broadcast: unknown[][] = []
  const routing = new DesktopRouting({
    configDir,
    windows: {
      send: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
      broadcast: (channel, ...args) => { broadcast.push([channel, ...args]) }
    },
    log: () => {}
  })
  const localData: ProjectsData = { projects: [fixtureProject({ id: 'local-p', directory: '/Users/me/l' })], tags: [], projectOrder: ['local-p'], pinnedItems: [] }
  routing.attachHost({ getProjectsData: () => localData, onProjectsChanged: () => () => {} })

  const handlers = new Map<string, Handler>()
  const inner: IpcRegistrar = {
    handle: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
    on: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
    onSync: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) }
  }
  const wrapped = routing.wrap(inner)
  wrapped.handle('load-projects', [], (() => ({ local: { revision: 3, data: localData } })) as never)
  wrapped.handle('pty-spawn', [], (() => 'spawned here') as never)
  const emit = (event: ServerEvent) => { for (const listener of eventListeners) listener(event) }
  return { routing, hub, calls, sent, broadcast, handlers, emit }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('DesktopRouting', () => {
  it('serves a server\'s projects with the local ones, spawns its terminals there and brings their output back', async () => {
    const t = setup()
    t.routing.attachHub(t.hub)
    await flush()

    const ctx: IpcContext = { clientId: 'win:1', isFocused: () => true }
    const sources = await t.handlers.get('load-projects')!(ctx) as Record<string, { revision: number; data: ProjectsData; offline?: boolean }>
    expect(Object.keys(sources)).toEqual(['local', 'srvA'])
    expect(sources.srvA.revision).toBe(77)
    expect(sources.srvA.data.projects.map(p => [p.id, p.host])).toEqual([['srv-p', 'srvA']])
    expect(t.routing.isServerProject('srv-p')).toBe(true)
    expect(t.routing.mergedProjects({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }).projects.map(p => p.id)).toEqual(['srv-p'])

    const attach = await t.handlers.get('pty-spawn')!(ctx, 'tab-1', '', '/home/srv/app', 80, 24, undefined, undefined, 'srv-p', undefined)
    expect(attach).toMatchObject({ scrollback: '$ ' })
    expect(t.calls.find(c => c.ch === 'pty-spawn')).toMatchObject({ serverId: 'srvA', clientId: 'win:1' })
    expect(await t.handlers.get('pty-spawn')!(ctx, 'tab-2', '', '/Users/me/l', 80, 24, undefined, undefined, 'local-p', undefined)).toBe('spawned here')

    t.emit({ serverId: 'srvA', client: 'win:1', ch: 'pty-data', args: ['tab-1', 'hello from the server'] })
    expect(t.sent).toEqual([['win:1', 'pty-data', 'tab-1', 'hello from the server']])
    // The server's own broadcasts of its settings never reach the windows.
    t.emit({ serverId: 'srvA', client: '*', ch: 'config-updated', args: [{}] })
    expect(t.broadcast.filter(b => b[0] === 'config-updated')).toEqual([])
  })
})
