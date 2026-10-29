import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRuns, type StreamRunPtys } from '../src/main/stream-runs'
import { PtySessions } from '../src/main/pty-sessions'
import type { PtyManager } from '../src/main/pty-manager'
import type { ScrollbackStorage } from '../src/main/scrollback-storage'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import type { AppConfig, Project, ProjectsData } from '../src/shared/types'
import { createMainStream } from '../src/shared/types'
import { streamRunCommand, streamRunTabId, type StreamRunState } from '../src/shared/stream-run'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'app',
    directory: '/repo',
    streams: [
      { ...createMainStream('p1'), id: 's-main' },
      { id: 's2', name: '0.5.0', tasks: [], workspace: { worktreePath: '/repo/.worktrees/0.5.0', branchName: '0.5.0', baseBranch: 'main' } as never }
    ],
    runCommand: 'npm run dev',
    ...overrides
  } as Project
}

describe('streamRunCommand', () => {
  it('takes the stream’s own command over the project’s, and none for shell-command projects', () => {
    const p = project()
    expect(streamRunCommand(p, p.streams[0])).toBe('npm run dev')
    expect(streamRunCommand(p, { ...p.streams[1], runCommand: '  pnpm dev --port 4000 ' })).toBe('pnpm dev --port 4000')
    expect(streamRunCommand(project({ runCommand: '  ' }), p.streams[0])).toBeUndefined()
    expect(streamRunCommand(project({ shellCommand: { command: 'htop' } }), p.streams[0])).toBeUndefined()
  })
})

describe('StreamRuns', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(initial: Project = project()) {
    let data: ProjectsData = { projects: [initial] } as ProjectsData
    const running = new Set<string>()
    const ptys = {
      spawnDetached: vi.fn((request: { id: string }) => { running.add(request.id) }),
      terminate: vi.fn((id: string) => { running.delete(id) }),
      writeFromMain: vi.fn((id: string) => running.has(id)),
      isRunning: (id: string) => running.has(id),
      discard: vi.fn((id: string) => { running.delete(id) }),
      loadScrollback: () => 'log'
    } satisfies StreamRunPtys
    const states: [string, string, StreamRunState | null][] = []
    const runs = new StreamRuns({
      ptys,
      projects: () => data,
      localShell: () => '/bin/zsh',
      ensureSsh: vi.fn(async () => {}),
      onState: (projectId, streamId, state) => { states.push([projectId, streamId, state]) },
      log: () => {},
      now: () => 1000,
      graceMs: 3000
    })
    return { runs, ptys, states, running, setData: (next: ProjectsData) => { data = next } }
  }

  it('starts the command in the stream’s folder through a login shell', async () => {
    const { runs, ptys, states } = setup()
    expect(await runs.control('p1', 's2', 'start')).toEqual({ ok: true })
    expect(ptys.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({
      id: streamRunTabId('s2'), shell: '/bin/zsh', args: ['-l', '-c', 'npm run dev'], cwd: '/repo/.worktrees/0.5.0', quiet: true
    }))
    expect(runs.state('s2')).toEqual({ status: 'running', command: 'npm run dev', startedAt: 1000 })
    expect(states[states.length - 1]?.[2]?.status).toBe('running')
    // A second Run while it runs changes nothing.
    await runs.control('p1', 's2', 'start')
    expect(ptys.spawnDetached).toHaveBeenCalledTimes(1)
  })

  it('runs an SSH project’s command on the remote host', async () => {
    const ssh = { host: 'h', port: 22, username: 'u', remoteDir: '/srv/app' }
    const { runs, ptys } = setup(project({ ssh } as Partial<Project>))
    await runs.control('p1', 's-main', 'start')
    expect(ptys.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({
      shell: '/bin/sh', args: ['-c', 'npm run dev'], cwd: '/srv/app', sshConfig: ssh
    }))
  })

  it('refuses a stream with no command', async () => {
    const { runs, ptys } = setup(project({ runCommand: undefined }))
    const result = await runs.control('p1', 's-main', 'start')
    expect(result.ok).toBe(false)
    expect(ptys.spawnDetached).not.toHaveBeenCalled()
  })

  it('records an exit by itself as exited with its code', async () => {
    const { runs } = setup()
    await runs.control('p1', 's-main', 'start')
    runs.handleExit(streamRunTabId('s-main'), 1)
    expect(runs.state('s-main')).toMatchObject({ status: 'exited', exitCode: 1, endedAt: 1000 })
  })

  it('stops with Ctrl-C first and calls it stopped, whatever the code', async () => {
    const { runs, ptys } = setup()
    await runs.control('p1', 's-main', 'start')
    const stopped = runs.control('p1', 's-main', 'stop')
    expect(ptys.writeFromMain).toHaveBeenCalledWith(streamRunTabId('s-main'), '\x03')
    runs.handleExit(streamRunTabId('s-main'), 130)
    await stopped
    expect(ptys.terminate).not.toHaveBeenCalled()
    expect(runs.state('s-main')).toMatchObject({ status: 'stopped' })
    expect(runs.state('s-main')?.exitCode).toBeUndefined()
  })

  it('ends the process outright when Ctrl-C does nothing', async () => {
    const { runs, ptys } = setup()
    await runs.control('p1', 's-main', 'start')
    const stopped = runs.control('p1', 's-main', 'stop')
    await vi.advanceTimersByTimeAsync(3000)
    expect(ptys.terminate).toHaveBeenCalledWith(streamRunTabId('s-main'))
    // No exit ever reported: still counts as stopped.
    await vi.advanceTimersByTimeAsync(1000)
    await stopped
    expect(runs.state('s-main')?.status).toBe('stopped')
  })

  it('restarts: stops, then starts afresh', async () => {
    const { runs, ptys } = setup()
    await runs.control('p1', 's-main', 'start')
    const restarted = runs.control('p1', 's-main', 'restart')
    runs.handleExit(streamRunTabId('s-main'), 0)
    expect(await restarted).toEqual({ ok: true })
    expect(ptys.spawnDetached).toHaveBeenCalledTimes(2)
    expect(runs.state('s-main')?.status).toBe('running')
  })

  it('drops the run of a stream that is gone', async () => {
    const { runs, ptys, states, setData } = setup()
    await runs.control('p1', 's2', 'start')
    setData({ projects: [project({ streams: [{ ...createMainStream('p1'), id: 's-main' }] })] } as ProjectsData)
    runs.reconcile()
    expect(ptys.discard).toHaveBeenCalledWith(streamRunTabId('s2'))
    expect(runs.state('s2')).toBeNull()
    expect(states[states.length - 1]).toEqual(['p1', 's2', null])
  })

  describe('in a task’s worktree', () => {
    const taskWorkspace = { worktreePath: '/repo/.worktrees/0.5.0--fix-auth', branchName: '0.5.0--fix-auth', baseBranch: '0.5.0' }
    function withTasks(): Project {
      const p = project()
      p.streams[1] = {
        ...p.streams[1],
        tasks: [
          { id: 't-auth', name: 'fix-auth', tabs: [], workspace: taskWorkspace },
          { id: 't-shared', name: 'shared', tabs: [] }
        ]
      } as never
      return p
    }

    it('starts there and says which task it runs in', async () => {
      const { runs, ptys } = setup(withTasks())
      expect(await runs.control('p1', 's2', 'start', 't-auth')).toEqual({ ok: true })
      expect(ptys.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({ id: streamRunTabId('s2'), cwd: '/repo/.worktrees/0.5.0--fix-auth' }))
      expect(runs.state('s2')).toEqual({ status: 'running', command: 'npm run dev', startedAt: 1000, taskId: 't-auth' })
    })

    it('runs a task without a worktree of its own in the stream’s folder', async () => {
      const { runs, ptys } = setup(withTasks())
      await runs.control('p1', 's2', 'start', 't-shared')
      expect(ptys.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/.worktrees/0.5.0' }))
      expect(runs.state('s2')?.taskId).toBeUndefined()
    })

    it('refuses a task that isn’t in the stream', async () => {
      const { runs, ptys } = setup(withTasks())
      expect(await runs.control('p1', 's2', 'start', 't-nope')).toEqual({ ok: false, error: 'The task is gone' })
      expect(ptys.spawnDetached).not.toHaveBeenCalled()
    })

    it('moves a running app there, and does nothing when it already runs there', async () => {
      const { runs, ptys } = setup(withTasks())
      await runs.control('p1', 's2', 'start')
      const moved = runs.control('p1', 's2', 'start', 't-auth')
      expect(ptys.writeFromMain).toHaveBeenCalledWith(streamRunTabId('s2'), '\x03')
      runs.handleExit(streamRunTabId('s2'), 130)
      expect(await moved).toEqual({ ok: true })
      expect(ptys.spawnDetached).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/repo/.worktrees/0.5.0--fix-auth' }))
      await runs.control('p1', 's2', 'start', 't-auth')
      expect(ptys.spawnDetached).toHaveBeenCalledTimes(2)
    })

    it('restarts where it ran', async () => {
      const { runs, ptys } = setup(withTasks())
      await runs.control('p1', 's2', 'start', 't-auth')
      const restarted = runs.control('p1', 's2', 'restart')
      runs.handleExit(streamRunTabId('s2'), 0)
      await restarted
      expect(ptys.spawnDetached).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/repo/.worktrees/0.5.0--fix-auth' }))
      expect(runs.state('s2')?.taskId).toBe('t-auth')
    })

    it('drops the run once its task leaves the stream', async () => {
      const { runs, ptys, setData } = setup(withTasks())
      await runs.control('p1', 's2', 'start', 't-auth')
      runs.reconcile()
      expect(ptys.discard).not.toHaveBeenCalled()
      const closed = withTasks()
      closed.streams[1].tasks = closed.streams[1].tasks.filter(t => t.id !== 't-auth')
      setData({ projects: [closed] } as ProjectsData)
      runs.reconcile()
      expect(ptys.discard).toHaveBeenCalledWith(streamRunTabId('s2'))
      expect(runs.state('s2')).toBeNull()
    })
  })

  it('lists one project’s runs', async () => {
    const { runs } = setup()
    await runs.control('p1', 's2', 'start')
    expect(Object.keys(runs.statesOf('p1'))).toEqual(['s2'])
    expect(runs.statesOf('other')).toEqual({})
  })
})

describe('PtySessions detached runs', () => {
  function setup(saved: string | null = null) {
    const callbacks = new Map<string, { onData?: (data: string) => void; onExit?: (code: number) => void }>()
    const ptyManager = {
      spawn: vi.fn((id: string, _shell: string, _cwd: string, _cols: number, _rows: number, _args?: string[], _env?: unknown,
        cbs?: { onData?: (data: string) => void; onExit?: (code: number) => void }) => { callbacks.set(id, cbs ?? {}) }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAll: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }
    const scrollback = { save: vi.fn(), load: vi.fn(() => saved), delete: vi.fn() }
    const sent: unknown[][] = []
    const exits: [string, number][] = []
    const sessions = new PtySessions({
      ptyManager: ptyManager as unknown as PtyManager,
      scrollbackStorage: scrollback as unknown as ScrollbackStorage,
      activityRegistry: new TabActivityRegistry(),
      sshManager: () => { throw new Error('no ssh in this test') },
      hookInjector: () => { throw new Error('no hooks in this test') },
      hookPort: () => 0,
      hookToken: () => '',
      getConfig: () => ({}) as AppConfig,
      broadcastAgentActivity: () => {},
      sendToClient: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
      log: () => {},
      piExtensionPath: () => '',
      onExit: (tabId, code) => { exits.push([tabId, code]) }
    })
    const start = () => sessions.spawnDetached({ id: 'run-s1', shell: '/bin/zsh', cwd: '/repo', cols: 120, rows: 32, args: ['-l', '-c', 'npm run dev'] })
    return { sessions, ptyManager, callbacks, sent, exits, scrollback, start }
  }

  it('runs with no window, and a viewer attaching later gets the output so far and what follows', () => {
    const { sessions, callbacks, sent, start } = setup()
    start()
    callbacks.get('run-s1')!.onData!('ready\r\n')
    expect(sent).toEqual([])
    expect(sessions.attachExisting('win:1', 'run-s1')).toEqual({ cols: 120, rows: 32, scrollback: 'ready\r\n', exitCode: null })
    callbacks.get('run-s1')!.onData!('GET /')
    expect(sent).toEqual([['win:1', 'pty-data', 'run-s1', 'GET /']])
    sessions.detach('win:1', 'run-s1')
    callbacks.get('run-s1')!.onData!('more')
    expect(sent).toHaveLength(1)
  })

  it('never spawns on attach; a run that is gone shows its saved log', () => {
    expect(setup().sessions.attachExisting('win:1', 'run-s1')).toBeNull()
    expect(setup('old log').sessions.attachExisting('win:1', 'run-s1')).toEqual({ cols: 80, rows: 24, scrollback: 'old log', exitCode: -1 })
  })

  it('keeps its viewers across a restart, with a fresh log', () => {
    const { sessions, callbacks, sent, start, scrollback } = setup()
    start()
    sessions.attachExisting('win:1', 'run-s1')
    callbacks.get('run-s1')!.onData!('first run')
    start()
    expect(scrollback.delete).toHaveBeenCalledWith('run-s1')
    expect(sessions.loadScrollback('run-s1')).toBe('')
    callbacks.get('run-s1')!.onData!('second run')
    expect(sent[sent.length - 1]).toEqual(['win:1', 'pty-data', 'run-s1', 'second run'])
  })

  it('terminate keeps the runtime so viewers see the exit and the log stays', () => {
    const { sessions, ptyManager, callbacks, sent, exits, start } = setup()
    start()
    sessions.attachExisting('win:1', 'run-s1')
    callbacks.get('run-s1')!.onData!('bye')
    sessions.terminate('run-s1')
    expect(ptyManager.kill).toHaveBeenCalledWith('run-s1')
    callbacks.get('run-s1')!.onExit!(129)
    expect(sent[sent.length - 1]).toEqual(['win:1', 'pty-exit', 'run-s1', 129])
    expect(exits).toEqual([['run-s1', 129]])
    expect(sessions.isRunning('run-s1')).toBe(false)
    expect(sessions.loadScrollback('run-s1')).toBe('bye')
  })
})
