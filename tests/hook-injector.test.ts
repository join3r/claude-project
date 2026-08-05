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
    injector.inject(testDir, 'tab-1')
    expect(fs.existsSync(settingsPath)).toBe(true)
  })

  it('injects all four hook types', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.SessionStart).toBeDefined()
    expect(settings.hooks.UserPromptSubmit).toBeDefined()
    expect(settings.hooks.Stop).toBeDefined()
    expect(settings.hooks.Notification).toBeDefined()
  })

  it('includes correct port in hook commands', () => {
    const injector = new HookInjector(9876)
    injector.inject(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const cmd = settings.hooks.Notification[0].hooks[0].command
    expect(cmd).toContain('localhost:9876')
  })

  it('includes $DEVTOOL_TAB_ID in hook commands', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const cmd = settings.hooks.SessionStart[0].hooks[0].command
    expect(cmd).toContain('$DEVTOOL_TAB_ID')
  })

  it('preserves existing non-hook settings', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }))
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
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
    injector.inject(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.Notification).toBeDefined()
  })

  it('removes injected hooks on cleanup', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    injector.cleanup(testDir, 'tab-1')
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
    injector.inject(testDir, 'tab-1')
    injector.cleanup(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.permissions.allow).toEqual(['Read'])
    expect(settings.hooks.PreToolUse).toHaveLength(1)
  })

  it('tracks injected project directories', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    expect(injector.getInjectedDirs()).toContain(testDir)
  })

  it('cleanupAll removes hooks from all injected directories', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-hook-test2-'))
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    injector.inject(dir2, 'tab-2')
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
    injector.inject(testDir, 'tab-1')
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

  it('tracks remote owners per projectId and remoteDir', () => {
    const injector = new HookInjector(3456)
    // First owner installs the hooks
    expect(injector.remoteInject('proj-1', '/home/deploy/app', 'tab-1')).toBe(true)
    // Second owner shares them
    expect(injector.remoteInject('proj-1', '/home/deploy/app', 'tab-2')).toBe(false)
    // First release leaves an owner behind, so hooks stay
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-1')).toBe(false)
    // Last owner gone — caller should run the remote cleanup script
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-2')).toBe(true)
  })

  it('does not collide owners across different projects with same remoteDir', () => {
    const injector = new HookInjector(3456)
    injector.remoteInject('proj-1', '/home/deploy/app', 'tab-1')
    injector.remoteInject('proj-2', '/home/deploy/app', 'tab-2')
    // Cleaning up proj-1 should not affect proj-2
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-1')).toBe(true)
    expect(injector.remoteCleanup('proj-2', '/home/deploy/app', 'tab-2')).toBe(true)
  })

  it('does not collide owners across different directories in the same project', () => {
    const injector = new HookInjector(3456)
    injector.remoteInject('proj-1', '/home/deploy/app/.worktrees/ws-a', 'tab-1')
    injector.remoteInject('proj-1', '/home/deploy/app/.worktrees/ws-b', 'tab-2')
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app/.worktrees/ws-a', 'tab-1')).toBe(true)
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app/.worktrees/ws-b', 'tab-2')).toBe(true)
  })

  it('shares one reference between two injected tabs in the same directory', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    injector.inject(testDir, 'tab-2')
    // Removing the first tab leaves the second tab's hooks in place
    injector.cleanup(testDir, 'tab-1')
    const s1 = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(s1.hooks.SessionStart).toBeDefined()
    // Removing the second removes them
    injector.cleanup(testDir, 'tab-2')
    const s2 = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(s2.hooks?.SessionStart).toBeUndefined()
  })

  // --- Ownership accounting (regression: refcounts decremented by tabs that never injected) ---

  it('cleanup for a never-spawned sibling tab does not remove an injected tab\'s hooks', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-injected')

    // A hidden lazy tab in the same directory never spawned, so it never injected —
    // its removal must not consume the injected tab's reference.
    injector.cleanup(testDir, 'tab-never-spawned')
    const afterSibling = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(afterSibling.hooks.SessionStart).toBeDefined()
    expect(injector.getInjectedDirs()).toContain(testDir)

    injector.cleanup(testDir, 'tab-injected')
    const afterInjected = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(afterInjected.hooks?.SessionStart).toBeUndefined()
    expect(injector.getInjectedDirs()).not.toContain(testDir)
  })

  it('a respawned tab still holds exactly one reference', () => {
    const injector = new HookInjector(3456)
    // PTY created, exits, created again — inject runs once per spawn
    injector.inject(testDir, 'tab-1')
    injector.inject(testDir, 'tab-1')
    injector.inject(testDir, 'tab-1')

    // A single removal is enough to take the hooks back off disk
    injector.cleanup(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks?.SessionStart).toBeUndefined()
    expect(injector.getInjectedDirs()).not.toContain(testDir)
  })

  it('a second cleanup for an already-removed tab is a no-op', () => {
    const injector = new HookInjector(3456)
    injector.inject(testDir, 'tab-1')
    injector.cleanup(testDir, 'tab-1')
    // Tab removed while its PTY was still alive: the PTY's later exit must not
    // resurrect or double-release accounting for a fresh tab in the same dir.
    injector.cleanup(testDir, 'tab-1')

    injector.inject(testDir, 'tab-2')
    injector.cleanup(testDir, 'tab-1')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.SessionStart).toBeDefined()
  })

  it('accounts for tabs in different directories separately', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-hook-test2-'))
    const settings2Path = path.join(dir2, '.claude', 'settings.local.json')
    try {
      const injector = new HookInjector(3456)
      injector.inject(testDir, 'tab-1')
      injector.inject(dir2, 'tab-2')

      injector.cleanup(testDir, 'tab-1')
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks?.SessionStart).toBeUndefined()
      // The other directory is untouched
      expect(JSON.parse(fs.readFileSync(settings2Path, 'utf-8')).hooks.SessionStart).toBeDefined()

      injector.cleanup(dir2, 'tab-2')
      expect(JSON.parse(fs.readFileSync(settings2Path, 'utf-8')).hooks?.SessionStart).toBeUndefined()
    } finally {
      fs.rmSync(dir2, { recursive: true })
    }
  })

  it('remote cleanup for a never-spawned sibling tab does not release the injected tab', () => {
    const injector = new HookInjector(3456)
    expect(injector.remoteInject('proj-1', '/home/deploy/app', 'tab-injected')).toBe(true)

    // Never-spawned sibling in the same remote dir — nothing to release
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-never-spawned')).toBe(false)
    // The injected tab still owns the hooks, so its removal is the last one
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-injected')).toBe(true)
  })

  it('a respawned remote tab still holds exactly one reference', () => {
    const injector = new HookInjector(3456)
    expect(injector.remoteInject('proj-1', '/home/deploy/app', 'tab-1')).toBe(true)
    // Respawn after the PTY exited — same owner, not a second reference
    expect(injector.remoteInject('proj-1', '/home/deploy/app', 'tab-1')).toBe(false)

    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-1')).toBe(true)
    // Nothing left to release
    expect(injector.remoteCleanup('proj-1', '/home/deploy/app', 'tab-1')).toBe(false)
  })
})
