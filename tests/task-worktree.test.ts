import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TaskWorktreeManager } from '../src/main/task-worktree'
import { TaskLandingManager } from '../src/main/task-landing'
import { LocalGitRunner } from '../src/main/git-runner'
import { canonicalFilePath, WorkspaceManager } from '../src/main/workspace-manager'
import { MemorySetupApprovals } from '../src/main/worktree-setup-approvals'
import { WORKTREE_CONFIG_FILE } from '../src/main/worktree-setup'
import { findTaskInProject } from '../src/shared/streams'
import type { Project, ProjectsData, Stream, Task, TaskWorktreeState, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'master', dir])
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
}

function branches(repo: string): string[] {
  return git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)
}

/** main's projects store, as app-runtime hands it over. */
function memoryStore(initial: ProjectsData) {
  let data = initial
  const listeners = new Set<() => void>()
  return {
    commits: 0,
    peek: () => data,
    commit(next: ProjectsData) {
      data = next
      this.commits++
      listeners.forEach(listener => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

const tab = (id: string) => ({ id, type: 'claude-chat' as const, title: 'Claude', sessionId: `s-${id}` })

describe('TaskWorktreeManager', () => {
  let repo: string
  let streamWorkspace: WorkspaceConfig
  let approvals: MemorySetupApprovals
  let git_: WorkspaceManager
  let store: ReturnType<typeof memoryStore>
  let states: Map<string, TaskWorktreeState>
  let manager: TaskWorktreeManager

  function worktreeStream(tasks: Task[], extra: Partial<Stream> = {}): Stream {
    return { id: 'stream-s', name: 'Release', workspace: streamWorkspace, taskWorktrees: true, tasks, ...extra }
  }

  function setProjects(projects: Project[]): void {
    store = memoryStore({ projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] })
    manager = new TaskWorktreeManager({
      projects: store,
      git: git_,
      onState: (taskId, state) => {
        if (state) states.set(taskId, state)
        else states.delete(taskId)
      },
      waitMs: 300
    })
  }

  function project(tasks: Task[], extra: Partial<Project> = {}, stream: Partial<Stream> = {}): Project {
    return fixtureProject({ id: 'p1', name: 'P', directory: repo, streams: [worktreeStream(tasks, stream)], ...extra })
  }

  function taskOf(taskId: string): Task | undefined {
    return findTaskInProject(store.peek().projects[0], taskId)
  }

  function writeConfig(dir: string, config: unknown): void {
    fs.mkdirSync(path.join(dir, '.devtool'), { recursive: true })
    fs.writeFileSync(path.join(dir, WORKTREE_CONFIG_FILE), JSON.stringify(config))
  }

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'task-wt-')))
    initGitRepo(repo)
    const streamPath = path.join(repo, '.worktrees', 'release')
    git(repo, 'worktree', 'add', '-q', streamPath, '-b', 'release', 'master')
    // The stream is ahead of master: a task branches off the stream, not master.
    git(streamPath, 'commit', '-q', '--allow-empty', '-m', 'stream work')
    streamWorkspace = { worktreePath: canonicalFilePath(streamPath), branchName: 'release', baseBranch: 'master', relativeProjectPath: '' }
    approvals = new MemorySetupApprovals()
    git_ = new WorkspaceManager({ approvals })
    states = new Map()
  })

  afterEach(() => {
    try { git(repo, 'worktree', 'prune') } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('makes <stream>--<slug> off the stream branch and records it on the task', async () => {
    setProjects([project([fixtureTask({ id: 't1', name: 'Fix the login bug', tabs: { left: [tab('a')] } })])])

    const result = await manager.ensureTaskWorktree('p1', 't1')

    expect(result.status).toBe('ready')
    const workspace = taskOf('t1')?.workspace
    expect(workspace).toEqual({
      worktreePath: canonicalFilePath(path.join(repo, '.worktrees', 'release--fix-the-login-bug')),
      branchName: 'release--fix-the-login-bug',
      baseBranch: 'release',
      relativeProjectPath: ''
    })
    if (result.status === 'ready') expect(result.workspace).toEqual(workspace)
    expect(git(workspace!.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'release'))
    expect(states.size).toBe(0)
  })

  it('makes one worktree for concurrent requests', async () => {
    setProjects([project([fixtureTask({ id: 't1', name: 'Once', tabs: { left: [tab('a')] } })])])

    const [a, b, c] = await Promise.all([
      manager.ensureTaskWorktree('p1', 't1'),
      manager.ensureTaskWorktree('p1', 't1'),
      manager.ensureTaskWorktree('p1', 't1')
    ])

    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(branches(repo).filter(name => name.startsWith('release--'))).toEqual(['release--once'])
    expect(store.commits).toBe(1)
    // Asked again later: the recorded worktree, nothing new.
    expect(await manager.ensureTaskWorktree('p1', 't1')).toEqual({ status: 'ready', workspace: taskOf('t1')!.workspace })
    expect(store.commits).toBe(1)
  })

  it('appends -2 when the branch is taken', async () => {
    git(repo, 'branch', 'release--same', 'master')
    setProjects([project([fixtureTask({ id: 't1', name: 'Same', tabs: { left: [tab('a')] } })])])

    await manager.ensureTaskWorktree('p1', 't1')

    expect(taskOf('t1')?.workspace?.branchName).toBe('release--same-2')
  })

  it('names the branch after the name the window passes', async () => {
    setProjects([project([fixtureTask({ id: 't1', name: 'New Task', tabs: { left: [tab('a')] } })])])

    await manager.ensureTaskWorktree('p1', 't1', { name: 'Add dark mode' })

    expect(taskOf('t1')?.workspace?.branchName).toBe('release--add-dark-mode')
  })

  it('waits for a window\'s save that brings the task into the stream', async () => {
    setProjects([project([])])
    const pending = manager.ensureTaskWorktree('p1', 't1', { streamId: 'stream-s' })
    const before = store.peek()
    store.commit({
      ...before,
      projects: [project([fixtureTask({ id: 't1', name: 'Late', tabs: { left: [tab('a')] } })])]
    })

    expect((await pending).status).toBe('ready')
    expect(taskOf('t1')?.workspace?.branchName).toBe('release--late')
  })

  it('answers not-needed for tasks that work in their stream\'s directory', async () => {
    const shared = fixtureTask({ id: 'shared', sharesStreamWorktree: true, tabs: { left: [tab('a')] } })
    setProjects([project([shared])])
    expect(await manager.ensureTaskWorktree('p1', 'shared')).toEqual({ status: 'not-needed' })

    setProjects([fixtureProject({ id: 'p1', directory: repo, tasks: [{ id: 'in-main', tabs: { left: [tab('b')] } }] })])
    expect(await manager.ensureTaskWorktree('p1', 'in-main')).toEqual({ status: 'not-needed' })

    setProjects([project([fixtureTask({ id: 'remote' })], { ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/r' } })])
    expect(await manager.ensureTaskWorktree('p1', 'remote')).toEqual({ status: 'not-needed' })
    expect(branches(repo).filter(name => name.startsWith('release--'))).toEqual([])
  })

  it('reports a git failure, records nothing and keeps the error for Retry', async () => {
    setProjects([project([fixtureTask({ id: 't1', name: 'Broken' })], {}, {
      workspace: { ...streamWorkspace, branchName: 'no-such-branch' }
    })])

    const result = await manager.ensureTaskWorktree('p1', 't1')

    expect(result.status).toBe('failed')
    expect(taskOf('t1')?.workspace).toBeUndefined()
    expect(states.get('t1')?.phase).toBe('failed')
    manager.dismiss('t1')
    expect(states.has('t1')).toBe(false)
  })

  it('holds setup commands for approval, then runs them on a yes', async () => {
    // The task's setup comes from the stream's worktree.
    writeConfig(streamWorkspace.worktreePath, { setup: ['touch ran.txt'], symlink: ['node_modules'] })
    fs.mkdirSync(path.join(streamWorkspace.worktreePath, 'node_modules'))
    setProjects([project([fixtureTask({ id: 't1', name: 'Gated', tabs: { left: [tab('a')] } })])])

    const result = await manager.ensureTaskWorktree('p1', 't1')

    expect(result.status).toBe('needs-approval')
    if (result.status !== 'needs-approval') return
    expect(result.pending.commands).toEqual(['touch ran.txt'])
    // Recorded already, so a restart can't orphan it; links are made, commands not run.
    const workspace = taskOf('t1')!.workspace!
    expect(workspace).toEqual(result.workspace)
    expect(fs.lstatSync(path.join(workspace.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(workspace.worktreePath, 'ran.txt'))).toBe(false)
    expect(states.get('t1')).toMatchObject({ phase: 'needs-approval', branch: 'release--gated' })
    // Whoever asks meanwhile (the phone) hears the same.
    expect((await manager.ensureTaskWorktree('p1', 't1')).status).toBe('needs-approval')

    const decided = await manager.decideSetup('t1', 'run')

    expect(decided).toEqual({ status: 'ready', workspace })
    expect(fs.existsSync(path.join(workspace.worktreePath, 'ran.txt'))).toBe(true)
    expect(approvals.isApproved(result.pending.repoKey, result.pending.hash)).toBe(true)
    expect(states.has('t1')).toBe(false)
  })

  it('skips held commands this once', async () => {
    writeConfig(streamWorkspace.worktreePath, { setup: ['touch ran.txt'] })
    setProjects([project([fixtureTask({ id: 't1', name: 'Skip', tabs: { left: [tab('a')] } })])])
    const result = await manager.ensureTaskWorktree('p1', 't1')
    if (result.status !== 'needs-approval') throw new Error(`expected needs-approval, got ${result.status}`)

    expect(await manager.decideSetup('t1', 'skip')).toEqual({ status: 'ready', workspace: result.workspace })
    expect(fs.existsSync(path.join(result.workspace.worktreePath, 'ran.txt'))).toBe(false)
    expect(approvals.isApproved(result.pending.repoKey, result.pending.hash)).toBe(false)
    expect(states.has('t1')).toBe(false)
  })

  it('keeps the worktree when a setup command fails, with the error to show', async () => {
    writeConfig(streamWorkspace.worktreePath, { setup: ['echo nope >&2; exit 3'] })
    setProjects([project([fixtureTask({ id: 't1', name: 'Fails', tabs: { left: [tab('a')] } })])])
    const held = await manager.ensureTaskWorktree('p1', 't1')
    if (held.status !== 'needs-approval') throw new Error(`expected needs-approval, got ${held.status}`)

    const result = await manager.decideSetup('t1', 'run')

    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.setupError).toContain('exited with code 3')
    expect(taskOf('t1')?.workspace).toBeDefined()
    expect(states.get('t1')).toMatchObject({ phase: 'setup-failed', branch: 'release--fails' })
    manager.dismiss('t1')
    expect(states.has('t1')).toBe(false)
  })

  it('puts a subfolder project\'s task at the repo\'s .worktrees with the same relative path', async () => {
    const sub = path.join(repo, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'index.txt'), 'x')
    git(repo, 'add', 'apps')
    git(repo, 'commit', '-q', '-m', 'web')
    git(streamWorkspace.worktreePath, 'merge', '-q', '--no-edit', 'master')
    setProjects([project(
      [fixtureTask({ id: 't1', name: 'Web', tabs: { left: [tab('a')] } })],
      { directory: sub },
      { workspace: { ...streamWorkspace, relativeProjectPath: 'apps/web' } }
    )])

    await manager.ensureTaskWorktree('p1', 't1')

    const workspace = taskOf('t1')!.workspace!
    expect(workspace.worktreePath).toBe(canonicalFilePath(path.join(repo, '.worktrees', 'release--web')))
    expect(workspace.relativeProjectPath).toBe('apps/web')
    expect(fs.existsSync(path.join(workspace.worktreePath, 'apps', 'web', 'index.txt'))).toBe(true)
  })

  describe('a reopened task with its worktree recorded', () => {
    /** Closes the task the way a closing stream's Keep branches / Discard all does. */
    async function closeForStream(mode: 'keep' | 'discard'): Promise<void> {
      const landing = new TaskLandingManager({
        projects: store,
        runner: new LocalGitRunner(),
        git: git_,
        activity: { getStatus: () => null, subscribe: () => () => {} }
      })
      expect(await landing.closeWorktree('p1', 't1', mode, { archive: false })).toEqual({ status: 'removed' })
    }

    it('gets it back on the kept branch, with its commits, and setup runs again once approved', async () => {
      writeConfig(streamWorkspace.worktreePath, { setup: ['touch ran.txt'], symlink: ['node_modules'] })
      fs.mkdirSync(path.join(streamWorkspace.worktreePath, 'node_modules'))
      setProjects([project([fixtureTask({ id: 't1', name: 'Keep me', tabs: { left: [tab('a')] } })])])
      const made = await manager.ensureTaskWorktree('p1', 't1')
      if (made.status !== 'needs-approval') throw new Error(`expected needs-approval, got ${made.status}`)
      await manager.decideSetup('t1', 'skip')
      const recorded = made.workspace
      fs.writeFileSync(path.join(recorded.worktreePath, 'work.txt'), 'committed\n')
      git(recorded.worktreePath, 'add', 'work.txt')
      git(recorded.worktreePath, 'commit', '-q', '-m', 'Work')
      fs.writeFileSync(path.join(recorded.worktreePath, 'draft.txt'), 'uncommitted\n')

      await closeForStream('keep')
      expect(fs.existsSync(recorded.worktreePath)).toBe(false)
      expect(taskOf('t1')?.workspace).toEqual(recorded)

      // Reopened: the gate (or the reopen itself) asks for it.
      const restored = await manager.ensureTaskWorktree('p1', 't1')

      expect(restored).toMatchObject({ status: 'needs-approval', workspace: recorded })
      if (restored.status !== 'needs-approval') return
      expect(git(recorded.worktreePath, 'branch', '--show-current').trim()).toBe('release--keep-me')
      expect(fs.readFileSync(path.join(recorded.worktreePath, 'work.txt'), 'utf8')).toBe('committed\n')
      // Keep branch committed the draft too.
      expect(fs.readFileSync(path.join(recorded.worktreePath, 'draft.txt'), 'utf8')).toBe('uncommitted\n')
      expect(fs.lstatSync(path.join(recorded.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true)
      expect(states.get('t1')).toMatchObject({ phase: 'needs-approval', branch: 'release--keep-me' })

      expect(await manager.decideSetup('t1', 'run')).toEqual({ status: 'ready', workspace: recorded })
      expect(fs.existsSync(path.join(recorded.worktreePath, 'ran.txt'))).toBe(true)
      expect(branches(repo).filter(branch => branch.startsWith('release--'))).toEqual(['release--keep-me'])
    })

    it('gets a fresh worktree off the stream when its branch is gone', async () => {
      setProjects([project([fixtureTask({ id: 't1', name: 'Gone', tabs: { left: [tab('a')] } })])])
      const made = await manager.ensureTaskWorktree('p1', 't1')
      if (made.status !== 'ready') throw new Error(`expected ready, got ${made.status}`)
      fs.writeFileSync(path.join(made.workspace.worktreePath, 'lost.txt'), 'x\n')
      await closeForStream('discard')
      expect(branches(repo)).not.toContain('release--gone')
      expect(taskOf('t1')?.workspace).toEqual(made.workspace)

      const fresh = await manager.ensureTaskWorktree('p1', 't1')

      expect(fresh.status).toBe('ready')
      const workspace = taskOf('t1')!.workspace!
      expect(workspace.branchName).toBe('release--gone')
      expect(fs.existsSync(path.join(workspace.worktreePath, 'lost.txt'))).toBe(false)
      expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'release'))
      expect(states.has('t1')).toBe(false)
    })

    it('is not restored while a landing closes the task (a phone\'s chat op in between)', async () => {
      setProjects([project([fixtureTask({ id: 't1', name: 'Closing', tabs: { left: [tab('a')] } })])])
      let landing: TaskLandingManager | null = null
      const guarded = new TaskWorktreeManager({ projects: store, git: git_, waitMs: 300, isLanding: (taskId) => landing?.isBusy(taskId) ?? false })
      const made = await guarded.ensureTaskWorktree('p1', 't1')
      if (made.status !== 'ready') throw new Error(`expected ready, got ${made.status}`)
      fs.writeFileSync(path.join(made.workspace.worktreePath, 'work.txt'), 'x\n')
      let between: unknown = null
      landing = new TaskLandingManager({
        projects: store,
        runner: new LocalGitRunner(),
        git: git_,
        activity: { getStatus: () => null, subscribe: () => () => {} },
        // The worktree is gone and the task not archived yet: something asks for it.
        archiveTask: async () => { between = await guarded.ensureTaskWorktree('p1', 't1') }
      })

      expect(await landing.landTask('p1', 't1')).toEqual({ status: 'landed' })

      expect(between).toEqual({ status: 'failed', error: 'The task is being closed' })
      expect(branches(repo).filter(branch => branch.startsWith('release--'))).toEqual([])
      expect(fs.existsSync(made.workspace.worktreePath)).toBe(false)
    })

    it('leaves a worktree that is still there alone', async () => {
      setProjects([project([fixtureTask({ id: 't1', name: 'Here', tabs: { left: [tab('a')] } })])])
      const made = await manager.ensureTaskWorktree('p1', 't1')
      const commits = store.commits

      expect(await manager.ensureTaskWorktree('p1', 't1')).toEqual(made)
      expect(store.commits).toBe(commits)
    })
  })

  it('runs a new stream\'s held setup once approved', async () => {
    writeConfig(repo, { setup: ['touch stream-ran.txt'] })
    setProjects([project([])])
    const created = await git_.create(repo, 'next', 'master')
    if (created.setup.status !== 'needs-approval') throw new Error(`expected needs-approval, got ${created.setup.status}`)
    const before = store.peek()
    store.commit({
      ...before,
      projects: [{
        ...before.projects[0],
        streams: [...before.projects[0].streams, {
          id: 'stream-next',
          name: 'next',
          workspace: { worktreePath: created.worktreePath, branchName: 'next', baseBranch: 'master', relativeProjectPath: '' },
          taskWorktrees: true,
          tasks: []
        }]
      }]
    })

    expect(await manager.runStreamSetup('p1', 'stream-next', created.setup.pending)).toEqual({ status: 'ok' })
    expect(fs.existsSync(path.join(created.worktreePath, 'stream-ran.txt'))).toBe(true)
  })
})
