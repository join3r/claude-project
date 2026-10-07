import { describe, expect, it } from 'vitest'
import { addTaskWithChat, makeTaskWorkspace, type WorkspaceGit } from '../src/main/mobile/new-task'
import { mainStreamId, type Project, type ProjectsData } from '../src/shared/types'
import { findStreamOfTask, projectTasks } from '../src/shared/streams'
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

function counter(): () => string {
  let n = 0
  return () => `id-${++n}`
}

describe('addTaskWithChat (SPEC.md §8.4)', () => {
  it('appends a task named after the prompt, with one claude-chat tab, and leaves the rest alone', () => {
    const before = data()
    const result = addTaskWithChat(before, 'p1', '\n  Fix the   login redirect\nthen test it', counter(), 42)
    expect(result).toMatchObject({ ok: true, tabId: 'id-1', taskId: 'id-3' })
    if (!result.ok) return
    const project = result.data.projects[0]
    const tasks = projectTasks(project)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toBe(projectTasks(before.projects[0])[0])
    expect(tasks[1]).toEqual({
      id: 'id-3',
      name: 'Fix the login redirect',
      mainTabId: 'id-1',
      panes: [{ tabs: [{ id: 'id-1', type: 'claude-chat', title: 'Claude', sessionId: 'id-2' }], activeTabId: 'id-1', width: 1 }],
      lastInteractedAt: 42
    })
    // Without a worktree it goes into `main`.
    expect(findStreamOfTask(project, 'id-3')?.id).toBe(mainStreamId('p1'))
    expect(project.streams).toHaveLength(1)
    expect(project.lifetimeStats).toEqual({ tasksCreated: 1, notesCreated: 0 })
    expect(projectTasks(before.projects[0])).toHaveLength(1)
  })

  it('cuts a long first line to fit the sidebar', () => {
    const result = addTaskWithChat(data(), 'p1', 'x'.repeat(80), counter())
    expect(result.ok && projectTasks(result.data.projects[0])[1].name).toBe('x'.repeat(49) + '…')
  })

  it('refuses unknown and hidden projects, and shell-command projects', () => {
    expect(addTaskWithChat(data(), 'nope', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ hideFromMobile: true }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ shellCommand: { command: 'npm run dev' } }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('makeTaskWorkspace (SPEC.md §8.6)', () => {
  const project = data().projects[0]

  function git(branches: string[], failures: string[] = []): WorkspaceGit & { created: string[] } {
    const created: string[] = []
    return {
      created,
      listBranches: async () => branches,
      create: async (_project, name, baseBranch) => {
        created.push(`${name}<${baseBranch}`)
        if (failures.includes(name)) throw new Error(`Branch "${name}" already exists`)
        return { worktreePath: `/src/api/.worktrees/${name}`, branchName: name, baseBranch, relativeProjectPath: '' }
      }
    }
  }

  it('forks a branch named after the prompt from main, else master', async () => {
    const g = git(['feature', 'master'])
    expect(await makeTaskWorkspace(project, 'Fix the login redirect', g)).toEqual({
      ok: true,
      workspace: { worktreePath: '/src/api/.worktrees/fix-the-login-redirect', branchName: 'fix-the-login-redirect', baseBranch: 'master', relativeProjectPath: '' }
    })
    expect(g.created).toEqual(['fix-the-login-redirect<master'])
  })

  it('steps past listed branches and ones made since the listing', async () => {
    const g = git(['main', 'fix-it'], ['fix-it-2'])
    const made = await makeTaskWorkspace(project, 'Fix it', g)
    expect(made.ok && made.workspace.branchName).toBe('fix-it-3')
    expect(g.created).toEqual(['fix-it-2<main', 'fix-it-3<main'])
  })

  it('reports a folder that is not a repository, and a creation that fails', async () => {
    const notGit: WorkspaceGit = { listBranches: async () => { throw new Error('not a git repository') }, create: async () => { throw new Error('unreachable') } }
    expect(await makeTaskWorkspace(project, 'Go', notGit)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await makeTaskWorkspace(project, 'Go', git([]))).toMatchObject({ ok: false, code: 'unsupported' })
    const broken: WorkspaceGit = { listBranches: async () => ['main'], create: async () => { throw new Error('disk full') } }
    expect(await makeTaskWorkspace(project, 'Go', broken)).toEqual({ ok: false, code: 'internal', message: 'disk full' })
  })

  it('puts the task in a new stream of its own that holds the workspace', () => {
    const workspace = { worktreePath: '/w', branchName: 'go', baseBranch: 'main', relativeProjectPath: '' }
    const result = addTaskWithChat(data(), 'p1', 'Go', counter(), 1, workspace)
    if (!result.ok) throw new Error(result.code)
    const stream = findStreamOfTask(result.data.projects[0], result.taskId)
    expect(stream).toMatchObject({ name: 'Go', workspace, lastTaskId: result.taskId })
    expect(stream?.isMain).toBeUndefined()
    expect(stream?.tasks.map(t => t.id)).toEqual([result.taskId])
  })
})
