import { describe, expect, it } from 'vitest'
import { countNulPaths, countNumstatFiles, countTextLines, parseNumstat } from '../src/main/git-diff-summary'

describe('parseNumstat', () => {
  it('sums added and deleted lines from git numstat output', () => {
    expect(parseNumstat('12\t4\tsrc/app.ts\n3\t0\tREADME.md\n')).toEqual({
      added: 15,
      deleted: 4
    })
  })

  it('ignores binary file entries', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n5\t2\tsrc/app.ts\n')).toEqual({
      added: 5,
      deleted: 2
    })
  })
})

describe('file counts', () => {
  it('counts one file per numstat line, binary files included', () => {
    expect(countNumstatFiles('-\t-\tassets/logo.png\n5\t2\tsrc/app.ts\n')).toBe(2)
    expect(countNumstatFiles('')).toBe(0)
  })

  it('counts NUL-separated paths', () => {
    expect(countNulPaths('a.ts\0dir/b.ts\0')).toBe(2)
    expect(countNulPaths('')).toBe(0)
  })
})

describe('countTextLines', () => {
  it('counts logical lines for text with a trailing newline', () => {
    expect(countTextLines('first\nsecond\n')).toBe(2)
  })

  it('counts a single line without a trailing newline', () => {
    expect(countTextLines('first')).toBe(1)
  })

  it('returns zero for empty files', () => {
    expect(countTextLines('')).toBe(0)
  })
})
