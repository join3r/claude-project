import { describe, expect, it } from 'vitest'
import { APP_CONFIG_KEYS, sanitizeConfigUpdate } from '../src/main/ipc/config-sanitize'
import { IpcValidationError } from '../src/main/ipc/validate'
import { DEFAULT_CONFIG } from '../src/shared/types'

describe('sanitizeConfigUpdate', () => {
  it('accepts the full default config unchanged', () => {
    const { config, droppedKeys, rejectedKeys } = sanitizeConfigUpdate(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(droppedKeys).toEqual([])
    expect(rejectedKeys).toEqual([])
  })

  it('knows every AppConfig key', () => {
    expect([...APP_CONFIG_KEYS].sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
  })

  it('drops keys that are not AppConfig fields', () => {
    const { config, droppedKeys } = sanitizeConfigUpdate({
      fontSize: 16,
      collapsedFolderIds: ['legacy'],
      hookToken: 'forged',
      __proto__injected: true
    })
    expect(config).toEqual({ fontSize: 16 })
    expect(droppedKeys.sort()).toEqual(['__proto__injected', 'collapsedFolderIds', 'hookToken'])
  })

  it('does not let a __proto__ key reach the config prototype', () => {
    const { config, droppedKeys } = sanitizeConfigUpdate(JSON.parse('{"__proto__": {"theme": "dark"}}'))
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype)
    expect((config as { theme?: string }).theme).toBeUndefined()
    expect(droppedKeys).toEqual(['__proto__'])
  })

  it('drops only a known key with the wrong type, keeping the rest of the save', () => {
    const { config, rejectedKeys } = sanitizeConfigUpdate({
      fontSize: '14',
      claudeCommand: ['rm', '-rf'],
      theme: 'neon',
      lastProjectId: 3,
      taskRecencyHighlight: { ...DEFAULT_CONFIG.taskRecencyHighlight, enabled: 'yes' },
      externalEditors: { editors: [{ id: 'x', name: 'X', command: 5 }], defaultId: null },
      editorFontSize: 18,
      theme2: 'ignored'
    })
    expect(config).toEqual({ editorFontSize: 18 })
    expect(rejectedKeys.map(r => r.key).sort()).toEqual(
      ['claudeCommand', 'externalEditors', 'fontSize', 'lastProjectId', 'taskRecencyHighlight', 'theme']
    )
    expect(rejectedKeys.find(r => r.key === 'taskRecencyHighlight')!.reason).toMatch(/enabled/)
  })

  it('leaves the stored value in place for a rejected key when merged', () => {
    const stored = { ...DEFAULT_CONFIG, theme: 'dark' as const, fontSize: 12 }
    const full = { ...stored, theme: 'neon', fontSize: 16 }
    const merged = { ...stored, ...sanitizeConfigUpdate(full).config }
    expect(merged.theme).toBe('dark')
    expect(merged.fontSize).toBe(16)
  })

  it('refuses a payload that is not an object', () => {
    expect(() => sanitizeConfigUpdate(null)).toThrow(IpcValidationError)
    expect(() => sanitizeConfigUpdate([])).toThrow(IpcValidationError)
    expect(() => sanitizeConfigUpdate('config')).toThrow(IpcValidationError)
  })

  it('strips unknown keys inside nested settings', () => {
    const { config } = sanitizeConfigUpdate({
      taskRecencyHighlight: { enabled: true, mode: 'rank', rankCount: 5, timeWindowMinutes: 60, extra: 1 }
    })
    expect(config.taskRecencyHighlight).toEqual({ enabled: true, mode: 'rank', rankCount: 5, timeWindowMinutes: 60 })
  })

  it('coerces windowsTerminal like loadConfig does', () => {
    expect(sanitizeConfigUpdate({ windowsTerminal: 'powershell' }).config.windowsTerminal).toBe('git-bash')
  })
})
