import fs from 'fs'
import path from 'path'
import { AI_TAB_META, type AppConfig } from '../shared/types'

type PathApi = typeof path.win32

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

export interface ResolveCommandDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  existsSync?: (filePath: string) => boolean
  path?: PathApi
}

/** Extra Windows dirs Electron's GUI PATH often omits. */
export function extraWindowsSearchDirs(env: NodeJS.ProcessEnv, pathMod: PathApi = path.win32): string[] {
  const dirs: string[] = []
  if (env.APPDATA) dirs.push(pathMod.join(env.APPDATA, 'npm'))
  if (env.LOCALAPPDATA) {
    dirs.push(pathMod.join(env.LOCALAPPDATA, 'npm'))
    dirs.push(pathMod.join(env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin'))
    dirs.push(pathMod.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin'))
  }
  dirs.push('C:\\Program Files\\Git\\usr\\bin')
  dirs.push('C:\\Program Files\\Git\\bin')
  dirs.push('C:\\Program Files (x86)\\Git\\usr\\bin')
  dirs.push('C:\\Program Files (x86)\\Git\\bin')
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  dirs.push(pathMod.join(systemRoot, 'System32', 'OpenSSH'))
  return dirs
}

export function missingCurlError(): Error {
  return new Error(
    'Cannot find curl. Install Git for Windows (curl.exe lives in Git\\usr\\bin), then open the Claude task again.'
  )
}

/** Locate `curl` / `curl.exe` for Claude hooks. Git usr\\bin is searched on Windows. */
export function findCurlExe(deps: ResolveCommandDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathMod = deps.path ?? (platform === 'win32' ? path.win32 : path.posix)
  const delim = pathMod.delimiter
  const pathDirs = (env.PATH || env.Path || '').split(delim)
  const extra = platform === 'win32' ? extraWindowsSearchDirs(env, pathMod as PathApi) : []
  const names = platform === 'win32' ? ['curl.exe', 'curl'] : ['curl']
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...extra]) {
    if (!dir) continue
    for (const name of names) {
      const candidate = pathMod.join(dir, name)
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Quote a file path for a POSIX hook snippet (Claude's hook runner). */
export function quotePosixHookBin(file: string): string {
  if (/^[\w./+-]+$/.test(file)) return file
  const unixish = file.replace(/\\/g, '/')
  return "'" + unixish.replace(/'/g, `'\\''`) + "'"
}

export function missingCommandError(command: string): Error {
  return new Error(
    `Cannot find "${command}". Set a command path in Settings → AI Tools, ` +
      `or add the folder that contains it to PATH (on Windows this is often %AppData%\\npm\\pi.cmd).`
  )
}

export function missingSshError(): Error {
  return new Error(
    'Cannot find ssh.exe. Install Git for Windows (Git\\usr\\bin\\ssh.exe) or Windows OpenSSH, then open the remote tab again.'
  )
}

/**
 * Absolute `ssh.exe` on Windows so ConPTY/CreateProcess can open it.
 * A bare `ssh` yields `Error: File not found:` with an empty path.
 * Non-Windows keeps the name `ssh` so the OS searches PATH.
 *
 * Prefer Git\\usr\\bin over System32 OpenSSH. Native Windows OpenSSH cannot
 * own a ControlMaster socket (`getsockname failed: Not a socket`). Git's
 * ssh can run the master and `-O` commands; PTY tabs on Windows still
 * connect directly (no `-S`) because Git cannot mux a new TTY session.
 */
export function resolveSshCommand(deps: ResolveCommandDeps = {}): string {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return 'ssh'
  const gitSsh = windowsGitSshExe(deps)
  if (gitSsh) return gitSsh
  try {
    return resolveAgentCommand('ssh', deps)
  } catch {
    throw missingSshError()
  }
}

/** Git\\usr\\bin\\ssh.exe when installed — the only Windows ssh that can host ControlMaster. */
export function windowsGitSshExe(deps: ResolveCommandDeps = {}): string | null {
  const env = deps.env ?? process.env
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathMod = deps.path ?? path.win32
  for (const dir of extraWindowsSearchDirs(env, pathMod)) {
    if (!/git[/\\]usr[/\\]bin$/i.test(dir)) continue
    const candidate = pathMod.join(dir, 'ssh.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Same as {@link resolveSshCommand}, but `ssh` if nothing is installed (execFile PATH search). */
export function sshExecutable(deps: ResolveCommandDeps = {}): string {
  try {
    return resolveSshCommand(deps)
  } catch {
    return 'ssh'
  }
}

function pathLooksAbsolute(file: string, platform: NodeJS.Platform, pathMod: PathApi): boolean {
  if (pathMod.isAbsolute(file)) return true
  if (platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(file)) return true
  if (platform === 'win32' && (file.startsWith('\\\\') || file.startsWith('//'))) return true
  return false
}

function candidateNames(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [file]
  // npm also writes an extensionless shebang shim (`pi`). CreateProcess cannot
  // run that (Win32 error 193), so PATH search only considers PATHEXT files.
  if (path.extname(file)) return [file]
  const pathext = (env.PATHEXT || DEFAULT_PATHEXT).split(';').map((ext) => ext.trim()).filter(Boolean)
  const names = new Set<string>()
  for (const raw of pathext) {
    const ext = raw.startsWith('.') ? raw : `.${raw}`
    names.add(file + ext)
    names.add(file + ext.toLowerCase())
  }
  return [...names]
}

/**
 * Turn a logical agent name (`pi`) or a user override into a file CreateProcess can open.
 * On non-Windows, PATH search is left to the OS unless the value is an absolute path.
 */
export function resolveAgentCommand(command: string, deps: ResolveCommandDeps = {}): string {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathMod = deps.path ?? (platform === 'win32' ? path.win32 : path.posix)
  const requested = command.trim()
  if (!requested) {
    throw new Error('No command to spawn.')
  }

  if (pathLooksAbsolute(requested, platform, pathMod)) {
    if (platform === 'win32' && !pathMod.extname(requested)) {
      const cmdShim = requested + '.cmd'
      if (existsSync(cmdShim)) return cmdShim
    }
    if (existsSync(requested)) return requested
    throw missingCommandError(requested)
  }

  if (platform !== 'win32') {
    return requested
  }

  const pathDirs = (env.PATH || env.Path || '').split(pathMod.delimiter)
  const dirs = [...pathDirs, ...extraWindowsSearchDirs(env, pathMod)].filter(Boolean)
  const names = candidateNames(requested, platform, env)
  const seen = new Set<string>()

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathMod.join(dir, name)
      const key = candidate.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (existsSync(candidate)) return candidate
    }
  }

  throw missingCommandError(requested)
}

/**
 * ConPTY/CreateProcess can only start PE binaries. npm's `pi.cmd` is a batch
 * shim — spawning it directly fails with Win32 error 193 (not a valid Win32 app).
 */
export function conptySpawnArgv(
  file: string,
  args: string[],
  deps: Pick<ResolveCommandDeps, 'platform' | 'env' | 'path'> = {}
): { file: string; args: string[] } {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return { file, args }
  const pathMod = deps.path ?? path.win32
  const ext = pathMod.extname(file).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file, args }
  const comspec = deps.env?.ComSpec || deps.env?.COMSPEC || 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', file, ...args] }
}

export function agentCommandOverride(
  shell: string,
  config: Pick<AppConfig, 'claudeCommand' | 'codexCommand' | 'piCommand'>
): string {
  if (shell === AI_TAB_META.claude.command) return config.claudeCommand
  if (shell === AI_TAB_META.codex.command) return config.codexCommand
  if (shell === AI_TAB_META.pi.command) return config.piCommand
  return ''
}

export function isAiAgentCommand(shell: string): boolean {
  return (
    shell === AI_TAB_META.claude.command ||
    shell === AI_TAB_META.codex.command ||
    shell === AI_TAB_META.pi.command
  )
}
