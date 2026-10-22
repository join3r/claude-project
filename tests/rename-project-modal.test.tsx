// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import RenameProjectModal, { runningSummary } from '../src/renderer/components/RenameProjectModal'
import { createMainStream, type Project } from '../src/shared/types'

void React

const project: Project = { id: 'p', name: 'app', directory: '/code/app', streams: [createMainStream('p')] }
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    renameProjectCheck: vi.fn(async (_id: string, { name }: { name: string }) => ({ target: `/code/${name}`, blockers: [], running: { terminals: 2, agents: 0, chats: 1 } })),
    renameProjectFolder: vi.fn(async (_id: string, { name }: { name: string }) => ({ directory: `/code/${name}`, warnings: [] }))
  }
  ;(window as unknown as { api: unknown }).api = api
})
afterEach(cleanup)

function renderModal(overrides: Partial<{ project: Project; folderMissing: boolean }> = {}) {
  const onRenameOnly = vi.fn()
  const onClose = vi.fn()
  render(<RenameProjectModal project={overrides.project ?? project} folderMissing={overrides.folderMissing ?? false} onRenameOnly={onRenameOnly} onClose={onClose} />)
  return { onRenameOnly, onClose }
}

describe('RenameProjectModal', () => {
  it('words the running tabs', () => {
    expect(runningSummary({ terminals: 2, agents: 0, chats: 1 })).toBe('2 terminals and 1 chat')
    expect(runningSummary({ terminals: 1, agents: 1, chats: 2 })).toBe('1 terminal, 1 agent and 2 chats')
  })

  it('renames the folder too when the names match, after saying what it stops', async () => {
    const { onClose, onRenameOnly } = renderModal()
    fireEvent.change(screen.getByDisplayValue('app'), { target: { value: 'web' } })
    expect((await screen.findByTestId('rename-running')).textContent).toContain('2 terminals and 1 chat will stop')
    expect(screen.getByText('app → web')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop and rename' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.renameProjectFolder).toHaveBeenCalledWith('p', { name: 'web', folder: true, stop: true })
    expect(onRenameOnly).not.toHaveBeenCalled()
  })

  it('asks again when more started running after the check', async () => {
    api.renameProjectCheck
      .mockResolvedValueOnce({ target: '/code/web', blockers: [], running: { terminals: 0, agents: 0, chats: 0 } })
      .mockResolvedValue({ target: '/code/web', blockers: [], running: { terminals: 1, agents: 0, chats: 0 } })
    const { onClose } = renderModal()
    fireEvent.change(screen.getByDisplayValue('app'), { target: { value: 'web' } })
    await screen.findByText('app → web')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect((await screen.findByTestId('rename-running')).textContent).toContain('1 terminal will stop and start again in the new folder when you next open it.')
    expect(api.renameProjectFolder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop and rename' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.renameProjectFolder).toHaveBeenCalledWith('p', { name: 'web', folder: true, stop: true })
  })

  it('shows what blocks the rename and keeps Rename off', async () => {
    api.renameProjectCheck.mockResolvedValue({ target: '/code/web', blockers: ['Wait for the agents working in "fix" to finish.'], running: { terminals: 0, agents: 0, chats: 1 } })
    renderModal()
    fireEvent.change(screen.getByDisplayValue('app'), { target: { value: 'web' } })
    expect((await screen.findByTestId('rename-blockers')).textContent).toContain('"fix"')
    expect((screen.getByRole('button', { name: 'Stop and rename' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('only renames when the folder name differs from the project or the folder is gone', async () => {
    const { onRenameOnly, onClose } = renderModal({ project: { ...project, name: 'My App' } })
    fireEvent.change(screen.getByDisplayValue('My App'), { target: { value: 'Web' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRenameOnly).toHaveBeenCalledWith('Web')
    expect(onClose).toHaveBeenCalled()
    expect(api.renameProjectCheck).not.toHaveBeenCalled()
    cleanup()
    renderModal({ folderMissing: true })
    expect(screen.getByText(/The folder is gone/)).toBeTruthy()
  })
})
