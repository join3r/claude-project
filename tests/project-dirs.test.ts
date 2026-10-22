import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MissingFolderWatch, ProjectDirError, appendNewProject, createProjectDir, missingProjectDirs, trashProjectDir, validateFolderName } from '../src/main/project-dirs'
import { LocalGitRunner, type GitRunner } from '../src/main/git-runner'
import { createMainStream, type Project } from '../src/shared/types'

const tmpDirs: string[] = []

function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function project(id: string, overrides: Partial<Project>): Project {
  return { id, name: id, directory: '', streams: [createMainStream(id)], ...overrides }
}

describe('missingProjectDirs', () => {
  it('lists local projects whose folder is gone, and only those', async () => {
    const root = tmp('pd-missing-')
    const file = path.join(root, 'a-file')
    fs.writeFileSync(file, '')
    const projects = [
      project('here', { directory: root }),
      project('gone', { directory: path.join(root, 'nope') }),
      project('file', { directory: file }),
      project('ssh', { directory: '/nope', ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/nope' } as Project['ssh'] }),
      project('server', { directory: '/nope', host: 'srv' }),
      project('shell', { directory: '', shellCommand: { command: 'htop' } })
    ]
    expect(await missingProjectDirs(projects)).toEqual(['gone', 'file'])
  })
})

describe('validateFolderName', () => {
  it('trims and accepts an ordinary name', () => {
    expect(validateFolderName('  my-app ')).toBe('my-app')
  })

  it.each(['', '  ', '.', '..', 'a/b', 'a\\b', 'a:b', 'x'.repeat(256)])('refuses %j', (name) => {
    expect(() => validateFolderName(name)).toThrow()
  })
})

describe('createProjectDir', () => {
  it('makes the folder and runs git init in it', async () => {
    const root = tmp('pd-create-')
    const projectsDir = path.join(root, 'code')
    const dir = await createProjectDir(projectsDir, 'app', new LocalGitRunner())
    expect(dir).toBe(path.join(projectsDir, 'app'))
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
  })

  it('refuses a folder that already exists', async () => {
    const root = tmp('pd-exists-')
    fs.mkdirSync(path.join(root, 'app'))
    await expect(createProjectDir(root, 'app', new LocalGitRunner())).rejects.toThrow(/already exists/)
  })

  it('needs a projects folder', async () => {
    await expect(createProjectDir('', 'app', new LocalGitRunner())).rejects.toMatchObject({ kind: 'no-projects-dir' })
  })

  it('tells a bad name from a failure', async () => {
    const root = tmp('pd-kinds-')
    await expect(createProjectDir(root, 'a/b', new LocalGitRunner())).rejects.toMatchObject({ kind: 'invalid' })
    fs.mkdirSync(path.join(root, 'app'))
    await expect(createProjectDir(root, 'app', new LocalGitRunner())).rejects.toBeInstanceOf(ProjectDirError)
    await expect(createProjectDir(root, 'app', new LocalGitRunner())).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('removes the empty folder when git init fails', async () => {
    const root = tmp('pd-gitfail-')
    const failing: GitRunner = { kind: 'local', run: async () => ({ stdout: '', stderr: 'boom', code: 1 }) }
    await expect(createProjectDir(root, 'app', failing)).rejects.toMatchObject({ kind: 'failed', message: expect.stringMatching(/boom/) })
    expect(fs.existsSync(path.join(root, 'app'))).toBe(false)
  })
})

describe('trashProjectDir', () => {
  function setup() {
    const root = tmp('pd-trash-')
    const home = path.join(root, 'home')
    const dir = path.join(home, 'code', 'app')
    fs.mkdirSync(dir, { recursive: true })
    const trashed: string[] = []
    return { root, home, dir, trashed, deps: { homeDir: home, trashItem: async (p: string) => { trashed.push(p) } } }
  }

  it('trashes a local project folder', async () => {
    const { dir, trashed, deps } = setup()
    await trashProjectDir([project('p', { directory: dir })], 'p', deps)
    expect(trashed).toEqual([dir])
  })

  it('refuses the home folder and what holds it', async () => {
    const { root, home, trashed, deps } = setup()
    await expect(trashProjectDir([project('p', { directory: home })], 'p', deps)).rejects.toThrow(/home folder/)
    await expect(trashProjectDir([project('p', { directory: root })], 'p', deps)).rejects.toThrow(/home folder/)
    expect(trashed).toEqual([])
  })

  it('refuses a folder another project lives in', async () => {
    const { dir, trashed, deps } = setup()
    const sub = path.join(dir, 'pkg')
    fs.mkdirSync(sub)
    const projects = [project('p', { directory: dir }), project('q', { name: 'Q', directory: sub })]
    await expect(trashProjectDir(projects, 'p', deps)).rejects.toThrow(/"Q"/)
    const same = [project('p', { directory: dir }), project('q', { name: 'Q', directory: dir })]
    await expect(trashProjectDir(same, 'p', deps)).rejects.toThrow(/"Q"/)
    expect(trashed).toEqual([])
  })

  it('refuses the projects folder itself', async () => {
    const { dir, trashed, deps } = setup()
    await expect(trashProjectDir([project('p', { directory: dir })], 'p', { ...deps, projectsDir: dir })).rejects.toThrow(/projects folder/)
    expect(trashed).toEqual([])
  })

  it('refuses non-local projects and unknown ids', async () => {
    const { trashed, deps } = setup()
    await expect(trashProjectDir([project('s', { directory: '/x', host: 'srv' })], 's', deps)).rejects.toThrow(/local/)
    await expect(trashProjectDir([], 'nope', deps)).rejects.toThrow(/gone/)
    expect(trashed).toEqual([])
  })
})

describe('appendNewProject', () => {
  it('adds a local project with only main, at the end of the order', () => {
    const data = appendNewProject({ projects: [], tags: [], projectOrder: ['x'], pinnedItems: [] }, 'p-new', 'app', '/code/app')
    expect(data.projectOrder).toEqual(['x', 'p-new'])
    expect(data.projects[0]).toMatchObject({ id: 'p-new', name: 'app', directory: '/code/app' })
    expect(data.projects[0].streams.map(s => s.isMain)).toEqual([true])
  })
})

describe('MissingFolderWatch', () => {
  it('tells listeners only when the set changes', async () => {
    const root = tmp('pd-watch-')
    const dir = path.join(root, 'app')
    fs.mkdirSync(dir)
    const watch = new MissingFolderWatch(() => [project('p', { directory: dir })])
    let calls = 0
    watch.subscribe(() => { calls++ })
    await watch.refresh()
    expect(calls).toBe(0)
    fs.rmSync(dir, { recursive: true })
    await watch.refresh()
    await watch.refresh()
    expect([...watch.peek()]).toEqual(['p'])
    expect(calls).toBe(1)
    fs.mkdirSync(dir)
    await watch.refresh()
    expect(watch.peek().size).toBe(0)
    expect(calls).toBe(2)
  })
})
