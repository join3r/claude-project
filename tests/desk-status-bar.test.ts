import { describe, expect, it } from 'vitest'
import { runLogTaskId, statusHosts, statusPhone, statusRunLabel } from '../src/renderer/components/desk/statusBar'
import type { InboxApp } from '../src/renderer/components/inbox'
import type { MobileState } from '../src/shared/mobile'
import type { ServerStatus } from '../src/shared/servers'
import type { Project, Stream } from '../src/shared/types'
import type { StreamRunState } from '../src/shared/stream-run'

function stream(id: string, taskIds: string[] = [], isMain = true): Stream {
  return { id, name: id, isMain, tasks: taskIds.map(taskId => ({ id: taskId, name: taskId, panes: [] })) } as unknown as Stream
}

function project(id: string, extra: Partial<Project> = {}, streams: Stream[] = [stream(`${id}-main`)]): Project {
  return { id, name: id, directory: `/tmp/${id}`, streams, ...extra } as unknown as Project
}

function server(id: string, name: string, state: ServerStatus['state']): ServerStatus {
  return { id, name, state, pairedAt: 0, lastSeen: null, build: null } as unknown as ServerStatus
}

function run(extra: Partial<StreamRunState> = {}): StreamRunState {
  return { status: 'running', commandId: 'dev', name: 'dev', command: 'npm run dev', startedAt: 1, ...extra }
}

const ssh = (host: string) => ({ host, port: 22, username: 'me', remoteDir: '' })

describe('status bar hosts', () => {
  it('lists this Mac, the servers by name, then one entry per SSH box', () => {
    const projects = [
      project('a', { ssh: ssh('build-box') }),
      project('b', { ssh: ssh('build-box') }),
      project('c', { ssh: ssh('alpha') }),
      project('d')
    ]
    const hosts = statusHosts(projects, [server('s2', 'zeta', 'offline'), server('s1', 'hetzner-1', 'online')], { b: 'connected', c: 'connecting' })
    expect(hosts.map(h => [h.label, h.detail, h.tone])).toEqual([
      ['This Mac', undefined, 'ok'],
      ['hetzner-1', undefined, 'ok'],
      ['zeta', 'offline', 'idle'],
      ['alpha (ssh)', 'connecting', 'idle'],
      ['build-box (ssh)', undefined, 'ok']
    ])
    expect(hosts[4].title).toBe('me@build-box:22 · a, b')
  })

  it('marks a server that needs an update, and an idle SSH box as not connected', () => {
    const hosts = statusHosts([project('a', { ssh: ssh('box') })], [server('s', 'old', 'incompatible')], {})
    expect(hosts[1]).toMatchObject({ detail: 'needs an update', tone: 'bad' })
    expect(hosts[2]).toMatchObject({ detail: 'not connected', tone: 'idle' })
  })
})

describe('status bar runs', () => {
  const main = stream('m', ['t1', 't2'])
  const beta = stream('beta', ['t3'], false)
  const p = project('stem', {}, [main, beta])

  it('names the project, a side stream and a crash', () => {
    expect(statusRunLabel({ project: p, stream: main, run: run(), crashed: false })).toBe('stem · dev')
    expect(statusRunLabel({ project: p, stream: beta, run: run({ name: 'server', status: 'exited', exitCode: 1 }), crashed: true })).toBe('stem › beta · server crashed')
  })

  it("opens a log in its own task's Bench, else the shown task of the same project", () => {
    const inTask: InboxApp = { project: p, stream: main, run: run({ taskId: 't2' }), crashed: false }
    expect(runLogTaskId(inTask, { projectId: null, taskId: null })).toBe('t2')
    const inFolder: InboxApp = { project: p, stream: main, run: run(), crashed: false }
    expect(runLogTaskId(inFolder, { projectId: 'stem', taskId: 't3' })).toBe('t3')
    expect(runLogTaskId(inFolder, { projectId: 'other', taskId: 'x' })).toBeNull()
    expect(runLogTaskId(inFolder, { projectId: 'stem', taskId: null })).toBeNull()
    // A task that has gone (its run outlived it) falls back the same way.
    expect(runLogTaskId({ ...inFolder, run: run({ taskId: 'gone' }) }, { projectId: null, taskId: null })).toBeNull()
  })
})

describe('status bar phone', () => {
  const base: MobileState = {
    enabled: true,
    relayUrl: 'wss://relay',
    desktopName: 'Mac',
    connection: { kind: 'online' },
    invite: null,
    pending: null,
    devices: []
  }
  const phone = (online: boolean, extra = {}) => ({ id: 'p', name: 'iPhone', pairedAt: 0, lastSeen: null, online, push: false, ...extra })

  it('stays away while phone access is off and nothing is paired', () => {
    expect(statusPhone(null)).toBeNull()
    expect(statusPhone({ ...base, enabled: false })).toBeNull()
    expect(statusPhone({ ...base, enabled: false, devices: [phone(false)] })).toMatchObject({ label: 'Phone access off', tone: 'idle' })
  })

  it('shows the paired phone, green while it is online', () => {
    expect(statusPhone({ ...base, devices: [phone(true)] })).toMatchObject({ label: 'iPhone', tone: 'ok' })
    expect(statusPhone({ ...base, devices: [phone(false)] })).toMatchObject({ label: 'iPhone', detail: 'paired', tone: 'idle' })
    expect(statusPhone({ ...base, devices: [phone(true), { ...phone(false), id: 'q' }] })).toMatchObject({ label: '2 phones', detail: '1 online', tone: 'ok' })
    expect(statusPhone({ ...base, connection: { kind: 'offline' }, devices: [phone(true)] })).toMatchObject({ detail: 'relay offline', tone: 'idle' })
    expect(statusPhone({ ...base, devices: [phone(true, { outdated: 'phone' })] })).toMatchObject({ tone: 'bad' })
  })

  it('asks for you while a phone waits to pair', () => {
    expect(statusPhone({ ...base, pending: { phoneId: 'x', name: 'Pixel', receivedAt: 0, online: true } as MobileState['pending'] })).toMatchObject({ label: 'Pixel wants to pair', tone: 'needs' })
    expect(statusPhone(base)).toMatchObject({ label: 'No phone paired' })
  })
})
