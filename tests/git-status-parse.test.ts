import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GIT_STATUS_ARGS, parseGitStatusZ } from '../src/main/git-status-parse'
import { gitEntryPaths } from '../src/shared/types'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
}

/** Exactly what the `fb-git-status` handler runs and parses. */
function status() {
  return parseGitStatusZ(git(...GIT_STATUS_ARGS))
}

/** Exactly what the `fb-git-stage` / `fb-git-unstage` handlers run. */
function stage(files: string[]): void {
  git('add', '--', ...files)
}
function unstage(files: string[]): void {
  git('reset', 'HEAD', '--', ...files)
}

function write(relativePath: string, content: string): void {
  fs.writeFileSync(path.join(repo, relativePath), content)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-parse-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: repo })
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  write('seed.txt', 'seed\n')
  stage(['seed.txt'])
  git('commit', '-qm', 'init')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('parseGitStatusZ against real repositories', () => {
  it('keeps a path with spaces raw and stages it', () => {
    write('a b.txt', 'x\n')
    stage(['a b.txt'])
    git('commit', '-qm', 'add spaced file')
    write('a b.txt', 'x\nmore\n')

    const modified = status()
    expect(modified.unstaged).toEqual([{ relativePath: 'a b.txt', status: 'M' }])

    // The raw path must be a usable pathspec — the old parser produced the
    // 7-character string `"a b.txt"` (quotes included) and this threw.
    stage(gitEntryPaths(modified.unstaged[0]))
    const staged = status()
    expect(staged.staged).toEqual([{ relativePath: 'a b.txt', status: 'M' }])
    expect(staged.unstaged).toEqual([])
  })

  it('keeps a non-ASCII path raw and stages it', () => {
    write('ünïcode.txt', 'u\n')

    const untracked = status()
    expect(untracked.untracked).toEqual([{ relativePath: 'ünïcode.txt', status: '?' }])

    stage(gitEntryPaths(untracked.untracked[0]))
    expect(status().staged).toEqual([{ relativePath: 'ünïcode.txt', status: 'A' }])
  })

  it('keeps a path with a backslash and a double quote raw and stages it', () => {
    const weird = 'q"back\\slash.txt'
    write(weird, 'z\n')

    const untracked = status()
    expect(untracked.untracked).toEqual([{ relativePath: weird, status: '?' }])

    stage(gitEntryPaths(untracked.untracked[0]))
    expect(status().staged).toEqual([{ relativePath: weird, status: 'A' }])
  })

  it('reports both paths of a staged rename and round-trips stage/unstage', () => {
    write('old name.txt', 'renameable\n')
    stage(['old name.txt'])
    git('commit', '-qm', 'add renameable')

    git('mv', 'old name.txt', 'nëw name.txt')

    const renamed = status()
    expect(renamed.staged).toEqual([
      { relativePath: 'nëw name.txt', status: 'R', origPath: 'old name.txt' }
    ])
    expect(renamed.unstaged).toEqual([])
    expect(gitEntryPaths(renamed.staged[0])).toEqual(['nëw name.txt', 'old name.txt'])

    // Unstaging must touch both sides, otherwise the old path stays deleted in
    // the index.
    unstage(gitEntryPaths(renamed.staged[0]))
    const afterUnstage = status()
    expect(afterUnstage.staged).toEqual([])
    expect(afterUnstage.unstaged).toEqual([{ relativePath: 'old name.txt', status: 'D' }])
    expect(afterUnstage.untracked).toEqual([{ relativePath: 'nëw name.txt', status: '?' }])

    // Re-staging both sides restores the rename.
    stage(['old name.txt', 'nëw name.txt'])
    expect(status().staged).toEqual([
      { relativePath: 'nëw name.txt', status: 'R', origPath: 'old name.txt' }
    ])
  })

  it('preserves XY semantics for untracked, modified, deleted and staged-plus-modified entries', () => {
    write('modified.txt', 'm\n')
    write('deleted.txt', 'd\n')
    write('both.txt', 'b\n')
    stage(['modified.txt', 'deleted.txt', 'both.txt'])
    git('commit', '-qm', 'fixtures')

    write('modified.txt', 'm2\n')
    fs.rmSync(path.join(repo, 'deleted.txt'))
    write('both.txt', 'b2\n')
    stage(['both.txt'])
    write('both.txt', 'b3\n')
    write('brand new.txt', 'n\n')

    const parsed = status()
    expect(parsed.untracked).toEqual([{ relativePath: 'brand new.txt', status: '?' }])
    // `both.txt` is ` M` in the index column and `M` in the worktree column, so
    // it appears in both lists.
    expect(parsed.staged).toEqual([{ relativePath: 'both.txt', status: 'M' }])
    expect(parsed.unstaged).toEqual([
      { relativePath: 'both.txt', status: 'M' },
      { relativePath: 'deleted.txt', status: 'D' },
      { relativePath: 'modified.txt', status: 'M' }
    ])
  })

  it('never treats a path starting with a dash as an option', () => {
    write('-dash.txt', 'dash\n')

    const untracked = status()
    expect(untracked.untracked).toEqual([{ relativePath: '-dash.txt', status: '?' }])

    // `git add -- -dash.txt`: the `--` separator keeps it a pathspec.
    stage(gitEntryPaths(untracked.untracked[0]))
    expect(status().staged).toEqual([{ relativePath: '-dash.txt', status: 'A' }])

    unstage(gitEntryPaths({ relativePath: '-dash.txt', status: 'A' }))
    expect(status().untracked).toEqual([{ relativePath: '-dash.txt', status: '?' }])
  })

  it('reads a dash-prefixed and a spaced path back through the diff invocation', () => {
    write('-dash.txt', 'dash\n')
    write('a b.txt', 'spaced\n')
    stage(['-dash.txt', 'a b.txt'])
    git('commit', '-qm', 'awkward names')

    // Mirrors `fb-git-diff`: the trailing `--` stops the object argument from
    // being read as an option.
    expect(git('show', 'HEAD:-dash.txt', '--')).toBe('dash\n')
    expect(git('show', 'HEAD:a b.txt', '--')).toBe('spaced\n')
  })
})

describe('parseGitStatusZ record grammar', () => {
  it('parses NUL-terminated records, including paths containing a newline', () => {
    const parsed = parseGitStatusZ('?? line\nbreak.txt\0 M plain.txt\0')
    expect(parsed.untracked).toEqual([{ relativePath: 'line\nbreak.txt', status: '?' }])
    expect(parsed.unstaged).toEqual([{ relativePath: 'plain.txt', status: 'M' }])
  })

  it('consumes the second path field of rename and copy records', () => {
    const parsed = parseGitStatusZ('R  new.txt\0old.txt\0C  copy.txt\0src.txt\0?? after.txt\0')
    expect(parsed.staged).toEqual([
      { relativePath: 'new.txt', status: 'R', origPath: 'old.txt' },
      { relativePath: 'copy.txt', status: 'C', origPath: 'src.txt' }
    ])
    // The origin fields must not leak into the next record.
    expect(parsed.untracked).toEqual([{ relativePath: 'after.txt', status: '?' }])
  })

  it('splits a rename with unstaged edits across both columns', () => {
    const parsed = parseGitStatusZ('RM new.txt\0old.txt\0')
    expect(parsed.staged).toEqual([
      { relativePath: 'new.txt', status: 'R', origPath: 'old.txt' }
    ])
    expect(parsed.unstaged).toEqual([{ relativePath: 'new.txt', status: 'M' }])
  })

  it('returns empty results for empty output', () => {
    expect(parseGitStatusZ('')).toEqual({ staged: [], unstaged: [], untracked: [] })
  })
})
