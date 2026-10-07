import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  notebookAllowedCwdRoots,
  pathIsInsideRoot,
  resolveNotebookKernelCwd
} from '../src/main/notebook-cwd'
import { NOTEBOOK_ERROR_CWD } from '../src/shared/notebook'

const win = { platform: 'win32' as const, path: path.win32 }
const posix = { platform: 'linux' as const, path: path.posix }

describe('notebookAllowedCwdRoots', () => {
  it('includes the project directory and each stream worktree', () => {
    expect(
      notebookAllowedCwdRoots({
        directory: 'C:\\proj',
        streams: [
          { workspace: { worktreePath: 'C:\\proj\\.worktrees\\t1' } },
          { workspace: { worktreePath: 'C:\\proj\\.worktrees\\t1' } },
          {}
        ]
      })
    ).toEqual(['C:\\proj', 'C:\\proj\\.worktrees\\t1'])
  })
})

describe('pathIsInsideRoot', () => {
  it('rejects a sibling prefix like proj vs proj-evil on Windows', () => {
    expect(pathIsInsideRoot('C:\\proj-evil', 'C:\\proj', path.win32, true)).toBe(false)
    expect(pathIsInsideRoot('C:\\proj\\src', 'C:\\proj', path.win32, true)).toBe(true)
    expect(pathIsInsideRoot('C:\\proj', 'C:\\proj', path.win32, true)).toBe(true)
  })

  it('is case-insensitive on Windows', () => {
    expect(pathIsInsideRoot('C:\\PROJ\\src', 'c:\\proj', path.win32, true)).toBe(true)
  })

  it('rejects a sibling prefix on POSIX', () => {
    expect(pathIsInsideRoot('/proj-evil', '/proj', path.posix, false)).toBe(false)
    expect(pathIsInsideRoot('/proj/src', '/proj', path.posix, false)).toBe(true)
  })
})

describe('resolveNotebookKernelCwd', () => {
  it('accepts a nested path under the project directory', () => {
    const result = resolveNotebookKernelCwd('C:\\proj\\notebooks', ['C:\\proj'], win)
    expect(result).toEqual({ ok: true, cwd: path.win32.resolve('C:\\proj\\notebooks') })
  })

  it('accepts a worktree outside the project directory', () => {
    const result = resolveNotebookKernelCwd(
      'D:\\wt\\task',
      ['C:\\proj', 'D:\\wt\\task'],
      win
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.cwd.toLowerCase()).toBe('d:\\wt\\task')
  })

  it('rejects cwd outside every allowed root', () => {
    expect(resolveNotebookKernelCwd('C:\\other', ['C:\\proj'], win)).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_CWD
    })
    expect(resolveNotebookKernelCwd('C:\\proj-evil', ['C:\\proj'], win)).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_CWD
    })
  })

  it('rejects empty cwd and empty roots', () => {
    expect(resolveNotebookKernelCwd('', ['/proj'], posix)).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_CWD
    })
    expect(resolveNotebookKernelCwd('/proj', [], posix)).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_CWD
    })
  })
})
