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
  private refCounts = new Map<string, number>()

  constructor(port: number) {
    this.port = port
  }

  /** Identify devtool hooks by marker OR by URL pattern (marker may be stripped by Claude) */
  private isDevtoolHook(h: HookEntry): boolean {
    if ((h as Record<string, unknown>)[DEVTOOL_HOOK_MARKER]) return true
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

  inject(projectDir: string): void {
    const count = this.refCounts.get(projectDir) ?? 0
    this.refCounts.set(projectDir, count + 1)

    // Only write hooks on first inject for this dir
    if (count > 0) return

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

  cleanup(projectDir: string): void {
    const count = this.refCounts.get(projectDir) ?? 0
    if (count <= 0) return

    if (count > 1) {
      this.refCounts.set(projectDir, count - 1)
      return
    }

    // Last reference — remove hooks from file
    this.refCounts.delete(projectDir)

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
    for (const dir of [...this.refCounts.keys()]) {
      // Force cleanup regardless of refcount
      this.refCounts.set(dir, 1)
      this.cleanup(dir)
    }
  }

  getInjectedDirs(): string[] {
    return [...this.refCounts.keys()]
  }

  // --- Remote hook injection ---

  private remoteRefCounts = new Map<string, number>()

  /** Shell-quote a value for safe interpolation into a remote shell command */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  /** Track remote inject ref-count keyed by projectId. Returns true on first inject. */
  remoteInject(projectId: string): boolean {
    const count = this.remoteRefCounts.get(projectId) ?? 0
    this.remoteRefCounts.set(projectId, count + 1)
    return count === 0
  }

  /** Track remote cleanup ref-count. Returns true when last ref removed. */
  remoteCleanup(projectId: string): boolean {
    const count = this.remoteRefCounts.get(projectId) ?? 0
    if (count <= 1) {
      this.remoteRefCounts.delete(projectId)
      return true
    }
    this.remoteRefCounts.set(projectId, count - 1)
    return false
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
