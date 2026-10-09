// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project, Stream, Tab, Task, TaskLanding, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

void React

const app = {
  switchToTask: vi.fn(),
  archiveTask: vi.fn(),
  addTab: vi.fn(),
  confirmDiscardDirty: vi.fn(),
  projects: [] as Project[]
}
vi.mock('../src/renderer/context/AppContext', () => ({ useApp: () => app }))

import TaskLandingBanner from '../src/renderer/components/TaskLandingBanner'
import { setLandingNotice } from '../src/renderer/taskLanding'

const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.5.0', branchName: '0.5.0', baseBranch: 'main', relativeProjectPath: '' }
const ownWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.5.0--fix', branchName: '0.5.0--fix', baseBranch: '0.5.0', relativeProjectPath: '' }
const agent: Tab = { id: 'tab-agent', type: 'claude-chat', title: 'Claude', sessionId: 's1' }

const api = {
  taskLandingFix: vi.fn(),
  taskLandingAbort: vi.fn(),
  taskLandingRetry: vi.fn(),
  taskStreamAhead: vi.fn()
}

function mount(landing?: TaskLanding, tabs: Tab[] = [agent]) {
  const task: Task = { ...fixtureTask({ id: 't1', name: 'Fix it', tabs: { left: tabs }, ownWorkspace: ownWs }), ...(landing ? { landing } : {}) }
  const stream: Stream = { id: 'stream-rel', name: '0.5.0', workspace: streamWs, taskWorktrees: true, tasks: [task] }
  const project = fixtureProject({ id: 'p1', directory: '/repo', streams: [stream] })
  app.projects = [project]
  return render(<TaskLandingBanner project={project} stream={stream} task={task} />)
}

beforeEach(() => {
  ;(window as unknown as { api: typeof api }).api = api
  api.taskLandingFix.mockReset().mockResolvedValue({ status: 'fixing' })
  api.taskLandingAbort.mockReset().mockResolvedValue({ status: 'aborted' })
  api.taskLandingRetry.mockReset().mockResolvedValue({ status: 'landed' })
  api.taskStreamAhead.mockReset().mockResolvedValue(0)
  app.switchToTask.mockReset()
  app.archiveTask.mockReset().mockResolvedValue(true)
  app.addTab.mockReset()
  app.confirmDiscardDirty.mockReset().mockResolvedValue('proceed')
})

afterEach(() => {
  act(() => setLandingNotice('t1', null))
  cleanup()
})

describe('TaskLandingBanner', () => {
  it('shows nothing while the task isn\'t landing', () => {
    mount()
    expect(screen.queryByTestId('task-landing-banner')).toBeNull()
  })

  it('lists a conflict\'s files and asks the agent to fix it by default', async () => {
    mount({ state: 'conflict', intent: 'land', files: ['a.txt', 'src/b.ts'] })
    expect(screen.getByRole('alert').textContent).toMatch(/^Conflicts with 0\.5\.0 in 2 files/)
    expect(screen.getByTestId('task-landing-files').textContent).toBe('a.txtsrc/b.ts')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask agent to fix' })) })
    expect(api.taskLandingFix).toHaveBeenCalledWith('p1', 't1')
  })

  it('I\'ll fix it opens a terminal at the worktree root', () => {
    mount({ state: 'conflict', files: ['a.txt'] })
    fireEvent.click(screen.getByRole('button', { name: 'I\'ll fix it' }))
    expect(app.addTab).toHaveBeenCalledWith('p1', 't1', 'focused', 'terminal', { cwd: '/repo/.worktrees/0.5.0--fix' })
  })

  it('a retried close that lands leaves the archiving to main', async () => {
    mount({ state: 'conflict', intent: 'close', files: ['a.txt'] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    expect(api.taskLandingRetry).toHaveBeenCalledWith('p1', 't1')
    // Main archived it as the landing closed it; no result line for a task that is gone.
    expect(app.archiveTask).not.toHaveBeenCalled()
    expect(screen.queryByText('Landed into 0.5.0.')).toBeNull()
  })

  it('a retried Land shows the result instead', async () => {
    mount({ state: 'conflict', intent: 'land', files: ['a.txt'] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    expect(app.archiveTask).not.toHaveBeenCalled()
    expect(screen.getByText('Landed into 0.5.0.')).toBeTruthy()
  })

  it('shows an error inline', async () => {
    api.taskLandingFix.mockResolvedValue({ status: 'failed', error: 'The task\'s agent is not running. Open the task, then ask again.' })
    mount({ state: 'conflict', files: ['a.txt'] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask agent to fix' })) })
    await waitFor(() => expect(screen.getByText(/agent is not running/).className).toMatch(/text-danger/))
  })

  it('can\'t ask a task without an agent tab', () => {
    mount({ state: 'conflict', files: ['a.txt'] }, [{ id: 'tab-sh', type: 'terminal', title: 'Terminal' }])
    expect((screen.getByRole('button', { name: 'Ask agent to fix' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the agent fixing, with Retry and Abort', async () => {
    mount({ state: 'fixing', files: ['a.txt'] })
    expect(screen.getByText('Fixing conflicts with 0.5.0…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask agent to fix' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Abort' })) })
    expect(api.taskLandingAbort).toHaveBeenCalledWith('p1', 't1')
  })

  it('names the stream\'s files in the way when blocked', () => {
    mount({ state: 'blocked', files: ['a.txt'], message: 'error: Your local changes would be overwritten' })
    expect(screen.getByRole('alert').textContent).toMatch(/^0\.5\.0 has local changes in 1 file this landing touches/)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'I\'ll fix it' })).toBeNull()
  })

  it('shows git\'s message when blocked without files', () => {
    mount({ state: 'blocked', files: [], message: 'The stream\'s worktree is not on 0.5.0' })
    expect(screen.getByText('Couldn\'t land into 0.5.0')).toBeTruthy()
    expect(screen.getByText('The stream\'s worktree is not on 0.5.0')).toBeTruthy()
  })

  it('shows a running landing', () => {
    mount({ state: 'landing', intent: 'update' })
    expect(screen.getByRole('status').textContent).toBe('Updating from 0.5.0…')
  })
})
