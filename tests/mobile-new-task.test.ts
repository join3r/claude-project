import { describe, expect, it } from 'vitest'
import { addTaskWithChat } from '../src/main/mobile/new-task'
import { createHomeTask, type ProjectsData } from '../src/shared/types'

function data(extra: Partial<ProjectsData['projects'][number]> = {}): ProjectsData {
  const home = createHomeTask('p1').task
  return {
    projects: [{
      id: 'p1', name: 'api', directory: '/src/api', ...extra,
      tasks: [home, {
        id: 't1', name: 'fix-auth',
        tabs: { left: [], right: [] },
        activeTab: { left: null, right: null }, splitOpen: false, splitRatio: 0.5
      }]
    }],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  } as ProjectsData
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
    expect(project.tasks).toHaveLength(3)
    expect(project.tasks[1]).toBe(before.projects[0].tasks[1])
    expect(project.tasks[2]).toEqual({
      id: 'id-3',
      name: 'Fix the login redirect',
      tabs: { left: [{ id: 'id-1', type: 'claude-chat', title: 'Claude', sessionId: 'id-2' }], right: [] },
      activeTab: { left: 'id-1', right: null },
      splitOpen: false,
      splitRatio: 0.5,
      lastInteractedAt: 42
    })
    expect(project.lifetimeStats).toEqual({ tasksCreated: 1, notesCreated: 0 })
    expect(before.projects[0].tasks).toHaveLength(2)
  })

  it('cuts a long first line to fit the sidebar', () => {
    const result = addTaskWithChat(data(), 'p1', 'x'.repeat(80), counter())
    expect(result.ok && result.data.projects[0].tasks[2].name).toBe('x'.repeat(49) + '…')
  })

  it('refuses unknown and hidden projects, and shell-command projects', () => {
    expect(addTaskWithChat(data(), 'nope', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ hideFromMobile: true }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addTaskWithChat(data({ shellCommand: { command: 'npm run dev' } }), 'p1', 'Go')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
