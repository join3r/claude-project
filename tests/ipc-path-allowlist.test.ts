import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowedLocalRoots,
  isPathInside,
  resolveAllowedDirectory,
  resolveConfinedPath
} from '../src/main/ipc/path-allowlist'
import { registerFileBrowserHandlers } from '../src/main/ipc/file-browser'
import type { IpcRegistrar } from '../src/main/ipc/registrar'
import { validateArgs } from '../src/main/ipc/validate'
import { createMainStream, type Project } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const tmpDirs: string[] = []

/**
 * A real temp dir, realpath'd the way the code under test does it (native: macOS's
 * /var is a symlink to /private/var, and on Windows the runner's temp dir is an 8.3
 * short name like RUNNER~1 that only the native realpath expands).
 */
function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p1',
    name: 'P',
    directory: '',
    streams: [createMainStream(overrides.id ?? 'p1')],
    ...overrides
  }
}

/**
 * A layout with a project, a secret outside it, and symlinks from inside the
 * project to the outside world.
 */
function layout() {
  const base = tmp('devtool-allow-')
  const projectDir = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'inside')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectDir, 'leak.txt'))
  fs.symlinkSync(outside, path.join(projectDir, 'leakdir'))
  fs.symlinkSync(path.join(projectDir, 'src', 'a.ts'), path.join(projectDir, 'alias.ts'))
  return { base, projectDir, outside }
}

describe('allowedLocalRoots', () => {
  it('lists local project directories and workspace worktrees, not remote ones', () => {
    const roots = allowedLocalRoots([
      fixtureProject({
        id: 'local',
        name: 'P',
        directory: '/work/app',
        tasks: [{
          id: 't', name: 't',
          workspace: { worktreePath: '/work/.wt/feat', branchName: 'feat', baseBranch: 'main', relativeProjectPath: 'apps/web' }
        }]
      }),
      project({ id: 'remote', directory: '/srv/remote', ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/srv' } }),
      project({ id: 'shell', directory: '' })
    ])
    expect(roots).toEqual(['/work/app', '/work/.wt/feat', '/work/.wt/feat/apps/web'])
  })

  it('lists a task’s own worktree next to its stream’s', () => {
    const own = { worktreePath: '/work/.wt/feat--fix', branchName: 'feat--fix', baseBranch: 'feat', relativeProjectPath: 'apps/web' }
    const roots = allowedLocalRoots([
      fixtureProject({
        id: 'local',
        directory: '/work/apps/web',
        tasks: [{
          id: 't',
          workspace: { worktreePath: '/work/.wt/feat', branchName: 'feat', baseBranch: 'main', relativeProjectPath: 'apps/web' },
          ownWorkspace: own
        }]
      })
    ])
    expect(roots).toEqual(['/work/apps/web', '/work/.wt/feat', '/work/.wt/feat/apps/web', '/work/.wt/feat--fix', '/work/.wt/feat--fix/apps/web'])
  })
})

describe('isPathInside', () => {
  it('matches the root and descendants only', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true)
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true)
    expect(isPathInside('/a/b', '/a/bc')).toBe(false)
    expect(isPathInside('/a/b', '/a')).toBe(false)
    expect(isPathInside('/a/b', '/a/b/..c')).toBe(true)
    expect(isPathInside('C:\\a', 'D:\\a', path.win32)).toBe(false)
    expect(isPathInside('C:\\a', 'c:\\A\\b', path.win32)).toBe(true)
  })
})

describe('resolveAllowedDirectory', () => {
  it('accepts a project directory and its sub-directories', async () => {
    const { projectDir } = layout()
    await expect(resolveAllowedDirectory(projectDir, [projectDir])).resolves.toBe(projectDir)
    await expect(resolveAllowedDirectory(path.join(projectDir, 'src'), [projectDir])).resolves.toBe(path.join(projectDir, 'src'))
  })

  it('refuses a directory that is not a known project', async () => {
    const { projectDir, outside } = layout()
    await expect(resolveAllowedDirectory(outside, [projectDir])).rejects.toThrow(/not a known project/)
    await expect(resolveAllowedDirectory(os.homedir(), [projectDir])).rejects.toThrow(/not a known project/)
    await expect(resolveAllowedDirectory('/', [projectDir])).rejects.toThrow(/not a known project/)
  })

  it('refuses a symlink inside the project that points outside it', async () => {
    const { projectDir } = layout()
    await expect(resolveAllowedDirectory(path.join(projectDir, 'leakdir'), [projectDir])).rejects.toThrow(/not a known project/)
  })

  it('refuses lexical escapes', async () => {
    const { projectDir } = layout()
    await expect(resolveAllowedDirectory(path.join(projectDir, '..', 'outside'), [projectDir])).rejects.toThrow()
  })

  it('accepts a project configured through a symlinked path', async () => {
    const { base, projectDir } = layout()
    const link = path.join(base, 'project-link')
    fs.symlinkSync(projectDir, link)
    await expect(resolveAllowedDirectory(link, [link])).resolves.toBe(projectDir)
    await expect(resolveAllowedDirectory(projectDir, [link])).resolves.toBe(projectDir)
  })

  it('refuses relative, empty, non-string and missing directories', async () => {
    const { projectDir } = layout()
    await expect(resolveAllowedDirectory('project', [projectDir])).rejects.toThrow(/absolute/)
    await expect(resolveAllowedDirectory('', [projectDir])).rejects.toThrow(/required/)
    await expect(resolveAllowedDirectory(42, [projectDir])).rejects.toThrow(/required/)
    await expect(resolveAllowedDirectory(path.join(projectDir, 'nope'), [projectDir])).rejects.toThrow(/does not exist/)
  })
})

describe('resolveConfinedPath', () => {
  it('resolves ordinary files and symlinks that stay inside', async () => {
    const { projectDir } = layout()
    await expect(resolveConfinedPath(projectDir, 'src/a.ts', { followFinal: true })).resolves.toBe(path.join(projectDir, 'src', 'a.ts'))
    await expect(resolveConfinedPath(projectDir, 'alias.ts', { followFinal: true })).resolves.toBe(path.join(projectDir, 'alias.ts'))
    await expect(resolveConfinedPath(projectDir, 'src/new-file.ts', { followFinal: true })).resolves.toBe(path.join(projectDir, 'src', 'new-file.ts'))
  })

  it('refuses a symlinked file or directory that points outside', async () => {
    const { projectDir } = layout()
    await expect(resolveConfinedPath(projectDir, 'leak.txt', { followFinal: true })).rejects.toThrow(/escapes/)
    await expect(resolveConfinedPath(projectDir, 'leakdir', { followFinal: true })).rejects.toThrow(/escapes/)
    await expect(resolveConfinedPath(projectDir, 'leakdir/secret.txt', { followFinal: true })).rejects.toThrow(/escapes/)
    // A not-yet-existing file under an escaping directory escapes too.
    await expect(resolveConfinedPath(projectDir, 'leakdir/new.txt', { followFinal: true })).rejects.toThrow(/escapes/)
    await expect(resolveConfinedPath(projectDir, 'leakdir/sub/new.txt', { followFinal: false })).rejects.toThrow(/escapes/)
  })

  it('lets the link itself be deleted or renamed, but nothing below it', async () => {
    const { projectDir } = layout()
    await expect(resolveConfinedPath(projectDir, 'leak.txt', { followFinal: false })).resolves.toBe(path.join(projectDir, 'leak.txt'))
    await expect(resolveConfinedPath(projectDir, 'leakdir/secret.txt', { followFinal: false })).rejects.toThrow(/escapes/)
  })

  it('refuses lexical traversal', async () => {
    const { projectDir } = layout()
    await expect(resolveConfinedPath(projectDir, '../outside/secret.txt', { followFinal: true })).rejects.toThrow(/traversal/)
  })
})

/** Collects handlers the way the real registrar would, minus the sender check. */
function fakeRegistrar() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc: IpcRegistrar = {
    handle: (channel, schema, handler) => {
      handlers.set(channel, (...raw) => handler({} as never, ...validateArgs(channel, schema, raw)))
    },
    on: () => {},
    onSync: () => {}
  }
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args)
  return { ipc, invoke }
}

describe('file browser handlers', () => {
  function setup() {
    const env = layout()
    const { ipc, invoke } = fakeRegistrar()
    const projects = [project({ directory: env.projectDir })]
    registerFileBrowserHandlers(ipc, {
      resolveRoot: (dir) => resolveAllowedDirectory(dir, allowedLocalRoots(projects))
    })
    return { ...env, invoke }
  }

  it('reads and writes files inside a known project', async () => {
    const { projectDir, invoke } = setup()
    await expect(invoke('fb-read-file', projectDir, 'src/a.ts')).resolves.toBe('inside')
    await invoke('fb-write-file', projectDir, 'src/b.ts', 'new')
    expect(fs.readFileSync(path.join(projectDir, 'src', 'b.ts'), 'utf-8')).toBe('new')
  })

  it('refuses a projectCwd the caller picked outside every project', async () => {
    const { outside, invoke } = setup()
    await expect(invoke('fb-read-file', outside, 'secret.txt')).rejects.toThrow(/not a known project/)
    await expect(invoke('fb-write-file', outside, 'pwned.txt', 'x')).rejects.toThrow(/not a known project/)
    await expect(invoke('fb-read-directory', '/', '')).rejects.toThrow(/not a known project/)
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false)
  })

  it('refuses to read or write through a symlink that leaves the project', async () => {
    const { projectDir, outside, invoke } = setup()
    await expect(invoke('fb-read-file', projectDir, 'leak.txt')).rejects.toThrow(/escapes/)
    await expect(invoke('fb-write-file', projectDir, 'leak.txt', 'overwritten')).rejects.toThrow(/escapes/)
    await expect(invoke('fb-read-directory', projectDir, 'leakdir')).rejects.toThrow(/escapes/)
    await expect(invoke('fb-create-file', projectDir, 'leakdir', 'x.txt')).rejects.toThrow(/escapes/)
    await expect(invoke('fb-delete', projectDir, 'leakdir/secret.txt')).rejects.toThrow(/escapes/)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
  })

  it('deletes a symlink itself without touching its target', async () => {
    const { projectDir, outside, invoke } = setup()
    await invoke('fb-delete', projectDir, 'leakdir')
    expect(fs.existsSync(path.join(projectDir, 'leakdir'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
  })

  it('refuses arguments of the wrong type before touching the disk', async () => {
    const { projectDir, invoke } = setup()
    await expect(invoke('fb-read-file', projectDir, { toString: () => 'src/a.ts' })).rejects.toThrow(/fb-read-file#1/)
    await expect(invoke('fb-write-file', projectDir, 'src/a.ts', 42)).rejects.toThrow(/fb-write-file#2/)
  })
})
