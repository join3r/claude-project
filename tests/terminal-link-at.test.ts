import { describe, expect, it } from 'vitest'
import { findLinkInLine } from '../src/renderer/utils/terminalLinkAt'

describe('findLinkInLine', () => {
  it('returns the URL when the column is inside it', () => {
    const line = 'see https://example.com/path for details'
    const url = 'https://example.com/path'
    const start = line.indexOf(url)
    expect(findLinkInLine(line, start)).toBe(url)
    expect(findLinkInLine(line, start + url.length - 1)).toBe(url)
  })

  it('returns null when the column is outside any URL', () => {
    const line = 'see https://example.com for details'
    expect(findLinkInLine(line, 0)).toBeNull()
    expect(findLinkInLine(line, 3)).toBeNull()
  })

  it('picks the correct URL when multiple links are on one line', () => {
    const line = 'a https://one.test b http://two.test c'
    expect(findLinkInLine(line, 2)).toBe('https://one.test')
    expect(findLinkInLine(line, line.indexOf('http://two.test') + 4)).toBe('http://two.test')
  })
})
