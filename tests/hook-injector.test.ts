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

  it('cleanup removes stale hooks where marker was stripped (identified by URL pattern)', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    // Simulate stale hooks from previous session (marker stripped by Claude Code)
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'curl -s -X POST http://localhost:9999/hook/session-start -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @-' }]
        }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook' }] }]
      }
    }))
    const injector = new HookInjector(3456)
    injector.inject(testDir)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    // Old stale hook (port 9999) should be replaced, not duplicated
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('localhost:3456')
    // User hooks preserved
    expect(settings.hooks.PreToolUse).toHaveLength(1)
  })

  // --- Remote hook injection tests ---

  it('builds remote inject script that merges hooks into existing settings', () => {
    const injector = new HookInjector(3456)
    const script = injector.buildRemoteInjectScript('/home/deploy/app', 45678)
    // Should create .claude dir
    expect(script).toContain('mkdir -p')
    expect(script).toContain('.claude')
    // Should use merge logic to preserve existing settings
    expect(script).toContain('settings.local.json')
    // Hooks are base64-encoded — decode and check the port
    const b64Match = script.match(/base64\.b64decode\('([^']+)'\)/)
    expect(b64Match).toBeTruthy()
    const decoded = Buffer.from(b64Match![1], 'base64').toString()
    // Should use the remote forwarded port (45678), not the local hook port (3456)
    expect(decoded).toContain('localhost:45678')
    expect(decoded).not.toContain('localhost:3456')
  })

  it('builds remote cleanup script that removes only devtool hooks', () => {
    const injector = new HookInjector(3456)
    const script = injector.buildRemoteCleanupScript('/home/deploy/app')
    expect(script).toContain('settings.local.json')
    // Should NOT delete the whole file — should filter out devtool hooks only
    expect(script).not.toMatch(/rm\s.*settings\.local\.json/)
  })

  it('ref-counts remote inject/cleanup per projectId and remoteDir', () => {
    const injector = new HookInjector(3456)
    // First inject increments refcount
    injector.remoteInject('proj-1', '/home/deploy/app')
    injector.remoteInject('proj-1', '/home/deploy/app')
    // First cleanup decrements but hooks stay
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app')).toBe(false) // not last ref
    // Second cleanup is last ref — returns true (caller should run remote cleanup script)
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app')).toBe(true)
  })

  it('does not collide ref-counts across different projects with same remoteDir', () => {
    const injector = new HookInjector(3456)
    injector.remoteInject('proj-1', '/home/deploy/app')
    injector.remoteInject('proj-2', '/home/deploy/app')
    // Cleaning up proj-1 should not affect proj-2
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app')).toBe(true)
    expect(injector.remoteCleanup('proj-2', '/home/deploy/app')).toBe(true)
  })

  it('does not collide ref-counts across different directories in the same project', () => {
    const injector = new HookInjector(3456)
    injector.remoteInject('proj-1', '/home/deploy/app/.worktrees/ws-a')
    injector.remoteInject('proj-1', '/home/deploy/app/.worktrees/ws-b')
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app/.worktrees/ws-a')).toBe(true)
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app/.worktrees/ws-b')).toBe(true)
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
