import { describe, it, expect } from 'vitest'
import { cleanTaskTitle, renameTaskIfStill, TASK_TITLE_MAX } from '../src/shared/task-name'
import { createMainStream, type ProjectsData, type Task } from '../src/shared/types'

describe('cleanTaskTitle', () => {
  it('keeps a plain title', () => {
    expect(cleanTaskTitle('Esc cancel leaves tasks stuck\n')).toBe('Esc cancel leaves tasks stuck')
  })

  it('drops quotes, a label, markdown and a closing period', () => {
    expect(cleanTaskTitle('"Fix relay reconnect."')).toBe('Fix relay reconnect')
    expect(cleanTaskTitle('Title: Inbox project grouping')).toBe('Inbox project grouping')
    expect(cleanTaskTitle('**Pinned projects first**')).toBe('Pinned projects first')
    expect(cleanTaskTitle('\n\n  Voice   dictation\nmore text')).toBe('Voice dictation')
  })

  it('gives up on an empty or long reply', () => {
    expect(cleanTaskTitle('  \n')).toBeNull()
    expect(cleanTaskTitle('""')).toBeNull()
    expect(cleanTaskTitle('a'.repeat(TASK_TITLE_MAX + 1))).toBeNull()
  })
})

describe('renameTaskIfStill', () => {
  const task = (id: string, name: string): Task => ({ id, name, panes: [] } as unknown as Task)
  const data = (name: string): ProjectsData => ({
    projects: [{ id: 'p1', name: 'P', directory: '/p', streams: [createMainStream('p1', [task('t1', name), task('t2', 'Other')])] }]
  } as unknown as ProjectsData)
  const nameOf = (d: ProjectsData, id: string) => d.projects[0].streams[0].tasks.find(t => t.id === id)?.name

  it('renames a task that still has its first-line name', () => {
    const next = renameTaskIfStill(data('I would like to have the project…'), 't1', 'I would like to have the project…', 'Bold inbox projects')
    expect(nameOf(next, 't1')).toBe('Bold inbox projects')
    expect(nameOf(next, 't2')).toBe('Other')
  })

  it('leaves a task renamed in the meantime, and a missing one, untouched', () => {
    const renamed = data('My own name')
    expect(renameTaskIfStill(renamed, 't1', 'I would like…', 'Bold inbox projects')).toBe(renamed)
    expect(renameTaskIfStill(renamed, 'gone', 'My own name', 'X')).toBe(renamed)
  })
})
