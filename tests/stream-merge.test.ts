import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mergeStream } from '../src/main/stream-merge'
import { LocalGitRunner } from '../src/main/git-runner'
import { canonicalFilePath } from '../src/main/workspace-manager'
import type { ProjectsData, Stream } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function write(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content)
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

describe('mergeStream', () => {
  let repo: string
  let streamPath: string
  let data: ProjectsData

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-merge-')))
    execFileSync('git', ['init', '-q', '-b', 'master', repo])
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    write(repo, 'a.txt', 'one\n')
    write(repo, '.gitignore', '.worktrees/\n')
    commitAll(repo, 'init')
    streamPath = path.join(repo, '.worktrees', 'release')
    git(repo, 'worktree', 'add', '-q', streamPath, '-b', 'release', 'master')
    streamPath = canonicalFilePath(streamPath)
    const stream: Stream = {
      id: 's-release',
      name: 'Release',
      workspace: { worktreePath: streamPath, branchName: 'release', baseBranch: 'master', relativeProjectPath: '' },
      tasks: []
    }
    data = { projects: [fixtureProject({ id: 'p1', directory: repo, streams: [stream] })] } as ProjectsData
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  const merge = () => mergeStream({ projects: { peek: () => data }, runner: new LocalGitRunner() }, 'p1', 's-release')

  it('merges into the checked-out base branch with a merge commit, even when a fast-forward would do', async () => {
    write(streamPath, 'b.txt', 'two\n')
    commitAll(streamPath, 'add b')
    expect(await merge()).toEqual({ status: 'merged' })
    expect(git(repo, 'log', '-1', '--format=%P', 'master').trim().split(' ')).toHaveLength(2)
    expect(git(repo, 'log', '-1', '--format=%s', 'master').trim()).toBe('Merge stream "Release" (release) into master')
    // The checkout moved with its branch.
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('two\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'branch', '--merged', 'master')).toContain('release')
  })

  it('merges diverged branches, and moves a base branch no worktree has checked out', async () => {
    git(repo, 'checkout', '-q', '--detach')
    git(repo, 'checkout', '-q', '-b', 'side')
    write(streamPath, 'b.txt', 'two\n')
    commitAll(streamPath, 'add b')
    const before = git(repo, 'rev-parse', 'master').trim()
    expect(await merge()).toEqual({ status: 'merged' })
    expect(git(repo, 'rev-parse', 'master^1').trim()).toBe(before)
    expect(git(repo, 'ls-tree', '--name-only', 'master')).toContain('b.txt')
  })

  it('reports conflicts and changes nothing', async () => {
    write(streamPath, 'a.txt', 'stream\n')
    commitAll(streamPath, 'stream edit')
    write(repo, 'a.txt', 'master\n')
    commitAll(repo, 'master edit')
    const before = git(repo, 'rev-parse', 'master').trim()
    expect(await merge()).toEqual({ status: 'conflict', files: ['a.txt'] })
    expect(git(repo, 'rev-parse', 'master').trim()).toBe(before)
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('is blocked by local changes in the base checkout that the merge touches', async () => {
    write(streamPath, 'a.txt', 'stream\n')
    commitAll(streamPath, 'stream edit')
    write(repo, 'a.txt', 'local\n')
    const before = git(repo, 'rev-parse', 'master').trim()
    const result = await merge()
    expect(result).toMatchObject({ status: 'blocked', files: ['a.txt'] })
    expect(git(repo, 'rev-parse', 'master').trim()).toBe(before)
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('local\n')
  })

  it('has nothing to do when the base already has the stream', async () => {
    expect(await merge()).toEqual({ status: 'nothing' })
  })
})
