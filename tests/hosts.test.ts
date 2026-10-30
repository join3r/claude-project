import { describe, expect, it, vi } from 'vitest'
import {
  addSavedHost,
  createProjectOnHost,
  folderName,
  hostChoicesFor,
  listHosts,
  newProjectHostUsable,
  projectHostKey,
  removeSavedHost,
  type HostProjectActions
} from '../src/renderer/hosts'
import type { ServerStatus } from '../src/shared/servers'
import type { Project, SavedHost } from '../src/shared/types'

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, directory: `/tmp/${id}`, streams: [], ...extra } as unknown as Project
}

function server(id: string, name: string, state: ServerStatus['state']): ServerStatus {
  return { id, name, state, pairedAt: 0, lastSeen: null, build: null } as unknown as ServerStatus
}

const ssh = (host: string, extra: Partial<{ port: number; username: string; keyFile: string; remoteDir: string }> = {}) =>
  ({ host, port: 22, username: 'me', remoteDir: '/srv/app', ...extra })

describe('projectHostKey', () => {
  it('reads the host from the fields a project already has', () => {
    expect(projectHostKey(project('a'))).toBe('mac')
    expect(projectHostKey(project('b', { host: 's1' }))).toBe('server:s1')
    expect(projectHostKey(project('c', { ssh: ssh('box', { port: 2222 }) }))).toBe('ssh:me@box:2222')
    expect(projectHostKey(project('d', { shellCommand: { command: ' docker exec -it web sh ' } }))).toBe('shell:docker exec -it web sh')
  })
})

describe('listHosts', () => {
  it('lists this Mac, servers by name, SSH boxes by address, then shells, each with its projects', () => {
    const projects = [
      project('mac1'),
      project('srv', { host: 's1' }),
      project('b1', { ssh: ssh('box') }),
      project('b2', { ssh: ssh('box', { remoteDir: '/other', keyFile: '/k' }) }),
      project('a1', { ssh: ssh('alpha') }),
      project('web', { shellCommand: { command: 'docker exec -it web sh' } }),
      project('tmp', { ephemeral: true })
    ]
    const hosts = listHosts(projects, [server('s2', 'zeta', 'offline'), server('s1', 'hetzner', 'online')], { b2: 'connected' })
    expect(hosts.map(h => [h.key, h.label, h.detail, h.tone, h.projects.map(p => p.id)])).toEqual([
      ['mac', 'This Mac', undefined, 'ok', ['mac1']],
      ['server:s1', 'hetzner', undefined, 'ok', ['srv']],
      ['server:s2', 'zeta', 'offline', 'idle', []],
      ['ssh:me@alpha:22', 'alpha', 'not connected', 'idle', ['a1']],
      ['ssh:me@box:22', 'box', undefined, 'ok', ['b1', 'b2']],
      ['shell:docker exec -it web sh', 'web', undefined, 'ok', ['web']]
    ])
  })

  it('keeps saved boxes and shells with no project, and names a shell by its saved name', () => {
    const saved: SavedHost[] = [
      { kind: 'ssh', host: 'spare', port: 22, username: 'root' },
      { kind: 'shell', name: 'Orb', command: 'orb shell' },
      { kind: 'shell', name: '', command: 'ssh-ish' }
    ]
    const hosts = listHosts([project('x', { shellCommand: { command: 'orb shell' } })], [], {}, saved)
    expect(hosts.map(h => [h.key, h.label, h.saved, h.projects.length])).toEqual([
      ['mac', 'This Mac', false, 0],
      ['ssh:root@spare:22', 'spare', true, 0],
      ['shell:orb shell', 'Orb', true, 1],
      ['shell:ssh-ish', 'ssh-ish', true, 0]
    ])
  })

  it('shows a server a project still names but that is no longer paired', () => {
    const hosts = listHosts([project('p', { host: 'gone123456' })], [], {})
    expect(hosts[1]).toMatchObject({ key: 'server:gone123456', detail: 'not paired', tone: 'bad' })
  })
})

describe('saved hosts', () => {
  it('replaces an entry with the same key and removes by key', () => {
    const first: SavedHost = { kind: 'ssh', host: 'box', port: 22, username: 'me' }
    const withKey: SavedHost = { ...first, keyFile: '/k' }
    const list = addSavedHost(addSavedHost([], first), withKey)
    expect(list).toEqual([withKey])
    expect(removeSavedHost(list, 'ssh:me@box:22')).toEqual([])
  })
})

describe('hostChoicesFor', () => {
  const projects = [
    project('local'),
    project('remote', { ssh: ssh('box') }),
    project('shell1', { shellCommand: { command: 'a' } }),
    project('shell2', { shellCommand: { command: 'b' } }),
    project('srv', { host: 's1' })
  ]
  const hosts = listHosts(projects, [server('s1', 'hetzner', 'online'), server('s2', 'old', 'offline')], {})
  const keys = (p: Project, move = false) => hostChoicesFor(p, hosts, move).map(h => h.key)

  it('keeps a local or server project on its host', () => {
    expect(keys(projects[0])).toEqual(['mac'])
    expect(keys(projects[4])).toEqual(['server:s1'])
  })

  it('lets a shell project switch shells', () => {
    expect(keys(projects[2])).toEqual(['shell:a', 'shell:b'])
  })

  it('offers an SSH project the online servers only when it can move', () => {
    expect(keys(projects[1])).toEqual(['ssh:me@box:22'])
    expect(keys(projects[1], true)).toEqual(['server:s1', 'ssh:me@box:22'])
  })

  it('holds back servers that are not online from New project', () => {
    expect(hosts.filter(newProjectHostUsable).map(h => h.key)).toEqual(['mac', 'server:s1', 'ssh:me@box:22', 'shell:a', 'shell:b'])
  })
})

describe('createProjectOnHost', () => {
  function actions(): HostProjectActions {
    return {
      addProject: vi.fn((name: string, directory: string) => project(name, { directory })),
      addServerProjects: vi.fn((serverId: string, items: Array<{ name: string; directory: string }>) => items.map(i => project(i.name, { host: serverId, directory: i.directory }))),
      addRemoteProject: vi.fn((name: string, config) => project(name, { ssh: config })),
      addShellCommandProject: vi.fn((name: string, command: string) => project(name, { shellCommand: { command } }))
    }
  }
  const hosts = listHosts(
    [project('r', { ssh: ssh('box', { keyFile: '/k' }) }), project('s', { shellCommand: { command: 'orb shell' } })],
    [server('s1', 'hetzner', 'online')],
    {}
  )
  const host = (key: string) => hosts.find(h => h.key === key)!

  it('maps the one Host field onto the existing project fields', () => {
    const a = actions()
    expect(createProjectOnHost(a, host('mac'), '', '/Users/me/code/app/')?.name).toBe('app')
    expect(a.addProject).toHaveBeenCalledWith('app', '/Users/me/code/app/')
    createProjectOnHost(a, host('server:s1'), 'api', '/home/me/api')
    expect(a.addServerProjects).toHaveBeenCalledWith('s1', [{ name: 'api', directory: '/home/me/api' }])
    createProjectOnHost(a, host('ssh:me@box:22'), '', '/srv/site')
    expect(a.addRemoteProject).toHaveBeenCalledWith('site', { host: 'box', port: 22, username: 'me', keyFile: '/k', remoteDir: '/srv/site' })
    createProjectOnHost(a, host('shell:orb shell'), 'VM', '')
    expect(a.addShellCommandProject).toHaveBeenCalledWith('VM', 'orb shell')
  })

  it('adds nothing without a folder, or a shell without a name', () => {
    const a = actions()
    expect(createProjectOnHost(a, host('mac'), 'x', ' ')).toBeNull()
    expect(createProjectOnHost(a, host('shell:orb shell'), '', '/x')).toBeNull()
    expect(a.addProject).not.toHaveBeenCalled()
    expect(a.addShellCommandProject).not.toHaveBeenCalled()
  })
})

describe('folderName', () => {
  it('takes the last segment of either separator', () => {
    expect(folderName('/a/b/')).toBe('b')
    expect(folderName('C:\\x\\y')).toBe('y')
    expect(folderName('')).toBe('')
  })
})
