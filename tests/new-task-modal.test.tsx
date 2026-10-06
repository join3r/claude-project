// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import React from 'react'
import { render, fireEvent, screen, act, cleanup, waitFor } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

import NewTaskModal from '../src/renderer/components/NewTaskModal'
import type { NewTaskSubmission, NewTaskTarget } from '../src/renderer/components/newTask'
import type { AppConfig, Project } from '../src/shared/types'

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, name, directory: `/repos/${id}`, tasks: [], ...extra }
}

const PROJECTS: Project[] = [
  project('p1', 'devtool'),
  project('p2', 'notes'),
  project('p3', 'scripts', { shellCommand: { command: 'htop' } })
]

type ComposerConfig = Pick<AppConfig, 'enableClaude' | 'enableCodex' | 'enablePi' | 'promptBoxAgent' | 'promptBoxMode'>
const CONFIG: ComposerConfig = { enableClaude: true, enableCodex: true, enablePi: false, promptBoxAgent: 'claude-chat', promptBoxMode: '' }

/** The target shorthand the assertions read best in. */
const inProject = (projectId: string): NewTaskTarget => ({ kind: 'project', projectId })
const inDir = (directory: string): NewTaskTarget => ({ kind: 'dir', directory })

let onCreate: Mock<(submission: NewTaskSubmission) => void>
let onAddProject: Mock<(name: string, directory: string, tagIds?: string[]) => Project>
let onClose: Mock<() => void>

interface CreateResult {
  worktreePath: string
  branchName: string
  relativeProjectPath: string
}

/** The IPC calls the modal makes; window.api is only defined under Electron. */
function api(): {
  workspaceListBranches: Mock<(req: unknown) => Promise<string[]>>
  workspaceCreate: Mock<(req: unknown) => Promise<CreateResult>>
  workspaceDelete: Mock<(req: unknown) => Promise<{ status: string }>>
  pickDirectory: Mock<() => Promise<string | null>>
} {
  return (window as unknown as { api: ReturnType<typeof api> }).api
}

/** A promise the test settles by hand, to hold a creation open across a cancel. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // jsdom has no layout, so keeping the cursor row visible is a no-op here.
  Element.prototype.scrollIntoView = vi.fn()
  onCreate = vi.fn()
  onAddProject = vi.fn((name: string, directory: string) => project('p9', name, { directory }))
  onClose = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    workspaceListBranches: vi.fn().mockResolvedValue(['master', 'feature/old']),
    workspaceCreate: vi.fn().mockResolvedValue({
      worktreePath: '/repos/p1/.worktrees/fix-the-badge',
      branchName: 'fix-the-badge',
      relativeProjectPath: ''
    }),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' }),
    pickDirectory: vi.fn().mockResolvedValue('/tmp/scratch')
  }
})

afterEach(() => {
  cleanup()
})

function modal(defaultProjectId: string | null, projects: Project[], config: ComposerConfig = CONFIG): React.ReactElement {
  return (
    <NewTaskModal
      projects={projects}
      defaultProjectId={defaultProjectId}
      getProjectDir={(p) => p.directory}
      config={config}
      allTags={[]}
      onEnsureTag={() => 't1'}
      onAddProject={onAddProject}
      onCreate={onCreate}
      onClose={onClose}
    />
  )
}

function renderModal(defaultProjectId: string | null = 'p1', projects: Project[] = PROJECTS, config?: ComposerConfig) {
  return render(modal(defaultProjectId, projects, config))
}

function promptInput(): HTMLTextAreaElement {
  return screen.getByLabelText('First prompt') as HTMLTextAreaElement
}

async function typePrompt(text: string): Promise<void> {
  await act(async () => { fireEvent.change(promptInput(), { target: { value: text } }) })
}

async function submit(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByLabelText('Create task')) })
}

function createButton(): HTMLButtonElement {
  return screen.getByLabelText('Create task') as HTMLButtonElement
}

function pickerButton(): HTMLButtonElement {
  return screen.getByLabelText('Project') as HTMLButtonElement
}

async function openPicker(): Promise<void> {
  await act(async () => { fireEvent.click(pickerButton()) })
}

function projectFilter(): HTMLInputElement {
  return screen.getByPlaceholderText('Filter projects…') as HTMLInputElement
}

/** Destination rows, in the order the picker lists them. The list follows the filter. */
function projectRows(): HTMLButtonElement[] {
  const list = screen.getByRole('group', { name: 'Destination' })
  return Array.from(list.querySelectorAll('button'))
}

function projectNames(): string[] {
  // Ad-hoc rows carry a "dir" badge inside the button; the label is the first span.
  return projectRows().map(b => b.querySelector('span')?.textContent ?? '')
}

/** The row drawn as selected. */
function selectedProject(): string | undefined {
  const row = projectRows().find(b => b.className.includes('bg-sel'))
  return row?.querySelector('span')?.textContent ?? undefined
}

/** What the picker button says the task goes into. */
function destination(): string {
  return pickerButton().querySelector('span')?.textContent ?? ''
}

async function chooseFromPicker(label: string): Promise<void> {
  await openPicker()
  await act(async () => { fireEvent.click(screen.getByText(label)) })
}

async function turnOnWorkspace(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())
  await waitFor(() => expect(createButton().disabled).toBe(false))
}

const WORKTREE = {
  worktreePath: '/repos/p1/.worktrees/fix-the-badge',
  branchName: 'fix-the-badge',
  baseBranch: 'master',
  relativeProjectPath: ''
}

describe('NewTaskModal', () => {
  it('starts the remembered agent on the first prompt, in the pre-selected project', async () => {
    renderModal()
    expect(document.activeElement).toBe(promptInput())
    await typePrompt('  Fix the badge  ')
    await submit()

    expect(onCreate).toHaveBeenCalledWith({
      target: inProject('p1'),
      start: { agent: 'claude-chat', prompt: { text: 'Fix the badge' } }
    })
    expect(api().workspaceCreate).not.toHaveBeenCalled()
  })

  it('submits on Enter and keeps Shift+Enter for a new line', async () => {
    renderModal()
    await typePrompt('Quick one')
    await act(async () => { fireEvent.keyDown(promptInput(), { key: 'Enter', shiftKey: true }) })
    expect(onCreate).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(promptInput(), { key: 'Enter' }) })
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ start: expect.objectContaining({ prompt: { text: 'Quick one' } }) }))
  })

  it('creates an empty task when sent without a prompt', async () => {
    renderModal()
    expect(createButton().disabled).toBe(false)
    await submit()
    expect(onCreate).toHaveBeenCalledWith({ target: inProject('p1'), start: undefined })
  })

  it('falls back to the first project when nothing is selected', async () => {
    renderModal(null)
    expect(destination()).toBe('devtool')
    await submit()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: inProject('p1') }))
  })

  it('hands the chosen agent, model and mode on with the prompt', async () => {
    renderModal()
    await act(async () => { fireEvent.click(screen.getByTitle('Model')) })
    await act(async () => { fireEvent.click(screen.getByText('Opus')) })
    // Shift+Tab cycles the permission mode, as in the prompt box.
    await act(async () => { fireEvent.keyDown(promptInput(), { key: 'Tab', shiftKey: true }) })
    await typePrompt('Plan it')
    await submit()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      start: { agent: 'claude-chat', prompt: { text: 'Plan it', model: 'opus', mode: 'default' } }
    }))
  })

  it('drops the Claude-only options for another agent', async () => {
    renderModal()
    await act(async () => { fireEvent.click(screen.getByTitle('Agent')) })
    await act(async () => { fireEvent.click(screen.getByText('Codex')) })
    expect(screen.queryByTitle('Model')).toBeNull()
    await typePrompt('Port it')
    await submit()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      start: { agent: 'codex', prompt: { text: 'Port it' } }
    }))
  })

  describe('images', () => {
    // "PNG" in base64, small enough to read back as-is.
    const png = (): File => new File(['PNG'], 'shot.png', { type: 'image/png' })

    async function pasteImage(): Promise<void> {
      await act(async () => { fireEvent.paste(promptInput(), { clipboardData: { files: [png()] } }) })
      await waitFor(() => expect(screen.getAllByLabelText('Remove image')).toHaveLength(1))
    }

    it('sends a pasted image to Claude with the first prompt', async () => {
      renderModal()
      await pasteImage()
      await typePrompt('What is wrong here?')
      await submit()
      expect(onCreate).toHaveBeenCalledWith({
        target: inProject('p1'),
        start: { agent: 'claude-chat', prompt: { text: 'What is wrong here?', images: [{ mediaType: 'image/png', data: 'UE5H' }] } }
      })
    })

    it('takes dropped images too, and lets one be removed', async () => {
      renderModal()
      const box = promptInput().parentElement as HTMLElement
      await act(async () => { fireEvent.drop(box, { dataTransfer: { files: [png(), png()], types: ['Files'] } }) })
      await waitFor(() => expect(screen.getAllByLabelText('Remove image')).toHaveLength(2))
      await act(async () => { fireEvent.click(screen.getAllByLabelText('Remove image')[0]) })
      expect(screen.getAllByLabelText('Remove image')).toHaveLength(1)
    })

    it('will not start on images alone', async () => {
      renderModal()
      await pasteImage()
      expect(createButton().disabled).toBe(true)
      expect(screen.getByText('Add a prompt to send the images with.')).toBeTruthy()
      await typePrompt('Look')
      expect(createButton().disabled).toBe(false)
    })

    it('ignores images for an agent that cannot take them', async () => {
      renderModal()
      await act(async () => { fireEvent.click(screen.getByTitle('Agent')) })
      await act(async () => { fireEvent.click(screen.getByText('Codex')) })
      await act(async () => { fireEvent.paste(promptInput(), { clipboardData: { files: [png()] } }) })
      expect(screen.queryByLabelText('Remove image')).toBeNull()
      await typePrompt('Port it')
      await submit()
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
        start: { agent: 'codex', prompt: { text: 'Port it' } }
      }))
    })
  })

  it('closes a chip menu on Escape without closing the dialog', async () => {
    renderModal()
    await act(async () => { fireEvent.click(screen.getByTitle('Agent')) })
    expect(screen.getByText('Codex')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryByText('Codex')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cuts the worktree first, with the branch named after the prompt', async () => {
    renderModal()
    await typePrompt('Fix the badge')
    await turnOnWorkspace()
    expect(screen.getByText('from master')).toBeTruthy()
    await submit()

    expect(api().workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: '/repos/p1',
      name: 'fix-the-badge',
      baseBranch: 'master'
    }))
    expect(onCreate).toHaveBeenCalledWith({
      target: inProject('p1'),
      start: { agent: 'claude-chat', prompt: { text: 'Fix the badge' } },
      workspace: WORKTREE
    })
  })

  it('steps to the next branch name when the first one is taken', async () => {
    api().workspaceCreate.mockRejectedValueOnce(new Error("fatal: a branch named 'fix-the-badge' already exists"))
    renderModal()
    await typePrompt('Fix the badge')
    await turnOnWorkspace()
    await submit()
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(api().workspaceCreate).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'fix-the-badge-2' }))
  })

  it('leaves a workspace with no prompt pending instead of cutting a worktree now', async () => {
    renderModal()
    await turnOnWorkspace()
    await submit()

    expect(api().workspaceCreate).not.toHaveBeenCalled()
    expect(onCreate).toHaveBeenCalledWith({ target: inProject('p1'), workspaceDraft: { baseBranch: 'master' } })
  })

  it('keeps the task when the worktree fails, and shows why', async () => {
    api().workspaceCreate.mockRejectedValueOnce(new Error('fatal: not a git repository'))
    renderModal()
    await typePrompt('Fix the badge')
    await turnOnWorkspace()
    await submit()

    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText('fatal: not a git repository')).toBeTruthy()
  })

  it('takes no prompt and no workspace for a custom shell project', async () => {
    renderModal('p3')
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    expect(promptInput().disabled).toBe(true)
    expect(screen.queryByTitle('Agent')).toBeNull()
    await submit()
    expect(onCreate).toHaveBeenCalledWith({ target: inProject('p3'), start: undefined })
    expect(api().workspaceListBranches).not.toHaveBeenCalled()
  })

  it('opens a blank task when no agent is switched on', async () => {
    renderModal('p1', PROJECTS, { ...CONFIG, enableClaude: false, enableCodex: false })
    expect(promptInput().disabled).toBe(true)
    await submit()
    expect(onCreate).toHaveBeenCalledWith({ target: inProject('p1'), start: undefined })
  })

  describe('the project picker', () => {
    it('lists every project with the current one marked', async () => {
      renderModal('p2')
      expect(destination()).toBe('notes')
      await openPicker()
      expect(projectNames()).toEqual(['devtool', 'notes', 'scripts'])
      expect(selectedProject()).toBe('notes')
    })

    // Tailwind emits `bg-transparent` after `bg-sel` in the utility layer, so a row
    // carrying both draws unselected. The background has to come from one branch only.
    it('does not let a transparent background out-rank the selected row', async () => {
      renderModal('p2')
      await openPicker()
      const selected = projectRows().find(b => b.className.includes('bg-sel'))
      expect(selected?.className).not.toContain('bg-transparent')
    })

    it('switches the destination on click and closes', async () => {
      renderModal()
      await openPicker()
      await act(async () => { fireEvent.click(screen.getByText('notes')) })
      expect(screen.queryByRole('group', { name: 'Destination' })).toBeNull()
      expect(destination()).toBe('notes')
      await submit()
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: inProject('p2') }))
    })

    it('narrows the list as you filter it', async () => {
      renderModal()
      await openPicker()
      await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'nte' } }) })
      expect(projectNames()).toEqual(['notes'])
    })

    // Filtering hid the pre-selected project and the highlight moved to the only
    // visible row; creating must agree with what is highlighted.
    it('creates in the highlighted project after the filter hides the default one', async () => {
      renderModal('p1')
      await openPicker()
      await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'not' } }) })
      expect(selectedProject()).toBe('notes')
      expect(destination()).toBe('notes')
      await submit()
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: inProject('p2') }))
    })

    it('hands Enter in the filter back to the prompt rather than creating', async () => {
      renderModal()
      await openPicker()
      await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'not' } }) })
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'Enter' }) })
      expect(onCreate).not.toHaveBeenCalled()
      expect(screen.queryByRole('group', { name: 'Destination' })).toBeNull()
      expect(destination()).toBe('notes')
    })

    it('walks the list with the arrow keys, stopping at the ends', async () => {
      renderModal()
      await openPicker()
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowDown' }) })
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowDown' }) })
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
      expect(selectedProject()).toBe('notes')
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
      await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
      expect(selectedProject()).toBe('devtool')
    })

    it('closes on Escape before the dialog does', async () => {
      renderModal()
      await openPicker()
      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
      expect(screen.queryByRole('group', { name: 'Destination' })).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
      expect(onClose).toHaveBeenCalled()
    })

    it('drops the filter input when there is only one project to pick', async () => {
      renderModal('p1', [PROJECTS[0]])
      await openPicker()
      expect(screen.queryByPlaceholderText('Filter projects…')).toBeNull()
      expect(projectNames()).toEqual(['devtool'])
    })

    it('offers a way out when there are no projects at all', async () => {
      renderModal(null, [])
      expect(screen.getByText('Tasks live in a project — add one, or point this task at a directory.')).toBeTruthy()
      expect(createButton().disabled).toBe(true)
      await openPicker()
      expect(screen.getByText('New project…')).toBeTruthy()
      expect(screen.getByText('Use a directory…')).toBeTruthy()
    })
  })

  describe('adding a destination', () => {
    it('creates a project and selects it', async () => {
      const { rerender } = renderModal()
      await chooseFromPicker('New project…')

      const dirField = screen.getByPlaceholderText('/path/to/project') as HTMLInputElement
      await act(async () => { fireEvent.change(dirField, { target: { value: '/repos/p9' } }) })
      const nameField = screen.getByPlaceholderText('My Project') as HTMLInputElement
      await act(async () => { fireEvent.change(nameField, { target: { value: 'new-thing' } }) })
      await act(async () => { fireEvent.click(screen.getByText('Add')) })

      expect(onAddProject).toHaveBeenCalledWith('new-thing', '/repos/p9', undefined)
      expect(screen.queryByPlaceholderText('/path/to/project')).toBeNull()

      // The parent hands the new project back down on its next render; until it
      // does, the selection must survive rather than snapping to the top match.
      await act(async () => {
        rerender(modal('p1', [...PROJECTS, project('p9', 'new-thing', { directory: '/repos/p9' })]))
      })
      expect(destination()).toBe('new-thing')

      await typePrompt('Kick off')
      await submit()
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: inProject('p9') }))
    })

    it('peels off the nested dialog on Escape before the composer', async () => {
      renderModal()
      await chooseFromPicker('New project…')

      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
      expect(screen.queryByPlaceholderText('/path/to/project')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
      expect(onClose).toHaveBeenCalled()
    })

    it('files the task against a picked directory without creating a project', async () => {
      renderModal()
      await chooseFromPicker('Use a directory…')

      expect(api().pickDirectory).toHaveBeenCalled()
      expect(destination()).toBe('scratch')
      expect(onAddProject).not.toHaveBeenCalled()
      // Pinned at the top of the list and marked as not-a-project.
      await openPicker()
      expect(projectNames()).toEqual(['scratch', 'devtool', 'notes', 'scripts'])
      expect(selectedProject()).toBe('scratch')

      await typePrompt('Poke at it')
      await submit()
      expect(onCreate).toHaveBeenCalledWith({
        target: inDir('/tmp/scratch'),
        start: { agent: 'claude-chat', prompt: { text: 'Poke at it' } }
      })
    })

    it('keeps the picked directory visible through a filter that excludes everything', async () => {
      renderModal()
      await chooseFromPicker('Use a directory…')
      await openPicker()
      await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'zzz' } }) })
      expect(projectNames()).toEqual(['scratch'])
      expect(selectedProject()).toBe('scratch')
    })

    it('cuts a worktree in the picked directory when a workspace is asked for', async () => {
      renderModal()
      await chooseFromPicker('Use a directory…')
      await typePrompt('Fix the badge')
      await turnOnWorkspace()
      expect(api().workspaceListBranches).toHaveBeenCalledWith(expect.objectContaining({ projectDir: '/tmp/scratch' }))

      await submit()
      expect(api().workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({
        projectDir: '/tmp/scratch',
        name: 'fix-the-badge'
      }))
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
        target: inDir('/tmp/scratch'),
        workspace: expect.objectContaining({ branchName: 'fix-the-badge' })
      }))
    })

    it('stays put when the directory picker is cancelled', async () => {
      renderModal()
      api().pickDirectory.mockResolvedValueOnce(null)
      await chooseFromPicker('Use a directory…')
      expect(destination()).toBe('devtool')
    })
  })

  it('closes on Escape', async () => {
    renderModal()
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(onClose).toHaveBeenCalled()
  })

  describe('cancelling an in-flight workspace creation', () => {
    /** Get the modal as far as "Creating…", with workspaceCreate still outstanding. */
    async function startCreating(): Promise<void> {
      renderModal()
      await typePrompt('Fix the badge')
      await turnOnWorkspace()
      await submit()
      expect(screen.getByText(/Creating worktree/)).toBeTruthy()
    }

    const escape = async (): Promise<void> => {
      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    }

    it('never creates the task when the creation lands after Escape', async () => {
      const pending = deferred<CreateResult>()
      api().workspaceCreate.mockReturnValueOnce(pending.promise)
      await startCreating()

      await escape()
      // The dialog stays up saying what it is doing rather than vanishing.
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText(/^Cancelling/)).toBeTruthy()

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })

      // onCreate is the only thing that adds and selects the task, so never
      // calling it is the fix.
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(onCreate).not.toHaveBeenCalled()
    })

    it('removes the worktree that was cut after the cancel', async () => {
      const pending = deferred<CreateResult>()
      api().workspaceCreate.mockReturnValueOnce(pending.promise)
      await startCreating()
      await escape()

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })

      await waitFor(() => expect(api().workspaceDelete).toHaveBeenCalledWith(expect.objectContaining({
        projectDir: '/repos/p1',
        worktreePath: '/repos/p1/.worktrees/fix-the-badge',
        branchName: 'fix-the-badge',
        baseBranch: 'master',
        force: true
      })))
      expect(onCreate).not.toHaveBeenCalled()
    })

    it('names the orphan when it cannot be removed instead of dropping it', async () => {
      const pending = deferred<CreateResult>()
      api().workspaceCreate.mockReturnValueOnce(pending.promise)
      api().workspaceDelete.mockRejectedValueOnce(new Error('worktree is locked'))
      await startCreating()
      await escape()

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })

      await waitFor(() => expect(screen.getByText(/could not be removed/)).toBeTruthy())
      expect(screen.getByText(/\/repos\/p1\/\.worktrees\/fix-the-badge/)).toBeTruthy()
      expect(screen.getByText(/worktree is locked/)).toBeTruthy()
      // Still no task, and the dialog stays up so the message is readable.
      expect(onCreate).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('swallows a rejected creation after Escape, with nothing to unwind', async () => {
      const unhandled: unknown[] = []
      const record = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', record)
      try {
        const pending = deferred<CreateResult>()
        api().workspaceCreate.mockReturnValueOnce(pending.promise)
        await startCreating()
        await escape()

        await act(async () => {
          pending.reject(new Error('fatal: branch already exists'))
          await pending.promise.catch(() => undefined)
        })

        await waitFor(() => expect(onClose).toHaveBeenCalled())
        expect(onCreate).not.toHaveBeenCalled()
        // Nothing was cut, so there is nothing to delete — and the failure is not
        // reported, since the user is the one who called it off.
        expect(api().workspaceDelete).not.toHaveBeenCalled()
        expect(screen.queryByText('fatal: branch already exists')).toBeNull()

        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', record)
      }
    })

    it('lets a second Escape leave immediately, still without a task', async () => {
      const pending = deferred<CreateResult>()
      api().workspaceCreate.mockReturnValueOnce(pending.promise)
      await startCreating()

      await escape()
      await escape()
      expect(onClose).toHaveBeenCalledTimes(1)

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })
      expect(onCreate).not.toHaveBeenCalled()
    })

    it('still creates the task when nobody cancels', async () => {
      const pending = deferred<CreateResult>()
      api().workspaceCreate.mockReturnValueOnce(pending.promise)
      await startCreating()

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })

      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: inProject('p1'), workspace: WORKTREE }))
      expect(api().workspaceDelete).not.toHaveBeenCalled()
    })
  })
})
