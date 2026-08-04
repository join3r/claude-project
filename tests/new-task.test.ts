import { describe, it, expect } from 'vitest'
import { branchSlug, defaultBaseBranch, isNewTaskDraftValid, matchProjects } from '../src/renderer/components/newTask'

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
  const base = { projectId: 'p1', name: 'Do the thing', workspace: false, branch: '', baseBranch: '' }

  it('needs a project and a name', () => {
    expect(isNewTaskDraftValid(base)).toBe(true)
    expect(isNewTaskDraftValid({ ...base, projectId: '' })).toBe(false)
    expect(isNewTaskDraftValid({ ...base, name: '   ' })).toBe(false)
  })

  it('ignores branch fields when no workspace is requested', () => {
    expect(isNewTaskDraftValid({ ...base, branch: '', baseBranch: '' })).toBe(true)
  })

  it('requires both branches once a workspace is requested', () => {
    const ws = { ...base, workspace: true }
    expect(isNewTaskDraftValid(ws)).toBe(false)
    expect(isNewTaskDraftValid({ ...ws, branch: 'do-the-thing' })).toBe(false)
    expect(isNewTaskDraftValid({ ...ws, branch: 'do-the-thing', baseBranch: 'main' })).toBe(true)
    expect(isNewTaskDraftValid({ ...ws, branch: '  ', baseBranch: 'main' })).toBe(false)
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
