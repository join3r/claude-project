import fs from 'fs'
import path from 'path'

const DEVTOOL_HOOK_MARKER = '__devtool_injected'

interface HookEntry {
  matcher: string
  hooks: { type: string; command: string }[]
  [DEVTOOL_HOOK_MARKER]?: boolean
}

export class HookInjector {
  private port: number
  /**
   * Tab ids that currently hold an injection, keyed by project dir.
   *
   * Tracking owners rather than a plain count keeps inject/cleanup balanced no
   * matter how they interleave: a cleanup for a tab that never spawned (hidden
   * lazy tabs request cleanup on removal regardless) can't consume a sibling's
   * reference, and a tab that respawns its PTY re-adds an id it already owns
   * instead of double-counting. Hooks come off disk exactly when a dir's owner
   * set empties.
   */
  private localOwners = new Map<string, Set<string>>()

  constructor(port: number) {
    this.port = port
  }

  /** Identify devtool hooks by marker OR by URL pattern (marker may be stripped by Claude) */
  private isDevtoolHook(h: HookEntry): boolean {
    if ((h as unknown as Record<string, unknown>)[DEVTOOL_HOOK_MARKER]) return true
    return h.hooks.some((hook) => /localhost:\d+\/hook\//.test(hook.command))
  }

  private buildHooks(): Record<string, HookEntry[]> {
    const base = `http://localhost:${this.port}`
    const mkHook = (endpoint: string): HookEntry => ({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `curl -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @- 2>/dev/null; printf Success`
      }],
      [DEVTOOL_HOOK_MARKER]: true
    })

    return {
      SessionStart: [mkHook('session-start')],
      UserPromptSubmit: [mkHook('working')],
      Stop: [mkHook('stopped')],
      Notification: [mkHook('notification')]
    }
  }

  inject(projectDir: string, tabId: string): void {
    const owners = this.localOwners.get(projectDir)
    if (owners) {
      // Hooks are already on disk for this dir — record the extra owner (or
      // ignore a respawn of one we already track) and leave the file alone.
      owners.add(tabId)
      return
    }
    this.localOwners.set(projectDir, new Set([tabId]))

    const claudeDir = path.join(projectDir, '.claude')
    const settingsPath = path.join(claudeDir, 'settings.local.json')

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true })
    }

    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    } catch {
      // File doesn't exist or invalid JSON
    }

    const existingHooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>
    const devtoolHooks = this.buildHooks()

    // Merge: add our hooks, preserve user hooks on other events
    const mergedHooks: Record<string, HookEntry[]> = { ...existingHooks }
    for (const [event, entries] of Object.entries(devtoolHooks)) {
      // Remove any previously injected devtool hooks on this event
      const userHooks = (mergedHooks[event] ?? []).filter(
        (h) => !this.isDevtoolHook(h)
      )
      mergedHooks[event] = [...userHooks, ...entries]
    }

    settings.hooks = mergedHooks
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  }

  /** Release `tabId`'s injection. A tab that never injected is a no-op. */
  cleanup(projectDir: string, tabId: string): void {
    const owners = this.localOwners.get(projectDir)
    if (!owners || !owners.delete(tabId)) return
    if (owners.size > 0) return

    // Last owner gone — remove hooks from file
    this.localOwners.delete(projectDir)
    this.removeHooksFromDisk(projectDir)
  }

  private removeHooksFromDisk(projectDir: string): void {
    const settingsPath = path.join(projectDir, '.claude', 'settings.local.json')
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

      for (const event of Object.keys(hooks)) {
        hooks[event] = hooks[event].filter(
          (h) => !this.isDevtoolHook(h)
        )
        if (hooks[event].length === 0) {
          delete hooks[event]
        }
      }

      settings.hooks = hooks
      if (Object.keys(hooks).length === 0) {
        delete settings.hooks
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    } catch {
      // File doesn't exist, nothing to clean
    }
  }

  cleanupAll(): void {
    for (const dir of [...this.localOwners.keys()]) {
      // Shutdown — drop hooks regardless of who still owns them
      this.localOwners.delete(dir)
      this.removeHooksFromDisk(dir)
    }
  }

  getInjectedDirs(): string[] {
    return [...this.localOwners.keys()]
  }

  // --- Remote hook injection ---

  /** Owner tab ids keyed by `projectId:remoteDir` — same accounting as {@link localOwners}. */
  private remoteOwners = new Map<string, Set<string>>()

  private remoteKey(projectId: string, remoteDir: string): string {
    return `${projectId}:${remoteDir}`
  }

  /** Shell-quote a value for safe interpolation into a remote shell command */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  /**
   * Record `tabId` as an owner of the remote injection for projectId + remoteDir.
   * Returns true when it is the first owner (hooks were not installed there yet).
   */
  remoteInject(projectId: string, remoteDir: string, tabId: string): boolean {
    const key = this.remoteKey(projectId, remoteDir)
    const owners = this.remoteOwners.get(key)
    if (owners) {
      owners.add(tabId)
      return false
    }
    this.remoteOwners.set(key, new Set([tabId]))
    return true
  }

  /**
   * Release `tabId`'s remote injection. Returns true when the last owner is gone
   * and the caller should run the remote cleanup script; a tab that never
   * injected releases nothing and returns false.
   */
  remoteCleanup(projectId: string, remoteDir: string, tabId: string): boolean {
    const key = this.remoteKey(projectId, remoteDir)
    const owners = this.remoteOwners.get(key)
    if (!owners || !owners.delete(tabId)) return false
    if (owners.size > 0) return false
    this.remoteOwners.delete(key)
    return true
  }

  /**
   * Build a shell script that merges devtool hooks into remote settings.local.json.
   * Preserves existing user settings and hooks.
   */
  buildRemoteInjectScript(remoteDir: string, remotePort: number): string {
    const base = `http://localhost:${remotePort}`
    const mkHookCmd = (endpoint: string): string =>
      `curl -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @- 2>/dev/null; printf Success`

    const devtoolHooks = {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: mkHookCmd('session-start') }], [DEVTOOL_HOOK_MARKER]: true }],
      UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: mkHookCmd('working') }], [DEVTOOL_HOOK_MARKER]: true }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: mkHookCmd('stopped') }], [DEVTOOL_HOOK_MARKER]: true }],
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: mkHookCmd('notification') }], [DEVTOOL_HOOK_MARKER]: true }]
    }

    const hooksJsonB64 = Buffer.from(JSON.stringify(devtoolHooks)).toString('base64')
    const settingsPath = `${remoteDir}/.claude/settings.local.json`
    const quotedRemoteDir = this.shellQuote(remoteDir)
    const quotedSettingsPath = this.shellQuote(settingsPath)

    return `mkdir -p ${quotedRemoteDir}/.claude && python3 -c "
import json, os, base64
path = ${quotedSettingsPath}
try:
    with open(path) as f: settings = json.load(f)
except: settings = {}
hooks = settings.get('hooks', {})
new_hooks = json.loads(base64.b64decode('${hooksJsonB64}').decode())
marker = '${DEVTOOL_HOOK_MARKER}'
for event in list(hooks.keys()):
    hooks[event] = [h for h in hooks[event] if not h.get(marker) and not any('localhost:' in hk.get('command','') and '/hook/' in hk.get('command','') for hk in h.get('hooks',[]))]
    if not hooks[event]: del hooks[event]
for event, entries in new_hooks.items():
    hooks.setdefault(event, []).extend(entries)
settings['hooks'] = hooks
with open(path, 'w') as f: json.dump(settings, f, indent=2)
"`
  }

  /**
   * Build a shell script that removes only devtool hooks from remote settings.local.json.
   */
  buildRemoteCleanupScript(remoteDir: string): string {
    const quotedSettingsPath = this.shellQuote(`${remoteDir}/.claude/settings.local.json`)

    return `python3 -c "
import json, os
path = ${quotedSettingsPath}
try:
    with open(path) as f: settings = json.load(f)
except: exit(0)
hooks = settings.get('hooks', {})
marker = '${DEVTOOL_HOOK_MARKER}'
for event in list(hooks.keys()):
    hooks[event] = [h for h in hooks[event] if not h.get(marker) and not any('localhost:' in hk.get('command','') and '/hook/' in hk.get('command','') for hk in h.get('hooks',[]))]
    if not hooks[event]: del hooks[event]
if not hooks: settings.pop('hooks', None)
settings['hooks'] = hooks
with open(path, 'w') as f: json.dump(settings, f, indent=2)
" 2>/dev/null || true`
  }
}
