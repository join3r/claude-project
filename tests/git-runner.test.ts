import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GitError, gitOutput, LocalGitRunner, RemoteGitRunner } from '../src/main/git-runner'
import { canonicalFilePath } from '../src/main/workspace-manager'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'master', dir])
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'commit', '--allow-empty', '-m', 'init')
}

function commitFile(dir: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), content)
  git(dir, 'add', file)
  git(dir, 'commit', '-m', message)
}

describe('LocalGitRunner', () => {
  const runner = new LocalGitRunner()
  let repoDir: string

  beforeEach(() => {
    repoDir = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-')))
    initGitRepo(repoDir)
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  it('returns stdout and exit code 0', async () => {
    const result = await runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('master')
    expect(result.failure).toBeUndefined()
  })

  it('reports a non-zero exit with stderr instead of throwing', async () => {
    const result = await runner.run(['rev-parse', '--verify', 'no-such-ref'], { cwd: repoDir })
    expect(result.code).toBe(128)
    expect(result.stderr).toMatch(/no-such-ref|Needed a single revision/)
    expect(result.failure).toBeUndefined()
  })

  it('leaves a conflicting rebase stopped for the caller to inspect', async () => {
    commitFile(repoDir, 'a.txt', 'base\n', 'base')
    git(repoDir, 'checkout', '-q', '-b', 'topic')
    commitFile(repoDir, 'a.txt', 'topic\n', 'topic')
    git(repoDir, 'checkout', '-q', 'master')
    commitFile(repoDir, 'a.txt', 'master\n', 'master')
    git(repoDir, 'checkout', '-q', 'topic')

    const result = await runner.run(['rebase', 'master'], { cwd: repoDir, env: { GIT_EDITOR: 'true' } })
    expect(result.code).not.toBe(0)
    expect(result.failure).toBeUndefined()
    const conflicted = await runner.run(['diff', '--name-only', '--diff-filter=U'], { cwd: repoDir })
    expect(conflicted.stdout.trim()).toBe('a.txt')
    expect(fs.existsSync(path.join(repoDir, '.git', 'rebase-merge')) || fs.existsSync(path.join(repoDir, '.git', 'rebase-apply'))).toBe(true)
    await runner.run(['rebase', '--abort'], { cwd: repoDir })
  })

  it('passes extra env through', async () => {
    const result = await runner.run(['config', '--get', 'devtool.probe'], {
      cwd: repoDir,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'devtool.probe', GIT_CONFIG_VALUE_0: 'yes' }
    })
    expect(result.stdout.trim()).toBe('yes')
  })

  it('reports a missing cwd as a spawn failure', async () => {
    const result = await runner.run(['status'], { cwd: path.join(repoDir, 'missing') })
    expect(result.code).toBe(-1)
    expect(result.failure).toBe('spawn')
    expect(result.stderr).not.toBe('')
  })

  it('gitOutput throws a GitError carrying stderr', async () => {
    await expect(gitOutput(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).resolves.toBe('master\n')
    const err = await gitOutput(runner, ['checkout', 'no-such-branch'], { cwd: repoDir }).catch(e => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).result.code).not.toBe(0)
    expect((err as GitError).stderr).toContain('no-such-branch')
    expect((err as GitError).message).toContain('no-such-branch')
  })
})

describe('RemoteGitRunner', () => {
  it('reports unsupported', async () => {
    const result = await new RemoteGitRunner().run()
    expect(result.code).toBe(-1)
    expect(result.failure).toBe('unsupported')
  })
})
