// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewProjectModal, { type NewProjectHost } from '../src/renderer/components/NewProjectModal'

void React

vi.mock('../src/renderer/components/servers/ServerFolderList', () => ({
  default: ({ onListing }: { onListing: (listing: { path: string }) => void }) => (
    <button onClick={() => onListing({ path: '/srv/work' })}>pick /srv/work</button>
  )
}))

let api: Record<string, unknown>
let folders: Record<string, string>

beforeEach(() => {
  folders = { local: '/code', srv: '/home/me/code' }
  api = {
    platform: 'darwin',
    projectsFolder: vi.fn(async (host: string) => folders[host] ?? ''),
    setProjectsFolder: vi.fn(async (host: string, dir: string) => { folders[host] = dir; return dir }),
    createProjectDir: vi.fn(async (host: string, name: string) => `${folders[host]}/${name}`),
    pickDirectory: vi.fn().mockResolvedValue('/elsewhere')
  }
  ;(window as unknown as { api: unknown }).api = api
})

afterEach(cleanup)

function renderModal(hosts: NewProjectHost[] = [{ id: 'local', label: 'This computer' }]) {
  const onCreated = vi.fn()
  render(<NewProjectModal hosts={hosts} onCreated={onCreated} onCancel={() => {}} allTags={[]} onEnsureTag={() => ''} />)
  return { onCreated }
}

describe('NewProjectModal', () => {
  it('creates the folder under this computer\'s projects folder and adds the project', async () => {
    const { onCreated } = renderModal()
    await screen.findByText('/code')
    expect(screen.queryByText('Where')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: ' app ' } })
    expect(screen.getByText('/code/app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('local', 'app', '/code/app', undefined))
    expect(api.createProjectDir).toHaveBeenCalledWith('local', 'app')
  })

  it('creates on a server, in that server\'s own folder, which Change… sets there', async () => {
    const { onCreated } = renderModal([{ id: 'local', label: 'This computer' }, { id: 'srv', label: 'build-box' }])
    fireEvent.click(await screen.findByRole('button', { name: 'build-box' }))
    await screen.findByText('/home/me/code')
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
    fireEvent.click(screen.getByText('pick /srv/work'))
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await screen.findByText('/srv/work')
    expect(api.setProjectsFolder).toHaveBeenCalledWith('srv', '/srv/work')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'api' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('srv', 'api', '/srv/work/api', undefined))
  })

  it('shows why the host refused, and stays open', async () => {
    ;(api.createProjectDir as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Error invoking remote method 'project-dirs:create': Error: /code/app already exists."))
    const { onCreated } = renderModal()
    await screen.findByText('/code')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/code/app already exists.')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('needs a projects folder before it can create', async () => {
    folders.local = ''
    renderModal()
    await screen.findByText('Not set')
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'app' } })
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await screen.findByText('/elsewhere')
    expect(api.setProjectsFolder).toHaveBeenCalledWith('local', '/elsewhere')
  })
})
