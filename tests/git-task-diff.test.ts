import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTaskDiffSummary } from '../src/main/ipc/git'

let root: string
let repo: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
}

function write(dir: string, file: string, lines: number): void {
  fs.writeFileSync(path.join(dir, file), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n')
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-task-diff-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, 'a.txt', 10)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readTaskDiffSummary', () => {
  it('counts only what is not committed, without a base branch', async () => {
    write(repo, 'a.txt', 12)
    write(repo, 'new.txt', 3)
    expect(await readTaskDiffSummary(repo)).toEqual({ added: 5, deleted: 0 })
  })

  it("counts a task worktree's commits and changes since it branched off, not the stream's later commits", async () => {
    git(repo, 'branch', 'stream')
    const wt = path.join(root, 'task')
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt, 'stream')
    // The task commits 4 new lines, then leaves 2 more uncommitted and an untracked file.
    write(wt, 'a.txt', 14)
    git(wt, 'commit', '-q', '-am', 'task work')
    write(wt, 'a.txt', 16)
    write(wt, 'notes.txt', 1)
    // The stream moves on meanwhile: none of that is the task's.
    git(repo, 'checkout', '-q', 'stream')
    write(repo, 'b.txt', 50)
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'stream work')

    expect(await readTaskDiffSummary(wt, 'stream')).toEqual({ added: 7, deleted: 0 })
  })

  it('falls back to uncommitted changes when the base branch is gone', async () => {
    write(repo, 'a.txt', 11)
    expect(await readTaskDiffSummary(repo, 'no-such-branch')).toEqual({ added: 1, deleted: 0 })
  })

  it('is null outside a git repo', async () => {
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    expect(await readTaskDiffSummary(plain)).toBeNull()
  })
})
