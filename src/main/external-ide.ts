import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { ExternalEditor } from '../shared/types'
import { conptySpawnArgv, extraWindowsSearchDirs, resolveAgentCommand } from './resolve-agent-command'

export interface DetectedEditor {
  name: string
  command: string
}

export interface ExternalIdeDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  existsSync?: (filePath: string) => boolean
  statSync?: (filePath: string) => { isDirectory(): boolean }
  spawn?: (file: string, args: string[], options: Record<string, unknown>) => ChildProcess
}

export function splitExtraArgs(extraArgs: string): string[] {
  return extraArgs.trim().split(/\s+/).filter(Boolean)
}

function pathModFor(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function wellKnownInstalls(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathMod: typeof path.win32
): DetectedEditor[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || ''
    const pf = env.ProgramFiles || 'C:\\Program Files'
    return [
      { name: 'Visual Studio Code', command: pathMod.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe') },
      { name: 'Visual Studio Code', command: pathMod.join(pf, 'Microsoft VS Code', 'Code.exe') },
      { name: 'Cursor', command: pathMod.join(local, 'Programs', 'cursor', 'Cursor.exe') },
      { name: 'Cursor', command: pathMod.join(local, 'Programs', 'Cursor', 'Cursor.exe') }
    ]
  }
  if (platform === 'darwin') {
    return [
      { name: 'Visual Studio Code', command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' },
      { name: 'Cursor', command: '/Applications/Cursor.app/Contents/MacOS/Cursor' }
    ]
  }
  return []
}

function findOnPath(
  logical: string,
  name: string,
  deps: ExternalIdeDeps,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): DetectedEditor | null {
  if (platform !== 'win32') {
    // resolveAgentCommand leaves PATH search to the OS on Unix, which is fine
    // for spawning but useless for detection — walk PATH ourselves.
    const existsSync = deps.existsSync ?? fs.existsSync
    for (const dir of (env.PATH || '').split(path.posix.delimiter)) {
      if (!dir) continue
      const candidate = path.posix.join(dir, logical)
      if (existsSync(candidate)) return { name, command: candidate }
    }
    return null
  }
  try {
    const command = resolveAgentCommand(logical, {
      platform,
      env,
      existsSync: deps.existsSync,
      path: pathModFor(platform)
    })
    return { name, command }
  } catch {
    return null
  }
}

function normalizeKey(command: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? command.toLowerCase() : command
}

/**
 * VS Code and Cursor from well-known install dirs, then PATH.
 * Prefers .exe over .cmd because resolveAgentCommand walks PATHEXT in that order.
 */
export function detectExternalEditors(deps: ExternalIdeDeps = {}): DetectedEditor[] {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathMod = pathModFor(platform)
  const found: DetectedEditor[] = []
  const seen = new Set<string>()

  const add = (candidate: DetectedEditor | null): void => {
    if (!candidate || !candidate.command) return
    if (!existsSync(candidate.command)) return
    const key = normalizeKey(candidate.command, platform)
    if (seen.has(key)) return
    seen.add(key)
    found.push(candidate)
  }

  for (const known of wellKnownInstalls(platform, env, pathMod)) {
    add(known)
  }

  add(findOnPath('code', 'Visual Studio Code', deps, platform, env))
  // PATH `cursor` is often resources/app/bin/cursor.cmd (Agents CLI), not the IDE.
  add(skipCursorAgentCli(findOnPath('cursor', 'Cursor', deps, platform, env), platform))

  // PATH walk also covers dirs Electron's GUI PATH often omits.
  if (platform === 'win32') {
    for (const dir of extraWindowsSearchDirs(env, pathMod)) {
      add({ name: 'Visual Studio Code', command: pathMod.join(dir, 'Code.exe') })
      add({ name: 'Cursor', command: pathMod.join(dir, 'Cursor.exe') })
    }
  }

  return preferExePerName(found)
}

/** `cursor.cmd` on PATH launches Cursor Agents, not the IDE window. */
function skipCursorAgentCli(
  candidate: DetectedEditor | null,
  platform: NodeJS.Platform
): DetectedEditor | null {
  if (!candidate) return null
  if (platform !== 'win32') return candidate
  const base = path.win32.basename(candidate.command).toLowerCase()
  if (base === 'cursor.cmd' || base === 'cursor.bat') return null
  return candidate
}

/** If Settings still points at cursor.cmd, walk up to Cursor.exe. */
function guiExeInsteadOfCursorCli(
  resolved: string,
  platform: NodeJS.Platform,
  existsSync: (filePath: string) => boolean,
  pathMod: typeof path.win32
): string {
  if (platform !== 'win32') return resolved
  const base = pathMod.basename(resolved).toLowerCase()
  if (base !== 'cursor.cmd' && base !== 'cursor.bat') return resolved
  let dir = pathMod.dirname(resolved)
  for (let i = 0; i < 6; i++) {
    const exe = pathMod.join(dir, 'Cursor.exe')
    if (existsSync(exe)) return exe
    const parent = pathMod.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolved
}

function preferExePerName(found: DetectedEditor[]): DetectedEditor[] {
  const byName = new Map<string, DetectedEditor>()
  for (const item of found) {
    const prev = byName.get(item.name)
    if (!prev) {
      byName.set(item.name, item)
      continue
    }
    const prevExe = prev.command.toLowerCase().endsWith('.exe')
    const nextExe = item.command.toLowerCase().endsWith('.exe')
    if (nextExe && !prevExe) byName.set(item.name, item)
  }
  return [...byName.values()]
}

export interface PreparedSpawn {
  file: string
  args: string[]
}

/** Keys Electron injects that make VS Code / Cursor (also Electron) fail or hide. */
export function envForExternalIde(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('CHROME_')) {
      delete env[key]
    }
  }
  delete env.VSCODE_PID
  delete env.VSCODE_CWD
  delete env.VSCODE_NLS_CONFIG
  delete env.NODE_OPTIONS
  return env
}

function isCmdWrapper(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  const base = path.win32.basename(file).toLowerCase()
  return base === 'cmd.exe' || base === 'cmd'
}

export function spawnOptionsForExternalIde(
  prepared: PreparedSpawn,
  deps: ExternalIdeDeps = {}
): Record<string, unknown> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const hideConsole = isCmdWrapper(prepared.file, platform)
  const pathMod = pathModFor(platform)
  // Don't inherit a huge project as cwd (can stall Code.exe). Don't hide the GUI.
  const cwd = hideConsole
    ? (env.USERPROFILE || env.HOME || process.cwd())
    : pathMod.dirname(prepared.file)
  return {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: envForExternalIde(env),
    windowsHide: hideConsole
  }
}

export function prepareOpenInIdeSpawn(
  editor: ExternalEditor,
  folder: string,
  deps: ExternalIdeDeps = {}
): PreparedSpawn {
  const platform = deps.platform ?? process.platform
  const existsSync = deps.existsSync ?? fs.existsSync
  const statSync = deps.statSync ?? ((filePath: string) => fs.statSync(filePath))

  const trimmedFolder = folder.trim()
  if (!trimmedFolder) throw new Error('No folder to open.')
  if (!existsSync(trimmedFolder)) throw new Error('Folder does not exist.')
  let st: { isDirectory(): boolean }
  try {
    st = statSync(trimmedFolder)
  } catch {
    throw new Error('Folder does not exist.')
  }
  if (!st.isDirectory()) throw new Error('Path is not a folder.')

  const command = editor.command.trim()
  if (!command) throw new Error('No editor command is set.')

  let resolved: string
  try {
    resolved = resolveAgentCommand(command, {
      platform,
      env: deps.env ?? process.env,
      existsSync,
      path: pathModFor(platform)
    })
  } catch {
    throw new Error(
      `Cannot find "${command}". Set the path in Settings → Editor & Diff → External IDEs.`
    )
  }

  const extra = splitExtraArgs(editor.extraArgs ?? '')
  const pathMod = pathModFor(platform)
  const gui = guiExeInsteadOfCursorCli(resolved, platform, existsSync, pathMod)
  return conptySpawnArgv(gui, [...extra, trimmedFolder], {
    platform,
    env: deps.env ?? process.env,
    path: pathMod
  })
}

export function openFolderInEditor(
  editor: ExternalEditor,
  folder: string,
  deps: ExternalIdeDeps = {}
): Promise<void> {
  const prepared = prepareOpenInIdeSpawn(editor, folder, deps)
  const run = deps.spawn ?? spawn
  const child = run(prepared.file, prepared.args, spawnOptionsForExternalIde(prepared, deps))
  if (typeof child.once !== 'function') {
    child.unref()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const finish = (err?: Error): void => {
      child.unref()
      if (err) reject(err)
      else resolve()
    }
    child.once('error', (err: Error) => finish(err))
    child.once('spawn', () => finish())
  })
}

/** VS Code and its forks open `vscode-remote://ssh-remote+<host>` folders (Remote - SSH). */
export function isVsCodeFamilyEditor(editor: Pick<ExternalEditor, 'name' | 'command'>): boolean {
  const base = path.posix.basename(editor.command.trim().replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (['code', 'code-insiders', 'cursor', 'codium', 'vscodium', 'windsurf'].includes(base)) return true
  const name = editor.name.toLowerCase()
  return /visual studio code|vs ?code|\bcode\b|cursor|codium|windsurf/.test(name)
    || /visual studio code|cursor\.app|vscodium|windsurf/i.test(editor.command)
}

/**
 * `vscode-remote://ssh-remote+<alias><folder>`. The folder is the server's
 * project directory (server data): every segment is percent-encoded, so spaces,
 * `#`, `?`, `%` and even newlines stay inside the path.
 */
export function sshRemoteFolderUri(alias: string, folder: string): string {
  if (!/^devtool-[0-9a-f]{12}$/.test(alias)) throw new Error(`Bad ssh host alias ${alias}`)
  if (!folder.startsWith('/') || folder.includes('\0') || folder.length > 4096) throw new Error('The server folder must be an absolute path')
  return `vscode-remote://ssh-remote+${alias}${folder.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Opens `folder` on a DevTool server in a VS Code-family editor, over the ssh
 * host `alias` (DevTool's ssh config): `--folder-uri vscode-remote://ssh-remote+…`.
 * The editor command is found as for a local folder, and spawned with an
 * argument array: no shell ever sees the server's path.
 */
export function prepareOpenRemoteSpawn(editor: ExternalEditor, alias: string, folder: string, deps: ExternalIdeDeps = {}): PreparedSpawn {
  const platform = deps.platform ?? process.platform
  const existsSync = deps.existsSync ?? fs.existsSync
  // A .cmd shim would put the server's path through cmd.exe; v1 has no Windows here anyway.
  if (platform === 'win32') throw new Error('Open in IDE for DevTool server projects needs macOS or Linux on this computer.')
  if (!isVsCodeFamilyEditor(editor)) {
    throw new Error(`Open in IDE on a DevTool server works with VS Code and Cursor (Remote - SSH), not ${editor.name || editor.command}.`)
  }
  const uri = sshRemoteFolderUri(alias, folder)
  const command = editor.command.trim()
  if (!command) throw new Error('No editor command is set.')
  let resolved: string
  try {
    resolved = resolveAgentCommand(command, { platform, env: deps.env ?? process.env, existsSync, path: pathModFor(platform) })
  } catch {
    throw new Error(`Cannot find "${command}". Set the path in Settings → Editor & Diff → External IDEs.`)
  }
  const pathMod = pathModFor(platform)
  const gui = guiExeInsteadOfCursorCli(resolved, platform, existsSync, pathMod)
  return conptySpawnArgv(gui, [...splitExtraArgs(editor.extraArgs ?? ''), '--folder-uri', uri], {
    platform,
    env: deps.env ?? process.env,
    path: pathMod
  })
}

export function openRemoteFolderInEditor(editor: ExternalEditor, alias: string, folder: string, deps: ExternalIdeDeps = {}): Promise<void> {
  const prepared = prepareOpenRemoteSpawn(editor, alias, folder, deps)
  const run = deps.spawn ?? spawn
  const child = run(prepared.file, prepared.args, spawnOptionsForExternalIde(prepared, deps))
  if (typeof child.once !== 'function') {
    child.unref()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const finish = (err?: Error): void => {
      child.unref()
      if (err) reject(err)
      else resolve()
    }
    child.once('error', (err: Error) => finish(err))
    child.once('spawn', () => finish())
  })
}
