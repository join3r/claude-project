import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTabJumpKey, isTaskJumpKey, jumpDigit } from '../src/renderer/hooks/useMetaHeld'

const key = (code: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}): KeyboardEvent =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent

const onPlatform = (platform: string): void => { vi.stubGlobal('window', { api: { platform } }) }

afterEach(() => { vi.unstubAllGlobals() })

describe('jump keys', () => {
  it('reads 1–9 from the physical digit row only', () => {
    expect(jumpDigit(key('Digit1'))).toBe(0)
    expect(jumpDigit(key('Digit9'))).toBe(8)
    expect(jumpDigit(key('Digit0'))).toBeNull()
    expect(jumpDigit(key('Numpad1'))).toBeNull()
    expect(jumpDigit(key('KeyJ'))).toBeNull()
  })

  it('on macOS: ⌘ opens a task, ⌃ picks a tab', () => {
    onPlatform('darwin')
    expect(isTaskJumpKey(key('Digit1', { metaKey: true }))).toBe(true)
    expect(isTabJumpKey(key('Digit1', { metaKey: true }))).toBe(false)
    expect(isTabJumpKey(key('Digit1', { ctrlKey: true }))).toBe(true)
    expect(isTaskJumpKey(key('Digit1', { ctrlKey: true }))).toBe(false)
    expect(isTaskJumpKey(key('Digit1', { metaKey: true, altKey: true }))).toBe(false)
  })

  it('elsewhere: Ctrl opens a task, Alt picks a tab', () => {
    onPlatform('win32')
    expect(isTaskJumpKey(key('Digit1', { ctrlKey: true }))).toBe(true)
    expect(isTabJumpKey(key('Digit1', { altKey: true }))).toBe(true)
    expect(isTabJumpKey(key('Digit1', { ctrlKey: true }))).toBe(false)
  })
})
