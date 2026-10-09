import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProjectMover, type ProjectMoverDeps } from '../src/main/servers/project-move'
import { ServerProjects, type ServerProjectsHub } from '../src/main/servers/server-projects'
import { RouteIndex, LOCAL_HOST } from '../src/main/servers/host-router'
import { RevisionStore } from '../src/main/revision-store'
import { Storage } from '../src/main/storage'
import type { ProjectsUpdate } from '../src/shared/projects-sources'
import type { ServersState } from '../src/shared/servers'
import type { Project, ProjectsData, Stream } from '../src/shared/types'
import { emptyArchive, withArchivedStream, withArchivedTasks, type ArchivedStream, type ArchivedTask, type ProjectArchive } from '../src/shared/archive'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const SERVER = 'a'.repeat(32)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-project-move-'))
  dirs.push(dir)
  return dir
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function sshProject(): Project {
  const feat: Stream = {
    id: 'stream-feat',
    name: 'feat',
    workspace: { worktreePath: '/home/me/repo/.worktrees/feat', branchName: 'feat', baseBranch: 'main', relativeProjectPath: '' },
    taskWorktrees: true,
    tasks: [
      fixtureTask({ id: 'task-term', tabs: { left: [{ id: 'tab-term', type: 'terminal', title: 'Terminal' }] } }),
      fixtureTask({ id: 'task-claude', tabs: { left: [{ id: 'tab-claude', type: 'claude', title: 'Claude', sessionId: 'sess-1' }] } })
    ]
  }
  return {
    ...fixtureProject({ id: 'p-ssh', name: 'repo', directory: '', streams: [feat] }),
    ssh: { host: 'box', port: 22, username: 'me', remoteDir: 'repo' },
    tagIds: ['tag-ssh']
  }
}

interface Harness {
  mover: ProjectMover
  local: RevisionStore<ProjectsData>
  serverProjects: ServerProjects
  server: { revision: number; data: ProjectsData; archive: ProjectArchive }
  index: RouteIndex
  events: string[]
  broadcasts: ProjectsUpdate[]
  logs: string[]
  hubCalls: Array<{ ch: string; args: unknown[] }>
  failOn: Set<string>
  liveTabs: string[]
  tabsMoved: Array<{ tabIds: string[]; resume: string[] }>
}

async function harness(options: { serverProjects?: Project[] } = {}): Promise<Harness> {
  const configDir = tempDir()
  const events: string[] = []
  const broadcasts: ProjectsUpdate[] = []
  const logs: string[] = []
  const hubCalls: Array<{ ch: string; args: unknown[] }> = []
  const failOn = new Set<string>()
  const index = new RouteIndex()
  const other = fixtureProject({ id: 'p-local', directory: '/Users/me/other' })
  const server = {
    revision: 5000,
    data: { projects: options.serverProjects ?? [fixtureProject({ id: 's-1', directory: '/home/me/s1' })], tags: [], projectOrder: [], pinnedItems: [] } as ProjectsData,
    archive: emptyArchive()
  }
  const state: ServersState = {
    relay: { kind: 'online' },
    servers: [{ id: SERVER, name: 'box', state: 'online', pairedAt: 1, lastSeen: null, build: null, host: null }],
    invite: null
  }
  // The store normalizes with the server projects, which read the store: built in turn.
  const store: { local: RevisionStore<ProjectsData> | null } = { local: null }
  const serverProjects = new ServerProjects({
    configDir,
    localProjects: () => store.local?.peek().projects ?? [],
    broadcast: (update) => {
      broadcasts.push(update)
      events.push(`broadcast:${update.source}:${update.data.projects.map(p => p.id).join(',')}`)
    },
    log: (message) => logs.push(message)
  })
  const local = new RevisionStore<ProjectsData>({
    initial: {
      projects: [sshProject(), other],
      tags: [{ id: 'tag-ssh', name: 'ssh' }, { id: 'tag-unused', name: 'x' }],
      projectOrder: ['p-local', 'p-ssh'],
      pinnedItems: [{ type: 'project', projectId: 'p-ssh' }, { type: 'task', projectId: 'p-ssh', streamId: 'stream-feat', taskId: 'task-claude' }]
    },
    normalize: (data) => Storage.normalizeProjectsData(data as unknown as Record<string, unknown>, { foreignProjects: serverProjects.foreignProjects() }),
    persist: () => { if (failOn.has('commit')) throw new Error('disk full') },
    broadcast: (envelope) => events.push(`broadcast:local:${envelope.data.projects.map(p => p.id).join(',')}`)
  })
  store.local = local
  const reindex = () => index.update([...local.peek().projects, ...serverProjects.foreignProjects()])
  local.subscribe(() => {
    serverProjects.localChanged()
    reindex()
  })
  serverProjects.onChange(reindex)

  const hub: ServerProjectsHub = {
    getState: () => state,
    onStateChange: () => () => {},
    call: async (serverId, _clientId, ch, args = []) => {
      hubCalls.push({ ch, args })
      if (failOn.has(ch)) throw new Error(`${ch} failed`)
      if (ch === 'load-projects') return { local: { revision: server.revision, data: server.data } }
      if (ch === 'save-projects-slice') {
        const payload = args[0] as { baseRevision: number; data: { projects: Project[] } }
        if (payload.baseRevision !== server.revision) return { ok: false, revision: server.revision, data: server.data }
        server.revision += 1
        server.data = { ...server.data, projects: payload.data.projects }
        events.push(`server-save:${payload.data.projects.map(p => p.id).join(',')}`)
        // The server's push comes first on the link, then the answer.
        serverProjects.handleUpdate(serverId, { source: 'local', revision: server.revision, data: server.data })
        return { ok: true, revision: server.revision }
      }
      throw new Error(`unexpected ${ch}`)
    }
  }
  serverProjects.attach(hub)
  await flush()
  reindex()

  const liveTabs = ['tab-term', 'tab-claude']
  const tabsMoved: Array<{ tabIds: string[]; resume: string[] }> = []
  const deps: ProjectMoverDeps = {
    local: {
      peek: () => local.peek(),
      commit: (data) => {
        events.push('commit')
        local.commit(data)
      },
      archive: () => withArchivedTasks(withArchivedStream(emptyArchive(), archivedStream()), [archivedTask()]),
      liveTabs: (ids) => ids.filter(id => liveTabs.includes(id)),
      endTabs: async (project) => {
        // Still this desktop's while its processes end.
        events.push(`endTabs:${project.id}:routes=${index.hostOfTab('tab-term')}`)
      }
    },
    servers: serverProjects,
    call: async (serverId, ch, args) => {
      hubCalls.push({ ch, args })
      if (failOn.has(ch)) throw new Error(`${ch} failed`)
      if (ch === 'server-list-dirs') return { path: `/home/me/${String(args[1]).replace(/^~\//, '')}`, parent: '/home/me', home: '/home/me', git: true, entries: [] }
      if (ch === 'archive-add-stream') {
        server.archive = withArchivedStream(server.archive, args[1] as ArchivedStream)
        events.push('archive-stream')
        return server.archive
      }
      if (ch === 'archive-add-tasks') {
        server.archive = withArchivedTasks(server.archive, args[1] as ArchivedTask[])
        events.push('archive-tasks')
        return server.archive
      }
      return hub.call(serverId, 'main', ch, args)
    },
    unpin: (tabId) => {
      index.unpin(tabId)
      events.push(`unpin:${tabId}`)
    },
    tabsMoved: (event) => {
      tabsMoved.push(event)
      events.push('tabsMoved')
    },
    closeSsh: async (projectId) => { events.push(`closeSsh:${projectId}`) },
    log: (message) => logs.push(message)
  }
  return { mover: new ProjectMover(deps), local, serverProjects, server, index, events, broadcasts, logs, hubCalls, failOn, liveTabs, tabsMoved }
}

function archivedTask(): ArchivedTask {
  return { task: fixtureTask({ id: 'task-done' }), streamId: 'stream-feat', streamName: 'feat', dir: '/home/me/repo/.worktrees/feat', archivedAt: 1 }
}

function archivedStream(): ArchivedStream {
  return {
    stream: { id: 'stream-old', name: 'old', workspace: { worktreePath: '/home/me/repo/.worktrees/old', branchName: 'old', baseBranch: 'main', relativeProjectPath: '' }, tasks: [] },
    doneTasks: [],
    dir: '/home/me/repo/.worktrees/old',
    archivedAt: 2
  }
}

describe('ProjectMover (Move to a DevTool server)', () => {
  it('moves the project with every id, keeps its order, pins and tags, and never drops it as a collision', async () => {
    const h = await harness()
    const pinned = h.index.pinnedHost('tab-term')
    expect(pinned).toBeUndefined()
    h.index.pin('tab-term', LOCAL_HOST)

    const result = await h.mover.move('p-ssh', SERVER)
    expect(result).toEqual({ projectId: 'p-ssh', serverId: SERVER, directory: '/home/me/repo', restarted: ['tab-term', 'tab-claude'] })

    // The server has it, as a server stores it: same ids, its folder, no ssh, no host.
    const onServer = h.server.data.projects.find(p => p.id === 'p-ssh')!
    expect(onServer.directory).toBe('/home/me/repo')
    expect(onServer).not.toHaveProperty('ssh')
    expect(onServer).not.toHaveProperty('host')
    expect(onServer.streams.map(s => s.id)).toEqual(sshProject().streams.map(s => s.id))
    expect(onServer.streams[1].tasks.map(t => t.panes[0].tabs[0].id)).toEqual(['tab-term', 'tab-claude'])
    expect(onServer.streams[1].tasks[1].panes[0].tabs[0].sessionId).toBe('sess-1')
    expect(onServer.streams[1].tasks.every(t => t.sharesStreamWorktree)).toBe(true)
    expect(onServer.tagIds).toEqual(['tag-ssh'])
    expect(h.server.data.projects.map(p => p.id)).toEqual(['s-1', 'p-ssh'])

    // This desktop: gone from its own projects, kept in its order and pins, its tag kept.
    const local = h.local.peek()
    expect(local.projects.map(p => p.id)).toEqual(['p-local'])
    expect(local.projectOrder).toEqual(['p-local', 'p-ssh'])
    expect(local.pinnedItems).toEqual([{ type: 'project', projectId: 'p-ssh' }, { type: 'task', projectId: 'p-ssh', streamId: 'stream-feat', taskId: 'task-claude' }])
    expect(local.tags.map(t => t.id)).toContain('tag-ssh')

    // Windows see it as the server's; routing follows; nothing was dropped.
    const foreign = h.serverProjects.foreignProjects().find(p => p.id === 'p-ssh')!
    expect(foreign.host).toBe(SERVER)
    expect(h.index.hostOfProject('p-ssh')).toBe(SERVER)
    expect(h.index.hostOfTab('tab-term')).toBe(SERVER)
    expect(h.index.hostOfTask('task-claude')).toBe(SERVER)
    expect(h.logs.filter(line => line.includes('id-collision'))).toEqual([])
    expect(h.broadcasts.at(-1)!.data.projects.map(p => p.id)).toEqual(['s-1', 'p-ssh'])
  })

  it('writes the server first, ends the local tabs before the switch, and closes ssh last', async () => {
    const h = await harness()
    await h.mover.move('p-ssh', SERVER)
    const at = (prefix: string) => h.events.findIndex(e => e.startsWith(prefix))
    expect(at('server-save:')).toBeGreaterThanOrEqual(0)
    expect(at('server-save:')).toBeLessThan(at('archive-stream'))
    expect(at('archive-tasks')).toBeLessThan(at('tabsMoved'))
    expect(at('tabsMoved')).toBeLessThan(at('endTabs:'))
    expect(at('endTabs:')).toBeLessThan(at('commit'))
    expect(at('unpin:tab-term')).toBeLessThan(at('commit'))
    expect(at('commit')).toBeLessThan(at('closeSsh:'))
    // While its processes ended, the project was still this desktop's.
    expect(h.events.find(e => e.startsWith('endTabs:'))).toBe('endTabs:p-ssh:routes=local')
    // No window saw the server's copy while the local one was there.
    const commit = at('commit')
    for (const event of h.events.slice(0, commit)) {
      if (event.startsWith(`broadcast:${SERVER}:`)) expect(event).not.toContain('p-ssh')
    }
    // The commit's own broadcasts: local without it, then the server with it.
    expect(h.events.slice(commit + 1, commit + 3)).toEqual(['broadcast:local:p-local', `broadcast:${SERVER}:s-1,p-ssh`])
    // Only Claude and Pi wait for a click: those that were running resume.
    expect(h.tabsMoved).toEqual([{ tabIds: ['tab-term', 'tab-claude'], resume: ['tab-claude'] }])
  })

  it('keeps the project when a window saves the server slice it had before the switch', async () => {
    const h = await harness()
    // A window's slice of the server from before the move: the project isn't in it yet.
    const stale: ProjectsData = { projects: h.serverProjects.sources()[SERVER].data.projects, tags: [], projectOrder: [], pinnedItems: [] }
    const pending: { save?: Promise<unknown> } = {}
    h.local.subscribe(() => {
      // Right after the switch, before the window heard of it, at the server's current revision.
      const base = h.server.revision
      queueMicrotask(() => { pending.save ??= h.serverProjects.save(SERVER, 'win:1', { baseRevision: base, data: stale }) })
    })
    await h.mover.move('p-ssh', SERVER)
    expect(await pending.save).toMatchObject({ ok: false })
    expect(h.server.data.projects.map(p => p.id)).toEqual(['s-1', 'p-ssh'])
    // The refusal hands the window the slice with the project to replay onto.
    expect((await pending.save as { data: ProjectsData }).data.projects.map(p => p.id)).toEqual(['s-1', 'p-ssh'])
  })

  it('moves the archive to the server\'s own, its worktree tasks kept in their stream\'s folder', async () => {
    const h = await harness()
    await h.mover.move('p-ssh', SERVER)
    expect(h.server.archive.streams.map(s => s.stream.id)).toEqual(['stream-old'])
    expect(h.server.archive.tasks.map(t => t.task.id)).toEqual(['task-done'])
    expect(h.server.archive.tasks[0].task.sharesStreamWorktree).toBe(true)
    expect(h.hubCalls.filter(c => c.ch.startsWith('archive-')).map(c => c.args[0])).toEqual(['p-ssh', 'p-ssh'])
  })

  it('leaves everything as it was when the server refuses the project', async () => {
    const h = await harness()
    const before = JSON.stringify(h.local.peek())
    const serverBefore = JSON.stringify(h.server.data)
    h.failOn.add('save-projects-slice')
    await expect(h.mover.move('p-ssh', SERVER)).rejects.toThrow(/did not take the project/)
    expect(JSON.stringify(h.local.peek())).toBe(before)
    expect(JSON.stringify(h.server.data)).toBe(serverBefore)
    expect(h.events.some(e => e === 'tabsMoved' || e.startsWith('endTabs') || e === 'commit' || e.startsWith('closeSsh'))).toBe(false)
    expect(h.serverProjects.foreignProjects().map(p => p.id)).toEqual(['s-1'])
    expect(h.index.hostOfProject('p-ssh')).toBe(LOCAL_HOST)
  })

  it('takes the project off the server again when its archive does not go through', async () => {
    const h = await harness()
    h.failOn.add('archive-add-tasks')
    await expect(h.mover.move('p-ssh', SERVER)).rejects.toThrow(/archive-add-tasks failed/)
    expect(h.server.data.projects.map(p => p.id)).toEqual(['s-1'])
    expect(h.local.peek().projects.map(p => p.id)).toEqual(['p-ssh', 'p-local'])
    expect(h.events.some(e => e === 'tabsMoved' || e === 'commit')).toBe(false)
    // The ids are this desktop's again, and nothing of the server collides with them.
    expect(h.index.hostOfTab('tab-term')).toBe(LOCAL_HOST)
    expect(h.logs.filter(line => line.includes('id-collision'))).toEqual([])
  })

  it('takes the project off the server again when this desktop cannot save', async () => {
    const h = await harness()
    h.failOn.add('commit')
    await expect(h.mover.move('p-ssh', SERVER)).rejects.toThrow(/could not save/)
    expect(h.server.data.projects.map(p => p.id)).toEqual(['s-1'])
  })

  it('refuses a server that has no such folder: it runs on another machine', async () => {
    const h = await harness()
    h.failOn.add('server-list-dirs')
    await expect(h.mover.move('p-ssh', SERVER)).rejects.toThrow(/has no folder ~\/repo/)
    expect(h.events.some(e => e.startsWith('server-save'))).toBe(false)
  })

  it('retries the server\'s compare-and-swap when another desktop saved first', async () => {
    const h = await harness()
    // Another desktop adds a project after this one last heard from the server.
    h.server.revision += 1
    h.server.data = { ...h.server.data, projects: [...h.server.data.projects, fixtureProject({ id: 's-2', directory: '/srv/2' })] }
    await h.mover.move('p-ssh', SERVER)
    expect(h.server.data.projects.map(p => p.id)).toEqual(['s-1', 's-2', 'p-ssh'])
  })

  it('refuses a project that is not an SSH project, and a second move of the same one', async () => {
    const h = await harness()
    await expect(h.mover.move('p-local', SERVER)).rejects.toThrow(/Only an SSH project/)
    await expect(h.mover.move('nope', SERVER)).rejects.toThrow(/gone/)
    const first = h.mover.move('p-ssh', SERVER)
    await expect(h.mover.move('p-ssh', SERVER)).rejects.toThrow(/already moving/)
    await first
  })

  it('replaces a copy a failed move left on the server', async () => {
    const leftover = { ...sshProject(), ssh: undefined, directory: '/home/me/repo', name: 'leftover' }
    const h = await harness({ serverProjects: [leftover] })
    // While this desktop has the project, the server's copy is hidden as a collision.
    expect(h.serverProjects.foreignProjects().map(p => p.id)).toEqual([])
    await h.mover.move('p-ssh', SERVER)
    expect(h.server.data.projects.map(p => [p.id, p.name])).toEqual([['p-ssh', 'repo']])
    expect(h.serverProjects.foreignProjects().map(p => p.id)).toEqual(['p-ssh'])
  })
})
