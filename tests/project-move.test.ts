import { describe, expect, it } from 'vitest'
import {
  canMoveToServer,
  matchServerForSsh,
  parseSshProbe,
  projectTabIds,
  sameHostName,
  serverArchiveFrom,
  serverPathForRemoteDir,
  serverProjectFrom,
  sshInstallTargetOf,
  sshProbeScript,
  SSH_PROBE_MARKER
} from '../src/shared/project-move'
import { needsTaskWorktree, reopensInOwnWorktree } from '../src/shared/streams'
import type { ServerStatus, SshHostProbe } from '../src/shared/servers'
import type { Project, SshConfig, Stream } from '../src/shared/types'
import { emptyArchive } from '../src/shared/archive'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const SSH: SshConfig = { host: 'orb', port: 22, username: 'devtool-srv-test', remoteDir: '/home/join3r/repo' }
const WORKTREE = { worktreePath: '/home/join3r/repo/.worktrees/feat', branchName: 'feat', baseBranch: 'main', relativeProjectPath: '' }

function sshProject(): Project {
  const feat: Stream = {
    id: 'stream-feat',
    name: 'feat',
    workspace: WORKTREE,
    taskWorktrees: true,
    tasks: [
      fixtureTask({ id: 'task-term', tabs: { left: [{ id: 'tab-term', type: 'terminal', title: 'Terminal' }] } }),
      fixtureTask({ id: 'task-claude', tabs: { left: [{ id: 'tab-claude', type: 'claude', title: 'Claude', sessionId: 'sess-1' }] } })
    ]
  }
  return {
    ...fixtureProject({ id: 'p-ssh', name: 'repo', directory: '', tasks: [{ id: 'task-main', tabs: { left: [{ id: 'tab-main', type: 'terminal', title: 'T' }] } }], streams: [feat] }),
    ssh: SSH,
    tunnel: { host: 'localhost', sourcePort: 3000, destinationPort: 3000 },
    tagIds: ['tag-1'],
    aiToolArgs: { claude: '--model sonnet' }
  }
}

function server(id: string, host: Partial<ServerStatus['host']> | null, state: ServerStatus['state'] = 'online'): ServerStatus {
  return {
    id,
    name: `name-${id.slice(0, 4)}`,
    state,
    pairedAt: 1,
    lastSeen: null,
    build: null,
    host: host ? { os: 'linux', arch: 'arm64', hostname: '', node: '24.21.0', ...host } : null
  }
}

const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const RELAY = 'ws://192.168.1.101:8787'

function probe(over: Partial<SshHostProbe> = {}): SshHostProbe {
  return { hostname: 'devtool-srv-test', user: 'join3r', installed: false, ...over }
}

describe('moving an SSH project to a server', () => {
  it('is offered for SSH projects only', () => {
    expect(canMoveToServer(sshProject())).toBe(true)
    expect(canMoveToServer(fixtureProject({ id: 'local' }))).toBe(false)
    expect(canMoveToServer({ ...fixtureProject({ id: 'srv' }), host: ID_A })).toBe(false)
    expect(canMoveToServer({ ssh: SSH, host: ID_A })).toBe(false)
  })

  it('asks the server for the remote folder as an SSH session would cd there', () => {
    expect(serverPathForRemoteDir('/home/join3r/repo')).toBe('/home/join3r/repo')
    expect(serverPathForRemoteDir('')).toBe('~')
    expect(serverPathForRemoteDir('  ')).toBe('~')
    expect(serverPathForRemoteDir(undefined)).toBe('~')
    expect(serverPathForRemoteDir('src/repo')).toBe('~/src/repo')
    expect(serverPathForRemoteDir('~/repo')).toBe('~/repo')
  })

  it('keeps every id, drops ssh and the tunnel, and sets the folder on the server', () => {
    const project = sshProject()
    const moved = serverProjectFrom(project, '/home/join3r/repo')
    expect(moved).not.toHaveProperty('ssh')
    expect(moved).not.toHaveProperty('tunnel')
    expect(moved).not.toHaveProperty('host')
    expect(moved.directory).toBe('/home/join3r/repo')
    expect(moved.id).toBe(project.id)
    expect(moved.streams.map(s => s.id)).toEqual(project.streams.map(s => s.id))
    expect(projectTabIds(moved)).toEqual(['tab-main', 'tab-term', 'tab-claude'])
    expect(moved.tagIds).toEqual(['tag-1'])
    expect(moved.aiToolArgs).toEqual({ claude: '--model sonnet' })
    const claude = moved.streams[1].tasks[1].panes[0].tabs[0]
    expect(claude.sessionId).toBe('sess-1')
    // The stream's worktree path is the same folder on the same machine.
    expect(moved.streams[1].workspace).toEqual(WORKTREE)
  })

  it('keeps the tasks that came along in their stream\'s worktree, while new ones get their own', () => {
    const moved = serverProjectFrom(sshProject(), '/home/join3r/repo')
    const feat = moved.streams[1]
    expect(feat.taskWorktrees).toBe(true)
    expect(feat.tasks.every(task => task.sharesStreamWorktree)).toBe(true)
    // The main stream works in the project folder: nothing to stamp.
    expect(moved.streams[0].tasks[0].sharesStreamWorktree).toBeUndefined()
    for (const task of feat.tasks) expect(needsTaskWorktree(moved, feat, task)).toBe(false)
    const fresh = fixtureTask({ id: 'task-new' })
    expect(needsTaskWorktree(moved, { ...feat, tasks: [...feat.tasks, fresh] }, fresh)).toBe(true)
    // Over SSH the same task never needed one.
    const ssh = sshProject()
    expect(needsTaskWorktree(ssh, ssh.streams[1], ssh.streams[1].tasks[0])).toBe(false)
    // A task with a worktree of its own keeps it as it is.
    const own = { ...fixtureTask({ id: 'task-own' }), workspace: { ...WORKTREE, worktreePath: '/w/own' } }
    const withOwn = serverProjectFrom({ ...ssh, streams: [ssh.streams[0], { ...ssh.streams[1], tasks: [own] }] }, '/r')
    expect(withOwn.streams[1].tasks[0]).toEqual(own)
  })

  it('stamps archived tasks of worktree streams too, so a reopen lands in the same folder', () => {
    const project = sshProject()
    const archived = fixtureTask({ id: 'task-old' })
    const archive = {
      ...emptyArchive(),
      tasks: [
        { task: archived, streamId: 'stream-feat', streamName: 'feat', dir: WORKTREE.worktreePath, archivedAt: 1 },
        { task: fixtureTask({ id: 'task-main-old' }), streamId: 'main-p-ssh', streamName: 'main', dir: '/home/join3r/repo', archivedAt: 2 }
      ],
      streams: [{
        stream: { id: 'stream-gone', name: 'gone', workspace: { ...WORKTREE, worktreePath: '/w/gone' }, tasks: [fixtureTask({ id: 'task-gone' })] },
        doneTasks: [{ task: fixtureTask({ id: 'task-gone-done' }), streamId: 'stream-gone', streamName: 'gone', dir: '/w/gone', archivedAt: 3 }],
        dir: '/w/gone',
        archivedAt: 4
      }]
    }
    const moved = serverArchiveFrom(archive, project)
    expect(moved.tasks[0].task.sharesStreamWorktree).toBe(true)
    expect(moved.tasks[1].task.sharesStreamWorktree).toBeUndefined()
    expect(moved.streams[0].stream.taskWorktrees).toBe(true)
    expect(moved.streams[0].stream.tasks[0].sharesStreamWorktree).toBe(true)
    expect(moved.streams[0].doneTasks[0].task.sharesStreamWorktree).toBe(true)
    const feat = serverProjectFrom(project, '/r').streams[1]
    expect(reopensInOwnWorktree(serverProjectFrom(project, '/r'), feat, moved.tasks[0].task)).toBe(false)
    expect(moved.tasks.map(t => t.task.id)).toEqual(['task-old', 'task-main-old'])
  })

  it('installs over SSH with the project\'s own target', () => {
    expect(sshInstallTargetOf(SSH)).toEqual({ host: 'orb', user: 'devtool-srv-test' })
    expect(sshInstallTargetOf({ host: 'h', port: 2222, username: '', keyFile: '~/.ssh/k', remoteDir: '' })).toEqual({ host: 'h', port: 2222, keyFile: '~/.ssh/k' })
  })
})

describe('which server runs on the SSH host', () => {
  const servers = [server(ID_A, { hostname: 'devtool-srv-test', user: 'join3r' }), server(ID_B, { hostname: 'other-box' })]

  it('reuses the paired server the host says runs there', () => {
    expect(matchServerForSsh({ ssh: SSH, servers, probe: probe({ installed: true, serverId: ID_A, relayUrl: RELAY }), relayUrl: RELAY }))
      .toEqual({ kind: 'paired', serverId: ID_A })
    // Even while it is offline: the dialog waits for it.
    expect(matchServerForSsh({ ssh: SSH, servers: [server(ID_A, null, 'offline')], probe: probe({ installed: true, serverId: ID_A }), relayUrl: RELAY }))
      .toEqual({ kind: 'paired', serverId: ID_A })
  })

  it('installs when nothing runs there and no paired server reports that machine', () => {
    expect(matchServerForSsh({ ssh: SSH, servers: [], probe: probe(), relayUrl: RELAY })).toEqual({ kind: 'install' })
    expect(matchServerForSsh({ ssh: SSH, servers: [servers[1]], probe: probe(), relayUrl: RELAY })).toEqual({ kind: 'install' })
    // A paired server with that host name but another user is another server.
    expect(matchServerForSsh({ ssh: SSH, servers: [server(ID_A, { hostname: 'devtool-srv-test', user: 'root' })], probe: probe(), relayUrl: RELAY })).toEqual({ kind: 'install' })
  })

  it('installs (which pairs it) when a server this desktop doesn\'t know runs there on its relay', () => {
    expect(matchServerForSsh({ ssh: SSH, servers, probe: probe({ installed: true, serverId: 'c'.repeat(32), relayUrl: `${RELAY}/` }), relayUrl: RELAY }))
      .toEqual({ kind: 'install' })
  })

  it('refuses a server on another relay', () => {
    expect(matchServerForSsh({ ssh: SSH, servers, probe: probe({ installed: true, relayUrl: 'wss://relay.devtool.awantech.sk' }), relayUrl: RELAY }))
      .toEqual({ kind: 'other-relay', relayUrl: 'wss://relay.devtool.awantech.sk' })
    expect(matchServerForSsh({ ssh: SSH, servers, probe: probe({ installed: true, serverId: 'c'.repeat(32), relayUrl: 'wss://elsewhere' }), relayUrl: RELAY }).kind)
      .toBe('other-relay')
  })

  it('asks when a paired server reports the machine but nothing runs in the default home', () => {
    expect(matchServerForSsh({ ssh: SSH, servers, probe: probe(), relayUrl: RELAY }))
      .toEqual({ kind: 'ask', candidates: [ID_A], likely: ID_A })
    // An older server says no user: the host name alone.
    const old = [server(ID_A, { hostname: 'devtool-srv-test.lan' })]
    expect(matchServerForSsh({ ssh: SSH, servers: old, probe: probe({ installed: true }), relayUrl: RELAY }))
      .toEqual({ kind: 'ask', candidates: [ID_A], likely: ID_A })
  })

  it('asks with every paired server when the host could not be checked, its likely one first', () => {
    const named = [server(ID_B, { hostname: 'other-box' }), server(ID_A, { hostname: 'dev', user: 'deploy' })]
    expect(matchServerForSsh({ ssh: { host: 'dev.example.com', username: 'deploy' }, servers: named, probe: null, relayUrl: RELAY }))
      .toEqual({ kind: 'ask', candidates: [ID_A, ID_B], likely: ID_A })
    expect(matchServerForSsh({ ssh: SSH, servers: named, probe: null, relayUrl: RELAY }))
      .toEqual({ kind: 'ask', candidates: [ID_B, ID_A] })
    expect(matchServerForSsh({ ssh: SSH, servers: [], probe: null, relayUrl: RELAY })).toEqual({ kind: 'install' })
  })

  it('compares host names the way people write them', () => {
    expect(sameHostName('dev', 'dev.example.com')).toBe(true)
    expect(sameHostName('Dev.local', 'dev')).toBe(true)
    expect(sameHostName('dev', 'devbox')).toBe(false)
    expect(sameHostName('10.0.0.1', '10.0.0.2')).toBe(false)
    expect(sameHostName('', 'dev')).toBe(false)
  })
})

describe('the SSH host probe', () => {
  it('is one sh -c a fish or csh login shell passes on unchanged', () => {
    const script = sshProbeScript()
    expect(script.startsWith("sh -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    const inner = script.slice("sh -c '".length, -1)
    expect(inner).not.toMatch(/['\\!\n]/)
    expect(inner).toContain(SSH_PROBE_MARKER)
  })

  it('reads the host, the user and the server installed there, after any banner', () => {
    const out = [
      'Welcome to Ubuntu',
      SSH_PROBE_MARKER,
      'host=devtool-srv-test',
      'user=join3r',
      'installed=1',
      'config={ "relayUrl": "ws://192.168.1.101:8787", "name": "box" }',
      `status=DevTool server "box" (${ID_A})`
    ].join('\n')
    expect(parseSshProbe(out)).toEqual({ hostname: 'devtool-srv-test', user: 'join3r', installed: true, serverId: ID_A, relayUrl: RELAY })
  })

  it('reads a host with nothing installed, and a stopped server (no status)', () => {
    expect(parseSshProbe(`${SSH_PROBE_MARKER}\r\nhost=box\r\nuser=me\r\ninstalled=0\r\n`)).toEqual({ hostname: 'box', user: 'me', installed: false })
    expect(parseSshProbe(`${SSH_PROBE_MARKER}\nhost=box\nuser=me\ninstalled=1\nconfig=not json\nstatus=\n`)).toEqual({ hostname: 'box', user: 'me', installed: true })
    expect(parseSshProbe('no marker here')).toBeNull()
  })
})
