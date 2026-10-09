import fs from 'fs'
import path from 'path'
import { findCurlExe, missingCurlError, quotePosixHookBin } from './resolve-agent-command'
import { HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER } from '../shared/hook-protocol'

const DEVTOOL_HOOK_MARKER = '__devtool_injected'

interface HookEntry {
  matcher: string
  hooks: { type: string; command: string; async?: boolean }[]
  [DEVTOOL_HOOK_MARKER]?: boolean
}

/**
 * Claude events DevTool listens to, and the endpoint each posts to.
 *
 * The first four drive the status dot and run synchronously, as they always have.
 * The rest only describe *what* the agent is doing (current tool, permission
 * dialogs, API failures, subagents, compaction) and post to `activity`, where
 * `hook_event_name` in the body tells them apart. They run `async` so a curl per
 * tool call never slows Claude down — the price is that they may arrive slightly
 * out of order, which `shared/agent-activity.ts` is written to tolerate.
 */
const HOOK_EVENTS: { event: string; endpoint: string; async?: boolean }[] = [
  { event: 'SessionStart', endpoint: 'session-start' },
  { event: 'UserPromptSubmit', endpoint: 'working' },
  { event: 'Stop', endpoint: 'stopped' },
  { event: 'Notification', endpoint: 'notification' },
  { event: 'PreToolUse', endpoint: 'activity', async: true },
  { event: 'PostToolUse', endpoint: 'activity', async: true },
  { event: 'PostToolUseFailure', endpoint: 'activity', async: true },
  { event: 'PermissionRequest', endpoint: 'activity', async: true },
  { event: 'StopFailure', endpoint: 'activity', async: true },
  { event: 'SubagentStart', endpoint: 'activity', async: true },
  { event: 'SubagentStop', endpoint: 'activity', async: true },
  { event: 'PreCompact', endpoint: 'activity', async: true },
  { event: 'PostCompact', endpoint: 'activity', async: true },
  { event: 'SessionEnd', endpoint: 'activity', async: true }
]

/** Which hook-server endpoint a Claude hook event belongs to (chat tabs deliver hooks in-process). */
export function hookEndpointFor(event: string): string {
  return HOOK_EVENTS.find((entry) => entry.event === event)?.endpoint ?? 'activity'
}

function buildDevtoolHooks(mkCommand: (endpoint: string) => string): Record<string, HookEntry[]> {
  const hooks: Record<string, HookEntry[]> = {}
  for (const { event, endpoint, async } of HOOK_EVENTS) {
    hooks[event] = [{
      matcher: '*',
      hooks: [{ type: 'command', command: mkCommand(endpoint), ...(async ? { async: true } : {}) }],
      [DEVTOOL_HOOK_MARKER]: true
    }]
  }
  return hooks
}

export class HookInjector {
  private port: number
  private token: string
  private resolveCurl: () => string | null
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

  constructor(port: number, token: string, resolveCurl: () => string | null = findCurlExe) {
    this.port = port
    this.token = token
    this.resolveCurl = resolveCurl
  }

  /** Identify devtool hooks by marker OR by URL pattern (marker may be stripped by Claude) */
  private isDevtoolHook(h: HookEntry): boolean {
    if ((h as unknown as Record<string, unknown>)[DEVTOOL_HOOK_MARKER]) return true
    return h.hooks.some((hook) => /localhost:\d+\/hook\//.test(hook.command))
  }

  private curlBin(): string {
    const found = this.resolveCurl()
    if (!found) throw missingCurlError()
    return quotePosixHookBin(found)
  }

  private buildHooks(): Record<string, HookEntry[]> {
    const curl = this.curlBin()
    const base = `http://localhost:${this.port}`
    return buildDevtoolHooks((endpoint) =>
      `${curl} -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "${HOOK_TAB_ID_HEADER}: $DEVTOOL_TAB_ID" -H "${HOOK_TOKEN_HEADER}: ${this.token}" -d @- 2>/dev/null; printf Success`
    )
  }

  inject(projectDir: string, tabId: string): void {
    const owners = this.localOwners.get(projectDir)
    if (owners) {
      // Hooks are already on disk for this dir — record the extra owner (or
      // ignore a respawn of one we already track) and leave the file alone.
      owners.add(tabId)
      return
    }

    const devtoolHooks = this.buildHooks()
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
   * Release every remote injection of a project at once (it moves to a DevTool
   * server): the directories that had owners, whose hooks the caller removes.
   */
  remoteReleaseAll(projectId: string): string[] {
    const prefix = `${projectId}:`
    const dirs: string[] = []
    for (const key of [...this.remoteOwners.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.remoteOwners.delete(key)
      dirs.push(key.slice(prefix.length))
    }
    return dirs
  }

  /**
   * Build a shell script that merges devtool hooks into remote settings.local.json.
   * Preserves existing user settings and hooks.
   */
  buildRemoteInjectScript(remoteDir: string, remotePort: number): string {
    const base = `http://localhost:${remotePort}`
    const mkHookCmd = (endpoint: string): string =>
      `curl -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "${HOOK_TAB_ID_HEADER}: $DEVTOOL_TAB_ID" -H "${HOOK_TOKEN_HEADER}: ${this.token}" -d @- 2>/dev/null; printf Success`

    const devtoolHooks = buildDevtoolHooks(mkHookCmd)

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
