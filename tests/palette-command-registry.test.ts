// tests/palette-command-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { CommandRegistry } from '../src/renderer/palette/CommandRegistry'
import type { Command } from '../src/renderer/palette/types'

function cmd(id: string, extra: Partial<Command> = {}): Command {
  return { id, title: id, run: () => {}, ...extra }
}

describe('CommandRegistry', () => {
  let r: CommandRegistry
  beforeEach(() => { r = new CommandRegistry() })

  it('registers and retrieves a command', () => {
    r.register(cmd('a'))
    expect(r.getById('a')?.id).toBe('a')
  })
  it('returns all registered commands', () => {
    r.register(cmd('a'))
    r.register(cmd('b'))
    expect(r.getAll().map(c => c.id).sort()).toEqual(['a', 'b'])
  })
  it('throws when registering a duplicate id', () => {
    r.register(cmd('a'))
    expect(() => r.register(cmd('a'))).toThrow(/duplicate/i)
  })
  it('unregisters by id', () => {
    r.register(cmd('a'))
    r.unregister('a')
    expect(r.getById('a')).toBeUndefined()
  })
  it('filters by scope predicate when given a context', () => {
    r.register(cmd('global'))
    r.register(cmd('scoped', { when: () => false }))
    const ctx = { actions: {} as any }
    expect(r.getAvailable(ctx).map(c => c.id)).toEqual(['global'])
  })
})
