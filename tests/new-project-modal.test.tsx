// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewProjectModal from '../src/renderer/components/NewProjectModal'

void React

let api: Record<string, ReturnType<typeof vi.fn> | string>

beforeEach(() => {
  api = {
    platform: 'darwin',
    createProjectDir: vi.fn().mockResolvedValue('/code/app'),
    pickDirectory: vi.fn().mockResolvedValue('/elsewhere')
  }
  ;(window as unknown as { api: unknown }).api = api
})

afterEach(cleanup)

function renderModal(projectsDir: string) {
  const onCreated = vi.fn()
  const onChangeProjectsDir = vi.fn()
  render(
    <NewProjectModal
      projectsDir={projectsDir}
      onChangeProjectsDir={onChangeProjectsDir}
      onCreated={onCreated}
      onCancel={() => {}}
      allTags={[]}
      onEnsureTag={() => ''}
    />
  )
  return { onCreated, onChangeProjectsDir }
}

describe('NewProjectModal', () => {
  it('creates the folder under the projects folder and adds the project', async () => {
    const { onCreated } = renderModal('/code')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: ' app ' } })
    expect(screen.getByText('/code/app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('app', '/code/app', undefined))
    expect(api.createProjectDir).toHaveBeenCalledWith('app')
  })

  it('shows why main refused, and stays open', async () => {
    ;(api.createProjectDir as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Error invoking remote method 'project-dirs:create': Error: /code/app already exists."))
    const { onCreated } = renderModal('/code')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/code/app already exists.')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('needs a projects folder before it can create', async () => {
    const { onChangeProjectsDir } = renderModal('')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'app' } })
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(onChangeProjectsDir).toHaveBeenCalledWith('/elsewhere'))
  })
})
