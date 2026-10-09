import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RelayServer } from '../relay/src/server.ts'
import { DesktopRouting } from '../src/main/servers/desktop-routing'
import type { IpcContext, IpcRegistrar } from '../src/main/ipc/registrar'
import type { DecodedImage, ImageCodec } from '../src/main/mobile/chat-image'
import type { ChatEvent } from '../src/shared/claude-chat'
import type { CommitHistoryResult, GitOperationResult, GitPostureResult, GitStatusResult, ProjectsData } from '../src/shared/types'
import type { PermissionSettingsSource } from '../src/shared/chat-permissions'
import { fixtureProject } from './helpers/streams-fixtures'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

/**
 * Step 7 end to end: a server project's files, Git panel, chat and conda
 * through the desktop's real router (DesktopRouting: ServerProjects, RouteIndex,
 * HostRouter), its ServerHub, a real relay on an ephemeral port and the server's
 * host. Every call below is what a window's preload sends; none may run here.
 */

type Handler = (ctx: IpcContext, ...args: unknown[]) => unknown

const PROJECT_ID = 'srv-workspace'
const ctx: IpcContext = { clientId: 'win:1', isFocused: () => true }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
  })
}

/** Decodes anything as a 4000x3000 image whose re-encodings are small. */
const bigImageCodec: ImageCodec = {
  decode: () => {
    const image = (width: number, height: number): DecodedImage => ({
      width,
      height,
      resize: (w, h) => image(w, h),
      png: () => Buffer.alloc(Math.min(200_000, width * height), 1),
      jpeg: () => Buffer.alloc(50_000, 2)
    })
    return image(4000, 3000)
  }
}

describe.skipIf(process.platform === 'win32')('a server project through the desktop\'s router (real relay)', () => {
  let relay: RelayServer
  let server: TestServer
  let desktop: TestDesktop
  let routing: DesktopRouting
  const handlers = new Map<string, Handler>()
  const sent: unknown[][] = []
  const broadcast: unknown[][] = []
  let root: string
  let repo: string
  let remote: string

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(handler(ctx, ...args))
  }

  const chatEvents = (tabId: string): ChatEvent[] => sent
    .filter(([clientId, ch, id]) => clientId === 'win:1' && ch === 'chat-event' && id === tabId)
    .map(entry => entry[4] as ChatEvent)

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-step7-')))
    remote = path.join(root, 'remote.git')
    repo = path.join(root, 'app')
    git(root, 'init', '--bare', '-b', 'main', remote)
    git(root, 'init', '-b', 'main', repo)
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'first')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    // The Git panel commits as the server's git user, as any shell there would.
    git(repo, 'config', 'user.name', 'Server User')
    git(repo, 'config', 'user.email', 'server@example.com')

    ;({ relay } = await startTestRelay())
    server = await startTestServer(relay.url)
    desktop = startTestDesktop(relay.url)
    await pairByCode(desktop, server)

    routing = new DesktopRouting({
      configDir: desktop.dir,
      windows: {
        send: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
        broadcast: (channel, ...args) => { broadcast.push([channel, ...args]) }
      },
      log: () => {},
      images: bigImageCodec
    })
    const local: ProjectsData = { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    routing.attachHost({ getProjectsData: () => local, onProjectsChanged: () => () => {} })
    const inner: IpcRegistrar = {
      handle: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
      on: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
      onSync: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) }
    }
    const wrapped = routing.wrap(inner)
    const channels = [
      'save-projects', 'fb-read-directory', 'fb-read-file', 'fb-write-file', 'fb-create-file', 'fb-create-directory', 'fb-rename', 'fb-delete',
      'fb-git-status', 'fb-git-diff', 'fb-git-stage', 'fb-git-unstage', 'fb-git-discard', 'fb-git-commit', 'fb-git-push', 'fb-git-pull',
      'git-project-posture', 'git-commit-history', 'conda-list-envs',
      'chat-attach', 'chat-send', 'chat-login', 'chat-login-dismiss', 'chat-list-files', 'chat-permissions-read', 'chat-permissions-update'
    ]
    for (const channel of channels) {
      wrapped.handle(channel, [], (() => { throw new Error(`${channel} ran on the desktop`) }) as never)
    }
    wrapped.on('chat-close', [], (() => { throw new Error('chat-close ran on the desktop') }) as never)
    routing.attachHub(desktop.hub)
    desktop.hub.onEvent(() => {})

    // A window adds the project to the server, through the desktop's save path.
    await waitFor(() => routing.projects.sources()[server.id] !== undefined, 'the server\'s projects')
    const { revision } = routing.projects.sources()[server.id]
    const project = { ...fixtureProject({ id: PROJECT_ID, name: 'App', directory: repo }), host: server.id, condaEnvName: 'ml', condaEnvPrefix: '/opt/conda/envs/ml' }
    const saved = await invoke('save-projects', server.id, { baseRevision: revision, data: { projects: [project], tags: [], projectOrder: [PROJECT_ID], pinnedItems: [] } }) as { ok: boolean }
    expect(saved.ok).toBe(true)
    await waitFor(() => routing.isServerProject(PROJECT_ID), 'the project routed to the server')
  }, 60_000)

  afterAll(async () => {
    desktop?.close()
    await server?.close()
    await relay?.close()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps the project\'s conda env on the server, where its spawns read it', async () => {
    const { local } = await desktop.hub.call(server.id, 'win:1', 'load-projects') as { local: { data: ProjectsData } }
    expect(local.data.projects.find(p => p.id === PROJECT_ID)).toMatchObject({ directory: repo, condaEnvName: 'ml', condaEnvPrefix: '/opt/conda/envs/ml' })
    expect(local.data.projects.find(p => p.id === PROJECT_ID)).not.toHaveProperty('host')
    expect(await invoke('conda-list-envs', PROJECT_ID)).toHaveProperty('envs')
  })

  it('browses, edits, creates, renames and deletes the server\'s files', async () => {
    const entries = await invoke('fb-read-directory', repo, '', PROJECT_ID) as Array<{ name: string }>
    expect(entries.map(e => e.name)).toContain('README.md')
    expect(await invoke('fb-read-file', repo, 'README.md', PROJECT_ID)).toBe('hello\n')

    await invoke('fb-write-file', repo, 'README.md', 'hello from the editor\n', PROJECT_ID)
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('hello from the editor\n')

    await invoke('fb-create-directory', repo, '', 'docs', PROJECT_ID)
    await invoke('fb-create-file', repo, 'docs', 'notes.md', PROJECT_ID)
    await invoke('fb-rename', repo, 'docs/notes.md', 'todo.md', PROJECT_ID)
    expect(fs.existsSync(path.join(repo, 'docs/todo.md'))).toBe(true)
    await invoke('fb-create-file', repo, '', 'scratch.txt', PROJECT_ID)
    await invoke('fb-delete', repo, 'scratch.txt', PROJECT_ID)
    expect(fs.existsSync(path.join(repo, 'scratch.txt'))).toBe(false)

    // The server's own folder check still applies to a routed call.
    await expect(invoke('fb-read-file', repo, '../remote.git/HEAD', PROJECT_ID)).rejects.toThrow()
    await expect(invoke('fb-read-directory', root, '', PROJECT_ID)).rejects.toThrow(/not a known project/)
  })

  it('shows the change in the Git panel, stages, commits and pushes to the remote', async () => {
    const status = await invoke('fb-git-status', repo, PROJECT_ID) as GitStatusResult
    const rootRepo = status.repos.find(r => r.path === '')!
    expect(rootRepo.unstaged.map(e => e.relativePath)).toContain('README.md')
    // git lists a new folder as one entry.
    expect(rootRepo.untracked.map(e => e.relativePath)).toContain('docs/')

    // The diff tab gets HEAD's copy here and the file's own from fb-read-file.
    expect(await invoke('fb-git-diff', repo, 'README.md', PROJECT_ID)).toBe('hello\n')

    expect(await invoke('fb-git-stage', repo, '', ['README.md', 'docs/todo.md'], PROJECT_ID)).toMatchObject({ success: true })
    expect(await invoke('fb-git-unstage', repo, '', ['docs/todo.md'], PROJECT_ID)).toMatchObject({ success: true })
    const staged = (await invoke('fb-git-status', repo, PROJECT_ID) as GitStatusResult).repos.find(r => r.path === '')!
    expect(staged.staged.map(e => e.relativePath)).toEqual(['README.md'])

    const commit = await invoke('fb-git-commit', repo, '', 'Edit the readme on the server', PROJECT_ID) as GitOperationResult
    expect(commit).toMatchObject({ success: true })
    const posture = await invoke('git-project-posture', repo, PROJECT_ID) as GitPostureResult
    expect(posture).toMatchObject({ isGitRepo: true, branch: 'main', ahead: 1, behind: 0 })
    expect(posture.lastCommit?.subject).toBe('Edit the readme on the server')

    expect(await invoke('fb-git-push', repo, '', PROJECT_ID)).toMatchObject({ success: true })
    expect(git(root, '--git-dir', remote, 'log', '-1', '--format=%s').trim()).toBe('Edit the readme on the server')
    expect(await invoke('git-project-posture', repo, PROJECT_ID)).toMatchObject({ ahead: 0 })
    expect(await invoke('fb-git-pull', repo, '', PROJECT_ID)).toMatchObject({ success: true })
    expect((await invoke('git-commit-history', repo, PROJECT_ID) as CommitHistoryResult).commits).toHaveLength(2)

    fs.writeFileSync(path.join(repo, 'README.md'), 'oops\n')
    expect(await invoke('fb-git-discard', repo, '', ['README.md'], PROJECT_ID)).toMatchObject({ success: true })
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('hello from the editor\n')
  })

  it('runs a chat on the server\'s claude, with images scaled to fit the link, /permissions and the pasted-code /login', async () => {
    await desktop.hub.call(server.id, 'win:1', 'save-config', [{ claudeCommand: path.resolve('tests/helpers/fake-claude.mjs') }])
    const tabId = 'srv-chat-tab'
    const snapshot = await invoke('chat-attach', tabId, { cwd: repo, sessionId: randomUUID(), projectId: PROJECT_ID }) as { seq: number }
    expect(snapshot.seq).toBeGreaterThanOrEqual(0)
    expect(routing.index.pinnedHost(tabId)).toBe(server.id)

    // A 5 MB screenshot doesn't fit one link message as it is; the desktop scales it first.
    const huge = { mediaType: 'image/png', data: Buffer.alloc(4_000_000, 7).toString('base64') }
    await expect(desktop.hub.call(server.id, 'win:1', 'chat-send', [tabId, 'too big', [huge]])).rejects.toThrow()
    await invoke('chat-send', tabId, 'ping through the router', [huge])
    await waitFor(() => chatEvents(tabId).some(e => e.t === 'sent' && e.images === 1), 'the sent message with its image', 20_000)
    await waitFor(() => chatEvents(tabId).some(e => e.t === 'sdk' && JSON.stringify(e.m).includes('echo: ping through the router')), 'the reply', 20_000)

    expect(await invoke('chat-list-files', repo, PROJECT_ID)).toEqual(expect.arrayContaining(['README.md']))

    await invoke('chat-permissions-update', repo, 'localSettings', 'allow', 'Bash(ls:*)', 'add', PROJECT_ID)
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.local.json'), 'utf8')) as { permissions?: { allow?: string[] } }
    expect(settings.permissions?.allow).toContain('Bash(ls:*)')
    const sources = await invoke('chat-permissions-read', repo, PROJECT_ID) as PermissionSettingsSource[]
    expect(sources.find(s => s.kind === 'localSettings')?.allow).toContain('Bash(ls:*)')

    // The server's browser isn't where the user is: /login asks for the pasted code.
    await invoke('chat-login', tabId, 'claudeai')
    await waitFor(() => chatEvents(tabId).some(e => e.t === 'login' && e.login?.status === 'running'), 'the login card', 10_000)
    const login = chatEvents(tabId).find(e => e.t === 'login' && e.login)
    expect(login).toMatchObject({ t: 'login', login: { status: 'running', method: 'claudeai', remote: true } })
    await invoke('chat-login-dismiss', tabId)

    await invoke('chat-close', tabId)
    expect(routing.index.pinnedHost(tabId)).toBeUndefined()
  }, 60_000)
})
