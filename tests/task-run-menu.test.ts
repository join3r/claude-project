import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskRunMenuEntries } from '../src/renderer/components/StreamRunControls'
import { streamRunTask, type StreamRunState } from '../src/shared/stream-run'
import { createMainStream } from '../src/shared/types'
import type { Project, Stream, Task } from '../src/shared/types'

const own: Task = { id: 't-auth', name: 'fix-auth', tabs: [], workspace: { worktreePath: '/repo/.worktrees/x--fix-auth', branchName: 'x--fix-auth', baseBranch: 'x' } } as never
const shared: Task = { id: 't-shared', name: 'shared', tabs: [] } as never
const stream: Stream = { id: 's-x', name: 'x', tasks: [own, shared], workspace: { worktreePath: '/repo/.worktrees/x', branchName: 'x', baseBranch: 'main' } } as never
const project: Project = { id: 'p', name: 'api', directory: '/repo', runCommand: 'npm run dev', streams: [{ ...createMainStream('p'), id: 's-main' }, stream] } as Project

const running = (taskId?: string): StreamRunState => ({ status: 'running', command: 'npm run dev', startedAt: 1, ...(taskId ? { taskId } : {}) })

describe('taskRunMenuEntries', () => {
  const control = vi.fn(async () => ({ ok: true as const }))
  ;(globalThis as unknown as { window: unknown }).window = { api: { streamRunControl: control } }
  afterEach(() => { control.mockClear() })

  it('offers Run app here only to a task with a worktree of its own, in a stream with a command', () => {
    expect(taskRunMenuEntries(project, stream, shared, undefined)).toEqual([])
    expect(taskRunMenuEntries({ ...project, runCommand: undefined }, stream, own, undefined)).toEqual([])
    const entries = taskRunMenuEntries(project, stream, own, undefined)
    expect(entries.map(e => e.label)).toEqual(['Run app here'])
    entries[0].onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'start', 't-auth')
  })

  it('says Run app here moves the app when it runs elsewhere', () => {
    expect(taskRunMenuEntries(project, stream, own, running())[0].title).toMatch(/^Moves x's app here/)
  })

  it('offers Restart, Stop and logs while the app runs in this task', () => {
    const entries = taskRunMenuEntries(project, stream, own, running('t-auth'))
    expect(entries.map(e => e.label)).toEqual(['Restart app', 'Stop app', 'Show app logs'])
    entries[0].onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'restart', 't-auth')
  })
})

describe('streamRunTask', () => {
  it('finds the task a run is in, while it is still in the stream', () => {
    expect(streamRunTask(stream, running('t-auth'))?.name).toBe('fix-auth')
    expect(streamRunTask(stream, running())).toBeUndefined()
    expect(streamRunTask(stream, running('t-gone'))).toBeUndefined()
  })
})
