import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findNestedGitRepos, repoForPath, toProjectEntries, toRepoPath } from '../src/main/git-repos'
import { GIT_STATUS_ARGS, parseGitStatusZ } from '../src/main/git-status-parse'

let root: string

function mkdirs(...rels: string[]): void {
  for (const rel of rels) fs.mkdirSync(path.join(root, rel), { recursive: true })
}

function gitInit(rel: string): void {
  mkdirs(rel)
  execFileSync('git', ['init', '-q'], { cwd: path.join(root, rel) })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-git-repos-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findNestedGitRepos', () => {
  it('finds repos below a folder that is not itself a repo, nearest first', () => {
    gitInit('app')
    gitInit('libs/core')
    gitInit('app/plugins/extra')
    mkdirs('notes/drafts')
    return expect(findNestedGitRepos(root)).resolves.toEqual(['app', 'libs/core', 'app/plugins/extra'])
  })

  it('counts a .git file (worktree / submodule) as a repo', async () => {
    mkdirs('wt')
    fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: /elsewhere\n')
    expect(await findNestedGitRepos(root)).toEqual(['wt'])
  })

  it('skips dependency trees, dot-directories and anything past the depth limit', async () => {
    gitInit('node_modules/pkg')
    gitInit('.cache/repo')
    gitInit('a/b/c/d')
    expect(await findNestedGitRepos(root)).toEqual([])
  })
})

describe('path mapping', () => {
  it('picks the deepest repo holding a path', () => {
    const repos = ['app', 'app/plugins/extra']
    expect(repoForPath(repos, 'app/plugins/extra/x.ts')).toBe('app/plugins/extra')
    expect(repoForPath(repos, 'app/main.ts')).toBe('app')
    expect(repoForPath(repos, 'application.ts')).toBe('')
  })

  it('maps project paths into a repo and refuses ones outside it', () => {
    expect(toRepoPath('app', 'app/src/a.ts')).toBe('src/a.ts')
    expect(toRepoPath('app', 'other/a.ts')).toBeNull()
    expect(toRepoPath('app', 'apple.ts')).toBeNull()
    expect(toRepoPath('', 'a.ts')).toBe('a.ts')
  })

  it("prefixes a repo's entries and hides nested repos from its untracked list", () => {
    gitInit('')
    gitInit('sub')
    fs.writeFileSync(path.join(root, 'top.txt'), 'x\n')
    fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'y\n')
    const parse = (rel: string) =>
      parseGitStatusZ(execFileSync('git', GIT_STATUS_ARGS, { cwd: path.join(root, rel), encoding: 'utf-8' }))

    const rootUntracked = parse('').untracked
    expect(rootUntracked.map(e => e.relativePath).sort()).toEqual(['sub/', 'top.txt'])
    expect(toProjectEntries('', rootUntracked, ['sub']).map(e => e.relativePath)).toEqual(['top.txt'])
    expect(toProjectEntries('sub', parse('sub').untracked, ['sub']).map(e => e.relativePath)).toEqual(['sub/inner.txt'])
  })

  it('prefixes the original path of a rename', () => {
    expect(toProjectEntries('lib', [{ relativePath: 'new.ts', origPath: 'old.ts', status: 'R' }], ['lib']))
      .toEqual([{ relativePath: 'lib/new.ts', origPath: 'lib/old.ts', status: 'R' }])
  })
})
