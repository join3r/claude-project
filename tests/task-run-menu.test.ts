import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamRunMenuEntries, taskHeaderRunMenu, taskRunMenuEntry } from '../src/renderer/components/StreamRunControls'
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

describe('taskHeaderRunMenu', () => {
  const labels = (entries: { label: string; dividerBefore?: boolean }[]) => entries.map(e => (e.dividerBefore ? '— ' : '') + e.label)

  it('offers this task, its stream and main, each with its own runs', () => {
    const entries = taskHeaderRunMenu(project, stream, own, [running('c-run', 't-auth')], [running('c-install')])
    expect(labels(entries)).toEqual([
      'Run install in this task', '— Restart run in this task', 'Stop run in this task', 'run logs in this task',
      '— Run install in x', 'Run run in x',
      '— Restart install in main', 'Stop install in main', 'install logs in main', '— Run run in main',
      '— Edit commands…'
    ])
    // Run in the stream's folder moves the run out of the task's worktree.
    expect(entries.find(e => e.label === 'Run run in x')?.hint).toBe('moves it')
    entries.find(e => e.label === 'Run run in x')?.onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-x', 'c-run', 'start')
    entries.find(e => e.label === 'Restart install in main')?.onSelect()
    expect(control).toHaveBeenCalledWith('p', 's-main', 'c-install', 'restart')
  })

  it('leaves out this task without a worktree, and main when the task is in it', () => {
    const main = project.streams[0]
    expect(labels(taskHeaderRunMenu(project, main, shared, [], []))).toEqual(['Run install in main', 'Run run in main', '— Edit commands…'])
  })

  it('offers to set commands up when there are none', () => {
    expect(labels(taskHeaderRunMenu({ ...project, runCommands: [] }, stream, own, [], []))).toEqual(['Set up commands…'])
  })
})

describe('streamRunTask', () => {
  it('finds the task a run is in, while it is still in the stream', () => {
    expect(streamRunTask(stream, running('c-run', 't-auth'))?.name).toBe('fix-auth')
    expect(streamRunTask(stream, running('c-run'))).toBeUndefined()
    expect(streamRunTask(stream, running('c-run', 't-gone'))).toBeUndefined()
  })
})
