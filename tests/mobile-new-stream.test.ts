import { describe, expect, it } from 'vitest'
import { createStream, listProjectBranches, type NewStreamDeps } from '../src/main/mobile/new-stream'
import type { Project, ProjectsData, WorkspaceCreateRequest, WorkspaceTarget } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

function data(extra: Partial<Project> = {}): ProjectsData {
  return {
    projects: [fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', ...extra,
      tasks: [{ id: 't1', name: 'fix-auth' }]
    })],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  }
}

function rig(initial: ProjectsData, branches: string[] = ['dev', 'main']) {
  let current = initial
  const listed: WorkspaceTarget[] = []
  const created: WorkspaceCreateRequest[] = []
  const commits: ProjectsData[] = []
  const deps: NewStreamDeps = {
    peek: () => current,
    commit: (next) => { commits.push(next); current = next },
    ids: () => 's-new',
    listBranches: async (target) => { listed.push(target); return branches },
    createWorkspace: async (request) => {
      created.push(request)
      if (request.name === 'taken') throw new Error('Branch "taken" already exists')
      return { worktreePath: `/src/api/.worktrees/${request.name}`, branchName: request.name, relativeProjectPath: '' }
    }
  }
  return { deps, listed, created, commits, current: () => current, set: (next: ProjectsData) => { current = next } }
}

const SSH = { host: 'box', port: 22, username: 'me', remoteDir: '/home/me/api' }

describe('createStream (SPEC.md §8.12)', () => {
  it('makes a worktree on the given branch and base, then appends the stream as the dialog does', async () => {
    const r = rig(data())
    const before = r.current().projects[0]
    const outcome = await createStream(r.deps, { projectId: 'p1', name: '0.6.0', worktree: true, branch: 'release-0.6', baseBranch: 'dev' })
    expect(outcome).toEqual({ ok: true, streamId: 's-new' })
    expect(r.created).toEqual([{ projectDir: '/src/api', projectId: undefined, sshConfig: undefined, name: 'release-0.6', baseBranch: 'dev' }])
    expect(r.listed).toEqual([])
    const project = r.current().projects[0]
    expect(project.streams.slice(0, -1)).toEqual(before.streams)
    expect(project.streams.at(-1)).toEqual({
      id: 's-new',
      name: '0.6.0',
      workspace: { worktreePath: '/src/api/.worktrees/release-0.6', branchName: 'release-0.6', baseBranch: 'dev', relativeProjectPath: '' },
      tasks: []
    })
    // The dialog doesn't make the new stream the current one.
    expect(project.lastStreamId).toBe(before.lastStreamId)
  })

  it('defaults the branch to the name\'s slug and the base to main, else master, else the first', async () => {
    const r = rig(data())
    await createStream(r.deps, { projectId: 'p1', name: 'Chapter 2', worktree: true })
    expect(r.created[0]).toMatchObject({ name: 'chapter-2', baseBranch: 'main' })
    expect(r.listed).toHaveLength(1)
  })

  it('works in the project folder without touching git', async () => {
    const r = rig(data())
    const outcome = await createStream(r.deps, { projectId: 'p1', name: 'Docs', worktree: false })
    expect(outcome).toEqual({ ok: true, streamId: 's-new' })
    expect(r.created).toEqual([])
    expect(r.listed).toEqual([])
    expect(r.current().projects[0].streams.at(-1)).toEqual({ id: 's-new', name: 'Docs', tasks: [] })
  })

  it('makes a remote project\'s worktree over SSH, in its remote folder', async () => {
    const r = rig(data({ ssh: SSH }))
    await createStream(r.deps, { projectId: 'p1', name: '0.6.0', worktree: true, baseBranch: 'main' })
    expect(r.created).toEqual([{ projectDir: '/home/me/api', projectId: 'p1', sshConfig: SSH, name: '0.6.0', baseBranch: 'main' }])
  })

  it('refuses a worktree for a shell-command project, but takes a folder stream', async () => {
    const r = rig(data({ shellCommand: { command: 'top' } }))
    expect(await createStream(r.deps, { projectId: 'p1', name: 'x', worktree: true })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(r.commits).toEqual([])
    expect(await createStream(r.deps, { projectId: 'p1', name: 'x', worktree: false })).toEqual({ ok: true, streamId: 's-new' })
  })

  it('answers not-found for an unknown or hidden project', async () => {
    const r = rig(data({ hideFromMobile: true }))
    expect(await createStream(r.deps, { projectId: 'p1', name: 'x', worktree: false })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await createStream(r.deps, { projectId: 'nope', name: 'x', worktree: false })).toMatchObject({ ok: false, code: 'not-found' })
    expect(r.commits).toEqual([])
  })

  it('reports a name with no usable branch, a repository with no branch, and git\'s own failure, committing nothing', async () => {
    const r = rig(data())
    expect(await createStream(r.deps, { projectId: 'p1', name: '!!!', worktree: true })).toMatchObject({ ok: false, code: 'bad-request' })
    await expect(createStream(r.deps, { projectId: 'p1', name: 'x', worktree: true, branch: 'taken' })).rejects.toThrow('already exists')
    const empty = rig(data(), [])
    expect(await createStream(empty.deps, { projectId: 'p1', name: 'x', worktree: true })).toMatchObject({ ok: false, code: 'internal' })
    expect(r.commits).toEqual([])
    expect(empty.commits).toEqual([])
  })
})

describe('listProjectBranches (SPEC.md §8.13)', () => {
  it('lists the branches and picks the base the dialog would', async () => {
    const r = rig(data({ ssh: SSH }), ['dev', 'master', 'x'])
    expect(await listProjectBranches(r.deps, 'p1')).toEqual({ ok: true, branches: ['dev', 'master', 'x'], defaultBase: 'master' })
    expect(r.listed).toEqual([{ projectDir: '/home/me/api', projectId: 'p1', sshConfig: SSH }])
    expect(await listProjectBranches(rig(data(), []).deps, 'p1')).toEqual({ ok: true, branches: [], defaultBase: '' })
  })

  it('answers unsupported for a shell-command project and not-found for an unknown one', async () => {
    const r = rig(data({ shellCommand: { command: 'top' } }))
    expect(await listProjectBranches(r.deps, 'p1')).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await listProjectBranches(r.deps, 'nope')).toMatchObject({ ok: false, code: 'not-found' })
    expect(r.listed).toEqual([])
  })
})
