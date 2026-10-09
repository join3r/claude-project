import { describe, expect, it } from 'vitest'
import { PRINTABLE_MAX, printable, stripBidi } from '../src/shared/printable'

describe('printable peer names', () => {
  it('leaves an ordinary name alone, emoji and accents included', () => {
    expect(printable('Vladimir’s iPhone')).toBe('Vladimir’s iPhone')
    expect(printable('Žofia 📱')).toBe('Žofia 📱')
  })

  it('shows control characters (ESC, CR, LF, TAB, BS, DEL, C1) as U+FFFD, so no sequence reaches the terminal', () => {
    const name = 'iPhone\u001b[2J\u001b]0;pwned\u0007\r\nAccept?\t\b\u007f\u009b31m'
    const out = printable(name)
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u)
    expect(out).toBe('iPhone�[2J�]0;pwned���Accept?����31m')
  })

  it('drops bidi controls and line separators', () => {
    for (const ch of ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏', ' ', ' ']) {
      expect(printable(`ab${ch}cd`)).toBe('abcd')
      expect(stripBidi(`ab${ch}cd`)).toBe('abcd')
    }
    // stripBidi keeps what React shows safely anyway.
    expect(stripBidi('a\u001bb')).toBe('a\u001bb')
  })

  it('caps the length with an ellipsis, by characters, and never splits a surrogate pair', () => {
    expect(Array.from(printable('x'.repeat(200)))).toHaveLength(PRINTABLE_MAX)
    expect(printable('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(printable('📱'.repeat(100), 10)).toBe(`${'📱'.repeat(9)}…`)
    expect(printable('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('names an empty or non-string name', () => {
    expect(printable('')).toBe('(no name)')
    expect(printable('‮‮  ')).toBe('(no name)')
    expect(printable(undefined)).toBe('(no name)')
    expect(printable(42)).toBe('42')
  })
})
