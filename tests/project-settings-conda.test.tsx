// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMainStream, type Project } from '../src/shared/types'

void React

vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({
    effectiveTheme: 'dark' as const,
    tags: [],
    addTag: () => ''
  })
}))

vi.mock('../src/renderer/components/dashboardIcons', () => ({
  fetchDashboardIconsMetadata: () => Promise.resolve({}),
  searchDashboardIcons: () => [],
  dashboardIconUrl: () => ''
}))

import ProjectSettings from '../src/renderer/components/ProjectSettings'

function localProject(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    directory: 'C:\\Repos\\demo',
    streams: [createMainStream('p1')],
    ...patch
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  ;(window as unknown as { api: { condaListEnvs: ReturnType<typeof vi.fn>; pickDirectory: ReturnType<typeof vi.fn> } }).api = {
    condaListEnvs: vi.fn().mockResolvedValue({
      executable: { kind: 'conda', file: 'C:\\Users\\me\\miniconda3\\Scripts\\conda.exe' },
      envs: [
        { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
        { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }
      ]
    }),
    pickDirectory: vi.fn().mockResolvedValue(null)
  }
})

afterEach(() => {
  cleanup()
})

describe('ProjectSettings conda picker', () => {
  it('lists conda envs and saves the selected name and prefix', async () => {
    const onSave = vi.fn()
    render(<ProjectSettings project={localProject()} onSave={onSave} onClose={vi.fn()} />)
    const picker = await screen.findByRole('combobox', { name: 'Conda environment' })
    await waitFor(() => {
      expect((picker as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'ml' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        condaEnvName: 'ml',
        condaEnvPrefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
      })
    )
    expect(
      screen.getByText(/Save, then open a new tab/, { exact: false })
    ).toBeTruthy()
    expect(screen.getByText(/conda init cannot leave you on base/, { exact: false })).toBeTruthy()
  })

  it('keeps a (saved) option when the stored prefix is not in the live list', async () => {
    render(
      <ProjectSettings
        project={localProject({
          condaEnvName: 'gone',
          condaEnvPrefix: 'D:\\gone\\envs\\gone'
        })}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole('combobox', { name: 'Conda environment' }))
    expect(await screen.findByRole('option', { name: 'gone (saved)' })).toBeTruthy()
  })

  it('hides the picker on remote projects', () => {
    render(
      <ProjectSettings
        project={localProject({
          ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/x' }
        })}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Conda environment')).toBeNull()
  })

  it('lists a server project\'s envs on its server, and browses the server\'s folders for its directory', async () => {
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.condaListEnvs.mockResolvedValue({
      executable: { kind: 'micromamba', file: '/home/me/bin/micromamba' },
      envs: [{ name: 'torch', prefix: '/home/me/micromamba/envs/torch' }]
    })
    api.serverListDirs = vi.fn((_host: string, dir: string) => Promise.resolve(dir === '/home/me/apps'
      ? { path: '/home/me/apps', parent: '/home/me', entries: [{ name: 'api', path: '/home/me/apps/api', git: true }] }
      : { path: '/home/me/apps/api', parent: '/home/me/apps', entries: [] }))
    const onSave = vi.fn()
    render(
      <ProjectSettings
        project={localProject({ directory: '/home/me/apps', host: 'srvA' })}
        onSave={onSave}
        onClose={vi.fn()}
      />
    )
    const picker = await screen.findByRole('combobox', { name: 'Conda environment' })
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false))
    expect(api.condaListEnvs).toHaveBeenCalledWith('p1')

    // Browse… lists the server's folders (no native dialog for them).
    fireEvent.click(screen.getByTitle('Browse'))
    expect(api.pickDirectory).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByText('api'))
    await waitFor(() => expect(api.serverListDirs).toHaveBeenLastCalledWith('srvA', '/home/me/apps/api', { showHidden: false }))
    fireEvent.click(screen.getByText('Use this folder'))
    expect((screen.getByPlaceholderText('/path/to/project') as HTMLInputElement).value).toBe('/home/me/apps/api')

    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'torch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/home/me/apps/api',
      condaEnvName: 'torch',
      condaEnvPrefix: '/home/me/micromamba/envs/torch'
    }))
  })
})
