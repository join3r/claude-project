import { describe, it, expect } from 'vitest'
import { branchSlug, defaultBaseBranch, isNewTaskDraftValid, matchProjects, terminalTaskName } from '../src/renderer/components/newTask'
import { defaultStreamBranch, nextVersions, streamWorktreeSupported, suggestStreamName } from '../src/renderer/components/newStream'
import { fixtureProject } from './helpers/streams-fixtures'

describe('branchSlug', () => {
  it('turns a prose task name into a git-safe branch', () => {
    expect(branchSlug('Fix inbox badge count')).toBe('fix-inbox-badge-count')
  })

  it('collapses punctuation runs instead of emitting empty segments', () => {
    expect(branchSlug('fix: the (inbox) badge!!')).toBe('fix-the-inbox-badge')
  })

  it('keeps the characters git allows', () => {
    expect(branchSlug('feature/inbox-v2.1')).toBe('feature/inbox-v2.1')
  })

  it('strips leading and trailing separators', () => {
    expect(branchSlug('  --wip--  ')).toBe('wip')
    expect(branchSlug('/nested/')).toBe('nested')
  })

  it('rejects sequences git refuses outright', () => {
    // ".." and "@{" are invalid inside a ref name.
    expect(branchSlug('bump..version')).toBe('bump.version')
    expect(branchSlug('at@{1}')).toBe('at-1')
  })

  it('drops a trailing .lock, which git reserves', () => {
    expect(branchSlug('package.lock')).toBe('package')
    expect(branchSlug('a.lock.lock')).toBe('a')
  })

  it('returns empty for a name with nothing usable in it', () => {
    expect(branchSlug('   ')).toBe('')
    expect(branchSlug('???')).toBe('')
  })
})

describe('isNewTaskDraftValid', () => {
  const base = { target: { kind: 'project' as const, projectId: 'p1' }, prompt: 'Do the thing' }

  it('needs a destination', () => {
    expect(isNewTaskDraftValid(base)).toBe(true)
    expect(isNewTaskDraftValid({ ...base, target: null })).toBe(false)
    expect(isNewTaskDraftValid({ ...base, target: { kind: 'project', projectId: '' } })).toBe(false)
  })

  it('allows a task with no prompt, which opens on its prompt box', () => {
    expect(isNewTaskDraftValid({ ...base, prompt: '   ' })).toBe(true)
  })

  it('accepts a bare directory as the destination', () => {
    expect(isNewTaskDraftValid({ ...base, target: { kind: 'dir', directory: '/tmp/scratch' } })).toBe(true)
    expect(isNewTaskDraftValid({ ...base, target: { kind: 'dir', directory: '' } })).toBe(false)
  })

})

describe('terminalTaskName', () => {
  it('names a terminal task after its start-up command, else "Terminal"', () => {
    expect(terminalTaskName('npm run dev')).toBe('npm run dev')
    expect(terminalTaskName('  make watch \n echo done')).toBe('make watch')
    expect(terminalTaskName('')).toBe('Terminal')
    expect(terminalTaskName(undefined)).toBe('Terminal')
    expect(terminalTaskName('x'.repeat(80))).toHaveLength(60)
  })
})

describe('new stream suggestions', () => {
  it('bumps a version: patch next, minor one click away', () => {
    expect(nextVersions('0.4.2')).toEqual({ next: '0.4.3', minor: '0.5.0' })
    expect(nextVersions('v1.9.9')).toEqual({ next: 'v1.9.10', minor: 'v1.10.0' })
    expect(nextVersions('0.4')).toEqual({ next: '0.5', minor: '1.0' })
    expect(nextVersions('bugfixes')).toBeNull()
    expect(nextVersions('1.2.3-rc1')).toBeNull()
    expect(nextVersions('5')).toBeNull()
  })

  it('suggests from the last stream other than main', () => {
    const stream = (id: string, name: string) => ({ id, name, tasks: [] })
    const base = fixtureProject({ id: 'p' })
    expect(suggestStreamName(base)).toEqual({ name: '' })
    expect(suggestStreamName({ ...base, streams: [...base.streams, stream('a', '0.4.1'), stream('b', '0.4.2')] }))
      .toEqual({ name: '0.4.3', minor: '0.5.0' })
    expect(suggestStreamName({ ...base, streams: [...base.streams, stream('a', '0.4.2'), stream('b', 'bugfixes')] }))
      .toEqual({ name: '' })
  })

  it('branches after the name, and offers worktrees except for custom shells', () => {
    expect(defaultStreamBranch('0.5.0')).toBe('0.5.0')
    expect(defaultStreamBranch('Bug fixes')).toBe('bug-fixes')
    const p = fixtureProject({ id: 'p' })
    expect(streamWorktreeSupported(p)).toBe(true)
    expect(streamWorktreeSupported({ ...p, ssh: { host: 'h', port: 22, username: 'u', remoteDir: '' } })).toBe(true)
    expect(streamWorktreeSupported({ ...p, shellCommand: { command: 'top' } })).toBe(false)
  })
})

describe('matchProjects', () => {
  const names = (ps: { name: string }[]): string[] => ps.map(p => p.name)
  const projects = [{ name: 'devtool' }, { name: 'my-notes' }, { name: 'notes' }, { name: 'scripts' }]

  it('keeps the given order when nothing is typed', () => {
    expect(names(matchProjects(projects, ''))).toEqual(['devtool', 'my-notes', 'notes', 'scripts'])
    expect(names(matchProjects(projects, '   '))).toEqual(['devtool', 'my-notes', 'notes', 'scripts'])
  })

  it('matches case-insensitively on a substring', () => {
    expect(names(matchProjects(projects, 'NOTE'))).toEqual(['notes', 'my-notes'])
  })

  it('matches a subsequence, not just a substring', () => {
    expect(names(matchProjects(projects, 'dvt'))).toEqual(['devtool'])
  })

  it('ranks a prefix hit above a mid-name one', () => {
    expect(names(matchProjects(projects, 'notes'))).toEqual(['notes', 'my-notes'])
  })

  it('keeps single-letter filters useful instead of scoring them away', () => {
    expect(names(matchProjects(projects, 'y'))).toEqual(['my-notes'])
  })

  it('returns nothing when the filter matches nothing', () => {
    expect(matchProjects(projects, 'zzz')).toEqual([])
  })
})

describe('defaultBaseBranch', () => {
  it('prefers main, then master, then the first branch', () => {
    expect(defaultBaseBranch(['dev', 'master', 'main'])).toBe('main')
    expect(defaultBaseBranch(['dev', 'master'])).toBe('master')
    expect(defaultBaseBranch(['dev', 'topic'])).toBe('dev')
    expect(defaultBaseBranch([])).toBe('')
  })
})
