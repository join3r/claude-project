import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HookInjector } from '../src/main/hook-injector'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('HookInjector', () => {
  let testDir: string
  let claudeDir: string
  let settingsPath: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-hook-test-'))
    claudeDir = path.join(testDir, '.claude')
    settingsPath = path.join(claudeDir, 'settings.local.json')
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true })
  })

  it('creates .claude directory and settings.local.json if they do not exist', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    expect(fs.existsSync(settingsPath)).toBe(true)
  })

  it('injects all four hook types', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.SessionStart).toBeDefined()
    expect(settings.hooks.UserPromptSubmit).toBeDefined()
    expect(settings.hooks.Stop).toBeDefined()
    expect(settings.hooks.Notification).toBeDefined()
  })

  it('includes correct port in hook commands', () => {
    const injector = new HookInjector(9876)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const cmd = settings.hooks.Notification[0].hooks[0].command
    expect(cmd).toContain('localhost:9876')
  })

  it('includes $DEVTOOL_TAB_ID in hook commands', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const cmd = settings.hooks.SessionStart[0].hooks[0].command
    expect(cmd).toContain('$DEVTOOL_TAB_ID')
  })

  it('preserves existing non-hook settings', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }))
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.permissions.allow).toEqual(['Read'])
    expect(settings.hooks.Notification).toBeDefined()
  })

  it('preserves existing user hooks on other events', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }]
      }
    }))
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.Notification).toBeDefined()
  })

  it('removes injected hooks on cleanup', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    injector.cleanup(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks?.SessionStart).toBeUndefined()
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined()
    expect(settings.hooks?.Stop).toBeUndefined()
    expect(settings.hooks?.Notification).toBeUndefined()
  })

  it('cleanup preserves other settings and hooks', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }]
      }
    }))
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    injector.cleanup(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.permissions.allow).toEqual(['Read'])
    expect(settings.hooks.PreToolUse).toHaveLength(1)
  })

  it('tracks injected project directories', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    expect(injector.getInjectedDirs()).toContain(testDir)
  })

  it('cleanupAll removes hooks from all injected directories', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-hook-test2-'))
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    injector.inject(dir2)
    injector.cleanupAll()
    const s1 = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const s2 = JSON.parse(fs.readFileSync(path.join(dir2, '.claude', 'settings.local.json'), 'utf-8'))
    expect(s1.hooks?.SessionStart).toBeUndefined()
    expect(s2.hooks?.SessionStart).toBeUndefined()
    fs.rmSync(dir2, { recursive: true })
  })

  it('ref-counts inject/cleanup per directory', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    injector.inject(testDir)
    // First cleanup decrements refcount but hooks stay
    injector.cleanup(testDir)
    const s1 = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(s1.hooks.SessionStart).toBeDefined()
    // Second cleanup removes hooks
    injector.cleanup(testDir)
    const s2 = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(s2.hooks?.SessionStart).toBeUndefined()
  })
})
