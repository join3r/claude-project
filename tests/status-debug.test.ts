import { describe, it, expect } from 'vitest'
import { formatStatusTransition } from '../src/renderer/statusDebug'

describe('formatStatusTransition', () => {
  it('renders both statuses and the reason', () => {
    expect(formatStatusTransition('tab-1', 'working', 'attention', 'hook-notification'))
      .toBe('[status] tab-1 working → attention (hook-notification)')
  })

  it('spells null out so a cleared status is visible in the log', () => {
    expect(formatStatusTransition('tab-1', null, 'working', 'pty-data'))
      .toBe('[status] tab-1 none → working (pty-data)')
    expect(formatStatusTransition('tab-1', 'attention', null, 'visit'))
      .toBe('[status] tab-1 attention → none (visit)')
  })

  it('omits the reason when a writer did not give one', () => {
    expect(formatStatusTransition('tab-1', null, 'exited')).toBe('[status] tab-1 none → exited')
  })
})
