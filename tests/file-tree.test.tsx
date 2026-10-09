// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FileTree, { type FileTreeHandle } from '../src/renderer/components/FileTree'
import type { DirectoryEntry } from '../src/shared/types'
import { FILE_BROWSER_REFRESH_MS } from '../src/renderer/hooks/fileBrowserRefresh'

void React

beforeEach(() => {
  ;(window as any).api = {
    fbReadDirectory: vi.fn(),
    fbCreateFile: vi.fn(),
    fbCreateDirectory: vi.fn(),
    fbRename: vi.fn(),
    fbDelete: vi.fn()
  }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'alert').mockImplementation(() => {})
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
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string): Promise<DirectoryEntry[]> => {
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
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string): Promise<DirectoryEntry[]> => {
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
    window.api.fbReadDirectory = vi.fn((): Promise<DirectoryEntry[]> =>
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

  it('filters loaded names without calling search-in-files', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([
        { name: 'hello.py', type: 'file' as const, relativePath: 'hello.py' },
        { name: 'readme.md', type: 'file' as const, relativePath: 'readme.md' }
      ])
    )

    render(
      <FileTree
        projectDir="/project"
        gitStatus={null}
        onFileClick={vi.fn()}
        filterQuery="hello"
      />
    )
    expect(await screen.findByText('hello.py')).toBeTruthy()
    expect(screen.queryByText('readme.md')).toBeNull()
  })

  it('creates a file from the context menu', async () => {
    const listing: Record<string, any[]> = { '': [{ name: 'a.ts', type: 'file', relativePath: 'a.ts' }] }
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) =>
      Promise.resolve(listing[rel] ?? [])
    )
    window.api.fbCreateFile = vi.fn(async () => {
      listing[''] = [
        { name: 'a.ts', type: 'file', relativePath: 'a.ts' },
        { name: 'b.ts', type: 'file', relativePath: 'b.ts' }
      ]
      return { name: 'b.ts', type: 'file' as const, relativePath: 'b.ts' }
    })

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.contextMenu(await screen.findByText('a.ts'))
    fireEvent.click(screen.getByText('New file'))
    const input = screen.getByPlaceholderText('file name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(window.api.fbCreateFile).toHaveBeenCalledWith('/project', '', 'b.ts', undefined)
    })
  })

  it('keeps the name field and shows an in-tree error when the file already exists', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'a.ts', type: 'file' as const, relativePath: 'a.ts' }])
    )
    window.api.fbCreateFile = vi.fn().mockRejectedValue(
      new Error("Error invoking remote method 'fb-create-file': Error: EEXIST: file already exists, open '/project/a.ts'")
    )

    const treeRef = React.createRef<FileTreeHandle>()
    render(
      <FileTree
        ref={treeRef}
        projectDir="/project"
        gitStatus={null}
        onFileClick={vi.fn()}
      />
    )
    expect(await screen.findByText('a.ts')).toBeTruthy()
    act(() => {
      treeRef.current?.startCreate('file')
    })
    const input = screen.getByPlaceholderText('file name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('A file or folder with that name already exists')
    expect(window.alert).not.toHaveBeenCalled()
    const retry = screen.getByPlaceholderText('file name') as HTMLInputElement
    expect(retry.value).toBe('a.ts')
  })

  it('renames and deletes with confirm', async () => {
    let listing = [{ name: 'a.ts', type: 'file' as const, relativePath: 'a.ts' }]
    window.api.fbReadDirectory = vi.fn(() => Promise.resolve(listing))
    window.api.fbRename = vi.fn(async () => {
      listing = [{ name: 'b.ts', type: 'file' as const, relativePath: 'b.ts' }]
      return { name: 'b.ts', type: 'file' as const, relativePath: 'b.ts' }
    })
    window.api.fbDelete = vi.fn(async () => {
      listing = []
    })

    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.contextMenu(await screen.findByText('a.ts'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByPlaceholderText('file name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(window.api.fbRename).toHaveBeenCalledWith('/project', 'a.ts', 'b.ts', undefined)
    })

    fireEvent.contextMenu(await screen.findByText('b.ts'))
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => {
      expect(window.api.fbDelete).toHaveBeenCalledWith('/project', 'b.ts', undefined)
    })
    expect(window.confirm).toHaveBeenCalled()
  })

  it('offers Reveal in Git Bash when a handler is provided', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'src', type: 'directory' as const, relativePath: 'src' }])
    )
    const onReveal = vi.fn()
    render(
      <FileTree
        projectDir="/project"
        gitStatus={null}
        onFileClick={vi.fn()}
        onRevealInTerminal={onReveal}
        hostPlatform="win32"
      />
    )
    fireEvent.contextMenu(await screen.findByText('src'))
    fireEvent.click(screen.getByText('Reveal in Git Bash'))
    expect(onReveal).toHaveBeenCalledWith('src')
  })

  it('names the terminal after the host\'s platform, and has no Reveal in Finder for a server\'s folder', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'src', type: 'directory' as const, relativePath: 'src' }])
    )
    const onReveal = vi.fn()
    render(
      <FileTree
        projectDir="/home/me/app"
        projectId="srv-p"
        gitStatus={null}
        onFileClick={vi.fn()}
        onRevealInTerminal={onReveal}
        hostPlatform="linux"
        canReveal={false}
      />
    )
    fireEvent.contextMenu(await screen.findByText('src'))
    expect(screen.queryByText(/Reveal in Finder|Show in Explorer|Show in file manager/)).toBeNull()
    fireEvent.click(screen.getByText('Reveal in Terminal'))
    expect(onReveal).toHaveBeenCalledWith('src')
    expect(window.api.fbReadDirectory).toHaveBeenCalledWith('/home/me/app', '', 'srv-p')
  })

  it('offers Open in Cursor from the context menu when editors are configured', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'src', type: 'directory' as const, relativePath: 'src' }])
    )
    const onOpenInIde = vi.fn().mockResolvedValue(null)
    render(
      <FileTree
        projectDir="/project"
        gitStatus={null}
        onFileClick={vi.fn()}
        ideEditors={[{ id: 'cursor', name: 'Cursor' }]}
        onOpenInIde={onOpenInIde}
      />
    )
    fireEvent.contextMenu(await screen.findByText('src'))
    fireEvent.click(screen.getByText('Open in Cursor'))
    expect(onOpenInIde).toHaveBeenCalledWith('cursor')
  })

  it('omits Open in when no editors are configured', async () => {
    window.api.fbReadDirectory = vi.fn(() =>
      Promise.resolve([{ name: 'src', type: 'directory' as const, relativePath: 'src' }])
    )
    render(<FileTree projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    fireEvent.contextMenu(await screen.findByText('src'))
    expect(screen.queryByText(/Open in /)).toBeNull()
  })

  it('creates a file from startCreate on the tree handle (toolbar)', async () => {
    const listing: Record<string, any[]> = { '': [{ name: 'a.ts', type: 'file', relativePath: 'a.ts' }] }
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string) =>
      Promise.resolve(listing[rel] ?? [])
    )
    window.api.fbCreateFile = vi.fn(async () => {
      listing[''] = [
        { name: 'a.ts', type: 'file', relativePath: 'a.ts' },
        { name: 'b.ts', type: 'file', relativePath: 'b.ts' }
      ]
      return { name: 'b.ts', type: 'file' as const, relativePath: 'b.ts' }
    })

    const treeRef = React.createRef<FileTreeHandle>()
    render(
      <FileTree
        ref={treeRef}
        projectDir="/project"
        gitStatus={null}
        onFileClick={vi.fn()}
      />
    )
    expect(await screen.findByText('a.ts')).toBeTruthy()
    act(() => {
      treeRef.current?.startCreate('file')
    })
    const input = screen.getByPlaceholderText('file name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(window.api.fbCreateFile).toHaveBeenCalledWith('/project', '', 'b.ts', undefined)
    })
  })

  it('expands nested folders and collapse-all hides them', async () => {
    window.api.fbReadDirectory = vi.fn((_dir: string, rel: string): Promise<DirectoryEntry[]> => {
      if (rel === '') return Promise.resolve([{ name: 'src', type: 'directory' as const, relativePath: 'src' }])
      if (rel === 'src') return Promise.resolve([{ name: 'lib', type: 'directory' as const, relativePath: 'src/lib' }])
      return Promise.resolve([{ name: 'a.ts', type: 'file' as const, relativePath: 'src/lib/a.ts' }])
    })

    const treeRef = React.createRef<FileTreeHandle>()
    render(<FileTree ref={treeRef} projectDir="/project" gitStatus={null} onFileClick={vi.fn()} />)
    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.queryByText('lib')).toBeNull()

    await act(async () => {
      await treeRef.current?.expandAll()
    })
    expect(await screen.findByText('lib')).toBeTruthy()
    expect(await screen.findByText('a.ts')).toBeTruthy()

    act(() => {
      treeRef.current?.collapseAll()
    })
    expect(screen.queryByText('lib')).toBeNull()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('src')).toBeTruthy()
  })
})
