// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FileTree from '../src/renderer/components/FileTree'
import { FILE_BROWSER_REFRESH_MS } from '../src/renderer/hooks/fileBrowserRefresh'

void React

beforeEach(() => {
  ;(window as any).api = {
    fbReadDirectory: vi.fn()
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Drive one refresh cycle. `focus` and the poll interval share a single handler,
 * so firing focus exercises the same code path without fake-timer plumbing
 * (RTL's waitFor doesn't detect vitest's fake timers).
 */
async function tickRefresh(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('FileTree', () => {
  it('contains a missing project directory error instead of rejecting globally', async () => {
    window.api.fbReadDirectory = vi.fn().mockRejectedValue(
      new Error("ENOENT: no such file or directory, scandir '/moved/project'")
    )

    render(<FileTree projectDir="/moved/project" gitStatus={null} onFileClick={vi.fn()} />)

    expect(await screen.findByText('Project directory is unavailable')).toBeTruthy()
    expect(screen.getByText('/moved/project')).toBeTruthy()
  })

  it('recovers when the project directory is updated', async () => {
    window.api.fbReadDirectory = vi.fn((projectDir: string) => {
      if (projectDir === '/old/project') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve([
        { name: 'src', type: 'directory' as const, relativePath: 'src' }
      ])
    })

    const view = render(
      <FileTree projectDir="/old/project" gitStatus={null} onFileClick={vi.fn()} />
    )
    expect(await screen.findByText('Project directory is unavailable')).toBeTruthy()

    view.rerender(
      <FileTree projectDir="/new/project" gitStatus={null} onFileClick={vi.fn()} />
    )

    await waitFor(() => {
      expect(screen.queryByText('Project directory is unavailable')).toBeNull()
      expect(screen.getByText('src')).toBeTruthy()
    })
  })

  it('polls on the shared file-browser refresh interval', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'a.ts', type: 'file' as const, relativePath: 'a.ts' }])
    )

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    await screen.findByText('a.ts')

    expect(setIntervalSpy.mock.calls.some(([, ms]) => ms === FILE_BROWSER_REFRESH_MS)).toBe(true)
  })

  it('picks up files added on disk without a remount', async () => {
    let listing: Record<string, any[]> = { '': [{ name: 'a.ts', type: 'file', relativePath: 'a.ts' }] }
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) =>
      Promise.resolve(listing[rel] ?? [])
    )

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    expect(await screen.findByText('a.ts')).toBeTruthy()

    listing = {
      '': [
        { name: 'lib', type: 'directory', relativePath: 'lib' },
        { name: 'a.ts', type: 'file', relativePath: 'a.ts' },
        { name: 'b.ts', type: 'file', relativePath: 'b.ts' }
      ]
    }
    await tickRefresh()

    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByText('lib')).toBeTruthy()
  })

  it('refreshes expanded subdirectories too, and keeps them expanded', async () => {
    let libEntries: any[] = [{ name: 'one.ts', type: 'file', relativePath: 'lib/one.ts' }]
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) =>
      Promise.resolve(
        rel === '' ? [{ name: 'lib', type: 'directory', relativePath: 'lib' }] : libEntries
      )
    )

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.click(await screen.findByText('lib'))
    expect(await screen.findByText('one.ts')).toBeTruthy()

    libEntries = [
      { name: 'one.ts', type: 'file', relativePath: 'lib/one.ts' },
      { name: 'two.ts', type: 'file', relativePath: 'lib/two.ts' }
    ]
    await tickRefresh()

    expect(screen.getByText('one.ts')).toBeTruthy()
    expect(screen.getByText('two.ts')).toBeTruthy()
  })

  it('drops a deleted directory from the cache and from the expanded set', async () => {
    let rootEntries: any[] = [{ name: 'lib', type: 'directory', relativePath: 'lib' }]
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) => {
      if (rel === '') return Promise.resolve(rootEntries)
      if (rootEntries.some(e => e.relativePath === rel)) {
        return Promise.resolve([{ name: 'one.ts', type: 'file', relativePath: 'lib/one.ts' }])
      }
      return Promise.reject(new Error('ENOENT'))
    })

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.click(await screen.findByText('lib'))
    expect(await screen.findByText('one.ts')).toBeTruthy()

    rootEntries = []
    await tickRefresh()

    expect(screen.queryByText('lib')).toBeNull()
    expect(screen.queryByText('one.ts')).toBeNull()

    // Re-created on disk: it must come back collapsed, not silently expanded.
    rootEntries = [{ name: 'lib', type: 'directory', relativePath: 'lib' }]
    await tickRefresh()
    expect(screen.getByText('lib')).toBeTruthy()
    expect(screen.queryByText('one.ts')).toBeNull()
  })

  it('prunes descendants of a deleted directory, not just the directory itself', async () => {
    let libExists = true
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) => {
      if (rel === '') {
        return Promise.resolve(libExists ? [{ name: 'lib', type: 'directory', relativePath: 'lib' }] : [])
      }
      if (!libExists) return Promise.reject(new Error('ENOENT'))
      if (rel === 'lib') return Promise.resolve([{ name: 'sub', type: 'directory', relativePath: 'lib/sub' }])
      return Promise.resolve([{ name: 'deep.ts', type: 'file', relativePath: 'lib/sub/deep.ts' }])
    })

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.click(await screen.findByText('lib'))
    fireEvent.click(await screen.findByText('sub'))
    expect(await screen.findByText('deep.ts')).toBeTruthy()

    libExists = false
    await tickRefresh()
    expect(screen.queryByText('lib')).toBeNull()

    // Recreated: `lib/sub` must not still be expanded from the stale cache.
    libExists = true
    await tickRefresh()
    expect(screen.getByText('lib')).toBeTruthy()
    expect(screen.queryByText('sub')).toBeNull()
    expect(screen.queryByText('deep.ts')).toBeNull()
  })

  it('clears the unavailable-directory error once the directory reappears', async () => {
    let available = false
    window.api.fbReadDirectory = vi.fn(() =>
      available
        ? Promise.resolve([{ name: 'src', type: 'directory', relativePath: 'src' }])
        : Promise.reject(new Error('ENOENT'))
    )

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    expect(await screen.findByText('Project directory is unavailable')).toBeTruthy()

    available = true
    await tickRefresh()

    expect(screen.queryByText('Project directory is unavailable')).toBeNull()
    expect(screen.getByText('src')).toBeTruthy()
  })
})
