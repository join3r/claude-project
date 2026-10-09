// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project, Stream, Tab, Task, TaskWorktreeState, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

void React

// The tab bodies are not under test: each shows where it would spawn.
vi.mock('../src/renderer/components/claude-chat/ClaudeChatTab', () => ({
  default: ({ projectDir }: { projectDir: string }) => React.createElement('div', { 'data-testid': 'chat-body' }, projectDir)
}))
vi.mock('../src/renderer/components/TerminalTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/EditorTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/DiffTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/NotebookTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AiToolTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/BrowserTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/NoteTab', () => ({ default: () => null }))
vi.mock('../src/renderer/components/TabBar', () => ({ default: () => null }))
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({ effectiveTheme: 'dark', setPaneWidths: () => {} })
}))

import TaskPanes from '../src/renderer/components/TaskPanes'
import { taskDirectory } from '../src/shared/streams'

const chat: Tab = { id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: 's1' }
const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/rel', branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' }
const ownWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/rel--fix', branchName: 'rel--fix', baseBranch: 'rel', relativeProjectPath: '' }

let pushState: (taskId: string, state: TaskWorktreeState | null) => void = () => {}
const api = {
  taskWorktreeEnsure: vi.fn(),
  taskWorktreeDecide: vi.fn(),
  taskWorktreeDismiss: vi.fn(),
  taskWorktreeStates: vi.fn(),
  onTaskWorktreeState: vi.fn()
}

function setup(task: Partial<Task> & { ownWorkspace?: WorkspaceConfig } = {}): { project: Project; task: Task } {
  const t = fixtureTask({ id: 't1', name: 'Fix it', tabs: { left: [chat] }, ...task })
  const stream: Stream = { id: 'stream-rel', name: 'rel', workspace: streamWs, taskWorktrees: true, tasks: [t] }
  return { project: fixtureProject({ id: 'p1', directory: '/repo', streams: [stream] }), task: t }
}

function mount(project: Project, task: Task, visible = true) {
  return render(<TaskPanes project={project} task={task} visible={visible} projectDir={taskDirectory(project, task)} />)
}

beforeAll(() => {
  api.onTaskWorktreeState.mockImplementation((cb: typeof pushState) => {
    pushState = cb
    return () => {}
  })
  api.taskWorktreeStates.mockResolvedValue({})
  ;(window as unknown as { api: typeof api }).api = api
})

beforeEach(() => {
  api.taskWorktreeEnsure.mockReset().mockResolvedValue({ status: 'failed', error: 'not now' })
  api.taskWorktreeDecide.mockReset().mockResolvedValue({ status: 'ready', workspace: ownWs })
})

afterEach(() => {
  act(() => pushState('t1', null))
  cleanup()
})

describe('TaskPanes and task worktrees', () => {
  it('asks for the worktree and holds the tabs until it is recorded', async () => {
    const { project, task } = setup()
    const view = mount(project, task)

    expect(screen.getByText('Preparing worktree…')).toBeTruthy()
    expect(screen.queryByTestId('chat-body')).toBeNull()
    expect(api.taskWorktreeEnsure).toHaveBeenCalledWith('p1', 't1', { name: 'Fix it', streamId: 'stream-rel' })

    act(() => pushState('t1', { phase: 'creating', branch: 'rel--fix-it', log: 'symlink node_modules\n' }))
    expect(screen.getByText('rel--fix-it')).toBeTruthy()
    expect(screen.getByText('symlink node_modules')).toBeTruthy()

    // Main records the worktree and clears the state: the chat starts there.
    const made = setup({ ownWorkspace: ownWs })
    act(() => pushState('t1', null))
    view.rerender(<TaskPanes project={made.project} task={made.task} visible projectDir={taskDirectory(made.project, made.task)} />)
    expect(screen.queryByTestId('task-worktree-panel')).toBeNull()
    expect(screen.getByTestId('chat-body').textContent).toBe('/repo/.worktrees/rel--fix')
  })

  it('shows the setup commands and answers with the choice', async () => {
    const { project, task } = setup({ ownWorkspace: ownWs })
    mount(project, task)
    expect(screen.getByTestId('chat-body')).toBeTruthy()

    act(() => pushState('t1', { phase: 'needs-approval', branch: 'rel--fix', pending: { repoKey: '/repo/.git', hash: 'h', commands: ['npm ci'] } }))
    expect(screen.queryByTestId('chat-body')).toBeNull()
    expect(screen.getByText('npm ci')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByText('Run setup')) })
    expect(api.taskWorktreeDecide).toHaveBeenCalledWith('t1', 'run')
    // A task that already has its worktree is never asked for one.
    expect(api.taskWorktreeEnsure).not.toHaveBeenCalled()
  })

  it('offers Retry after a git failure', async () => {
    const { project, task } = setup()
    mount(project, task)
    // Main answers, and keeps the error for the panel.
    await act(async () => {})
    act(() => pushState('t1', { phase: 'failed', error: 'fatal: invalid reference: rel' }))
    expect(screen.getByText('fatal: invalid reference: rel')).toBeTruthy()
    api.taskWorktreeEnsure.mockClear()

    fireEvent.click(screen.getByText('Retry'))
    expect(api.taskWorktreeEnsure).toHaveBeenCalledTimes(1)
  })

  it('starts a legacy task in the stream\'s worktree, and asks nothing for a hidden task', () => {
    const legacy = setup({ sharesStreamWorktree: true })
    mount(legacy.project, legacy.task)
    expect(screen.getByTestId('chat-body').textContent).toBe('/repo/.worktrees/rel')
    cleanup()

    const hidden = setup()
    mount(hidden.project, hidden.task, false)
    expect(screen.queryByTestId('chat-body')).toBeNull()
    expect(api.taskWorktreeEnsure).not.toHaveBeenCalled()
  })
})
