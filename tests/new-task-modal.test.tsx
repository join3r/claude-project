// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import React from 'react'
import { render, fireEvent, screen, act, cleanup, waitFor } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

import NewTaskModal from '../src/renderer/components/NewTaskModal'
import type { Project, WorkspaceConfig } from '../src/shared/types'

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, name, directory: `/repos/${id}`, tasks: [], ...extra }
}

const PROJECTS: Project[] = [
  project('p1', 'devtool'),
  project('p2', 'notes'),
  project('p3', 'scripts', { shellCommand: { command: 'htop' } })
]

let onCreate: Mock<(projectId: string, name: string) => void>
let onCreateWorkspace: Mock<(projectId: string, name: string, workspace: WorkspaceConfig) => void>
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
  onCreateWorkspace = vi.fn()
  onClose = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    workspaceListBranches: vi.fn().mockResolvedValue(['master', 'feature/old']),
    workspaceCreate: vi.fn().mockResolvedValue({
      worktreePath: '/repos/p1/.worktrees/fix-the-badge',
      branchName: 'fix-the-badge',
      relativeProjectPath: ''
    }),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' })
  }
})

afterEach(() => {
  cleanup()
})

function renderModal(defaultProjectId: string | null = 'p1', projects: Project[] = PROJECTS) {
  return render(
    <NewTaskModal
      projects={projects}
      defaultProjectId={defaultProjectId}
      getProjectDir={(p) => p.directory}
      onCreate={onCreate}
      onCreateWorkspace={onCreateWorkspace}
      onClose={onClose}
    />
  )
}

function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText('What needs doing?') as HTMLInputElement
}

function projectFilter(): HTMLInputElement {
  return screen.getByPlaceholderText('Filter projects…') as HTMLInputElement
}

/** Project rows, in the order the picker lists them. The list follows the filter. */
function projectRows(): HTMLButtonElement[] {
  const list = projectFilter().nextElementSibling as HTMLElement
  return Array.from(list.querySelectorAll('button'))
}

function projectNames(): string[] {
  return projectRows().map(b => b.textContent ?? '')
}

/** The row drawn as selected — same `bg-sel` idiom as the base-branch list. */
function selectedProject(): string | undefined {
  return projectRows().find(b => b.className.includes('bg-sel'))?.textContent ?? undefined
}

describe('NewTaskModal', () => {
  it('creates a plain task in the pre-selected project', async () => {
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: '  Fix the badge  ' } }) })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })

    expect(onCreate).toHaveBeenCalledWith('p1', 'Fix the badge')
    expect(onCreateWorkspace).not.toHaveBeenCalled()
    expect(api().workspaceCreate).not.toHaveBeenCalled()
  })

  it('falls back to the first project when nothing is selected', async () => {
    renderModal(null)
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Anything' } }) })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })
    expect(onCreate).toHaveBeenCalledWith('p1', 'Anything')
  })

  it('submits on Enter from the name field', async () => {
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Quick one' } }) })
    await act(async () => { fireEvent.keyDown(nameInput(), { key: 'Enter' }) })
    expect(onCreate).toHaveBeenCalledWith('p1', 'Quick one')
  })

  it('refuses to create without a name', async () => {
    renderModal()
    const create = screen.getByText('Create') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    await act(async () => { fireEvent.click(create) })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('creates the worktree before the task when a workspace is requested', async () => {
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })

    await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())

    // The branch is derived from the task name and the base defaults to master.
    const branch = screen.getByPlaceholderText('feature-name') as HTMLInputElement
    expect(branch.value).toBe('fix-the-badge')

    await act(async () => { fireEvent.click(screen.getByText('Create')) })

    expect(api().workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: '/repos/p1',
      name: 'fix-the-badge',
      baseBranch: 'master'
    }))
    expect(onCreateWorkspace).toHaveBeenCalledWith('p1', 'Fix the badge', {
      worktreePath: '/repos/p1/.worktrees/fix-the-badge',
      branchName: 'fix-the-badge',
      baseBranch: 'master',
      relativeProjectPath: ''
    })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('keeps a hand-edited branch name instead of re-deriving it', async () => {
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())

    const branch = screen.getByPlaceholderText('feature-name') as HTMLInputElement
    await act(async () => { fireEvent.change(branch, { target: { value: 'jr/badge' } }) })
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge again' } }) })

    expect((screen.getByPlaceholderText('feature-name') as HTMLInputElement).value).toBe('jr/badge')
  })

  it('keeps the task when the worktree fails, and shows why', async () => {
    ;api().workspaceCreate.mockRejectedValueOnce(new Error('Branch "x" already exists'))
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())
    await act(async () => { fireEvent.click(screen.getByText('Create')) })

    expect(onCreateWorkspace).not.toHaveBeenCalled()
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText('Branch "x" already exists')).toBeTruthy()
  })

  it('disables the workspace toggle for custom shell projects', async () => {
    renderModal('p3')
    const toggle = screen.getByRole('switch') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText('Not available for custom shell projects.')).toBeTruthy()
    expect(api().workspaceListBranches).not.toHaveBeenCalled()
  })

  it('shows the whole project list with the current one marked', async () => {
    renderModal('p2')
    expect(projectNames()).toEqual(['devtool', 'notes', 'scripts'])
    expect(selectedProject()).toBe('notes')
    // The name field is the one worth typing into first.
    expect(document.activeElement).toBe(nameInput())
  })

  // Tailwind emits `bg-transparent` after `bg-sel` in the utility layer, so a row
  // carrying both draws unselected — the picker looked inert even though clicking
  // and filtering worked. The background has to come from one branch only.
  it('does not let a transparent background out-rank the selected row', async () => {
    renderModal('p2')
    const selected = projectRows().find(b => b.className.includes('bg-sel'))
    expect(selected?.className).not.toContain('bg-transparent')
  })

  it('narrows the project list as you filter it', async () => {
    renderModal()
    await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'nte' } }) })
    expect(projectNames()).toEqual(['notes'])
  })

  it('picks the top match on Enter instead of creating the task', async () => {
    renderModal()
    await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'not' } }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'Enter' }) })

    expect(onCreate).not.toHaveBeenCalled()
    expect(selectedProject()).toBe('notes')

    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Write it up' } }) })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })
    expect(onCreate).toHaveBeenCalledWith('p2', 'Write it up')
  })

  it('walks the list with the arrow keys, starting from the selected project', async () => {
    renderModal()
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowDown' }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowDown' }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'Enter' }) })
    expect(selectedProject()).toBe('notes')

    // And it stops at the ends rather than wrapping.
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'ArrowUp' }) })
    await act(async () => { fireEvent.keyDown(projectFilter(), { key: 'Enter' }) })
    expect(selectedProject()).toBe('devtool')
  })

  it('keeps the project filter clear of the branch filter', async () => {
    renderModal()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())

    const branchFilter = screen.getByPlaceholderText('Filter branches…') as HTMLInputElement
    await act(async () => { fireEvent.change(branchFilter, { target: { value: 'feature' } }) })
    await act(async () => { fireEvent.change(projectFilter(), { target: { value: 'not' } }) })
    expect((screen.getByPlaceholderText('Filter branches…') as HTMLInputElement).value).toBe('feature')

    // Switching project drops the old repo's branches, filter included.
    await act(async () => { fireEvent.click(projectRows()[0]) })
    expect(projectFilter().value).toBe('not')
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Filter branches…') as HTMLInputElement).value).toBe('')
    })
  })

  it('drops the filter input when there is only one project to pick', async () => {
    renderModal('p1', [PROJECTS[0]])
    expect(screen.queryByPlaceholderText('Filter projects…')).toBeNull()
    expect(screen.getByRole('button', { name: 'devtool' })).toBeTruthy()
  })

  it('still asks for a project when there are none', async () => {
    renderModal(null, [])
    expect(screen.getByText('Add a project first — tasks live inside one.')).toBeTruthy()
    expect(screen.queryByPlaceholderText('Filter projects…')).toBeNull()
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
      await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Fix the badge' } }) })
      await act(async () => { fireEvent.click(screen.getByRole('switch')) })
      await waitFor(() => expect(api().workspaceListBranches).toHaveBeenCalled())
      await act(async () => { fireEvent.click(screen.getByText('Create')) })
      expect(screen.getByText('Creating…')).toBeTruthy()
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
      expect(screen.getByText('Cancelling…')).toBeTruthy()

      await act(async () => {
        pending.resolve({
          worktreePath: '/repos/p1/.worktrees/fix-the-badge',
          branchName: 'fix-the-badge',
          relativeProjectPath: ''
        })
        await pending.promise
      })

      // onCreateWorkspace is the only thing that adds and selects the task
      // (Sidebar's addWorkspaceTask hangs off it), so never calling it is the fix.
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(onCreateWorkspace).not.toHaveBeenCalled()
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
      expect(onCreateWorkspace).not.toHaveBeenCalled()
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
      expect(onCreateWorkspace).not.toHaveBeenCalled()
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
        expect(onCreateWorkspace).not.toHaveBeenCalled()
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
      expect(onCreateWorkspace).not.toHaveBeenCalled()
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

      expect(onCreateWorkspace).toHaveBeenCalledWith('p1', 'Fix the badge', {
        worktreePath: '/repos/p1/.worktrees/fix-the-badge',
        branchName: 'fix-the-badge',
        baseBranch: 'master',
        relativeProjectPath: ''
      })
      expect(api().workspaceDelete).not.toHaveBeenCalled()
    })
  })
})
