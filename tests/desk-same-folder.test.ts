import { describe, expect, it } from 'vitest'
import { busyInSameFolder, sameFolderWarning } from '../src/renderer/components/desk/deskStart'
import { createMainStream } from '../src/shared/types'
import type { Project, Stream, Task, TabStatusValue, WorkspaceConfig } from '../src/shared/types'
import { singlePane } from '../src/shared/streams'

function task(id: string, extra?: Partial<Task>): Task {
  return { id, name: id, panes: singlePane([{ id: `${id}-tab`, type: 'claude-chat' as const, title: 'Claude' }]), ...extra }
}

function workspace(path: string): WorkspaceConfig {
  return { worktreePath: path, branchName: path, baseBranch: 'main', relativeProjectPath: '' }
}

function project(main: Task[], streams: Stream[] = []): Project {
  return { id: 'p', name: 'p', directory: '/tmp/p', streams: [createMainStream('p', main), ...streams] }
}

const working = (...ids: string[]) => (tabId: string): TabStatusValue => (ids.some(id => `${id}-tab` === tabId) ? 'working' : null)

describe('busyInSameFolder', () => {
  it('names a working main task when a new main task would share the project folder', () => {
    const p = project([task('a'), task('b')])
    expect(busyInSameFolder(p, undefined, working('a')).map(t => t.id)).toEqual(['a'])
  })

  it('ignores idle tasks and tasks in a worktree of their own', () => {
    const own = task('own', { workspace: workspace('/tmp/p/.worktrees/own') })
    const p = project([task('idle'), own])
    expect(busyInSameFolder(p, undefined, working('own'))).toEqual([])
  })

  it('is quiet when the new task gets a worktree of its own', () => {
    const release: Stream = { id: 's', name: 'release', workspace: workspace('/tmp/p-release'), taskWorktrees: true, tasks: [task('shared', { sharesStreamWorktree: true })] }
    const p = project([], [release])
    expect(busyInSameFolder(p, release, working('shared'))).toEqual([])
  })

  it('warns in a stream worktree its tasks share', () => {
    const old: Stream = { id: 's', name: 'old', workspace: workspace('/tmp/p-old'), tasks: [task('x')] }
    const p = project([task('main-task')], [old])
    expect(busyInSameFolder(p, old, working('x', 'main-task')).map(t => t.id)).toEqual(['x'])
    expect(sameFolderWarning(p, old, [old.tasks[0]])).toMatch(/^"x" is already working in the old worktree/)
  })
})
