import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { cloneHostRepo, discoverHostRepos, expandHostPath, listHostDirectories, repoNameFromUrl } from '../src/main/host-fs'

/**
 * The host channels behind "Server project…": a server's folders, the git repos
 * under its home, and a clone (here from a local bare repo).
 */

let root: string

function mkdirs(...parts: string[]): string {
  const dir = path.join(root, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function gitRepo(...parts: string[]): string {
  const dir = mkdirs(...parts)
  fs.mkdirSync(path.join(dir, '.git'))
  return dir
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-host-fs-')))
  gitRepo('projects', 'alpha')
  gitRepo('projects', 'alpha', 'nested')
  gitRepo('work', 'client', 'beta')
  gitRepo('work', 'client', 'deep', 'too-deep')
  gitRepo('node_modules', 'pkg')
  gitRepo('.hidden', 'secret')
  mkdirs('Library', 'Caches')
  mkdirs('empty')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a folder')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('host folders', () => {
  it('expands ~ and refuses relative paths', () => {
    expect(expandHostPath('', '/home/u')).toBe('/home/u')
    expect(expandHostPath('~', '/home/u')).toBe('/home/u')
    expect(expandHostPath('~/projects', '/home/u')).toBe('/home/u/projects')
    expect(() => expandHostPath('relative/dir', '/home/u')).toThrow(/absolute/)
  })

  it('lists folders only, marks repos, and shows hidden ones on request', async () => {
    const listing = await listHostDirectories('', { home: root })
    expect(listing.path).toBe(root)
    expect(listing.parent).toBe(path.dirname(root))
    expect(listing.entries.map(e => e.name)).toEqual(['empty', 'Library', 'node_modules', 'projects', 'work'])
    const projects = await listHostDirectories(path.join(root, 'projects'))
    expect(projects.entries).toEqual([{ name: 'alpha', path: path.join(root, 'projects', 'alpha'), git: true }])
    const hidden = await listHostDirectories(root, { showHidden: true })
    expect(hidden.entries.map(e => e.name)).toContain('.hidden')
    await expect(listHostDirectories(path.join(root, 'missing'))).rejects.toThrow()
  })
})

describe('repo discovery', () => {
  it('finds repos three levels down, not inside repos, hidden or heavy folders', async () => {
    const found = await discoverHostRepos({ root })
    expect(found.root).toBe(root)
    expect(found.truncated).toBe(false)
    expect(found.repos.map(r => path.relative(root, r.path))).toEqual(['projects/alpha', 'work/client/beta'])
    expect(found.repos[0].name).toBe('alpha')
    const deeper = await discoverHostRepos({ root, maxDepth: 4 })
    expect(deeper.repos.map(r => path.relative(root, r.path))).toContain('work/client/deep/too-deep')
  })

  it('stops at its time limit and says so', async () => {
    let clock = 0
    const found = await discoverHostRepos({ root, timeLimitMs: 5, now: () => (clock += 10) })
    expect(found.truncated).toBe(true)
  })
})

describe('clone', () => {
  let bare: string

  beforeAll(() => {
    const src = mkdirs('clone-src')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: src, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(src, 'README.md'), 'hello\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
    bare = path.join(root, 'bare', 'demo.git')
    execFileSync('git', ['clone', '-q', '--bare', src, bare], { stdio: 'pipe' })
  })

  it('names the folder after the repo', () => {
    expect(repoNameFromUrl('git@github.com:me/demo.git')).toBe('demo')
    expect(repoNameFromUrl('https://example.com/a/b/tool/')).toBe('tool')
  })

  it('clones into the parent folder (made if missing) with progress, and refuses an existing folder', async () => {
    const parent = path.join(root, 'cloned', 'here')
    const lines: string[] = []
    const result = await cloneHostRepo({ url: bare, parentDir: parent }, { onProgress: (line) => lines.push(line), home: root })
    expect(result).toEqual({ path: path.join(parent, 'demo'), name: 'demo' })
    expect(fs.readFileSync(path.join(parent, 'demo', 'README.md'), 'utf8')).toBe('hello\n')
    expect(lines.length).toBeGreaterThan(0)
    await expect(cloneHostRepo({ url: bare, parentDir: parent }, { onProgress: () => {}, home: root })).rejects.toThrow(/already exists/)
  })

  it('fails with git\'s reason, and never takes an option for a URL', async () => {
    await expect(cloneHostRepo({ url: path.join(root, 'nope.git'), parentDir: path.join(root, 'cloned') }, { onProgress: () => {}, home: root }))
      .rejects.toThrow(/does not exist|not found|fatal/i)
    await expect(cloneHostRepo({ url: '--upload-pack=touch /tmp/x', parentDir: root }, { onProgress: () => {} })).rejects.toThrow(/Not a repository URL/)
  })
})
