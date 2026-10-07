import { describe, expect, it } from 'vitest'
import { addTaskWithChat } from '../src/main/mobile/new-task'
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
    const result = addTaskWithChat(before, 'p1', '\n  Fix the   login redirect\nthen test it', undefined, counter(), 42)
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
    // With no stream named and none used yet, it goes into `main`.
    expect(findStreamOfTask(project, 'id-3')?.id).toBe(mainStreamId('p1'))
    expect(project.streams).toHaveLength(1)
    expect(project.lifetimeStats).toEqual({ tasksCreated: 1, notesCreated: 0 })
    expect(projectTasks(before.projects[0])).toHaveLength(1)
  })

  it('cuts a long first line to fit the sidebar', () => {
    const result = addTaskWithChat(data(), 'p1', 'x'.repeat(80), undefined, counter())
    expect(result.ok && projectTasks(result.data.projects[0])[1].name).toBe('x'.repeat(49) + '…')
  })

  it('refuses unknown and hidden projects, and shell-command projects', () => {
    expect(addTaskWithChat(data(), 'nope', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ hideFromMobile: true }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ shellCommand: { command: 'npm run dev' } }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('addTaskWithChat streams (SPEC.md §8.4)', () => {
  const streams = [
    { id: 's-050', name: '0.5.0', workspace: { worktreePath: '/w', branchName: '0.5.0', baseBranch: 'main', relativeProjectPath: '' }, tasks: [] },
    { id: 's-bugs', name: 'bugfixes', tasks: [] }
  ]

  it('adds to the stream the phone names, and makes it the most recently used one', () => {
    const result = addTaskWithChat(data({ streams: undefined }), 'p1', 'Go', 's-050', counter(), 1)
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
    const withStreams: ProjectsData = { ...data(), projects: [fixtureProject({ id: 'p1', name: 'api', directory: '/src/api', tasks: [{ id: 't1', name: 'fix-auth' }], streams })] }
    const added = addTaskWithChat(withStreams, 'p1', 'Go', 's-050', counter(), 1)
    if (!added.ok) throw new Error(added.code)
    const project = added.data.projects[0]
    expect(findStreamOfTask(project, added.taskId)?.id).toBe('s-050')
    expect(project.lastStreamId).toBe('s-050')
    expect(project.streams.find(s => s.id === 's-050')?.lastTaskId).toBe(added.taskId)
  })

  it('defaults to the stream the project was last used in, else main', () => {
    const base = fixtureProject({ id: 'p1', name: 'api', directory: '/src/api', tasks: [{ id: 't1', name: 'fix-auth' }], streams })
    const last: ProjectsData = { ...data(), projects: [{ ...base, lastStreamId: 's-bugs' }] }
    const added = addTaskWithChat(last, 'p1', 'Go', undefined, counter(), 1)
    expect(added.ok && findStreamOfTask(added.data.projects[0], added.taskId)?.id).toBe('s-bugs')
    const gone: ProjectsData = { ...data(), projects: [{ ...base, lastStreamId: 'archived' }] }
    const fallback = addTaskWithChat(gone, 'p1', 'Go', undefined, counter(), 1)
    expect(fallback.ok && findStreamOfTask(fallback.data.projects[0], fallback.taskId)?.id).toBe(mainStreamId('p1'))
  })

  it('refuses a stream that is gone (archived streams are not in the data)', () => {
    expect(addTaskWithChat(data(), 'p1', 'Go', 'archived')).toMatchObject({ ok: false, code: 'not-found' })
  })
})
