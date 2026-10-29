import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamRunMenuEntries, taskRunMenuEntry } from '../src/renderer/components/StreamRunControls'
import { streamRunTask, type StreamRunState } from '../src/shared/stream-run'
import { createMainStream } from '../src/shared/types'
import type { Project, Stream, Task } from '../src/shared/types'

const own: Task = { id: 't-auth', name: 'fix-auth', tabs: [], workspace: { worktreePath: '/repo/.worktrees/x--fix-auth', branchName: 'x--fix-auth', baseBranch: 'x' } } as never
const shared: Task = { id: 't-shared', name: 'shared', tabs: [] } as never
const stream: Stream = { id: 's-x', name: 'x', tasks: [own, shared], workspace: { worktreePath: '/repo/.worktrees/x', branchName: 'x', baseBranch: 'main' } } as never
const project: Project = {
  id: 'p',
  name: 'api',
  directory: '/repo',
  runCommands: [
    { id: 'c-install', name: 'install', command: 'npm ci' },
    { id: 'c-run', name: 'run', command: 'npm run dev' }
  ],
  streams: [{ ...createMainStream('p'), id: 's-main' }, stream]
} as Project

const running = (commandId: string, taskId?: string): StreamRunState =>
  ({ status: 'running', commandId, name: commandId.slice(2), command: 'x', startedAt: 1, ...(taskId ? { taskId } : {}) })

const control = vi.fn(async () => ({ ok: true as const }))
;(globalThis as unknown as { window: unknown }).window = { api: { streamRunControl: control } }
afterEach(() => { control.mockClear() })

describe('streamRunMenuEntries', () => {
  it('offers Run for each command, and Restart, Stop and logs for one that runs', () => {
    const entries = streamRunMenuEntries(project, stream, [running('c-run')])
    expect(entries.map(e => e.label)).toEqual(['Run install', 'Restart run', 'Stop run', 'run logs'])
    expect(entries.map(e => !!e.dividerBefore)).toEqual([false, true, false, false])
    entries[0].onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'c-install', 'start')
  })

  it('keeps Stop for a command removed while it runs', () => {
    const entries = streamRunMenuEntries(project, stream, [running('c-gone')])
    expect(entries.map(e => e.label)).toEqual(['Run install', 'Run run', 'Stop gone', 'gone logs'])
  })

  it('in a task, runs here and says when that moves a run', () => {
    const entries = streamRunMenuEntries(project, stream, [running('c-run')], own)
    expect(entries.map(e => [e.label, e.hint])).toEqual([['Run install here', undefined], ['Run run here', 'moves it']])
    entries[1].onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'c-run', 'start', 't-auth')
    const here = streamRunMenuEntries(project, stream, [running('c-run', 't-auth')], own)
    expect(here.map(e => e.label)).toEqual(['Run install here', 'Restart run', 'Stop run', 'run logs'])
    here[1].onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'c-run', 'restart', 't-auth')
  })
})

describe('taskRunMenuEntry', () => {
  it('is Run here… for a task with a worktree of its own, in a stream with commands', () => {
    expect(taskRunMenuEntry(project, stream, shared, [], { x: 0, y: 0 })).toBeNull()
    expect(taskRunMenuEntry({ ...project, runCommands: [] }, stream, own, [], { x: 0, y: 0 })).toBeNull()
    expect(taskRunMenuEntry(project, stream, own, [], { x: 0, y: 0 })?.label).toBe('Run here…')
    expect(taskRunMenuEntry(project, stream, own, [running('c-run', 't-auth')], { x: 0, y: 0 })?.hint).toBe('1 running')
  })
})

describe('streamRunTask', () => {
  it('finds the task a run is in, while it is still in the stream', () => {
    expect(streamRunTask(stream, running('c-run', 't-auth'))?.name).toBe('fix-auth')
    expect(streamRunTask(stream, running('c-run'))).toBeUndefined()
    expect(streamRunTask(stream, running('c-run', 't-gone'))).toBeUndefined()
  })
})
