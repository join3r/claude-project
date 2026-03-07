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

  private buildHooks(): Record<string, HookEntry[]> {
    const base = `http://localhost:${this.port}`
    const mkHook = (endpoint: string): HookEntry => ({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `curl -s -X POST ${base}/hook/${endpoint} -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @-`
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
        (h) => !(h as Record<string, unknown>)[DEVTOOL_HOOK_MARKER]
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
          (h) => !(h as Record<string, unknown>)[DEVTOOL_HOOK_MARKER]
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
}
