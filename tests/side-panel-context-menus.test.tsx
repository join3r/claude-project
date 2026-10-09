// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GitStatusResult } from '../src/shared/types'

void React

const app = {
  selectedProjectId: 'p1',
  selectedTaskId: 't1',
  notes: { p1: [{ id: 'n1', name: 'Ideas' }] },
  createNote: vi.fn(),
  renameNote: vi.fn(),
  deleteNote: vi.fn(),
  openOrFocusNoteTab: vi.fn()
}
vi.mock('../src/renderer/context/AppContext', () => ({ useApp: () => app }))

const { default: NotesList } = await import('../src/renderer/components/NotesList')
const { default: GitStatus } = await import('../src/renderer/components/GitStatus')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    revealInFolder: vi.fn(() => Promise.resolve()),
    fbGitDiscard: vi.fn(() => Promise.resolve({ ok: true })),
    fbGitStage: vi.fn(() => Promise.resolve({ ok: true }))
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('notes right-click menu', () => {
  it('opens, renames and deletes (after asking)', () => {
    render(<NotesList />)
    fireEvent.contextMenu(screen.getByText('Ideas'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(app.openOrFocusNoteTab).toHaveBeenCalledWith('p1', 't1', 'focused', 'n1')

    fireEvent.contextMenu(screen.getByText('Ideas'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Ideas')
    fireEvent.change(input, { target: { value: 'Plans' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(app.renameNote).toHaveBeenCalledWith('p1', 'n1', 'Plans')

    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    fireEvent.contextMenu(screen.getByText('Ideas'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(confirm).toHaveBeenCalled()
    expect(app.deleteNote).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.contextMenu(screen.getByText('Ideas'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(app.deleteNote).toHaveBeenCalledWith('p1', 'n1')
  })
})

describe('git panel right-click menu', () => {
  const status: GitStatusResult = {
    staged: [],
    unstaged: [{ relativePath: 'src/a.ts', status: 'M' }, { relativePath: 'gone.ts', status: 'D' }],
    untracked: [],
    summary: {} as GitStatusResult['summary'],
    repos: []
  }
  status.repos = [{ path: '', staged: status.staged, unstaged: status.unstaged, untracked: status.untracked }]

  it('reveals a file, and discards only after asking', () => {
    render(<GitStatus gitStatus={status} projectDir="/repo" onFileClick={vi.fn()} />)
    fireEvent.contextMenu(screen.getByText('src/a.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    expect(window.api.revealInFolder).toHaveBeenCalledWith('/repo', 'src/a.ts', undefined)

    vi.stubGlobal('confirm', vi.fn(() => true))
    fireEvent.contextMenu(screen.getByText('src/a.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
    expect(window.api.fbGitDiscard).toHaveBeenCalledWith('/repo', '', ['src/a.ts'], undefined)
  })

  it('gives each nested repo its own block, with repo-relative rows and operations', () => {
    const entry = { relativePath: 'lib/x/b.ts', status: 'M' as const }
    const nested: GitStatusResult = {
      staged: [], unstaged: [entry], untracked: [], summary: {} as GitStatusResult['summary'],
      repos: [{ path: 'lib/x', staged: [], unstaged: [entry], untracked: [] }]
    }
    render(<GitStatus gitStatus={nested} projectDir="/repo" onFileClick={vi.fn()} />)
    expect(screen.getByText('lib/x')).toBeTruthy()
    vi.stubGlobal('confirm', vi.fn(() => true))
    fireEvent.contextMenu(screen.getByText('b.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
    expect(window.api.fbGitDiscard).toHaveBeenCalledWith('/repo', 'lib/x', ['lib/x/b.ts'], undefined)
  })

  it('shows why a repo was skipped instead of a commit box', () => {
    const skipped: GitStatusResult = {
      staged: [], unstaged: [], untracked: [], summary: {} as GitStatusResult['summary'],
      repos: [{ path: 'vendor/x', staged: [], unstaged: [], untracked: [], skipped: 'Not scanned: filters' }]
    }
    render(<GitStatus gitStatus={skipped} projectDir="/repo" onFileClick={vi.fn()} />)
    expect(screen.getByText('Not scanned: filters')).toBeTruthy()
    expect(screen.queryByPlaceholderText('Commit message…')).toBeNull()
  })

  it('says so when the project holds no repo at all', () => {
    const none: GitStatusResult = { staged: [], unstaged: [], untracked: [], summary: {} as GitStatusResult['summary'], repos: [] }
    render(<GitStatus gitStatus={none} projectDir="/repo" onFileClick={vi.fn()} />)
    expect(screen.getByText('Not a git repository')).toBeTruthy()
  })

  it('offers no reveal for a deleted file', () => {
    render(<GitStatus gitStatus={status} projectDir="/repo" onFileClick={vi.fn()} />)
    fireEvent.contextMenu(screen.getByText('gone.ts'))
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Stage' })).toBeTruthy()
  })
})
