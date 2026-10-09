import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RelayServer } from '../relay/src/server.ts'
import { DesktopRouting } from '../src/main/servers/desktop-routing'
import type { IpcContext, IpcRegistrar } from '../src/main/ipc/registrar'
import { SETUP_APPROVALS_FILE } from '../src/main/worktree-setup-approvals'
import { findTaskInProject } from '../src/shared/streams'
import type {
  Project,
  ProjectsData,
  Stream,
  Task,
  TaskLandingPreview,
  TaskLandingResult,
  TaskWorktreeResult,
  WorkspaceConfig,
  WorkspaceCreateResult
} from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

/**
 * Plan step 8 end to end: a DevTool server's project gets a stream with a
 * worktree, task worktrees with the repo's setup (approved from the desktop,
 * stored and run on the server), and lands them, all through the desktop's
 * real router (DesktopRouting), its ServerHub, a real relay on an ephemeral
 * port and the server's host. Every call below is what a window's preload
 * sends; none may run on the desktop.
 */

type Handler = (ctx: IpcContext, ...args: unknown[]) => unknown

const PROJECT_ID = 'srv-landing'
const STREAM_ID = 'stream-rel'
const win: IpcContext = { clientId: 'win:1', isFocused: () => true }

const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/** A commit of just `file`: worktrees here hold setup's untracked marker, which no one commits. */
function commitFile(dir: string, file: string, message: string): void {
  git(dir, 'add', '--', file)
  git(dir, 'commit', '-q', '-m', message, '--', file)
}

function rebaseInProgress(worktree: string): boolean {
  const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir').trim()
  return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))
}

describe.skipIf(process.platform === 'win32')('streams, task worktrees and landing on a server project (real relay)', () => {
  let relay: RelayServer
  let server: TestServer
  let desktop: TestDesktop
  let routing: DesktopRouting
  const handlers = new Map<string, Handler>()
  const broadcast: unknown[][] = []
  let root: string
  let repo: string
  let streamWs: WorkspaceConfig

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(handler(win, ...args))
  }

  /** The server's project as the windows see it now. */
  const project = (): Project => {
    const found = routing.projects.sources()[server.id]?.data.projects.find(p => p.id === PROJECT_ID)
    if (!found) throw new Error('the server project is not here')
    return found
  }

  /** The server's own copy of its data (no `host`). */
  const serverData = (): ProjectsData => server.server.host.getProjectsData()

  const serverTask = (taskId: string): Task | undefined => findTaskInProject(serverData().projects.find(p => p.id === PROJECT_ID), taskId)

  /** A window's save of the server's slice, as the per-source sync makes it. */
  const saveProject = async (change: (p: Project) => Project): Promise<void> => {
    const { revision } = routing.projects.sources()[server.id]
    const next = change(project())
    const saved = await invoke('save-projects', server.id, { baseRevision: revision, data: { projects: [next], tags: [], projectOrder: [PROJECT_ID], pinnedItems: [] } }) as { ok: boolean; revision: number }
    expect(saved.ok).toBe(true)
    await waitFor(() => routing.projects.sources()[server.id].revision >= saved.revision, 'the server\'s save to come back')
  }

  const addTask = async (id: string, name: string): Promise<void> => {
    await saveProject(p => ({
      ...p,
      streams: p.streams.map(s => (s.id === STREAM_ID ? { ...s, tasks: [...s.tasks, { id, name, panes: [] }] } : s))
    }))
  }

  /** A task's own worktree, made on the server as its first tab would ask for it; setup already approved. */
  const makeTaskWorktree = async (id: string, name: string): Promise<WorkspaceConfig> => {
    await addTask(id, name)
    const made = await invoke('task-worktree-ensure', PROJECT_ID, id, { name, streamId: STREAM_ID }) as TaskWorktreeResult
    expect(made.status).toBe('ready')
    if (made.status !== 'ready') throw new Error('no worktree')
    return made.workspace
  }

  const pushes = (channel: string, taskId: string): unknown[] => broadcast.filter(b => b[0] === channel && b[1] === taskId).map(b => b[2])

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-step8-')))
    repo = path.join(root, 'app')
    git(root, 'init', '-q', '-b', 'main', repo)
    // Landing commits as the server's git user, as any shell there would.
    git(repo, 'config', 'user.name', 'Server User')
    git(repo, 'config', 'user.email', 'server@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    write(repo, 'a.txt', 'one\n')
    write(repo, 'b.txt', 'two\n')
    write(repo, '.gitignore', '.worktrees/\nnode_modules/\n')
    write(repo, '.devtool/worktree.json', JSON.stringify({ symlink: ['node_modules'], setup: ['echo "$DEVTOOL_BRANCH" > setup-marker.txt'] }))
    commitAll(repo, 'init')
    write(repo, 'node_modules/dep/index.js', 'module.exports = 1\n')

    ;({ relay } = await startTestRelay())
    server = await startTestServer(relay.url)
    desktop = startTestDesktop(relay.url)
    await pairByCode(desktop, server)

    routing = new DesktopRouting({
      configDir: desktop.dir,
      windows: {
        send: () => {},
        broadcast: (channel, ...args) => { broadcast.push([channel, ...args]) }
      },
      log: () => {}
    })
    const local: ProjectsData = { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    routing.attachHost({ getProjectsData: () => local, onProjectsChanged: () => () => {} })
    const inner: IpcRegistrar = {
      handle: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
      on: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
      onSync: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) }
    }
    const wrapped = routing.wrap(inner)
    for (const channel of [
      'save-projects', 'archive-load', 'workspace-list-branches', 'workspace-create', 'workspace-delete', 'workspace-restore',
      'task-worktree-ensure', 'task-worktree-decide', 'task-worktree-dismiss', 'stream-worktree-setup-run',
      'task-land', 'task-landing-retry', 'task-landing-abort', 'task-landing-fix', 'task-update-from-stream', 'task-stream-ahead',
      'task-landing-preview', 'task-worktree-close'
    ]) {
      wrapped.handle(channel, [], (() => { throw new Error(`${channel} ran on the desktop`) }) as never)
    }
    // Every host's states, merged: this desktop has none.
    wrapped.handle('task-worktree-states', [], (() => ({})) as never)
    routing.attachHub(desktop.hub)
    desktop.hub.onEvent(() => {})

    await waitFor(() => routing.projects.sources()[server.id] !== undefined, 'the server\'s projects')
    const { revision } = routing.projects.sources()[server.id]
    const added = { ...fixtureProject({ id: PROJECT_ID, name: 'App', directory: repo }), host: server.id }
    const saved = await invoke('save-projects', server.id, { baseRevision: revision, data: { projects: [added], tags: [], projectOrder: [PROJECT_ID], pinnedItems: [] } }) as { ok: boolean }
    expect(saved.ok).toBe(true)
    await waitFor(() => routing.isServerProject(PROJECT_ID), 'the project routed to the server')
  }, 60_000)

  afterAll(async () => {
    desktop?.close()
    await server?.close()
    await relay?.close()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('makes a stream\'s worktree on the server and leaves its setup commands to the user', async () => {
    expect(await invoke('workspace-list-branches', { projectDir: repo, projectId: PROJECT_ID })).toEqual(['main'])
    const created = await invoke('workspace-create', { projectDir: repo, projectId: PROJECT_ID, name: 'rel', baseBranch: 'main' }) as WorkspaceCreateResult
    expect(created.branchName).toBe('rel')
    expect(created.setupPending?.commands).toEqual(['echo "$DEVTOOL_BRANCH" > setup-marker.txt'])
    streamWs = { worktreePath: created.worktreePath, branchName: created.branchName, baseBranch: 'main', relativeProjectPath: created.relativeProjectPath }
    // Links ran (nothing to approve there); the command waits.
    expect(fs.lstatSync(path.join(streamWs.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(streamWs.worktreePath, 'setup-marker.txt'))).toBe(false)

    // The window adds the stream, born marked for task worktrees.
    const stream: Stream = { id: STREAM_ID, name: 'rel', workspace: streamWs, taskWorktrees: true, tasks: [] }
    await saveProject(p => ({ ...p, streams: [...p.streams, stream] }))
    expect(serverData().projects[0].streams.find(s => s.id === STREAM_ID)?.workspace?.branchName).toBe('rel')
  }, 30_000)

  it('asks the desktop to approve a task\'s setup, stores the approval on the server, and runs it only then', async () => {
    await addTask('t-approve', 'Approve setup')
    const made = await invoke('task-worktree-ensure', PROJECT_ID, 't-approve', { name: 'Approve setup', streamId: STREAM_ID }) as TaskWorktreeResult
    expect(made.status).toBe('needs-approval')
    if (made.status !== 'needs-approval') throw new Error('no prompt')
    const worktree = made.workspace.worktreePath
    expect(made.workspace.branchName).toBe('rel--approve-setup')
    expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(worktree, 'setup-marker.txt'))).toBe(false)

    // The prompt reached the windows through the link, for the server's own task.
    await waitFor(() => pushes('task-worktree-state', 't-approve').some(s => (s as { phase?: string })?.phase === 'needs-approval'), 'the approval prompt')
    const merged = await invoke('task-worktree-states') as Record<string, { phase: string; pending?: { commands: string[] } }>
    expect(merged['t-approve']).toMatchObject({ phase: 'needs-approval', pending: { commands: ['echo "$DEVTOOL_BRANCH" > setup-marker.txt'] } })

    // Desktop main is not a window: the server won't take a yes from it.
    await expect(desktop.hub.call(server.id, 'main', 'task-worktree-decide', ['t-approve', 'run'])).rejects.toThrow(/approved from a DevTool window/)
    expect(fs.existsSync(path.join(worktree, 'setup-marker.txt'))).toBe(false)

    // The window's Run setup.
    const decided = await invoke('task-worktree-decide', 't-approve', 'run') as TaskWorktreeResult
    expect(decided.status).toBe('ready')
    expect(fs.readFileSync(path.join(worktree, 'setup-marker.txt'), 'utf8')).toBe('rel--approve-setup\n')
    await waitFor(() => pushes('task-worktree-state', 't-approve').at(-1) === null, 'the prompt cleared')

    // Stored where the commands run, never on the desktop.
    const approvals = JSON.parse(fs.readFileSync(path.join(server.server.env.configDir, SETUP_APPROVALS_FILE), 'utf8')) as { repos: Record<string, string[]> }
    expect(made.pending.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(approvals.repos[made.pending.repoKey]).toEqual([made.pending.hash])
    expect(fs.existsSync(path.join(desktop.dir, SETUP_APPROVALS_FILE))).toBe(false)

    // The stream's own setup runs from the New stream dialog's answer, approved already.
    expect(await invoke('stream-worktree-setup-run', PROJECT_ID, STREAM_ID, made.pending)).toEqual({ status: 'ok' })
    expect(fs.readFileSync(path.join(streamWs.worktreePath, 'setup-marker.txt'), 'utf8')).toBe('rel\n')
    await expect(desktop.hub.call(server.id, 'main', 'stream-worktree-setup-run', [PROJECT_ID, STREAM_ID, made.pending])).rejects.toThrow(/approved from a DevTool window/)

    // Nothing to land: closing just removes it (setup's marker is not the task's work).
    expect(await invoke('task-landing-preview', PROJECT_ID, 't-approve')).toEqual({ commits: 0, uncommitted: 0 })
    expect(await invoke('task-land', PROJECT_ID, 't-approve')).toEqual({ status: 'nothing' })
    expect(fs.existsSync(worktree)).toBe(false)
  }, 30_000)

  it('lands two tasks that edit different files as two squash commits, and removes their worktrees', async () => {
    const a = await makeTaskWorktree('t-a', 'Edit a')
    const b = await makeTaskWorktree('t-b', 'Edit b')
    write(a.worktreePath, 'a.txt', 'one, from task a\n')
    commitFile(a.worktreePath, 'a.txt', 'Change a')
    write(a.worktreePath, 'c.txt', 'new file\n')
    write(b.worktreePath, 'b.txt', 'two, from task b\n')

    expect(await invoke('task-landing-preview', PROJECT_ID, 't-a')).toEqual({ commits: 1, uncommitted: 1 } satisfies TaskLandingPreview)
    expect(await invoke('task-land', PROJECT_ID, 't-a')).toEqual({ status: 'landed' })
    // The stream moved: task b's "+N".
    expect(await invoke('task-stream-ahead', PROJECT_ID, 't-b')).toBe(1)
    expect(await invoke('task-land', PROJECT_ID, 't-b')).toEqual({ status: 'landed' })

    expect(git(repo, 'log', '--format=%s', 'main..rel').trim().split('\n')).toEqual(['Edit b', 'Edit a'])
    expect(git(repo, 'log', '-1', '--format=%b', 'rel~1').trim()).toBe('- Change a')
    expect(fs.readFileSync(path.join(streamWs.worktreePath, 'c.txt'), 'utf8')).toBe('new file\n')
    // Clean, but for the stream's own setup marker.
    expect(git(streamWs.worktreePath, 'status', '--porcelain')).toBe('?? setup-marker.txt\n')
    for (const ws of [a, b]) expect(fs.existsSync(ws.worktreePath)).toBe(false)
    expect(git(repo, 'branch', '--format=%(refname:short)')).not.toMatch(/rel--edit-/)

    // Archived by the server; the windows hear the landing state clear even after the task left the data.
    expect(serverTask('t-a')).toBeUndefined()
    await waitFor(() => !project().streams.some(s => s.tasks.some(t => t.id === 't-a' || t.id === 't-b')), 'the tasks gone from the window\'s copy')
    const archive = await invoke('archive-load', PROJECT_ID) as { tasks: Array<{ task: { id: string } }> }
    expect(archive.tasks.map(e => e.task.id)).toEqual(expect.arrayContaining(['t-a', 't-b']))
    await waitFor(() => pushes('task-landing-state', 't-b').at(-1) === null, 'task b\'s landing cleared')
  }, 60_000)

  it('stops on a conflict, aborts it, then lands once the user fixed it', async () => {
    const c = await makeTaskWorktree('t-c', 'Edit the same line')
    write(c.worktreePath, 'a.txt', 'one, from task c\n')
    // Someone landed a change to the same line meanwhile.
    write(streamWs.worktreePath, 'a.txt', 'one, from the stream\n')
    commitFile(streamWs.worktreePath, 'a.txt', 'Stream edits a')

    const first = await invoke('task-land', PROJECT_ID, 't-c') as TaskLandingResult
    expect(first).toEqual({ status: 'conflict', files: ['a.txt'] })
    expect(serverTask('t-c')?.landing).toEqual({ state: 'conflict', intent: 'close', files: ['a.txt'] })
    await waitFor(() => (project().streams.flatMap(s => s.tasks).find(t => t.id === 't-c')?.landing?.state) === 'conflict', 'the conflict in the window\'s copy')
    expect(pushes('task-landing-state', 't-c').at(-1)).toEqual({ state: 'conflict', intent: 'close', files: ['a.txt'] })
    // The task's agent would be asked, but it has none.
    expect(await invoke('task-landing-fix', PROJECT_ID, 't-c')).toEqual({ status: 'failed', error: 'This task has no agent tab to ask' })

    expect(await invoke('task-landing-abort', PROJECT_ID, 't-c')).toEqual({ status: 'aborted' })
    expect(rebaseInProgress(c.worktreePath)).toBe(false)
    expect(serverTask('t-c')?.landing).toBeUndefined()
    expect(fs.existsSync(c.worktreePath)).toBe(true)

    // Again, and this time "I'll fix it": resolved and staged in the task's worktree on the server.
    expect(await invoke('task-land', PROJECT_ID, 't-c')).toEqual({ status: 'conflict', files: ['a.txt'] })
    expect(rebaseInProgress(c.worktreePath)).toBe(true)
    write(c.worktreePath, 'a.txt', 'one, from the stream and task c\n')
    git(c.worktreePath, 'add', 'a.txt')
    expect(await invoke('task-landing-retry', PROJECT_ID, 't-c')).toEqual({ status: 'landed' })
    expect(git(repo, 'log', '-1', '--format=%s', 'rel').trim()).toBe('Edit the same line')
    expect(fs.readFileSync(path.join(streamWs.worktreePath, 'a.txt'), 'utf8')).toBe('one, from the stream and task c\n')
    expect(fs.existsSync(c.worktreePath)).toBe(false)
    expect(serverTask('t-c')).toBeUndefined()
  }, 60_000)

  it('blocks on a dirty stream worktree until it is clean, and updates a task from its stream', async () => {
    const d = await makeTaskWorktree('t-d', 'Edit b again')
    write(d.worktreePath, 'b.txt', 'two, from task d\n')
    write(streamWs.worktreePath, 'b.txt', 'two, uncommitted in the stream\n')

    const blocked = await invoke('task-land', PROJECT_ID, 't-d') as TaskLandingResult
    expect(blocked).toMatchObject({ status: 'blocked', files: ['b.txt'] })
    expect(serverTask('t-d')?.landing).toMatchObject({ state: 'blocked', intent: 'close', files: ['b.txt'] })
    expect(await invoke('task-landing-retry', PROJECT_ID, 't-d')).toMatchObject({ status: 'blocked' })

    git(streamWs.worktreePath, 'checkout', '--', 'b.txt')
    expect(await invoke('task-landing-retry', PROJECT_ID, 't-d')).toEqual({ status: 'landed' })
    expect(fs.readFileSync(path.join(streamWs.worktreePath, 'b.txt'), 'utf8')).toBe('two, from task d\n')

    // Update from stream: the task takes the stream's new commit without landing.
    const e = await makeTaskWorktree('t-e', 'Keep working')
    write(streamWs.worktreePath, 'd.txt', 'from the stream\n')
    commitFile(streamWs.worktreePath, 'd.txt', 'Stream adds d')
    expect(await invoke('task-stream-ahead', PROJECT_ID, 't-e')).toBe(1)
    expect(await invoke('task-update-from-stream', PROJECT_ID, 't-e')).toEqual({ status: 'updated' })
    expect(await invoke('task-stream-ahead', PROJECT_ID, 't-e')).toBe(0)
    expect(fs.existsSync(path.join(e.worktreePath, 'd.txt'))).toBe(true)

    // Keep branch: the worktree goes, the branch stays for a reopen.
    write(e.worktreePath, 'e.txt', 'draft\n')
    expect(await invoke('task-worktree-close', PROJECT_ID, 't-e', 'keep')).toEqual({ status: 'removed' })
    expect(fs.existsSync(e.worktreePath)).toBe(false)
    expect(git(repo, 'branch', '--format=%(refname:short)')).toContain('rel--keep-working')
  }, 60_000)
})
