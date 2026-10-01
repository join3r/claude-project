import type { AppConfig } from '../../shared/types'
import { isValidRelayUrl, normalizeRelayUrl, type MobileConfig } from '../../shared/mobile'
import { IpcValidationError, isPlainRecord, v, type Validator } from './validate'

const str = v.string()
const bool = v.boolean()
const num = v.number()
const nullableStr = v.nullable(v.string())

export const relayUrl: Validator<string> = (value, path) => {
  const url = normalizeRelayUrl(v.string({ max: 2048 })(value, path))
  if (!isValidRelayUrl(url)) throw new IpcValidationError(`Invalid IPC argument ${path}: not a ws:// or wss:// URL`)
  return url
}

const mobileConfig: Validator<MobileConfig> = v.object({
  enabled: bool,
  relayUrl,
  desktopName: v.optional(v.string({ max: 100 }))
})

/**
 * One validator per AppConfig key. Typed as a total map so adding a field to
 * AppConfig without teaching main how to check it is a compile error.
 */
const CONFIG_FIELDS: { [K in keyof AppConfig]-?: Validator<AppConfig[K]> } = {
  fontFamily: str,
  fontSize: num,
  theme: v.literal('system', 'dark', 'light'),
  terminalTheme: v.literal('system', 'dark', 'light'),
  terminalColorScheme: v.literal('auto', 'solarized-dark', 'solarized-light', 'one-dark', 'dracula', 'monokai', 'classic'),
  defaultShell: str,
  // Legacy values are coerced on load; anything a renderer sends is coerced the same way.
  windowsTerminal: (value, path) => {
    v.string()(value, path)
    return 'git-bash'
  },
  portableNodeDir: str,
  copyOnSelect: bool,
  editorFontFamily: str,
  editorFontSize: num,
  editorWordWrap: v.literal('off', 'on', 'bounded'),
  editorLineNumbers: v.literal('off', 'on', 'relative', 'interval'),
  editorRenderWhitespace: v.literal('none', 'boundary', 'selection', 'trailing', 'all'),
  editorMinimap: bool,
  editorTabSize: num,
  diffRenderSideBySide: bool,
  diffIgnoreTrimWhitespace: bool,
  externalEditors: v.object({
    editors: v.array(v.object({
      id: v.string({ nonEmpty: true }),
      name: str,
      command: str,
      extraArgs: v.optional(str)
    }) as Validator<AppConfig['externalEditors']['editors'][number]>),
    defaultId: nullableStr
  }),
  enableClaude: bool,
  enableCodex: bool,
  enablePi: bool,
  claudeCommand: str,
  codexCommand: str,
  piCommand: str,
  lazyLoadClaude: bool,
  keepAwakeWhileWorking: bool,
  autoCheckUpdates: bool,
  claudeDefaultView: v.literal('terminal', 'chat'),
  lastProjectId: nullableStr,
  lastTaskId: nullableStr,
  defaultSidebarTab: v.literal('projects', 'inbox'),
  newTaskAutoOpen: v.literal('none', 'claude', 'codex', 'pi', 'browser', 'terminal'),
  taskRecencyHighlight: v.object({
    enabled: bool,
    mode: v.literal('rank', 'time'),
    rankCount: num,
    timeWindowMinutes: num
  }),
  activityPanel: v.object({
    enabled: bool,
    heightPx: num
  }),
  idleTaskCleanup: v.object({
    enabled: bool,
    byAge: v.object({ enabled: bool, days: num }),
    byCount: v.object({ enabled: bool, maxTasks: num }),
    combine: v.literal('and', 'or'),
    settledOnly: bool,
    includeCleanWorkspaces: bool
  }),
  mobile: v.optional(mobileConfig)
}

/**
 * Keys main owns through dedicated IPC (`mobile-*`). A window sends its whole
 * config on every save, and a copy from before a mobile-* call would undo it.
 */
export const MAIN_OWNED_CONFIG_KEYS: readonly (keyof AppConfig)[] = ['mobile']

export interface SanitizedConfig {
  config: Partial<AppConfig>
  /** Keys that are not AppConfig fields (legacy or foreign) and were ignored. */
  droppedKeys: string[]
  /** AppConfig keys whose value had the wrong type/value; the stored value is kept. */
  rejectedKeys: { key: string; reason: string }[]
}

/**
 * Filter what a renderer sends to `save-config` down to AppConfig's own keys,
 * each checked against its type. Unknown keys are dropped (an old config.json
 * can still carry retired fields the renderer echoes back). A known key with
 * the wrong type or value is left out of the result too, so the caller keeps
 * the value it already has: the renderer always sends the whole config, and
 * refusing the save outright would let one stale value block every change.
 */
export function sanitizeConfigUpdate(input: unknown): SanitizedConfig {
  if (!isPlainRecord(input)) throw new IpcValidationError('Invalid IPC argument save-config#0: expected an object')
  const config: Record<string, unknown> = {}
  const droppedKeys: string[] = []
  const rejectedKeys: { key: string; reason: string }[] = []
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, key)) {
      droppedKeys.push(key)
      continue
    }
    const validator = CONFIG_FIELDS[key as keyof AppConfig] as Validator<unknown>
    try {
      config[key] = validator(value, `config.${key}`)
    } catch (err) {
      rejectedKeys.push({ key, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { config: config as Partial<AppConfig>, droppedKeys, rejectedKeys }
}

export const APP_CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as (keyof AppConfig)[]
