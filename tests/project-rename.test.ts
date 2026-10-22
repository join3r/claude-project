import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProjectRename, rebasePath, rebasePathsDeep, renameProject, type ProjectRenameDeps } from '../src/main/project-rename'
import { moveAgentHistory } from '../src/main/agent-history-move'
import { LocalGitRunner } from '../src/main/git-runner'
import { claudeProjectSlug } from '../src/main/ipc/agents'
import { piSessionDirName } from '../src/main/agent-session-move'
import { emptyArchive, type ProjectArchive } from '../src/shared/archive'
import { createMainStream, type Project, type ProjectsData, type TabStatusValue } from '../src/shared/types'

const tmpDirs: string[] = []
function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

/** A repo at `<root>/app` with a worktree stream at `.worktrees/rel` and a task with two tabs. */
function setup(overrides: { status?: Record<string, TabStatusValue>; live?: string[]; dirty?: string[]; busy?: string[] } = {}) {
  const root = tmp('rename-')
  const dir = path.join(root, 'app')
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README'), 'x')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  const worktree = path.join(dir, '.worktrees', 'rel')
  git(dir, 'worktree', 'add', '-q', '-b', 'rel', worktree)

  const main = createMainStream('p')
  main.tasks = [{
    id: 't1', name: 'fix', panes: [{ id: 'pane', tabs: [
      { id: 'tab-term', type: 'terminal', title: 'zsh' },
      { id: 'tab-chat', type: 'claude-chat', title: 'Claude' },
      { id: 'tab-file', type: 'editor', title: 'README', filePath: path.join(dir, 'README') } as never
    ], activeTabId: 'tab-term' }]
  } as never]
  const project: Project = {
    id: 'p', name: 'app', directory: dir,
    streams: [main, { id: 's-rel', name: 'rel', tasks: [], workspace: { worktreePath: worktree, branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' } }]
  }
  let data: ProjectsData = { projects: [project], tags: [], projectOrder: ['p'], pinnedItems: [] }
  let archive: ProjectArchive = { ...emptyArchive(), tasks: [{ task: { id: 'old', name: 'old', panes: [] } as never, streamId: 's-rel', streamName: 'rel', dir: worktree, archivedAt: 1 }] }
  const live = new Set(overrides.live ?? ['tab-term', 'tab-chat'])
  const calls: string[] = []
  const deps: ProjectRenameDeps = {
    peek: () => data,
    commit: (next) => { data = next; calls.push('commit') },
    statusOf: (tabId) => overrides.status?.[tabId] ?? null,
    isLive: (tabId) => live.has(tabId),
    dirtyTabIds: () => overrides.dirty ?? [],
    taskBusy: (taskId) => (overrides.busy ?? []).includes(taskId),
    stopTabs: (ids) => { calls.push(`stop:${ids.join(',')}`); for (const id of ids) live.delete(id) },
    announceRestart: (ids) => { calls.push(`restart:${ids.join(',')}`) },
    archive: { load: () => archive, update: (_id, fn) => (archive = fn(archive)) },
    git: new LocalGitRunner(),
    moveAgentHistory: vi.fn(async () => { calls.push('history'); return [] })
  }
  return { root, dir, worktree, deps, calls, data: () => data, archive: () => archive }
}

describe('rebasePath', () => {
  it('re-roots the folder and paths below it, and nothing else', () => {
    expect(rebasePath('/a/app', '/a/app', '/a/web')).toBe('/a/web')
    expect(rebasePath('/a/app/src/x.ts', '/a/app', '/a/web')).toBe('/a/web/src/x.ts')
    expect(rebasePath('/a/app-other', '/a/app', '/a/web')).toBe('/a/app-other')
    expect(rebasePath('C:\\a\\app\\x', 'C:\\a\\app', 'C:\\a\\web')).toBe('C:\\a\\web\\x')
    expect(rebasePathsDeep({ n: 1, l: ['/a/app/x', 'text'] }, '/a/app', '/a/web')).toEqual({ n: 1, l: ['/a/web/x', 'text'] })
  })
})

describe('checkProjectRename', () => {
  it('lists the running tabs it would stop', async () => {
    const env = setup()
    const check = await checkProjectRename(env.deps, 'p', { name: 'web', folder: true })
    expect(check).toEqual({ target: path.join(env.root, 'web'), blockers: [], running: { terminals: 1, agents: 0, chats: 1 } })
  })

  it('refuses while an agent works, a task lands, a file is unsaved or the name is taken', async () => {
    const env = setup({ status: { 'tab-chat': 'working' }, dirty: ['tab-file'], busy: ['t1'] })
    fs.mkdirSync(path.join(env.root, 'web'))
    const { blockers } = await checkProjectRename(env.deps, 'p', { name: 'web', folder: true })
    expect(blockers.join('\n')).toMatch(/already exists/)
    expect(blockers.join('\n')).toMatch(/agents working in "fix"/)
    expect(blockers.join('\n')).toMatch(/landing or worktree setup of "fix"/)
    expect(blockers.join('\n')).toMatch(/Save or close "README"/)
  })

  it('refuses a subfolder of a bigger repository, and a folder another project lives in', async () => {
    const env = setup()
    const sub = path.join(env.dir, 'pkg')
    fs.mkdirSync(sub)
    const data = env.data()
    data.projects.push({ id: 'q', name: 'pkg', directory: sub, streams: [createMainStream('q')] })
    expect((await checkProjectRename(env.deps, 'p', { name: 'web', folder: true })).blockers.join(' ')).toMatch(/"pkg" lives in this folder/)
    expect((await checkProjectRename(env.deps, 'q', { name: 'lib', folder: true })).blockers.join(' ')).toMatch(/inside the git repository/)
  })

  it('lets a busy plain terminal be stopped', async () => {
    const env = setup({ status: { 'tab-term': 'working' } })
    expect((await checkProjectRename(env.deps, 'p', { name: 'web', folder: true })).blockers).toEqual([])
  })

  it('is a plain rename without the folder', async () => {
    const env = setup({ status: { 'tab-chat': 'working' } })
    expect(await checkProjectRename(env.deps, 'p', { name: 'web', folder: false })).toMatchObject({ target: env.dir, blockers: [] })
  })
})

describe('renameProject', () => {
  it('needs the user to confirm stopping live tabs', async () => {
    const env = setup()
    await expect(renameProject(env.deps, 'p', { name: 'web', folder: true })).rejects.toThrow(/confirm stopping/)
    expect(fs.existsSync(env.dir)).toBe(true)
  })

  it('stops the tabs, moves the folder, repairs worktrees, rewrites every path and then restarts the tabs', async () => {
    const env = setup()
    const result = await renameProject(env.deps, 'p', { name: 'web', folder: true, stop: true })
    const to = path.join(env.root, 'web')
    expect(result).toEqual({ directory: to, warnings: [] })
    expect(fs.existsSync(env.dir)).toBe(false)
    expect(env.calls).toEqual(['stop:tab-term,tab-chat', 'restart:tab-term,tab-chat', 'history', 'commit'])

    const project = env.data().projects[0]
    expect(project).toMatchObject({ name: 'web', directory: to })
    expect(project.streams[1].workspace?.worktreePath).toBe(path.join(to, '.worktrees', 'rel'))
    expect((project.streams[0].tasks[0].panes[0].tabs[2] as unknown as { filePath: string }).filePath).toBe(path.join(to, 'README'))
    expect(env.archive().tasks[0].dir).toBe(path.join(to, '.worktrees', 'rel'))

    // git follows: the worktree knows its repo, and the repo its worktree.
    const newWorktree = path.join(to, '.worktrees', 'rel')
    expect(git(newWorktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('rel')
    expect(git(to, 'worktree', 'list', '--porcelain')).toContain(`worktree ${newWorktree}`)
    expect(env.deps.moveAgentHistory).toHaveBeenCalledWith(env.dir, to, [env.worktree])
  })

  it('only renames when the folder stays', async () => {
    const env = setup()
    await renameProject(env.deps, 'p', { name: 'Web App', folder: false })
    expect(env.data().projects[0]).toMatchObject({ name: 'Web App', directory: env.dir })
    expect(env.calls).toEqual(['commit'])
  })
})

describe('moveAgentHistory', () => {
  function session(folder: string, id: string, cwd: string) {
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, `${id}.jsonl`), `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd, sessionId: id })}\n`)
  }

  it('moves Claude and Pi history for the folder and below, leaves look-alike siblings, re-keys ~/.claude.json', async () => {
    const home = tmp('history-')
    const roots = { claudeProjects: path.join(home, 'claude'), piSessions: path.join(home, 'pi'), claudeJson: path.join(home, '.claude.json') }
    const from = '/code/app'
    const to = '/code/web'
    const slug = (p: string) => path.join(roots.claudeProjects, claudeProjectSlug(p))
    session(slug(from), 's1', from)
    session(slug('/code/app/.worktrees/rel'), 's2', '/code/app/.worktrees/rel')
    session(slug('/code/app/src'), 's3', '/code/app/src')
    session(slug('/code/app-other'), 's4', '/code/app-other')
    // Already there for the new folder: kept, the old one's other sessions join it.
    session(slug(to), 'mine', to)
    fs.mkdirSync(path.join(roots.piSessions, piSessionDirName(from)), { recursive: true })
    fs.writeFileSync(path.join(roots.piSessions, piSessionDirName(from), '1_p1.jsonl'), `${JSON.stringify({ type: 'session', cwd: from })}\n`)
    fs.writeFileSync(roots.claudeJson, JSON.stringify({ userID: 'u', projects: { [from]: { allowedTools: ['Bash'] }, '/code/app/src': { a: 1 }, '/code/app-other': { b: 2 } } }, null, 2), { mode: 0o600 })

    expect(await moveAgentHistory(from, to, ['/code/app/.worktrees/rel'], roots)).toEqual([])

    expect(fs.readdirSync(slug(to)).sort()).toEqual(['mine.jsonl', 's1.jsonl'])
    expect(fs.existsSync(slug(from))).toBe(false)
    expect(fs.existsSync(path.join(slug('/code/web/.worktrees/rel'), 's2.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(slug('/code/web/src'), 's3.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(slug('/code/app-other'), 's4.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(roots.piSessions, piSessionDirName(to), '1_p1.jsonl'))).toBe(true)
    const config = JSON.parse(fs.readFileSync(roots.claudeJson, 'utf8'))
    expect(config).toEqual({ userID: 'u', projects: { [to]: { allowedTools: ['Bash'] }, '/code/web/src': { a: 1 }, '/code/app-other': { b: 2 } } })
    if (process.platform !== 'win32') expect(fs.statSync(roots.claudeJson).mode & 0o777).toBe(0o600)
  })
})
