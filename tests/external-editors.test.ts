import { describe, expect, it } from 'vitest'
import { localProjectFolder, paletteAliasesForEditor, resolveDefaultExternalEditor } from '../src/shared/external-editors'
import { featureAvailable, openInIdeAvailable, revealAvailable } from '../src/shared/project-features'
import { createMainStream, type Project } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    directory: 'C:\\Repos\\demo',
    streams: [createMainStream('p1')],
    ...patch
  }
}

describe('external editor helpers', () => {
  it('falls back to the first editor when defaultId is missing', () => {
    const editors = [
      { id: 'a', name: 'VS Code', command: 'Code.exe', extraArgs: '' },
      { id: 'b', name: 'Cursor', command: 'Cursor.exe', extraArgs: '' }
    ]
    expect(resolveDefaultExternalEditor({ editors, defaultId: null })?.id).toBe('a')
    expect(resolveDefaultExternalEditor({ editors, defaultId: 'b' })?.id).toBe('b')
  })

  it('adds vscode aliases for Visual Studio Code', () => {
    expect(paletteAliasesForEditor('Visual Studio Code')).toEqual(
      expect.arrayContaining(['vscode', 'code'])
    )
  })

  it('uses the worktree folder for workspace tasks', () => {
    const withWorktree = fixtureProject({
      id: 'p1',
      name: 'Demo',
      directory: 'C:\\Repos\\demo',
      tasks: [{
        id: 't1',
        name: 'branch',
        workspace: {
          worktreePath: 'C:\\Repos\\demo-wt',
          branchName: 'feat',
          baseBranch: 'master',
          relativeProjectPath: 'apps\\web'
        }
      }]
    })
    const task = withWorktree.streams[1].tasks[0]
    expect(localProjectFolder(withWorktree, task)).toBe('C:\\Repos\\demo-wt\\apps\\web')
    // The same task looked up in a project where it has no worktree uses the project folder.
    expect(localProjectFolder(project(), task)).toBe('C:\\Repos\\demo')
  })

  it('returns null for remote projects', () => {
    expect(localProjectFolder(project({ ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/x' } }), null)).toBeNull()
  })

  it('opens a DevTool server project\'s folder (over SSH) on macOS and Linux, never on Windows (plan step 9)', () => {
    const onServer = project({ host: 'ab'.repeat(16), directory: '/home/dev/app' })
    expect(featureAvailable(onServer, 'local-folder')).toBe(true)
    expect(localProjectFolder(onServer, null, 'darwin')).toBe('/home/dev/app')
    expect(localProjectFolder(onServer, null, 'linux')).toBe('/home/dev/app')
    expect(localProjectFolder(onServer, null, 'win32')).toBeNull()
    expect(openInIdeAvailable(onServer, 'win32')).toBe(false)
    expect(openInIdeAvailable(project(), 'win32')).toBe(true)
    // Reveal in Finder stays this computer's only.
    expect(revealAvailable(onServer)).toBe(false)
  })
})
