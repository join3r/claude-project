import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  anchoredExcludeLine,
  ensureInfoExclude,
  excludeLinesFor,
  gitCommonDir,
  normalizeConfigPath,
  parseWorktreeConfig,
  readWorktreeConfig,
  runWorktreeSetup,
  WORKTREE_CONFIG_FILE,
  type WorktreeSetupRequest
} from '../src/main/worktree-setup'
import { FileSetupApprovals, MemorySetupApprovals } from '../src/main/worktree-setup-approvals'
import { LocalGitRunner } from '../src/main/git-runner'
import { canonicalFilePath, WorkspaceManager } from '../src/main/workspace-manager'

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

function addWorktree(repo: string, branch: string, base = 'master'): string {
  const dest = path.join(repo, '.worktrees', branch)
  git(repo, 'worktree', 'add', '-q', dest, '-b', branch, base)
  return canonicalFilePath(dest)
}

function writeConfig(dir: string, config: unknown): string {
  const text = typeof config === 'string' ? config : JSON.stringify(config, null, 2)
  fs.mkdirSync(path.join(dir, '.devtool'), { recursive: true })
  fs.writeFileSync(path.join(dir, WORKTREE_CONFIG_FILE), text)
  return text
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function excludeFile(repo: string): string {
  return path.join(repo, '.git', 'info', 'exclude')
}

/** Lines `git status --porcelain` reports, untracked included. */
function status(dir: string): string[] {
  return git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
}

describe('parseWorktreeConfig', () => {
  it('accepts the three lists and ignores unknown keys', () => {
    expect(parseWorktreeConfig({ setup: ['npm ci'], symlink: ['node_modules'], copy: ['.env'], ports: [3000] })).toEqual({
      ok: true,
      config: { setup: ['npm ci'], symlink: ['node_modules'], copy: ['.env'] }
    })
  })

  it('treats missing keys as empty', () => {
    expect(parseWorktreeConfig({})).toEqual({ ok: true, config: { setup: [], symlink: [], copy: [] } })
  })

  it('normalizes paths and drops duplicates', () => {
    const result = parseWorktreeConfig({ symlink: ['./node_modules/', 'node_modules', 'apps\\web\\node_modules'] })
    expect(result).toEqual({ ok: true, config: { setup: [], symlink: ['node_modules', 'apps/web/node_modules'], copy: [] } })
  })

  it.each([
    ['/etc/passwd'],
    ['C:\\Windows'],
    ['../outside'],
    ['a/../../outside'],
    ['a/../b'],
    ['.'],
    [''],
    ['.git'],
    ['.git/hooks'],
    ['.GIT/config']
  ])('rejects %j', (entry) => {
    const result = parseWorktreeConfig({ copy: [entry] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('copy[0]')
  })

  it('rejects wrong shapes with a message naming the key', () => {
    const cases: Array<[unknown, string]> = [
      [[], 'JSON object'],
      [null, 'JSON object'],
      ['npm ci', 'JSON object'],
      [{ setup: 'npm ci' }, '"setup"'],
      [{ setup: ['ok', ''] }, 'setup[1]'],
      [{ setup: [3] }, 'setup[0]'],
      [{ symlink: 'node_modules' }, '"symlink"'],
      [{ copy: [42] }, 'copy[0]']
    ]
    for (const [raw, fragment] of cases) {
      const result = parseWorktreeConfig(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain(WORKTREE_CONFIG_FILE)
        expect(result.error).toContain(fragment)
      }
    }
  })

  it('normalizeConfigPath returns null for escapes', () => {
    expect(normalizeConfigPath('a/b')).toBe('a/b')
    expect(normalizeConfigPath('..')).toBeNull()
    expect(normalizeConfigPath('\\\\server\\share')).toBeNull()
  })
})

describe('readWorktreeConfig', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-config-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('is empty with no hash when there is no file', () => {
    expect(readWorktreeConfig(dir)).toEqual({ ok: true, config: { setup: [], symlink: [], copy: [] }, hash: null })
  })

  it('hashes the raw file', () => {
    const text = writeConfig(dir, { setup: ['echo hi'] })
    expect(readWorktreeConfig(dir)).toEqual({ ok: true, config: { setup: ['echo hi'], symlink: [], copy: [] }, hash: sha256(text) })
  })

  it('reports bad JSON instead of throwing', () => {
    writeConfig(dir, '{ "setup": [')
    const result = readWorktreeConfig(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not valid JSON')
  })
})

describe('exclude lines', () => {
  it('anchors entries and escapes glob characters', () => {
    expect(anchoredExcludeLine('node_modules')).toBe('/node_modules')
    expect(anchoredExcludeLine('a*b/[x]?')).toBe('/a\\*b/\\[x]\\?')
  })

  it('always covers hook settings and the worktrees folder', () => {
    expect(excludeLinesFor({ setup: [], symlink: ['node_modules'], copy: ['.env', 'node_modules'] })).toEqual([
      '**/.claude/settings.local.json', '/.worktrees/', '/node_modules', '/.env'
    ])
  })
})

describe('worktree setup on real repos', () => {
  const runner = new LocalGitRunner()
  let repo: string
  let outside: string

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setup-')))
    outside = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-outside-')))
    initGitRepo(repo)
  })

  afterEach(() => {
    try { git(repo, 'worktree', 'prune') } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const request = (worktreeRoot: string, extra: Partial<WorktreeSetupRequest> = {}): WorktreeSetupRequest => ({
    sourceRoot: repo,
    worktreeRoot,
    branch: path.basename(worktreeRoot),
    runner,
    env: { ...process.env } as Record<string, string>,
    ...extra
  })

  describe('ensureInfoExclude', () => {
    it('resolves the common dir from a linked worktree', async () => {
      const wt = addWorktree(repo, 'a')
      expect(await gitCommonDir(runner, wt)).toBe(canonicalFilePath(path.join(repo, '.git')))
    })

    it('appends missing lines, keeps the user\'s, and is idempotent', async () => {
      fs.mkdirSync(path.dirname(excludeFile(repo)), { recursive: true })
      fs.writeFileSync(excludeFile(repo), '# mine\n*.swp\n/node_modules')
      const commonDir = await gitCommonDir(runner, repo)

      const added = await ensureInfoExclude(commonDir, ['/node_modules', '/.env'])
      expect(added).toEqual(['/.env'])
      const once = fs.readFileSync(excludeFile(repo), 'utf8')
      expect(once.startsWith('# mine\n*.swp\n/node_modules\n')).toBe(true)
      expect(once.split('\n').filter(line => line === '/.env')).toHaveLength(1)

      expect(await ensureInfoExclude(commonDir, ['/node_modules', '/.env'])).toEqual([])
      expect(fs.readFileSync(excludeFile(repo), 'utf8')).toBe(once)
    })

    it('does not add a line twice when two writers run at once', async () => {
      const commonDir = await gitCommonDir(runner, repo)
      await Promise.all([ensureInfoExclude(commonDir, ['/x']), ensureInfoExclude(commonDir, ['/x'])])
      const lines = fs.readFileSync(excludeFile(repo), 'utf8').split('\n')
      expect(lines.filter(line => line === '/x')).toHaveLength(1)
    })

    it('is seen by every linked worktree', async () => {
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
      git(repo, 'add', '.gitignore')
      git(repo, 'commit', '-qm', 'ignore')
      fs.mkdirSync(path.join(repo, 'node_modules'))
      const wt = addWorktree(repo, 'linked')
      // A symlink named node_modules is not a directory to `node_modules/`.
      fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'), 'junction')
      fs.mkdirSync(path.join(wt, 'apps', 'web', '.claude'), { recursive: true })
      fs.writeFileSync(path.join(wt, 'apps', 'web', '.claude', 'settings.local.json'), '{}')
      expect(status(wt).length).toBeGreaterThan(0)

      await ensureInfoExclude(await gitCommonDir(runner, wt), excludeLinesFor({ setup: [], symlink: ['node_modules'], copy: [] }))
      expect(status(wt)).toEqual([])
      expect(status(repo)).toEqual([])
    })
  })

  describe('runWorktreeSetup', () => {
    it('links and copies from the source, and leaves the worktree clean', async () => {
      writeConfig(repo, { symlink: ['node_modules', 'missing-dir'], copy: ['.env', 'config/local.json', 'missing.txt'] })
      fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
      fs.mkdirSync(path.join(repo, 'config'))
      fs.writeFileSync(path.join(repo, 'config', 'local.json'), '{"a":1}')
      const wt = addWorktree(repo, 'stream')

      const result = await runWorktreeSetup(request(wt))
      expect(result.status).toBe('ok')
      expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(true)
      expect(canonicalFilePath(path.join(wt, 'node_modules'))).toBe(canonicalFilePath(path.join(repo, 'node_modules')))
      expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n')
      expect(fs.readFileSync(path.join(wt, 'config', 'local.json'), 'utf8')).toBe('{"a":1}')
      expect(fs.existsSync(path.join(wt, 'missing-dir'))).toBe(false)
      expect(result.log).toContain('missing.txt: not in the source checkout, skipped')
      // The config file itself is untracked in the source only; the worktree has nothing to commit.
      expect(status(wt)).toEqual([])
    })

    it('leaves an existing destination alone and can run again', async () => {
      writeConfig(repo, { copy: ['.env'] })
      fs.writeFileSync(path.join(repo, '.env'), 'source\n')
      const wt = addWorktree(repo, 'again')
      fs.writeFileSync(path.join(wt, '.env'), 'mine\n')

      const first = await runWorktreeSetup(request(wt))
      const second = await runWorktreeSetup(request(wt))
      expect(first.status).toBe('ok')
      expect(second.status).toBe('ok')
      expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('mine\n')
      expect(second.log).toContain('.env: already in the worktree, left alone')
    })

    it('links a task worktree to the real folder behind the stream\'s link', async () => {
      writeConfig(repo, { symlink: ['node_modules'] })
      fs.mkdirSync(path.join(repo, 'node_modules'))
      const stream = addWorktree(repo, 'stream')
      expect((await runWorktreeSetup(request(stream))).status).toBe('ok')
      writeConfig(stream, { symlink: ['node_modules'] })
      const task = addWorktree(repo, 'stream--task', 'stream')

      const result = await runWorktreeSetup(request(task, { sourceRoot: stream }))
      expect(result.status).toBe('ok')
      expect(fs.readlinkSync(path.join(task, 'node_modules')).replace(/[\\/]$/, '')).toBe(canonicalFilePath(path.join(repo, 'node_modules')))
    })

    it('reports a bad config but still writes the base exclude lines', async () => {
      writeConfig(repo, { symlink: ['../escape'] })
      const wt = addWorktree(repo, 'bad')
      const result = await runWorktreeSetup(request(wt))
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.error).toContain('symlink[0]')
      expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain('**/.claude/settings.local.json')
    })

    describe('setup commands', () => {
      // A relative `ran.txt` also proves the command ran in the worktree.
      const envCommand = 'printf "%s\\n" "$DEVTOOL_BRANCH" "$DEVTOOL_SOURCE_PATH" "$DEVTOOL_WORKTREE_PATH" > ran.txt'

      it('does not run commands of an unapproved config, but links and copies', async () => {
        const text = writeConfig(repo, { setup: [envCommand], copy: ['.env'] })
        fs.writeFileSync(path.join(repo, '.env'), 'x')
        const wt = addWorktree(repo, 'gate')

        const result = await runWorktreeSetup(request(wt, { approvals: new MemorySetupApprovals() }))
        expect(result.status).toBe('needs-approval')
        if (result.status !== 'needs-approval') return
        expect(result.pending).toEqual({
          repoKey: canonicalFilePath(path.join(repo, '.git')),
          hash: sha256(text),
          commands: [envCommand]
        })
        expect(fs.existsSync(path.join(wt, 'ran.txt'))).toBe(false)
        expect(fs.existsSync(path.join(wt, '.env'))).toBe(true)
      })

      it('never runs commands without an approvals store', async () => {
        writeConfig(repo, { setup: ['touch ran.txt'] })
        const wt = addWorktree(repo, 'no-store')
        expect((await runWorktreeSetup(request(wt))).status).toBe('needs-approval')
        expect(fs.existsSync(path.join(wt, 'ran.txt'))).toBe(false)
      })

      it('runs approved commands in the worktree with the DEVTOOL_* env', async () => {
        writeConfig(repo, { setup: [envCommand] })
        const approvals = new MemorySetupApprovals()
        const wt = addWorktree(repo, 'approved')
        const pending = await runWorktreeSetup(request(wt, { approvals }))
        if (pending.status !== 'needs-approval') throw new Error(`expected needs-approval, got ${pending.status}`)
        approvals.approve(pending.pending.repoKey, pending.pending.hash)

        const result = await runWorktreeSetup(request(wt, { approvals }))
        expect(result.status).toBe('ok')
        const [branch, source, worktree] = fs.readFileSync(path.join(wt, 'ran.txt'), 'utf8').split('\n')
        expect(branch).toBe('approved')
        expect(source).toBe(repo)
        expect(worktree).toBe(wt)
        expect(result.log).toContain(`$ ${envCommand}`)
      })

      it('asks again once the config changes', async () => {
        writeConfig(repo, { setup: ['touch first.txt'] })
        const approvals = new MemorySetupApprovals()
        const one = addWorktree(repo, 'one')
        const pending = await runWorktreeSetup(request(one, { approvals }))
        if (pending.status !== 'needs-approval') throw new Error('expected needs-approval')
        approvals.approve(pending.pending.repoKey, pending.pending.hash)
        expect((await runWorktreeSetup(request(one, { approvals }))).status).toBe('ok')

        writeConfig(repo, { setup: ['touch first.txt', 'touch second.txt'] })
        const two = addWorktree(repo, 'two')
        const again = await runWorktreeSetup(request(two, { approvals }))
        expect(again.status).toBe('needs-approval')
        expect(fs.existsSync(path.join(two, 'first.txt'))).toBe(false)
        expect(fs.existsSync(path.join(two, 'second.txt'))).toBe(false)
      })

      it('stops at a failing command and reports its output', async () => {
        writeConfig(repo, { setup: ['echo preparing; echo broken >&2; exit 3', 'touch after.txt'] })
        const approvals = new MemorySetupApprovals()
        const wt = addWorktree(repo, 'fails')
        const pending = await runWorktreeSetup(request(wt, { approvals }))
        if (pending.status !== 'needs-approval') throw new Error('expected needs-approval')
        approvals.approve(pending.pending.repoKey, pending.pending.hash)

        const result = await runWorktreeSetup(request(wt, { approvals }))
        expect(result.status).toBe('failed')
        if (result.status !== 'failed') return
        expect(result.error).toContain('exited with code 3')
        expect(result.error).toContain('broken')
        expect(result.log).toContain('preparing')
        expect(fs.existsSync(path.join(wt, 'after.txt'))).toBe(false)
        // The worktree itself is untouched by the failure.
        expect(fs.existsSync(wt)).toBe(true)
      })
    })

    describe('escapes', () => {
      it('refuses a source behind a symlinked folder', async () => {
        fs.writeFileSync(path.join(outside, 'secret'), 'top secret')
        fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction')
        writeConfig(repo, { copy: ['linked/secret'] })
        const wt = addWorktree(repo, 'esc1')

        const result = await runWorktreeSetup(request(wt))
        expect(result.status).toBe('failed')
        if (result.status === 'failed') expect(result.error).toMatch(/symlink; refused/)
        expect(fs.existsSync(path.join(wt, 'linked'))).toBe(false)
      })

      it('refuses a source that is a symlink out of the repository', async () => {
        fs.writeFileSync(path.join(outside, 'secret'), 'top secret')
        fs.symlinkSync(outside, path.join(repo, 'leak'), 'junction')
        writeConfig(repo, { copy: ['leak'] })
        const wt = addWorktree(repo, 'esc2')

        const result = await runWorktreeSetup(request(wt))
        expect(result.status).toBe('failed')
        if (result.status === 'failed') expect(result.error).toContain('outside the repository; refused')
        expect(fs.existsSync(path.join(wt, 'leak'))).toBe(false)
      })

      it('refuses a destination behind a symlinked folder in the worktree', async () => {
        fs.mkdirSync(path.join(repo, 'out'))
        fs.writeFileSync(path.join(repo, 'out', 'payload'), 'x')
        writeConfig(repo, { copy: ['out/payload'] })
        const wt = addWorktree(repo, 'esc3')
        fs.symlinkSync(outside, path.join(wt, 'out'), 'junction')

        const result = await runWorktreeSetup(request(wt))
        expect(result.status).toBe('failed')
        if (result.status === 'failed') expect(result.error).toMatch(/in the worktree is a symlink; refused/)
        expect(fs.existsSync(path.join(outside, 'payload'))).toBe(false)
      })
    })
  })

  describe('WorkspaceManager.create', () => {
    it('applies setup to a new stream worktree and keeps it while commands wait', async () => {
      writeConfig(repo, { symlink: ['node_modules'], setup: ['touch ready.txt'] })
      fs.mkdirSync(path.join(repo, 'node_modules'))
      const approvals = new MemorySetupApprovals()
      const manager = new WorkspaceManager({ approvals })

      const created = await manager.create(repo, 'with-setup', 'master')
      expect(fs.lstatSync(path.join(created.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true)
      expect(created.setup.status).toBe('needs-approval')
      if (created.setup.status !== 'needs-approval') return
      expect(fs.existsSync(path.join(created.worktreePath, 'ready.txt'))).toBe(false)

      manager.approveSetup(created.setup.pending.repoKey, created.setup.pending.hash)
      const rerun = await manager.runSetup({ sourceRoot: repo, worktreeRoot: created.worktreePath, branch: created.branchName })
      expect(rerun.status).toBe('ok')
      expect(fs.existsSync(path.join(created.worktreePath, 'ready.txt'))).toBe(true)
    })
  })
})

describe('FileSetupApprovals', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-approvals-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('persists approvals per repo and content', () => {
    new FileSetupApprovals(dir).approve('/repo/.git', 'aaa')
    const store = new FileSetupApprovals(dir)
    expect(store.isApproved('/repo/.git', 'aaa')).toBe(true)
    expect(store.isApproved('/repo/.git', 'bbb')).toBe(false)
    expect(store.isApproved('/other/.git', 'aaa')).toBe(false)
  })

  it('approves nothing from a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'worktree-setup-approvals.json'), '{nope')
    const store = new FileSetupApprovals(dir)
    expect(store.isApproved('/repo/.git', 'aaa')).toBe(false)
    store.approve('/repo/.git', 'aaa')
    expect(store.isApproved('/repo/.git', 'aaa')).toBe(true)
  })
})
