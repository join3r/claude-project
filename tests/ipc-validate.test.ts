import { describe, expect, it } from 'vitest'
import { IpcValidationError, v, validateArgs } from '../src/main/ipc/validate'
import { safeId, sshConfig, windowViewState, chatPromptResponse, revisionSave, projectsData } from '../src/main/ipc/schemas'
import { createDefaultWindowViewState } from '../src/shared/types'

describe('validators', () => {
  it('checks primitive types', () => {
    expect(v.string()('x', 'a')).toBe('x')
    expect(() => v.string()(1, 'a')).toThrow(IpcValidationError)
    expect(() => v.string({ nonEmpty: true })('', 'a')).toThrow(/non-empty/)
    expect(v.number({ int: true, min: 0 })(3, 'n')).toBe(3)
    expect(() => v.number()(NaN, 'n')).toThrow(/finite/)
    expect(() => v.number({ int: true })(1.5, 'n')).toThrow(/integer/)
    expect(() => v.number({ max: 2 })(3, 'n')).toThrow(/<= 2/)
    expect(() => v.boolean()('true', 'b')).toThrow(/boolean/)
    expect(v.literal('a', 'b')('b', 'l')).toBe('b')
    expect(() => v.literal('a', 'b')('c', 'l')).toThrow(/one of/)
  })

  it('treats null and undefined as absent for optional', () => {
    const opt = v.optional(v.string())
    expect(opt(undefined, 'o')).toBeUndefined()
    expect(opt(null, 'o')).toBeUndefined()
    expect(() => opt(5, 'o')).toThrow(IpcValidationError)
    expect(v.nullable(v.string())(null, 'n')).toBeNull()
    expect(() => v.nullable(v.string())(undefined, 'n')).toThrow()
  })

  it('names the failing path inside nested values', () => {
    const shape = v.object({ list: v.array(v.object({ id: v.string() })) })
    expect(() => shape({ list: [{ id: 'a' }, { id: 2 }] }, 'arg')).toThrow('arg.list[1].id')
  })

  it('strips, passes through or rejects unknown object keys', () => {
    const shape = { a: v.string(), b: v.optional(v.number()) }
    expect(v.object(shape)({ a: 'x', extra: 1 }, 'o')).toEqual({ a: 'x' })
    expect(v.object(shape, 'passthrough')({ a: 'x', extra: 1 }, 'o')).toEqual({ a: 'x', extra: 1 })
    expect(() => v.object(shape, 'reject')({ a: 'x', extra: 1 }, 'o')).toThrow(/unexpected key "extra"/)
    // An absent optional key stays absent rather than becoming `undefined`.
    expect(Object.keys(v.object(shape)({ a: 'x' }, 'o'))).toEqual(['a'])
  })

  it('refuses arrays, class instances and null where an object is expected', () => {
    const shape = v.object({})
    expect(() => shape([], 'o')).toThrow(/object/)
    expect(() => shape(null, 'o')).toThrow(/object/)
    expect(() => shape(new Date(), 'o')).toThrow(/object/)
  })

  it('cannot be turned into a prototype write by a __proto__ key', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "a": "x"}')
    const out = v.record(v.unknown)(payload, 'r') as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const passthrough = v.object({ a: v.string() }, 'passthrough')(payload, 'o') as Record<string, unknown>
    expect(Object.getPrototypeOf(passthrough)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(passthrough, '__proto__')).toBe(true)
  })

  it('picks the first matching union variant', () => {
    expect(chatPromptResponse({ behavior: 'deny', message: 'no' }, 'r')).toEqual({ behavior: 'deny', message: 'no' })
    expect(() => chatPromptResponse({ behavior: 'maybe' }, 'r')).toThrow(/no variant matched/)
  })
})

describe('validateArgs', () => {
  it('passes missing trailing args to optional validators', () => {
    expect(validateArgs('ch', [v.string(), v.optional(v.string())], ['a'])).toEqual(['a', undefined])
  })

  it('refuses extra args and wrong types with the channel name', () => {
    expect(() => validateArgs('ch', [v.string()], ['a', 'b'])).toThrow(/ch: expected at most 1/)
    expect(() => validateArgs('ch', [v.string()], [1])).toThrow('ch#0')
  })
})

describe('domain schemas', () => {
  it('rejects ids that could escape a directory', () => {
    expect(safeId('3f0c-1', 'id')).toBe('3f0c-1')
    expect(safeId('home-tab-abc', 'id')).toBe('home-tab-abc')
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'a\0b', 'C:x']) {
      expect(() => safeId(bad, 'id')).toThrow(IpcValidationError)
    }
  })

  it('checks ssh configs field by field', () => {
    const ok = { host: 'h', port: 22, username: 'u', remoteDir: '' }
    expect(sshConfig(ok, 's')).toEqual(ok)
    expect(() => sshConfig({ ...ok, port: '22' }, 's')).toThrow(/port/)
    expect(() => sshConfig({ ...ok, port: 70000 }, 's')).toThrow(/port/)
    expect(() => sshConfig({ ...ok, host: '' }, 's')).toThrow(/host/)
  })

  it('accepts a real window view state and refuses a malformed one', () => {
    const state = createDefaultWindowViewState()
    expect(windowViewState(state, 'w')).toEqual(state)
    expect(() => windowViewState({ ...state, taskStates: { t: { fileBrowserOpen: 'yes' } } }, 'w')).toThrow(/fileBrowserOpen/)
    expect(() => windowViewState({ ...state, expandedProjectIds: 'x' }, 'w')).toThrow(/expandedProjectIds/)
  })

  it('checks the directories main reads out of a projects save', () => {
    const save = revisionSave(projectsData)
    const data = { projects: [{ id: 'p', directory: '/x', streams: [{ id: 's', name: 'main', tasks: [] }] }], tags: [], projectOrder: ['p'], pinnedItems: [] }
    expect(save({ baseRevision: 1, data }, 's')).toEqual({ baseRevision: 1, data })
    expect(() => save({ baseRevision: 1, data: { projects: [{ id: 'p', directory: 5, streams: [] }] } }, 's')).toThrow(/directory/)
    expect(() => save({ baseRevision: 1, data: { projects: [{ id: 'p', streams: [{ id: 's', workspace: { worktreePath: 1 }, tasks: [] }] }] } }, 's'))
      .toThrow(/worktreePath/)
    // The pre-streams shape (tasks owning worktrees) is migrated on load and never saved.
    expect(() => save({ baseRevision: 1, data: { projects: [{ id: 'p', directory: '/x', tasks: [] }] } }, 's')).toThrow(/streams/)
    expect(() => save({ baseRevision: -1, data }, 's')).toThrow(/baseRevision/)
  })
})
