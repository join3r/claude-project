import { describe, it, expect } from 'vitest'
import { taskBranchName } from '../src/shared/branch-name'

describe('taskBranchName', () => {
  it('joins the stream branch and the task slug with --', () => {
    expect(taskBranchName('0.5.0', 'Fix inbox badge count', [])).toBe('0.5.0--fix-inbox-badge-count')
  })

  it('keeps a stream branch with a slash and flattens slashes in the task name', () => {
    expect(taskBranchName('feature/inbox', 'api/v2 cleanup', [])).toBe('feature/inbox--api-v2-cleanup')
  })

  it('falls back to "task" for an empty or placeholder name', () => {
    expect(taskBranchName('s', '', [])).toBe('s--task')
    expect(taskBranchName('s', '   ', [])).toBe('s--task')
    expect(taskBranchName('s', 'New Task', [])).toBe('s--task')
    expect(taskBranchName('s', 'new task', [])).toBe('s--task')
    expect(taskBranchName('s', '!!!', [])).toBe('s--task')
  })

  it('cuts a long name without leaving a trailing separator', () => {
    const name = 'Refactor the session restore code so that it handles every tab type…'
    const branch = taskBranchName('s', name, [])
    const slug = branch.slice('s--'.length)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toMatch(/^[a-z0-9]/)
    expect(slug).toMatch(/[a-z0-9]$/)
  })

  it('does not end in .lock after the cut', () => {
    expect(taskBranchName('s', 'x.lock', [])).toBe('s--x')
  })

  it('appends -2, -3… when the name is taken', () => {
    expect(taskBranchName('s', 'fix', ['s--fix'])).toBe('s--fix-2')
    expect(taskBranchName('s', 'fix', ['s--fix', 's--fix-2'])).toBe('s--fix-3')
    expect(taskBranchName('s', 'New Task', ['s--task'])).toBe('s--task-2')
  })

  it('treats names differing only in case as taken', () => {
    expect(taskBranchName('S', 'fix', ['s--FIX'])).toBe('S--fix-2')
  })

  it('treats a name that is a folder of an existing ref as taken', () => {
    expect(taskBranchName('s', 'fix', ['s--fix/old'])).toBe('s--fix-2')
  })

  it('ignores unrelated branches', () => {
    expect(taskBranchName('s', 'fix', ['master', 's', 's--fixes', 'other--fix'])).toBe('s--fix')
  })
})
