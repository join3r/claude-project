import { describe, expect, it, vi } from 'vitest'
import { isInterruptKey, KeyInterrupts } from '../src/main/key-interrupts'

describe('isInterruptKey', () => {
  it('matches a bare Esc and its kitty form, not Alt+key or arrows', () => {
    expect(isInterruptKey('\x1b')).toBe(true)
    expect(isInterruptKey('\x1b[27u')).toBe(true)
    expect(isInterruptKey('\x1bb')).toBe(false)
    expect(isInterruptKey('\x1b[A')).toBe(false)
    expect(isInterruptKey('\x1b\x1b')).toBe(false)
  })
})

describe('KeyInterrupts', () => {
  it('reports a Stop for Esc while working or waiting on you', () => {
    const keys = new KeyInterrupts()
    const stop = vi.fn()
    keys.pressed('t', 'working', stop)
    keys.pressed('t', 'attention', stop)
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('leaves an idle or exited tab alone', () => {
    const keys = new KeyInterrupts()
    const stop = vi.fn()
    keys.pressed('t', null, stop)
    keys.pressed('t', 'exited', stop)
    expect(stop).not.toHaveBeenCalled()
  })

  it('survives the Stop it reports, which passes through hook()', () => {
    const keys = new KeyInterrupts()
    keys.pressed('t', 'working', () => { keys.hook('t', { hook_event_name: 'Stop' }) })
    expect(keys.hook('t', { hook_event_name: 'PreToolUse' })).toBe(true)
  })

  it('takes the tab back to working once, when the main agent keeps using tools', () => {
    const keys = new KeyInterrupts()
    keys.pressed('t', 'working', () => {})
    expect(keys.hook('t', { hook_event_name: 'PostToolUse', agent_id: 'sub' })).toBe(false)
    expect(keys.hook('t', { hook_event_name: 'Notification' })).toBe(false)
    expect(keys.hook('t', { hook_event_name: 'PostToolUse' })).toBe(true)
    expect(keys.hook('t', { hook_event_name: 'PreToolUse' })).toBe(false)
  })

  it('stops watching at the next prompt or Stop', () => {
    const keys = new KeyInterrupts()
    keys.pressed('t', 'working', () => {})
    keys.hook('t', { hook_event_name: 'UserPromptSubmit' })
    expect(keys.hook('t', { hook_event_name: 'PreToolUse' })).toBe(false)
    keys.pressed('u', 'working', () => {})
    keys.forget('u')
    expect(keys.hook('u', { hook_event_name: 'PreToolUse' })).toBe(false)
  })
})
