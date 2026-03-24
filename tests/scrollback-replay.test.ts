import { describe, expect, it } from 'vitest'
import { sanitizeRestoredScrollback } from '../src/renderer/components/scrollbackReplay'

describe('sanitizeRestoredScrollback', () => {
  it('removes terminal report noise from restored scrollback', () => {
    const scrollback =
      'prefix' +
      '\x1b[I' +
      '\x1b[1;1R' +
      '\x1b[?62;4;9;22c' +
      '\x1b]10;rgb:cccc/cccc/cccc\x1b\\' +
      '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' +
      'suffix'

    expect(sanitizeRestoredScrollback(scrollback)).toBe('prefixsuffix')
  })

  it('removes terminal probe queries without touching normal ansi styling', () => {
    const scrollback =
      '\x1b]10;?\x1b\\' +
      '\x1b]11;?\x07' +
      '\x1b[6n' +
      '\x1b[>0c' +
      '\x1b[31mhello\x1b[0m'

    expect(sanitizeRestoredScrollback(scrollback)).toBe('\x1b[31mhello\x1b[0m')
  })
})
